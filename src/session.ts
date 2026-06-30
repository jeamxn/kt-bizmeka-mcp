/**
 * Disk-backed session registry for in-flight bizmeka logins.
 *
 * A login spans two MCP tool calls (`bizmeka_login_start` sends the SMS, then
 * `bizmeka_verify_otp` finishes after the user reads the code), and the
 * authenticated BizmekaClient must survive between them.
 *
 * The original in-memory Map only works when one long-lived process handles
 * both calls (streamable-http). Stdio hosts like Claude cowork spawn a FRESH
 * process per tool call, so an in-memory Map is empty on the second call and
 * every login fails with "세션이 만료되었거나 존재하지 않습니다". We therefore
 * persist each session to disk (a small JSON file keyed by sid) so it survives
 * process restarts. Sessions expire on INACTIVITY (a sliding window keyed off
 * the last use) so stale cookie jars don't pile up, while a session that's
 * actively being used — e.g. reading mail, then composing a long HTML mail
 * before sending — stays alive. (A previous version keyed expiry off the fixed
 * createdAt, which hard-killed in-use sessions 10 minutes after login_start and
 * surfaced as a spurious "세션이 만료되었거나 존재하지 않습니다" mid-task.)
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BizmekaClient, type ClientState } from "./client.ts";

// How long a session stays valid AFTER ITS LAST USE (sliding idle window).
// Each successful tool call refreshes this via store.save(). Set generously so
// a human reading/composing mail between calls doesn't get logged out; stale
// abandoned sessions (OTP never entered, etc.) still get GC'd after this idle.
const SESSION_IDLE_TTL_MS = 1_800_000; // 30 min of inactivity

/** Where session files live. Honors MCP_SESSION_DIR, else ~/.cache, else tmp. */
function sessionDir(): string {
  const override = process.env.MCP_SESSION_DIR;
  const base = override
    ? override
    : safeJoin(homedir(), ".cache", "kt-bizmeka") ??
      join(tmpdir(), "kt-bizmeka");
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    return base;
  } catch {
    const fallback = join(tmpdir(), "kt-bizmeka");
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    return fallback;
  }
}

function safeJoin(...parts: string[]): string | null {
  try {
    return join(...parts);
  } catch {
    return null;
  }
}

interface SessionFile {
  state: ClientState;
  createdAt: number;
  /** Refreshed on every save(); expiry is measured from this, not createdAt. */
  lastUsedAt: number;
  authenticated: boolean;
  portalUrl: string | null;
  ssoRedirect: string;
}

/** Live view of a session: the rehydrated client + its metadata. */
export interface Session {
  client: BizmekaClient;
  ssoRedirect: string;
  createdAt: number;
  authenticated: boolean;
  portalUrl: string | null;
}

function fileFor(sid: string): string {
  // sid is base64url (no path separators) — safe as a filename.
  return join(sessionDir(), `${sid}.json`);
}

function expired(lastUsedAt: number): boolean {
  return Date.now() - lastUsedAt > SESSION_IDLE_TTL_MS;
}

