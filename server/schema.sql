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

-- ─────────────────────────────────────────────────────────────────────────
-- Song-sheet cache (POST /song). The Worker scrapes a chord sheet from an
-- external site once, converts it to the plain "chords above the lyrics"
-- text the app's parser understands, and keeps it here so the next open of
-- the same song (on any device) is instant and doesn't hit the source site
-- again. `raw` is that text; `refresh:true` on the request re-fetches.
CREATE TABLE IF NOT EXISTS sheets (
  key         TEXT PRIMARY KEY,     -- "q:<artist>|<title>" (normalised) or "url:<url>"
  source      TEXT NOT NULL,        -- which site it came from ("ultimate-guitar", "e-chords", …)
  url         TEXT,                 -- the page it was taken from
  raw         TEXT NOT NULL,        -- chord sheet text, ready for js/songsheet.js
  meta        TEXT NOT NULL DEFAULT '{}',  -- JSON { title, artist, key, capo }
  fetched_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sheets_fetched ON sheets (fetched_at);

-- Upstream fetches per client IP, for rate limiting /song. Cache hits don't
-- count; only requests that actually reach out to a source site do.
CREATE TABLE IF NOT EXISTS fetch_attempts (
  ip  TEXT NOT NULL,
  ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fetch_attempts ON fetch_attempts (ip, ts);
