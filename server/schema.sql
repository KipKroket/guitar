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
-- Song-sheet cache (POST /song). The Worker scrapes chord sheets from
-- external sites once, converts them to the plain "chords above the lyrics"
-- text the app's parser understands, and keeps them here so the next open of
-- the same song (on any device) is instant and doesn't hit the source sites
-- again. `refresh:true` on the request re-fetches.
--
-- Two row shapes share this table, told apart by `key`'s prefix:
--   "url:<url>"            one page, fetched by exact link -- `raw` is that
--                           page's sheet text, `source`/`url`/`meta` describe it.
--   "list:<artist>|<title>" a search by artist/title -- `raw` is a JSON array
--                           of candidates (`{source,url,meta,raw}` each, one
--                           per matched page) for the client to preview and
--                           pick from; `source` is the literal "list" and
--                           `url`/`meta` are unused.
CREATE TABLE IF NOT EXISTS sheets (
  key         TEXT PRIMARY KEY,
  source      TEXT NOT NULL,        -- which site it came from, or "list"
  url         TEXT,                 -- the page it was taken from (url: rows only)
  raw         TEXT NOT NULL,        -- sheet text (url: rows) or JSON candidate array (list: rows)
  meta        TEXT NOT NULL DEFAULT '{}',  -- JSON { title, artist, key, capo } (url: rows only)
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
