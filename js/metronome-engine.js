// Guitar — Metronome engine
// Classic Web Audio "lookahead" scheduler (see Chris Wilson, "A Tale of Two
// Clocks") so tempo stays sample-accurate instead of drifting the way a
// plain setInterval click would. The UI layer (metronome.js) drives visuals
// off the exact audioContext times this schedules, not off the JS timer.

class MetronomeEngine {
  constructor() {
    this.audioCtx = null;
    this.gain = null;
    this.bpm = 100;
    this.beatsPerBar = 4;
    this.running = false;
    this.currentBeatInBar = 0;
    this.nextNoteTime = 0;

    this.lookaheadMs = 25;       // how often the scheduler wakes up
    this.scheduleAheadS = 0.1;   // how far ahead (seconds) notes get queued
    this.timerId = null;

    this.onSchedule = null; // (beatInBar, time) -- called the instant a click is queued

    // Optional extras, all off by default (the Tools metronome uses none):
    this.wave = "sine";     // oscillator shape -- "square" cuts through music far better
    this.volume = 0.9;      // master gain; above 1 only makes sense with the limiter
    this.limiter = false;   // soft ceiling so a boosted volume doesn't clip
    this.toneFor = null;    // (clickNumber since start) -> { freq, peak, len } to override one click
    this.clickCount = 0;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  _ensureCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.volume;
      if (this.limiter) {
        const lim = this.audioCtx.createDynamicsCompressor();
        lim.threshold.value = -3;
        lim.knee.value = 0;
        lim.ratio.value = 20;
        lim.attack.value = 0.001;
        lim.release.value = 0.05;
        this.gain.connect(lim).connect(this.audioCtx.destination);
      } else {
        this.gain.connect(this.audioCtx.destination);
      }
    }
  }

  setBpm(bpm) {
    this.bpm = Math.max(30, Math.min(300, Math.round(bpm)));
  }

  setBeatsPerBar(n) {
    this.beatsPerBar = Math.max(1, n);
    this.currentBeatInBar = 0;
  }

  isRunning() {
    return this.running;
  }

  start(onSchedule) {
    this._ensureCtx();
    if (this.audioCtx.state === "suspended") this.audioCtx.resume();
    this.onSchedule = onSchedule;
    this.running = true;
    this.currentBeatInBar = 0;
    this.clickCount = 0;
    this.nextNoteTime = this.audioCtx.currentTime + 0.05;
    this._scheduler();
  }

  stop() {
    this.running = false;
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = null;
  }

  _scheduleClick(beatInBar, time) {
    const isAccent = beatInBar === 0;
    const custom = this.toneFor ? this.toneFor(this.clickCount) : null;
    this.clickCount++;
    const freq = custom ? custom.freq : isAccent ? 1560 : 1040;
    const peak = custom ? custom.peak : isAccent ? 1 : 0.55;
    const len = custom ? custom.len : 0.05;
    const osc = this.audioCtx.createOscillator();
    const clickGain = this.audioCtx.createGain();
    osc.type = this.wave;
    osc.frequency.value = freq;

    clickGain.gain.setValueAtTime(0, time);
    clickGain.gain.linearRampToValueAtTime(peak, time + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + len);

    osc.connect(clickGain).connect(this.gain);
    osc.start(time);
    osc.stop(time + len + 0.01);

    if (this.onSchedule) this.onSchedule(beatInBar, time);
  }

  _scheduler() {
    if (!this.running) return;
    while (this.nextNoteTime < this.audioCtx.currentTime + this.scheduleAheadS) {
      this._scheduleClick(this.currentBeatInBar, this.nextNoteTime);
      const secondsPerBeat = 60.0 / this.bpm;
      this.nextNoteTime += secondsPerBeat;
      this.currentBeatInBar = (this.currentBeatInBar + 1) % this.beatsPerBar;
    }
    this.timerId = setTimeout(() => this._scheduler(), this.lookaheadMs);
  }
}

window.GuitarMetronomeEngine = { MetronomeEngine };
