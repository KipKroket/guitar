// Guitar — shared floating "audio source" dock: a small pill that holds the
// Spotify and backing-track buttons (js/spotify.js, js/backingtrack.js),
// sitting just above the autoscroll FAB. It owns nothing about either
// source itself -- only:
//  - the pill container, showing/hiding it in step with the lyrics panel
//    (see the "songsheetexpand" event dispatched by js/songsheet.js, the
//    same signal the FAB already reacts to), and making sure only one
//    source's *setup popover* is open at a time (login prompt / paste-a-
//    link form -- see togglePanel/closePanel);
//  - the persistent now-playing bar (showNowPlaying/hideNowPlaying), shown
//    once a source actually has something cued or playing. It's a separate,
//    always-full-width element rather than another popover, specifically so
//    playback controls never sit as a card on top of the lyrics -- see the
//    .audio-dock__bar comment in style.css.
(function () {
  let dock = null;
  let openId = null;
  let openPanelEl = null;
  let openCloseFn = null;
  let outsideHandler = null;
  let ctx = { song: null, inst: null };

  let bar = null;
  let barId = null;
  let barCloseFn = null;

  function ensureDock() {
    if (dock) return dock;
    dock = document.createElement("div");
    dock.className = "audio-dock";
    dock.hidden = true;
    (document.querySelector(".app") || document.body).appendChild(dock);
    return dock;
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.className = "audio-dock__bar";
    bar.hidden = true;
    (document.querySelector(".app") || document.body).appendChild(bar);
    // Mirrors js/app.js's --bottom-nav-h: the FAB and dock pill need to know
    // how tall the bar is (0 when hidden) so they can shift up and clear it.
    if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(bar);
    return bar;
  }

  function syncBarHeight() {
    const h = bar && !bar.hidden ? bar.getBoundingClientRect().height + 8 : 0;
    document.documentElement.style.setProperty("--nowplaying-h", h + "px");
  }

  // One event for both "a setup popover is open" and "this source is now
  // playing" -- each dock button just wants to know which id (if any) it
  // should highlight as active, not which of the two states that is.
  function notify() {
    document.dispatchEvent(
      new CustomEvent("audiodockpanelchange", { detail: { openId: openId || barId } })
    );
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
        if (!ev.target.closest) return;
        // The autoscroll FAB lives outside .audio-dock (it's anchored to
        // .app, not this pill) -- without this, tapping it to turn on
        // autoscroll read as "click outside" and closed + stopped whatever
        // was playing here, which is its own separate control.
        if (ev.target.closest(".audio-dock") || ev.target.closest(".songsheet__fab")) return;
        closePanel();
      };
      document.addEventListener("pointerdown", outsideHandler, true);
    }, 0);
    return true;
  }

  // Replaces the now-playing bar's content and shows it. Switching source
  // (or the setup popover taking over -- see closePanel above) tears down
  // the previous one via its own onCloseFn first, same contract as
  // togglePanel.
  function showNowPlaying(id, contentEl, onCloseFn) {
    if (barId && barId !== id) hideNowPlaying();
    closePanel(); // a setup popover and the bar are never shown at once
    const b = ensureBar();
    b.textContent = "";
    b.appendChild(contentEl);
    b.hidden = false;
    barId = id;
    barCloseFn = onCloseFn || null;
    syncBarHeight();
    notify();
  }

  function hideNowPlaying() {
    if (barCloseFn) {
      try {
        barCloseFn();
      } catch (e) {
        /* best effort, same as closePanel */
      }
    }
    barCloseFn = null;
    const wasPlaying = barId;
    barId = null;
    if (bar) {
      bar.hidden = true;
      bar.textContent = "";
    }
    syncBarHeight();
    if (wasPlaying) notify();
  }

  document.addEventListener("songsheetexpand", (e) => {
    const d = e.detail || {};
    ctx = { song: d.song || null, inst: d.inst || null };
    const show = Boolean(d.expanded && d.hasLyrics);
    if (!show) {
      closePanel();
      hideNowPlaying();
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
    showNowPlaying,
    hideNowPlaying,
    isNowPlaying: (id) => barId === id,
    getContext: () => ctx,
  };
})();
