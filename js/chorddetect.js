// Guitar — chord-CHANGE-detection engine for the songsheet "Play along" mode
// (js/songsheet.js). Doesn't try to recognise which chord is sounding at
// all -- it just listens for the live sound becoming meaningfully
// different from whatever was sounding a moment ago, and advances the step
// pointer through the song's own progression on that signal alone,
// regardless of which chords are actually being played.
//
// This replaced an earlier version that scored the live sound against the
// specific chord expected next (cosine similarity against a small set of
// chord-tone templates). That worked in principle but missed often in
// practice -- a phone mic plus a plain FFT chroma vector isn't reliable
// enough at telling two *specific* chords apart. "Did the sound change at
// all" is a much easier question, and it's all the pointer actually needs:
// the song's own chord list already says what comes next, so all that's
// missing is *when* to move on.
//
// The one thing this approach has to guard against: a strum's pick attack
// always looks "different" from whatever was sustaining a moment before,
// even when it's the *same* chord being re-strummed. So "different" is
// never decided from a single reading -- a candidate has to read
// consistently different from the settled baseline for DWELL_MS before
// it's accepted as a real change, which is long enough for a pick attack's
// transient to have decayed into the new sustain (or, on a same-chord
// restrum, back into essentially the old one) either way.
(function () {
  const MIN_HZ = 70; // just under open low E (~82Hz), with headroom
  const MAX_HZ = 1300; // a couple of guitar-range harmonics; cuts off hiss
  const CHANGE_THRESHOLD = 0.85; // cosine similarity BELOW this = "different from the baseline" (0.5 was so strict that e.g. G->C, which share tones, never registered)
  const SAME_CANDIDATE = 0.85; // a new reading this similar to the pending candidate counts as "still the same candidate"
  const NOISE_FLOOR = 0.002; // this tick's total chroma energy below this = "not playing"
  const DWELL_MS = 200; // how long a candidate must read consistently different before it counts
  const TICK_MS = 120; // analysis cadence, throttled inside the rAF loop
  const SMOOTH = 0.5; // chroma exponential-smoothing factor (0 = none)

  function normalise(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    const len = Math.sqrt(sum);
    if (len < 1e-9) return vec.map(() => 0);
    return vec.map((v) => v / len);
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
  // Still needed here even though this detector no longer looks at chord
  // *symbols* at all: without it, two consecutive identical-chord steps
  // would be unreachable -- nothing about the actual sound changes between
  // them, so a "does the sound differ" detector could never tell the song
  // moved on to the second one.
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
      this.index = 0;
      // The settled sound to compare new readings against -- null until
      // the first real (non-silent) reading establishes one.
      this.baseline = null;
      // A reading that currently looks different from the baseline, and
      // since when -- only promoted to the new baseline (and an advance)
      // once it's held for DWELL_MS straight.
      this.candidateVec = null;
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
    // pointer and drop the baseline, so whatever's sounding right after the
    // tap is learned fresh instead of being compared to (and likely read as
    // "different" from) whatever was playing before the jump.
    jumpTo(index) {
      this.index = Math.max(0, Math.min(this.steps.length - 1, index));
      this.baseline = null;
      this.candidateVec = null;
    }

    _feed(now, liveVec) {
      if (!this.baseline) {
        this.baseline = liveVec;
        this.candidateVec = null;
        return;
      }
      const similarity = cosine(liveVec, this.baseline);
      if (similarity >= CHANGE_THRESHOLD) {
        // Still reads as the same sound as the baseline -- nothing brewing.
        this.candidateVec = null;
        return;
      }
      // A reading that differs from the baseline but ALSO from the pending
      // candidate is still a moving target (attack transient, chord still
      // ringing in) -- restart the dwell on it instead of counting it toward
      // the old candidate.
      if (!this.candidateVec || cosine(liveVec, this.candidateVec) < SAME_CANDIDATE) {
        this.candidateVec = liveVec;
        this.candidateSince = now;
        return;
      }
      if (now - this.candidateSince >= DWELL_MS) {
        this.baseline = liveVec;
        this.candidateVec = null;
        if (this.index < this.steps.length - 1) {
          this.index += 1;
          if (this.onStep) this.onStep(this.index);
        }
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
      // Nobody's playing right now -- leave the baseline and any candidate
      // alone rather than feeding silence in as "different", so a pause
      // between chords doesn't itself register as a change once playing
      // resumes.
      if (energy < NOISE_FLOOR) return;
      this._feed(now, normalise(this.chroma));
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
