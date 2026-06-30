/**
 * HTTP client implementing the KT bizmeka EZ multi-step login flow.
 *
 * Domains:
 *   * ezsso.bizmeka.com    — IdP: login form, RSA key, CSRF, 1st/2nd factor
 *   * ezportal.bizmeka.com — SP: receives the signed SAML assertion, hosts portal
 *   * ezwebmail.bizmeka.com — webmail SP
 *
 * The flow is intentionally split so a human can read the SMS one-time code
 * between `submitCredentials`/`sendSms` (sends the SMS) and `verifyOtp`
 * (completes 2FA + SSO).
 */

import { HttpClient, type Cookie } from "./http.ts";
import { RSAEncryptor } from "./crypto.ts";
import { AlreadyLoggedInError, BizmekaError } from "./errors.ts";

export const SSO_BASE = "https://ezsso.bizmeka.com";
export const PORTAL_BASE = "https://ezportal.bizmeka.com";
export const WEBMAIL_BASE = "https://ezwebmail.bizmeka.com";
export const GROUPWARE_BASE = "https://ezgroupware.bizmeka.com";

// Regexes against /loginForm.do
const RE_MODULUS = /id="sproKeyModulus"\s+value="([0-9a-fA-F]+)"/;
const RE_EXPONENT = /id="sproKeyExponent"\s+value="([0-9a-fA-F]+)"/;
// Password fixed suffix appended after the RSA ciphertext in the inline script:
//   $("#j_password").val(securedPassword + 'AABBCC...');
const RE_PW_SUFFIX =
  /#j_password"\)\.val\(\s*securedPassword\s*\+\s*['"]([0-9A-Fa-f]+)['"]/;
// OWASP CSRFGuard token from /JavaScriptServlet:  "OWASP_CSRFTOKEN", "XXXX-...");
const RE_CSRF = /"OWASP_CSRFTOKEN",\s*"([A-Z0-9-]+)"/;

/** Minimal HTML entity unescape covering numeric (dec/hex) + common named refs. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: "\u00a0",
};
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

export interface LoginContext {
  modulus: string;
  exponent: string;
  passwordSuffix: string;
  csrfToken: string;
}

/**
 * Serializable snapshot of a client mid-login, so the authenticated state can
 * survive between two MCP tool calls even when the host (e.g. Claude cowork)
 * spawns a fresh stdio process per call. Contains everything `verifyOtp` and
 * the webmail tools need; the password is NOT included (only needed for the
 * 1st factor, which has already happened by the time we persist).
 */
export interface ClientState {
  username: string;
  /**
   * The account password. Persisted so a freshly-spawned stdio process (e.g.
   * verify_otp, or an auto re-login after the server session dies) can use it
   * without re-prompting. Optional for backward compat with older state files.
   */
  password?: string;
  ctx: LoginContext | null;
  cookies: Cookie[];
  webmailCsrf: string | null;
  groupwareCsrf?: string | null;
}

export class BizmekaClient {
  readonly http: HttpClient;
  private ctx: LoginContext | null = null;
  webmailCsrf: string | null = null;
  /** ezgroupware CSRFGuard page token (from JavaScriptServlet), cached. */
  groupwareCsrf: string | null = null;

  constructor(
    public readonly username: string,
    public readonly password: string,
    timeoutMs = 20000,
  ) {
    this.http = new HttpClient(timeoutMs);
  }

  get csrfToken(): string {
    if (!this.ctx) throw new BizmekaError("login context not initialized");
    return this.ctx.csrfToken;
  }

  get isLoggedIn(): boolean {
    return this.http.cookies.get("isLogin") === "Y";
  }

