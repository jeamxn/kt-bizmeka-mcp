/**
 * OAuth /authorize — the bizmeka login *is* the authorization step.
 *
 *   GET  /authorize  → validate the OAuth request; if the browser already
 *                      carries a valid AS identity cookie AND we still have
 *                      remembered trust for that user, issue a code immediately
 *                      (fully automatic, no form). Otherwise render the id/pw
 *                      form (step 1).
 *   POST /authorize  (stage=credentials) → bizmeka 1st factor + SMS, or the
 *                      trusted-browser fast path → straight to a code.
 *   POST /authorize  (stage=otp)         → verify OTP, persist trust, set the
 *                      long-lived AS identity cookie, issue a code.
 *
 * In-flight login state (the half-completed bizmeka session) lives in the
 * `login_flows` table (encrypted), so the SMS wait survives across stateless
 * containers behind a load balancer.
 */
import { randomBytes } from "node:crypto";
import { BizmekaClient } from "../client.ts";
import type { ClientState } from "../client.ts";
import { db } from "../storage/pg.ts";
import {
  decryptJson,
  encryptJson,
  signCookie,
  verifyCookie,
} from "../storage/crypto.ts";
import { trust } from "../storage/index.ts";
import { getClient, redirectAllowed } from "./clients.ts";
import { errorPage, loginPage, otpPage } from "./pages.ts";

const FLOW_TTL_MS = 10 * 60 * 1000; // 10 min to complete id/pw → OTP
const CODE_TTL_MS = 60 * 1000; // authorization code: 60s
const AS_COOKIE = "bizmeka_as"; // long-lived identity cookie name
const AS_COOKIE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

interface FlowRow {
  flow_id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string | null;
  enc_session: Uint8Array | null;
  username: string | null;
  stage: string;
  expires_at: number;
}

/** Parse a Cookie header into a map. */
function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
}

/** Build a redirect Response to redirect_uri with ?code= (&state=). */
function redirectWithCode(
  redirectUri: string,
  code: string,
  state: string | null,
  setCookie?: string,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  const headers: Record<string, string> = { Location: u.toString() };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

/** Persist an authorization code bound to this flow + user. */
async function issueCode(flow: FlowRow, username: string): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const sql = await db();
  await sql`
    INSERT INTO auth_codes (code, client_id, username, redirect_uri, code_challenge, scope, expires_at)
    VALUES (${code}, ${flow.client_id}, ${username}, ${flow.redirect_uri},
            ${flow.code_challenge}, ${flow.scope}, ${Date.now() + CODE_TTL_MS})
  `;
  return code;
}

