// Guitar — Tuner module
// Client-side pitch detection via autocorrelation (ACF2+), no server involved.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const TUNINGS = {
  standard:     { label: "Standard",       strings: [82.41, 110.00, 146.83, 196.00, 246.94, 329.63] },
  dropD:        { label: "Drop D",         strings: [73.42, 110.00, 146.83, 196.00, 246.94, 329.63] },
  openG:        { label: "Open G",         strings: [73.42, 98.00, 146.83, 196.00, 246.94, 293.66] },
  openD:        { label: "Open D",         strings: [73.42, 110.00, 146.83, 185.00, 220.00, 293.66] },
  halfStepDown: { label: "Half Step Down", strings: [77.78, 103.83, 138.59, 185.00, 233.08, 311.13] },
};

function freqToNote(frequency) {
  const A4 = 440;
  const semitonesFromA4 = 12 * Math.log2(frequency / A4);
  const rounded = Math.round(semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - rounded) * 100);
  const noteIndex = (rounded + 9 + 120) % 12; // A is index 9 in NOTE_NAMES(C-based)
  const octave = 4 + Math.floor((rounded + 9) / 12);
  return { name: NOTE_NAMES[noteIndex], octave, cents, midiOffset: rounded };
}

// Pitch detector: McLeod Pitch Method (MPM) on the Normalised Square
// Difference Function (NSDF), operating on a Float32Array buffer.
// Returns { freq, clarity, rms }; freq is -1 when there is no clear pitch.
//
// Build 55 rework -- the old version ran on the raw 48 kHz mic signal with a
// 2048-sample (~43 ms) window. Simulated plucks through that exact code showed
// a per-frame spread of ~3 cents with 12-30% of frames more than 3 cents off,
// even on a perfectly steady string: broadband mic noise and the pick/string
// hiss land straight in the NSDF, and the weak tail of a decaying note
// wandered +/-5-10 cents while still passing the 0.5 clarity gate. That is
// the "every pluck reads a bit different" effect. Now:
//   * the signal is band-passed upstream (Web Audio biquads tracking the
//     target string, ~1.5x-6x its fundamental -- see BANDPASS_* below),
//     which strips the noise, the fundamental itself and the high partials;
//   * it is then decimated here (48k -> 12k), which makes a 4096-sample
//     (~85 ms, 7+ periods of low E) window *cheaper* than the old 2048 one;
//   * clarity is interpolated at the peak and returned, so the caller can
//     demand a confident reading instead of a bare "some period exists".
// Same simulation afterwards: spread ~0.2-0.3 cents, 0% of frames >3 cents off.
// On real recordings (Juul's guitar, iPhone mic, Sept 2026) the within-note
// spread on A/D/G went from ~2.5 cents to ~0.5-1.2 cents.
const MPM_FMIN = 60;          // Hz -- below the lowest string we ever target (73 Hz, drop/open tunings)
const MPM_FMAX = 440;         // Hz -- above the highest (330 Hz) with headroom
const MPM_CLARITY_MIN = 0.8;  // confident, clean period only (was 0.5 -- let noisy decay tails through)
const MPM_PEAK_RATIO = 0.9;   // the first NSDF hump reaching this fraction of the tallest hump wins
                              // (this is what rejects octave-down / sub-harmonic locks)
const MPM_RMS_GATE = 0.002;   // measured after the low-pass, which removes most of the energy of a
                              // bright pluck -- clarity is the real "is it a note" gate now
const DECIMATE_TARGET_RATE = 12000; // Hz -- plenty for <=1 kHz content after the low-pass

