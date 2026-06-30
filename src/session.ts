/**
 * In-memory session registry for in-flight bizmeka logins.
 *
 * A login spans two MCP tool calls (`bizmeka_login_start` sends the SMS, then
 * `bizmeka_verify_otp` finishes after the user reads the code), so the
 * authenticated BizmekaClient must survive between calls. We keep them in a
 * process-local map keyed by an opaque session id. Sessions expire so stale
 * cookie jars don't pile up.
 */

import { randomBytes } from "node:crypto";
import { BizmekaClient } from "./client.ts";

// How long a half-finished login (SMS sent, OTP pending) stays valid.
const SESSION_TTL_MS = 600_000;

export interface Session {
  client: BizmekaClient;
  ssoRedirect: string;
  createdAt: number;
  authenticated: boolean;
  portalUrl: string | null;
}

function expired(s: Session): boolean {
  return Date.now() - s.createdAt > SESSION_TTL_MS;
}

class SessionStore {
  private sessions = new Map<string, Session>();

  private gc(): void {
    for (const [sid, s] of this.sessions) {
      if (expired(s)) this.sessions.delete(sid);
    }
  }

  create(client: BizmekaClient, ssoRedirect = ""): string {
    this.gc();
    const sid = randomBytes(16).toString("base64url");
    this.sessions.set(sid, {
      client,
      ssoRedirect,
      createdAt: Date.now(),
      authenticated: false,
      portalUrl: null,
    });
    return sid;
  }

  get(sid: string): Session | undefined {
    this.gc();
    return this.sessions.get(sid);
  }

  drop(sid: string): void {
    this.sessions.delete(sid);
  }
}

export const store = new SessionStore();
