/**
 * Postgres-backed storage (remote HTTP server). Filled in Phase 1.3.
 * This module is only imported when STORAGE=db, so the stdio binary never
 * loads the pg driver.
 */
import { BizmekaClient } from "../client.ts";
import type { Cookie } from "../http.ts";
import type {
  Session,
  SessionBackend,
  SessionPatch,
  TrustBackend,
  TrustRecord,
} from "./types.ts";

const NOT_IMPL = "db storage backend not yet implemented";

export class DbSessionBackend implements SessionBackend {
  async create(_client: BizmekaClient, _ssoRedirect = ""): Promise<string> {
    throw new Error(NOT_IMPL);
  }
  async get(_sid: string): Promise<Session | undefined> {
    throw new Error(NOT_IMPL);
  }
  async save(
    _sid: string,
    _client: BizmekaClient,
    _patch: SessionPatch = {},
  ): Promise<void> {
    throw new Error(NOT_IMPL);
  }
  async drop(_sid: string): Promise<void> {
    throw new Error(NOT_IMPL);
  }
}

export class DbTrustBackend implements TrustBackend {
  async save(
    _username: string,
    _cookies: Cookie[],
    _password?: string,
  ): Promise<void> {
    throw new Error(NOT_IMPL);
  }
  async read(_username: string): Promise<TrustRecord | null> {
    throw new Error(NOT_IMPL);
  }
  async load(_username: string): Promise<Cookie[] | null> {
    throw new Error(NOT_IMPL);
  }
  async loadPassword(_username: string): Promise<string | null> {
    throw new Error(NOT_IMPL);
  }
  async listUsernames(): Promise<string[]> {
    throw new Error(NOT_IMPL);
  }
  async mostRecentUsername(): Promise<string | null> {
    throw new Error(NOT_IMPL);
  }
  async drop(_username: string): Promise<void> {
    throw new Error(NOT_IMPL);
  }
}