function mpmDetect(input, inputRate) {
  const D = Math.max(1, Math.round(inputRate / DECIMATE_TARGET_RATE));
  const SIZE = Math.floor(input.length / D);
  const sampleRate = inputRate / D;
  const NONE = { freq: -1, clarity: 0, rms: 0 };

  // Decimate (boxcar average of D samples -- a last bit of anti-aliasing on
  // top of the upstream low-pass) and remove DC in one pass.
  const buffer = new Float64Array(SIZE);
  let mean = 0;
  for (let i = 0; i < SIZE; i++) {
    let acc = 0;
    for (let k = 0; k < D; k++) acc += input[i * D + k];
    buffer[i] = acc / D;
    mean += buffer[i];
  }
  mean /= SIZE;
  // cumSq[k] = sum of buffer[i]^2 for i in [0, k) -- NSDF denominator in O(1) per lag.
  const cumSq = new Float64Array(SIZE + 1);
  for (let i = 0; i < SIZE; i++) {
    buffer[i] -= mean;
    cumSq[i + 1] = cumSq[i] + buffer[i] * buffer[i];
  }
  const totalSq = cumSq[SIZE];
  const rms = Math.sqrt(totalSq / SIZE);
  NONE.rms = rms;
  if (rms < MPM_RMS_GATE) return NONE;

  const maxLag = Math.min(SIZE - 3, Math.floor(sampleRate / MPM_FMIN));
  const minLag = Math.max(2, Math.floor(sampleRate / MPM_FMAX));

  // NSDF from lag 1 (not minLag) so the hump-finder sees the real edge of
  // the zero-lag lobe -- see git history (Build <=54) for the high-E story.
  const nsdf = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let ac = 0;
    for (let i = 0; i < SIZE - lag; i++) ac += buffer[i] * buffer[i + lag];
    const denom = cumSq[SIZE - lag] + (totalSq - cumSq[lag]);
    nsdf[lag] = denom > 0 ? (2 * ac) / denom : 0;
  }

  // Local maximum of each positive hump whose peak lies in the valid range.
  const humps = [];
  let l = 1;
  while (l <= maxLag) {
    while (l <= maxLag && nsdf[l] <= 0) l++;
    let humpMax = -1, humpArg = -1;
    while (l <= maxLag && nsdf[l] > 0) {
      if (nsdf[l] > humpMax) { humpMax = nsdf[l]; humpArg = l; }
      l++;
    }
    if (humpArg !== -1 && humpArg >= minLag) humps.push({ arg: humpArg, val: humpMax });
  }
  if (humps.length === 0) return NONE;

  let globalMax = 0;
  for (const h of humps) if (h.val > globalMax) globalMax = h.val;
  if (globalMax < MPM_CLARITY_MIN) return NONE;

  const threshold = MPM_PEAK_RATIO * globalMax;
  let chosen = humps[0];
  for (const h of humps) {
    if (h.val >= threshold) { chosen = h; break; }
  }
  const peakLag = chosen.arg;

  // Parabolic interpolation around the chosen NSDF peak: sub-sample period
  // plus the interpolated peak height (the clarity of this reading).
  let period = peakLag;
  let clarity = chosen.val;
  const y1 = nsdf[peakLag - 1], y2 = nsdf[peakLag], y3 = nsdf[peakLag + 1];
  const a = (y1 + y3 - 2 * y2) / 2;
  const b = (y3 - y1) / 2;
  if (a < 0) {
    period = peakLag - b / (2 * a);
    clarity = y2 - (b * b) / (4 * a);
  }
  if (period <= 0 || clarity < MPM_CLARITY_MIN) return NONE;
  return { freq: sampleRate / period, clarity: Math.min(1, clarity), rms };
}

// Guitar strings are harmonic-rich -- especially thinner, brighter high
// strings -- which can still occasionally fool the period-picker into
// locking onto a harmonic or sub-harmonic of the true pitch instead of the
// fundamental (e.g. an NSDF hump at the 2nd harmonic of an inharmonic low
// string, or the 4th harmonic of an open high E, ~1320Hz, instead of the
// actual 330Hz string pitch). Left uncorrected, a reading like that either
// shows a wildly wrong note or -- if it happens to fall outside the accepted
// 30-1200Hz range -- gets silently discarded every single frame, which looks
// like "this string isn't detected at all". When we know which string the
// user is tuning to, we can correct for this: test the raw detected pitch
// against a few small integer multiples/divisors and snap to whichever lands
// closest to the expected note. This only fixes octave-type errors -- it
// never nudges the actual cents reading toward "in tune", so real mistuning
// still shows correctly.
const OCTAVE_CANDIDATE_RATIOS = [1, 2, 0.5, 3, 1 / 3, 4, 1 / 4];
function correctOctaveError(freq, expectedFreq) {
  if (!expectedFreq) return freq;
  let best = freq;
  let bestCentsAbs = Math.abs(1200 * Math.log2(freq / expectedFreq));
  for (const ratio of OCTAVE_CANDIDATE_RATIOS) {
    const candidate = freq * ratio;
    const centsAbs = Math.abs(1200 * Math.log2(candidate / expectedFreq));
    if (centsAbs < bestCentsAbs) {
      bestCentsAbs = centsAbs;
      best = candidate;
    }
  }
  return best;
}

