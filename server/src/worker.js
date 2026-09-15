// Guitar cloud sync — a single Cloudflare Worker backed by one D1 database.
//
// Endpoints (all POST, JSON in / JSON out):
//   /register  { username, passcode }        -> { token }        409 if taken
//   /login     { username, passcode }        -> { token }        401 / 429
//   /sync      { token, libraries }          -> { libraries }     401
//   /logout    { token }                     -> { ok: true }
//   /song      { artist, title }             -> { candidates: [...] }   429 / 502
//              { url }                       -> { raw, meta, source, url }   429 / 502
//   /jam/create { song, sheet }               -> { code, hostToken }    400 / 429
//   /jam/update { code, hostToken, song?, sheet?, mode?, pos? } -> { ok, participantCount }  403 / 404
//   /jam/poll   { code, followerId }          -> { ok, song, sheet, mode, pos, participantCount }  404
//   /jam/end    { code, hostToken }           -> { ok: true }           403 / 404
//
// "libraries" is { guitar: {songs,tombstones}, piano: {songs,tombstones} }.
// The server keeps its own copy and returns the MERGE of what it had and
// what the client sent, so no device can clobber another. The merge below
// is a straight port of mergeSnapshots() in app/js/library.js — keep them
// in step.
//
// /song by { artist, title } searches Ultimate Guitar and Cifra Club, fetches
// the top couple of matches from EACH (so a wrong top pick doesn't silently
// win), and returns them all as `candidates` for the client to preview and
// pick from -- it never guesses on the user's behalf. /song by { url } fetches
// that one exact page and returns it directly (unambiguous, no picker
// needed): the recovery path when search finds nothing or the wrong version.
// Both cache in D1 (table `sheets`); `refresh: true` re-fetches past the
// cache. It's an open endpoint, lightly rate-limited per IP; if it ever gets
// abused, gate it behind userForToken() the way /sync is.
//
// /jam/* -- "samen jammen": a host broadcasts where it is in a song so
// friends can follow along on their own phones. No WebSocket/Durable
// Object -- followers poll, which is a bit laggier (a second or two) but
// keeps this on the same free Workers+D1 plan as everything else here. See
// the jam_sessions comment in schema.sql for the full design. `hostToken`
// (returned once, from /jam/create) authorises /jam/update and /jam/end;
// anyone with the 4-char `code` can /jam/poll.

const INSTRUMENTS = ["guitar", "piano"];
const TOMB_TTL_MS = 150 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const RATE_LIMIT_MAX = 10; // failed attempts...
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // ...per username per hour

const SONG_RATE_MAX = 40; // upstream chord-sheet fetches...
const SONG_RATE_WINDOW_MS = 60 * 60 * 1000; // ...per client IP per hour (cache hits don't count)
const SCRAPE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const JAM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L -- easy to read aloud
const JAM_CREATE_MAX = 20; // /jam/create attempts...
const JAM_CREATE_WINDOW_MS = 60 * 60 * 1000; // ...per client IP per hour
const JAM_STALE_MS = 45 * 1000; // no host update in this long -> followers treat it as ended
const JAM_PRESENCE_TTL_MS = 8 * 1000; // a follower who hasn't polled in this long doesn't count

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400);
    }

    try {
      if (path === "/register") return await register(env, body);
      if (path === "/login") return await login(env, body);
      if (path === "/sync") return await sync(env, body);
      if (path === "/logout") return await logout(env, body);
      if (path === "/song") return await song(env, body, request);
      if (path === "/jam/create") return await jamCreate(env, body, request);
      if (path === "/jam/update") return await jamUpdate(env, body);
      if (path === "/jam/poll") return await jamPoll(env, body);
      if (path === "/jam/end") return await jamEnd(env, body);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Server error", detail: String(err && err.message || err) }, 500);
    }
  },
};

/* ---------- Endpoints ---------- */

