/**
 * Dynamic Client Registration (RFC 7591) — remote / db mode.
 *
 * MCP clients (Claude) register themselves before the OAuth dance. We only
 * support PUBLIC clients (PKCE, no client secret): the connector runs on the
 * user's machine and can't keep a secret. Registered clients live in
 * `oauth_clients` so any container behind a load balancer can validate them.
 */
import { randomBytes } from "node:crypto";
import { db } from "../storage/pg.ts";

function bad(error: string, desc: string): Response {
  return new Response(JSON.stringify({ error, error_description: desc }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** Look up a registered client; null if unknown. */
export async function getClient(clientId: string): Promise<{
  client_id: string;
  redirect_uris: string[];
  client_name: string | null;
} | null> {
  const sql = await db();
  const rows = await sql<
    { client_id: string; redirect_uris: string[]; client_name: string | null }[]
  >`SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id = ${clientId}`;
  return rows[0] ?? null;
}

/** True if redirect_uri exactly matches one of the client's registered URIs. */
export function redirectAllowed(
  client: { redirect_uris: string[] },
  redirectUri: string,
): boolean {
  return client.redirect_uris.includes(redirectUri);
}

/** POST /register — validate redirect_uris, mint a public client, persist it. */
export async function registerClient(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return bad("invalid_client_metadata", "request body must be JSON");
  }

  const redirectUris: unknown = body?.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((u) => typeof u === "string" && /^https?:\/\//.test(u))
  ) {
    return bad(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array of http(s) URLs",
    );
  }

  const clientId = randomBytes(16).toString("hex");
  const clientName =
    typeof body?.client_name === "string" ? body.client_name : null;
  const createdAt = Date.now();

  const sql = await db();
  await sql`
    INSERT INTO oauth_clients
      (client_id, client_secret, redirect_uris, client_name, token_endpoint_auth_method, created_at)
    VALUES
      (${clientId}, ${null}, ${sql.json(redirectUris)}, ${clientName}, ${"none"}, ${createdAt})
  `;

  return new Response(
    JSON.stringify({
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: clientName ?? undefined,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(createdAt / 1000),
    }),
    {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
