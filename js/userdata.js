// Guitar — everything besides the song library that belongs to the user:
// setlists, preferences, and the pasted/fetched chord sheets.
//
//   setlists   per-instrument, merged like the library (per-row updatedAt +
//              tombstones) -- synced to the account AND in the backup file.
//   settings   a fixed allowlist of localStorage preferences, last-write-wins
//              per key -- synced to the account AND in the backup file.
//   sheets     the chord/lyric text. Copyright: NEVER synced to the account
//              (js/sync.js doesn't touch them), but they ARE in the backup
//              file, which only ever lives on the user's own device.
//
// Not covered on purpose: the Spotify login (a per-device credential -- just
// reconnect) and the last-used instrument (each installed PWA pins its own).
(function () {
  const INSTRUMENTS = ["guitar", "piano"];
  const TOMB_TTL_MS = 150 * 24 * 60 * 60 * 1000;

  const SETTING_KEYS = [
    "guitar-theme",
    "guitar-default-tuning",
    "guitar-metronome-bpm",
    "guitar-metronome-signature",
    "guitar-chord-root",
    "guitar-chord-type",
    "guitar-autoscroll-speed",
    "guitar-backingtrack-speed",
  ];
  const SETTING_SET = new Set(SETTING_KEYS);
  const TS_KEY = "guitar-settings-ts"; // { key: lastChangedMs }
  const INIT_KEY = "guitar-settings-init";

  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  let applying = false;

  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v && typeof v === "object" ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      nativeSet.call(localStorage, key, JSON.stringify(value));
    } catch (e) {
      /* quota -- nothing sensible to do */
    }
  }

  /* ---------- Settings ---------- */
  function readTs() {
    return readJson(TS_KEY, {});
  }

  // Values that predate this feature get timestamp 1: old enough for any real
  // change (here or on another device) to win, but still pushed once so the
  // account ends up holding them. Runs once per install.
  try {
    if (!localStorage.getItem(INIT_KEY)) {
      const ts = readTs();
      SETTING_KEYS.forEach((k) => {
        if (localStorage.getItem(k) !== null && !ts[k]) ts[k] = 1;
      });
      writeJson(TS_KEY, ts);
      nativeSet.call(localStorage, INIT_KEY, "1");
    }
  } catch (e) {
    /* storage unavailable */
  }

  // Every write to a watched preference stamps it and nudges the sync layer,
  // so the individual modules that own those preferences stay untouched.
  Storage.prototype.setItem = function (key, value) {
    let watch = false;
    let old = null;
    try {
      watch = this === window.localStorage && !applying && SETTING_SET.has(key);
      if (watch) old = this.getItem(key);
    } catch (e) {
      watch = false;
    }
    nativeSet.apply(this, arguments);
    if (watch && old !== String(value)) {
      const ts = readTs();
      ts[key] = Date.now();
      writeJson(TS_KEY, ts);
      setTimeout(() => document.dispatchEvent(new CustomEvent("userdatachange")), 0);
    }
  };

  function getSettings() {
    const ts = readTs();
    const out = {};
    SETTING_KEYS.forEach((k) => {
      const v = localStorage.getItem(k);
      if (v !== null && ts[k]) out[k] = { v: v, ts: ts[k] };
    });
    return out;
  }

  // Newer timestamp wins per key. Returns the keys whose value actually
  // changed (the running app only reads these at startup).
  function applySettings(incoming) {
    const changed = [];
    if (!incoming || typeof incoming !== "object") return changed;
    const ts = readTs();
    applying = true;
    try {
      SETTING_KEYS.forEach((k) => {
        const e = incoming[k];
        if (!e || typeof e.v !== "string" || !(e.ts > (ts[k] || 0))) return;
        if (localStorage.getItem(k) !== e.v) {
          nativeSet.call(localStorage, k, e.v);
          changed.push(k);
        }
        ts[k] = e.ts;
      });
    } finally {
      applying = false;
    }
    writeJson(TS_KEY, ts);
    return changed;
  }

  // Signing in on a fresh device: forget local timestamps so the account's
  // values win over whatever defaults this device wrote on its own.
  function resetSettingTimestamps() {
    writeJson(TS_KEY, {});
  }

  /* ---------- Setlists ---------- */
  const slKey = (inst) => inst + "-setlists";
  const slTombKey = (inst) => inst + "-setlists-tomb";

  function readList(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  function cleanSetlist(s) {
    return { ...s, id: String(s.id), name: typeof s.name === "string" ? s.name : "Untitled", songIds: Array.isArray(s.songIds) ? s.songIds : [] };
  }
  function setlistSnap(inst) {
    return {
      songs: readList(slKey(inst)).filter((s) => s && typeof s === "object" && s.id != null).map(cleanSetlist),
      tombstones: readList(slTombKey(inst)).filter((t) => t && t.id),
    };
  }

  function getSetlists() {
    const out = {};
    INSTRUMENTS.forEach((inst) => (out[inst] = setlistSnap(inst)));
    return out;
  }

  // Returns how many setlists were new to this device.
  function applySetlists(incoming) {
    if (!incoming || typeof incoming !== "object" || !window.GuitarLibrary || !window.GuitarLibrary.mergeSnapshots) return 0;
    let added = 0;
    INSTRUMENTS.forEach((inst) => {
      const inSnap = incoming[inst];
      if (!inSnap) return;
      const local = setlistSnap(inst);
      const merged = window.GuitarLibrary.mergeSnapshots(local, {
        songs: (Array.isArray(inSnap.songs) ? inSnap.songs : []).filter((s) => s && s.id != null).map(cleanSetlist),
        tombstones: Array.isArray(inSnap.tombstones) ? inSnap.tombstones : [],
      });
      const had = new Set(local.songs.map((s) => s.id));
      added += merged.songs.filter((s) => !had.has(s.id)).length;
      writeJson(slKey(inst), merged.songs);
      writeJson(slTombKey(inst), merged.tombstones);
    });
    document.dispatchEvent(new CustomEvent("setlistsapplied"));
    return added;
  }

  /* ---------- Chord sheets (backup file only) ---------- */
  const sheetKey = (inst) => inst + "-sheets";

  function getSheets() {
    const out = {};
    INSTRUMENTS.forEach((inst) => (out[inst] = readJson(sheetKey(inst), {})));
    return out;
  }

  // Returns how many sheets were new or newer than the local copy.
  function applySheets(incoming) {
    if (!incoming || typeof incoming !== "object") return 0;
    let n = 0;
    INSTRUMENTS.forEach((inst) => {
      const inStore = incoming[inst];
      if (!inStore || typeof inStore !== "object") return;
      const store = readJson(sheetKey(inst), {});
      let dirty = false;
      Object.keys(inStore).forEach((id) => {
        const rec = inStore[id];
        if (!rec || typeof rec.raw !== "string") return;
        const cur = store[id];
        if (!cur || (rec.savedAt || 0) > (cur.savedAt || 0)) {
          store[id] = rec;
          dirty = true;
          n++;
        }
      });
      if (dirty) writeJson(sheetKey(inst), store);
    });
    return n;
  }

  window.GuitarUserData = {
    getSettings,
    applySettings,
    resetSettingTimestamps,
    getSetlists,
    applySetlists,
    getSheets,
    applySheets,
  };
})();
