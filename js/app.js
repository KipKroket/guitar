(function () {
  const { GuitarTuner, TUNINGS, freqToNote } = window.GuitarTunerEngine;

  const CONFIRM_CENTS = 5;      // how close counts as "in tune"
  const CONFIRM_HOLD_MS = 500;  // how long it must stay in tune before confirming
  const ADVANCE_DELAY_MS = 700; // pause after confirmation before moving on

  const SIGNAL_GRACE_MS = 2500;    // brief dropouts (breath, pick noise, or a plucked string simply
                                    // ringing out) don't reset progress. A plucked guitar string decays
                                    // below the mic's detectable level within roughly a second on a
                                    // phone mic (especially with AGC disabled), well before a real
                                    // "stopped playing" pause would happen -- so this needs to be long
                                    // enough to bridge a natural decay tail, not just a breath/pick-noise
                                    // blip. The CONFIRM_HOLD_MS timer below is wall-clock based, so an
                                    // in-tune hold keeps accumulating silently during this grace window.
  const HOLD_GRACE_MS = 400;       // a stray out-of-tune reading doesn't cancel an in-tune hold
  const CENTS_SMOOTHING = 0.25;    // needle/reading smoothing factor (0-1, lower = calmer)
  const HOLD_SMOOTHING = 0.2;      // separate, calmer filter that decides "in tune" for confirming --
                                    // steadier than the needle so a stray noise spike can't stall the
                                    // auto-advance. Was 0.08, which (paired with the old detector's
                                    // sharp low-string bias) was so sluggish a correctly tuned string
                                    // could take many seconds to confirm, or never cross the line at
                                    // all. The detector no longer has that bias and the 150-cent
                                    // outlier gate below still swallows true octave slips, so this can
                                    // track real pitch changes far more promptly.
  const HOLD_OUTLIER_GATE_CENTS = 150; // a single reading this far from the current hold estimate is
                                        // almost certainly a bad detection (octave slip); ignore it
  const HOLD_OUTLIER_RESEED_FRAMES = 15; // ~0.25s of consecutive rejections means the *hold* value
                                          // itself is the bad one (e.g. seeded off a noisy attack-
                                          // transient reading right when the string was plucked) --
                                          // re-seed instead of rejecting every future update forever
  const NEAR_ENTER_CENTS = 15;     // enter the quiet "near" zone once this close
  const NEAR_EXIT_CENTS = 20;      // only leave the "near" zone once this far off again (hysteresis)
  const DIRECTION_DEBOUNCE_MS = 350; // how long a direction must hold before the hint switches

  /* ---------- Navigation ---------- */
  const navButtons = document.querySelectorAll(".nav-btn");
  const pages = document.querySelectorAll(".page");
  const settingsFab = document.getElementById("settings-fab");
  const settingsBack = document.getElementById("settings-back");
  let currentPage = null;
  // Settings is no longer in the bottom nav -- it opens from the floating gear
  // and its back arrow returns you to wherever you were. previousPage tracks
  // the last non-settings page for exactly that.
  let previousPage = "library";

  function showPage(target) {
    if (currentPage && currentPage !== "settings") previousPage = currentPage;
    currentPage = target;
    pages.forEach((p) => (p.hidden = p.dataset.page !== target));
    navButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.target === target));
    // The gear would sit on top of the Settings page's own back arrow.
    if (settingsFab) settingsFab.hidden = target === "settings";
    if (target === "chords" && window.GuitarChords) window.GuitarChords.refresh();
  }

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.target));
  });

  if (settingsFab) settingsFab.addEventListener("click", () => showPage("settings"));
  if (settingsBack) settingsBack.addEventListener("click", () => showPage(previousPage || "library"));

  /* ---------- Instrument mode (guitar / piano) ---------- */
  // The app doubles as a piano companion. The mode is global: it swaps the
  // colour palette (see [data-instrument] in the CSS), hides the tuner from
  // the bottom nav, and gives the library its own separate list and its own
  // set of chord-lookup sites (handled in library.js, which listens for the
  // "instrumentchange" event dispatched below).
  const INSTRUMENTS = ["guitar", "piano"];
  // A ?instrument= in the URL wins over the stored value. The piano PWA is
  // installed with start_url "./index.html?instrument=piano" (and the guitar
  // one with ?instrument=guitar), so each installed icon always opens in its
  // own mode regardless of what the shared localStorage last held. Opened
  // plain in a browser (no param), we fall back to the last used instrument.
  const forcedInstrument = new URLSearchParams(location.search).get("instrument");
  let instrument = INSTRUMENTS.includes(forcedInstrument)
    ? forcedInstrument
    : localStorage.getItem("guitar-instrument");
  if (!INSTRUMENTS.includes(instrument)) instrument = "guitar";
  document.body.dataset.instrument = instrument;

  // The guitar/piano switch appears in more than one place (library header,
  // chord book header) -- keep every instance in sync.
  const instrumentToggles = document.querySelectorAll(".instrument-switch");
  const syncInstrumentToggles = (inst) =>
    instrumentToggles.forEach((t) => t.setAttribute("aria-checked", inst === "piano" ? "true" : "false"));
  syncInstrumentToggles(instrument);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  // Swap the app's identity (tab title, iOS home-screen title, icon, manifest)
  // to match the instrument. On iOS this is read at "Add to Home Screen" time,
  // so installing while in piano mode captures the name "Piano" and the piano
  // icon; on Android the manifest swap does the same for the installed PWA.
  const linkManifest = document.querySelector('link[rel="manifest"]');
  const linkAppleIcon = document.querySelector('link[rel="apple-touch-icon"]');
  const linkFavicon = document.querySelector('link[rel="icon"]');
  const metaAppleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');

  function applyInstrumentIdentity(inst) {
    const piano = inst === "piano";
    document.title = piano ? "Piano" : "Guitar";
    if (metaAppleTitle) metaAppleTitle.setAttribute("content", piano ? "Piano" : "Guitar");
    if (linkManifest) linkManifest.setAttribute("href", piano ? "manifest-piano.json" : "manifest.json");
    if (linkAppleIcon) linkAppleIcon.setAttribute("href", piano ? "icons/apple-touch-icon-piano.png" : "icons/apple-touch-icon.png");
    if (linkFavicon) linkFavicon.setAttribute("href", piano ? "icons/icon-piano.svg" : "icons/icon.svg");
  }
  applyInstrumentIdentity(instrument);

  // Keep the mobile status-bar tint in step with whatever palette is active.
  function syncThemeColor() {
    if (!themeColorMeta) return;
    const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
    if (bg) themeColorMeta.setAttribute("content", bg);
  }

  function setInstrument(next) {
    if (!INSTRUMENTS.includes(next) || next === instrument) return;
    instrument = next;
    document.body.dataset.instrument = next;
    syncInstrumentToggles(next);
    localStorage.setItem("guitar-instrument", next);
    applyInstrumentIdentity(next);
    // The tuner tab is guitar-only; if it's on screen when switching to
    // piano, step back to the library (where piano mode lives).
    if (next === "piano" && currentPage === "tuner") showPage("library");
    syncThemeColor();
    document.dispatchEvent(new CustomEvent("instrumentchange", { detail: { instrument: next } }));
  }

  instrumentToggles.forEach((t) => {
    t.addEventListener("click", () => {
      setInstrument(instrument === "guitar" ? "piano" : "guitar");
    });
  });

  // Exposed so the song library can read the current instrument and switch
  // tabs without needing its own copy of this logic.
  window.GuitarApp = { showPage, getInstrument: () => instrument };

  /* ---------- Theme ---------- */
  const themeToggle = document.getElementById("theme-toggle");
  const savedTheme = localStorage.getItem("guitar-theme") || "light";
  document.body.dataset.theme = savedTheme;
  themeToggle.setAttribute("aria-pressed", savedTheme === "dark");

  themeToggle.addEventListener("click", () => {
    const next = document.body.dataset.theme === "dark" ? "light" : "dark";
    document.body.dataset.theme = next;
    themeToggle.setAttribute("aria-pressed", next === "dark");
    localStorage.setItem("guitar-theme", next);
    syncThemeColor();
  });

  /* ---------- Build number ---------- */
  // Shown small at the bottom of Settings so it's possible to tell at a glance
  // which bundle a device is actually running (a PWA can sit on a stale
  // service-worker cache for a while after a deploy). BUMP THIS ON EVERY
  // DEPLOY, in lockstep with the CACHE name in sw.js -- the two always move
  // together so this number identifies the exact shipped code.
  const BUILD = "22";
  const versionEl = document.getElementById("app-version");
  if (versionEl) versionEl.textContent = "Build " + BUILD;

  /* ---------- Tuning selection ---------- */
  const tuningSelect = document.getElementById("tuning-select");
  const defaultTuningSelect = document.getElementById("default-tuning-select");

  const savedDefaultTuning = localStorage.getItem("guitar-default-tuning") || "standard";
  tuningSelect.value = savedDefaultTuning;
  defaultTuningSelect.value = savedDefaultTuning;

  defaultTuningSelect.addEventListener("change", () => {
    localStorage.setItem("guitar-default-tuning", defaultTuningSelect.value);
    tuningSelect.value = defaultTuningSelect.value;
    resetSession();
    renderStringChips();
  });

  tuningSelect.addEventListener("change", () => {
    resetSession();
    renderStringChips();
  });

  /* ---------- Reference tone: real recording first, synthesis as fallback ---------- */
  let toneCtx = null;

  // Real acoustic guitar open-string recordings (Philharmonia Orchestra sound
  // sample library -- free to download and use), bundled locally with the app.
  // One consistent source: same guitar, same player, same room and mic, so the
  // six tones sit together as a set. Each file has been prepared once, up front,
  // so the app does nothing to them at runtime:
  //   - trimmed to the open-string pluck plus ~1.4-1.8 s of natural decay
  //   - pitch-corrected to exact concert pitch (the recorded guitar was a few
  //     cents off here and there); every file is now within ~1 cent of target
  //   - loudness-matched across the set, with a short fade in/out
  // (An earlier set from a different library had a broken A2 whose fundamental
  //  died almost immediately, leaving a wavering octave overtone -- that is why
  //  the whole set was replaced rather than patched.)
  const REAL_SAMPLES = {
    E2: "audio/E2.mp3",
    A2: "audio/A2.mp3",
    D3: "audio/D3.mp3",
    G3: "audio/G3.mp3",
    B3: "audio/B3.mp3",
    E4: "audio/E4.mp3",
  };

  // Same-origin now, so fetch()+decodeAudioData() works without any CORS
  // concern, and buffers can be cached and reused freely.
  const sampleBufferCache = new Map(); // key -> Promise<AudioBuffer>
  let activePreviewSource = null;
  let previewSeq = 0;
  let previewGain = null;
  let previewCompressor = null;

  // The files are already loudness-normalized (~-14 LUFS) at authoring time,
  // so no extra make-up gain is needed -- pushing it louder here was what
  // drove the compressor hard enough to audibly pump/distort. Slight
  // attenuation instead, and the compressor is now a gentle safety net
  // (higher threshold, lower ratio, slower attack) rather than a limiter
  // doing several dB of constant gain reduction.
  const PREVIEW_GAIN = 0.8;

  function getPreviewChain(ctx) {
    if (!previewGain) {
      previewGain = ctx.createGain();
      previewGain.gain.value = PREVIEW_GAIN;
      previewCompressor = ctx.createDynamicsCompressor();
      previewCompressor.threshold.value = -3;
      previewCompressor.knee.value = 6;
      previewCompressor.ratio.value = 3;
      previewCompressor.attack.value = 0.008;
      previewCompressor.release.value = 0.25;
      previewGain.connect(previewCompressor).connect(ctx.destination);
    }
    return previewGain;
  }

  function loadSampleBuffer(ctx, key, url) {
    if (!sampleBufferCache.has(key)) {
      const promise = fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`Sample fetch failed: ${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .catch((err) => {
          sampleBufferCache.delete(key); // don't cache a failure, allow a later retry
          throw err;
        });
      sampleBufferCache.set(key, promise);
    }
    return sampleBufferCache.get(key);
  }

  // Warm the cache as soon as the page loads (fetching a same-origin file
  // needs no gesture), so the first tap on a string doesn't have to wait on
  // a network round trip.
  Object.entries(REAL_SAMPLES).forEach(([key, url]) => {
    fetch(url)
      .then((res) => res.arrayBuffer())
      .then((data) => { sampleBufferCache.set(key, Promise.resolve(data)); })
      .catch(() => { /* first real tap will retry via loadSampleBuffer */ });
  });

  function stopActivePreview() {
    if (activePreviewSource) {
      activePreviewSource.onended = null;
      try { activePreviewSource.stop(); } catch (err) { /* already stopped */ }
      activePreviewSource = null;
    }
  }

  function playDecodedBuffer(buffer) {
    const ctx = toneCtx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(getPreviewChain(ctx));
    activePreviewSource = source;

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (activePreviewSource === source) activePreviewSource = null;
        resolve();
      };
      source.onended = finish;
      source.start(0);
      setTimeout(finish, buffer.duration * 1000 + 250); // safety net in case onended never fires
    });
  }

  function playRealSampleBuffer(key, url, frequency) {
    const mySeq = ++previewSeq;
    stopActivePreview();

    return loadSampleBuffer(toneCtx, key, url)
      .then((cached) => {
        if (mySeq !== previewSeq) return; // a newer string was tapped meanwhile
        // The warm-up cache above stores a raw ArrayBuffer (fetched eagerly,
        // before any AudioContext necessarily exists yet); decode it lazily
        // here, once, the first time it's actually needed for playback.
        const decodePromise = cached instanceof ArrayBuffer ? toneCtx.decodeAudioData(cached) : Promise.resolve(cached);
        return decodePromise.then((buffer) => {
          sampleBufferCache.set(key, Promise.resolve(buffer));
          if (mySeq !== previewSeq) return;
          return playDecodedBuffer(buffer);
        });
      })
      .catch(() => {
        if (mySeq !== previewSeq) return;
        return playSynthTone(frequency); // e.g. a genuinely broken file -- still give some feedback
      });
  }
  function smoothedNoise(N, passes) {
    let raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = Math.random() * 2 - 1;
    for (let p = 0; p < passes; p++) {
      const s = new Float32Array(N);
      for (let i = 0; i < N; i++) s[i] = (raw[(i - 1 + N) % N] + raw[i] + raw[(i + 1) % N]) / 3;
      raw = s;
    }
    return raw;
  }

  function karplusVoice(sampleRate, frequency, totalSamples, damping, smoothPasses) {
    const N = Math.max(2, Math.round(sampleRate / frequency));
    const ring = smoothedNoise(N, smoothPasses);
    const out = new Float32Array(totalSamples);
    let idx = 0;
    for (let i = 0; i < totalSamples; i++) {
      const cur = ring[idx];
      const next = ring[(idx + 1) % N];
      out[i] = cur;
      ring[idx] = damping * 0.5 * (cur + next);
      idx = (idx + 1) % N;
    }
    return out;
  }

  const SYNTH_PARAMS = {
    dampingA: 0.995, dampingB: 0.9945, detune: 0.005, detuneMix: 0.4,
    smoothPasses: 1, smoothAlpha: 0.15, lowpass: 6500,
    thumpAmp: 0.08, thumpFreqs: [110, 190], thumpDecay: 32, drive: 1.9, duration: 1.4,
  };

  function pluckedStringBuffer(ctx, frequency, params) {
    const sampleRate = ctx.sampleRate;
    const totalSamples = Math.floor(sampleRate * params.duration);
    const voiceA = karplusVoice(sampleRate, frequency, totalSamples, params.dampingA, params.smoothPasses);
    const voiceB = karplusVoice(sampleRate, frequency * (1 + params.detune), totalSamples, params.dampingB, params.smoothPasses);
    const mixed = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) mixed[i] = voiceA[i] * 0.75 + voiceB[i] * params.detuneMix;

    let prev = 0;
    for (let i = 0; i < totalSamples; i++) {
      prev += params.smoothAlpha * (mixed[i] - prev);
      mixed[i] = prev;
    }

    const thumpSamples = Math.min(totalSamples, Math.floor(sampleRate * 0.14));
    for (let i = 0; i < thumpSamples; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * params.thumpDecay);
      mixed[i] += Math.sin(2 * Math.PI * params.thumpFreqs[0] * t) * params.thumpAmp * env
                + Math.sin(2 * Math.PI * params.thumpFreqs[1] * t) * params.thumpAmp * 0.5 * env;
    }

    let peak = 0;
    for (let i = 0; i < totalSamples; i++) peak = Math.max(peak, Math.abs(mixed[i]));
    if (peak > 0.98) { const g = 0.98 / peak; for (let i = 0; i < totalSamples; i++) mixed[i] *= g; }

    const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
    buffer.copyToChannel(mixed, 0);
    return buffer;
  }

  function softClipCurve(drive) {
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    return curve;
  }

  function ensureToneCtx() {
    toneCtx = toneCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (toneCtx.state === "suspended") toneCtx.resume();
    return toneCtx;
  }

  function playSynthTone(frequency) {
    const ctx = ensureToneCtx();
    const params = SYNTH_PARAMS;
    const buffer = pluckedStringBuffer(ctx, frequency, params);
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const softener = ctx.createWaveShaper();
    softener.curve = softClipCurve(params.drive);
    softener.oversample = "2x";

    const body = ctx.createBiquadFilter();
    body.type = "lowpass";
    body.frequency.value = params.lowpass;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(1, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + params.duration);

    source.connect(softener).connect(body).connect(gain).connect(ctx.destination);
    // Registered the same way as a real-sample source, so switching strings
    // quickly stops a still-ringing synth fallback exactly like it stops a
    // real recording -- one cancellation path for both.
    activePreviewSource = source;

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (activePreviewSource === source) activePreviewSource = null;
        resolve();
      };
      source.onended = finish;
      source.start(now);
      source.stop(now + params.duration);
    });
  }

  function playReferenceTone(frequency) {
    ensureToneCtx();
    const note = freqToNote(frequency);
    const key = `${note.name}${note.octave}`;
    const realUrl = REAL_SAMPLES[key];
    return realUrl ? playRealSampleBuffer(key, realUrl, frequency) : playSynthTone(frequency);
  }

  function playConfirmChime() {
    const ctx = ensureToneCtx();
    const now = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  }

  /* ---------- Tuning session state ---------- */
  let currentTargetIndex = 0;
  let confirmedSet = new Set();
  let inTuneSince = null;
  let outOfTuneSince = null;
  let confirmedForTarget = false;
  let sessionComplete = false;
  let smoothedCents = null;
  let holdCents = null;
  let holdOutlierStreak = 0;
  let lastSignalAt = 0;
  let hintZone = "far";           // "far" | "near", with hysteresis between them
  let committedDirection = null;  // "up" | "down" | null
  let pendingDirection = null;
  let pendingDirectionSince = 0;

  function resetSession() {
    currentTargetIndex = 0;
    confirmedSet = new Set();
    inTuneSince = null;
    outOfTuneSince = null;
    confirmedForTarget = false;
    sessionComplete = false;
    noteNameEl.classList.remove("confirmed", "in-tune");
    resetHintTracking();
    tuner.setTargetFrequency(currentTuning().strings[0]);
  }

  function setTarget(index) {
    currentTargetIndex = index;
    inTuneSince = null;
    outOfTuneSince = null;
    confirmedForTarget = false;
    sessionComplete = false;
    noteNameEl.classList.remove("confirmed", "in-tune");
    resetHintTracking();
    renderStringChips();
    // Tell the detector which note to expect so it can correct octave-lock
    // errors (see tuner.js) instead of silently discarding good-but-mis-
    // octaved readings on brighter, harmonic-rich strings.
    tuner.setTargetFrequency(currentTuning().strings[index]);
  }

  function resetHintTracking() {
    smoothedCents = null;
    holdCents = null;
    holdOutlierStreak = 0;
    hintZone = "far";
    committedDirection = null;
    pendingDirection = null;
    pendingDirectionSince = 0;
  }

  /* ---------- String chips ---------- */
  const stringTargets = document.getElementById("string-targets");

  function renderStringChips() {
    const tuning = TUNINGS[tuningSelect.value];
    stringTargets.innerHTML = "";
    tuning.strings.forEach((freq, i) => {
      const { name, octave } = freqToNote(freq);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "string-chip"
        + (i === currentTargetIndex ? " active" : "")
        + (confirmedSet.has(i) ? " done" : "");
      chip.textContent = (confirmedSet.has(i) ? "✓ " : "") + `${name}${octave}`;
      chip.addEventListener("click", () => onStringChipClick(i));
      stringTargets.appendChild(chip);
    });
  }

  // Switching strings quickly shouldn't queue up a run of previews that
  // arrive late, out of sync with whatever is currently selected. So the
  // chip itself reacts instantly (selection, readout, hint text), but the
  // actual audio waits for a short pause in tapping before it fetches or
  // plays anything -- rapid taps stay silent; only the string you settle on
  // gets a sound.
  const TONE_SETTLE_MS = 120;
  let toneRequestSeq = 0;
  let toneSettleTimer = null;

  function onStringChipClick(i) {
    setTarget(i);
    setHint("Listen…");

    const freq = TUNINGS[tuningSelect.value].strings[i];
    const mySeq = ++toneRequestSeq;
    stopActivePreview(); // silence whatever was already sounding right away

    if (toneSettleTimer) clearTimeout(toneSettleTimer);
    toneSettleTimer = setTimeout(() => {
      if (mySeq !== toneRequestSeq) return; // superseded by a later tap -- stay quiet
      playReferenceTone(freq).then(() => {
        if (mySeq !== toneRequestSeq) return;
        // Tapping a string only auditions its reference pitch -- it no longer
        // starts the microphone. The mic (and its permission prompt) is asked
        // for exactly once, when the user deliberately taps "Start tuning".
        // On iOS a PWA re-asks every launch, so we don't want a stray tap on
        // a string name to trigger that when someone is only checking a pitch.
        setHint(isListening ? "Listening… play the string." : "Tap “Start tuning” when you’re ready.");
      });
    }, TONE_SETTLE_MS);
  }

  /* ---------- Meter ---------- */
  const ticksGroup = document.getElementById("meter-ticks");
  const needle = document.getElementById("meter-needle");
  const CENTER = { x: 150, y: 160 };
  const RADIUS = 130;

  function polar(radius, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: CENTER.x + radius * Math.cos(rad), y: CENTER.y - radius * Math.sin(rad) };
  }

  function buildTicks() {
    ticksGroup.innerHTML = "";
    for (let cents = -50; cents <= 50; cents += 10) {
      const angle = 90 - (cents / 50) * 90;
      const isCenter = cents === 0;
      const inner = polar(RADIUS - (isCenter ? 16 : 10), angle);
      const outer = polar(RADIUS + 4, angle);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", inner.x);
      line.setAttribute("y1", inner.y);
      line.setAttribute("x2", outer.x);
      line.setAttribute("y2", outer.y);
      line.setAttribute("class", "meter-tick" + (isCenter ? " center" : ""));
      ticksGroup.appendChild(line);
    }
  }
  buildTicks();

  function setNeedle(cents) {
    const clamped = Math.max(-50, Math.min(50, cents));
    const rotation = (clamped / 50) * 90;
    needle.style.transform = `rotate(${rotation}deg)`;
  }

  /* ---------- Readout elements ---------- */
  const noteNameEl = document.getElementById("note-name");
  const noteNameTextEl = document.getElementById("note-name-text");
  const centsValueEl = document.getElementById("cents-value");
  const freqValueEl = document.getElementById("freq-value");
  const hintEl = document.getElementById("tuner-hint");
  const micButton = document.getElementById("mic-toggle");
  const micLabel = document.getElementById("mic-toggle-label");

  function currentTuning() {
    return TUNINGS[tuningSelect.value];
  }

  /* ---------- Calm hint text (fades between short, infrequent messages) ---------- */
  let currentHintText = null;
  let hintFadeTimer = null;

  function setHint(text) {
    if (text === currentHintText) return;
    currentHintText = text;
    if (hintFadeTimer) clearTimeout(hintFadeTimer);
    hintEl.classList.add("is-fading");
    hintFadeTimer = setTimeout(() => {
      hintEl.textContent = text;
      hintEl.classList.remove("is-fading");
    }, 160);
  }

  // Decide the direction hint ("Tune up/down a little.") with hysteresis on the
  // near/far zone boundary and a short debounce before flipping direction, so
  // the text doesn't flicker when a note hovers right at a threshold.
  function updateDirectionHint(cents) {
    const absCents = Math.abs(cents);

    if (hintZone === "far") {
      if (absCents <= NEAR_ENTER_CENTS) hintZone = "near";
    } else if (absCents > NEAR_EXIT_CENTS) {
      hintZone = "far";
    }

    if (hintZone === "near") {
      committedDirection = null;
      pendingDirection = null;
      setHint("Almost there…");
      return;
    }

    const dir = cents < 0 ? "up" : "down";
    if (committedDirection === null) {
      committedDirection = dir;
      pendingDirection = dir;
      pendingDirectionSince = Date.now();
    } else if (dir !== pendingDirection) {
      pendingDirection = dir;
      pendingDirectionSince = Date.now();
    } else if (dir !== committedDirection && Date.now() - pendingDirectionSince >= DIRECTION_DEBOUNCE_MS) {
      committedDirection = dir;
    }

    setHint(committedDirection === "up" ? "Tune up a little." : "Tune down a little.");
  }

  function advanceToNext() {
    const tuning = currentTuning();
    confirmedSet.add(currentTargetIndex);
    const isLast = currentTargetIndex >= tuning.strings.length - 1;
    if (isLast) {
      sessionComplete = true;
      tuner.stop();
      isListening = false;
      micButton.classList.remove("is-listening");
      micButton.setAttribute("aria-pressed", "false");
      micLabel.textContent = "Start tuning";
      setHint("All strings are in tune.");
      renderStringChips();
      return;
    }
    setTarget(currentTargetIndex + 1);
    setHint("Listening… play the next string.");
  }

  function handleUpdate(result) {
    if (sessionComplete) return;

    if (!result) {
      const now = Date.now();
      // A brief dropout (breath, pick noise, a plucked string ringing out)
      // shouldn't reset an in-tune hold or yank the hint back to "Listening…".
      if (lastSignalAt && now - lastSignalAt < SIGNAL_GRACE_MS) return;
      inTuneSince = null;
      outOfTuneSince = null;
      smoothedCents = null;
      holdCents = null;
      noteNameEl.classList.remove("in-tune");
      if (!confirmedForTarget) {
        setHint("Listening… play a single string.");
        // The grace window is now long, so by the time we actually get here
        // the string has genuinely gone silent -- clear the frozen readout
        // instead of leaving stale numbers/needle sitting on screen looking
        // "in tune" for many seconds after the app has stopped listening.
        noteNameTextEl.textContent = "—";
        centsValueEl.innerHTML = `— <span>cents</span>`;
        freqValueEl.textContent = "— Hz";
        setNeedle(0);
      }
      return;
    }
    lastSignalAt = Date.now();

    const tuning = currentTuning();
    const targetFreq = tuning.strings[currentTargetIndex];
    const targetNote = freqToNote(targetFreq);
    const rawCents = 1200 * Math.log2(result.frequency / targetFreq);
    smoothedCents = smoothedCents === null ? rawCents : smoothedCents + CENTS_SMOOTHING * (rawCents - smoothedCents);
    const cents = Math.round(smoothedCents);

    noteNameTextEl.textContent = `${targetNote.name}${targetNote.octave}`;
    centsValueEl.innerHTML = `${cents > 0 ? "+" : ""}${cents} <span>cents</span>`;
    freqValueEl.textContent = `${result.frequency.toFixed(1)} Hz`;
    setNeedle(smoothedCents);

    // A second, much slower filter decides whether the string counts as "in
    // tune" for confirming/advancing. The needle above stays snappy off the
    // fast filter; this one deliberately lags behind so an isolated bad
    // reading (an octave slip from the pitch detector, a stray harmonic,
    // pick noise) barely moves it and can't stall or restart the hold.
    if (holdCents === null) {
      holdCents = rawCents;
      holdOutlierStreak = 0;
    } else if (Math.abs(rawCents - holdCents) <= HOLD_OUTLIER_GATE_CENTS) {
      holdCents = holdCents + HOLD_SMOOTHING * (rawCents - holdCents);
      holdOutlierStreak = 0;
    } else {
      holdOutlierStreak++;
      if (holdOutlierStreak >= HOLD_OUTLIER_RESEED_FRAMES) {
        holdCents = rawCents;
        holdOutlierStreak = 0;
      }
    }

    const inTune = Math.abs(holdCents) <= CONFIRM_CENTS;
    noteNameEl.classList.toggle("in-tune", inTune);

    if (confirmedForTarget) return;

    if (inTune) {
      outOfTuneSince = null;
      if (inTuneSince === null) inTuneSince = Date.now();
      setHint("Holding steady…");
      if (Date.now() - inTuneSince >= CONFIRM_HOLD_MS) {
        confirmedForTarget = true;
        noteNameEl.classList.add("confirmed");
        playConfirmChime();
        setHint("Nice, in tune!");
        setTimeout(() => {
          noteNameEl.classList.remove("confirmed");
          advanceToNext();
        }, ADVANCE_DELAY_MS);
      }
    } else {
      updateDirectionHint(smoothedCents);
      if (inTuneSince !== null) {
        // Mid-hold already: give a brief grace window before throwing the
        // progress away, so one noisy/glitchy reading (a pick scrape, a
        // stray harmonic) doesn't force the whole 600ms hold to restart.
        if (outOfTuneSince === null) outOfTuneSince = Date.now();
        if (Date.now() - outOfTuneSince >= HOLD_GRACE_MS) {
          inTuneSince = null;
          outOfTuneSince = null;
        }
      }
    }
  }

  const tuner = new GuitarTuner();
  let isListening = false;

  async function startListening() {
    try {
      setHint("Requesting microphone access…");
      // Pass the app's single shared AudioContext so the mic (tuner) and
      // playback (reference tones/chime) never fight over the audio
      // session -- see the comment on GuitarTuner.start for why.
      await tuner.start(handleUpdate, ensureToneCtx());
      isListening = true;
      lastSignalAt = 0;
      micButton.classList.add("is-listening");
      micButton.setAttribute("aria-pressed", "true");
      micLabel.textContent = "Stop";
      setHint("Listening… play a single string.");
    } catch (err) {
      setHint("Microphone access was denied or unavailable.");
    }
  }

  micButton.addEventListener("click", () => {
    if (isListening) {
      tuner.stop();
      isListening = false;
      micButton.classList.remove("is-listening");
      micButton.setAttribute("aria-pressed", "false");
      micLabel.textContent = "Start tuning";
      setHint("Tap start and play a single string.");
      return;
    }
    resetSession();
    renderStringChips();
    startListening();
  });

  currentHintText = hintEl.textContent;
  renderStringChips();

  // The app always opens on the library now (it's the shared hub for both
  // instruments), not the tuner.
  showPage("library");
  syncThemeColor();
})();
