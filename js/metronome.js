// Guitar — Metronome page
(function () {
  const { MetronomeEngine } = window.GuitarMetronomeEngine;

  const SIGNATURES = ["2/4", "3/4", "4/4", "5/4", "6/8", "7/8"];
  const MIN_BPM = 30;
  const MAX_BPM = 300;
  const TAP_RESET_MS = 2000; // gap this long between taps starts a fresh tap sequence
  const TAP_MAX_SAMPLES = 8; // average over at most this many recent intervals

  const beatsInSignature = (sig) => parseInt(sig.split("/")[0], 10);

  /* ---------- Elements ---------- */
  const bpmInput = document.getElementById("metro-bpm-input");
  const bpmMinus = document.getElementById("metro-bpm-minus");
  const bpmPlus = document.getElementById("metro-bpm-plus");
  const tapButton = document.getElementById("metro-tap");
  const signatureSelect = document.getElementById("metro-signature");
  const beatsRow = document.getElementById("metro-beats");
  const toggleButton = document.getElementById("metro-toggle");
  const toggleLabel = document.getElementById("metro-toggle-label");
  const toggleIcon = document.getElementById("metro-toggle-icon");
  const needle = document.getElementById("metro-needle");

  const PLAY_ICON_D = "M8 5.5v13l11-6.5Z";
  const STOP_ICON_D = "M6.5 6.5h11v11h-11Z";

  /* ---------- State (persisted) ---------- */
  const engine = new MetronomeEngine();

  const savedBpm = parseInt(localStorage.getItem("guitar-metronome-bpm"), 10);
  let bpm = Number.isFinite(savedBpm) ? clampBpm(savedBpm) : 100;

  const savedSignature = localStorage.getItem("guitar-metronome-signature");
  let signature = SIGNATURES.includes(savedSignature) ? savedSignature : "4/4";

  function clampBpm(value) {
    return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(value)));
  }

  function persist() {
    localStorage.setItem("guitar-metronome-bpm", String(bpm));
    localStorage.setItem("guitar-metronome-signature", signature);
  }

  /* ---------- Beat dots ---------- */
  function renderBeatDots() {
    const count = beatsInSignature(signature);
    beatsRow.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const dot = document.createElement("span");
      dot.className = "beat-dot" + (i === 0 ? " accent" : "");
      beatsRow.appendChild(dot);
    }
  }

  function setActiveBeatDot(beatInBar) {
    const dots = beatsRow.children;
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle("active", i === beatInBar);
    }
  }

  /* ---------- BPM controls ---------- */
  function applyBpm(next, { restart = false } = {}) {
    bpm = clampBpm(next);
    bpmInput.value = bpm;
    engine.setBpm(bpm);
    persist();
    if (restart && engine.isRunning()) {
      // Let the next scheduled note pick up the new tempo naturally --
      // no need to stop/start, the scheduler reads engine.bpm live.
    }
  }

  bpmInput.value = bpm;
  bpmMinus.addEventListener("click", () => applyBpm(bpm - 1));
  bpmPlus.addEventListener("click", () => applyBpm(bpm + 1));

  bpmInput.addEventListener("change", () => {
    const parsed = parseInt(bpmInput.value, 10);
    applyBpm(Number.isFinite(parsed) ? parsed : bpm);
  });

  /* ---------- Tap tempo ---------- */
  let tapTimes = [];

  tapButton.addEventListener("click", () => {
    const now = performance.now();
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > TAP_RESET_MS) {
      tapTimes = [];
    }
    tapTimes.push(now);
    if (tapTimes.length > TAP_MAX_SAMPLES) tapTimes.shift();

    if (tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      applyBpm(60000 / avgMs);
    }
  });

  /* ---------- Time signature ---------- */
  signatureSelect.value = signature;
  renderBeatDots();

  signatureSelect.addEventListener("change", () => {
    signature = signatureSelect.value;
    engine.setBeatsPerBar(beatsInSignature(signature));
    renderBeatDots();
    persist();
  });

  /* ---------- Needle (classic swinging pendulum, in the app's own style) ---------- */
  const NEEDLE_SWING_DEG = 28;
  let swingRight = true;

  function flipNeedle(secondsPerBeat) {
    needle.style.transitionDuration = `${secondsPerBeat}s`;
    needle.style.transform = `rotate(${swingRight ? NEEDLE_SWING_DEG : -NEEDLE_SWING_DEG}deg)`;
    swingRight = !swingRight;
  }

  function resetNeedle() {
    needle.style.transitionDuration = "0.25s";
    needle.style.transform = "rotate(0deg)";
    swingRight = true;
  }

  /* ---------- Visual sync loop ----------
     The engine schedules clicks slightly ahead of when they actually sound
     (that's what makes the audio itself glitch-free). Visuals should flip
     exactly when a beat *sounds*, not when it's scheduled, so scheduled
     beats go into a small queue here and a rAF loop only acts on one once
     the audio clock actually reaches it. */
  let noteQueue = [];
  let lastDrawnBeat = -1;
  let rafId = null;

  function onSchedule(beatInBar, time) {
    noteQueue.push({ beatInBar, time });
  }

  function draw() {
    if (!engine.audioCtx) return;
    const now = engine.audioCtx.currentTime;
    let fired = null;
    while (noteQueue.length && noteQueue[0].time <= now) {
      fired = noteQueue.shift();
    }
    if (fired && fired.beatInBar !== lastDrawnBeat) {
      lastDrawnBeat = fired.beatInBar;
      flipNeedle(60 / bpm);
      setActiveBeatDot(fired.beatInBar);
    }
    rafId = requestAnimationFrame(draw);
  }

  /* ---------- Start / stop ---------- */
  function start() {
    engine.setBpm(bpm);
    engine.setBeatsPerBar(beatsInSignature(signature));
    noteQueue = [];
    lastDrawnBeat = -1;
    engine.start(onSchedule);
    rafId = requestAnimationFrame(draw);
    toggleButton.classList.add("is-listening");
    toggleButton.setAttribute("aria-pressed", "true");
    toggleLabel.textContent = "Stop";
    toggleIcon.setAttribute("d", STOP_ICON_D);
  }

  function stop() {
    engine.stop();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    noteQueue = [];
    resetNeedle();
    setActiveBeatDot(-1);
    toggleButton.classList.remove("is-listening");
    toggleButton.setAttribute("aria-pressed", "false");
    toggleLabel.textContent = "Start";
    toggleIcon.setAttribute("d", PLAY_ICON_D);
  }

  toggleButton.addEventListener("click", () => {
    if (engine.isRunning()) stop();
    else start();
  });

  // Stop cleanly if the person navigates away mid-tick.
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.target !== "metronome" && engine.isRunning()) stop();
    });
  });

  /* ---------- Hook for the future song library: "Play with metronome" ----------
     Library will call window.GuitarMetronome.playAtBpm(bpm[, signature]) to
     jump here with the song's tempo already dialed in and running. */
  window.GuitarMetronome = {
    playAtBpm(nextBpm, nextSignature) {
      if (nextSignature && SIGNATURES.includes(nextSignature)) {
        signature = nextSignature;
        signatureSelect.value = signature;
        engine.setBeatsPerBar(beatsInSignature(signature));
        renderBeatDots();
      }
      applyBpm(nextBpm);
      if (window.GuitarApp) window.GuitarApp.showPage("metronome");
      if (!engine.isRunning()) start();
    },
  };
})();
