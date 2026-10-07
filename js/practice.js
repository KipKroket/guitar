// Guitar — "Practice" source for the song screen: a metronome with a count-in
// bar that stands in for a recording. It has its own clock, so js/songsheet.js
// treats it like Spotify / YouTube (getPosition / isPlaying / seekTo) and the
// lyrics follow the same LRCLIB timing -- you just play the song yourself.
//
// The clock runs on the audio clock (audioCtx.currentTime) that also times the
// clicks, so the click and the highlight can't drift apart. Play = a count-in
// bar of clicks, then the song clock starts at its current position (0:00, so
// the song's own intro is played along with too).
(function () {
  const BEATS = 4;
  const CLICK_KEY = "guitar-practice-click";
  const DEFAULT_BPM = 100;

  let engine = null;
  let song = null;
  let bpm = DEFAULT_BPM;
  let clickDuring = loadClickPref();
  let running = false; // count-in or song running
  let basePos = 0; // ms the song clock starts from after the count-in
  let startAt = null; // audio time of the downbeat the song starts on
  let clickTimes = []; // audio times of the count-in clicks
  let scheduled = 0;
  let ticker = null;

  function loadClickPref() {
    try {
      return localStorage.getItem(CLICK_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }
  function saveClickPref() {
    try {
      localStorage.setItem(CLICK_KEY, clickDuring ? "1" : "0");
    } catch (e) {
      /* fine to just not remember it */
    }
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function formatTime(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function ensureEngine() {
    if (!engine) {
      engine = new window.GuitarMetronomeEngine.MetronomeEngine();
      engine.setBeatsPerBar(BEATS);
    }
    return engine;
  }
  // What's audible right now, in audio-clock seconds (output latency removed).
  function audibleNow() {
    const ctx = engine && engine.audioCtx;
    if (!ctx) return 0;
    return ctx.currentTime - (ctx.outputLatency || 0);
  }

  function getPosition() {
    if (!running || startAt == null) return basePos;
    const now = audibleNow();
    return now < startAt ? basePos : basePos + (now - startAt) * 1000;
  }

  function begin() {
    ensureEngine();
    engine.setBpm(bpm);
    scheduled = 0;
    startAt = null;
    clickTimes = [];
    running = true;
    engine.start((beat, time) => {
      if (!running) return;
      if (scheduled < BEATS) clickTimes.push(time);
      else if (scheduled === BEATS) {
        // The downbeat after the count-in bar: the song starts here.
        startAt = time;
        if (!clickDuring) engine.stop();
      }
      scheduled++;
    });
  }

  function pause() {
    if (!running) return;
    basePos = getPosition();
    running = false;
    startAt = null;
    if (engine) engine.stop();
  }

  function togglePlay() {
    if (running) pause();
    else begin();
  }

  function seekTo(ms) {
    basePos = Math.max(0, ms);
    // Mid-song: jump on the spot, no new count-in.
    if (running && startAt != null) startAt = audibleNow();
  }

  // The sheet has played through to the end: stop and rewind.
  function finish() {
    pause();
    basePos = 0;
  }

  function setBpm(v) {
    bpm = Math.max(30, Math.min(300, Math.round(v)));
    if (engine) engine.setBpm(bpm);
    if (song) {
      song.practiceBpm = bpm;
      if (window.GuitarLibrary && window.GuitarLibrary.setSongField) {
        window.GuitarLibrary.setSongField(song.id, { practiceBpm: bpm });
      }
    }
  }

  function startingBpm(s) {
    if (s && s.practiceBpm) return s.practiceBpm;
    const lib = window.GuitarLibrary;
    const fromLib = lib && lib.getDetailBpm && lib.getDetailBpm();
    return fromLib ? Math.round(fromLib) : DEFAULT_BPM;
  }

  const ICON_PLAY =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="7" y="5.5" width="4" height="13" fill="currentColor"/><rect x="14" y="5.5" width="4" height="13" fill="currentColor"/></svg>';
  const ICON_METRONOME =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 3h6l3.5 17.5h-13Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 15.5 15.5 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function stopTicker() {
    if (ticker != null) {
      clearInterval(ticker);
      ticker = null;
    }
  }
  function teardown() {
    pause();
    basePos = 0;
    stopTicker();
    song = null;
  }

  // BPM and "click during the song" live in a small popover over the bar.
  function buildPanel(onBpm) {
    const wrap = el("div", "audio-dock__panel");
    const head = el("div", "audio-dock__speed-head");
    head.appendChild(el("span", null, "Tempo"));
    const val = el("span", "audio-dock__speed-val", bpm + " BPM");
    head.appendChild(val);
    wrap.appendChild(head);

    const row = el("div", "practice__row");
    const minus = el("button", "audio-dock__bar-speed", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", "Slower");
    const plus = el("button", "audio-dock__bar-speed", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Faster");
    const slider = el("input");
    slider.type = "range";
    slider.min = "40";
    slider.max = "220";
    slider.step = "1";
    slider.value = String(bpm);
    function apply(v) {
      setBpm(v);
      slider.value = String(bpm);
      val.textContent = bpm + " BPM";
      onBpm();
    }
    minus.addEventListener("click", () => apply(bpm - 1));
    plus.addEventListener("click", () => apply(bpm + 1));
    slider.addEventListener("input", () => apply(parseInt(slider.value, 10)));
    row.appendChild(minus);
    row.appendChild(slider);
    row.appendChild(plus);
    wrap.appendChild(row);

    const label = el("label", "practice__check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = clickDuring;
    box.addEventListener("change", () => {
      clickDuring = box.checked;
      saveClickPref();
      // Switching it on mid-song: the scheduler stopped after the count-in.
      if (clickDuring && running && startAt != null && engine && !engine.isRunning()) {
        engine.start(() => {});
      }
    });
    label.appendChild(box);
    label.appendChild(el("span", null, "Keep clicking during the song"));
    wrap.appendChild(label);
    wrap.appendChild(el("p", "audio-dock__hint", "Press play: one count-in bar, then the lyrics follow the song's timing."));
    return wrap;
  }

  function buildBar() {
    const bar = document.createDocumentFragment();
    const dock = window.GuitarAudioDock;

    const icon = el("div", "audio-dock__bar-icon");
    icon.innerHTML = ICON_METRONOME;
    bar.appendChild(icon);

    const playPause = el("button", "audio-dock__playpause");
    playPause.type = "button";
    playPause.setAttribute("aria-label", "Play/pause");
    bar.appendChild(playPause);

    const status = el("p", "audio-dock__bar-status", "");
    bar.appendChild(status);

    const bpmBtn = el("button", "audio-dock__bar-speed");
    bpmBtn.type = "button";
    bpmBtn.setAttribute("aria-label", "Tempo");
    bpmBtn.addEventListener("click", () => {
      dock.togglePanel("practice", () => buildPanel(refresh), null);
    });
    bar.appendChild(bpmBtn);

    const close = el("button", "audio-dock__bar-close");
    close.type = "button";
    close.setAttribute("aria-label", "Stop");
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.addEventListener("click", () => dock.hideNowPlaying());
    bar.appendChild(close);

    function refresh() {
      bpmBtn.textContent = bpm + " BPM";
      playPause.innerHTML = running ? ICON_PAUSE : ICON_PLAY;
      playPause.classList.toggle("is-playing", running);
      let text;
      const now = audibleNow();
      if (running && (startAt == null || now < startAt)) {
        const heard = clickTimes.filter((t) => t <= now).length;
        text = heard ? "Count-in " + Math.min(heard, BEATS) : "Get ready…";
      } else if (running) {
        text = formatTime(getPosition());
      } else {
        text = basePos > 0 ? formatTime(basePos) + " · paused" : "Press play";
      }
      if (status.textContent !== text) status.textContent = text;
    }
    playPause.addEventListener("click", () => {
      togglePlay();
      refresh();
    });
    refresh();
    stopTicker();
    ticker = setInterval(refresh, 100);
    return bar;
  }

  if (window.GuitarAudioDock) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "audio-dock__btn";
    btn.setAttribute("aria-label", "Practice with metronome");
    btn.innerHTML = ICON_METRONOME + "<span>Practice</span>";
    btn.addEventListener("click", () => {
      const dock = window.GuitarAudioDock;
      const ctx = dock.getContext();
      if (!ctx.song) return;
      if (dock.isNowPlaying("practice")) {
        dock.hideNowPlaying(); // tapping again stops it
        return;
      }
      if (window.GuitarSpotify) window.GuitarSpotify.stop();
      song = ctx.song;
      bpm = startingBpm(song);
      basePos = 0;
      running = false;
      dock.showNowPlaying("practice", buildBar(), teardown);
    });
    document.addEventListener("audiodockpanelchange", (e) => {
      btn.classList.toggle("is-active", e.detail && e.detail.openId === "practice");
    });
    window.GuitarAudioDock.registerButton(btn, "practice");
  }

  window.GuitarPractice = {
    getPosition,
    getSourceKey: () => "practice",
    getDuration: () => 0,
    isPlaying: () => running,
    togglePlay,
    pause,
    finish,
    seekTo,
  };
})();
