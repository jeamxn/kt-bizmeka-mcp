# KT Bizmeka MCP — OAuth-gated Remote Server Implementation Plan

> **For implementer:** Build task-by-task. Each task is small, has exact paths, complete code, and a verification step. Commit after each task.

**Goal:** Add an OAuth 2.1 Authorization Server to the remote (HTTP) transport where the `/authorize` page IS the bizmeka login (id/pw → SMS → OTP). Only after a successful bizmeka login does the user get an MCP access token. Credentials/trust live in Postgres (encrypted), never on local disk for the remote path. The local `exe` (stdio) keeps working exactly as today via a file-backed storage backend.

**Architecture:**
- Storage is abstracted behind an interface with two backends: `file` (stdio/exe, current behavior) and `db` (Postgres, remote).
- The remote server implements OAuth AS endpoints directly inside the existing `Bun.serve` fetch handler (the SDK's auth handlers are express-bound, incompatible with our WebStandard transport).
- OAuth `sub` = bizmeka username (1:1). Access token short-lived, refresh token long-lived → infinite renewal while the stored browserCertify cookie keeps working.
- bizmeka password + browserCertify cookies are AES-256-GCM encrypted with `MASTER_KEY` (injected via dokploy env), stored in `user_trust`.
- Container is stateless (all OAuth + login-flow state in DB) so a load balancer can be added later.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk` (transport only), Postgres via `Bun.sql`, AES-256-GCM (node:crypto), Docker + dokploy.

---

## Decisions locked
1. bizmeka account = MCP user (1:1). bizmeka login at `/authorize` is the identity.
2. Refresh token → infinite renewal (no forced periodic re-login while certify cookie valid).
3. `MASTER_KEY` provided via dokploy env (not in compose file, just a slot).
4. Single container now, but **stateless** (login-flow state in DB) to allow future LB.

---

## Environment / config matrix

| Mode | `MCP_TRANSPORT` | `STORAGE` | Auth | Where state lives |
|------|-----------------|-----------|------|-------------------|
| Local exe | `stdio` (default) | `file` (default) | none (local user) | `~/.cache/kt-bizmeka/` files |
| Remote   | `http` | `db` | OAuth 2.1 | Postgres |

New env vars (remote): `STORAGE=db`, `DATABASE_URL=postgres://...`, `MASTER_KEY=<base64 32 bytes>`, `PUBLIC_URL=https://bizmeka-mcp.jeamxn.dev` (issuer + redirect base).

---

## Phase 0 — Storage abstraction (no behavior change)

### Task 0.1: Define storage interfaces
**Files:**
- Create: `src/storage/types.ts`

Define interfaces capturing what the app needs today (so the file backend is a drop-in):
```ts
import type { Cookie } from "../http.ts";
import type { ClientState } from "../client.ts";

export interface SessionRecord {
  state: ClientState;
  createdAt: number;
  lastUsedAt: number;
  authenticated: boolean;
  portalUrl: string | null;
  ssoRedirect: string;
}

export interface TrustRecord {
  username: string;
  password?: string;
  cookies: Cookie[];
  savedAt: number;
}

/** In-flight bizmeka login sessions (login_start → verify_otp). */
export interface SessionBackend {
  create(rec: SessionRecord): Promise<string> | string;
  get(sid: string): Promise<SessionRecord | null> | SessionRecord | null;
  save(sid: string, rec: SessionRecord): Promise<void> | void;
  drop(sid: string): Promise<void> | void;
}

/** Long-lived remembered-browser credentials (per bizmeka username). */
export interface TrustBackend {
  save(rec: TrustRecord): Promise<void> | void;
  read(username: string): Promise<TrustRecord | null> | TrustRecord | null;
  drop(username: string): Promise<void> | void;
  listUsernames(): Promise<string[]> | string[];
}
```
**Verify:** `bunx tsc --noEmit` clean.
**Commit:** `refactor: add storage backend interfaces`

### Task 0.2: Extract current file logic into `FileSessionBackend` + `FileTrustBackend`
**Files:**
- Create: `src/storage/file.ts` (move the fs-based logic out of `session.ts`)
- Modify: `src/session.ts` (keep `store`/`trust` singletons but delegate to a backend selected by env)

Keep `SessionStore`/`TrustStore` public API identical (sync today). The file backend stays sync; the DB backend is async — so **promote the public API to async** (return Promises) and `await` at call sites. (This is the one cross-cutting change; do it carefully.)

**Verify:** `bunx tsc --noEmit`; run existing stdio smoke (login flow) — unchanged.
**Commit:** `refactor: file-backed storage behind backend interface`

### Task 0.3: Make `store`/`trust` async at all call sites
**Files:**
- Modify: `src/server.ts` (every `store.*`/`trust.*` call → `await`)
- Modify: `src/client.ts` if it touches trust (it does in `tryRelogin` via `trust.load`)

**Verify:** `bunx tsc --noEmit` clean; rebuild `current`; re-run the full stdio verification (OTP login → delete session files → `login_start {}` skips SMS). Must still pass.
**Commit:** `refactor: await storage calls (prep for async db backend)`

---

## Phase 1 — Postgres backend

### Task 1.1: Add DB bootstrap + schema
**Files:**
- Create: `src/storage/db.ts`
- Create: `src/storage/schema.sql`

Schema:
```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,                 -- null for public clients
  redirect_uris JSONB NOT NULL,
  client_name TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,              -- bizmeka user (sub)
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token TEXT PRIMARY KEY,             -- store sha256(token), not raw
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  scope TEXT,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,             -- store sha256(token)
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  scope TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
-- in-flight bizmeka login during /authorize (survives the SMS wait, enables stateless LB)
CREATE TABLE IF NOT EXISTS login_flows (
  flow_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  -- the in-progress bizmeka session (cookies/ctx) encrypted
  enc_session BYTEA,
  username TEXT,
  stage TEXT NOT NULL,                -- 'await_otp'
  expires_at BIGINT NOT NULL
);
-- remembered bizmeka credentials (the remote equivalent of the trust file)
CREATE TABLE IF NOT EXISTS user_trust (
  username TEXT PRIMARY KEY,
  enc_password BYTEA,                 -- AES-256-GCM(MASTER_KEY)
  enc_cookies BYTEA NOT NULL,         -- AES-256-GCM(MASTER_KEY)
  saved_at BIGINT NOT NULL
);
-- in-flight MCP tool sessions (login_start → verify_otp on the TOOL path, if used remotely)
CREATE TABLE IF NOT EXISTS tool_sessions (
  sid TEXT PRIMARY KEY,
  enc_state BYTEA NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL,
  authenticated BOOLEAN NOT NULL,
  portal_url TEXT,
  sso_redirect TEXT NOT NULL DEFAULT ''
);
```
`db.ts`: lazy `Bun.sql` connection from `DATABASE_URL`, run `schema.sql` on first connect (idempotent `CREATE TABLE IF NOT EXISTS`), export `sql`.

**Verify:** unit: connect to a local pg (docker run postgres), import db.ts, assert tables exist.
**Commit:** `feat: postgres connection + schema bootstrap`

### Task 1.2: AES-256-GCM crypto helper
**Files:**
- Create: `src/storage/crypto_box.ts`

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function key(): Buffer {
  const b64 = process.env.MASTER_KEY;
  if (!b64) throw new Error("MASTER_KEY not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("MASTER_KEY must be base64 of 32 bytes");
  return k;
}
export function seal(plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]); // iv(12)+tag(16)+ct
}
export function open(box: Buffer): string {
  const iv = box.subarray(0, 12), tag = box.subarray(12, 28), ct = box.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
```
**Verify:** round-trip test (`open(seal(x)) === x`); wrong key throws.
**Commit:** `feat: AES-256-GCM seal/open for credential storage`

### Task 1.3: `DbSessionBackend` + `DbTrustBackend`
**Files:**
- Modify: `src/storage/db.ts`

Implement the two backend interfaces against `tool_sessions` / `user_trust`, encrypting `state`/`password`/`cookies` via crypto_box. `listUsernames()` → `SELECT username FROM user_trust`.

**Verify:** integration test against local pg: save trust → read back equal; save session → get equal; drop works.
**Commit:** `feat: postgres-backed session + trust backends`

### Task 1.4: Backend selection by env
**Files:**
- Modify: `src/session.ts`

`STORAGE=db` → DB backends; else file. Keep singletons `store`, `trust`.
**Verify:** `STORAGE=file` stdio path unchanged; `STORAGE=db DATABASE_URL=... MASTER_KEY=...` boots without error.
**Commit:** `feat: select storage backend via STORAGE env`

---

## Phase 2 — OAuth Authorization Server (remote only)

### Task 2.1: OAuth metadata + protected-resource documents
**Files:**
- Create: `src/oauth/metadata.ts`

Serve (issuer = `PUBLIC_URL`):
- `GET /.well-known/oauth-authorization-server` → `{ issuer, authorization_endpoint, token_endpoint, registration_endpoint, response_types_supported:["code"], code_challenge_methods_supported:["S256"], grant_types_supported:["authorization_code","refresh_token"], token_endpoint_auth_methods_supported:["none"] }`
- `GET /.well-known/oauth-protected-resource` → `{ resource: PUBLIC_URL + "/mcp", authorization_servers:[PUBLIC_URL] }`

**Verify:** curl both endpoints → valid JSON.
**Commit:** `feat: OAuth discovery metadata endpoints`

### Task 2.2: Dynamic Client Registration
**Files:**
- Create: `src/oauth/clients.ts`

`POST /register` → validate `redirect_uris`, generate `client_id` (random), public client (`token_endpoint_auth_method:"none"`, no secret), persist to `oauth_clients`, return per RFC 7591.
**Verify:** curl register → returns client_id; row in DB.
**Commit:** `feat: dynamic client registration (RFC 7591)`

### Task 2.3: `/authorize` GET — render bizmeka login page
**Files:**
- Create: `src/oauth/authorize.ts`
- Create: `src/oauth/pages.ts` (minimal HTML, antd-free, no emoji; clean editorial form)

`GET /authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope`:
- validate client_id + redirect_uri against `oauth_clients` (exact match)
- validate `code_challenge_method=S256`
- render HTML form (step 1): bizmeka **아이디 / 비밀번호** inputs, hidden field carrying a signed `req` blob (the oauth params) OR create a `login_flows` row now and carry `flow_id`.
**Verify:** open URL in browser → form renders; bad client_id → error page.
**Commit:** `feat: /authorize renders bizmeka login (step 1)`

### Task 2.4: `/authorize` POST step 1 — id/pw → bizmeka 1st factor + SMS
**Files:**
- Modify: `src/oauth/authorize.ts`

On POST (stage=credentials): run the existing `BizmekaClient.submitCredentials()` flow.
- If trusted-browser fast path (no 2FA) → skip straight to issuing a code (Task 2.6 logic).
- Else `loadSecondStep()` + `sendSms()`, persist the in-progress client (`enc_session`) + username into a `login_flows` row (stage=`await_otp`), render **OTP 입력 폼** (step 2) carrying `flow_id`.
- On bad credentials → re-render step 1 with an error.
**Verify:** real bizmeka id/pw via browser → SMS arrives, OTP page shows.
**Commit:** `feat: /authorize step 1 (bizmeka credentials + SMS)`

### Task 2.5: `/authorize` POST step 2 — OTP → verify + persist trust + issue code
**Files:**
- Modify: `src/oauth/authorize.ts`

On POST (stage=await_otp): load `login_flows`, restore client, `verifyOtp(otp, true)` (always remember). On success:
- `trust.save({username, password, cookies})` → encrypted `user_trust`
- create `auth_codes` row (code, client_id, username, redirect_uri, code_challenge, 60s expiry)
- delete the `login_flows` row
- `302` to `redirect_uri?code=...&state=...`
On bad OTP → re-render step 2 with error.
**Verify:** full browser flow → lands back on client redirect with `?code=`.
**Commit:** `feat: /authorize step 2 (OTP verify, persist trust, issue code)`

### Task 2.6: `/token` — code exchange + refresh
**Files:**
- Create: `src/oauth/token.ts`

`POST /token`:
- `grant_type=authorization_code`: validate code (exists, unexpired, client matches, redirect matches), **PKCE**: `base64url(sha256(code_verifier)) === code_challenge`. Issue access token (random, store `sha256` + 1h expiry) + refresh token (random, store `sha256`). Delete the code. Return `{access_token, token_type:"Bearer", expires_in:3600, refresh_token, scope}`.
- `grant_type=refresh_token`: validate (exists, not revoked), issue a new access token (rotate refresh optional; keep same for simplicity). Infinite renewal.
**Verify:** curl exchange with a real code + verifier → tokens; refresh → new access token.
**Commit:** `feat: /token authorization_code + refresh_token grants`

### Task 2.7: Bearer auth middleware on `/mcp`
**Files:**
- Modify: `src/server.ts` (runHttp fetch handler)

For `db` storage + `/mcp`: require `Authorization: Bearer <token>`. Verify against `access_tokens` (sha256 lookup, unexpired). On fail → `401` + `WWW-Authenticate: Bearer resource_metadata="PUBLIC_URL/.well-known/oauth-protected-resource"`. On success → attach resolved `username` to the request context for tool calls. `file` storage / stdio path = no auth (unchanged).
**Verify:** `/mcp` without token → 401 with WWW-Authenticate; with valid token → MCP initialize works.
**Commit:** `feat: gate /mcp behind bearer access tokens (db mode)`

### Task 2.8: Auto-bind authenticated user to tool calls (remote)
**Files:**
- Modify: `src/server.ts` (buildServer — accept an optional `authedUsername`)

When the server is built for an authenticated remote session, inject the username so tools resolve the bizmeka client from `user_trust` automatically (auto-login like the stdio fast path). Remote users never call `bizmeka_login_start`/`verify_otp` (OAuth did it) — those tools can return a helpful "already authenticated via OAuth" message, or stay available for re-trust.
**Verify:** with a valid token, call `bizmeka_mail_folders` (no explicit login) → returns folders.
**Commit:** `feat: bind OAuth user to tool session (auto bizmeka client)`

---

## Phase 3 — Packaging

### Task 3.1: Dockerfile
**Files:**
- Create: `Dockerfile`

Multi-stage: `oven/bun:1.3` → `bun install` → copy src → run via `bun src/server.ts` (do NOT compile; needs Bun runtime + Bun.sql). `ENV MCP_TRANSPORT=http STORAGE=db MCP_PORT=8000`. `EXPOSE 8000`. Non-root user. Healthcheck `GET /health`.
**Verify:** `docker build` succeeds; `docker run` with env boots and `/health` returns ok.
**Commit:** `feat: Dockerfile for remote http server`

### Task 3.2: docker-compose.yml (dokploy)
**Files:**
- Create: `docker-compose.yml`

```yaml
services:
  mcp:
    build: .
    environment:
      MCP_TRANSPORT: http
      STORAGE: db
      MCP_PORT: 8000
      DATABASE_URL: postgres://bizmeka:${POSTGRES_PASSWORD}@db:5432/bizmeka
      MASTER_KEY: ${MASTER_KEY}
      PUBLIC_URL: ${PUBLIC_URL}
    expose:
      - "8000"          # no host port binding — dokploy/Traefik routes the domain
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: bizmeka
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: bizmeka
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bizmeka"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped
volumes:
  pgdata:
```
dokploy env slots to fill: `POSTGRES_PASSWORD`, `MASTER_KEY` (base64 32B), `PUBLIC_URL=https://bizmeka-mcp.jeamxn.dev`.
Note ALLOWED/proxy: server must trust `X-Forwarded-Proto` so issuer URLs are https. Bind `0.0.0.0`. No host `ports:`.
**Verify:** `docker compose up` locally with a test `.env` → both healthy, `/health` ok, discovery JSON reachable.
**Commit:** `feat: docker-compose for dokploy deployment`

### Task 3.3: README — remote deploy + Claude connect
**Files:**
- Modify: `README.md`

Document env vars, how to generate `MASTER_KEY` (`openssl rand -base64 32`), dokploy setup (expose only, domain routing, https headers), and how to add the connector in Claude (`https://bizmeka-mcp.jeamxn.dev/mcp`, OAuth auto-discovered).
**Commit:** `docs: remote OAuth deployment guide`

---

## Validation (end-to-end, after Phase 3)
1. `docker compose up`; register a client (curl) → client_id.
2. Build authorize URL with PKCE; open in browser → bizmeka login → SMS → OTP → redirect with `?code`.
3. `POST /token` (code+verifier) → access+refresh tokens.
4. `POST /mcp` initialize with Bearer → session; call `bizmeka_mail_folders` → folders (no manual login).
5. Wait past access-token expiry; refresh → new token; `/mcp` still works.
6. Second bizmeka account → fully isolated trust (no cross-user leakage).
7. Confirm `user_trust` rows are encrypted bytea (psql: not readable plaintext).
8. Local exe path: `STORAGE` unset → file mode, stdio login still works unchanged.

## Risks / open questions
- **Bun.sql maturity** — if flaky, fall back to `postgres` npm driver (add dep). Decide at Task 1.1.
- **Cross-cutting async refactor (Task 0.3)** is the riskiest; re-run the full stdio verification after it.
- **browserCertify lifetime** — if bizmeka eventually invalidates the certify cookie, refresh-based auto-login will fail; the user must re-`/authorize`. Token verify should detect the downstream bizmeka session-dead error and surface a re-auth hint.
- **Stdio binary** still compiles without Postgres (db.ts must be lazily imported only in db mode, so `bun build --compile` doesn't pull a live connection).
- **PKCE required** for all clients (public clients, no secret) — reject missing/invalid challenge.
