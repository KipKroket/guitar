-- Guitar cloud sync — D1 (SQLite) schema.
-- Apply with:  wrangler d1 execute guitar-sync --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  username    TEXT PRIMARY KEY,      -- 3–20 chars, [a-z0-9_-], already lowercased
  salt        TEXT NOT NULL,         -- hex
  hash        TEXT NOT NULL,         -- hex, PBKDF2-SHA256(passcode, salt, iterations)
  iterations  INTEGER NOT NULL,
  libraries   TEXT NOT NULL DEFAULT '{}',  -- JSON: { guitar:{songs,tombstones}, piano:{...} }
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One row per signed-in device. The client stores only the token.
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,      -- hex, 32 random bytes
  username    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (username);

-- Failed auth attempts, for rate limiting. Rows are pruned as they age out.
CREATE TABLE IF NOT EXISTS auth_attempts (
  username    TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON auth_attempts (username, ts);
