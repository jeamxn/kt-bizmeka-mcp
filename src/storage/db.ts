/**
 * Postgres-backed storage (remote HTTP server). Mirrors the file backend's
 * semantics: sliding idle expiry for sessions, durable trust records. Secrets
 * (ClientState, cookie jars, passwords) are AES-256-GCM encrypted at rest.
 *
 * Only imported when STORAGE=db, so the stdio binary never loads the pg driver.
 */
import { randomBytes } from "node:crypto";
import { BizmekaClient } from "../client.ts";
import type { Cookie } from "../http.ts";
import { db } from "./pg.ts";
import { decryptJson, encryptJson } from "./crypto.ts";
import {
  SESSION_IDLE_TTL_MS,
  type Session,
  type SessionBackend,
  type SessionPatch,
  type SessionRecord,
  type TrustBackend,
  type TrustRecord,
} from "./types.ts";

function now(): number {
  return Date.now();
}

export class DbSessionBackend implements SessionBackend {
  async create(client: BizmekaClient, ssoRedirect = ""): Promise<string> {
    const sql = await db();
    const sid = randomBytes(16).toString("base64url");
    const t = now();
    const encState = encryptJson(client.dumpState());
    await sql`
      INSERT INTO tool_sessions
        (sid, enc_state, created_at, last_used_at, authenticated, portal_url, sso_redirect)
      VALUES
        (${sid}, ${encState}, ${t}, ${t}, ${false}, ${null}, ${ssoRedirect})
    `;
    // Opportunistic GC of idle sessions.
    await sql`DELETE FROM tool_sessions WHERE last_used_at < ${t - SESSION_IDLE_TTL_MS}`;
    return sid;
  }

  async get(sid: string): Promise<Session | undefined> {
    const sql = await db();
    const rows = await sql`SELECT * FROM tool_sessions WHERE sid = ${sid}`;
    const row = rows[0];
    if (!row) return undefined;
    const lastUsed = Number(row.last_used_at);
    if (now() - lastUsed > SESSION_IDLE_TTL_MS) {
      await this.drop(sid);
      return undefined;
    }
    const state = decryptJson<ReturnType<BizmekaClient["dumpState"]>>(
      row.enc_state,
    );
    return {
      client: BizmekaClient.restore(state),
      ssoRedirect: row.sso_redirect ?? "",
      createdAt: Number(row.created_at),
      authenticated: row.authenticated,
      portalUrl: row.portal_url ?? null,
    };
  }

  async save(
    sid: string,
    client: BizmekaClient,
    patch: SessionPatch = {},
  ): Promise<void> {
    const sql = await db();
    const encState = encryptJson(client.dumpState());
    const t = now();
    // Only update an existing row (mirrors file backend's "no upsert on save").
    if (patch.authenticated !== undefined && patch.portalUrl !== undefined) {
      await sql`
        UPDATE tool_sessions SET enc_state=${encState}, last_used_at=${t},
          authenticated=${patch.authenticated}, portal_url=${patch.portalUrl}
        WHERE sid=${sid}`;
    } else if (patch.authenticated !== undefined) {
      await sql`
        UPDATE tool_sessions SET enc_state=${encState}, last_used_at=${t},
          authenticated=${patch.authenticated}
        WHERE sid=${sid}`;
    } else if (patch.portalUrl !== undefined) {
      await sql`
        UPDATE tool_sessions SET enc_state=${encState}, last_used_at=${t},
          portal_url=${patch.portalUrl}
        WHERE sid=${sid}`;
    } else {
      await sql`
        UPDATE tool_sessions SET enc_state=${encState}, last_used_at=${t}
        WHERE sid=${sid}`;
    }
  }

  async drop(sid: string): Promise<void> {
    const sql = await db();
    await sql`DELETE FROM tool_sessions WHERE sid = ${sid}`;
  }
}

export class DbTrustBackend implements TrustBackend {
  async save(
    username: string,
    cookies: Cookie[],
    password?: string,
  ): Promise<void> {
    const sql = await db();
    const encCookies = encryptJson(cookies);
    const t = now();
    // Preserve an existing password if this save omits one.
    if (password !== undefined) {
      const encPw = encryptJson(password);
      await sql`
        INSERT INTO user_trust (username, enc_password, enc_cookies, saved_at)
        VALUES (${username}, ${encPw}, ${encCookies}, ${t})
        ON CONFLICT (username) DO UPDATE
          SET enc_password=${encPw}, enc_cookies=${encCookies}, saved_at=${t}`;
    } else {
      await sql`
        INSERT INTO user_trust (username, enc_password, enc_cookies, saved_at)
        VALUES (${username}, ${null}, ${encCookies}, ${t})
        ON CONFLICT (username) DO UPDATE
          SET enc_cookies=${encCookies}, saved_at=${t}`;
    }
  }

  async read(username: string): Promise<TrustRecord | null> {
    const sql = await db();
    const rows =
      await sql`SELECT * FROM user_trust WHERE username = ${username}`;
    const row = rows[0];
    if (!row) return null;
    return {
      username: row.username,
      password: row.enc_password
        ? decryptJson<string>(row.enc_password)
        : undefined,
      cookies: decryptJson<Cookie[]>(row.enc_cookies),
      savedAt: Number(row.saved_at),
    };
  }

  async load(username: string): Promise<Cookie[] | null> {
    return (await this.read(username))?.cookies ?? null;
  }

  async loadPassword(username: string): Promise<string | null> {
    return (await this.read(username))?.password ?? null;
  }

  async listUsernames(): Promise<string[]> {
    const sql = await db();
    const rows = await sql`SELECT username FROM user_trust`;
    return rows.map((r) => r.username as string);
  }

  async mostRecentUsername(): Promise<string | null> {
    const sql = await db();
    const rows = await sql`
      SELECT username FROM user_trust
      WHERE enc_password IS NOT NULL
      ORDER BY saved_at DESC LIMIT 1`;
    return rows[0]?.username ?? null;
  }

  async drop(username: string): Promise<void> {
    const sql = await db();
    await sql`DELETE FROM user_trust WHERE username = ${username}`;
  }
}
