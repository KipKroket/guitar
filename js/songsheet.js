// Guitar — Song sheet: full lyrics with the chords placed above them, shown
// inside the song-detail overlay.
//
// Phase 1 (this file): parse a pasted chord sheet, render it, transpose it,
// tap a chord to see its diagram. No network at all -- the text is whatever
// the user pastes in. Phase 2 adds a "fetch automatically" button that fills
// the same textarea from a proxy; phase 3 adds autoscroll.
//
// PRIVACY / LICENSING: pasted sheets live under their own localStorage keys
// (guitar-sheets / piano-sheets), keyed by song id. That store is deliberately
// NOT read by js/sync.js and NOT part of the Settings export/import -- so a
// copied chord sheet never travels to the cloud copy or into a backup file
// that might be shared. Only the raw text + a transpose offset are kept; the
// sheet is re-parsed on open, so the stored blob stays tiny and format-
// agnostic.
(function () {
  const STORAGE_KEYS = { guitar: "guitar-sheets", piano: "piano-sheets" };
  // Autoscroll tempo is a plain user preference (not per-song, not part of
  // any sheet record) so it's kept in its own tiny localStorage key.
  const SCROLL_SPEED_KEY = "guitar-autoscroll-speed";

  // Same Cloudflare Worker as js/sync.js (SYNC_URL), plus the /song route:
  // it scrapes a chord sheet, caches it, and hands back the same "chords
  // above the lyrics" text a paste would produce. Empty string disables the
  // "Fetch automatically" button (paste still works).
  const FETCH_URL = "https://guitar-sync.julianleendertse.workers.dev/song";

  const NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const FLAT  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm"]);

  // A whitespace-separated token that reads as a chord: a root note, an
  // optional pile of quality/extension text, an optional slash bass. Kept
  // permissive on purpose -- anything odd still parses as "some chord" and
  // just may not get a diagram.
  const CHORD_TOKEN =
    /^[A-G](?:#|b)?(?:maj|min|m|M|sus|add|aug|dim|°|Δ|\+|\d|\(|\)|#|b|-|\/|[A-G])*$/;

  // Section headers: a bracketed label whose inside is not itself a chord,
  // or a bare word like "Chorus" / "Verse 2" on its own line.
  const BARE_SECTION =
    /^(intro|verse|chorus|pre[-\s]?chorus|bridge|outro|refrain|interlude|instrumental|instr|solo|hook|coda|tag|ending|breakdown|vamp)(\s*\d+)?\s*:?\s*$/i;

  // A "chord name + fret map" legend line some sites open a sheet with, e.g.
  // "G     3-x-0-0-0-3". Useful in a printed chart, redundant here -- every
  // chord already has a tappable diagram -- so these are dropped entirely
  // rather than shown as a stray text line.
  const FRET_LEGEND_LINE =
    /^\s*[A-G](?:#|b)?[a-zA-Z0-9]{0,6}(?:\/[A-G](?:#|b)?)?\s+[0-9xX](?:[-\s][0-9xX]){3,5}\s*$/;

  /* ================================================================
     Parsing: raw text -> { meta, sections:[{ label, lines:[line] }] }
     line = { lyric: string, chords: [{ sym, index }] }
     ================================================================ */

  function isChordToken(t) {
    if (!t) return false;
    if (/^(n\.?c\.?|%|x\d+|\|)$/i.test(t)) return true; // "N.C.", repeat marks
    return CHORD_TOKEN.test(t) && /[A-G]/.test(t[0]);
  }

  function isChordLine(raw) {
    const line = raw.trim();
    if (!line) return false;
    if (/[a-z]{4,}/.test(line) && !/^[A-G]/.test(line)) return false;
    const tokens = line.split(/\s+/);
    if (!tokens.every(isChordToken)) return false;
    // A lone bare letter ("A") is ambiguous with a lyric; require either
    // several tokens or some chord-ish detail (accidental / quality / digit).
    return tokens.length > 1 || /[#b0-9msuaditgMΔ+°/]/.test(tokens[0].slice(1));
  }

  function sectionLabel(raw) {
    const line = raw.trim();
    const bracket = line.match(/^\[([^\]]+)\]:?\s*$/);
    if (bracket) {
      const inner = bracket[1].trim();
      // "[C]" or "[Am]" on its own line is a chord, not a heading.
      if (isChordToken(inner) && !/\s/.test(inner)) return null;
      return inner;
    }
    if (BARE_SECTION.test(line)) return line.replace(/:\s*$/, "").trim();
    return null;
  }

  // One ChordPro-style line: "[Am]Hello dark[C]ness" -> lyric + chord indices.
  function parseInlineChordLine(raw) {
    const chords = [];
    let lyric = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "[") {
        const close = raw.indexOf("]", i);
        if (close !== -1) {
          chords.push({ sym: raw.slice(i + 1, close).trim(), index: lyric.length });
          i = close + 1;
          continue;
        }
      }
      lyric += raw[i];
      i += 1;
    }
    return { lyric: lyric.replace(/\s+$/, ""), chords };
  }

  // A bare chord line ("  C      G   Am") paired with the lyric line under it.
  function parseChordOverLine(chordRaw, lyricRaw) {
    const chords = [];
    const re = /(\S+)/g;
    let m;
    while ((m = re.exec(chordRaw))) chords.push({ sym: m[1], index: m.index });
    const lyric = (lyricRaw || "").replace(/\s+$/, "");
    return { lyric, chords };
  }

  function parseDirective(raw, ctx) {
    const m = raw.trim().match(/^\{\s*([a-z_]+)\s*:?\s*([^}]*)\}$/i);
    if (!m) return false;
    const name = m[1].toLowerCase();
    const val = m[2].trim();
    if (name === "title" || name === "t") ctx.meta.title = val;
    else if (name === "subtitle" || name === "st" || name === "artist") ctx.meta.artist = val;
    else if (name === "key") ctx.meta.key = val;
    else if (name === "capo") ctx.meta.capo = val;
    else if (name === "comment" || name === "c" || name === "ci" || name === "comment_italic")
      ctx.startSection(val || null);
    else if (name === "start_of_chorus" || name === "soc") ctx.startSection("Chorus");
    else if (name === "start_of_verse" || name === "sov") ctx.startSection("Verse");
    else if (name === "start_of_bridge" || name === "sob") ctx.startSection("Bridge");
    else if (name === "end_of_chorus" || name === "eoc" || name === "end_of_verse" ||
             name === "eov" || name === "end_of_bridge" || name === "eob")
      ctx.startSection(null);
    // everything else (define, tempo, sot/eot, ...) is ignored for v1
    return true;
  }

  function parseSheet(text) {
    const meta = {};
    const sections = [];
    let current = null;

    function startSection(label) {
      // Fold consecutive empty sections together.
      if (current && current.lines.length === 0) {
        current.label = label;
        return;
      }
      current = { label: label || null, lines: [] };
      sections.push(current);
    }
    function ensureSection() {
      if (!current) startSection(null);
      return current;
    }
    const ctx = { meta, startSection };

    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];

      if (/^\s*\{[^}]*\}\s*$/.test(raw) && parseDirective(raw, ctx)) continue;

      if (!raw.trim()) {
        // Blank line = paragraph break inside a section.
        if (current && current.lines.length && current.lines[current.lines.length - 1] !== null)
          current.lines.push(null);
        continue;
      }

      if (FRET_LEGEND_LINE.test(raw)) continue;

      const label = sectionLabel(raw);
      if (label !== null || /^\[[^\]]+\]:?\s*$/.test(raw.trim())) {
        startSection(label);
        continue;
      }

      if (raw.indexOf("[") !== -1 && /\[[^\]]+\]/.test(raw)) {
        ensureSection().lines.push(parseInlineChordLine(raw));
        continue;
      }

      if (isChordLine(raw)) {
        const next = lines[i + 1];
        const nextIsLyric =
          next != null && next.trim() && !isChordLine(next) && sectionLabel(next) === null &&
          !/^\s*\{[^}]*\}\s*$/.test(next);
        if (nextIsLyric) {
          ensureSection().lines.push(parseChordOverLine(raw, next));
          i += 1;
        } else {
          ensureSection().lines.push(parseChordOverLine(raw, ""));
        }
        continue;
      }

      ensureSection().lines.push({ lyric: raw.replace(/\s+$/, ""), chords: [] });
    }

    // Drop a trailing empty section and trailing paragraph breaks.
    while (sections.length && sections[sections.length - 1].lines.filter(Boolean).length === 0)
      sections.pop();
    sections.forEach((s) => {
      while (s.lines.length && s.lines[s.lines.length - 1] === null) s.lines.pop();
    });

    const chordCount = sections.reduce(
      (n, s) => n + s.lines.reduce((k, l) => k + (l ? l.chords.length : 0), 0),
      0
    );
    const lineCount = sections.reduce((n, s) => n + s.lines.filter(Boolean).length, 0);
    return { meta, sections, chordCount, lineCount };
  }

  /* ================================================================
     Transpose
     ================================================================ */

  function shiftNote(letter, acc, semis, preferFlat) {
    let idx = NOTE_IDX[letter];
    if (idx == null) return letter + (acc || "");
    if (acc === "#") idx += 1;
    else if (acc === "b") idx -= 1;
    idx = ((idx + semis) % 12 + 12) % 12;
    return (preferFlat ? FLAT : SHARP)[idx];
  }

  // Shift only the root (start of symbol) and a slash-bass note; leave the
  // quality text ("m7", "sus4", "add9") untouched.
  function transposeSym(sym, semis, preferFlat) {
    if (!sym || !semis) return sym;
    if (/^(n\.?c\.?|%|x\d+|\|)$/i.test(sym)) return sym;
    return sym.replace(/([A-G])(#|b)?/g, (whole, letter, acc, offset) => {
      const isRoot = offset === 0;
      const isBass = offset > 0 && sym[offset - 1] === "/";
      if (!isRoot && !isBass) return whole;
      return shiftNote(letter, acc, semis, preferFlat);
    });
  }

  function transposeModel(model, semis) {
    if (!semis) return model;
    const preferFlat = FLAT_KEYS.has((model.meta.key || "").trim()) || semis < 0;
    const sections = model.sections.map((s) => ({
      label: s.label,
      lines: s.lines.map((l) =>
        l == null
          ? null
          : { lyric: l.lyric, chords: l.chords.map((c) => ({ sym: transposeSym(c.sym, semis, preferFlat), index: c.index })) }
      ),
    }));
    return { meta: model.meta, sections, chordCount: model.chordCount, lineCount: model.lineCount };
  }

  // Real chord symbols only -- bar lines, "N.C.", repeat marks and the like
  // appear in the sheet body but shouldn't become chips or count towards the
  // "N chords" badge.
  function uniqueChords(model) {
    const seen = new Set();
    const out = [];
    model.sections.forEach((s) =>
      s.lines.forEach((l) => {
        if (!l) return;
        l.chords.forEach((c) => {
          const k = c.sym.trim();
          if (k && /^[A-G]/.test(k) && !seen.has(k)) {
            seen.add(k);
            out.push(k);
          }
        });
      })
    );
    return out;
  }

  /* ================================================================
     Storage (own keys -- see the privacy note at the top of the file)
     ================================================================ */

  function readStore(inst) {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS[inst]) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  function writeStore(inst, store) {
    try {
      localStorage.setItem(STORAGE_KEYS[inst], JSON.stringify(store));
    } catch (e) {
      /* quota -- nothing sensible to do here for a personal tool */
    }
  }
  function loadSheet(inst, songId) {
    const rec = readStore(inst)[songId];
    return rec && typeof rec.raw === "string" ? rec : null;
  }
  function saveSheet(inst, songId, rec) {
    const store = readStore(inst);
    store[songId] = { raw: rec.raw, source: rec.source || "paste", transpose: rec.transpose | 0, savedAt: Date.now() };
    writeStore(inst, store);
  }
  function deleteSheet(inst, songId) {
    const store = readStore(inst);
    delete store[songId];
    writeStore(inst, store);
  }

  /* ================================================================
     UI -- lives inside #songsheet in the song-detail overlay
     ================================================================ */

  const root = document.getElementById("songsheet");
  if (!root) return;

  let state = null; // { song, inst, record, adding, expanded, autoscroll }
  let panel = null; // the expanded content area; null while collapsed

  /* ================================================================
     Autoscroll -- scrolls the enclosing overlay (not the panel itself)
     at a steady speed while the sheet is on screen. Speed is a small
     1-10 "level" mapped to px/s; the level is remembered, the on/off
     state is not (a reopened sheet always starts stopped).
     ================================================================ */

  function loadScrollSpeed() {
    const v = parseInt(localStorage.getItem(SCROLL_SPEED_KEY), 10);
    return v >= 1 && v <= 10 ? v : 4;
  }
  function saveScrollSpeed(level) {
    try {
      localStorage.setItem(SCROLL_SPEED_KEY, String(level));
    } catch (e) {
      /* quota -- fine to just not remember it */
    }
  }
  function levelToPxPerSec(level) {
    return level * 8; // 8..80 px/s
  }

  let scrollRAF = null;
  let scrollLastTs = null;
  let scrollOutsideHandler = null;

  function scrollContainer() {
    return root.closest(".overlay") || document.scrollingElement || document.documentElement;
  }

  function stopAutoscroll() {
    if (scrollRAF != null) cancelAnimationFrame(scrollRAF);
    scrollRAF = null;
    scrollLastTs = null;
  }

  function autoscrollTick(ts) {
    const active =
      state && state.expanded && state.record && !state.adding && state.autoscroll.on;
    if (!active) {
      stopAutoscroll();
      // Something other than an explicit toggle-off stopped us (the panel
      // collapsed, the sheet went into edit mode, ...) -- reflect that in
      // state so the checkbox/FAB don't claim autoscroll is still on with
      // nothing actually moving.
      if (state && state.autoscroll && state.autoscroll.on) {
        state.autoscroll.on = false;
        render();
      }
      return;
    }
    const box = scrollContainer();
    if (scrollLastTs != null) {
      const dt = (ts - scrollLastTs) / 1000;
      box.scrollTop += levelToPxPerSec(state.autoscroll.speed) * dt;
      if (box.scrollTop >= box.scrollHeight - box.clientHeight - 1) {
        // Reached the bottom -- stop rather than sit there doing nothing.
        state.autoscroll.on = false;
        stopAutoscroll();
        render();
        return;
      }
    }
    scrollLastTs = ts;
    scrollRAF = requestAnimationFrame(autoscrollTick);
  }

  function startAutoscroll() {
    if (scrollRAF != null) return;
    scrollLastTs = null;
    scrollRAF = requestAnimationFrame(autoscrollTick);
  }

  function closeScrollMenu() {
    if (!state || !state.autoscroll || !state.autoscroll.menuOpen) return;
    state.autoscroll.menuOpen = false;
    if (scrollOutsideHandler) {
      document.removeEventListener("pointerdown", scrollOutsideHandler, true);
      scrollOutsideHandler = null;
    }
  }

  /* ---- Floating "while scrolling" control -----------------------------
     A small round button pinned to the bottom-right of the viewport
     (position: fixed -- a plain child of <body>, not of #songsheet, so it
     isn't clipped by the overlay's own overflow-y:auto and stays put
     regardless of scroll position), visible only while autoscroll is
     actually running. Lets you change tempo or stop without having to
     scroll back up to the toolbar. ---- */

  let fab = null;
  let fabOutsideHandler = null;

  function closeFabMenu() {
    if (!state || !state.autoscroll || !state.autoscroll.fabMenuOpen) return;
    state.autoscroll.fabMenuOpen = false;
    if (fabOutsideHandler) {
      document.removeEventListener("pointerdown", fabOutsideHandler, true);
      fabOutsideHandler = null;
    }
  }

  function renderFab() {
    const show = !!(
      state && state.expanded && state.record && !state.adding && state.autoscroll.on
    );
    if (!show) {
      closeFabMenu();
      if (fab) {
        fab.remove();
        fab = null;
      }
      return;
    }
    if (!fab) {
      fab = el("div", "songsheet__fab");
      document.body.appendChild(fab);
    }
    fab.textContent = "";

    const btn = el("button", "songsheet__fab-btn", null);
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", state.autoscroll.fabMenuOpen ? "true" : "false");
    btn.setAttribute("aria-label", "Autoscroll instellingen");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M6 6l6 6 6-6M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.autoscroll.fabMenuOpen = !state.autoscroll.fabMenuOpen;
      renderFab();
      if (!state.autoscroll.fabMenuOpen) return;
      // Registered after this click has finished bubbling, so the same tap
      // that opened the menu doesn't also close it via the outside handler.
      setTimeout(() => {
        if (!state || !state.autoscroll.fabMenuOpen) return;
        fabOutsideHandler = (ev) => {
          if (!ev.target.closest || !ev.target.closest(".songsheet__fab")) {
            closeFabMenu();
            renderFab();
          }
        };
        document.addEventListener("pointerdown", fabOutsideHandler, true);
      }, 0);
    });
    fab.appendChild(btn);

    if (state.autoscroll.fabMenuOpen) {
      const menu = el("div", "songsheet__fab-menu");

      const speedWrap = el("label", "songsheet__scroll-speed");
      const speedHead = el("div", "songsheet__scroll-speed-head");
      speedHead.appendChild(el("span", null, "Tempo"));
      const speedVal = el("span", "songsheet__scroll-speed-val", String(state.autoscroll.speed));
      speedHead.appendChild(speedVal);
      speedWrap.appendChild(speedHead);
      const speed = el("input", null);
      speed.type = "range";
      speed.min = "1";
      speed.max = "10";
      speed.step = "1";
      speed.value = String(state.autoscroll.speed);
      speed.addEventListener("input", () => {
        state.autoscroll.speed = parseInt(speed.value, 10);
        speedVal.textContent = speed.value;
      });
      speed.addEventListener("change", () => saveScrollSpeed(state.autoscroll.speed));
      speedWrap.appendChild(speed);
      menu.appendChild(speedWrap);

      const stop = el(
        "button",
        "songsheet__btn songsheet__btn--sm songsheet__btn--danger songsheet__fab-stop",
        "Stop autoscroll"
      );
      stop.type = "button";
      stop.addEventListener("click", () => {
        state.autoscroll.on = false;
        stopAutoscroll();
        render();
      });
      menu.appendChild(stop);

      fab.appendChild(menu);
    }
  }

  function currentInstrument() {
    return (window.GuitarApp && window.GuitarApp.getInstrument()) ||
      document.body.dataset.instrument || "guitar";
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function open(song) {
    if (!song || !song.id) {
      close();
      return;
    }
    const inst = currentInstrument();
    // Always start collapsed -- the detail page opens showing just the
    // "Lyrics & chords" bar, above the external Chords/Tabs links.
    state = {
      song,
      inst,
      record: loadSheet(inst, song.id),
      adding: false,
      expanded: false,
      fetching: false,
      fetchError: null,
      confirmRemove: false,
      autoscroll: { on: false, speed: loadScrollSpeed(), menuOpen: false, fabMenuOpen: false },
    };
    root.hidden = false;
    render();
  }

  function close() {
    stopAutoscroll();
    closeScrollMenu();
    state = null;
    panel = null;
    renderFab();
    root.hidden = true;
    root.textContent = "";
  }

  function render() {
    if (!state) {
      renderFab();
      return;
    }
    root.textContent = "";
    panel = null;

    root.appendChild(buildToggle());
    renderFab();
    if (!state.expanded) return;

    panel = el("div", "songsheet__panel");
    root.appendChild(panel);

    if (!state.record) {
      renderEmpty();
    } else if (state.adding) {
      renderEditor(state.record.raw);
    } else {
      renderSheet();
    }
  }

  // The always-visible header: a disclosure button that expands/collapses the
  // panel. When a sheet exists it also shows a small chord count as a nudge
  // to open it.
  function buildToggle() {
    const btn = el("button", "songsheet__toggle");
    btn.type = "button";
    btn.setAttribute("aria-expanded", state.expanded ? "true" : "false");
    btn.appendChild(el("span", "songsheet__toggle-label", "Lyrics & chords"));

    if (state.record) {
      const n = uniqueChords(parseSheet(state.record.raw)).length;
      btn.appendChild(
        el("span", "songsheet__toggle-note", n ? n + (n === 1 ? " chord" : " chords") : "added")
      );
    }

    const chev = el("span", "songsheet__chev");
    chev.setAttribute("aria-hidden", "true");
    chev.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.appendChild(chev);

    btn.addEventListener("click", () => {
      state.expanded = !state.expanded;
      render();
    });
    return btn;
  }

  function renderEmpty() {
    if (state.adding) {
      renderEditor("");
      return;
    }
    panel.appendChild(el("p", "songsheet__sub", "Fetch the chords automatically, or paste a sheet yourself."));

    const row = el("div", "songsheet__actions songsheet__actions--start");
    row.appendChild(fetchButton());
    const paste = el("button", "songsheet__btn", "Paste a sheet");
    paste.type = "button";
    paste.disabled = state.fetching;
    paste.addEventListener("click", () => {
      state.adding = true;
      render();
    });
    row.appendChild(paste);
    panel.appendChild(row);

    renderFetchStatus(panel);
  }

  // Shared "Fetch automatically" button. Disabled while a fetch is in flight
  // or when there's no title to search on.
  function fetchButton() {
    const btn = el(
      "button",
      "songsheet__btn songsheet__btn--primary",
      state.fetching ? "Fetching…" : "Fetch automatically"
    );
    btn.type = "button";
    btn.disabled = state.fetching || !((state.song && state.song.title) || "").trim();
    btn.addEventListener("click", () => doFetch());
    return btn;
  }

  function renderFetchStatus(host) {
    if (state.fetching) {
      host.appendChild(el("p", "songsheet__status", "Looking it up…"));
    } else if (state.fetchError) {
      host.appendChild(el("p", "songsheet__status songsheet__status--error", state.fetchError));
    }
  }

  // A single Ultimate Guitar / e-chords (or other) link pasted into the
  // textarea, with nothing else -- fetched through the same Worker instead
  // of being saved as literal text. This is the recovery path when the
  // artist/title search picks the wrong version, or finds nothing at all:
  // paste the exact page instead.
  function bareUrl(text) {
    const t = text.trim();
    return /^https?:\/\/\S+$/.test(t) ? t : null;
  }

  async function doFetch(url) {
    if (!state || state.fetching) return;
    const songId = state.song.id;
    state.fetching = true;
    state.fetchError = null;
    render();
    let data = null;
    let err = null;
    try {
      const body = url
        ? { url }
        : { artist: (state.song.artist || "").trim(), title: (state.song.title || "").trim() };
      const res = await fetch(FETCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.raw) {
        err = (data && data.error) || "Fetch failed (" + res.status + ").";
      }
    } catch (e) {
      err = navigator.onLine ? "Couldn't reach the fetch service." : "You're offline.";
    }

    // The overlay may have been closed, or moved to another song, while we
    // were waiting.
    if (!state || state.song.id !== songId) return;
    state.fetching = false;

    if (err) {
      if (!/[.!?]$/.test(err)) err += ".";
      state.fetchError = err + " You can still paste a sheet in.";
      state.adding = true; // drop into the editor as the fallback
      render();
      return;
    }

    saveSheet(state.inst, songId, {
      raw: data.raw,
      source: data.source || "fetch",
      transpose: (state.record && state.record.transpose) | 0,
    });
    state.record = loadSheet(state.inst, songId);
    state.adding = false;
    state.fetchError = null;
    render();
  }

  function renderEditor(initial) {
    const form = el("div", "songsheet__editor");

    // Auto-fetch is still offered here -- both as the recovery path after a
    // failed fetch and as an alternative to typing.
    renderFetchStatus(form);
    if (((state.song && state.song.title) || "").trim()) {
      const fr = el("div", "songsheet__actions songsheet__actions--start");
      fr.appendChild(fetchButton());
      form.appendChild(fr);
    }

    const ta = el("textarea", "songsheet__textarea");
    ta.value = initial || "";
    ta.rows = 12;
    ta.spellcheck = false;
    ta.setAttribute("autocapitalize", "none");
    ta.placeholder =
      "[Verse]\n[G]Twinkle twinkle [C]little [G]star\n\n— or —\n\nG                 C     G\nTwinkle twinkle little star\n\n— or paste a link to the chords page (Ultimate Guitar, e-chords, …)";
    form.appendChild(ta);

    const actions = el("div", "songsheet__actions");
    const cancel = el("button", "songsheet__btn", state.record ? "Cancel" : "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.adding = false;
      render();
    });
    const save = el("button", "songsheet__btn songsheet__btn--primary", "Save");
    save.type = "button";
    save.addEventListener("click", () => {
      const raw = ta.value;
      if (!raw.trim()) {
        if (!state.record) {
          state.adding = false;
          render();
        }
        return;
      }
      const url = bareUrl(raw);
      if (url) {
        doFetch(url); // a lone link -- fetch and parse that exact page
        return;
      }
      saveSheet(state.inst, state.song.id, {
        raw,
        source: "paste",
        transpose: (state.record && state.record.transpose) | 0,
      });
      state.record = loadSheet(state.inst, state.song.id);
      state.adding = false;
      render();
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    form.appendChild(actions);
    panel.appendChild(form);
    setTimeout(() => ta.focus(), 30);
  }

  function renderSheet() {
    const model = parseSheet(state.record.raw);
    const semis = state.record.transpose | 0;
    const shown = transposeModel(model, semis);

    /* ---- toolbar: two rows so it doesn't feel like a wall of buttons --
       the primary row (autoscroll, edit) stays put; transpose and remove
       are secondary, so they sit in a quieter row underneath. ---- */
    const bar = el("div", "songsheet__bar");
    const hasLyrics = shown.sections.some((s) =>
      s.lines.some((l) => l && l.lyric && l.lyric.trim())
    );

    const primaryRow = el("div", "songsheet__bar-row");
    if (hasLyrics) primaryRow.appendChild(buildScrollControl());
    if (!state.confirmRemove) {
      const edit = el("button", "songsheet__btn songsheet__btn--sm", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        state.adding = true;
        render();
      });
      primaryRow.appendChild(edit);
    }
    bar.appendChild(primaryRow);

    const secondaryRow = el("div", "songsheet__bar-row songsheet__bar-row--secondary");
    const tp = el("div", "songsheet__transpose");
    const minus = el("button", "songsheet__step", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", "Transpose down");
    const plus = el("button", "songsheet__step", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Transpose up");
    const amount = el("span", "songsheet__transpose-val", semis > 0 ? "+" + semis : String(semis));
    minus.addEventListener("click", () => bumpTranspose(-1));
    plus.addEventListener("click", () => bumpTranspose(1));
    tp.appendChild(minus);
    tp.appendChild(amount);
    tp.appendChild(plus);
    secondaryRow.appendChild(tp);

    if (state.confirmRemove) {
      // Inline confirm instead of window.confirm() -- confirm() dialogs are
      // suppressed in some embedded/preview browser contexts (silently
      // returning false, so the button looked broken), and a two-tap inline
      // control is nicer on a phone anyway.
      const confirmWrap = el("div", "songsheet__confirm");
      confirmWrap.appendChild(el("span", "songsheet__confirm-label", "Remove this sheet?"));
      const yes = el("button", "songsheet__btn songsheet__btn--sm songsheet__btn--danger", "Remove");
      yes.type = "button";
      yes.addEventListener("click", () => {
        deleteSheet(state.inst, state.song.id);
        state.record = null;
        state.confirmRemove = false;
        render();
      });
      const no = el("button", "songsheet__btn songsheet__btn--sm", "Cancel");
      no.type = "button";
      no.addEventListener("click", () => {
        state.confirmRemove = false;
        render();
      });
      confirmWrap.appendChild(yes);
      confirmWrap.appendChild(no);
      secondaryRow.appendChild(confirmWrap);
    } else {
      const clear = el("button", "songsheet__btn songsheet__btn--sm", "Remove");
      clear.type = "button";
      clear.addEventListener("click", () => {
        state.confirmRemove = true;
        render();
      });
      secondaryRow.appendChild(clear);
    }
    bar.appendChild(secondaryRow);
    panel.appendChild(bar);

    if (model.meta.capo) {
      panel.appendChild(el("p", "songsheet__meta", "Capo " + model.meta.capo));
    }

    /* ---- chord chips + a slot for the tapped chord's diagram ---- */
    const chordSyms = uniqueChords(shown);
    if (chordSyms.length) {
      const chips = el("div", "songsheet__chips");
      const card = el("div", "songsheet__chipcard");
      card.hidden = true;
      let openSym = null;
      chordSyms.forEach((sym) => {
        const chip = el("button", "songsheet__chip", sym);
        chip.type = "button";
        chip.addEventListener("click", () => {
          if (openSym === sym) {
            openSym = null;
            card.hidden = true;
            chip.classList.remove("is-active");
            return;
          }
          openSym = sym;
          Array.from(chips.children).forEach((c) => c.classList.remove("is-active"));
          chip.classList.add("is-active");
          card.hidden = false;
          const ok = window.GuitarChords && window.GuitarChords.renderInto
            ? window.GuitarChords.renderInto(card, sym)
            : false;
          if (!ok && !card.textContent) card.textContent = "No diagram for " + sym + ".";
        });
        chips.appendChild(chip);
      });
      panel.appendChild(chips);
      panel.appendChild(card);
    }

    /* ---- the sheet body ---- */
    const body = el("div", "songsheet__body");
    shown.sections.forEach((section) => {
      const sec = el("div", "ss-section");
      if (section.label) sec.appendChild(el("div", "ss-section__label", section.label));
      section.lines.forEach((line) => {
        if (line == null) {
          sec.appendChild(el("div", "ss-break"));
          return;
        }
        sec.appendChild(renderLine(line));
      });
      body.appendChild(sec);
    });
    panel.appendChild(body);

    if (model.chordCount === 0 && model.lineCount > 0) {
      panel.appendChild(
        el(
          "p",
          "songsheet__hint",
          "No chords picked up — put [Am]-style marks in the text, or a line of " +
            "chords directly above each lyric line."
        )
      );
    }
  }

  // The autoscroll button + its popover menu (on/off, tempo). Only ever
  // built when the sheet actually has lyric text to scroll through.
  function buildScrollControl() {
    const wrap = el("div", "songsheet__scroll");

    const btn = el("button", "songsheet__btn songsheet__btn--sm songsheet__scroll-btn", null);
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", state.autoscroll.menuOpen ? "true" : "false");
    if (state.autoscroll.on) btn.classList.add("is-active");
    // Double chevron = "keeps going down on its own", clearer at a glance
    // than a single arrow (which reads as a plain scroll-to-bottom action).
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M6 6l6 6 6-6M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.appendChild(el("span", "songsheet__scroll-btn-label", "Autoscroll"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.autoscroll.menuOpen) {
        closeScrollMenu();
        render();
        return;
      }
      state.autoscroll.menuOpen = true;
      render();
      // Registered after this click has finished bubbling, so the same tap
      // that opened the menu doesn't also close it via the outside handler.
      setTimeout(() => {
        if (!state || !state.autoscroll.menuOpen) return;
        // Matched by class, not by node reference -- render() may have
        // rebuilt the menu (a fresh wrap/btn) by the time this fires.
        scrollOutsideHandler = (ev) => {
          if (!ev.target.closest || !ev.target.closest(".songsheet__scroll")) {
            closeScrollMenu();
            render();
          }
        };
        document.addEventListener("pointerdown", scrollOutsideHandler, true);
      }, 0);
    });
    wrap.appendChild(btn);

    if (state.autoscroll.menuOpen) {
      const menu = el("div", "songsheet__scroll-menu");

      const toggleRow = el("label", "songsheet__scroll-row");
      toggleRow.appendChild(el("span", null, "Autoscroll"));
      const toggle = el("input", "songsheet__scroll-toggle");
      toggle.type = "checkbox";
      toggle.checked = state.autoscroll.on;
      toggle.addEventListener("change", () => {
        state.autoscroll.on = toggle.checked;
        if (state.autoscroll.on) startAutoscroll();
        else stopAutoscroll();
        btn.classList.toggle("is-active", state.autoscroll.on);
        renderFab();
      });
      toggleRow.appendChild(toggle);
      menu.appendChild(toggleRow);

      const speedWrap = el("label", "songsheet__scroll-speed");
      const speedHead = el("div", "songsheet__scroll-speed-head");
      speedHead.appendChild(el("span", null, "Tempo"));
      const speedVal = el("span", "songsheet__scroll-speed-val", String(state.autoscroll.speed));
      speedHead.appendChild(speedVal);
      speedWrap.appendChild(speedHead);
      const speed = el("input", null);
      speed.type = "range";
      speed.min = "1";
      speed.max = "10";
      speed.step = "1";
      speed.value = String(state.autoscroll.speed);
      speed.addEventListener("input", () => {
        state.autoscroll.speed = parseInt(speed.value, 10);
        speedVal.textContent = speed.value;
      });
      speed.addEventListener("change", () => saveScrollSpeed(state.autoscroll.speed));
      speedWrap.appendChild(speed);
      menu.appendChild(speedWrap);

      wrap.appendChild(menu);
    }

    return wrap;
  }

  // Split a lyric string at each chord index; each piece carries the chord
  // that starts it in a block above. `white-space: pre` on the pieces keeps
  // the spacing; the pieces are inline and wrap as whole units.
  function renderLine(line) {
    const wrap = el("div", "ss-line");
    const chords = line.chords.slice().sort((a, b) => a.index - b.index);
    const lyric = line.lyric || "";

    if (!chords.length) {
      const seg = el("span", "ss-seg");
      seg.appendChild(el("span", "ss-seg__chord"));
      seg.appendChild(el("span", "ss-seg__lyric", lyric || " "));
      wrap.appendChild(seg);
      return wrap;
    }

    let cursor = 0;
    if (chords[0].index > 0) {
      const seg = el("span", "ss-seg");
      seg.appendChild(el("span", "ss-seg__chord"));
      seg.appendChild(el("span", "ss-seg__lyric", lyric.slice(0, chords[0].index)));
      wrap.appendChild(seg);
      cursor = chords[0].index;
    }

    chords.forEach((ch, i) => {
      const start = Math.max(cursor, ch.index);
      const end = i + 1 < chords.length ? Math.max(start, chords[i + 1].index) : lyric.length;
      let piece = lyric.slice(start, end);
      if (piece === "") piece = " "; // keep width so the chord has somewhere to sit
      const seg = el("span", "ss-seg");
      const chordEl = el("span", "ss-seg__chord", ch.sym);
      // Reserve trailing space only when the chord label is at least as wide
      // as the syllable under it -- otherwise densely-chorded lines (bar
      // notation like "| G D | Am7 |") get gaps punched mid-word.
      if (ch.sym.length >= Math.max(piece.replace(/\s+$/, "").length, 1)) {
        chordEl.classList.add("ss-seg__chord--pad");
      }
      seg.appendChild(chordEl);
      seg.appendChild(el("span", "ss-seg__lyric", piece));
      wrap.appendChild(seg);
      cursor = end;
    });

    if (cursor < lyric.length) {
      const seg = el("span", "ss-seg");
      seg.appendChild(el("span", "ss-seg__chord"));
      seg.appendChild(el("span", "ss-seg__lyric", lyric.slice(cursor)));
      wrap.appendChild(seg);
    }
    return wrap;
  }

  function bumpTranspose(delta) {
    if (!state || !state.record) return;
    let next = (state.record.transpose | 0) + delta;
    next = ((next % 12) + 12) % 12;
    if (next > 6) next -= 12; // keep it in -5..+6
    saveSheet(state.inst, state.song.id, {
      raw: state.record.raw,
      source: state.record.source,
      transpose: next,
    });
    state.record = loadSheet(state.inst, state.song.id);
    render();
  }

  // library.js drives this: open() when a song detail is shown, close() when
  // it's dismissed or the instrument switches.
  window.GuitarSongSheet = { open, close };
})();
