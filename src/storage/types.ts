/**
 * Storage abstraction for bizmeka MCP.
 *
 * Two backends implement these interfaces:
 *   - file (stdio / local exe)  — JSON files under ~/.cache/kt-bizmeka/
 *   - db   (remote HTTP server) — Postgres, with secrets encrypted at rest
 *
 * The API is intentionally async so the db backend fits without changing call
 * sites. The file backend simply wraps synchronous fs calls in resolved
 * promises. Sessions are keyed by an opaque session id (sid); trust records are
 * keyed by bizmeka username.
 */
import type { BizmekaClient, ClientState } from "../client.ts";
import type { Cookie } from "../http.ts";

/** Live view of a session: the rehydrated client + its metadata. */
export interface Session {
  client: BizmekaClient;
  ssoRedirect: string;
  createdAt: number;
  authenticated: boolean;
  portalUrl: string | null;
}

/** Patch accepted by SessionBackend.save(). */
export interface SessionPatch {
  authenticated?: boolean;
  portalUrl?: string | null;
}

/** Persisted session record (serializable). */
export interface SessionRecord {
  state: ClientState;
  createdAt: number;
  /** Refreshed on every save(); idle expiry is measured from this. */
  lastUsedAt: number;
  authenticated: boolean;
  portalUrl: string | null;
  ssoRedirect: string;
}

/** Persisted trust record: long-lived "remember this browser" data. */
export interface TrustRecord {
  username: string;
  /** Account password (encrypted at rest in the db backend). */
  password?: string;
  cookies: Cookie[];
  savedAt: number;
}

/** Session persistence: an in-flight or authenticated bizmeka login. */
export interface SessionBackend {
  create(client: BizmekaClient, ssoRedirect?: string): Promise<string>;
  get(sid: string): Promise<Session | undefined>;
  save(sid: string, client: BizmekaClient, patch?: SessionPatch): Promise<void>;
  drop(sid: string): Promise<void>;
}

/** Trust persistence: per-username remembered-browser cookies + password. */
export interface TrustBackend {
  save(username: string, cookies: Cookie[], password?: string): Promise<void>;
  read(username: string): Promise<TrustRecord | null>;
  load(username: string): Promise<Cookie[] | null>;
  loadPassword(username: string): Promise<string | null>;
  listUsernames(): Promise<string[]>;
  mostRecentUsername(): Promise<string | null>;
  drop(username: string): Promise<void>;
}

/** How long a session stays valid AFTER ITS LAST USE (sliding idle window). */
export const SESSION_IDLE_TTL_MS = 1_800_000; // 30 min of inactivity