/** Build the long-lived, signed, HttpOnly AS identity cookie for a user. */
function asCookieFor(username: string): string {
  const token = signCookie({ sub: username, exp: Date.now() + AS_COOKIE_TTL_MS });
  const maxAge = Math.floor(AS_COOKIE_TTL_MS / 1000);
  return `${AS_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function getFlow(flowId: string): Promise<FlowRow | null> {
  const sql = await db();
  const rows = await sql<FlowRow[]>`SELECT * FROM login_flows WHERE flow_id = ${flowId}`;
  const f = rows[0];
  if (!f) return null;
  if (Number(f.expires_at) < Date.now()) {
    await sql`DELETE FROM login_flows WHERE flow_id = ${flowId}`;
    return null;
  }
  return f;
}

async function dropFlow(flowId: string): Promise<void> {
  const sql = await db();
  await sql`DELETE FROM login_flows WHERE flow_id = ${flowId}`;
}

// ---------------------------------------------------------------------------
// GET /authorize
// ---------------------------------------------------------------------------
export async function handleAuthorizeGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const responseType = q.get("response_type") ?? "";
  const codeChallenge = q.get("code_challenge") ?? "";
  const challengeMethod = q.get("code_challenge_method") ?? "";
  const state = q.get("state");
  const scope = q.get("scope") ?? "mcp";

  const client = clientId ? await getClient(clientId) : null;
  if (!client) return errorPage("알 수 없는 클라이언트입니다 (client_id).");
  if (!redirectUri || !redirectAllowed(client, redirectUri)) {
    return errorPage("등록되지 않은 redirect_uri 입니다.");
  }
  // From here we can safely redirect errors back to the client per OAuth spec,
  // but for a human-facing popup an inline error page is clearer.
  if (responseType !== "code") {
    return errorPage("지원하지 않는 response_type 입니다 (code 만 지원).");
  }
  if (challengeMethod !== "S256" || !codeChallenge) {
    return errorPage("PKCE(S256, code_challenge)가 필요합니다.");
  }

  // Create the pending flow row now so POSTs only carry an opaque flow_id.
  const flowId = randomBytes(18).toString("base64url");
  const sql = await db();
  await sql`
    INSERT INTO login_flows
      (flow_id, client_id, redirect_uri, state, code_challenge, scope, enc_session, username, stage, expires_at)
    VALUES
      (${flowId}, ${clientId}, ${redirectUri}, ${state}, ${codeChallenge}, ${scope},
       ${null}, ${null}, ${"start"}, ${Date.now() + FLOW_TTL_MS})
  `;

  // Fully-automatic path: a valid AS identity cookie + remembered trust means
  // this browser already proved who it is — issue a code with no form.
  const cookies = parseCookies(req);
  const ident = verifyCookie<{ sub: string }>(cookies[AS_COOKIE]);
  if (ident?.sub) {
    const remembered = await trust.read(ident.sub);
    if (remembered) {
      const flow = await getFlow(flowId);
      if (flow) {
        const code = await issueCode(flow, ident.sub);
        await dropFlow(flowId);
        // refresh the cookie's lifetime on each automatic use
        return redirectWithCode(redirectUri, code, state, asCookieFor(ident.sub));
      }
    }
  }

  return loginPage(flowId);
}

// ---------------------------------------------------------------------------
// POST /authorize
// ---------------------------------------------------------------------------
export async function handleAuthorizePost(req: Request): Promise<Response> {
  const form = await req.formData();
  const flowId = String(form.get("flow_id") ?? "");
  const stage = String(form.get("stage") ?? "");
  const flow = flowId ? await getFlow(flowId) : null;
  if (!flow) {
    return errorPage("로그인 세션이 만료되었습니다. 연결을 다시 시도해 주세요.");
  }

  if (stage === "credentials") {
    return stepCredentials(flow, form);
  }
  if (stage === "otp") {
    return stepOtp(flow, form);
  }
  return errorPage("잘못된 요청입니다.");
}

/** Step 1: id/pw → bizmeka 1st factor (+ SMS), or trusted fast path → code. */
/** Structural view of FormData (avoids undici-vs-DOM FormData type clash). */
type Form = { get(name: string): unknown };

async function stepCredentials(
  flow: FlowRow,
  form: Form,
): Promise<Response> {
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!username || !password) {
    return loginPage(flow.flow_id, "아이디와 비밀번호를 모두 입력하세요.");
  }

  const client = new BizmekaClient(username, password);
  // Reuse any remembered browser cookies so the 1st factor can skip SMS.
  const remembered = await trust.load(username);
  if (remembered) client.loadCookies(remembered);

  try {
    const { needs2fa } = await client.submitCredentials();
    if (!needs2fa) {
      // Trusted-browser fast path: already authenticated, no SMS.
      await trust.save(username, client.dumpCookies(), password);
      const code = await issueCode(flow, username);
      await dropFlow(flow.flow_id);
      return redirectWithCode(
        flow.redirect_uri,
        code,
        flow.state,
        asCookieFor(username),
      );
    }
    await client.loadSecondStep();
    await client.sendSms();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return loginPage(flow.flow_id, `로그인 실패: ${msg}`);
  }

  // Persist the in-progress bizmeka session (encrypted) for the OTP step.
  const sql = await db();
  await sql`
    UPDATE login_flows
       SET enc_session = ${encryptJson(client.dumpState())},
           username = ${username},
           stage = ${"await_otp"},
           expires_at = ${Date.now() + FLOW_TTL_MS}
     WHERE flow_id = ${flow.flow_id}
  `;
  return otpPage(flow.flow_id);
}

/** Step 2: OTP → verify, persist trust, set identity cookie, issue code. */
async function stepOtp(flow: FlowRow, form: Form): Promise<Response> {
  const otp = String(form.get("otp") ?? "").trim();
  if (!otp) return otpPage(flow.flow_id, "인증번호를 입력하세요.");
  if (flow.stage !== "await_otp" || !flow.enc_session) {
    return errorPage("로그인 단계가 올바르지 않습니다. 다시 시도해 주세요.");
  }

  let client: BizmekaClient;
  try {
    const state = decryptJson<ClientState>(flow.enc_session);
    client = BizmekaClient.restore(state);
  } catch {
    return errorPage("로그인 세션 복원에 실패했습니다. 다시 시도해 주세요.");
  }

  try {
    await client.verifyOtp(otp, true); // always remember this browser
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return otpPage(flow.flow_id, `인증 실패: ${msg}`);
  }

  const username = flow.username ?? client.username;
  await trust.save(username, client.dumpCookies(), client.password);
  const code = await issueCode(flow, username);
  await dropFlow(flow.flow_id);
  return redirectWithCode(
    flow.redirect_uri,
    code,
    flow.state,
    asCookieFor(username),
  );
}