// Turns the stream of per-frame readings (in cents vs. the target string)
// into what the UI shows and decides. Pure logic, no DOM/audio, so it can be
// tested offline against simulated plucks.
//
// Why this exists: a plucked string physically starts *sharp* -- the extra
// tension of the big initial swing raises the pitch by a few cents (more for
// a harder pluck) and it glides back down over roughly half a second. The old
// app logic confirmed after 500 ms within +/-5 cents of a smoothed value, so
// it largely judged that glide: a hard pluck read differently from a soft
// one, and a slightly-flat string could get confirmed on its sharp attack.
// Now a string only counts as in tune once the readings over a short window
// are *steady*: small spread and no remaining drift.
const STAB_WINDOW_MS = 400;        // readings considered for the steadiness test
const STAB_MIN_SPAN_MS = 250;      // window must actually cover this much time
const STAB_MIN_READINGS = 10;
const STAB_MAX_SPREAD = 3;         // cents, p90 - p10 across the window
const STAB_MAX_SLOPE = 6;          // cents/second -- still gliding if faster
const STAB_OUTLIER_CENTS = 60;     // octave slips / stray locks are far outside this
const STAB_OUTLIER_RESEED = 8;     // ...unless they persist: then the pitch really moved
const STAB_DISPLAY_MEDIAN = 5;     // needle = median of the last few readings...
const STAB_DISPLAY_SMOOTHING = 0.3; // ...then lightly smoothed

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

class PitchStabilizer {
  constructor() { this.reset(); }

  reset() {
    this.window = [];      // {t, c}
    this.display = null;
    this.outlierStreak = 0;
  }

  // A fresh pluck: forget the previous note's readings for the steadiness
  // test (the new note glides on its own), but keep the needle where it is.
  newNote() {
    this.window = [];
    this.outlierStreak = 0;
  }

  push(cents, t) {
    const w = this.window;
    while (w.length && t - w[0].t > STAB_WINDOW_MS) w.shift();

    if (w.length >= 3) {
      const med = median(w.map((r) => r.c));
      if (Math.abs(cents - med) > STAB_OUTLIER_CENTS) {
        this.outlierStreak++;
        if (this.outlierStreak < STAB_OUTLIER_RESEED) return this.state();
        w.length = 0; // it wasn't an outlier, the pitch genuinely moved
      }
    }
    this.outlierStreak = 0;
    w.push({ t, c: cents });

    const recent = w.slice(-STAB_DISPLAY_MEDIAN).map((r) => r.c);
    const target = median(recent);
    this.display = this.display === null || Math.abs(target - this.display) > STAB_OUTLIER_CENTS
      ? target
      : this.display + STAB_DISPLAY_SMOOTHING * (target - this.display);
    return this.state();
  }

  state() {
    const w = this.window;
    if (this.display === null || w.length === 0) return null;
    const cs = w.map((r) => r.c);
    const sorted = [...cs].sort((a, b) => a - b);
    const med = quantile(sorted, 0.5);
    let stable = false;
    let spread = Infinity, slope = Infinity;
    if (w.length >= STAB_MIN_READINGS && w[w.length - 1].t - w[0].t >= STAB_MIN_SPAN_MS) {
      spread = quantile(sorted, 0.9) - quantile(sorted, 0.1);
      // least-squares slope in cents per second
      const n = w.length;
      let mt = 0, mc = 0;
      for (const r of w) { mt += r.t; mc += r.c; }
      mt /= n; mc /= n;
      let num = 0, den = 0;
      for (const r of w) { num += (r.t - mt) * (r.c - mc); den += (r.t - mt) ** 2; }
      slope = den > 0 ? (num / den) * 1000 : 0;
      stable = spread <= STAB_MAX_SPREAD && Math.abs(slope) <= STAB_MAX_SLOPE;
    }
    return { display: this.display, median: med, stable, spread, slope };
  }
}

// Band-pass tracking the target string: keep partials 2..~6, drop the rest.
// Why drop the fundamental: in real recordings it is the *least* reliable
// part of the sound. A phone mic barely picks up a low E's fundamental, and
// the A string's fundamental (110 Hz) sits right on the guitar body's air
// resonance (~100 Hz), which pulls it: measured at -25 cents while every
// harmonic of the same note sat at -7. A low-pass-only version of this
// rework (keeping the fundamental) read that A string 6 cents flatter than
// the old detector and jumped around more. Partials 2..6 still repeat once
// per fundamental period, so the NSDF still finds the true period (and
// correctOctaveError catches the rare lock onto the 2nd partial's period).
const BANDPASS_LOW_RATIO = 1.5;
const BANDPASS_HIGH_RATIO = 6;
const BANDPASS_DEFAULT_HZ = [60, 2000]; // no target known yet
const ONSET_RMS_RATIO = 1.3;    // frame RMS jumping by this much = a (re)pluck

