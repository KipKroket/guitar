// Guitar — YouTube backing track, in the audio dock (js/audiodock.js).
//
// Paste a YouTube link once, it's saved on the song (js/library.js's
// setSongField -- same field it uses for favorite/learning, so it rides
// along with sync/backup) and from then on the button just plays it in the
// persistent now-playing bar. Native YouTube chrome is turned off
// (playerVars.controls) in favour of the same slim play/pause + seek row
// the Spotify bar uses -- YouTube's terms still expect an actual visible
// player rather than a hidden background one, so the video stays on
// screen, just as a small thumbnail instead of a large embed sitting over
// the lyrics.
(function () {
  const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

  function extractVideoId(url) {
    const m = String(url || "").match(VIDEO_ID_RE);
    return m ? m[1] : null;
  }

  let ytApiPromise = null;
  function loadYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
      const prevCb = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prevCb) prevCb();
        resolve(window.YT);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
    return ytApiPromise;
  }

  let ytPlayer = null;
  let progressTimer = null;
  function stopProgressTimer() {
    if (progressTimer != null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }
  function destroyPlayer() {
    stopProgressTimer();
    if (ytPlayer) {
      try {
        ytPlayer.destroy();
      } catch (e) {
        /* already gone */
      }
      ytPlayer = null;
    }
  }
  function stop() {
    if (ytPlayer && ytPlayer.pauseVideo) {
      try {
        ytPlayer.pauseVideo();
      } catch (e) {
        /* not ready yet -- nothing playing to stop */
      }
    }
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  // Setup-only popover: paste/replace the link. Shown when there's no link
  // yet, and reachable again via the pencil icon on the now-playing bar to
  // swap in a different one.
  function buildLinkForm(song) {
    const wrap = el("div", "audio-dock__panel");
    wrap.appendChild(el("p", "audio-dock__hint", "Plak een YouTube-link naar de backing track."));
    const input = el("input", "custom-song__input");
    input.type = "url";
    input.value = song.backingTrackUrl || "";
    input.placeholder = "https://youtube.com/watch?v=…";
    wrap.appendChild(input);
    const error = el("p", "audio-dock__status audio-dock__status--error", "");
    error.hidden = true;
    wrap.appendChild(error);
    const save = el("button", "songsheet__btn songsheet__btn--primary", "Opslaan");
    save.type = "button";
    save.addEventListener("click", () => {
      const url = input.value.trim();
      const id = extractVideoId(url);
      if (!id) {
        error.textContent = "Geen geldige YouTube-link.";
        error.hidden = false;
        return;
      }
      song.backingTrackUrl = url;
      if (window.GuitarLibrary && window.GuitarLibrary.setSongField) {
        window.GuitarLibrary.setSongField(song.id, { backingTrackUrl: url });
      }
      window.GuitarAudioDock.showNowPlaying("backingtrack", buildNowPlayingBar(song), () => {
        destroyPlayer();
      });
    });
    wrap.appendChild(save);
    setTimeout(() => input.focus(), 30);
    return wrap;
  }

  // The persistent now-playing bar (js/audiodock.js's showNowPlaying) --
  // same shape as Spotify's: small thumbnail, play/pause, tap-to-seek
  // progress, time, plus a pencil (change link) and a close button.
  function buildNowPlayingBar(song) {
    const bar = document.createDocumentFragment();

    const mount = el("div", "audio-dock__bar-video");
    bar.appendChild(mount);

    const status = el("p", "audio-dock__bar-status", "Laden…");
    bar.appendChild(status);

    const playPause = el("button", "audio-dock__playpause", "");
    playPause.type = "button";
    playPause.setAttribute("aria-label", "Play/pause");
    playPause.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>';
    playPause.hidden = true;
    bar.appendChild(playPause);

    const progress = el("div", "audio-dock__progress");
    const progressFill = el("div", "audio-dock__progress-fill");
    progress.appendChild(progressFill);
    progress.hidden = true;
    bar.appendChild(progress);

    const time = el("span", "audio-dock__time", "0:00");
    time.hidden = true;
    bar.appendChild(time);

    const editBtn = el("button", "audio-dock__bar-edit", "");
    editBtn.type = "button";
    editBtn.setAttribute("aria-label", "Andere link");
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    editBtn.addEventListener("click", () => {
      // Just a transient popover over the still-playing bar -- cancelling it
      // (tap outside) shouldn't tear down the video that's already going.
      window.GuitarAudioDock.togglePanel("backingtrack", () => buildLinkForm(song), null);
    });
    bar.appendChild(editBtn);

    const close = el("button", "audio-dock__bar-close", "");
    close.type = "button";
    close.setAttribute("aria-label", "Stoppen");
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.addEventListener("click", () => window.GuitarAudioDock.hideNowPlaying());
    bar.appendChild(close);

    const videoId = extractVideoId(song.backingTrackUrl);
    if (!videoId) {
      status.textContent = "Deze link ziet er niet meer geldig uit.";
      status.classList.add("audio-dock__bar-status--error");
      return bar;
    }

    let dur = 0;
    const seekBar = window.GuitarAudioDock.wireSeekBar(progress, progressFill, time, {
      getDuration: () => dur,
      onSeek: (sec) => ytPlayer && ytPlayer.seekTo(sec, true),
      formatTime: (sec) => formatTime(sec) + " / " + formatTime(dur),
    });
    function renderPlaying(isPlaying) {
      playPause.classList.toggle("is-playing", isPlaying);
      playPause.innerHTML = isPlaying
        ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="7" y="5.5" width="4" height="13" fill="currentColor"/><rect x="14" y="5.5" width="4" height="13" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>';
    }
    function tick() {
      if (!ytPlayer || !ytPlayer.getCurrentTime) return;
      dur = ytPlayer.getDuration() || dur;
      if (seekBar.isDragging()) return; // don't fight the drag preview
      const pos = ytPlayer.getCurrentTime() || 0;
      progressFill.style.width = (dur ? Math.min(100, (pos / dur) * 100) : 0) + "%";
      time.textContent = formatTime(pos) + " / " + formatTime(dur);
    }

    playPause.addEventListener("click", () => {
      if (!ytPlayer) return;
      const state = ytPlayer.getPlayerState();
      if (state === window.YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
    });

    loadYtApi().then((YT) => {
      destroyPlayer();
      ytPlayer = new YT.Player(mount, {
        videoId,
        width: "100%",
        height: "100%",
        // autoplay:0 -- opening the bar cues the video, playback only
        // starts once the play button is actually tapped.
        playerVars: { playsinline: 1, controls: 0, autoplay: 0, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            status.hidden = true;
            playPause.hidden = false;
            progress.hidden = false;
            time.hidden = false;
            tick(); // duration (and 0:00) is available as soon as it's cued, not just once playing starts
          },
          onStateChange: (e) => {
            const playing = e.data === YT.PlayerState.PLAYING;
            renderPlaying(playing);
            if (playing) {
              stopProgressTimer();
              progressTimer = setInterval(tick, 400);
              tick();
            } else {
              stopProgressTimer();
            }
          },
          onError: () => {
            stopProgressTimer();
            status.hidden = false;
            status.classList.add("audio-dock__bar-status--error");
            status.textContent = "Deze video kan niet worden afgespeeld.";
            playPause.hidden = true;
            progress.hidden = true;
            time.hidden = true;
          },
        },
      });
    });

    return bar;
  }

  const YOUTUBE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21.6 7.2c-.25-1-1-1.75-2-2C17.9 4.7 12 4.7 12 4.7s-5.9 0-7.6.5c-1 .25-1.75 1-2 2C2 8.9 2 12 2 12s0 3.1.4 4.8c.25 1 1 1.75 2 2 1.7.5 7.6.5 7.6.5s5.9 0 7.6-.5c1-.25 1.75-1 2-2 .4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8Z"/><path fill="#fff" d="M10 9.3v5.4l4.6-2.7Z"/></svg>';

  if (window.GuitarAudioDock) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "audio-dock__btn";
    btn.setAttribute("aria-label", "Backing track");
    btn.innerHTML = YOUTUBE_SVG;
    btn.addEventListener("click", () => {
      const ctx = window.GuitarAudioDock.getContext();
      if (!ctx.song) return;
      if (window.GuitarAudioDock.isNowPlaying("backingtrack")) {
        window.GuitarAudioDock.hideNowPlaying(); // tapping again stops it
        return;
      }
      if (window.GuitarSpotify) window.GuitarSpotify.stop();
      if (!ctx.song.backingTrackUrl) {
        window.GuitarAudioDock.togglePanel("backingtrack", () => buildLinkForm(ctx.song), null);
        return;
      }
      window.GuitarAudioDock.showNowPlaying("backingtrack", buildNowPlayingBar(ctx.song), () => {
        destroyPlayer();
      });
    });
    document.addEventListener("audiodockpanelchange", (e) => {
      btn.classList.toggle("is-active", e.detail && e.detail.openId === "backingtrack");
    });
    window.GuitarAudioDock.registerButton(btn);
  }

  window.GuitarBackingTrack = { stop };
})();
