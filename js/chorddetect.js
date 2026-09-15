// Guitar — chord-detection engine for the songsheet "Play along" mode
// (js/songsheet.js). Listens to the mic and works out which of a *small*
// known set of chords -- the ones in this song's own progression -- is
// most likely sounding right now, then drives a step pointer through
// that progression.
//
// Deliberately not a general "name any chord" recogniser: scoring the
// live sound against only the handful of chords a song actually uses
// (rather than all 12 roots x every quality) is what keeps a phone mic
// plus a plain FFT chroma vector usable at all -- fewer, more different-
// sounding candidates to tell apart.
//
// Matching is a small state machine, not "closest chord wins each tick":
// PlayAlongDetector only ever compares the live sound against the
// *current* step (to recognise "no change yet") and a short lookahead
// window of the next couple of steps, and only advances once the same
// candidate has read consistently for DWELL_MS. That means a chord that's
// barely audible (weak strum, buzzed string, drowned out) still lets the
// pointer catch up as soon as a later chord in the window reads clearly,
// instead of getting stuck forever waiting for a transition that will
// never register cleanly.
//
// MATCH_THRESHOLD / DWELL_MS / STEP_LOOKAHEAD / NOISE_FLOOR below are
// first-pass guesses -- there's no real guitar+mic audio to tune them
// against in this environment, so expect them to need adjusting once
// actually tried.
(function () {
  const MIN_HZ = 70; // just under open low E (~82Hz), with headroom
  const MAX_HZ = 1300; // a couple of guitar-range harmonics; cuts off hiss
  const MATCH_THRESHOLD = 0.55; // cosine similarity needed to accept a candidate
  const NOISE_FLOOR = 0.02; // this tick's total chroma energy below this = "not playing"
  const DWELL_MS = 220; // how long a candidate must read before it counts
  const STEP_LOOKAHEAD = 2; // how far ahead in the progression to listen for
  const TICK_MS = 120; // analysis cadence, throttled inside the rAF loop
  const SMOOTH = 0.5; // chroma exponential-smoothing factor (0 = none)

  function normalise(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    const len = Math.sqrt(sum);
    if (len < 1e-9) return vec.map(() => 0);
    return vec.map((v) => v / len);
  }

  // A binary chord-tone template over the 12 pitch classes (root weighted
  // a bit heavier -- it's usually the loudest, lowest note in a strummed
  // chord). Reuses js/chords.js's own symbol parser rather than
  // re-deriving root/quality here.
  function template(sym) {
    const vec = new Array(12).fill(0);
    const pcs = window.GuitarChords && window.GuitarChords.pitchClasses ? window.GuitarChords.pitchClasses(sym) : null;
    if (!pcs || !pcs.length) return vec;
    pcs.forEach((pc, i) => {
      vec[pc] = i === 0 ? 1.3 : 1;
    });
    return normalise(vec);
  }

  function cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += a[i] * b[i];
    return dot;
  }

  // Consecutive repeats of the same chord (held across two lines, say)
  // collapse into one step -- matches js/songsheet.js's buildChordSteps(),
  // so the two stay index-for-index in sync. Idempotent, so it's harmless
  // if the caller already collapsed its own list before handing it over.
  function collapseSteps(syms) {
    const out = [];
    syms.forEach((sym) => {
      if (out.length && out[out.length - 1] === sym) return;
      out.push(sym);
    });
    return out;
  }

  class PlayAlongDetector {
    constructor(syms) {
      this.steps = collapseSteps(syms || []);
      this.templates = new Map();
      this.index = 0;
      this.candidateSym = null;
      this.candidateSince = 0;
      this.chroma = new Array(12).fill(0);
      this.listening = false;
      this.onStep = null;
      this._lastTick = 0;
    }

    stepCount() {
      return this.steps.length;
    }

    currentIndex() {
      return this.index;
    }

    // Manual override (tapping a lyric line in songsheet.js) -- jump the
    // pointer and drop whatever partial candidate match was building up,
    // so a stray reading right after the tap can't immediately undo it.
    jumpTo(index) {
      this.index = Math.max(0, Math.min(this.steps.length - 1, index));
      this.candidateSym = null;
    }

    _templateFor(sym) {
      let t = this.templates.get(sym);
      if (!t) {
        t = template(sym);
        this.templates.set(sym, t);
      }
      return t;
    }

    // Scores the live chroma vector against only the chords worth
    // listening for right now: the current step (so "still on this
    // chord" can win and nothing advances) plus a short lookahead window.
    _bestCandidate() {
      let best = null;
      let bestScore = MATCH_THRESHOLD;
      for (let k = 0; k <= STEP_LOOKAHEAD; k++) {
        const sym = this.steps[this.index + k];
        if (sym == null) break;
        const score = cosine(this.chroma, this._templateFor(sym));
        if (score > bestScore) {
          bestScore = score;
          best = { sym, offset: k };
        }
      }
      return best;
    }

    _feed(now) {
      const best = this._bestCandidate();
      if (!best || best.offset === 0) {
        // Either nothing cleared the threshold, or the clearest match is
        // just "still on the current chord" -- neither advances anything.
        this.candidateSym = null;
        return;
      }
      if (this.candidateSym === best.sym) {
        if (now - this.candidateSince >= DWELL_MS) {
          this.index += best.offset;
          this.candidateSym = null;
          if (this.onStep) this.onStep(this.index);
        }
      } else {
        this.candidateSym = best.sym;
        this.candidateSince = now;
      }
    }

    // sharedCtx: an AudioContext to reuse instead of creating a new one --
    // same reasoning as js/tuner.js's GuitarTuner.start(): a second
    // AudioContext can get silently suspended on iOS Safari once anything
    // else in the app plays audio through a different one.
    async start(onStep, sharedCtx) {
      this.onStep = onStep;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.ownsContext = !sharedCtx;
      this.audioCtx = sharedCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 8192;
      // Smoothing happens on the chroma vector below instead, at our own
      // TICK_MS cadence -- the analyser's built-in smoothing runs every
      // frame regardless, which doesn't line up with that throttling.
      this.analyser.smoothingTimeConstant = 0;
      this.source.connect(this.analyser);
      this.freqBuffer = new Float32Array(this.analyser.frequencyBinCount);
      this.listening = true;
      this._lastTick = 0;
      this._tick();
    }

    _tick() {
      if (!this.listening) return;
      const now = performance.now();
      if (now - this._lastTick >= TICK_MS) {
        this._lastTick = now;
        // Wrapped defensively, same as GuitarTuner._tick() -- an uncaught
        // error here would happen before the rAF call below runs, silently
        // ending the loop for good (mic stays open, marker just freezes).
        try {
          this._analyse(now);
        } catch (err) {
          console.error("PlayAlongDetector tick error:", err);
        }
      }
      this.rafId = requestAnimationFrame(() => this._tick());
    }

    _analyse(now) {
      this.analyser.getFloatFrequencyData(this.freqBuffer);
      const binHz = this.audioCtx.sampleRate / this.analyser.fftSize;
      const raw = new Array(12).fill(0);
      const minBin = Math.max(1, Math.floor(MIN_HZ / binHz));
      const maxBin = Math.min(this.freqBuffer.length - 1, Math.ceil(MAX_HZ / binHz));
      for (let i = minBin; i <= maxBin; i++) {
        const db = this.freqBuffer[i];
        if (db < -90) continue; // effectively silent bin
        const amp = Math.pow(10, db / 20);
        const freq = i * binHz;
        const midi = 69 + 12 * Math.log2(freq / 440);
        const pc = ((Math.round(midi) % 12) + 12) % 12;
        raw[pc] += amp;
      }
      for (let i = 0; i < 12; i++) this.chroma[i] = this.chroma[i] * SMOOTH + raw[i] * (1 - SMOOTH);
      const energy = raw.reduce((a, b) => a + b, 0);
      if (energy < NOISE_FLOOR) return; // nobody's playing right now
      this._feed(now);
    }

    stop() {
      this.listening = false;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.source) {
        try {
          this.source.disconnect();
        } catch (err) {
          /* already disconnected */
        }
      }
      if (this.analyser) {
        try {
          this.analyser.disconnect();
        } catch (err) {
          /* already disconnected */
        }
      }
      if (this.audioCtx && this.ownsContext) this.audioCtx.close();
      this.audioCtx = null;
      this.analyser = null;
      this.source = null;
      this.stream = null;
    }
  }

  window.PlayAlongEngine = { PlayAlongDetector };
})();
