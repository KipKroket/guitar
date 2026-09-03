// Guitar — Chord book
// A small offline reference: pick a root note and a chord type, see how to
// play it. Guitar mode draws a fretboard diagram; piano mode draws a
// keyboard with the chord tones lit up. No network, no database file --
// guitar shapes are a curated table plus movable barre shapes, piano is
// derived straight from the intervals.

(function () {
  const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  // suffix: what to append to the root for the chord name.
  // intervals: semitones above the root (also the piano note set).
  const QUALITIES = [
    { key: "maj",  label: "maj",  suffix: "",     intervals: [0, 4, 7] },
    { key: "min",  label: "min",  suffix: "m",    intervals: [0, 3, 7] },
    { key: "7",    label: "7",    suffix: "7",    intervals: [0, 4, 7, 10] },
    { key: "m7",   label: "m7",   suffix: "m7",   intervals: [0, 3, 7, 10] },
    { key: "maj7", label: "maj7", suffix: "maj7", intervals: [0, 4, 7, 11] },
    { key: "sus4", label: "sus4", suffix: "sus4", intervals: [0, 5, 7] },
    { key: "sus2", label: "sus2", suffix: "sus2", intervals: [0, 2, 7] },
    { key: "dim",  label: "dim",  suffix: "dim",  intervals: [0, 3, 6] },
    { key: "aug",  label: "aug",  suffix: "aug",  intervals: [0, 4, 8] },
  ];

  /* ---------------- Guitar shapes ----------------
     Fret arrays run string 6 -> string 1 (low E on the left, as on a real
     chord chart). Values: 0 = open, -1 = muted, n = fret n. */

  // The nice open-position voicings. Everything not here falls back to a
  // movable barre shape.
  const OPEN_SHAPES = {
    "C maj":  [-1, 3, 2, 0, 1, 0],
    "C 7":    [-1, 3, 2, 3, 1, 0],
    "C maj7": [-1, 3, 2, 0, 0, 0],
    "D maj":  [-1, -1, 0, 2, 3, 2],
    "D min":  [-1, -1, 0, 2, 3, 1],
    "D 7":    [-1, -1, 0, 2, 1, 2],
    "D m7":   [-1, -1, 0, 2, 1, 1],
    "D maj7": [-1, -1, 0, 2, 2, 2],
    "D sus2": [-1, -1, 0, 2, 3, 0],
    "D sus4": [-1, -1, 0, 2, 3, 3],
    "E maj":  [0, 2, 2, 1, 0, 0],
    "E min":  [0, 2, 2, 0, 0, 0],
    "E 7":    [0, 2, 0, 1, 0, 0],
    "E m7":   [0, 2, 0, 0, 0, 0],
    "E maj7": [0, 2, 1, 1, 0, 0],
    "E sus4": [0, 2, 2, 2, 0, 0],
    "F maj7": [-1, -1, 3, 2, 1, 0],
    "G maj":  [3, 2, 0, 0, 0, 3],
    "G 7":    [3, 2, 0, 0, 0, 1],
    "G maj7": [3, 2, 0, 0, 0, 2],
    "A maj":  [-1, 0, 2, 2, 2, 0],
    "A min":  [-1, 0, 2, 2, 1, 0],
    "A 7":    [-1, 0, 2, 0, 2, 0],
    "A m7":   [-1, 0, 2, 0, 1, 0],
    "A maj7": [-1, 0, 2, 1, 2, 0],
    "A sus2": [-1, 0, 2, 2, 0, 0],
    "A sus4": [-1, 0, 2, 2, 3, 0],
    "B 7":    [-1, 2, 1, 2, 0, 2],
  };

  // Movable barre shapes, given as fret offsets from the barre fret B.
  // "E" shapes are rooted on string 6 (open-string note E, pitch class 4);
  // "A" shapes on string 5 (note A, pitch class 9). "x" = muted.
  const MOVABLE = {
    E: {
      maj:  [0, 2, 2, 1, 0, 0],
      min:  [0, 2, 2, 0, 0, 0],
      "7":  [0, 2, 0, 1, 0, 0],
      m7:   [0, 2, 0, 0, 0, 0],
      maj7: [0, 2, 1, 1, 0, 0],
      sus4: [0, 2, 2, 2, 0, 0],
      aug:  [0, 3, 2, 1, 1, 0],
    },
    A: {
      maj:  ["x", 0, 2, 2, 2, 0],
      min:  ["x", 0, 2, 2, 1, 0],
      "7":  ["x", 0, 2, 0, 2, 0],
      m7:   ["x", 0, 2, 0, 1, 0],
      maj7: ["x", 0, 2, 1, 2, 0],
      sus4: ["x", 0, 2, 2, 3, 0],
      sus2: ["x", 0, 2, 2, 0, 0],
      dim:  ["x", 0, 1, 2, 1, "x"],
      aug:  ["x", 0, 3, 2, 2, "x"],
    },
  };

  // Returns { frets:[6..1], baseFret, label, barreFret } or null.
  function guitarShape(rootIdx, quality) {
    const name = NOTES[rootIdx] + " " + quality.key;
    if (OPEN_SHAPES[name]) {
      return finishShape(OPEN_SHAPES[name].slice(), "Open position");
    }
    // Movable: try both anchor strings, take the lower (easier) fret. b === 0
    // only comes up when the root is the open-string note itself (E or A),
    // and then the template already is the open voicing.
    const options = [];
    if (MOVABLE.E[quality.key]) {
      options.push({ b: ((rootIdx - 4) % 12 + 12) % 12, tpl: MOVABLE.E[quality.key], shape: "E-shape" });
    }
    if (MOVABLE.A[quality.key]) {
      options.push({ b: ((rootIdx - 9) % 12 + 12) % 12, tpl: MOVABLE.A[quality.key], shape: "A-shape" });
    }
    if (!options.length) return null;
    options.sort((x, y) => x.b - y.b);
    const pick = options[0];
    const frets = pick.tpl.map((v) => (v === "x" ? -1 : pick.b + v));
    if (pick.b === 0) return finishShape(frets, "Open position");
    return finishShape(frets, "Barre — " + ordinal(pick.b) + " fret (" + pick.shape + ")", pick.b);
  }

  function finishShape(frets, label, barreFret) {
    const positives = frets.filter((f) => f > 0);
    const hasOpen = frets.includes(0);
    const minPos = positives.length ? Math.min.apply(null, positives) : 1;
    const baseFret = hasOpen || minPos === 1 ? 1 : minPos;
    return { frets, baseFret, label, barreFret: barreFret || null };
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /* ---------------- SVG: guitar fretboard ---------------- */
  const FB = { rows: 5, w: 168, h: 196, padX: 22, padTop: 34, padBottom: 20 };

  function renderFretboard(shape) {
    const { frets, baseFret, barreFret } = shape;
    const left = FB.padX, right = FB.w - FB.padX;
    const top = FB.padTop, bottom = FB.h - FB.padBottom;
    const stringGap = (right - left) / 5;
    const fretGap = (bottom - top) / FB.rows;
    const x = (s) => left + s * stringGap;          // s: 0..5 (string 6 -> 1)
    const y = (f) => top + f * fretGap;             // f: 0..rows fret lines

    let g = "";
    // frame
    for (let s = 0; s < 6; s++) g += line(x(s), top, x(s), bottom, 1.4);
    for (let f = 0; f <= FB.rows; f++) g += line(left, y(f), right, y(f), 1.4);
    // nut, or a "Nfr" marker
    if (baseFret === 1) {
      g += `<rect x="${left - 1}" y="${top - 4}" width="${right - left + 2}" height="4" rx="1" fill="var(--ink)"/>`;
    } else {
      g += `<text x="${left - 8}" y="${top + fretGap * 0.7}" text-anchor="end" font-size="11" fill="var(--ink-soft)">${baseFret}fr</text>`;
    }
    // barre
    if (barreFret) {
      const idx = [];
      frets.forEach((v, s) => { if (v === barreFret) idx.push(s); });
      if (idx.length >= 2) {
        const row = barreFret - baseFret;
        g += `<rect x="${x(Math.min.apply(null, idx)) - 6}" y="${y(row) + fretGap / 2 - 7}" width="${x(Math.max.apply(null, idx)) - x(Math.min.apply(null, idx)) + 12}" height="14" rx="7" fill="var(--amber)"/>`;
      }
    }
    // dots + open/muted markers
    frets.forEach((v, s) => {
      if (v === -1) {
        g += mark(x(s), top - 14, "x");
      } else if (v === 0) {
        g += mark(x(s), top - 14, "o");
      } else {
        const row = v - baseFret;
        g += `<circle cx="${x(s)}" cy="${y(row) + fretGap / 2}" r="7.5" fill="var(--amber-deep)"/>`;
      }
    });

    return `<svg viewBox="0 0 ${FB.w} ${FB.h}" class="fretboard" role="img" aria-label="Chord diagram">${g}</svg>`;

    function line(x1, y1, x2, y2, w) {
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--line)" stroke-width="${w}" stroke-linecap="round"/>`;
    }
    function mark(cx, cy, kind) {
      if (kind === "o") return `<circle cx="${cx}" cy="${cy}" r="4.6" fill="none" stroke="var(--ink-soft)" stroke-width="1.6"/>`;
      return `<g stroke="var(--ink-soft)" stroke-width="1.6" stroke-linecap="round"><line x1="${cx - 4}" y1="${cy - 4}" x2="${cx + 4}" y2="${cy + 4}"/><line x1="${cx - 4}" y1="${cy + 4}" x2="${cx + 4}" y2="${cy - 4}"/></g>`;
    }
  }

  /* ---------------- SVG: piano keyboard ---------------- */
  const BLACK_PCS = [1, 3, 6, 8, 10];

  function renderKeyboard(rootIdx, intervals) {
    const isBlack = (pc) => BLACK_PCS.indexOf(((pc % 12) + 12) % 12) !== -1;
    const W = 27, H = 108, BW = 16, BH = 66;

    // Always begin the drawing on a white key at or just below the root, so a
    // black-note root (A#, C#, ...) doesn't leave the keyboard starting
    // mid-pattern. Keys are absolute notes; a key is "on" when its distance
    // above the root is one of the chord intervals.
    const startNote = isBlack(rootIdx) ? rootIdx - 1 : rootIdx;
    let sEnd = rootIdx - startNote + 12; // up to the octave root
    if (isBlack(startNote + sEnd)) sEnd -= 1; // never end on a trailing black key

    const slotX = [];
    let whiteCount = 0;
    for (let s = 0; s <= sEnd; s++) {
      if (!isBlack(startNote + s)) { slotX[s] = whiteCount * W; whiteCount++; }
    }
    const width = whiteCount * W;

    // Root gets the ember accent so it reads at a glance; the other chord
    // tones use the main accent.
    let whites = "", blacks = "";
    for (let s = 0; s <= sEnd; s++) {
      const abs = startNote + s;
      const off = abs - rootIdx;
      const on = off >= 0 && intervals.indexOf(off) !== -1;
      const isRoot = abs === rootIdx;
      if (!isBlack(abs)) {
        const fill = isRoot ? "var(--ember)" : on ? "var(--amber)" : "var(--surface-raised)";
        whites += `<rect x="${slotX[s]}" y="0" width="${W - 1.5}" height="${H}" rx="3" fill="${fill}" stroke="var(--line)" stroke-width="1"/>`;
        if (on) whites += `<circle cx="${slotX[s] + (W - 1.5) / 2}" cy="${H - 15}" r="3.6" fill="var(--bg)"/>`;
      } else {
        const prevWhiteX = slotX[s - 1] !== undefined ? slotX[s - 1] : 0;
        const bx = prevWhiteX + W - BW / 2 - 0.75;
        const fill = isRoot ? "var(--ember)" : on ? "var(--amber)" : "var(--ink)";
        blacks += `<rect x="${bx}" y="0" width="${BW}" height="${BH}" rx="2.5" fill="${fill}"/>`;
        if (on) blacks += `<circle cx="${bx + BW / 2}" cy="${BH - 11}" r="3.2" fill="var(--bg)"/>`;
      }
    }
    return `<svg viewBox="-1 -1 ${width + 2} ${H + 2}" class="keyboard" role="img" aria-label="Chord on the keyboard">${whites}${blacks}</svg>`;
  }

  /* ---------------- Wiring ---------------- */
  const rootsEl = document.getElementById("chord-roots");
  const typesEl = document.getElementById("chord-types");
  const nameEl = document.getElementById("chord-name");
  const diagramEl = document.getElementById("chord-diagram");
  const notesEl = document.getElementById("chord-notes");
  const hintEl = document.getElementById("chord-shape-hint");
  const subEl = document.getElementById("chords-sub");
  if (!rootsEl || !typesEl) return;

  let rootIdx = clampRoot(localStorage.getItem("guitar-chord-root"));
  let qualityKey = clampQuality(localStorage.getItem("guitar-chord-type"));

  function clampRoot(name) {
    const i = NOTES.indexOf(name);
    return i === -1 ? 0 : i;
  }
  function clampQuality(key) {
    return QUALITIES.some((q) => q.key === key) ? key : "maj";
  }
  function currentInstrument() {
    return (window.GuitarApp && window.GuitarApp.getInstrument())
      || document.body.dataset.instrument || "guitar";
  }

  NOTES.forEach((n, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chord-chip";
    b.textContent = n;
    b.addEventListener("click", () => {
      rootIdx = i;
      localStorage.setItem("guitar-chord-root", n);
      render();
    });
    rootsEl.appendChild(b);
  });

  QUALITIES.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chord-chip chord-chip--type";
    b.textContent = q.label;
    b.dataset.key = q.key;
    b.addEventListener("click", () => {
      qualityKey = q.key;
      localStorage.setItem("guitar-chord-type", q.key);
      render();
    });
    typesEl.appendChild(b);
  });

  function render() {
    const quality = QUALITIES.find((q) => q.key === qualityKey);
    const piano = currentInstrument() === "piano";

    Array.from(rootsEl.children).forEach((b, i) => b.classList.toggle("is-active", i === rootIdx));
    Array.from(typesEl.children).forEach((b) => b.classList.toggle("is-active", b.dataset.key === qualityKey));

    nameEl.textContent = NOTES[rootIdx] + quality.suffix;
    notesEl.textContent = quality.intervals.map((iv) => NOTES[(rootIdx + iv) % 12]).join("  ·  ");
    if (subEl) subEl.textContent = piano
      ? "Which keys to press — root note highlighted."
      : "Low string on the left · ✕ muted · ○ open.";

    if (piano) {
      diagramEl.innerHTML = renderKeyboard(rootIdx, quality.intervals);
      hintEl.textContent = "";
    } else {
      const shape = guitarShape(rootIdx, quality);
      if (!shape) {
        diagramEl.innerHTML = "";
        hintEl.textContent = "No common shape for this one.";
      } else {
        diagramEl.innerHTML = renderFretboard(shape);
        hintEl.textContent = shape.label;
      }
    }
  }

  document.addEventListener("instrumentchange", render);

  // app.js calls this when the Chords tab is shown; render once now too so the
  // page is ready if it's opened before any instrument change.
  window.GuitarChords = { refresh: render };
  render();
})();
