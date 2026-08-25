CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_email TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  email_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pending_registrations (
  email TEXT PRIMARY KEY,
  display_email TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('platform', 'user')),
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'cloudflare', 'huggingface', 'compatible')),
  encrypted_key TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  endpoint_url TEXT NOT NULL DEFAULT '',
  key_last4 TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_type, owner_id, provider)
) STRICT;

CREATE TABLE IF NOT EXISTS model_catalog (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'cloudflare', 'huggingface', 'compatible')),
  provider_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('platform', 'byok')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  input_price_micros INTEGER NOT NULL DEFAULT 0,
  output_price_micros INTEGER NOT NULL DEFAULT 0,
  max_output_tokens INTEGER NOT NULL DEFAULT 4096,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_model_id, access_mode)
) STRICT;

CREATE TABLE IF NOT EXISTS user_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requests_per_minute INTEGER NOT NULL DEFAULT 10,
  requests_per_day INTEGER NOT NULL DEFAULT 100,
  tokens_per_month INTEGER NOT NULL DEFAULT 1000000,
  platform_cost_limit_micros INTEGER NOT NULL DEFAULT 5000000,
  max_output_tokens INTEGER NOT NULL DEFAULT 4096,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  credential_source TEXT NOT NULL CHECK (credential_source IN ('platform', 'byok')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed')),
  provider_request_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS usage_balances (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  requests_used INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  platform_cost_used_micros INTEGER NOT NULL DEFAULT 0,
  reserved_cost_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, period)
) STRICT;

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON provider_credentials(owner_type, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_models_access ON model_catalog(enabled, access_mode, provider);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_balances_period ON usage_balances(period);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

INSERT OR IGNORE INTO model_catalog VALUES ('model_openai_gpt54mini_platform', 'openai', 'gpt-5.4-mini', 'GPT-5.4 mini', 'platform', 1, 750000, 4500000, 4096, datetime('now'), datetime('now'));
INSERT OR IGNORE INTO model_catalog VALUES ('model_openai_gpt41_platform', 'openai', 'gpt-4.1', 'GPT-4.1', 'platform', 1, 2000000, 8000000, 4096, datetime('now'), datetime('now'));
INSERT OR IGNORE INTO model_catalog VALUES ('model_openai_gpt54_byok', 'openai', 'gpt-5.4', 'GPT-5.4', 'byok', 1, 2500000, 15000000, 4096, datetime('now'), datetime('now'));
