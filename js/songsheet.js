// Guitar — Song sheet: full lyrics with the chords placed above them, shown
// on the song screen (the detail overlay). The chord strip, the lyrics and the
// bottom transport bar are all filled from here; the song's "..." menu reads
// getActions() for the things you do now and then (edit, sync, play along).
//
// Phase 1 (this file): parse a pasted chord sheet, render it, transpose it,
// see chords in context. No network at all -- the text is whatever
// the user pastes in. Phase 2 adds a "fetch automatically" button: a
// title/artist search comes back as multiple candidates (one Worker request
// per site tried, several sites) shown as a scrollable preview list -- the
// user picks one, nothing is saved automatically -- while a pasted link is
// unambiguous and fetched straight into the sheet. Phase 3 adds autoscroll.
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
  const SHOW_CHORDS_KEY = "guitar-show-chords";

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

  // A line that's mostly lyrics but has a chord-looking word stuck in the
  // middle -- e.g. copy-pasted from a site that positions chords with CSS
  // rather than a real chord line, so the vertical alignment is lost and
  // the chord token just lands in the running text. Lift any such token out
  // as an inline chord at that spot and close the gap to one space, same as
  // between two ordinary words. Bare "A" is skipped -- it's the one chord
  // name that's also a common English word, so it's left as lyric text
  // rather than risk mangling a real line.
  function extractInlineChords(raw) {
    const parts = raw.split(/(\s+)/);
    const chords = [];
    let lyric = "";
    let pendingSpace = false;
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        pendingSpace = true;
        continue;
      }
      if (part !== "A" && isChordToken(part)) {
        chords.push({ sym: part, index: lyric.length });
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && lyric) lyric += " ";
      lyric += part;
      pendingSpace = false;
    }
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

      ensureSection().lines.push(extractInlineChords(raw));
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
     Cleaning a fetched sheet: scraped pages often wrap the actual lyrics in
     song blurbs, wikipedia/site links, credits, strumming notes and ASCII
     chord/tab diagrams (lines of dashes, x's and o's). None of that belongs
     in the viewer -- the sheet should open straight on the intro. Works on
     the raw text (before parsing) and only ever deletes lines, apart from
     turning a plain "Capo 2" line into a {capo: 2} directive.
     ================================================================ */

  const JUNK_LINE_RES = [
    /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|nl)\b/i,
    /wikipedia/i,
    /^\s*\(?\s*(?:tabbed|transcribed|chords?|tabs?|lyrics|arranged|submitted|written|edited|corrected|typed|tuning|album|from)\s+(?:by|from)\b/i,
    /©|\(c\)\s*\d{4}|copyright|all rights reserved|please rate|rate this (?:tab|song|chord)/i,
    /^\s*(?:difficulty|tuning|key|artist|album|song|title|genre|year|rating|author|written by|tempo|bpm|time signature)\s*:\s*\S.{0,60}$/i,
    /^\s*(?:chord (?:diagrams?|chart|legend|shapes?|key|names?)|chords? (?:used|in this song|for this song)|chords?|strumming(?: pattern)?|strum(?:ming)? pattern|rhythm|legend|notes?|n\.?\s?b\.?|tips?|about|info|intro tab|fingerpicking(?: pattern)?)\s*:?\s*$/i,
    /^\s*(?:strumming|strum(?:ming)? pattern|rhythm|pattern|tip|notes?|n\.?\s?b\.?)\s*:\s*\S/i,
  ];
  // Capo info shows up in many wordings: "Capo 2", "Capo: 3rd fret",
  // "capo on 2nd fret", "2nd fret capo", "(Capo II)". "no capo" / "without
  // capo" mean none. Returns the fret number as a string, or null.
  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  function findCapo(line) {
    if (!/\bcapo\b/i.test(line) || /\b(?:no|without|don'?t use(?: a)?)\s+capo\b/i.test(line)) return null;
    let m = line.match(/\bcapo\b\s*(?:[:=\-–]|on|at|@)?\s*(?:the\s+)?(?:fret\s*)?(\d{1,2}|[ivx]{1,4}\b)/i);
    if (!m) m = line.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*fret\s*(?:with\s*)?capo\b/i);
    if (!m) return null;
    const n = /^\d/.test(m[1]) ? +m[1] : ROMAN[m[1].toLowerCase()];
    return n > 0 && n <= 12 ? String(n) : null;
  }

  // ASCII tab / chord-box lines: "e|---0---|", "|--|--|", "x 0 2 2 1 0", "x02210".
  function isDiagramLine(raw) {
    const line = raw.trim();
    if (!line) return false;
    const body = line.replace(/^[A-Ga-g][#b]?\s*[|:]/, "");
    if (
      /^[\s\-|+=_~.:*\/\\<>()^0-9xXoOhHpPbBrRsS]+$/.test(body) &&
      (body.match(/[-|=_]/g) || []).length >= 3
    ) {
      return true;
    }
    return /^[xXoO0-9](?:[\s-]*[xXoO0-9]){3,}$/.test(line) && /[xX0-9]/.test(line);
  }

  function isJunkLine(raw) {
    return isDiagramLine(raw) || JUNK_LINE_RES.some((re) => re.test(raw));
  }

  // Prose: a long sentence with no chords in it (song blurb, disclaimer).
  function isProseLine(raw) {
    const line = raw.trim();
    if (!line || isChordLine(raw) || /\[[^\]]+\]/.test(line)) return false;
    return line.split(/\s+/).length >= 10 && /[.!?:]$/.test(line);
  }

  function cleanSheetText(raw) {
    const text = String(raw || "").replace(/\r\n?/g, "\n");
    let capo = null;
    const hasCapoDirective = /^\s*\{\s*capo\b/im.test(text);
    let lines = [];
    text.split("\n").forEach((ln) => {
      // Capo details are collected from every line -- wherever they hide --
      // before the surrounding junk is thrown away. A short line that is
      // only about the capo is dropped (the chord chips show it instead).
      if (!/^\s*\{[^}]*\}\s*$/.test(ln)) {
        const found = findCapo(ln);
        if (found != null) {
          if (capo == null) capo = found;
          if (ln.length <= 80 && ln.indexOf("[") === -1 && !isChordLine(ln)) return;
        }
      }
      if (/^\s*\{[^}]*\}\s*$/.test(ln)) {
        lines.push(ln);
        return;
      }
      if (!isJunkLine(ln)) lines.push(ln);
    });

    const isDirective = (ln) => /^\s*\{[^}]*\}\s*$/.test(ln);
    const isRealLabel = (ln) => {
      const lab = sectionLabel(ln);
      return lab !== null && !/^\d+$/.test(lab);
    };
    // First line that is unmistakably the sheet itself: a section heading,
    // a line with inline [chords], or a chord line sitting right above a
    // lyric line.
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim() || isDirective(ln)) continue;
      const bracketChord = /\[[^\]]+\]/.test(ln) && sectionLabel(ln) === null && !/^\s*\[[^\]]*\]\s*$/.test(ln);
      const next = lines[i + 1];
      const paired =
        isChordLine(ln) && next != null && next.trim() && !isChordLine(next) &&
        sectionLabel(next) === null && !isDirective(next);
      if (isRealLabel(ln) || bracketChord || paired) {
        start = i;
        break;
      }
    }
    if (start > 0) {
      lines = lines.filter((ln, i) => i >= start || isDirective(ln));
    }

    // Trailing disclaimers / notes.
    while (lines.length && (!lines[lines.length - 1].trim() || isProseLine(lines[lines.length - 1]))) {
      lines.pop();
    }

    if (capo != null && !hasCapoDirective) {
      let at = 0;
      while (at < lines.length && isDirective(lines[at])) at++;
      lines.splice(at, 0, "{capo: " + capo + "}");
    }

    const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "") + "\n";
    // Never hand back a sheet that lost all its content.
    return parseSheet(out).lineCount > 0 ? out : String(raw || "");
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
    store[songId] = {
      raw: rec.raw,
      source: rec.source || "paste",
      transpose: rec.transpose | 0,
      savedAt: Date.now(),
    };
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
  // The fixed-tempo speed is remembered per song (on the song itself, so it
  // rides along with backup and sync like the backing-track link does); the
  // last speed used anywhere is only the starting point for a song that has
  // none yet.
  function songScrollSpeed(song) {
    const v = song && song.scrollSpeed;
    return Number.isInteger(v) && v >= 1 && v <= 10 ? v : loadScrollSpeed();
  }
  function persistScrollSpeed() {
    if (!state) return;
    const level = state.autoscroll.speed;
    saveScrollSpeed(level);
    state.song.scrollSpeed = level;
    if (window.GuitarLibrary && window.GuitarLibrary.setSongField) {
      window.GuitarLibrary.setSongField(state.song.id, { scrollSpeed: level });
    }
  }

  function levelToPxPerSec(level) {
    return level * 8; // 8..80 px/s
  }

  let scrollRAF = null;
  let scrollLastTs = null;
  // Our own float target position, independent of what box.scrollTop
  // reports back -- at low tempos the per-frame delta is well under 1px,
  // and some mobile browsers (notably iOS Safari on a
  // `-webkit-overflow-scrolling: touch` container) silently drop or
  // coarsely round sub-pixel scrollTop writes, so accumulating by reading
  // box.scrollTop back each frame never actually moved anywhere below a
  // certain tempo. scrollPos keeps accumulating regardless of whether a
  // given write "sticks"; scrollWritten is the last whole-pixel value we
  // actually applied, and we only write again once scrollPos has drifted
  // at least 1px past it -- so every write is a real, whole-pixel jump a
  // picky scroll container can't silently ignore.
  let scrollPos = null;
  let scrollWritten = null;

  function scrollContainer() {
    return document.getElementById("detail-scroll") || root.closest(".overlay") || document.scrollingElement || document.documentElement;
  }

  // Forgets the scroll position we were accumulating (and the sub-pixel
  // transform) so the next scroll starts from where the box really is. The
  // frame loop itself (autoscrollTick) keeps running while a sheet is open --
  // it also drives the line highlight and the audio-following scroll.
  function stopAutoscroll() {
    scrollLastTs = null;
    scrollPos = null;
    scrollWritten = null;
    if (panel) panel.style.transform = "";
  }
  function stopLoop() {
    if (scrollRAF != null) cancelAnimationFrame(scrollRAF);
    scrollRAF = null;
    stopAutoscroll();
  }

  // scrollTop can only ever land on a whole pixel, so at a slow tempo (a
  // handful of px/s) it visibly steps once every several frames instead of
  // gliding -- a `translateY` has no such floor. The panel carries the
  // sub-pixel remainder between whole-pixel scrollTop writes (always well
  // under 1px -- writeScroll fires the moment rounding would cross to the
  // next pixel, so the gap it's covering for never grows past half a pixel
  // either side), so motion looks like a smooth 60fps glide on top of
  // scrollTop's coarser but still fully real, drag-compatible position.
  function writeScroll(box, targetY) {
    const rounded = Math.round(targetY);
    if (rounded !== scrollWritten) {
      if (box.scrollTo) box.scrollTo(0, rounded);
      else box.scrollTop = rounded;
      scrollWritten = rounded;
    }
    if (panel) panel.style.transform = "translateY(" + (scrollWritten - targetY) + "px)";
  }

  // Reached the bottom -- stop rather than keep writing scroll positions
  // that can't go anywhere (which jitters the text). Shared by manual and
  // synced pacing.
  function stopIfAtBottom(box, y) {
    if (y < box.scrollHeight - box.clientHeight - 1) return false;
    state.autoscroll.on = false;
    stopAutoscroll();
    render();
    return true;
  }

  function tickManual(box, ts) {
    if (scrollPos == null) {
      scrollPos = box.scrollTop;
      scrollWritten = scrollPos;
    } else if (Math.abs(box.scrollTop - scrollWritten) > 1) {
      // The container moved by more than our own last write -- a manual
      // scroll (drag/wheel) to nudge the position, since nothing else writes
      // to this scroll container while autoscroll owns it. Adopt it as the
      // new base rather than snapping back, so a small correction just
      // shifts where autoscroll continues from, at the same speed.
      scrollPos = box.scrollTop;
      scrollWritten = scrollPos;
    }
    if (scrollLastTs != null) {
      const dt = (ts - scrollLastTs) / 1000;
      scrollPos += levelToPxPerSec(state.autoscroll.speed) * dt;
      writeScroll(box, scrollPos);
      if (stopIfAtBottom(box, scrollPos)) return;
    }
    scrollLastTs = ts;
  }

  function lineElAt(idx) {
    return panel ? panel.querySelector('[data-line-idx="' + idx + '"]') : null;
  }

  // Converts a virtual line position into a scrollTop that puts that line
  // about a third of the way down the visible area -- a comfortable reading
  // spot, same idea as a karaoke prompter keeping the current line clear of
  // the very top edge.
  function virtualLineToScrollTop(box, virtualLine) {
    const f = Math.floor(virtualLine);
    const elF = lineElAt(f);
    if (!elF) return null;
    const boxRect = box.getBoundingClientRect();
    const topF = elF.getBoundingClientRect().top - boxRect.top + box.scrollTop;
    let topC = topF;
    const frac = virtualLine - f;
    if (frac > 0) {
      const elC = lineElAt(f + 1);
      if (elC) topC = elC.getBoundingClientRect().top - boxRect.top + box.scrollTop;
    }
    return topF + (topC - topF) * frac - box.clientHeight * 0.3;
  }

  // The inverse of virtualLineToScrollTop() above -- given where the
  // container is currently scrolled to, which fractional line sits at that
  // same "a third of the way down" reference point. Used to report the
  // host's position for js/jam.js regardless of which of the two
  // autoscroll flavors put it there (synced or fixed-tempo both just move
  // box.scrollTop in the end) without needing tickManual/tickSynced to
  // track it themselves -- called at most once a second, not per frame, so
  // walking every rendered line's getBoundingClientRect() here is fine.
  function scrollTopToVirtualLine(box) {
    const lines = panel ? panel.querySelectorAll("[data-line-idx]") : [];
    if (!lines.length) return 0;
    const boxRect = box.getBoundingClientRect();
    const targetY = box.scrollTop + box.clientHeight * 0.3;
    let best = 0;
    let bestTop = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const top = lines[i].getBoundingClientRect().top - boxRect.top + box.scrollTop;
      if (top <= targetY) {
        best = i;
        bestTop = top;
      } else {
        // bestTop is still -Infinity when even the very first line sits
        // below the target reading position -- a tall header (art + title +
        // chip row) above a short song can easily push line 0 that far down
        // on a roomy viewport. (targetY - -Infinity) / (top - -Infinity) is
        // Infinity/Infinity there, i.e. NaN -- silently breaking every jam
        // follower's scroll sync, since this NaN went out over the wire as
        // pos.line and was never a visible error locally. "Still above the
        // first line" is virtual line 0, same as the no-lines-rendered case
        // above.
        if (bestTop === -Infinity) return 0;
        const frac = (targetY - bestTop) / (top - bestTop);
        return best + Math.max(0, Math.min(1, frac));
      }
    }
    return best;
  }

  // "Mark" a line -- clicking the empty space to the right of a line's own
  // text (not the lyric/chords themselves, see the click handler in
  // renderSheet below) gives it a brief glow: a quick way to point at one
  // line without interrupting playing to say which. Purely a visual pulse,
  // not part of `state` and not re-applied on the next render.
  //
  // flashLine() is the shared, DOM-only half: js/jam.js reuses it to
  // replay the same glow on a follower's own rendered copy of the sheet
  // (a completely separate DOM tree, hence `container` rather than
  // reaching for `panel` here). MARK_FADE_MS must match the
  // .ss-line--mark-fade transition duration in css/style.css.
  const MARK_HOLD_MS = 1400; // full brightness before the fade starts
  const MARK_FADE_MS = 700;

  function flashLine(container, idx) {
    const lineEl = container && container.querySelector('[data-line-idx="' + idx + '"]');
    if (!lineEl) return;
    if (lineEl._markHoldTimer) clearTimeout(lineEl._markHoldTimer);
    if (lineEl._markFadeTimer) clearTimeout(lineEl._markFadeTimer);
    // Drop the fade-transition class before (re-)adding --marked so the
    // jump to full brightness is instant even on a re-mark mid-fade, not
    // eased in from wherever the previous fade had gotten to.
    lineEl.classList.remove("ss-line--mark-fade");
    lineEl.classList.add("ss-line--marked");
    void lineEl.offsetWidth; // force the class removal above to land before the next change
    lineEl.classList.add("ss-line--mark-fade");
    lineEl._markHoldTimer = setTimeout(() => {
      lineEl._markHoldTimer = null;
      lineEl.classList.remove("ss-line--marked");
      lineEl._markFadeTimer = setTimeout(() => {
        lineEl._markFadeTimer = null;
        lineEl.classList.remove("ss-line--mark-fade");
      }, MARK_FADE_MS);
    }, MARK_HOLD_MS);
  }

  // Host-side trigger: flash it locally right away, and hand it to
  // js/jam.js (if it exists and a jam is actually being hosted -- it no-ops
  // otherwise) so every follower's screen flashes the same line too.
  function markLine(idx) {
    flashLine(panel, idx);
    if (window.GuitarJam && window.GuitarJam.hostMarkLine) window.GuitarJam.hostMarkLine(idx);
  }

  // A snapshot of "what the host is currently looking at", polled by
  // js/jam.js roughly once a second while hosting a jam -- null when
  // there's no open sheet with lyrics to follow. pos.line is a fractional
  // index into the flat line list (same units scrollTopToVirtualLine/
  // virtualLineToScrollTop use), not a pixel or scrollHeight fraction --
  // that's what makes it portable to a follower's screen, which can have a
  // completely different line-wrap layout (width, font size, ...) for the
  // exact same text.
  function getJamSnapshot() {
    if (!state || !state.record || !sheetHasLyrics(state.record.raw)) return null;
    const snapshot = {
      song: {
        title: (state.song && state.song.title) || "",
        artist: (state.song && state.song.artist) || "",
        art: (state.song && state.song.artworkUrl) || null,
      },
      sheet: { raw: state.record.raw, transpose: state.record.transpose | 0 },
      mode: "none",
      pos: { line: null, index: null },
    };
    if (state.playAlong.on) {
      snapshot.mode = "playalong";
      snapshot.pos.index = state.playAlong.index;
    } else if (panel) {
      const active = getActivePlayback();
      if (active && active.playing && followsAudio()) {
        // Following the recording: followers get the line that is lit.
        snapshot.mode = "timestamps";
        snapshot.pos.line = state.timing.nowLine >= 0 ? state.timing.nowLine : null;
      } else if (state.autoscroll.on) {
        snapshot.mode = "autoscroll";
        snapshot.pos.line = scrollTopToVirtualLine(scrollContainer());
      }
    }
    // Deliberately NOT reporting a position when autoscroll is off, even
    // though the host may well be scrolling by hand -- a follower's own
    // scroll-follow toggle is meant to track the host's autoscroll on/off
    // state one-to-one (js/jam.js applyFollowerScroll), so it should go
    // dark the instant the host stops autoscroll, not stay lit because of
    // manual scrolling underneath.
    return snapshot;
  }

  /* ---- The frame loop ---------------------------------------------------------
     Runs while a sheet is open. Every frame: notice a newly loaded recording
     (starts the LRCLIB lookup), and then either follow the recording -- the
     line that is about to be sung is highlighted and eased into view -- or,
     as the fallback, scroll at the fixed tempo while that is switched on. ---- */
  let nowEls = [];
  let userScrollUntil = 0; // after the user scrolls by hand, leave the view alone for a moment
  let lastNowIdx = -2;
  let settling = false;
  let wasFollowing = false;
  let transportSig = "";
  let scrollListening = false;

  // Lights the current line plus any lines after it that have no timing of
  // their own (up to the next timed line, or the end of the section): a
  // lyric written as two short lines that LRCLIB times as one sentence is
  // sung in one go, so both light up together. `endIdx` is the first line
  // that must NOT light up (the next anchor's line), or -1 for "no limit".
  function applyNowHighlight(idx, endIdx) {
    const targets = [];
    const first = idx >= 0 && panel ? lineElAt(idx) : null;
    if (first) {
      targets.push(first);
      for (let i = idx + 1; endIdx < 0 || i < endIdx; i++) {
        const el = lineElAt(i);
        if (!el || el.parentElement !== first.parentElement) break;
        targets.push(el);
      }
    }
    if (
      targets.length === nowEls.length &&
      targets.every((t, i) => t === nowEls[i] && t.classList.contains("ss-line--now"))
    ) return;
    nowEls.forEach((el) => el.classList.remove("ss-line--now", "ss-line--now-cont", "ss-line--now-more"));
    nowEls = targets;
    targets.forEach((t, i) => {
      void t.offsetWidth; // restart the little flash
      t.classList.add("ss-line--now");
      // Lines in one group share a single block: the lower ones drop their
      // top glow and the upper ones their rounded bottom, so nothing overlaps.
      if (i > 0) t.classList.add("ss-line--now-cont");
      if (i < targets.length - 1) t.classList.add("ss-line--now-more");
    });
  }

  function markUserScroll() {
    userScrollUntil = performance.now() + 4000;
    scrollPos = null;
    scrollWritten = null;
  }

  function autoscrollTick(ts) {
    scrollRAF = requestAnimationFrame(autoscrollTick);
    if (!state || !state.expanded || !state.record || state.adding || state.candidates) {
      scrollLastTs = null;
      return;
    }
    const box = scrollContainer();
    const active = getActivePlayback();
    updateTimingFor(active);
    const T = state.timing;
    const following = !!(active && T && !state.autoscroll.forceManual && timingReady());
    const now = performance.now();
    const dt = scrollLastTs != null ? Math.min(0.1, (ts - scrollLastTs) / 1000) : 0;

    if (following) {
      const cur = AS.currentLine(T.anchors, active.ms - T.offsetMs + leadMs);
      const idx = cur.at < 0 ? -1 : cur.line;
      T.nowLine = idx;
      let endIdx = -1;
      for (let k = cur.at + 1; cur.at >= 0 && k < T.anchors.length; k++) {
        if (T.anchors[k].line > idx) { endIdx = T.anchors[k].line; break; }
      }
      applyNowHighlight(idx, endIdx);
      if (!wasFollowing) {
        scrollPos = null;
        scrollWritten = null;
      }
      if (now < userScrollUntil) {
        scrollPos = null;
        scrollWritten = null;
      } else if (active.playing || idx !== lastNowIdx || settling) {
        let y = virtualLineToScrollTop(box, idx < 0 ? 0 : idx);
        if (y != null) {
          y = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, y));
          if (scrollPos == null) {
            scrollPos = box.scrollTop;
            scrollWritten = scrollPos;
          }
          scrollPos += (y - scrollPos) * (dt ? 1 - Math.exp(-dt * 6) : 1);
          writeScroll(box, scrollPos);
          settling = Math.abs(y - scrollPos) > 1;
        }
      }
      lastNowIdx = idx;
      scrollLastTs = ts;
    } else {
      if (wasFollowing) stopAutoscroll();
      if (T) T.nowLine = -1;
      applyNowHighlight(-1);
      lastNowIdx = -2;
      settling = false;
      if (state.autoscroll.on) tickManual(box, ts);
      else scrollLastTs = null;
    }
    wasFollowing = following;

    // the transport bar follows what the recording does
    const sig = [audioLoaded() ? 1 : 0, active && active.playing ? 1 : 0, T ? T.status : "-", state.autoscroll.on ? 1 : 0, state.autoscroll.forceManual ? 1 : 0, following ? 1 : 0].join();
    if (sig !== transportSig) {
      transportSig = sig;
      renderTransport();
    }
  }

  // Starts the frame loop (once per open sheet) and listens for the user
  // scrolling by hand, which pauses the following for a few seconds.
  function startLoop() {
    if (scrollRAF == null) scrollRAF = requestAnimationFrame(autoscrollTick);
    if (!scrollListening) {
      const box = scrollContainer();
      ["wheel", "touchstart", "touchmove"].forEach((ev) => box.addEventListener(ev, markUserScroll, { passive: true }));
      scrollListening = true;
    }
  }
  // Switches fixed-tempo scrolling on from a clean start.
  function startAutoscroll() {
    scrollLastTs = null;
    scrollPos = null;
    scrollWritten = null;
    startLoop();
  }

  /* ---- Automatic timing -----------------------------------------------------
     When a recording (Spotify / YouTube) is loaded in the audio bar, the song's
     lyric timing comes from LRCLIB (js/autosync.js): look the song up by
     artist + title + the recording's length, take the version that fits, and
     match its lines to this sheet's lines. The result is a list of anchors
     { ms, line, h } -- h is a short hash of the line, never its text -- kept
     on this device only, per song and recording (TIMING_KEY), together with
     the offset the user last set for that recording.
     While the recording plays the sheet follows it: the line that is about to
     be sung is highlighted (`leadMs` before it starts, and it stays put
     through instrumental parts) and the view scrolls to it. Fixed-tempo
     autoscroll is the fallback when there is no recording, no timing found,
     or the user asks for it. ---- */

  const AS = window.AutoSync;
  const TIMING_KEY = "guitar-autotiming";
  const LEAD_KEY = "guitar-autosync-lead";
  let leadMs = (function () {
    try {
      const v = parseInt(localStorage.getItem(LEAD_KEY), 10);
      return v >= 0 && v <= 3000 ? v : 1000;
    } catch (e) {
      return 1000;
    }
  })();

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* quota -- the timing is simply looked up again next time */
    }
  }

  function freshTiming(key) {
    return {
      key,
      status: "idle", // idle -> looking -> synced | warn | none | error
      note: "",
      error: "",
      ranked: [],
      index: 0,
      cand: null,
      map: null,
      anchors: [],
      offsetMs: 0,
      touched: false,
      dismissed: false,
      stored: null,
      durMs: 0,
      durDiff: 0,
      nowLine: -1,
      t0: performance.now(),
    };
  }

  // Normalized lyric text of every line, in the same flat numbering the
  // rendered lines (data-line-idx) and the anchors use.
  function sheetLineNorms() {
    if (!state || !state.record) return [];
    if (state.normsRaw !== state.record.raw) {
      const out = [];
      parseSheet(state.record.raw).sections.forEach((section) =>
        section.lines.forEach((line) => {
          if (line != null) out.push(AS.norm(line.lyric));
        })
      );
      state.norms = out;
      state.normsRaw = state.record.raw;
    }
    return state.norms;
  }

  // The recording that is loaded in the audio bar, with its live position.
  function getActivePlayback() {
    const dock = window.GuitarAudioDock;
    if (!dock) return null;
    if (dock.isNowPlaying("spotify") && window.GuitarSpotify && window.GuitarSpotify.getPosition) {
      const S = window.GuitarSpotify;
      const key = S.getSourceKey && S.getSourceKey();
      const ms = S.getPosition();
      if (key && ms != null) return { key, ms, dur: S.getDuration(), playing: S.isPlaying() };
    }
    if (dock.isNowPlaying("backingtrack") && window.GuitarBackingTrack && window.GuitarBackingTrack.getPosition) {
      const B = window.GuitarBackingTrack;
      const key = B.getSourceKey && B.getSourceKey();
      const ms = B.getPosition();
      if (key && ms != null) return { key, ms, dur: B.getDuration(), playing: B.isPlaying() };
    }
    return null;
  }

  // Skips the recording to where line `idx` is sung -- the moment that line
  // lights up (its anchor, shifted by the user's offset and the highlight's
  // lead), so playing on from there starts just before it. Lines without a
  // timestamp of their own belong to the closest anchor above them; lines
  // before the first anchor (an intro) go to the start. Does nothing without
  // a loaded recording that has timing. In a jam only the host's screen ever
  // gets here (followers' lines have no handler), and followers pick the new
  // position up through the usual snapshot.
  function seekToLine(idx) {
    const T = state && state.timing;
    const active = getActivePlayback();
    if (!active || !T || !timingReady()) return;
    let ms = 0;
    for (let k = T.anchors.length - 1; k >= 0; k--) {
      if (T.anchors[k].line <= idx) {
        ms = Math.max(0, T.anchors[k].ms + T.offsetMs - leadMs + 50);
        break;
      }
    }
    const src = window.GuitarAudioDock && window.GuitarAudioDock.isNowPlaying("spotify") ? window.GuitarSpotify : window.GuitarBackingTrack;
    if (!src || !src.seekTo) return;
    src.seekTo(ms);
    // The tap's touchstart counted as "scrolling by hand" -- but this one
    // should carry the view along straight away.
    userScrollUntil = 0;
    scrollPos = null;
    scrollWritten = null;
    settling = true;
  }

  // Whether a recording is loaded in the audio bar -- from the moment it is
  // cued, not only once it has a playback position.
  function audioLoaded() {
    const dock = window.GuitarAudioDock;
    return !!(dock && (dock.isNowPlaying("spotify") || dock.isNowPlaying("backingtrack")));
  }
  function timingReady() {
    const T = state && state.timing;
    return !!(T && (T.status === "synced" || T.status === "warn") && T.anchors.length >= 2);
  }
  // Could this song follow the audio right now (timing found)?
  function hasSyncAvailable() {
    return !!(state && audioLoaded() && timingReady());
  }
  // Is it following (the user has not chosen fixed tempo)?
  function followsAudio() {
    return hasSyncAvailable() && !state.autoscroll.forceManual;
  }
  // Is the play button meant to drive the recording -- timing found, or still
  // being looked up?
  function playDrivesAudio() {
    const T = state && state.timing;
    return !!(state && audioLoaded() && !state.autoscroll.forceManual && T && (T.status === "looking" || T.status === "idle" || timingReady()));
  }

  function timingKey() {
    return state.song.id + "|" + state.timing.key;
  }
  function loadStoredTiming(norms) {
    const st = lsGet(TIMING_KEY, {})[timingKey()];
    if (!st || !Array.isArray(st.a) || st.a.length < 2) return null;
    let bad = 0;
    st.a.forEach((a) => {
      if (!norms[a[1]] || AS.hashLine(norms[a[1]]) !== a[2]) bad++;
    });
    return bad > st.a.length * 0.2 ? null : st; // the sheet changed under it
  }
  function persistTiming() {
    const T = state && state.timing;
    if (!T || !T.anchors.length) return;
    const all = lsGet(TIMING_KEY, {});
    const c = T.cand;
    all[timingKey()] = {
      a: T.anchors.map((a) => [a.ms, a.line, a.h]),
      off: T.offsetMs,
      touched: T.touched,
      diff: T.durDiff,
      lrc: c ? { artist: c.artistName, name: c.trackName, duration: c.duration } : (T.stored && T.stored.lrc) || null,
      stats: T.map ? { pct: T.map.pct, coverage: T.map.coverage, jumps: T.map.jumps, lrcLines: T.map.lrcLines } : (T.stored && T.stored.stats) || null,
      at: Date.now(),
    };
    const keys = Object.keys(all);
    if (keys.length > 80) keys.sort((x, y) => all[x].at - all[y].at).slice(0, keys.length - 80).forEach((k) => delete all[k]);
    lsSet(TIMING_KEY, all);
  }

  // Called every frame with whatever is loaded in the audio bar: starts the
  // lookup when a new recording shows up (once its length is known), and
  // forgets the timing when the recording goes away.
  function updateTimingFor(active) {
    if (!active) {
      if (state.timing) {
        state.timing = null;
        state.calibrating = false;
        renderTiming();
        renderTransport();
      }
      return;
    }
    let T = state.timing;
    if (!T || T.key !== active.key) {
      T = state.timing = freshTiming(active.key);
      state.calibrating = false;
      renderTransport();
    }
    if (T.status === "idle" && (active.dur > 0 || performance.now() - T.t0 > 3000)) {
      T.durMs = active.dur || 0;
      startLookup(false);
    }
  }

  async function startLookup(force) {
    const mine = state;
    const T = state.timing;
    const song = state.song;
    const norms = sheetLineNorms();
    if (!norms.some(Boolean)) {
      T.status = "none";
      T.note = "nosheet";
      renderTiming();
      return;
    }
    if (!force) {
      const st = loadStoredTiming(norms);
      if (st) {
        T.anchors = st.a.map((a) => ({ ms: a[0], line: a[1], h: a[2] }));
        T.offsetMs = st.off || 0;
        T.touched = !!st.touched;
        T.durDiff = st.diff || 0;
        T.stored = st;
        afterChoice();
        return;
      }
    }
    T.status = "looking";
    T.stored = null;
    renderTiming();
    renderTransport();
    let cands;
    try {
      cands = await AS.lookup(song.artist, song.title);
    } catch (e) {
      if (state !== mine || state.timing !== T) return;
      T.status = "error";
      T.error = String((e && e.message) || e);
      renderTiming();
      renderTransport();
      return;
    }
    if (state !== mine || state.timing !== T) return;
    if (!cands.length) {
      T.status = "none";
      T.note = "notfound";
      renderTiming();
      renderTransport();
      return;
    }
    T.ranked = AS.rank(cands, T.durMs / 1000);
    applyChoice(AS.choose(T.ranked, norms, 0, 3));
  }

  // The sheet's lines were renumbered or reworded: the anchors no longer
  // belong to it, so the next frame looks the recording up again.
  function sheetChanged() {
    if (!state) return;
    state.timing = null;
    state.calibrating = false;
    state.normsRaw = null;
  }

  function applyChoice(choice) {
    const T = state.timing;
    if (!choice || choice.map.pct < 0.5) {
      // Too little of the lyrics matches: probably another song or another language.
      T.status = "none";
      T.note = "mismatch";
      T.map = choice ? choice.map : null;
      renderTiming();
      renderTransport();
      return;
    }
    T.index = choice.index;
    T.cand = choice.cand;
    T.map = choice.map;
    T.anchors = choice.map.anchors;
    T.stored = null;
    T.durDiff = T.durMs && choice.cand.duration ? T.durMs / 1000 - choice.cand.duration : 0;
    afterChoice();
  }

  function afterChoice() {
    const T = state.timing;
    T.status = Math.abs(T.durDiff) > 2 && !T.touched ? "warn" : "synced";
    persistTiming();
    // The recording is not the length of the version LRCLIB has: ask right
    // away which line is being sung, instead of making the user dig for it.
    if (T.status === "warn" && !T.dismissed && !state.calibrating) {
      state.calibrating = true;
      render();
    }
    renderTiming();
    renderTransport();
  }

  function setOffset(ms) {
    const T = state.timing;
    if (!T) return;
    T.offsetMs = Math.max(-60000, Math.min(60000, Math.round(ms / 10) * 10));
    T.touched = true;
    if (T.status === "warn") T.status = "synced";
    persistTiming();
    renderTiming();
    renderTransport();
  }

  // Quick fix: the user taps the line that is being sung right now.
  function setCalibrating(on) {
    if (!state || state.calibrating === on) return;
    state.calibrating = on;
    const T = state.timing;
    if (!on && T) {
      T.dismissed = true;
      if (T.status === "warn") {
        // "It's fine": the timing is accepted as it is, so the warning goes away for good.
        T.touched = true;
        T.status = "synced";
        persistTiming();
      }
    }
    render();
  }
  function calibrateTo(idx) {
    const T = state.timing;
    const active = getActivePlayback();
    if (!T || !active) return;
    const now = active.ms - T.offsetMs;
    let best = null;
    T.anchors.forEach((a) => {
      if (a.line === idx && (!best || Math.abs(a.ms - now) < Math.abs(best.ms - now))) best = a;
    });
    if (!best) {
      T.hint = "That line has no timing. Tap a line next to it.";
      renderTiming();
      return;
    }
    T.hint = "";
    state.calibrating = false;
    setOffset(active.ms - (best.ms + 700)); // about 0.7 s to react
    render();
  }

  function fmtMmss(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function fmtSigned(ms) {
    const v = ms / 1000;
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2).replace(/0$/, "") + " s";
  }

  /* ---- The timing pill under the title, and the quick-fix banner ---- */
  const PILL = {
    looking: { cls: "is-looking", icon: "", text: "Looking up timing…" },
    synced: { cls: "", icon: "✓", text: "Synced" },
    warn: { cls: "is-warn", icon: "!", text: "Timing may be off" },
    none: { cls: "is-none", icon: "–", text: "No timing found · fixed tempo" },
    error: { cls: "is-error", icon: "!", text: "Couldn't reach LRCLIB · tap to retry" },
  };
  function renderTiming() {
    const host = document.getElementById("detail-timing");
    if (!host) return;
    host.textContent = "";
    host.classList.remove("is-band");
    const T = state && state.timing;
    if (!T || T.status === "idle" || !state.record || state.adding) {
      host.hidden = true;
      return;
    }
    // A working timing needs no pill: it only shows while looking up, when the
    // timing may be off, or when nothing was found. Fixing it by hand is in
    // the ... menu (Timing).
    if (T.status === "synced" && !state.calibrating) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    // "May be off" and the tap prompt belong together: the whole box turns yellow.
    const band = T.status === "warn" && state.calibrating;
    host.classList.toggle("is-band", band);
    const P = PILL[T.status] || PILL.none;
    let text = P.text;
    if (T.status === "synced" && T.offsetMs) text += " · " + fmtSigned(T.offsetMs);
    if (T.status === "none" && T.note === "mismatch") text = "Lyrics don't match LRCLIB · fixed tempo";
    const pill = el("button", "sync-pill " + P.cls + (band ? " on-band" : ""));
    pill.type = "button";
    pill.appendChild(el("i", null, P.icon));
    pill.appendChild(el("span", null, text));
    pill.setAttribute("aria-label", text);
    pill.addEventListener("click", () => {
      if (T.status === "error") startLookup(true);
      else if (T.status === "warn") setCalibrating(!state.calibrating);
      else openTiming();
    });
    if (T.status !== "synced") host.appendChild(pill);
    if (state.calibrating) {
      const banner = el("div", "sync-fix");
      banner.appendChild(
        el("span", null, (T.status === "warn" ? "Timing may be off. " : "") + "Tap the line you hear right now.")
      );
      const done = el("button", "songsheet__btn songsheet__btn--sm", T.status === "warn" ? "It's fine" : "Cancel");
      done.type = "button";
      done.addEventListener("click", () => setCalibrating(false));
      banner.appendChild(done);
      host.appendChild(banner);
      if (T.hint) host.appendChild(el("p", "sync-fix__hint", T.hint));
    }
  }

  /* ---- The Timing sheet (⋯ menu): the details behind the pill ---- */
  function openTiming() {
    if (!state || !state.timing) return;
    const UI = window.GuitarUI;
    UI.openSheet({
      title: "Timing",
      render(body, api) {
        const T = state.timing;
        const box = el("div", "timing-sheet");
        body.appendChild(box);
        const src = el("p", "t-source");
        const label = {
          looking: "Looking up…",
          synced: "Synced",
          warn: "Timing may be off",
          none: T.note === "mismatch" ? "The lyrics don't match" : "Not found at LRCLIB",
          error: "LRCLIB unreachable",
          idle: "",
        }[T.status];
        src.appendChild(el("b", null, label));
        const info = el("small");
        const lrc = T.cand ? { artist: T.cand.artistName, name: T.cand.trackName, duration: T.cand.duration } : T.stored && T.stored.lrc;
        const st = T.map || (T.stored && T.stored.stats);
        const parts = [];
        if (lrc) parts.push("LRCLIB: " + lrc.artist + " – " + lrc.name + " (" + fmtMmss(lrc.duration) + ")");
        if (T.durMs) parts.push("this recording " + fmtMmss(T.durMs / 1000));
        if (st) parts.push(Math.round(st.pct * 100) + "% of its lines matched this sheet");
        if (T.ranked.length) parts.push("version " + (T.index + 1) + " of " + T.ranked.length);
        info.textContent = parts.join(" · ");
        src.appendChild(info);
        box.appendChild(src);

        if (timingReady()) {
          box.appendChild(
            UI.stepperRow("Timing offset", "Lyrics later (+) or earlier (−)", (v) => fmtSigned(v), (d) => {
              if (d) setOffset(T.offsetMs + d * 250);
              return T.offsetMs;
            })
          );
          box.appendChild(
            UI.stepperRow("Highlight ahead", "How early the next line lights up", (v) => (v / 1000).toFixed(1) + " s", (d) => {
              if (d) {
                leadMs = Math.max(0, Math.min(3000, leadMs + d * 500));
                try {
                  localStorage.setItem(LEAD_KEY, String(leadMs));
                } catch (e) {
                  /* just not remembered */
                }
              }
              return leadMs;
            })
          );
          const acts = el("div", "t-actions");
          const tap = el("button", "songsheet__btn songsheet__btn--sm", "Tap the line you hear");
          tap.type = "button";
          tap.addEventListener("click", () => {
            api.close();
            setCalibrating(true);
          });
          acts.appendChild(tap);
          if (T.ranked.length > 1) {
            const next = el("button", "songsheet__btn songsheet__btn--sm", "Try next version");
            next.type = "button";
            next.addEventListener("click", () => {
              api.close();
              T.touched = false;
              applyChoice(AS.choose(T.ranked, sheetLineNorms(), (T.index + 1) % T.ranked.length, 1));
            });
            acts.appendChild(next);
          }
          box.appendChild(acts);
        }
        const acts2 = el("div", "t-actions");
        const again = el("button", "songsheet__btn songsheet__btn--sm", "Look up again");
        again.type = "button";
        again.addEventListener("click", () => {
          api.close();
          T.dismissed = false;
          startLookup(true);
        });
        acts2.appendChild(again);
        box.appendChild(acts2);
        if (st) {
          const det = el("details");
          det.appendChild(el("summary", null, "Details"));
          const pre = el("pre");
          pre.textContent = [
            "anchors: " + T.anchors.length,
            "LRC lines: " + st.lrcLines + ", sheet coverage: " + Math.round(st.coverage * 100) + "%, jumps back: " + st.jumps,
            "duration difference: " + (T.durDiff || 0).toFixed(1) + " s",
            T.stored ? "loaded from this device (no lookup)" : "fresh lookup",
          ].join("\n");
          det.appendChild(pre);
          box.appendChild(det);
        }
        box.appendChild(el("p", "t-credit", "Timing data: LRCLIB (lrclib.net). Only times are kept on this device, never the lyrics."));
      },
    });
  }

  /* ---- Play along --------------------------------------------------------
     Listens to the mic (js/chorddetect.js) and moves a marker through the
     song's own chord progression as you actually play it -- no backing
     track, no timestamps, entirely separate from sync mode/autoscroll
     above. Mutually exclusive with sync mode (both repurpose tapping a
     line) and with autoscroll (both move things while you're trying to
     read); entering one turns the others off, same precedent sync mode
     already sets for autoscroll. ---- */

  // Flattens the chord progression into ordered "steps" for play-along,
  // one per written chord. Each step remembers its occurrence (line +
  // position within that line), so it can be highlighted while current --
  // see the stepKey lookup in renderLine().
  function buildChordSteps(shown) {
    const steps = [];
    let lineIdx = 0;
    shown.sections.forEach((section) => {
      section.lines.forEach((line) => {
        if (line == null) return;
        line.chords
          .slice()
          .sort((a, b) => a.index - b.index)
          .filter((c) => /^[A-G]/.test(c.sym.trim()))
          .forEach((c, order) => {
            // One step per written chord, repeats included -- "Em Em Em"
            // means three plays, and the detector needs each of them to be
            // played (see js/chorddetect.js's re-attack handling).
            steps.push({ sym: c.sym, occurrences: [{ lineIdx, order }] });
          });
        lineIdx += 1;
      });
    });
    return steps;
  }

  function stopPlayAlong() {
    if (!state) return;
    if (state.playAlong.detector) state.playAlong.detector.stop();
    state.playAlong.on = false;
    state.playAlong.detector = null;
    state.playAlong.steps = null;
    state.playAlong.index = 0;
    state.playAlong.error = null;
  }

  // Keeps the live play-along chord roughly mid-screen so the last few
  // chords stay visible above it (for when the detector runs ahead) and the
  // next ones below. Driven purely by which chord step we're on -- fully
  // independent of autoscroll/timestamps. Runs after render() (which
  // rebuilds the chord elements) so the highlight class is already applied.
  function centerPlayAlongChord() {
    if (!state || !state.playAlong.on || !panel) return;
    const chordEl = panel.querySelector(".ss-seg__chord--playalong");
    if (!chordEl) return;
    const box = scrollContainer();
    const boxRect = box.getBoundingClientRect();
    const r = chordEl.getBoundingClientRect();
    const y = box.scrollTop + (r.top - boxRect.top) + r.height / 2 - box.clientHeight / 2;
    const top = Math.max(0, Math.round(y));
    if (box.scrollTo) box.scrollTo({ top, behavior: "smooth" });
    else box.scrollTop = top;
  }

  async function startPlayAlong() {
    const model = parseSheet(state.record.raw);
    const shown = transposeModel(model, state.record.transpose | 0);
    const steps = buildChordSteps(shown);
    if (!steps.length) return;

    if (state.autoscroll.on) {
      state.autoscroll.on = false;
      stopAutoscroll();
    }

    state.playAlong.steps = steps;
    state.playAlong.index = 0;
    state.playAlong.error = null;
    state.playAlong.on = true; // optimistic -- render() shows "listening…" while getUserMedia resolves
    render();
    centerPlayAlongChord();

    if (!window.PlayAlongEngine) {
      state.playAlong.on = false;
      state.playAlong.error = "Play along isn't available.";
      render();
      return;
    }
    try {
      const detector = new window.PlayAlongEngine.PlayAlongDetector(steps.map((s) => s.sym));
      state.playAlong.detector = detector;
      await detector.start((newIndex) => {
        if (!state || !state.playAlong.on || state.playAlong.detector !== detector) return;
        state.playAlong.index = newIndex;
        render();
        centerPlayAlongChord();
      });
    } catch (err) {
      console.error("Play along mic error:", err);
      state.playAlong.on = false;
      state.playAlong.detector = null;
      state.playAlong.error = "Couldn't access the microphone.";
      render();
    }
  }

  function togglePlayAlong() {
    if (state.playAlong.on) {
      stopPlayAlong();
      render();
    } else {
      startPlayAlong();
    }
  }

  // Manual override for whenever the detector guesses wrong or gets stuck
  // -- tapping a lyric line jumps to wherever you'd naturally continue
  // from there: the first chord that starts on that exact line, if it has
  // one, so a line with several chord changes on it (a chorus opener like
  // "C G D") lands you on the first of those, not the last; otherwise the
  // most recent chord established by an earlier line. No separate
  // next/previous controls needed.
  function jumpPlayAlongTo(lineIdx) {
    if (!state.playAlong.on || !state.playAlong.steps) return;
    const steps = state.playAlong.steps;
    let target = 0;
    let onThisLine = -1;
    for (let i = 0; i < steps.length; i++) {
      if (onThisLine === -1 && steps[i].occurrences.some((o) => o.lineIdx === lineIdx)) onThisLine = i;
      if (steps[i].occurrences[0].lineIdx <= lineIdx) target = i;
    }
    if (onThisLine !== -1) target = onThisLine;
    if (state.playAlong.detector) state.playAlong.detector.jumpTo(target);
    state.playAlong.index = target;
    render();
    centerPlayAlongChord();
  }

  /* ---- Transport bar --------------------------------------------------
     The one bar at the bottom of the song screen (#song-transport): a round
     play button, a pace area, a button for the audio sources (Spotify /
     YouTube -- js/audiodock.js puts their list and the now-playing bar in the
     same container) and "Aa" for the display sheet.
     Play normally means "play the song's recording and let the sheet follow
     it": it starts the recording when none is loaded, and plays or pauses it
     once there is one. Only when there is no recording, no timing was found,
     or "Fixed tempo" was picked, play scrolls at a fixed speed instead (the
     slider in the pace area). ---- */

  let transportRow = null;
  let transportAudioBtn = null;

  // Transpose-invariant, so it's fine to check straight off the stored raw
  // text without re-parsing through transposeModel.
  function sheetHasLyrics(raw) {
    return parseSheet(raw).sections.some((s) =>
      s.lines.some((l) => l && l.lyric && l.lyric.trim())
    );
  }

  function showChordsPref() {
    try {
      return localStorage.getItem(SHOW_CHORDS_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }
  function saveShowChords(on) {
    try {
      localStorage.setItem(SHOW_CHORDS_KEY, on ? "1" : "0");
    } catch (e) {
      /* fine to just not remember it */
    }
  }

  const ICON_PLAY =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="7" y="5.5" width="4" height="13" rx="1" fill="currentColor"/><rect x="14" y="5.5" width="4" height="13" rx="1" fill="currentColor"/></svg>';
  const ICON_NOTE =
    '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';

  // Which recording the play button starts when none is loaded yet: the
  // song's Spotify track (or any, once logged in to Spotify), else its
  // YouTube link, else nothing (the play button then scrolls at a fixed tempo).
  function autoSource() {
    const song = state && state.song;
    if (!song) return null;
    const sp = window.GuitarSpotify;
    if (sp && (song.spotifyTrackId || (sp.isLoggedIn && sp.isLoggedIn()))) return "spotify";
    if (song.backingTrackUrl && window.GuitarBackingTrack) return "backingtrack";
    return null;
  }

  function togglePlayback() {
    const dock = window.GuitarAudioDock;
    if (dock && dock.isNowPlaying("spotify") && window.GuitarSpotify) window.GuitarSpotify.togglePlay();
    else if (dock && dock.isNowPlaying("backingtrack") && window.GuitarBackingTrack) window.GuitarBackingTrack.togglePlay();
  }

  function renderTransport() {
    const host = document.getElementById("song-transport");
    if (!host) return;
    const show = !!(state && state.record && !state.adding && sheetHasLyrics(state.record.raw));
    if (!show) {
      host.hidden = true;
      if (transportRow) transportRow.textContent = "";
      return;
    }
    host.hidden = false;
    if (!transportRow) {
      transportRow = el("div", "transport__row");
      host.appendChild(transportRow);
    }
    transportRow.textContent = "";

    const T = state.timing;
    const drivesAudio = playDrivesAudio(); // play = the recording, the sheet follows it
    const follows = followsAudio();
    const active = getActivePlayback();
    const playing = drivesAudio ? !!(active && active.playing) : state.autoscroll.on;
    const play = el("button", "transport__play" + (playing ? " is-on" : "") + (playing && follows ? " is-synced" : ""));
    play.type = "button";
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    play.setAttribute("aria-pressed", playing ? "true" : "false");
    play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    play.addEventListener("click", (e) => {
      e.stopPropagation();
      if (drivesAudio) {
        togglePlayback();
        return;
      }
      if (!audioLoaded() && !state.autoscroll.on) {
        // Nothing loaded yet: start the song's own recording; the sheet follows it.
        const src = autoSource();
        if (src) {
          if (src === "backingtrack") window.GuitarBackingTrack.playWhenReady();
          if (window.GuitarAudioDock && window.GuitarAudioDock.startSource(src)) return;
        }
      }
      // Fallback: scroll at a fixed tempo.
      if (state.autoscroll.on) {
        state.autoscroll.on = false;
        stopAutoscroll();
      } else {
        state.autoscroll.on = true;
        startAutoscroll();
      }
      renderTransport();
    });
    transportRow.appendChild(play);

    const pace = el("div", "transport__pace");
    const canFollow = hasSyncAvailable();
    // Small text switch between the two modes, only when both are possible.
    const modeLink = (label, forceManual) => {
      const b = el("button", "transport__mode", label);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        state.autoscroll.forceManual = forceManual;
        if (forceManual) state.autoscroll.on = false;
        stopAutoscroll();
        renderTransport();
      });
      return b;
    };
    if (follows) {
      const head = el("div", "transport__pace-head");
      head.appendChild(el("span", "transport__pace-label transport__pace-label--synced", "Follows the audio"));
      head.appendChild(modeLink("Fixed tempo", true));
      pace.appendChild(head);
    } else if (drivesAudio) {
      // The recording is loaded and its timing is still being looked up.
      const head = el("div", "transport__pace-head");
      head.appendChild(el("span", "transport__pace-label", "Looking up timing…"));
      pace.appendChild(head);
    } else {
      const head = el("div", "transport__pace-head");
      let label = "Scroll speed";
      if (canFollow) label = "Fixed tempo";
      else if (audioLoaded() && T && (T.status === "none" || T.status === "error")) label = "Fixed tempo · no timing";
      head.appendChild(el("span", "transport__pace-label", label));
      if (canFollow) head.appendChild(modeLink("Follow audio", false));
      else if (audioLoaded() && T && (T.status === "none" || T.status === "error") && T.note !== "nosheet") {
        const retry = el("button", "transport__mode", "Try again");
        retry.type = "button";
        retry.addEventListener("click", (e) => {
          e.stopPropagation();
          T.dismissed = false;
          startLookup(true);
        });
        head.appendChild(retry);
      }
      const val = el("span", "transport__pace-val", String(state.autoscroll.speed));
      head.appendChild(val);
      pace.appendChild(head);
      const speed = el("input", "transport__slider");
      speed.type = "range";
      speed.min = "1";
      speed.max = "10";
      speed.step = "1";
      speed.value = String(state.autoscroll.speed);
      speed.setAttribute("aria-label", "Scroll speed");
      speed.addEventListener("input", () => {
        state.autoscroll.speed = parseInt(speed.value, 10);
        val.textContent = speed.value;
      });
      speed.addEventListener("change", persistScrollSpeed);
      pace.appendChild(speed);
    }
    transportRow.appendChild(pace);

    const audio = el("button", "transport__btn");
    audio.type = "button";
    audio.setAttribute("aria-label", "Audio");
    audio.innerHTML = ICON_NOTE;
    audio.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.GuitarAudioDock) window.GuitarAudioDock.toggleSources();
    });
    transportAudioBtn = audio;
    syncAudioButton();
    transportRow.appendChild(audio);

    const display = el("button", "transport__btn transport__btn--text", "Aa");
    display.type = "button";
    display.setAttribute("aria-label", "Display");
    display.addEventListener("click", (e) => {
      e.stopPropagation();
      openDisplaySheet();
    });
    transportRow.appendChild(display);
  }

  function syncAudioButton() {
    if (!transportAudioBtn) return;
    const on = !!(window.GuitarAudioDock && window.GuitarAudioDock.isActive());
    transportAudioBtn.classList.toggle("is-on", on);
    transportAudioBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  // A recording being loaded (or dropped) can change what the scroll follows,
  // so the whole bar is redrawn, not just the ♪ button.
  document.addEventListener("audiodockpanelchange", () => renderTransport());

  /* ---- Display sheet: key, chords on/off, scroll mode --------------------
     Everything that changes how the sheet reads, in one place instead of
     spread over the song screen. ---- */
  function openDisplaySheet() {
    if (!state || !state.record) return;
    const UI = window.GuitarUI;
    UI.openSheet({
      title: "Display",
      render(body) {
        const model = parseSheet(state.record.raw);
        const key = (model.meta.key || "").trim();
        body.appendChild(
          UI.stepperRow(
            "Key",
            key ? "Original key " + key : "Semitones up or down",
            (v) => (v > 0 ? "+" + v : v < 0 ? "−" + Math.abs(v) : "0"),
            (delta) => {
              if (delta) bumpTranspose(delta);
              return state.record.transpose | 0;
            }
          )
        );
        body.appendChild(
          UI.switchRow("Show chords", "Off leaves just the lyrics", showChordsPref(), (on) => {
            saveShowChords(on);
            render();
          })
        );

        const head = el("h3", "ui-sheet__sub", "Scrolling");
        body.appendChild(head);
        if (hasSyncAvailable()) {
          const seg = el("div", "seg");
          seg.setAttribute("role", "group");
          seg.setAttribute("aria-label", "Scroll mode");
          [
            { label: "Follow audio", forceManual: false },
            { label: "Fixed tempo", forceManual: true },
          ].forEach(({ label, forceManual }) => {
            const b = el("button", "seg__btn", label);
            b.type = "button";
            b.setAttribute("aria-pressed", !!state.autoscroll.forceManual === forceManual ? "true" : "false");
            b.addEventListener("click", () => {
              state.autoscroll.forceManual = forceManual;
              Array.from(seg.children).forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
              renderTransport();
            });
            seg.appendChild(b);
          });
          body.appendChild(seg);
        }
        const wrap = el("label", "ui-row ui-row--range");
        const top = el("div", "ui-row__text");
        top.appendChild(el("span", null, "Fixed tempo speed (this song)"));
        const val = el("b", null, String(state.autoscroll.speed));
        top.appendChild(val);
        wrap.appendChild(top);
        const speed = el("input", "transport__slider");
        speed.type = "range";
        speed.min = "1";
        speed.max = "10";
        speed.step = "1";
        speed.value = String(state.autoscroll.speed);
        speed.addEventListener("input", () => {
          state.autoscroll.speed = parseInt(speed.value, 10);
          val.textContent = speed.value;
        });
        speed.addEventListener("change", () => {
          persistScrollSpeed();
          renderTransport();
        });
        wrap.appendChild(speed);
        body.appendChild(wrap);
      },
    });
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

  function open(song, opts) {
    if (!song || !song.id) {
      close();
      return;
    }
    const inst = currentInstrument();
    // The sheet is simply there -- no collapsed state any more.
    state = {
      song,
      inst,
      record: loadSheet(inst, song.id),
      adding: false,
      expanded: true,
      fetching: false,
      fetchError: null,
      candidates: null, // search results awaiting a pick, or null
      confirmRemove: false,
      timing: null, // automatic timing of the recording that is loaded, see updateTimingFor()
      calibrating: false, // "tap the line you hear" quick fix is armed
      norms: [],
      normsRaw: null,
      autoscroll: { on: false, speed: songScrollSpeed(song), forceManual: false },
      playAlong: { on: false, index: 0, steps: null, detector: null, error: null },
    };
    migrateFetchedSheet();
    root.hidden = false;
    render();
    startLoop();
  }

  // Sheets fetched before cleanSheetText() existed still carry their junk --
  // clean them once on open (pasted sheets are the user's own text and are
  // left alone).
  function migrateFetchedSheet() {
    const rec = state.record;
    if (!rec || rec.source === "paste") return;
    const cleaned = cleanSheetText(rec.raw);
    if (cleaned === rec.raw) return;
    saveSheet(state.inst, state.song.id, { raw: cleaned, source: rec.source, transpose: rec.transpose });
    state.record = loadSheet(state.inst, state.song.id);
  }

  function close() {
    stopLoop();
    applyNowHighlight(-1);
    stopPlayAlong();
    state = null;
    panel = null;
    nowEls = [];
    renderTiming();
    clearChordStrip();
    renderTransport();
    dispatchExpandEvent();
    root.hidden = true;
    root.textContent = "";
  }

  // js/audiodock.js (the Spotify + backing-track pill) and js/library.js
  // (hiding Chords/Tabs + the metronome button) both react to this -- fired
  // from render() so it also catches a sheet going from empty to having
  // lyrics while already expanded, not just the expand/collapse toggle
  // itself.
  function dispatchExpandEvent() {
    document.dispatchEvent(
      new CustomEvent("songsheetexpand", {
        detail: {
          expanded: !!(state && state.expanded),
          song: state ? state.song : null,
          inst: state ? state.inst : null,
          hasSheet: !!(state && state.record),
          hasLyrics: !!(state && state.record && sheetHasLyrics(state.record.raw)),
        },
      })
    );
  }

  function render() {
    if (!state) {
      clearChordStrip();
      renderTransport();
      dispatchExpandEvent();
      return;
    }
    root.textContent = "";
    panel = null;
    nowEls = []; // the lines are rebuilt below; the loop re-applies the highlight
    root.classList.toggle("songsheet--nochords", !showChordsPref());

    panel = el("div", "songsheet__panel");
    root.appendChild(panel);

    // Any chord strip belongs to a rendered sheet only -- renderSheet() fills
    // it again below.
    clearChordStrip();
    if (state.candidates) {
      renderCandidatePicker();
    } else if (!state.record) {
      renderEmpty();
    } else if (state.adding) {
      renderEditor(state.record.raw);
    } else {
      renderSheet();
    }
    renderTransport();
    renderTiming();
    dispatchExpandEvent();
  }

  function renderEmpty() {
    if (state.adding) {
      renderEditor("");
      return;
    }
    panel.appendChild(el("p", "songsheet__sub", "No sheet for this song yet. Fetch the chords automatically, or paste one yourself."));

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

  function candidateSourceLabel(name) {
    if (name === "ultimate-guitar") return "Ultimate Guitar";
    if (name === "cifraclub") return "Cifra Club";
    if (name === "e-chords") return "e-chords";
    return name || "";
  }

  // The first handful of lines worth showing in a candidate card -- skips
  // the {title:}/{artist:}/{key:} directive header (already shown above the
  // preview) and any leading blank lines so the little scroll space isn't
  // wasted repeating what the card head already says.
  function candidatePreviewLines(raw, n) {
    const lines = String(raw || "")
      .split("\n")
      .filter((ln) => !/^\{[a-z]+:.*\}$/i.test(ln.trim()));
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.slice(0, n).join("\n");
  }

  // After a title/artist fetch: every candidate the Worker found (already
  // scraped in full -- see server/src/worker.js's fetchCandidates()), each
  // with its own short scrollable preview, so a wrong auto-picked match
  // never silently lands in the sheet -- the user picks the right one, or
  // bails out to paste instead.
  function renderCandidatePicker() {
    const n = state.candidates.length;
    panel.appendChild(
      el(
        "p",
        "songsheet__sub",
        "Found " + n + (n === 1 ? " match" : " matches") + " — scroll to compare, then pick one."
      )
    );

    const list = el("div", "songsheet__candidates");
    state.candidates.forEach((cand) => {
      const meta = cand.meta || {};
      const card = el("div", "songsheet__candidate");

      const head = el("div", "songsheet__candidate-head");
      head.appendChild(
        el("span", "songsheet__candidate-title", meta.title || state.song.title || "Untitled")
      );
      if (meta.artist) head.appendChild(el("span", "songsheet__candidate-artist", meta.artist));
      head.appendChild(el("span", "songsheet__candidate-source", candidateSourceLabel(cand.source)));
      card.appendChild(head);

      card.appendChild(el("pre", "songsheet__candidate-preview", candidatePreviewLines(cand.raw, 8)));

      const use = el("button", "songsheet__btn songsheet__btn--primary songsheet__btn--sm", "Use this");
      use.type = "button";
      use.addEventListener("click", () => pickCandidate(cand));
      card.appendChild(use);

      list.appendChild(card);
    });
    panel.appendChild(list);

    const actions = el("div", "songsheet__actions songsheet__actions--start");
    const cancel = el("button", "songsheet__btn", state.record ? "Keep my current sheet" : "None of these — paste a sheet");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.candidates = null;
      state.adding = !state.record;
      render();
    });
    actions.appendChild(cancel);
    panel.appendChild(actions);
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

  // A pasted url() names one exact page, so it's fetched and saved straight
  // away -- no ambiguity to preview. A title/artist search can't know which
  // hit is right, so its result is a list of candidates: parked in
  // state.candidates for renderCandidatePicker() to show, nothing saved
  // until the user taps one (applyFetchedSheet/pickCandidate below).
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
      const ok = url ? !!(data && data.raw) : !!(data && Array.isArray(data.candidates) && data.candidates.length);
      if (!res.ok || !ok) {
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

    if (url) {
      applyFetchedSheet({ raw: data.raw, source: data.source || "fetch" });
      return;
    }

    state.candidates = data.candidates;
    render();
  }

  // Shared by the url() fetch above and pickCandidate() below -- both end
  // with the same text ready to save.
  function applyFetchedSheet(rec) {
    const songId = state.song.id;
    rec = { ...rec, raw: cleanSheetText(rec.raw) };
    saveSheet(state.inst, songId, {
      raw: rec.raw,
      source: rec.source || "fetch",
      transpose: (state.record && state.record.transpose) | 0,
    });
    state.record = loadSheet(state.inst, songId);
    sheetChanged();
    state.adding = false;
    state.candidates = null;
    state.fetchError = null;
    render();
  }

  function pickCandidate(cand) {
    if (!state || !cand) return;
    applyFetchedSheet({ raw: cand.raw, source: cand.source || "fetch" });
  }

  function renderEditor(initial) {
    const form = el("div", "songsheet__editor");

    // Auto-fetch is still offered here -- both as the recovery path after a
    // failed fetch and as an alternative to typing. Remove lives here too
    // now (not on the normal sheet view) -- it's a rare, destructive action
    // that only makes sense once you're already in "editing this sheet"
    // mode, so it no longer has to compete for space with Edit/Sync/Play
    // along on every visit.
    renderFetchStatus(form);
    const hasTitle = ((state.song && state.song.title) || "").trim() !== "";
    if (hasTitle || state.record) {
      const fr = el("div", "songsheet__actions songsheet__actions--start");
      if (state.confirmRemove) {
        const confirmWrap = el("div", "songsheet__confirm");
        confirmWrap.appendChild(el("span", "songsheet__confirm-label", "Remove this sheet?"));
        const yes = el("button", "songsheet__btn songsheet__btn--sm songsheet__btn--danger", "Remove");
        yes.type = "button";
        yes.addEventListener("click", () => {
          deleteSheet(state.inst, state.song.id);
          state.record = null;
          state.confirmRemove = false;
          state.adding = false;
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
        fr.appendChild(confirmWrap);
      } else {
        if (hasTitle) fr.appendChild(fetchButton());
        if (state.record) {
          const remove = el("button", "songsheet__btn songsheet__btn--sm songsheet__btn--danger", "Remove");
          remove.type = "button";
          remove.addEventListener("click", () => {
            state.confirmRemove = true;
            render();
          });
          fr.appendChild(remove);
        }
      }
      form.appendChild(fr);
    }

    const ta = el("textarea", "songsheet__textarea");
    ta.value = initial || "";
    ta.rows = 12;
    ta.spellcheck = false;
    ta.setAttribute("autocapitalize", "none");
    ta.placeholder =
      "[Verse]\n[G]Twinkle twinkle [C]little [G]star\n\n— or —\n\nG                 C     G\nTwinkle twinkle little star\n\n— or paste a link to the chords page (Ultimate Guitar, Cifra Club, e-chords, …)";
    form.appendChild(ta);

    const actions = el("div", "songsheet__actions");
    const cancel = el("button", "songsheet__btn", state.record ? "Cancel" : "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.adding = false;
      state.confirmRemove = false;
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
      sheetChanged();
      state.adding = false;
      render();
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    form.appendChild(actions);
    panel.appendChild(form);
    setTimeout(() => ta.focus(), 30);
  }

  /* ---- Chord strip -------------------------------------------------------
     Every chord in the song as a row of chips pinned under the top bar
     (#detail-chordstrip), plus the capo. Tapping one opens its diagram in
     #detail-chordcard right below the strip. ---- */
  function chordStripEl() {
    return document.getElementById("detail-chordstrip");
  }
  function chordCardEl() {
    return document.getElementById("detail-chordcard");
  }
  function clearChordStrip() {
    const strip = chordStripEl();
    const card = chordCardEl();
    if (strip) {
      strip.hidden = true;
      strip.textContent = "";
    }
    if (card) {
      card.hidden = true;
      card.textContent = "";
    }
  }

  function renderChordStrip(model, chordSyms) {
    const strip = chordStripEl();
    const card = chordCardEl();
    if (!strip || !card) return;
    strip.textContent = "";
    card.hidden = true;
    card.textContent = "";
    const capo = model.meta.capo;
    if ((!chordSyms.length && !capo) || !showChordsPref()) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;

    let openSym = null;
    let swapMode = false;

    function renderCard() {
      card.textContent = "";
      if (!openSym) {
        card.hidden = true;
        return;
      }
      card.hidden = false;
      const head = el("div", "songsheet__chipcard-head");
      if (swapMode) {
        const back = el("button", "songsheet__chip-swap", null);
        back.type = "button";
        back.setAttribute("aria-label", "Cancel swap");
        back.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        back.addEventListener("click", (e) => {
          e.stopPropagation();
          swapMode = false;
          renderCard();
        });
        head.appendChild(back);
        head.appendChild(el("span", "songsheet__chipcard-title", "Swap " + openSym + " for…"));
        card.appendChild(head);

        const pickerHost = el("div", "songsheet__swap-picker");
        card.appendChild(pickerHost);
        if (window.GuitarChords && window.GuitarChords.renderSwapPicker) {
          window.GuitarChords.renderSwapPicker(pickerHost, openSym, (newSym) => {
            swapChord(openSym, newSym);
          });
        }
      } else {
        const swap = el("button", "songsheet__chip-swap", null);
        swap.type = "button";
        swap.title = "Swap this chord";
        swap.setAttribute("aria-label", "Swap this chord");
        swap.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7h13l-3-3M20 17H7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        swap.addEventListener("click", (e) => {
          e.stopPropagation();
          swapMode = true;
          renderCard();
        });
        head.appendChild(swap);
        card.appendChild(head);

        const inner = el("div", "songsheet__chipcard-inner");
        card.appendChild(inner);
        const ok = window.GuitarChords && window.GuitarChords.renderInto
          ? window.GuitarChords.renderInto(inner, openSym)
          : false;
        if (!ok && !inner.textContent) inner.textContent = "No diagram for " + openSym + ".";
      }
    }

    chordSyms.forEach((sym) => {
      const chip = el("button", "songsheet__chip", sym);
      chip.type = "button";
      chip.addEventListener("click", () => {
        const wasOpen = openSym === sym;
        openSym = wasOpen ? null : sym;
        swapMode = false;
        Array.from(strip.querySelectorAll(".songsheet__chip")).forEach((c) => c.classList.remove("is-active"));
        if (!wasOpen) chip.classList.add("is-active");
        renderCard();
      });
      strip.appendChild(chip);
    });
    if (capo) strip.appendChild(el("span", "songsheet__chips-capo", "Capo " + capo));
  }

  function renderSheet() {
    const model = parseSheet(state.record.raw);
    const semis = state.record.transpose | 0;
    const shown = transposeModel(model, semis);

    // Only the two temporary modes get a bar of their own -- placing sync
    // timestamps and play along. Everything else lives in the transport bar
    // (autoscroll, audio, display) or the song's "..." menu (edit, find
    // another sheet), so a plain sheet starts straight with the lyrics.
    renderFetchStatus(panel);
    if (state.playAlong.on) {
      const bar = el("div", "songsheet__bar");
      const row = el("div", "songsheet__bar-row");
      const stop = el("button", "songsheet__btn songsheet__btn--primary songsheet__btn--sm", "Stop play along");
      stop.type = "button";
      stop.addEventListener("click", () => togglePlayAlong());
      row.appendChild(stop);
      bar.appendChild(row);
      panel.appendChild(bar);
    }

    const chordSyms = uniqueChords(shown);
    renderChordStrip(model, chordSyms);

    if (state.playAlong.on) {
      panel.appendChild(
        el(
          "p",
          "songsheet__sub",
          "Listening — play the highlighted chord to move on. Tap a line to jump there yourself."
        )
      );
    }
    if (state.playAlong.error) {
      panel.appendChild(el("p", "songsheet__status songsheet__status--error", state.playAlong.error));
    }

    /* ---- the sheet body ---- */
    const body = el("div", "songsheet__body");
    let flatLineIdx = 0;
    // The set of "lineIdx:order" chord occurrences belonging to whichever
    // step play-along is currently on -- see buildChordSteps() and the
    // stepKey lookup in renderLine().
    let playAlongKeys = null;
    if (state.playAlong.on && state.playAlong.steps) {
      const step = state.playAlong.steps[state.playAlong.index];
      if (step) playAlongKeys = new Set(step.occurrences.map((o) => o.lineIdx + ":" + o.order));
    }
    shown.sections.forEach((section) => {
      const sec = el("div", "ss-section");
      if (section.label) sec.appendChild(el("div", "ss-section__label", section.label));
      section.lines.forEach((line) => {
        if (line == null) {
          sec.appendChild(el("div", "ss-break"));
          return;
        }
        const idx = flatLineIdx++;
        const lineEl = renderLine(line, idx, playAlongKeys);
        lineEl.dataset.lineIdx = String(idx);
        if (state.playAlong.on) {
          lineEl.classList.add("ss-line--syncable");
          lineEl.addEventListener("click", (e) => {
            e.stopPropagation();
            jumpPlayAlongTo(idx);
          });
        }
        if (state.calibrating) {
          // Quick fix: a tap anywhere on the line says "this is the line I hear".
          lineEl.classList.add("ss-line--syncable");
          lineEl.addEventListener("click", (e) => {
            e.stopPropagation();
            calibrateTo(idx);
          });
        }
        if (!state.calibrating && !state.playAlong.on) {
          // A tap on the text skips the recording to that line (seekToLine,
          // only while a recording with timing is loaded); the empty space
          // right of the line's own content (e.target is the wrap itself
          // there, never one of its .ss-seg children) still just marks it.
          lineEl.addEventListener("click", (e) => {
            if (e.target === lineEl) markLine(idx);
            else seekToLine(idx);
          });
        }
        sec.appendChild(lineEl);
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

  // Split a lyric string at each chord index; each piece carries the chord
  // that starts it in a block above. `white-space: pre` on the pieces keeps
  // the spacing; the pieces are inline and wrap as whole units. `lineIdx`
  // + `playAlongKeys` (a Set of "lineIdx:order" strings, or null when play
  // along isn't on) are only used to mark whichever chord occurrence is
  // the currently-live play-along step -- see buildChordSteps(). Chords are
  // plain text: a tap on a line is handled by the line itself (seekToLine).
  function renderLine(line, lineIdx, playAlongKeys) {
    const wrap = el("div", "ss-line");
    const chords = line.chords.slice().sort((a, b) => a.index - b.index);
    const lyric = line.lyric || "";
    let realOrder = 0;

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
      // Real chord symbols only -- bar lines / "N.C." / repeat marks stay
      // plain text, same filter as the chip row's uniqueChords().
      const isRealChord = /^[A-G]/.test(ch.sym.trim());
      if (isRealChord) {
        if (playAlongKeys && playAlongKeys.has(lineIdx + ":" + realOrder)) {
          chordEl.classList.add("ss-seg__chord--playalong");
        }
        realOrder += 1;
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

  /* ---- Chord swap -- replace every occurrence of one chord with another --
     Triggered from the chip card's "swap" button (renderSheet below). Works
     against the RAW stored text, not the rendered model, so the change
     survives a transpose and a re-open. `oldSym`/`newSym` are both as
     currently DISPLAYED (i.e. already transposed) -- collectRawSymsFor()
     maps that back to whatever literal token(s) actually appear in the raw
     text for that chord, and the new symbol is transposed backward by the
     current offset before being written in, so it lands on the same pitch
     the user picked once the existing transpose is re-applied on render
     (see transposeSym -- shiftNote always re-derives a note purely from its
     semitone index, so the exact spelling written to raw is invisible once
     forward-transposed again; irrelevant when transpose is 0, which is the
     common case and needs no round-trip at all). ---- */

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Every literal raw chord token whose transposed form equals `displayedSym`
  // -- usually exactly one, but a hand-typed sheet could spell the same
  // chord two different ways in different spots.
  function collectRawSymsFor(model, shown, displayedSym) {
    const out = new Set();
    model.sections.forEach((s, si) => {
      s.lines.forEach((l, li) => {
        if (!l) return;
        const shownLine = shown.sections[si].lines[li];
        l.chords.forEach((c, ci) => {
          if (shownLine.chords[ci].sym === displayedSym) out.add(c.sym);
        });
      });
    });
    return out;
  }

  // Replaces one exact chord token throughout the raw text: a ChordPro
  // "[Am]" bracket (any line), or a bare token on a line the parser itself
  // would recognise as a chord line (isChordLine) -- never inside plain
  // lyric text, so a lyric that happens to contain the same letters (e.g.
  // the word "am") is left alone.
  function replaceChordInRaw(raw, oldSym, newSym) {
    if (!oldSym || oldSym === newSym) return raw;
    const oldEsc = escapeRegExp(oldSym);
    let out = raw.replace(new RegExp("\\[" + oldEsc + "\\]", "g"), "[" + newSym + "]");
    const tokenRe = new RegExp("(^|\\s)" + oldEsc + "(?=\\s|$)", "g");
    out = out
      .split("\n")
      .map((line) => (isChordLine(line) ? line.replace(tokenRe, "$1" + newSym) : line))
      .join("\n");
    return out;
  }

  function swapChord(oldDisplayedSym, newDisplayedSym) {
    if (!state || !state.record || !newDisplayedSym || oldDisplayedSym === newDisplayedSym) return;
    const model = parseSheet(state.record.raw);
    const semis = state.record.transpose | 0;
    const shown = transposeModel(model, semis);
    const rawSyms = collectRawSymsFor(model, shown, oldDisplayedSym);
    if (!rawSyms.size) return;
    const preferFlat = FLAT_KEYS.has((model.meta.key || "").trim()) || semis < 0;
    const newRawSym = semis ? transposeSym(newDisplayedSym, -semis, preferFlat) : newDisplayedSym;
    let raw = state.record.raw;
    rawSyms.forEach((oldRawSym) => {
      raw = replaceChordInRaw(raw, oldRawSym, newRawSym);
    });
    saveSheet(state.inst, state.song.id, { raw, source: state.record.source, transpose: semis });
    state.record = loadSheet(state.inst, state.song.id);
    render();
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
  // js/jam.js (host side) reads getJamSnapshot() to know what to broadcast;
  // (follower side) reuses parseSheet/transposeModel/renderLine/
  // buildChordSteps/uniqueChords to render a received sheet exactly the way
  // this file renders the host's own, without duplicating that logic.
  // What the song's "..." menu (js/library.js) offers for the open sheet.
  function getActions() {
    const has = !!(state && state.record);
    const lyrics = has && sheetHasLyrics(state.record.raw);
    return {
      hasSheet: has,
      hasLyrics: !!lyrics,
      hasChords: has && uniqueChords(parseSheet(state.record.raw)).length > 0,
      hasTiming: !!(state && state.timing && state.timing.status !== "idle"),
      playAlongOn: !!(state && state.playAlong.on),
      edit() {
        if (!state) return;
        stopPlayAlong();
        state.calibrating = false;
        state.adding = true;
        render();
      },
      openTiming,
      togglePlayAlong() {
        if (state && state.record) togglePlayAlong();
      },
      fetchNew() {
        if (state) doFetch();
      },
    };
  }

  window.GuitarSongSheet = {
    getActions,
    open,
    close,
    getJamSnapshot,
    parseSheet,
    transposeModel,
    renderLine,
    buildChordSteps,
    uniqueChords,
    flashLine,
  };
})();
