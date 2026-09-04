// Guitar cloud sync — a single Cloudflare Worker backed by one D1 database.
//
// Endpoints (all POST, JSON in / JSON out):
//   /register  { username, passcode }        -> { token }        409 if taken
//   /login     { username, passcode }        -> { token }        401 / 429
//   /sync      { token, libraries }          -> { libraries }     401
//   /logout    { token }                     -> { ok: true }
//   /song      { artist, title } | { url }   -> { raw, meta, source, url }   404 / 429 / 502
//
// "libraries" is { guitar: {songs,tombstones}, piano: {songs,tombstones} }.
// The server keeps its own copy and returns the MERGE of what it had and
// what the client sent, so no device can clobber another. The merge below
// is a straight port of mergeSnapshots() in app/js/library.js — keep them
// in step.
//
// /song scrapes a chord sheet from an external site (Ultimate Guitar first,
// then e-chords), converts it to the plain "chords above the lyrics" text
// that app/js/songsheet.js parses, caches it in D1 (table `sheets`), and
// returns it. `refresh: true` re-fetches past the cache. It's an open
// endpoint, lightly rate-limited per IP; if it ever gets abused, gate it
// behind userForToken() the way /sync is.

const INSTRUMENTS = ["guitar", "piano"];
const TOMB_TTL_MS = 150 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const RATE_LIMIT_MAX = 10; // failed attempts...
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // ...per username per hour

const SONG_RATE_MAX = 40; // upstream chord-sheet fetches...
const SONG_RATE_WINDOW_MS = 60 * 60 * 1000; // ...per client IP per hour (cache hits don't count)
const SCRAPE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

async function song(env, body, request) {
  const artist = String((body && body.artist) || "").trim();
  const title = String((body && body.title) || "").trim();
  const url = String((body && body.url) || "").trim();
  const refresh = Boolean(body && body.refresh);
  if (!title && !url) return json({ error: "Need a song title or a url." }, 400);

  const key = url
    ? "url:" + url.toLowerCase()
    : "q:" + normKey(artist) + "|" + normKey(cleanTitle(title));

  if (!refresh) {
    const hit = await env.DB
      .prepare("SELECT source, url, raw, meta FROM sheets WHERE key = ?")
      .bind(key)
      .first();
    if (hit) {
      return json({ raw: hit.raw, meta: safeParse(hit.meta), source: hit.source, url: hit.url, cached: true });
    }
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await songRateLimited(env, ip)) {
    return json({ error: "Too many fetches this hour — wait a bit, or paste the sheet in by hand." }, 429);
  }

  const chain = url
    ? sourcesForUrl(url)
    : [
        { name: "ultimate-guitar", run: () => ugSearchAndFetch(artist, title) },
        { name: "e-chords", run: () => echordsSearchAndFetch(artist, title) },
      ];

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

async function songRateLimited(env, ip) {
  const cutoff = Date.now() - SONG_RATE_WINDOW_MS;
  await env.DB.prepare("DELETE FROM fetch_attempts WHERE ts < ?").bind(cutoff).run();
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM fetch_attempts WHERE ip = ? AND ts > ?")
    .bind(ip, cutoff)
    .first();
  return row && row.n >= SONG_RATE_MAX;
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

async function ugSearchAndFetch(artist, title) {
  const q = [artist, cleanTitle(title)].filter(Boolean).join(" ");
  const searchUrl =
    "https://www.ultimate-guitar.com/search.php?search_type=title&type%5B%5D=300&value=" +
    encodeURIComponent(q);
  const data = ugPageData(ugStore(await getHtml(searchUrl)));
  const results = (data && data.results) || [];
  const hits = results.filter(
    (r) => r && r.tab_url && (r.type === "Chords" || r.type_name === "Chords")
  );
  if (!hits.length) throw new Error("no chord results");
  hits.sort((a, b) => (b.votes || 0) * (b.rating || 0) - (a.votes || 0) * (a.rating || 0));
  return ugFromUrl(hits[0].tab_url, { artist, title });
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
    .filter((ln) => !/^\s*[A-G][#b]?[a-z0-9]{0,4}\s+[0-9xX](?:[-\s][0-9xX]){3,5}\s*$/.test(ln))
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

/* ---- shared scraping helpers ---- */

function sourcesForUrl(url) {
  const u = url.toLowerCase();
  if (u.includes("ultimate-guitar.com"))
    return [{ name: "ultimate-guitar", run: () => ugFromUrl(url, {}) }];
  if (u.includes("e-chords.com"))
    return [{ name: "e-chords", run: () => echordsFromUrl(url, {}) }];
  return [
    { name: "ultimate-guitar", run: () => ugFromUrl(url, {}) },
    { name: "e-chords", run: () => echordsFromUrl(url, {}) },
  ];
}

async function getHtml(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": SCRAPE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
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
