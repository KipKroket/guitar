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
  }

  _ensureCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = 0.9;
      this.gain.connect(this.audioCtx.destination);
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
    const osc = this.audioCtx.createOscillator();
    const clickGain = this.audioCtx.createGain();
    osc.frequency.value = isAccent ? 1560 : 1040;

    clickGain.gain.setValueAtTime(0, time);
    clickGain.gain.linearRampToValueAtTime(isAccent ? 1 : 0.55, time + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

    osc.connect(clickGain).connect(this.gain);
    osc.start(time);
    osc.stop(time + 0.06);

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