class SessionStore {
  /** Delete expired session files. */
  private gc(): void {
    let dir: string;
    try {
      dir = sessionDir();
    } catch {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const p = join(dir, name);
      try {
        const raw = readFileSync(p, "utf8");
        const data = JSON.parse(raw) as SessionFile;
        if (expired(data.lastUsedAt ?? data.createdAt)) unlinkSync(p);
      } catch {
        // Corrupt/unreadable file: best-effort cleanup if it's old enough.
        try {
          if (Date.now() - statSync(p).mtimeMs > SESSION_IDLE_TTL_MS)
            unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private write(sid: string, data: SessionFile): void {
    writeFileSync(fileFor(sid), JSON.stringify(data), { mode: 0o600 });
  }

  private read(sid: string): SessionFile | null {
    try {
      return JSON.parse(readFileSync(fileFor(sid), "utf8")) as SessionFile;
    } catch {
      return null;
    }
  }

  create(client: BizmekaClient, ssoRedirect = ""): string {
    this.gc();
    const sid = randomBytes(16).toString("base64url");
    const now = Date.now();
    this.write(sid, {
      state: client.dumpState(),
      createdAt: now,
      lastUsedAt: now,
      authenticated: false,
      portalUrl: null,
      ssoRedirect,
    });
    return sid;
  }

  get(sid: string): Session | undefined {
    const data = this.read(sid);
    if (!data) return undefined;
    if (expired(data.lastUsedAt ?? data.createdAt)) {
      this.drop(sid);
      return undefined;
    }
    return {
      client: BizmekaClient.restore(data.state),
      ssoRedirect: data.ssoRedirect,
      createdAt: data.createdAt,
      authenticated: data.authenticated,
      portalUrl: data.portalUrl,
    };
  }

  /**
   * Persist the current client state + metadata back to disk after a tool
   * mutates it (e.g. verify_otp logs in, or a webmail call refreshes cookies).
   * Refreshes lastUsedAt so the idle-expiry window slides forward on every
   * successful use — keeping an actively-used session alive — while createdAt
   * is preserved for diagnostics.
   */
  save(
    sid: string,
    client: BizmekaClient,
    patch: { authenticated?: boolean; portalUrl?: string | null } = {},
  ): void {
    const existing = this.read(sid);
    if (!existing) return;
    this.write(sid, {
      ...existing,
      state: client.dumpState(),
      lastUsedAt: Date.now(),
      authenticated: patch.authenticated ?? existing.authenticated,
      portalUrl:
        patch.portalUrl !== undefined ? patch.portalUrl : existing.portalUrl,
    });
  }

  drop(sid: string): void {
    try {
      unlinkSync(fileFor(sid));
    } catch {
      /* already gone */
    }
  }
}

export const store = new SessionStore();

// ---------------------------------------------------------------------------
// Trusted-browser store: persists the "remember this browser" cookies
// (browserCertify=Y et al.) per username, so a future login can skip SMS 2FA.
//
// Verified live: after verifyOtp(rememberBrowser=true), the cookie jar carries
// a long-lived token cookie. Re-submitting 1st-factor credentials with that
// cookie present logs in WITHOUT an SMS step (isLogin=Y set on login.do).
//
// These cookies are long-lived (server-defined expiry), so unlike sessions they
// have NO idle TTL — we keep them until login stops accepting them, at which
// point the caller falls back to the normal SMS flow and re-saves.
// ---------------------------------------------------------------------------
import type { Cookie } from "./http.ts";

interface TrustFile {
  username: string;
  cookies: Cookie[];
  savedAt: number;
}

function trustDir(): string {
  const base = join(sessionDir(), "trust");
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch {
    /* sessionDir already ensured a writable base */
  }
  return base;
}

/** Filesystem-safe filename for a username (base64url, no separators). */
function trustFileFor(username: string): string {
  const safe = Buffer.from(username, "utf8").toString("base64url");
  return join(trustDir(), `${safe}.json`);
}

class TrustStore {
  /** Persist the long-lived "remembered browser" cookies for a username. */
  save(username: string, cookies: Cookie[]): void {
    try {
      writeFileSync(
        trustFileFor(username),
        JSON.stringify({ username, cookies, savedAt: Date.now() } as TrustFile),
        { mode: 0o600 },
      );
    } catch {
      /* best-effort; trust is an optimization, not required for correctness */
    }
  }

  /** Load remembered cookies for a username, or null if none saved. */
  load(username: string): Cookie[] | null {
    try {
      const data = JSON.parse(
        readFileSync(trustFileFor(username), "utf8"),
      ) as TrustFile;
      return data.cookies ?? null;
    } catch {
      return null;
    }
  }

  /** Forget a username's remembered cookies (e.g. after they stop working). */
  drop(username: string): void {
    try {
      unlinkSync(trustFileFor(username));
    } catch {
      /* already gone */
    }
  }
}

export const trust = new TrustStore();
