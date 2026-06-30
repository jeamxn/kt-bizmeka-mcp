/**
 * OAuth /token — authorization_code (with PKCE) and refresh_token grants.
 *
 * Access tokens are short-lived (1h); refresh tokens are long-lived and grant
 * infinite renewal (the user never re-authenticates as long as the stored
 * bizmeka trust keeps working). Raw token values are returned to the client
 * but only their sha256 hashes are stored, so a DB leak can't replay them.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "../storage/pg.ts";
import { sha256 } from "../storage/crypto.ts";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour

function tokenError(error: string, status = 400): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function tokenOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** base64url(sha256(verifier)) === challenge ? (PKCE S256) */
function pkceOk(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

async function mintTokens(
  clientId: string,
  username: string,
  scope: string | null,
): Promise<{ access: string; refresh: string }> {
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const sql = await db();
  await sql`
    INSERT INTO access_tokens (token, client_id, username, scope, expires_at)
    VALUES (${sha256(access)}, ${clientId}, ${username}, ${scope}, ${Date.now() + ACCESS_TTL_MS})
  `;
  await sql`
    INSERT INTO refresh_tokens (token, client_id, username, scope, revoked, created_at)
    VALUES (${sha256(refresh)}, ${clientId}, ${username}, ${scope}, ${false}, ${Date.now()})
  `;
  return { access, refresh };
}

export async function handleToken(req: Request): Promise<Response> {
  let form: { get(name: string): unknown };
  try {
    form = await req.formData();
  } catch {
    return tokenError("invalid_request");
  }
  const grantType = String(form.get("grant_type") ?? "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    const verifier = String(form.get("code_verifier") ?? "");
    if (!code || !clientId || !redirectUri || !verifier) {
      return tokenError("invalid_request");
    }

    const sql = await db();
    const rows = await sql<
      {
        code: string;
        client_id: string;
        username: string;
        redirect_uri: string;
        code_challenge: string;
        scope: string | null;
        expires_at: number;
      }[]
    >`SELECT * FROM auth_codes WHERE code = ${code}`;
    const row = rows[0];
    // Single-use: delete immediately regardless of outcome.
    if (row) await sql`DELETE FROM auth_codes WHERE code = ${code}`;

    if (!row) return tokenError("invalid_grant");
    if (Number(row.expires_at) < Date.now()) return tokenError("invalid_grant");
    if (row.client_id !== clientId) return tokenError("invalid_grant");
    if (row.redirect_uri !== redirectUri) return tokenError("invalid_grant");
    if (!pkceOk(verifier, row.code_challenge)) return tokenError("invalid_grant");

    const { access, refresh } = await mintTokens(clientId, row.username, row.scope);
    return tokenOk({
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: row.scope ?? "mcp",
    });
  }

  if (grantType === "refresh_token") {
    const refresh = String(form.get("refresh_token") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    if (!refresh || !clientId) return tokenError("invalid_request");

    const sql = await db();
    const rows = await sql<
      {
        token: string;
        client_id: string;
        username: string;
        scope: string | null;
        revoked: boolean;
      }[]
    >`SELECT * FROM refresh_tokens WHERE token = ${sha256(refresh)}`;
    const row = rows[0];
    if (!row || row.revoked) return tokenError("invalid_grant");
    if (row.client_id !== clientId) return tokenError("invalid_grant");

    // Issue a fresh access token; keep the same refresh token (infinite renewal).
    const access = randomBytes(32).toString("base64url");
    await sql`
      INSERT INTO access_tokens (token, client_id, username, scope, expires_at)
      VALUES (${sha256(access)}, ${clientId}, ${row.username}, ${row.scope}, ${Date.now() + ACCESS_TTL_MS})
    `;
    return tokenOk({
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: row.scope ?? "mcp",
    });
  }

  return tokenError("unsupported_grant_type");
}

/**
 * Resolve a Bearer access token to its bizmeka username, or null if invalid /
 * expired. Used by the /mcp gate (Task 2.7).
 */
export async function resolveBearer(token: string): Promise<string | null> {
  const sql = await db();
  const rows = await sql<{ username: string; expires_at: number }[]>`
    SELECT username, expires_at FROM access_tokens WHERE token = ${sha256(token)}
  `;
  const row = rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  return row.username;
}
