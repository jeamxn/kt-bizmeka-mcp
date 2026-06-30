/**
 * Postgres connection + schema bootstrap for the remote (db) storage backend.
 *
 * Uses the `postgres` npm driver. The connection is created lazily on first
 * use from DATABASE_URL, and the schema (idempotent CREATE TABLE IF NOT EXISTS)
 * is applied once per process. This module is only imported when STORAGE=db,
 * so the stdio binary never loads the driver.
 *
 * The schema is inlined as a string (not read from disk) so it survives
 * `bun build --compile` into a single binary.
 */
import postgres from "postgres";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  redirect_uris JSONB NOT NULL,
  client_name TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  scope TEXT,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  scope TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_flows (
  flow_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  enc_session BYTEA,
  username TEXT,
  stage TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_trust (
  username TEXT PRIMARY KEY,
  enc_password BYTEA,
  enc_cookies BYTEA NOT NULL,
  saved_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_sessions (
  sid TEXT PRIMARY KEY,
  enc_state BYTEA NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL,
  authenticated BOOLEAN NOT NULL,
  portal_url TEXT,
  sso_redirect TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_login_flows_expires ON login_flows (expires_at);
CREATE INDEX IF NOT EXISTS idx_tool_sessions_last_used ON tool_sessions (last_used_at);
`;

export type Sql = ReturnType<typeof postgres>;

let _sql: Sql | null = null;
let _ready: Promise<Sql> | null = null;

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required when STORAGE=db");
  }
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? "10"),
    idle_timeout: 30,
    connect_timeout: 10,
    // bytea comes back as a Buffer/Uint8Array by default — good for enc_* cols.
  });
}

/** Get the connection, applying the schema exactly once per process. */
export function db(): Promise<Sql> {
  if (_ready) return _ready;
  _ready = (async () => {
    _sql = connect();
    await _sql.unsafe(SCHEMA);
    return _sql;
  })();
  return _ready;
}

/** Close the pool (tests / graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _ready = null;
  }
}
