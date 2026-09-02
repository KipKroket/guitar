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

// Autocorrelation pitch detector (ACF2+), operating on a Float32Array buffer.
// Returns frequency in Hz, or -1 if no clear pitch found.
function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // too quiet

  let r1 = 0, r2 = SIZE - 1;
  const threshold = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < threshold) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < threshold) { r2 = SIZE - i; break; }
  }

  const trimmed = buffer.slice(r1, r2);
  const n = trimmed.length;
  const c = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    for (let i = 0; i < n - lag; i++) {
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
  }
  let T0 = maxPos;

  // Parabolic interpolation for sub-sample precision
  if (T0 > 0 && T0 < n - 1) {
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) T0 = T0 - b / (2 * a);
  }

  if (T0 <= 0) return -1;
  return sampleRate / T0;
}

// Guitar strings are harmonic-rich -- especially thinner, brighter high
// strings -- which can fool a simple autocorrelation peak-picker into
// locking onto a harmonic or sub-harmonic of the true pitch instead of the
// fundamental (e.g. finding the 4th harmonic of an open high E, ~1320Hz,
// instead of the actual 330Hz string pitch). Left uncorrected, a reading
// like that either shows a wildly wrong note or -- if it happens to fall
// outside the accepted 30-1200Hz range -- gets silently discarded every
// single frame, which looks like "this string isn't detected at all".
// When we know which string the user is tuning to, we can correct for
// this: test the raw detected pitch against a few small integer
// multiples/divisors and snap to whichever lands closest to the expected
// note. This only fixes octave-type errors -- it never nudges the actual
// cents reading toward "in tune", so real mistuning still shows correctly.
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
      let freq = autoCorrelate(this.buffer, this.audioCtx.sampleRate);
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