  // -- step 1: fetch login form + RSA key + password suffix --------------
  private async loadLoginContext(): Promise<LoginContext> {
    // Don't auto-follow redirects: when a trusted/active SSO session already
    // exists, loginForm.do answers 302 → /sso/ssoLogin.do (i.e. "already
    // authenticated, no form for you"). Following it lands on a page with no
    // RSA key and used to blow up as "RSA public key not found".
    const r = await this.http.get(`${SSO_BASE}/loginForm.do`, {
      followRedirects: false,
    });
    const loc = r.headers.get("location") ?? "";
    if (r.status >= 300 && r.status < 400 && loc.includes("ssoLogin")) {
      // Already logged in via the remembered browser — no credentials needed.
      throw new AlreadyLoggedInError();
    }
    if (r.status >= 400)
      throw new BizmekaError(`loginForm.do 응답 오류 (status=${r.status})`);
    const html = r.text;

    const mMod = RE_MODULUS.exec(html);
    const mExp = RE_EXPONENT.exec(html);
    const mSuf = RE_PW_SUFFIX.exec(html);
    if (!mMod || !mExp) {
      throw new BizmekaError("RSA public key not found in loginForm.do");
    }
    const suffix = mSuf ? mSuf[1]! : "";

    // CSRF token comes from the CSRFGuard servlet (shares the cookie jar)
    const rj = await this.http.get(`${SSO_BASE}/JavaScriptServlet`, {
      headers: {
        Referer: `${SSO_BASE}/loginForm.do`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (rj.status >= 400)
      throw new BizmekaError(`JavaScriptServlet 응답 오류 (status=${rj.status})`);
    const mCsrf = RE_CSRF.exec(rj.text);
    if (!mCsrf) {
      throw new BizmekaError("OWASP_CSRFTOKEN not found in JavaScriptServlet");
    }

    const ctx: LoginContext = {
      modulus: mMod[1]!,
      exponent: mExp[1]!,
      passwordSuffix: suffix,
      csrfToken: mCsrf[1]!,
    };
    this.ctx = ctx;
    return ctx;
  }

  // -- step 2: submit encrypted credentials -----------------------------
  /**
   * Perform 1st-factor login (RSA-encrypted id/pw + CSRF).
   *
   * Returns whether 2nd-factor (SMS) is still required:
   *   - { needs2fa: true }  → normal path; caller does sendSms() + verifyOtp().
   *   - { needs2fa: false } → this cookie jar was previously "remembered"
   *     (browserCertify=Y), so the server completed login here without SMS.
   *     `isLogin=Y` is already set; the caller can use the session directly.
   */
  async submitCredentials(): Promise<{ needs2fa: boolean }> {
    let ctx: LoginContext;
    try {
      ctx = await this.loadLoginContext();
    } catch (e) {
      // Remembered browser is already authenticated (loginForm.do → ssoLogin.do).
      // Treat as a completed, SMS-free login.
      if (e instanceof AlreadyLoggedInError) return { needs2fa: false };
      throw e;
    }
    const rsa = new RSAEncryptor(ctx.modulus, ctx.exponent);
    const securedUser = rsa.encrypt(this.username);
    const securedPw = rsa.encrypt(this.password) + ctx.passwordSuffix;

    const r = await this.http.post(`${SSO_BASE}/login.do`, {
      params: { OWASP_CSRFTOKEN: ctx.csrfToken },
      data: {
        j_username: securedUser,
        j_password: securedPw,
        messageId: "",
        bannerUrl: "",
        OWASP_CSRFTOKEN: ctx.csrfToken,
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SSO_BASE,
        Referer: `${SSO_BASE}/loginForm.do`,
      },
    });
    const location = r.headers.get("location") ?? "";
    // Trusted browser (browserCertify cookie present): login completes here,
    // no secondStepVerif redirect, and isLogin=Y is already set. Skip SMS.
    if (this.isLoggedIn) return { needs2fa: false };
    if (r.status === 302 && location.includes("secondStepVerif")) {
      return { needs2fa: true };
    }
    if (r.status === 302 && location.includes("loginForm")) {
      throw new BizmekaError(
        "로그인 실패: 아이디 또는 비밀번호가 올바르지 않습니다.",
      );
    }
    throw new BizmekaError(
      `예상치 못한 응답 (status=${r.status}, location=${JSON.stringify(location)})`,
    );
  }

  // -- step 3: load 2nd-step page (also primes the referer/cookies) ------
  async loadSecondStep(): Promise<void> {
    const r = await this.http.get(`${SSO_BASE}/rule/secondStepVerifView.do`, {
      headers: { Referer: `${SSO_BASE}/loginForm.do` },
    });
    if (r.status >= 400 || !r.text.includes("loginVerify")) {
      throw new BizmekaError("2차 인증 페이지를 불러오지 못했습니다.");
    }
  }

  // -- step 4: send the SMS one-time code to the registered phone --------
  async sendSms(): Promise<void> {
    const r = await this.http.get(`${SSO_BASE}/sendCertKeyToMobile.do`, {
      params: { _: Date.now() },
      headers: this.ajaxHeaders(),
    });
    if (r.status >= 400)
      throw new BizmekaError(`인증번호 발송 요청 실패 (status=${r.status})`);
    let data: any;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new BizmekaError("인증번호 발송 응답을 해석하지 못했습니다.");
    }
    // res: 0 = OK, -1 = session expired, other = error (msg present)
    if (data.res !== 0) {
      throw new BizmekaError(`인증번호 발송 실패: ${data.msg ?? "알 수 없는 오류"}`);
    }
  }

  // -- step 5: pre-check the entered code (AJAX) ------------------------
  async confirmCertKey(certKey: string): Promise<boolean> {
    const r = await this.http.get(`${SSO_BASE}/confirmCertKey.do`, {
      params: { certKey, _: Date.now() },
      headers: this.ajaxHeaders(),
    });
    if (r.status >= 400) return false;
    try {
      return JSON.parse(r.text).res === 0;
    } catch {
      return false;
    }
  }

  // -- step 6: finalize 2nd factor -> SAML auto-post -> portal -----------
  async verifyOtp(certKey: string, rememberBrowser = false): Promise<string> {
    if (!this.ctx) {
      throw new BizmekaError(
        "login context not initialized; call submitCredentials first",
      );
    }

    // 1) confirm the code first (the browser does this before loginVerify)
    if (!(await this.confirmCertKey(certKey))) {
      throw new BizmekaError("2차 인증 실패: 인증번호가 올바르지 않습니다.");
    }

    // 2) loginVerify -> SAML auto-post HTML (status 200) + isLogin cookie
    const data: Record<string, string> = {
      bannerUrl: "",
      certKey,
      OWASP_CSRFTOKEN: this.ctx.csrfToken,
    };
    if (rememberBrowser) data.browserCertify = "Y";
    const r = await this.http.post(`${SSO_BASE}/loginVerify.do`, {
      params: { OWASP_CSRFTOKEN: this.ctx.csrfToken },
      data,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SSO_BASE,
        Referer: `${SSO_BASE}/rule/secondStepVerifView.do`,
      },
    });
    const loc = r.headers.get("location") ?? "";
    if (loc.includes("secondStepVerif") || loc.includes("loginForm")) {
      throw new BizmekaError("2차 인증 실패: 인증번호가 틀렸거나 만료되었습니다.");
    }
    if (this.http.cookies.get("isLogin") !== "Y") {
      throw new BizmekaError(
        "2차 인증 실패: 로그인 쿠키가 설정되지 않았습니다. 인증번호를 확인하세요.",
      );
    }

    // 3) post the SAML assertion carried in the response body to the SP
    const saml = BizmekaClient.extractSamlForm(r.text);
    if (saml === null) {
      throw new BizmekaError("2차 인증은 통과했으나 SAML 응답을 찾지 못했습니다.");
    }
    await this.http.post(saml.action, {
      data: saml.fields,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SSO_BASE,
        Referer: `${SSO_BASE}/`,
      },
    });

    // 4) confirm the portal session
    const rp = await this.http.get(`${PORTAL_BASE}/portal/main/main.do`, {
      headers: { Referer: `${SSO_BASE}/` },
      followRedirects: true,
    });
    if (rp.status !== 200) {
      throw new BizmekaError(`포털 진입 실패 (status=${rp.status})`);
    }
    return rp.url;
  }

