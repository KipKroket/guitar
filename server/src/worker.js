// Guitar cloud sync — a single Cloudflare Worker backed by one D1 database.
//
// Endpoints (all POST, JSON in / JSON out):
//   /register  { username, passcode }        -> { token }        409 if taken
//   /login     { username, passcode }        -> { token }        401 / 429
//   /sync      { token, libraries }          -> { libraries }     401
//   /logout    { token }                     -> { ok: true }
//
// "libraries" is { guitar: {songs,tombstones}, piano: {songs,tombstones} }.
// The server keeps its own copy and returns the MERGE of what it had and
// what the client sent, so no device can clobber another. The merge below
// is a straight port of mergeSnapshots() in app/js/library.js — keep them
// in step.

const INSTRUMENTS = ["guitar", "piano"];
const TOMB_TTL_MS = 150 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const RATE_LIMIT_MAX = 10; // failed attempts...
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // ...per username per hour

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
