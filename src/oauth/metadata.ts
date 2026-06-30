/**
 * OAuth 2.1 discovery metadata (remote / db mode only).
 *
 * Claude (and other MCP clients) auto-discover the authorization server from
 * these well-known documents, so the user only pastes the `/mcp` URL.
 *
 * The issuer is PUBLIC_URL when set; otherwise we derive it from the incoming
 * request, honoring X-Forwarded-Proto/Host so issuer URLs come out https when
 * behind dokploy/Traefik.
 */

/** Resolve the public-facing base URL (issuer), proxy-aware. No trailing slash. */
export function issuerFor(req: Request): string {
  const explicit = process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** GET /.well-known/oauth-authorization-server */
export function authServerMetadata(req: Request): Response {
  const issuer = issuerFor(req);
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}

/** GET /.well-known/oauth-protected-resource */
export function protectedResourceMetadata(req: Request): Response {
  const issuer = issuerFor(req);
  return json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
  });
}