  /**
   * Return {action, fields} for a SAML auto-post form, or null.
   * Handles both directions of the SAML dance (SAMLResponse / SAMLRequest).
   * Field values arrive HTML-entity-encoded, so we unescape them.
   */
  static extractSamlForm(
    html: string,
  ): { action: string; fields: Record<string, string> } | null {
    if (!html.includes("SAMLResponse") && !html.includes("SAMLRequest")) {
      return null;
    }
    const actionM = /<form[^>]+action="([^"]+)"/i.exec(html);
    if (!actionM) return null;
    const action = unescapeHtml(actionM[1]!);
    const fields: Record<string, string> = {};
    const re = /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      fields[unescapeHtml(m[1]!)] = unescapeHtml(m[2]!);
    }
    if (!("SAMLResponse" in fields) && !("SAMLRequest" in fields)) {
      return null;
    }
    return { action, fields };
  }

  /**
   * Detect the bizmeka SSO login form. When a server session has expired, the
   * SAML chain ends here instead of on the requested app page. Requires two
   * independent markers to avoid false positives on ordinary pages.
   */
  static isLoginPage(html: string): boolean {
    let hits = 0;
    for (const m of ['name="j_username"', 'type="password"', "loginForm"]) {
      if (html.includes(m)) hits++;
    }
    return hits >= 2;
  }

  /**
   * Given an HTML body that may contain a SAML auto-post form, submit it and
   * keep following further SAML auto-post forms / redirects until a normal page
   * is reached. Returns the final HTML body.
   */
  async followSamlChain(
    html: string,
    referer: string,
    maxHops = 6,
  ): Promise<string> {
    let body = html;
    let ref = referer;
    for (let i = 0; i < maxHops; i++) {
      const saml = BizmekaClient.extractSamlForm(body);
      if (!saml) return body;
      const r = await this.http.post(saml.action, {
        data: saml.fields,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: ref,
        },
        followRedirects: true,
      });
      body = r.text;
      ref = r.url;
    }
    return body;
  }

  private ajaxHeaders(): Record<string, string> {
    if (!this.ctx) throw new BizmekaError("login context not initialized");
    return {
      OWASP_CSRFTOKEN: this.ctx.csrfToken,
      Referer: `${SSO_BASE}/rule/secondStepVerifView.do`,
      "X-Requested-With": "XMLHttpRequest, OWASP CSRFGuard Project",
      Accept: "*/*",
    };
  }

  // -- cookie persistence (debug / multi-step reuse) ---------------------
  dumpCookies(): Cookie[] {
    return this.http.cookies.dump();
  }

  loadCookies(cookies: Cookie[]): void {
    this.http.cookies.load(cookies);
  }

  /** Full serializable snapshot (cookies + login context) for cross-process reuse. */
  dumpState(): ClientState {
    return {
      username: this.username,
      password: this.password,
      ctx: this.ctx,
      cookies: this.http.cookies.dump(),
      webmailCsrf: this.webmailCsrf,
      groupwareCsrf: this.groupwareCsrf,
    };
  }

  /** Rebuild a client from a snapshot. Restores the password when present. */
  static restore(state: ClientState): BizmekaClient {
    const client = new BizmekaClient(state.username, state.password ?? "");
    client.ctx = state.ctx;
    client.webmailCsrf = state.webmailCsrf;
    client.groupwareCsrf = state.groupwareCsrf ?? null;
    client.http.cookies.load(state.cookies);
    return client;
  }

  // ===================== WEBMAIL (ezwebmail) ============================
  /**
   * Enter the webmail service via SAML SP-initiated SSO and return the Spring
   * Security `_csrf` token used by the mail JSON APIs.
   */
  async enterWebmail(): Promise<string> {
    const r = await this.http.get(
      `${WEBMAIL_BASE}/mail/list.do?_entityId=ezwebmail.bizmeka.com`,
      { followRedirects: true },
    );
    let body = await this.followSamlChain(r.text, `${WEBMAIL_BASE}/`);
    // A dead server session bounces the SAML chain back to the login form.
    // Detect it up front so withClient() can auto re-login (no SMS) — the login
    // page can also carry a _csrf, which would otherwise mask the dead session.
    if (BizmekaClient.isLoginPage(body)) {
      throw new BizmekaError(
        "세션이 만료되었습니다. 다시 로그인하세요. (웹메일 SSO가 로그인 페이지로 리다이렉트됨)",
      );
    }
    let token = BizmekaClient.extractWebmailCsrf(body);
    if (!token) {
      const r2 = await this.http.get(
        `${WEBMAIL_BASE}/mail/list.do?_entityId=ezwebmail.bizmeka.com`,
        { followRedirects: true },
      );
      body = await this.followSamlChain(r2.text, `${WEBMAIL_BASE}/`);
      if (BizmekaClient.isLoginPage(body)) {
        throw new BizmekaError(
          "세션이 만료되었습니다. 다시 로그인하세요. (웹메일 SSO가 로그인 페이지로 리다이렉트됨)",
        );
      }
      token = BizmekaClient.extractWebmailCsrf(body);
    }
    if (!token) {
      throw new BizmekaError("웹메일 진입 실패: _csrf 토큰을 찾지 못했습니다.");
    }
    this.webmailCsrf = token;
    return token;
  }

  static extractWebmailCsrf(html: string): string {
    const pats = [
      /name="_csrf"\s+value="([0-9a-f-]{36})"/,
      /"_csrf"\s*:\s*"([0-9a-f-]{36})"/,
      /_csrf["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/,
      /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/,
    ];
    for (const p of pats) {
      const m = p.exec(html);
      if (m) return m[1]!;
    }
    return "";
  }

  // ===================== GROUPWARE (ezgroupware / planner) =============
  /**
   * Enter the groupware service via SAML SP-initiated SSO and capture the
   * CSRFGuard page token (served by /JavaScriptServlet, same mechanism as the
   * ezsso login). Cached in `groupwareCsrf`. The planner JSON APIs additionally
   * need a per-request token from getAjaxToken() (see below); both are sent in
   * the OWASP_CSRFTOKEN header as "<ajaxToken>, <pageToken>".
   *
   * Verified live: planner entry → JavaScriptServlet → getAjaxToken → CRUD.
   */
  async enterGroupware(): Promise<string> {
    const r = await this.http.get(
      `${GROUPWARE_BASE}/groupware/planner/calendar.do?`,
      { followRedirects: true },
    );
    // Follow the SAML auto-post chain to establish the ezgroupware session.
    const landing = await this.followSamlChain(r.text, `${GROUPWARE_BASE}/`);
    // If the SSO bounced us back to the login form, the server session is dead.
    // Surface a recognizable error so the caller can trigger an unattended
    // re-login (browserCertify cookie + stored password → no SMS).
    if (BizmekaClient.isLoginPage(landing)) {
      throw new BizmekaError(
        "세션이 만료되었습니다. 다시 로그인하세요. (그룹웨어 SSO가 로그인 페이지로 리다이렉트됨)",
      );
    }
    const js = await this.http.get(`${GROUPWARE_BASE}/JavaScriptServlet`, {
      headers: {
        Accept: "*/*",
        Referer: `${GROUPWARE_BASE}/groupware/planner/calendar.do?`,
      },
    });
    const m = RE_CSRF.exec(js.text);
    if (!m) {
      throw new BizmekaError(
        "그룹웨어 진입 실패: CSRF 페이지 토큰을 찾지 못했습니다.",
      );
    }
    this.groupwareCsrf = m[1]!;
    return this.groupwareCsrf;
  }

  /** Ensure the groupware page token is available (enter lazily if needed). */
  async requireGroupware(): Promise<string> {
    return this.groupwareCsrf ?? (await this.enterGroupware());
  }

  /**
   * Fetch a fresh per-request CSRFGuard token. The planner write endpoints
   * (create/update/delete) reject a stale/missing one. GET feeds are happy with
   * just the page token, but using a fresh ajax token everywhere is safe.
   */
  async groupwareAjaxToken(): Promise<string> {
    const pageToken = await this.requireGroupware();
    const r = await this.http.post(
      `${GROUPWARE_BASE}/support/csrf/getAjaxToken.do`,
      {
        headers: {
          Accept: "*/*",
          OWASP_CSRFTOKEN: pageToken,
          Referer: `${GROUPWARE_BASE}/groupware/planner/calendar.do?`,
          "X-Requested-With": "XMLHttpRequest, OWASP CSRFGuard Project",
        },
      },
    );
    const tok = r.text.trim();
    if (!/^[A-Z0-9-]{20,}$/.test(tok)) {
      throw new BizmekaError(
        `그룹웨어 ajax 토큰 발급 실패 (status=${r.status})`,
      );
    }
    return tok;
  }

  /** Standard header set for a planner API call. `tok` is a per-request token. */
  groupwareHeaders(tok: string, json = false): Record<string, string> {
    const pageToken = this.groupwareCsrf ?? "";
    return {
      Accept: "application/json, text/javascript, */*; q=0.01",
      OWASP_CSRFTOKEN: `${tok}, ${pageToken}`,
      Origin: GROUPWARE_BASE,
      Referer: `${GROUPWARE_BASE}/groupware/planner/calendar.do?`,
      "X-Requested-With": "XMLHttpRequest, OWASP CSRFGuard Project",
      "Content-Type": json
        ? "application/json; charset=UTF-8"
        : "application/x-www-form-urlencoded; charset=UTF-8",
    };
  }
}
