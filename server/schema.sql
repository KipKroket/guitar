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

-- ─────────────────────────────────────────────────────────────────────────
-- Jam sessions (samen jammen): a host's phone broadcasts where it is in a
-- song -- which autoscroll mode it's using (timestamps / fixed-tempo
-- autoscroll / play along) and the current position in that mode -- so
-- friends' phones can follow the same lyrics/chords scroll without needing
-- their own copy of the sheet saved, and without streaming any audio (the
-- host's own speaker is the only audio in the room -- this only
-- synchronises the on-screen position/highlight). Polled by followers
-- rather than pushed over a WebSocket -- no Durable Object involved, so
-- this stays on the same free Workers+D1 plan the rest of this backend
-- already runs on. That means a second or two of lag, which is fine for
-- following lyrics but not meant for anything tighter.
CREATE TABLE IF NOT EXISTS jam_sessions (
  code            TEXT PRIMARY KEY,   -- 4-char join code, unambiguous alphabet
  host_token      TEXT NOT NULL,      -- secret only the host holds; required for /jam/update and /jam/end
  song_title      TEXT NOT NULL DEFAULT '',
  song_artist     TEXT NOT NULL DEFAULT '',
  song_art        TEXT,               -- artwork url/data-uri, optional
  sheet_raw       TEXT NOT NULL DEFAULT '',
  sheet_transpose INTEGER NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT 'none', -- 'none' | 'timestamps' | 'autoscroll' | 'playalong'
  -- 'timestamps' and 'autoscroll' both just move the host's own scroll
  -- position -- rather than replaying the host's sync-point/tempo math
  -- (which needs the exact same line-wrap layout to land right, and a
  -- follower's screen width/font size can easily differ), the host simply
  -- samples its own scrollTop / scrollHeight ratio and broadcasts that.
  -- Device-independent by construction: "60% down the sheet" means the
  -- same thing on every screen.
  pos_fraction    REAL,               -- timestamps/autoscroll modes: 0..1 scroll position
  pos_index       INTEGER,            -- playalong mode: current chord-step index (see js/songsheet.js buildChordSteps)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL    -- bumped on every host call; long-stale = treated as ended
);

-- One row per connected follower, so the host can show a headcount without
-- knowing who's in it. Upserted on every follower poll, pruned by age.
CREATE TABLE IF NOT EXISTS jam_presence (
  code          TEXT NOT NULL,
  follower_id   TEXT NOT NULL,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (code, follower_id)
);
CREATE INDEX IF NOT EXISTS idx_jam_presence_code ON jam_presence (code, last_seen);

-- /jam/create attempts per client IP, for basic abuse resistance -- same
-- shape/purpose as fetch_attempts above.
CREATE TABLE IF NOT EXISTS jam_create_attempts (
  ip  TEXT NOT NULL,
  ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jam_create_attempts ON jam_create_attempts (ip, ts);