async function register(env, { username, passcode }) {
  const u = normUser(username);
  if (!u) return json({ error: "Bad username" }, 400);
  if (!/^\d{6}$/.test(String(passcode || ""))) return json({ error: "Passcode must be 6 digits" }, 400);

  const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(u).first();
  if (existing) return json({ error: "Username taken" }, 409);

  const salt = randomHex(16);
  const hash = await pbkdf2(passcode, salt, PBKDF2_ITERATIONS);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (username, salt, hash, iterations, libraries, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(u, salt, hash, PBKDF2_ITERATIONS, "{}", now, now).run();

  const token = await newSession(env, u);
  return json({ token });
}

async function login(env, { username, passcode }) {
  const u = normUser(username);
  if (!u) return json({ error: "Bad username" }, 400);

  if (await rateLimited(env, u)) return json({ error: "Too many attempts" }, 429);

  const row = await env.DB.prepare(
    "SELECT salt, hash, iterations FROM users WHERE username = ?"
  ).bind(u).first();

  let ok = false;
  if (row) {
    const attempt = await pbkdf2(passcode, row.salt, row.iterations);
    ok = timingSafeEqual(attempt, row.hash);
  }
  if (!ok) {
    await env.DB.prepare("INSERT INTO auth_attempts (username, ts) VALUES (?, ?)").bind(u, Date.now()).run();
    return json({ error: "Wrong username or passcode" }, 401);
  }

  const token = await newSession(env, u);
  return json({ token });
}

async function sync(env, { token, libraries }) {
  const u = await userForToken(env, token);
  if (!u) return json({ error: "Not signed in" }, 401);

  const row = await env.DB.prepare("SELECT libraries FROM users WHERE username = ?").bind(u).first();
  let server = {};
  try {
    server = JSON.parse((row && row.libraries) || "{}") || {};
  } catch (e) {
    server = {};
  }
  const incoming = libraries && typeof libraries === "object" ? libraries : {};

  const merged = {};
  for (const inst of INSTRUMENTS) {
    merged[inst] = mergeSnapshots(cleanSnap(server[inst]), cleanSnap(incoming[inst]));
  }

  await env.DB.prepare("UPDATE users SET libraries = ?, updated_at = ? WHERE username = ?")
    .bind(JSON.stringify(merged), Date.now(), u)
    .run();

  return json({ libraries: merged });
}

async function logout(env, { token }) {
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(String(token)).run();
  return json({ ok: true });
}

/* ---------- /song: scrape + cache a chord sheet ---------- */

// Per source, how many of its top-scored search hits to actually fetch and
// offer as candidates -- and a hard cap across all sources combined, so one
// click never fans out into an unbounded pile of upstream requests.
const CANDIDATES_PER_SOURCE = 2;
const MAX_CANDIDATES = 5;

async function song(env, body, request) {
  const artist = String((body && body.artist) || "").trim();
  const title = String((body && body.title) || "").trim();
  const url = String((body && body.url) || "").trim();
  const refresh = Boolean(body && body.refresh);
  if (!title && !url) return json({ error: "Need a song title or a url." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return url
    ? await fetchSingleUrl(env, ip, url, refresh)
    : await fetchCandidates(env, ip, artist, title, refresh);
}

async function fetchSingleUrl(env, ip, url, refresh) {
  const key = "url:" + url.toLowerCase();
  if (!refresh) {
    const hit = await env.DB
      .prepare("SELECT source, url, raw, meta FROM sheets WHERE key = ?")
      .bind(key)
      .first();
    if (hit) {
      return json({ raw: hit.raw, meta: safeParse(hit.meta), source: hit.source, url: hit.url, cached: true });
    }
  }

  if (await songRateLimited(env, ip)) {
    return json({ error: "Too many fetches this hour — wait a bit, or paste the sheet in by hand." }, 429);
  }

  // e-chords reachable here (a pasted e-chords link) even though it's
  // dropped from the search chain below -- see fetchCandidates() for why.
  const chain = sourcesForUrl(url);

  const tried = [];
  let result = null;
  for (const s of chain) {
    try {
      const r = await s.run();
      if (r && r.raw && r.raw.trim()) {
        result = { source: s.name, ...r };
        break;
      }
      tried.push(s.name + ": nothing usable");
    } catch (e) {
      tried.push(s.name + ": " + String((e && e.message) || e));
    }
  }

  await env.DB.prepare("INSERT INTO fetch_attempts (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();

  if (!result) return json({ error: "Couldn't fetch a chord sheet for this song.", tried }, 502);

  await env.DB
    .prepare(
      "INSERT INTO sheets (key, source, url, raw, meta, fetched_at) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET source=excluded.source, url=excluded.url, " +
        "raw=excluded.raw, meta=excluded.meta, fetched_at=excluded.fetched_at"
    )
    .bind(key, result.source, result.url || null, result.raw, JSON.stringify(result.meta || {}), Date.now())
    .run();

  return json({ raw: result.raw, meta: result.meta || {}, source: result.source, url: result.url || null });
}

// Artist/title search: rather than silently picking "the best" hit (which is
// exactly what produces the occasional wrong-song result the picker exists
// to fix), fetch the top couple of hits from every source and hand back all
// of them -- already fully converted to sheet text -- so the client can show
// a preview list and the user picks. Cached as one list per query.
async function fetchCandidates(env, ip, artist, title, refresh) {
  const key = "list:" + normKey(artist) + "|" + normKey(cleanTitle(title));

  if (!refresh) {
    const hit = await env.DB.prepare("SELECT raw FROM sheets WHERE key = ?").bind(key).first();
    const cached = hit && safeParse(hit.raw);
    if (Array.isArray(cached) && cached.length) return json({ candidates: cached, cached: true });
  }

  if (await songRateLimited(env, ip)) {
    return json({ error: "Too many fetches this hour — wait a bit, or paste the sheet in by hand." }, 429);
  }

  // e-chords dropped here: both its search API and its song pages sit behind
  // a Cloudflare JS challenge that a plain fetch() can never pass (confirmed
  // -- it 403s identically with or without a Worker), so it never once
  // succeeded and only added latency. Left reachable via sourcesForUrl() for
  // a pasted link, in case that ever changes.
  //
  // Cifra Club has no such challenge (confirmed working from a Worker, no UA
  // spoofing even required) and is a large, independent catalog, so it's a
  // genuine second set of candidates rather than a duplicate of Ultimate
  // Guitar. Both sources are searched and fetched in parallel -- they're
  // independent, and doing so keeps one click's wall-clock time down even
  // though it now fetches several pages instead of one.
  const sources = [
    {
      name: "ultimate-guitar",
      search: () => ugSearch(artist, title),
      fetch: (h) => ugFromUrl(h.tab_url, { artist, title }),
      label: (h) => h.tab_url,
    },
    {
      name: "cifraclub",
      search: () => cifraclubSearch(artist, title),
      fetch: (h) =>
        cifraclubFromUrl("https://www.cifraclub.com/" + h.dns + "/" + h.url + "/", {
          artist: h.art || artist,
          title: h.txt || title,
        }),
      label: (h) => h.dns + "/" + h.url,
    },
  ];

  const perSource = await Promise.all(
    sources.map(async (s) => {
      const tried = [];
      const found = [];
      let hits;
      try {
        hits = await s.search();
      } catch (e) {
        tried.push(s.name + ": " + String((e && e.message) || e));
        return { found, tried };
      }
      const picked = hits.slice(0, CANDIDATES_PER_SOURCE);
      const results = await Promise.allSettled(picked.map((h) => s.fetch(h)));
      results.forEach((res, i) => {
        const h = picked[i];
        if (res.status === "fulfilled" && res.value && res.value.raw && res.value.raw.trim()) {
          found.push({ source: s.name, url: res.value.url, meta: res.value.meta || {}, raw: res.value.raw });
        } else {
          const reason = res.status === "rejected" ? String((res.reason && res.reason.message) || res.reason) : "nothing usable";
          tried.push(s.name + " (" + s.label(h) + "): " + reason);
        }
      });
      return { found, tried };
    })
  );

  const tried = [];
  let candidates = [];
  perSource.forEach((r) => {
    candidates = candidates.concat(r.found);
    tried.push(...r.tried);
  });
  candidates = candidates.slice(0, MAX_CANDIDATES);

  await env.DB.prepare("INSERT INTO fetch_attempts (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();

  if (!candidates.length) return json({ error: "Couldn't fetch a chord sheet for this song.", tried }, 502);

  await env.DB
    .prepare(
      "INSERT INTO sheets (key, source, url, raw, meta, fetched_at) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET source=excluded.source, raw=excluded.raw, fetched_at=excluded.fetched_at"
    )
    .bind(key, "list", null, JSON.stringify(candidates), "{}", Date.now())
    .run();

  return json({ candidates });
}

async function songRateLimited(env, ip) {
  const cutoff = Date.now() - SONG_RATE_WINDOW_MS;
  await env.DB.prepare("DELETE FROM fetch_attempts WHERE ts < ?").bind(cutoff).run();
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM fetch_attempts WHERE ip = ? AND ts > ?")
    .bind(ip, cutoff)
    .first();
  return row && row.n >= SONG_RATE_MAX;
}

/* ---------- /jam/*: "samen jammen" ----------
   One row in jam_sessions per active jam, keyed by a 4-char code. The host
   is the only writer (via /jam/update, gated by hostToken); followers only
   ever read (/jam/poll) and touch their own presence row. mode/pos together
   describe "where the host currently is" in whichever of the app's three
   existing autoscroll mechanisms it's using -- js/jam.js on the client maps
   that straight onto the same rendering songsheet.js already has for the
   host's own screen, so a follower's view is pixel-for-pixel the same
   highlight/scroll logic, just fed by polled state instead of local
   audio/mic/timestamps. ---- */

// A jam can be created before any song is open -- the host picks "Start a
// jam" from Settings, gets a code to share immediately, and the first song
// (song/sheet fields) arrives later via /jam/update once they open one
// with lyrics. Followers who join before that see a "waiting" state.
async function jamCreate(env, body, request) {
  const song = (body && body.song) || {};
  const sheet = (body && body.sheet) || {};
  const raw = String(sheet.raw || "");

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await jamCreateRateLimited(env, ip)) {
    return json({ error: "Too many jams started this hour -- wait a bit." }, 429);
  }
  await env.DB.prepare("INSERT INTO jam_create_attempts (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();

  const hostToken = randomHex(16);
  const now = Date.now();
  let code = null;
  for (let attempt = 0; attempt < 6 && !code; attempt++) {
    const candidate = randomJamCode();
    const existing = await env.DB.prepare("SELECT code FROM jam_sessions WHERE code = ?").bind(candidate).first();
    if (!existing) code = candidate;
  }
  if (!code) return json({ error: "Couldn't allocate a jam code -- try again." }, 500);

  await env.DB
    .prepare(
      "INSERT INTO jam_sessions (code, host_token, song_title, song_artist, song_art, sheet_raw, sheet_transpose, mode, created_at, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      code,
      hostToken,
      String(song.title || "").slice(0, 200),
      String(song.artist || "").slice(0, 200),
      song.art ? String(song.art).slice(0, 4000) : null,
      raw.slice(0, 100000),
      sheet.transpose | 0,
      "none",
      now,
      now
    )
    .run();

  return json({ code, hostToken });
}

// Partial update -- only the fields the client includes get written, so a
// once-a-second position tick doesn't have to re-send the whole sheet text.
async function jamUpdate(env, body) {
  const code = normJamCode(body && body.code);
  const hostToken = String((body && body.hostToken) || "");
  if (!code) return json({ error: "Bad code" }, 400);

  const row = await env.DB.prepare("SELECT host_token FROM jam_sessions WHERE code = ?").bind(code).first();
  if (!row) return json({ error: "Jam not found" }, 404);
  if (!timingSafeEqual(hostToken, row.host_token)) return json({ error: "Not the host" }, 403);

  const sets = ["updated_at = ?"];
  const vals = [Date.now()];

  const song = body.song;
  if (song && typeof song === "object") {
    sets.push("song_title = ?", "song_artist = ?", "song_art = ?");
    vals.push(
      String(song.title || "").slice(0, 200),
      String(song.artist || "").slice(0, 200),
      song.art ? String(song.art).slice(0, 4000) : null
    );
  }
  const sheet = body.sheet;
  if (sheet && typeof sheet === "object") {
    sets.push("sheet_raw = ?", "sheet_transpose = ?");
    vals.push(String(sheet.raw || "").slice(0, 100000), sheet.transpose | 0);
  }
  if (typeof body.mode === "string") {
    sets.push("mode = ?");
    vals.push(["none", "timestamps", "autoscroll", "playalong"].includes(body.mode) ? body.mode : "none");
  }
  const pos = body.pos;
  if (pos && typeof pos === "object") {
    sets.push("pos_fraction = ?", "pos_index = ?");
    vals.push(
      Number.isFinite(pos.fraction) ? pos.fraction : null,
      Number.isFinite(pos.index) ? pos.index : null
    );
  }
  vals.push(code);
  await env.DB.prepare(`UPDATE jam_sessions SET ${sets.join(", ")} WHERE code = ?`).bind(...vals).run();

  return json({ ok: true, participantCount: await jamParticipantCount(env, code) });
}

async function jamPoll(env, body) {
  const code = normJamCode(body && body.code);
  if (!code) return json({ error: "Bad code" }, 400);

  const row = await env.DB.prepare("SELECT * FROM jam_sessions WHERE code = ?").bind(code).first();
  if (!row || Date.now() - row.updated_at > JAM_STALE_MS) {
    return json({ error: "Jam not found or has ended" }, 404);
  }

  const followerId = String((body && body.followerId) || "").slice(0, 64);
  if (followerId) {
    await env.DB
      .prepare(
        "INSERT INTO jam_presence (code, follower_id, last_seen) VALUES (?,?,?) " +
          "ON CONFLICT(code, follower_id) DO UPDATE SET last_seen = excluded.last_seen"
      )
      .bind(code, followerId, Date.now())
      .run();
  }

  return json({
    ok: true,
    song: { title: row.song_title, artist: row.song_artist, art: row.song_art },
    sheet: { raw: row.sheet_raw, transpose: row.sheet_transpose },
    mode: row.mode,
    pos: { fraction: row.pos_fraction, index: row.pos_index },
    participantCount: await jamParticipantCount(env, code),
    updatedAt: row.updated_at,
  });
}

async function jamEnd(env, body) {
  const code = normJamCode(body && body.code);
  const hostToken = String((body && body.hostToken) || "");
  if (!code) return json({ error: "Bad code" }, 400);

  const row = await env.DB.prepare("SELECT host_token FROM jam_sessions WHERE code = ?").bind(code).first();
  if (!row) return json({ ok: true }); // already gone -- ending twice is fine
  if (!timingSafeEqual(hostToken, row.host_token)) return json({ error: "Not the host" }, 403);

  await env.DB.prepare("DELETE FROM jam_sessions WHERE code = ?").bind(code).run();
  await env.DB.prepare("DELETE FROM jam_presence WHERE code = ?").bind(code).run();
  return json({ ok: true });
}

async function jamParticipantCount(env, code) {
  const cutoff = Date.now() - JAM_PRESENCE_TTL_MS;
  await env.DB.prepare("DELETE FROM jam_presence WHERE code = ? AND last_seen < ?").bind(code, cutoff).run();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM jam_presence WHERE code = ?").bind(code).first();
  return (row && row.n) || 0;
}

async function jamCreateRateLimited(env, ip) {
  const cutoff = Date.now() - JAM_CREATE_WINDOW_MS;
  await env.DB.prepare("DELETE FROM jam_create_attempts WHERE ts < ?").bind(cutoff).run();
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM jam_create_attempts WHERE ip = ? AND ts > ?")
    .bind(ip, cutoff)
    .first();
  return row && row.n >= JAM_CREATE_MAX;
}

function randomJamCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < 4; i++) s += JAM_CODE_ALPHABET[bytes[i] % JAM_CODE_ALPHABET.length];
  return s;
}

function normJamCode(code) {
  const c = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 4 ? c : null;
}

/* ---- source: Ultimate Guitar ---- */

// UG ships the whole page state as HTML-escaped JSON in one attribute.
function ugStore(html) {
  const m = html.match(/<div class="js-store" data-content="([^"]*)"/);
  if (!m) throw new Error("no js-store (blocked or changed)");
  return JSON.parse(htmlDecode(m[1]));
}
function ugPageData(store) {
  return (
    (store && store.store && store.store.page && store.store.page.data) ||
    (store && store.page && store.page.data) ||
    null
  );
}

// Returns UG's chord-tab search hits, best match first -- fetching the
// actual page content is a separate step (ugFromUrl) so the caller can pull
// as many or as few of these as it wants.
async function ugSearch(artist, title) {
  const cleanedTitle = cleanTitle(title);
  const q = [artist, cleanedTitle].filter(Boolean).join(" ");
  const searchUrl =
    "https://www.ultimate-guitar.com/search.php?search_type=title&type%5B%5D=300&value=" +
    encodeURIComponent(q);
  const data = ugPageData(ugStore(await getHtml(searchUrl)));
  const results = (data && data.results) || [];
  const hits = results.filter(
    (r) => r && r.tab_url && (r.type === "Chords" || r.type_name === "Chords")
  );
  if (!hits.length) throw new Error("no chord results");

  // Popularity alone (the old sort) picks the most-voted result even when
  // it's the wrong song entirely -- a viral cover or a same-named different
  // track can easily outvote the actual requested one. Score how well each
  // hit's own title/artist matches what was asked for, and only fall back
  // to popularity as a tiebreaker among comparably-matched hits.
  const wantTitle = normKey(cleanedTitle);
  const wantArtist = normKey(artist);
  hits.forEach((r) => {
    r._titleScore = tokenOverlap(wantTitle, normKey(cleanTitle(r.song_name || "")));
    r._artistScore = wantArtist ? tokenOverlap(wantArtist, normKey(r.artist_name || "")) : 1;
    r._popularity = Math.log((r.votes || 0) + 1) * Math.max(r.rating || 0, 0.1);
  });
  hits.sort((a, b) => {
    const matchDiff = (b._titleScore * 2 + b._artistScore) - (a._titleScore * 2 + a._artistScore);
    if (Math.abs(matchDiff) > 0.15) return matchDiff;
    return b._popularity - a._popularity;
  });
  return hits;
}

// Word-overlap similarity (Dice coefficient) between two normKey()'d
// strings -- cheap and robust enough to tell "the requested song" apart
// from an unrelated but highly-voted result, without a string-distance
// library. 0 when either side is empty (an unknown artist shouldn't
// silently score as a perfect match).
function tokenOverlap(a, b) {
  const ta = new Set(String(a || "").split(" ").filter(Boolean));
  const tb = new Set(String(b || "").split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  ta.forEach((t) => { if (tb.has(t)) shared++; });
  return (2 * shared) / (ta.size + tb.size);
}

async function ugFromUrl(pageUrl, fallback) {
  fallback = fallback || {};
  const data = ugPageData(ugStore(await getHtml(pageUrl)));
  const content =
    data && data.tab_view && data.tab_view.wiki_tab && data.tab_view.wiki_tab.content;
  if (!content) throw new Error("no tab content");
  const tab = (data && data.tab) || {};
  const meta = {
    title: tab.song_name || fallback.title || "",
    artist: tab.artist_name || fallback.artist || "",
    key: tab.tonality_name || "",
    capo:
      (data.tab_view && data.tab_view.meta && data.tab_view.meta.capo) || tab.capo || "",
  };
  return { raw: ugContentToText(content, meta), meta, url: pageUrl };
}

// UG content: aligned "[tab]" blocks with each chord wrapped as "[ch]C[/ch]".
// Strip the wrappers and you have the plain chords-above-lyrics text that
// app/js/songsheet.js already parses; prepend the key/capo as directives.
function ugContentToText(content, meta) {
  const bodyText = htmlDecode(
    String(content)
      .replace(/\r\n?/g, "\n")
      .replace(/\[\/?tab\]/g, "")
      .replace(/\[\/?ch\]/g, "")
  )
    // Drop the "chord name + fret map" legend lines UG often opens with
    // ("G     3-x-0-0-0-3") -- the app has tappable diagrams for every chord.
    .split("\n")
    .filter((ln) => !/^\s*[A-G][#b]?[a-zA-Z0-9]{0,6}(?:\/[A-G][#b]?)?\s+[0-9xX](?:[-\s][0-9xX]){3,5}\s*$/.test(ln))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const head = [];
  if (meta.title) head.push("{title: " + meta.title + "}");
  if (meta.artist) head.push("{artist: " + meta.artist + "}");
  if (meta.key) head.push("{key: " + meta.key + "}");
  if (meta.capo && String(meta.capo) !== "0") head.push("{capo: " + meta.capo + "}");
  return (head.length ? head.join("\n") + "\n\n" : "") + bodyText + "\n";
}

/* ---- source: e-chords ----
   Its /search-all page renders results client-side, but its JSON search API
   is reachable, and it gives the artist/title slugs the song-page URL is
   built from. The song page itself is server-rendered with the sheet in a
   <pre>. (Both calls can still hit Cloudflare's interstitial from a Worker;
   on any failure we fall through and the paste box stays.) */

async function echordsSearchAndFetch(artist, title) {
  const q = [artist, cleanTitle(title)].filter(Boolean).join(" ");
  const api =
    "https://www.e-chords.com/api/search?artists_take=0&albums_take=0&lyrics_take=0&videos_take=0&composers_take=0&songs_take=15&q=" +
    encodeURIComponent(q);
  const res = await fetch(api, {
    headers: {
      "User-Agent": SCRAPE_UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.e-chords.com/",
    },
    cf: { cacheTtl: 900 },
  });
  if (!res.ok) throw new Error("search HTTP " + res.status);
  const data = await res.json();
  const hits = (data && data.songs && data.songs.hits) || [];
  const usable = hits.filter(
    (h) =>
      h && h.COD_ARTISTA && h.COD_TITULO &&
      Array.isArray(h.INSTRUMENTOS) && h.INSTRUMENTOS.some((i) => i && i.SLUG === "chords")
  );
  if (!usable.length) throw new Error("no chord results");
  const want = normKey(artist);
  usable.sort((a, b) => {
    const am = want && normKey(a.ARTISTA || "") === want ? 1 : 0;
    const bm = want && normKey(b.ARTISTA || "") === want ? 1 : 0;
    if (am !== bm) return bm - am;
    return (b.QT_HITS || 0) - (a.QT_HITS || 0);
  });
  const pick = usable[0];
  return echordsFromUrl(
    "https://www.e-chords.com/chords/" + pick.COD_ARTISTA + "/" + pick.COD_TITULO,
    { artist: pick.ARTISTA || artist, title: pick.TITULO || title }
  );
}

async function echordsFromUrl(pageUrl, fallback) {
  fallback = fallback || {};
  const html = await getHtml(pageUrl);
  const pre =
    html.match(/<pre[^>]*id=["']?core["']?[^>]*>([\s\S]*?)<\/pre>/i) ||
    html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!pre) {
    if (/just a moment|challenge-platform|cf-browser-verification/i.test(html))
      throw new Error("blocked (challenge)");
    throw new Error("no <pre> block");
  }
  const bodyText = htmlDecode(stripTags(pre[1]))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (bodyText.length < 40) throw new Error("sheet too short");
  const meta = { title: fallback.title || "", artist: fallback.artist || "" };
  const head =
    meta.title || meta.artist
      ? "{title: " + meta.title + "}\n{artist: " + meta.artist + "}\n\n"
      : "";
  return { raw: head + bodyText + "\n", meta, url: pageUrl };
}

/* ---- source: Cifra Club ----
   Cifra Club renders the sheet server-side with no Cloudflare challenge
   (confirmed working from a Worker, no UA spoofing needed) as a <pre> of
   <div> lines where each chord is a plain <b data-chord-name="..."> already
   sitting in the right column above/inline with its lyric -- so stripping
   tags is all it takes to get the same "chords above lyrics" text
   ugContentToText() produces for UG. Search goes through the public,
   unauthenticated, CORS-open Solr endpoint the site's own search box calls
   (found by watching its network traffic; not documented, so it could
   change under us, same risk as scraping the HTML itself). */

// Returns Cifra Club's search hits, best match first -- see ugSearch() above
// for why fetching is a separate step.
async function cifraclubSearch(artist, title) {
  const cleanedTitle = cleanTitle(title);
  const q = [artist, cleanedTitle].filter(Boolean).join(" ");
  const res = await fetch("https://solr.sscdn.co/cc/c7/?q=" + encodeURIComponent(q) + "&limit=15", {
    cf: { cacheTtl: 900 },
  });
  if (!res.ok) throw new Error("search HTTP " + res.status);
  const data = await res.json();
  const docs = (data && data.response && data.response.docs) || [];
  // tipo "2" is a song page; other types are albums, artists or user playlists.
  const hits = docs.filter((d) => d && d.tipo === "2" && d.dns && d.url);
  if (!hits.length) throw new Error("no chord results");

  const wantTitle = normKey(cleanedTitle);
  const wantArtist = normKey(artist);
  hits.forEach((d) => {
    d._titleScore = tokenOverlap(wantTitle, normKey(cleanTitle(d.txt || "")));
    d._artistScore = wantArtist ? tokenOverlap(wantArtist, normKey(d.art || "")) : 1;
  });
  hits.sort((a, b) => (b._titleScore * 2 + b._artistScore) - (a._titleScore * 2 + a._artistScore));
  return hits;
}

async function cifraclubFromUrl(pageUrl, fallback) {
  fallback = fallback || {};
  const html = await getHtml(pageUrl);
  const pre = html.match(/<pre[^>]*data-chord-content[^>]*>([\s\S]*?)<\/pre>/i);
  if (!pre) {
    if (/just a moment|challenge-platform|cf-browser-verification/i.test(html))
      throw new Error("blocked (challenge)");
    throw new Error("no chord sheet on page");
  }
  const bodyText = cifraclubContentToText(pre[1]);
  if (bodyText.length < 40) throw new Error("sheet too short");

  // No fallback names given (a pasted URL) -- the page <title> is
  // "Song - Artist - Cifra Club".
  const titleTag = html.match(/<title>([^<]*)<\/title>/i);
  const parts = titleTag ? htmlDecode(titleTag[1]).split(" - ") : [];
  const meta = {
    title: fallback.title || (parts[0] || "").trim(),
    artist: fallback.artist || (parts[1] || "").trim(),
  };
  const head =
    meta.title || meta.artist ? "{title: " + meta.title + "}\n{artist: " + meta.artist + "}\n\n" : "";
  return { raw: head + bodyText + "\n", meta, url: pageUrl };
}

// Unlike UG's [ch]/[tab] wrapper syntax, Cifra Club's markup IS the layout --
// each chord's tag already sits at the column it belongs above, so this only
// strips tags and decodes entities (no synthetic newlines: every <div> line
// already carries its own trailing "\n", inserting another one would open a
// blank line between every chord line and the lyric line under it).
function cifraclubContentToText(pre) {
  return htmlDecode(String(pre).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---- shared scraping helpers ---- */

function sourcesForUrl(url) {
  const u = url.toLowerCase();
  if (u.includes("ultimate-guitar.com"))
    return [{ name: "ultimate-guitar", run: () => ugFromUrl(url, {}) }];
  if (u.includes("e-chords.com"))
    return [{ name: "e-chords", run: () => echordsFromUrl(url, {}) }];
  if (u.includes("cifraclub.com"))
    return [{ name: "cifraclub", run: () => cifraclubFromUrl(url, {}) }];
  return [
    { name: "ultimate-guitar", run: () => ugFromUrl(url, {}) },
    { name: "cifraclub", run: () => cifraclubFromUrl(url, {}) },
    { name: "e-chords", run: () => echordsFromUrl(url, {}) },
  ];
}

// A Cloudflare Worker's egress IPs are shared across every Worker on the
// platform, so a site that's itself behind Cloudflare (Ultimate Guitar
// included) sometimes rate-limits that shared range harder than it would a
// single residential visitor -- one request in the ordinary rate, the next
// a 429. A short retry absorbs that without the user ever seeing it.
async function getHtml(pageUrl, attempt) {
  attempt = attempt || 1;
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": SCRAPE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      // Cifra Club localizes both UI chrome and some user-submitted section
      // labels by request language; without this a Worker's geo-routed
      // request can land on a Spanish or Portuguese version of an English
      // song page.
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (res.status === 429 && attempt < 3) {
    await sleep(500 * attempt);
    return getHtml(pageUrl, attempt + 1);
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Trim "(Remastered 2011)", "- 2009 Version" and the like off a track title so
// the search on the chord site isn't thrown off. Real parenthetical titles
// (e.g. "(Sittin' On) The Dock of the Bay") are left alone.
function cleanTitle(t) {
  const NOISE =
    /\b(remaster(ed)?|mono|stereo|version|live|unplugged|acoustic|deluxe|edition|edit|mix|remix|re-?recorded|anniversary|radio|single|explicit|clean|bonus|take \d+|feat\.?)\b/i;
  return (
    String(t || "")
      .replace(/\s*[([][^)\]]*[)\]]\s*$/g, (m) => (NOISE.test(m) ? " " : m))
      .replace(/\s*[-–—]\s*[^-–—]*$/, (m) => (NOISE.test(m) ? "" : m))
      .replace(/\s{2,}/g, " ")
      .trim() || String(t || "")
  );
}

function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch (e) {
    return {};
  }
}

// Named entities that actually turn up in song text (UG stores its content
// with these literal, e.g. "knockin&rsquo; on heaven&rsquo;s door").
const NAMED_ENTITIES = {
  rsquo: "’", lsquo: "‘", apos: "'", quot: '"',
  rdquo: "”", ldquo: "“", hellip: "…",
  mdash: "—", ndash: "–", deg: "°", amp: "&",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â",
  uuml: "ü", ouml: "ö", auml: "ä", iuml: "ï", euml: "ë",
  ntilde: "ñ", ccedil: "ç", szlig: "ß", oslash: "ø", aring: "å",
  aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
};

function htmlDecode(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => codePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : m;
    })
    .replace(/&amp;/g, "&");
}
function codePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return "";
  }
}

function stripTags(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|pre|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

/* ---------- Sessions & rate limiting ---------- */

async function newSession(env, username) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, username, created_at) VALUES (?,?,?)")
    .bind(token, username, Date.now())
    .run();
  return token;
}

async function userForToken(env, token) {
  if (!token || typeof token !== "string") return null;
  const row = await env.DB.prepare("SELECT username FROM sessions WHERE token = ?").bind(token).first();
  return row ? row.username : null;
}

async function rateLimited(env, username) {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  await env.DB.prepare("DELETE FROM auth_attempts WHERE ts < ?").bind(cutoff).run();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempts WHERE username = ? AND ts > ?"
  ).bind(username, cutoff).first();
  return row && row.n >= RATE_LIMIT_MAX;
}

/* ---------- Merge (port of app/js/library.js mergeSnapshots) ---------- */

function cleanSnap(s) {
  s = s && typeof s === "object" ? s : {};
  return {
    songs: Array.isArray(s.songs) ? s.songs.filter((x) => x && x.id) : [],
    tombstones: Array.isArray(s.tombstones) ? s.tombstones.filter((x) => x && x.id) : [],
  };
}

function mergeSnapshots(a, b) {
  const now = Date.now();

  const tombs = new Map();
  a.tombstones.concat(b.tombstones).forEach((t) => {
    const prev = tombs.get(t.id);
    if (!prev || (t.deletedAt || 0) > (prev.deletedAt || 0)) {
      tombs.set(t.id, { id: t.id, deletedAt: t.deletedAt || 0 });
    }
  });

  const rows = new Map();
  a.songs.concat(b.songs).forEach((s) => {
    const prev = rows.get(s.id);
    if (!prev || (s.updatedAt || 0) >= (prev.updatedAt || 0)) rows.set(s.id, s);
  });

  const songs = [];
  rows.forEach((s, id) => {
    const t = tombs.get(id);
    if (t && (t.deletedAt || 0) >= (s.updatedAt || 0)) return;
    songs.push(s);
  });

  const keptTombs = [];
  tombs.forEach((t, id) => {
    if (now - (t.deletedAt || 0) > TOMB_TTL_MS) return;
    const s = rows.get(id);
    if (s && (s.updatedAt || 0) > (t.deletedAt || 0)) return;
    keptTombs.push(t);
  });

  return { songs, tombstones: keptTombs };
}

/* ---------- Crypto & helpers ---------- */

function normUser(username) {
  const u = String(username || "").trim().toLowerCase();
  return /^[a-z0-9_-]{3,20}$/.test(u) ? u : null;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(passcode, saltHex, iterations) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(String(passcode)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

function json(obj, status = 200) {
  return cors(
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}
