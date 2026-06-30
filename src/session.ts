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
 * process restarts. Sessions expire so stale cookie jars don't pile up.
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

// How long a session (SMS sent, OTP pending, or freshly logged in) stays valid.
const SESSION_TTL_MS = 600_000;

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

function expired(createdAt: number): boolean {
  return Date.now() - createdAt > SESSION_TTL_MS;
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
        if (expired(data.createdAt)) unlinkSync(p);
      } catch {
        // Corrupt/unreadable file: best-effort cleanup if it's old enough.
        try {
          if (Date.now() - statSync(p).mtimeMs > SESSION_TTL_MS) unlinkSync(p);
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
    this.write(sid, {
      state: client.dumpState(),
      createdAt: Date.now(),
      authenticated: false,
      portalUrl: null,
      ssoRedirect,
    });
    return sid;
  }

  get(sid: string): Session | undefined {
    const data = this.read(sid);
    if (!data) return undefined;
    if (expired(data.createdAt)) {
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
   * Preserves the original createdAt so the TTL window doesn't slide forever.
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
