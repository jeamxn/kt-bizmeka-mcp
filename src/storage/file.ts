/**
 * File-backed storage (stdio / local exe). Extracted verbatim from the original
 * session.ts logic; behavior is unchanged. Synchronous fs calls are wrapped in
 * resolved promises to satisfy the async backend interface.
 *
 * Sessions are small JSON files keyed by sid; trust records live under a
 * `trust/` subdir keyed by a base64url-encoded username. Files are 0600.
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
import { BizmekaClient } from "../client.ts";
import type { Cookie } from "../http.ts";
import {
  SESSION_IDLE_TTL_MS,
  type Session,
  type SessionBackend,
  type SessionPatch,
  type SessionRecord,
  type TrustBackend,
  type TrustRecord,
} from "./types.ts";

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

function fileFor(sid: string): string {
  // sid is base64url (no path separators) — safe as a filename.
  return join(sessionDir(), `${sid}.json`);
}

function expired(lastUsedAt: number): boolean {
  return Date.now() - lastUsedAt > SESSION_IDLE_TTL_MS;
}

export class FileSessionBackend implements SessionBackend {
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
        const data = JSON.parse(raw) as SessionRecord;
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

  private write(sid: string, data: SessionRecord): void {
    writeFileSync(fileFor(sid), JSON.stringify(data), { mode: 0o600 });
  }

  private read(sid: string): SessionRecord | null {
    try {
      return JSON.parse(readFileSync(fileFor(sid), "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  async create(client: BizmekaClient, ssoRedirect = ""): Promise<string> {
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

  async get(sid: string): Promise<Session | undefined> {
    const data = this.read(sid);
    if (!data) return undefined;
    if (expired(data.lastUsedAt ?? data.createdAt)) {
      await this.drop(sid);
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

  async save(
    sid: string,
    client: BizmekaClient,
    patch: SessionPatch = {},
  ): Promise<void> {
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

  async drop(sid: string): Promise<void> {
    try {
      unlinkSync(fileFor(sid));
    } catch {
      /* already gone */
    }
  }
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

export class FileTrustBackend implements TrustBackend {
  private readSync(username: string): TrustRecord | null {
    try {
      return JSON.parse(
        readFileSync(trustFileFor(username), "utf8"),
      ) as TrustRecord;
    } catch {
      return null;
    }
  }

  async save(
    username: string,
    cookies: Cookie[],
    password?: string,
  ): Promise<void> {
    try {
      // Preserve an existing password if this save omits one.
      const prev = this.readSync(username);
      writeFileSync(
        trustFileFor(username),
        JSON.stringify({
          username,
          password: password ?? prev?.password,
          cookies,
          savedAt: Date.now(),
        } as TrustRecord),
        { mode: 0o600 },
      );
    } catch {
      /* best-effort; trust is an optimization, not required for correctness */
    }
  }

  async read(username: string): Promise<TrustRecord | null> {
    return this.readSync(username);
  }

  async load(username: string): Promise<Cookie[] | null> {
    return this.readSync(username)?.cookies ?? null;
  }

  async loadPassword(username: string): Promise<string | null> {
    return this.readSync(username)?.password ?? null;
  }

  async listUsernames(): Promise<string[]> {
    try {
      return readdirSync(trustDir())
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          try {
            return Buffer.from(n.slice(0, -5), "base64url").toString("utf8");
          } catch {
            return "";
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async mostRecentUsername(): Promise<string | null> {
    let best: { user: string; savedAt: number } | null = null;
    for (const user of await this.listUsernames()) {
      const rec = this.readSync(user);
      if (!rec?.password) continue; // need a password for unattended re-login
      const savedAt = rec.savedAt ?? 0;
      if (!best || savedAt > best.savedAt) best = { user, savedAt };
    }
    return best?.user ?? null;
  }

  async drop(username: string): Promise<void> {
    try {
      unlinkSync(trustFileFor(username));
    } catch {
      /* already gone */
    }
  }
}
