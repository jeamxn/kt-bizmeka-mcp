-- KT Bizmeka MCP — remote (db) storage schema.
-- Idempotent: safe to run on every boot. Secrets are stored encrypted
-- (AES-256-GCM with MASTER_KEY); tokens are stored as sha256 hashes.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,                 -- null for public clients
  redirect_uris JSONB NOT NULL,
  client_name TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,              -- sha256(code)
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,             -- bizmeka user (sub)
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token TEXT PRIMARY KEY,            -- sha256(token), not raw
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  scope TEXT,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,            -- sha256(token)
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  scope TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

-- In-flight bizmeka login during /authorize (survives the SMS wait, enables
-- stateless horizontal scaling).
CREATE TABLE IF NOT EXISTS login_flows (
  flow_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  enc_session BYTEA,                 -- in-progress bizmeka session, encrypted
  username TEXT,
  stage TEXT NOT NULL,               -- 'await_otp'
  expires_at BIGINT NOT NULL
);

-- Remembered bizmeka credentials (remote equivalent of the local trust file).
CREATE TABLE IF NOT EXISTS user_trust (
  username TEXT PRIMARY KEY,
  enc_password BYTEA,                -- AES-256-GCM(MASTER_KEY)
  enc_cookies BYTEA NOT NULL,        -- AES-256-GCM(MASTER_KEY)
  saved_at BIGINT NOT NULL
);

-- In-flight MCP tool sessions (login_start -> verify_otp on the TOOL path).
CREATE TABLE IF NOT EXISTS tool_sessions (
  sid TEXT PRIMARY KEY,
  enc_state BYTEA NOT NULL,          -- AES-256-GCM(MASTER_KEY) of ClientState
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
