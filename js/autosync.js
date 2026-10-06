// Guitar — automatic lyric timing from LRCLIB (no UI in here).
// Everything the song screen needs to turn "artist + title + duration" into a
// list of {ms, line, h} anchors for one sheet: look the song up at
// lrclib.net, pick the version that fits the recording, match its lines to
// the sheet's lines (repeats may jump back), and turn a playback position
// into "the line that is about to be sung". Anchors keep a short hash of
// each line instead of its text, so no lyrics are ever stored. Pure
// functions, no DOM; loads in the browser (window.AutoSync) and in node
// (module.exports) so it can be tested.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AutoSync = api;
})(typeof self !== "undefined" ? self : this, function () {
  const LRCLIB = "https://lrclib.net/api/";

  /* ---------- text helpers ---------- */
  function norm(s) {
    s = String(s || "").toLowerCase();
    if (s.normalize) s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return s.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function cleanTitle(t) {
    return String(t || "")
      .replace(/\s*[\(\[].*?[\)\]]/g, "")
      .replace(/\s*-\s*(remaster.*|live.*)$/i, "")
      .trim();
  }
  // Short stable hash of a normalized line -- stored instead of the text.
  function hashLine(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }
  function dice(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const m = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const k = a.substr(i, 2);
      m.set(k, (m.get(k) || 0) + 1);
    }
    let inter = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const k = b.substr(i, 2);
      const c = m.get(k);
      if (c) {
        inter++;
        m.set(k, c - 1);
      }
    }
    return (2 * inter) / (a.length + b.length - 2);
  }
  const simMemo = new Map();
  function sim(a, b) {
    if (a === b) return a ? 1 : 0;
    if (!a || !b) return 0;
    const key = a + "\u0001" + b;
    const hit = simMemo.get(key);
    if (hit !== undefined) return hit;
    const wa = new Set(a.split(" "));
    const wb = new Set(b.split(" "));
    let inter = 0;
    wa.forEach((w) => {
      if (wb.has(w)) inter++;
    });
    let v = 0;
    if (inter / Math.min(wa.size, wb.size) >= 0.34) {
      v = dice(a, b);
      const sh = a.length <= b.length ? a : b;
      const lg = a.length <= b.length ? b : a;
      if (sh.length >= 12 && lg.indexOf(sh) !== -1) v = Math.max(v, 0.9);
    }
    if (simMemo.size > 200000) simMemo.clear();
    simMemo.set(key, v);
    return v;
  }

  /* ---------- LRC ---------- */
  // "[01:02.50][02:10.00] text" -> one entry per timestamp. Empty lines and
  // tag lines ([ar:...]) are dropped.
  function parseLrc(text) {
    const out = [];
    String(text || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const m = line.match(/^((?:\s*\[\d+:\d+(?:[.:]\d+)?\])+)\s*(.*)$/);
        if (!m) return;
        const t = norm(m[2]);
        if (!t) return;
        const re = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
        let x;
        while ((x = re.exec(m[1]))) {
          out.push({ ms: Math.round((parseInt(x[1], 10) * 60 + parseFloat(x[2].replace(":", "."))) * 1000), text: t });
        }
      });
    out.sort((a, b) => a.ms - b.ms);
    return out;
  }

  /* ---------- LRCLIB ---------- */
  function artistOk(q, r) {
    const a = norm(q), b = norm(r);
    if (!a || !b) return false;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
    return dice(a, b) >= 0.7;
  }
  function titleOk(q, r) {
    const a = norm(cleanTitle(q)), b = norm(cleanTitle(r));
    if (!a || !b) return false;
    if (a === b) return true;
    if ((a.length >= 4 && b.indexOf(a) !== -1) || (b.length >= 4 && a.indexOf(b) !== -1)) return true;
    return dice(a, b) >= 0.8;
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  // LRCLIB answers 503 now and then under load -- a second try nearly always
  // works, so retry with a growing pause instead of giving up.
  async function fetchJson(url, opts) {
    const tries = (opts && opts.tries) || 4;
    const f = (opts && opts.fetch) || fetch;
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await f(url);
        if (res.ok) return await res.json();
        last = new Error("HTTP " + res.status);
      } catch (e) {
        last = e;
      }
      await sleep(500 * Math.pow(2, i));
    }
    throw last || new Error("LRCLIB unreachable");
  }
  function strictSynced(list, artist, title) {
    return (list || []).filter(
      (r) => r && r.syncedLyrics && artistOk(artist, r.artistName) && titleOk(title, r.trackName)
    );
  }
  async function lookup(artist, title, opts) {
    const q1 = LRCLIB + "search?" + new URLSearchParams({ track_name: cleanTitle(title), artist_name: artist });
    let found = strictSynced(await fetchJson(q1, opts), artist, title);
    if (!found.length) {
      const q2 = LRCLIB + "search?" + new URLSearchParams({ q: artist + " " + cleanTitle(title) });
      found = strictSynced(await fetchJson(q2, opts), artist, title);
    }
    // identical timing files add nothing
    const seen = new Set();
    return found.filter((c) => {
      const k = c.syncedLyrics.trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /* ---------- LRC lines -> sheet lines ---------- */
  // lrc: [{ms, text(normalized)}]; sheet: array of normalized lyric texts, ""
  // for chord-only lines. Returns, for each LRC line, the sheet line it
  // belongs to (or null). The path may step forward by one (the normal case),
  // skip ahead, stay put, or jump BACK (a chorus the sheet only writes once).
  function matchLines(lrc, sheet, tau) {
    tau = tau == null ? 0.62 : tau;
    const idx = [];
    sheet.forEach((t, i) => {
      if (t) idx.push(i);
    });
    const n = idx.length, m = lrc.length, NEG = -1e9;
    if (!n || !m) return { assign: new Array(m).fill(null), score: 0 };
    const sc = [];
    for (let j = 0; j < m; j++) {
      const row = new Array(n);
      for (let k = 0; k < n; k++) row[k] = sim(lrc[j].text, sheet[idx[k]]);
      sc.push(row);
    }
    let dp = new Array(n + 1).fill(NEG);
    dp[n] = 0; // "nothing matched yet"
    const back = [];
    for (let j = 0; j < m; j++) {
      const ndp = dp.slice();
      const bp = [];
      for (let i = 0; i <= n; i++) bp.push(i * 2); // encoded (prev, matched=0)
      for (let k = 0; k < n; k++) {
        const s = sc[j][k];
        if (s < tau) continue;
        const reward = 0.3 + 2 * (s - tau);
        let bv = NEG, bi = -1;
        for (let i = 0; i <= n; i++) {
          const v = dp[i];
          if (v <= NEG / 2) continue;
          let c;
          if (i === n || k === i + 1) c = 0;
          else if (k === i) c = 0.2;
          else if (k > i + 1) c = Math.min(0.6, 0.04 * (k - i - 1));
          else c = 0.5;
          const tot = v + reward - c;
          if (tot > bv) {
            bv = tot;
            bi = i;
          }
        }
        if (bv > ndp[k]) {
          ndp[k] = bv;
          bp[k] = bi * 2 + 1;
        }
      }
      dp = ndp;
      back.push(bp);
    }
    let st = 0;
    for (let i = 1; i <= n; i++) if (dp[i] > dp[st]) st = i;
    const score = dp[st];
    const assign = new Array(m).fill(null);
    for (let j = m - 1; j >= 0; j--) {
      const e = back[j][st];
      if (e & 1) assign[j] = idx[st];
      st = e >> 1;
    }
    return { assign, score };
  }

  // Everything the UI needs from one LRCLIB candidate against one sheet.
  function mapCandidate(cand, sheet) {
    const lrc = parseLrc(cand.syncedLyrics);
    const res = matchLines(lrc, sheet);
    const anchors = [];
    let jumps = 0, prev = -1;
    res.assign.forEach((line, j) => {
      if (line == null) return;
      if (prev >= 0 && line < prev) jumps++;
      anchors.push({ ms: lrc[j].ms, line, h: hashLine(sheet[line]) });
      prev = line;
    });
    const covered = new Set(anchors.map((a) => a.line)).size;
    const sheetLines = sheet.filter(Boolean).length;
    const gaps = [];
    for (let i = 1; i < anchors.length; i++) gaps.push(anchors[i].ms - anchors[i - 1].ms);
    gaps.sort((a, b) => a - b);
    return {
      anchors,
      lrcLines: lrc.length,
      matched: anchors.length,
      pct: lrc.length ? anchors.length / lrc.length : 0,
      coverage: sheetLines ? covered / sheetLines : 0,
      jumps,
      medianGapMs: gaps.length ? gaps[gaps.length >> 1] : 0,
      maxGapMs: gaps.length ? gaps[gaps.length - 1] : 0,
    };
  }

  // Candidates nearest in length to the recording come first; the first few
  // are mapped and the one that explains most of the sheet wins.
  function rank(cands, durSec) {
    const list = cands.slice();
    if (durSec) list.sort((a, b) => Math.abs((a.duration || 0) - durSec) - Math.abs((b.duration || 0) - durSec));
    return list;
  }
  function choose(ranked, sheet, from, count) {
    let best = null;
    for (let i = from || 0; i < Math.min(ranked.length, (from || 0) + (count || 3)); i++) {
      const map = mapCandidate(ranked[i], sheet);
      if (!best || map.matched > best.map.matched) best = { index: i, cand: ranked[i], map };
    }
    return best;
  }

  /* ---------- position -> sheet line ---------- */
  // anchors are sorted by ms. Returns the sheet line that has most recently
  // started at time t (ms), and the index of that anchor, or at = -1 while
  // t is still before the first line. The line stays current through any
  // instrumental gap until the next one starts: callers add their "show it a
  // moment early" lead to t themselves.
  function currentLine(anchors, t) {
    const n = anchors.length;
    if (!n || t < anchors[0].ms) return { line: n ? anchors[0].line : 0, at: -1 };
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (anchors[mid].ms <= t) lo = mid;
      else hi = mid - 1;
    }
    return { line: anchors[lo].line, at: lo };
  }

  return { norm, cleanTitle, hashLine, sim, parseLrc, lookup, fetchJson, matchLines, mapCandidate, rank, choose, currentLine, artistOk, titleOk };
});
