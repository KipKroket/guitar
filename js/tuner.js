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
// Returns frequency in Hz, or -1 if no clear pitch found.
//
// This replaced a plain autocorrelation peak-picker (ACF2+). That detector
// had a systematic *sharp* bias that grew as the note got lower -- an
// in-tune low E read about +10 cents, low A about +8, D about +6 -- because
// a short 2048-sample window only holds a few periods of a bass note and
// the broad autocorrelation peak gets pulled toward zero lag. The practical
// effect was severe: a perfectly tuned E/A/D string sat permanently just
// outside the +/-5-cent confirm window, so the tuner would flash "almost
// there" forever and never advance to the next string, while an actually
// flat string could read close enough to get wrongly confirmed. The NSDF
// is self-normalising, so its peak lands on the true period with well under
// a cent of bias no matter how few periods are in the window, and the
// height of that peak (0..1, the "clarity") is a dependable gate for
// "is this a pitched sound at all" -- far better than a bare RMS threshold.
const MPM_FMIN = 60;          // Hz -- below the lowest string we ever target (73 Hz, drop/open tunings)
const MPM_FMAX = 440;         // Hz -- above the highest (330 Hz) with headroom
const MPM_CLARITY_MIN = 0.5;  // reject noise, room tone, the pick "thunk" -- anything without a real period
const MPM_PEAK_RATIO = 0.9;   // the first NSDF hump reaching this fraction of the tallest hump wins
                              // (this is what rejects octave-down / sub-harmonic locks)
const MPM_RMS_GATE = 0.006;   // was 0.01 on the old detector -- lowered so a string that has
                              // already decayed partway through its ring still registers

function mpmDetect(buffer, sampleRate) {
  const SIZE = buffer.length;

  // Remove DC / very-low-frequency drift first: a non-zero mean skews the
  // NSDF normalisation and biases the period estimate.
  let mean = 0;
  for (let i = 0; i < SIZE; i++) mean += buffer[i];
  mean /= SIZE;

  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const v = buffer[i] - mean;
    rms += v * v;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < MPM_RMS_GATE) return -1;

  const maxLag = Math.min(SIZE - 2, Math.floor(sampleRate / MPM_FMIN));
  const minLag = Math.max(2, Math.floor(sampleRate / MPM_FMAX));

  // cumSq[k] = sum of (buffer[i]-mean)^2 for i in [0, k) -- lets the NSDF
  // denominator for each lag be computed in O(1).
  const cumSq = new Float64Array(SIZE + 1);
  for (let i = 0; i < SIZE; i++) {
    const v = buffer[i] - mean;
    cumSq[i + 1] = cumSq[i] + v * v;
  }
  const totalSq = cumSq[SIZE];

  // NSDF over the useful lag range only -- for guitar that's ~100..735
  // samples, so this is actually less work than the old full O(n^2) ACF.
  const nsdf = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i < SIZE - lag; i++) {
      ac += (buffer[i] - mean) * (buffer[i + lag] - mean);
    }
    const denom = (cumSq[SIZE - lag] - cumSq[0]) + (totalSq - cumSq[lag]);
    nsdf[lag] = denom > 0 ? (2 * ac) / denom : 0;
  }

  // Take the local maximum of each positive hump of the NSDF.
  const humps = [];
  let l = minLag;
  while (l <= maxLag && nsdf[l] > 0) l++; // skip a partial hump sitting at the start of the range
  while (l <= maxLag) {
    while (l <= maxLag && nsdf[l] <= 0) l++;
    let humpMax = -1, humpArg = -1;
    while (l <= maxLag && nsdf[l] > 0) {
      if (nsdf[l] > humpMax) { humpMax = nsdf[l]; humpArg = l; }
      l++;
    }
    if (humpArg !== -1) humps.push({ arg: humpArg, val: humpMax });
  }
  if (humps.length === 0) return -1;

  let globalMax = 0;
  for (const h of humps) if (h.val > globalMax) globalMax = h.val;
  if (globalMax < MPM_CLARITY_MIN) return -1;

  const threshold = MPM_PEAK_RATIO * globalMax;
  let chosen = humps[0];
  for (const h of humps) {
    if (h.val >= threshold) { chosen = h; break; }
  }
  const peakLag = chosen.arg;
  if (peakLag <= 0) return -1;

  // Parabolic interpolation around the chosen NSDF peak for a sub-sample period.
  let period = peakLag;
  if (peakLag > minLag && peakLag < maxLag) {
    const y1 = nsdf[peakLag - 1], y2 = nsdf[peakLag], y3 = nsdf[peakLag + 1];
    const a = (y1 + y3 - 2 * y2) / 2;
    const b = (y3 - y1) / 2;
    if (a !== 0) period = peakLag - b / (2 * a);
  }
  if (period <= 0) return -1;
  return sampleRate / period;
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

class GuitarTuner {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    this.rafId = null;
    this.buffer = null;
    this.onUpdate = null; // callback({frequency, note, octave, cents})
    this.listening = false;
    this.targetFrequency = null; // expected frequency of the string being tuned, used for octave correction
  }

  // Called by the app whenever the active tuning target (string) changes,
  // so the detector can correct octave-lock errors against the right note.
  setTargetFrequency(freq) {
    this.targetFrequency = freq || null;
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
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
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
      let freq = mpmDetect(this.buffer, this.audioCtx.sampleRate);
      if (freq !== -1) freq = correctOctaveError(freq, this.targetFrequency);
      if (freq !== -1 && freq > 30 && freq < 1200) {
        const note = freqToNote(freq);
        this.onUpdate({ frequency: freq, ...note });
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
    if (this.source) { try { this.source.disconnect(); } catch (err) { /* already disconnected */ } }
    if (this.analyser) { try { this.analyser.disconnect(); } catch (err) { /* already disconnected */ } }
    // Only close the context if we created it ourselves -- a shared
    // context is owned by the caller and may still be in use elsewhere
    // (reference tones, chime, metronome).
    if (this.audioCtx && this.ownsContext) this.audioCtx.close();
    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
  }
}

window.GuitarTunerEngine = { GuitarTuner, TUNINGS, freqToNote };
