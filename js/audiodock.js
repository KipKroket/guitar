// Guitar — shared floating "audio source" dock: a small pill that holds the
// Spotify and backing-track buttons (js/spotify.js, js/backingtrack.js),
// sitting just above the autoscroll FAB. It owns nothing about either
// source itself -- only the pill container, showing/hiding it in step with
// the lyrics panel (see the "songsheetexpand" event dispatched by
// js/songsheet.js, the same signal the FAB already reacts to), and making
// sure only one source's panel is open at a time.
(function () {
  let dock = null;
  let openId = null;
  let openPanelEl = null;
  let openCloseFn = null;
  let outsideHandler = null;
  let ctx = { song: null, inst: null };

  function ensureDock() {
    if (dock) return dock;
    dock = document.createElement("div");
    dock.className = "audio-dock";
    dock.hidden = true;
    (document.querySelector(".app") || document.body).appendChild(dock);
    return dock;
  }

  function notify() {
    document.dispatchEvent(new CustomEvent("audiodockpanelchange", { detail: { openId } }));
  }

  function closePanel() {
    if (openCloseFn) {
      try {
        openCloseFn();
      } catch (e) {
        /* best effort -- a source's own stop() shouldn't be able to wedge this */
      }
    }
    if (openPanelEl && openPanelEl.parentNode) openPanelEl.remove();
    openPanelEl = null;
    openCloseFn = null;
    const wasOpen = openId;
    openId = null;
    if (outsideHandler) {
      document.removeEventListener("pointerdown", outsideHandler, true);
      outsideHandler = null;
    }
    if (wasOpen) notify();
  }

  // Opening a second source's panel implicitly closes the first (calling its
  // stop callback) -- Spotify and a backing track are never meant to play at
  // once. Tapping the same source's button again just closes it.
  function togglePanel(id, buildFn, onCloseFn) {
    if (openId === id) {
      closePanel();
      return false;
    }
    closePanel();
    const panelEl = buildFn();
    ensureDock().appendChild(panelEl);
    openId = id;
    openPanelEl = panelEl;
    openCloseFn = onCloseFn || null;
    notify();
    // Registered after this click finishes bubbling (same trick as the
    // autoscroll FAB menu) so the tap that opened the panel doesn't also
    // close it via the outside handler.
    setTimeout(() => {
      if (openId !== id) return;
      outsideHandler = (ev) => {
        if (!ev.target.closest || !ev.target.closest(".audio-dock")) closePanel();
      };
      document.addEventListener("pointerdown", outsideHandler, true);
    }, 0);
    return true;
  }

  document.addEventListener("songsheetexpand", (e) => {
    const d = e.detail || {};
    ctx = { song: d.song || null, inst: d.inst || null };
    const show = Boolean(d.expanded && d.hasLyrics);
    if (!show) {
      closePanel();
      ensureDock().hidden = true;
      return;
    }
    ensureDock().hidden = false;
  });

  window.GuitarAudioDock = {
    registerButton(el) {
      ensureDock().appendChild(el);
    },
    togglePanel,
    closePanel,
    getContext: () => ctx,
  };
})();
