// Guitar — YouTube backing track, in the audio dock (js/audiodock.js).
//
// Paste a YouTube link once, it's saved on the song (js/library.js's
// setSongField -- same field it uses for favorite/learning, so it rides
// along with sync/backup) and from then on the button just opens a small
// player. Audio only in spirit -- the embedded player is kept small rather
// than hidden outright, since YouTube's own terms expect an actual visible
// player, not a hidden background one.
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
  function destroyPlayer() {
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

  function buildLinkForm(song, panel) {
    const wrap = el("div", "audio-dock__form");
    wrap.appendChild(el("p", "audio-dock__hint", "Plak een YouTube-link naar de backing track."));
    const input = el("input", "custom-song__input");
    input.type = "url";
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
      panel.textContent = "";
      panel.appendChild(buildPlayer(song, panel));
    });
    wrap.appendChild(save);
    setTimeout(() => input.focus(), 30);
    return wrap;
  }

  function buildPlayer(song, panel) {
    const wrap = el("div", "audio-dock__player-wrap");
    const mount = el("div", "audio-dock__player");
    wrap.appendChild(mount);

    const status = el("p", "audio-dock__status", "Laden…");
    wrap.appendChild(status);

    const actions = el("div", "audio-dock__player-actions");
    const change = el("button", "songsheet__btn songsheet__btn--sm", "Andere link");
    change.type = "button";
    change.addEventListener("click", () => {
      destroyPlayer();
      panel.textContent = "";
      panel.appendChild(buildLinkForm(song, panel));
    });
    actions.appendChild(change);
    wrap.appendChild(actions);

    const videoId = extractVideoId(song.backingTrackUrl);
    if (!videoId) {
      status.textContent = "Deze link ziet er niet meer geldig uit.";
      status.classList.add("audio-dock__status--error");
      return wrap;
    }

    loadYtApi().then((YT) => {
      destroyPlayer();
      ytPlayer = new YT.Player(mount, {
        videoId,
        width: "100%",
        height: "150",
        playerVars: { playsinline: 1 },
        events: {
          onReady: () => {
            status.hidden = true;
          },
          onError: () => {
            status.hidden = false;
            status.classList.add("audio-dock__status--error");
            status.textContent = "Deze video kan niet worden afgespeeld.";
          },
        },
      });
    });

    return wrap;
  }

  function buildPanel(song) {
    const panel = el("div", "audio-dock__panel");
    panel.appendChild(song.backingTrackUrl ? buildPlayer(song, panel) : buildLinkForm(song, panel));
    return panel;
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
      if (window.GuitarSpotify) window.GuitarSpotify.stop();
      window.GuitarAudioDock.togglePanel("backingtrack", () => buildPanel(ctx.song), () => {
        stop();
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
