/**
 * Minimal HTTP client reproducing the parts of Python httpx that the bizmeka
 * login flow relies on:
 *
 *   * a persistent cookie jar with domain/path matching across the three
 *     bizmeka subdomains (ezsso / ezportal / ezwebmail),
 *   * manual redirect handling (httpx used follow_redirects=False so the login
 *     steps can inspect 302 Location headers themselves),
 *   * form-urlencoded and query-param helpers.
 *
 * `fetch` (Bun/Node) does NOT persist cookies and auto-follows redirects, so we
 * layer this on top.
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string; // host the cookie applies to (no leading dot)
  path: string;
}

/** Parse a single Set-Cookie header line into a Cookie (domain defaults to reqHost). */
function parseSetCookie(line: string, reqHost: string): Cookie | null {
  const parts = line.split(";");
  const first = parts[0];
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  let domain = reqHost;
  let path = "/";
  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    if (!attr) continue;
    const aeq = attr.indexOf("=");
    const key = (aeq < 0 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
    const val = aeq < 0 ? "" : attr.slice(aeq + 1).trim();
    if (key === "domain" && val) {
      domain = val.replace(/^\./, "").toLowerCase();
    } else if (key === "path" && val) {
      path = val;
    }
  }
  return { name, value, domain, path };
}

/** Does a cookie's domain apply to the request host? (host == domain or subdomain) */
function domainMatch(cookieDomain: string, reqHost: string): boolean {
  const cd = cookieDomain.toLowerCase();
  const rh = reqHost.toLowerCase();
  return rh === cd || rh.endsWith("." + cd);
}

function pathMatch(cookiePath: string, reqPath: string): boolean {
  if (cookiePath === "/" || cookiePath === reqPath) return true;
  if (reqPath.startsWith(cookiePath)) {
    return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
  }
  return false;
}

export class CookieJar {
  // keyed by `${domain}\t${path}\t${name}` so a re-set updates in place
  private store = new Map<string, Cookie>();

  setFromHeaders(headers: Headers, reqHost: string): void {
    // Bun/Node expose multiple Set-Cookie via getSetCookie()
    const lines =
      typeof (headers as any).getSetCookie === "function"
        ? (headers as any).getSetCookie()
        : (() => {
            const v = headers.get("set-cookie");
            return v ? [v] : [];
          })();
    for (const line of lines) {
      const c = parseSetCookie(line, reqHost);
      if (c) this.store.set(`${c.domain}\t${c.path}\t${c.name}`, c);
    }
  }

  /** Build the Cookie request header for a URL, matching domain + path. */
  header(url: URL): string {
    const host = url.hostname;
    const path = url.pathname || "/";
    const matched: Cookie[] = [];
    for (const c of this.store.values()) {
      if (domainMatch(c.domain, host) && pathMatch(c.path, path)) {
        matched.push(c);
      }
    }
    return matched.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  get(name: string): string | undefined {
    for (const c of this.store.values()) {
      if (c.name === name) return c.value;
    }
    return undefined;
  }

  set(name: string, value: string, domain: string, path = "/"): void {
    const d = domain.replace(/^\./, "").toLowerCase();
    this.store.set(`${d}\t${path}\t${name}`, { name, value, domain: d, path });
  }

  dump(): Cookie[] {
    return [...this.store.values()].map((c) => ({ ...c }));
  }

  load(cookies: Cookie[]): void {
    for (const c of cookies) {
      this.set(c.name, c.value, c.domain || "", c.path || "/");
    }
  }
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  url: string; // final URL (after any manual redirects)
  text: string;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** form-urlencoded body. Arrays of [key,value] allow repeated keys. */
  data?: Record<string, string> | Array<[string, string]>;
  /** Raw request body (e.g. a JSON string). Mutually exclusive with `data`. */
  body?: string;
  params?: Record<string, string | number>;
  followRedirects?: boolean;
  maxRedirects?: number;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function encodeForm(
  data: Record<string, string> | Array<[string, string]>,
): string {
  const pairs: Array<[string, string]> = Array.isArray(data)
    ? data
    : Object.entries(data);
  return pairs
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join("&");
}

export class HttpClient {
  readonly cookies = new CookieJar();
  private timeoutMs: number;

  constructor(timeoutMs = 20000) {
    this.timeoutMs = timeoutMs;
  }

  async request(
    rawUrl: string,
    opts: RequestOptions = {},
  ): Promise<HttpResponse> {
    const {
      method = "GET",
      headers = {},
      data,
      body: rawBody,
      params,
      followRedirects = false,
      maxRedirects = 10,
    } = opts;

    let url = new URL(rawUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }

    let currentMethod = method;
    let body: string | undefined;
    const baseHeaders: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Accept-Language": "ko-KR,ko;q=0.9",
      ...headers,
    };
    if (rawBody !== undefined) {
      body = rawBody;
    } else if (data !== undefined) {
      body = encodeForm(data);
      if (!hasHeader(baseHeaders, "content-type")) {
        baseHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    let redirects = 0;
    while (true) {
      const reqHeaders: Record<string, string> = { ...baseHeaders };
      const cookieHeader = this.cookies.header(url);
      if (cookieHeader) reqHeaders["Cookie"] = cookieHeader;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(url.toString(), {
          method: currentMethod,
          headers: reqHeaders,
          body: currentMethod === "POST" ? body : undefined,
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      this.cookies.setFromHeaders(resp.headers, url.hostname);

      const isRedirect =
        resp.status >= 300 && resp.status < 400 && resp.headers.has("location");

      if (followRedirects && isRedirect && redirects < maxRedirects) {
        redirects++;
        const loc = resp.headers.get("location")!;
        url = new URL(loc, url);
        // 303, or 301/302 on POST -> switch to GET and drop body (browser behavior)
        if (
          resp.status === 303 ||
          ((resp.status === 301 || resp.status === 302) &&
            currentMethod === "POST")
        ) {
          currentMethod = "GET";
          body = undefined;
          delete baseHeaders["Content-Type"];
        }
        continue;
      }

      const text = await resp.text();
      return {
        status: resp.status,
        headers: resp.headers,
        url: url.toString(),
        text,
      };
    }
  }

  get(url: string, opts: Omit<RequestOptions, "method"> = {}) {
    return this.request(url, { ...opts, method: "GET" });
  }

  post(url: string, opts: Omit<RequestOptions, "method"> = {}) {
    return this.request(url, { ...opts, method: "POST" });
  }
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());
}