class GuitarTuner {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.filters = [];
    this.stream = null;
    this.rafId = null;
    this.buffer = null;
    this.onUpdate = null; // callback({frequency, note, octave, cents, clarity, msSinceOnset, onsetId}) or null
    this.listening = false;
    this.targetFrequency = null; // expected frequency of the string being tuned
    this.prevRms = 0;
    this.lastOnsetAt = 0;
    this.onsetId = 0;
  }

  // Called by the app whenever the active tuning target (string) changes:
  // used for octave correction and to retune the input low-pass.
  setTargetFrequency(freq) {
    this.targetFrequency = freq || null;
    this._applyFilterCutoff();
  }

  _applyFilterCutoff() {
    if (!this.audioCtx) return;
    const t = this.targetFrequency;
    const [lo, hi] = t ? [t * BANDPASS_LOW_RATIO, t * BANDPASS_HIGH_RATIO] : BANDPASS_DEFAULT_HZ;
    for (const f of this.filters) {
      f.frequency.setValueAtTime(f.type === "highpass" ? lo : hi, this.audioCtx.currentTime);
    }
  }

  // sharedCtx: an AudioContext to reuse instead of creating a new one.
  // Mobile browsers (iOS Safari in particular) can silently suspend one
  // AudioContext the moment a *second* one starts playing anything --
  // the mic stream stays open (OS mic indicator stays lit) but the
  // context never processes samples again, so the meter freezes for
  // good after the first reference tone or sample is played. Sharing a
  // single context between the tuner (mic) and the rest of the app
  // (reference tones, chime, metronome) avoids that conflict entirely.
  async start(onUpdate, sharedCtx) {
    this.onUpdate = onUpdate;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.ownsContext = !sharedCtx;
    this.audioCtx = sharedCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Safari (especially iOS) frequently creates/leaves the context in a
    // "suspended" state -- the mic stream is captured fine (the OS mic
    // indicator lights up), but the audio graph never actually processes
    // samples until resumed, so the meter silently never moves. Resume
    // explicitly rather than assuming "running".
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source = source;
    // Two cascaded 2nd-order high-passes + two low-passes (24 dB/octave
    // each side): the band-pass described above, which also anti-aliases
    // mpmDetect's decimation.
    this.filters = ["highpass", "highpass", "lowpass", "lowpass"].map((type) => {
      const f = this.audioCtx.createBiquadFilter();
      f.type = type;
      f.Q.value = 0.7071;
      return f;
    });
    this._applyFilterCutoff();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 4096; // ~85 ms at 48 kHz; decimated to 1024 samples before analysis
    let node = source;
    for (const f of this.filters) { node.connect(f); node = f; }
    node.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.prevRms = 0;
    this.lastOnsetAt = 0;
    this.listening = true;
    this._tick();
  }

  _tick() {
    if (!this.listening) return;
    // Wrapped defensively: an uncaught error in here would happen *before*
    // the requestAnimationFrame call below runs, silently ending the loop
    // for good (mic stays open, meter just stops forever). Catching and
    // logging keeps the loop alive even if a single frame's analysis fails.
    try {
      this.analyser.getFloatTimeDomainData(this.buffer);
      const r = mpmDetect(this.buffer, this.audioCtx.sampleRate);
      const now = performance.now();
      // Onset = the (filtered) level jumping up. While a pluck is still
      // sliding into the window this fires on several frames in a row, so
      // lastOnsetAt ends up at the *end* of the attack.
      if (r.rms > MPM_RMS_GATE && r.rms > this.prevRms * ONSET_RMS_RATIO) {
        if (now - this.lastOnsetAt > 150) this.onsetId++;
        this.lastOnsetAt = now;
      }
      this.prevRms = r.rms;

      let freq = r.freq;
      if (freq !== -1) freq = correctOctaveError(freq, this.targetFrequency);
      if (freq !== -1 && freq > 30 && freq < 1200) {
        const note = freqToNote(freq);
        this.onUpdate({
          frequency: freq,
          clarity: r.clarity,
          msSinceOnset: now - this.lastOnsetAt,
          onsetId: this.onsetId,
          ...note,
        });
      } else {
        this.onUpdate(null);
      }
    } catch (err) {
      console.error("GuitarTuner tick error:", err);
    }
    this.rafId = requestAnimationFrame(() => this._tick());
  }

  stop() {
    this.listening = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    for (const node of [this.source, ...this.filters, this.analyser]) {
      if (node) { try { node.disconnect(); } catch (err) { /* already disconnected */ } }
    }
    // Only close the context if we created it ourselves -- a shared
    // context is owned by the caller and may still be in use elsewhere
    // (reference tones, chime, metronome).
    if (this.audioCtx && this.ownsContext) this.audioCtx.close();
    this.audioCtx = null;
    this.analyser = null;
    this.filters = [];
    this.source = null;
    this.stream = null;
  }
}

window.GuitarTunerEngine = { GuitarTuner, PitchStabilizer, TUNINGS, freqToNote, mpmDetect, correctOctaveError };
