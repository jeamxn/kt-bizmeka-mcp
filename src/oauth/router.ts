/**
 * OAuth route dispatcher (remote / db mode only).
 *
 * This module statically imports the OAuth handlers, which in turn import the
 * Postgres driver (via pg.ts). It is therefore **only dynamically imported**
 * from runHttp() when STORAGE=db, so the stdio binary never bundles the pg
 * driver (see the plan's "stdio binary still compiles without Postgres" risk).
 */
import {
  authServerMetadata,
  protectedResourceMetadata,
  issuerFor,
} from "./metadata.ts";
import { registerClient } from "./clients.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "./authorize.ts";
import { handleToken, resolveBearer } from "./token.ts";

export interface OAuthRouter {
  /** Handle an OAuth-namespaced request, or return null if not ours. */
  handle(req: Request, url: URL): Promise<Response | null>;
  /** Resolve a Bearer token on /mcp → bizmeka username, or null. */
  resolveBearer(token: string): Promise<string | null>;
  /** 401 challenge pointing clients at the protected-resource metadata. */
  unauthorized(req: Request): Response;
}

function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function createRouter(): OAuthRouter {
  return {
    async handle(req: Request, url: URL): Promise<Response | null> {
      const p = url.pathname;
      if (req.method === "OPTIONS" && p !== "/mcp" && p !== "/mcp/") {
        return cors();
      }
      // Discovery metadata. RFC 9728 / RFC 8414 + the MCP spec let clients probe
      // path-aware variants, e.g. when the resource is https://host/mcp the
      // client may GET /.well-known/oauth-protected-resource/mcp (path inserted
      // after the well-known segment). Match the base path AND any suffix so
      // both the bare and path-aware forms resolve (Claude probes the suffixed
      // form first when adding the connector).
      if (p.startsWith("/.well-known/oauth-authorization-server")) {
        return authServerMetadata(req);
      }
      if (p.startsWith("/.well-known/oauth-protected-resource")) {
        return protectedResourceMetadata(req);
      }
      switch (p) {
        case "/register":
          if (req.method === "POST") return registerClient(req);
          return new Response("Method Not Allowed", { status: 405 });
        case "/authorize":
          if (req.method === "GET") return handleAuthorizeGet(req);
          if (req.method === "POST") return handleAuthorizePost(req);
          return new Response("Method Not Allowed", { status: 405 });
        case "/token":
          if (req.method === "POST") return handleToken(req);
          return new Response("Method Not Allowed", { status: 405 });
        default:
          return null;
      }
    },
    resolveBearer,
    unauthorized(req: Request): Response {
      const issuer = issuerFor(req);
      return new Response(
        JSON.stringify({ error: "invalid_token" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    },
  };
}
