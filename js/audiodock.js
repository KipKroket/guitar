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
//    once a source actually has something cued or playing. Rather than
//    floating another card above the pill, it takes over the bottom nav's
//    own spot (a child of .bottom-nav, inset:0) and hides the nav buttons
//    underneath -- the nav isn't needed while something's playing, and this
//    way the bar never has to fight the lyrics for space either. See the
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
    // A child of .bottom-nav -- see the .audio-dock CSS comment: bottom:100%
    // of the nav itself needs no JS-measured height to stay clear of it.
    (document.querySelector(".bottom-nav") || document.querySelector(".app") || document.body).appendChild(dock);
    return dock;
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.className = "audio-dock__bar";
    bar.hidden = true;
    const nav = document.querySelector(".bottom-nav");
    (nav || document.querySelector(".app") || document.body).appendChild(bar);
    return bar;
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
        // The autoscroll FAB lives outside .audio-dock (it's its own
        // sibling element) -- without this, tapping it to turn on
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
    const nav = document.querySelector(".bottom-nav");
    if (nav) nav.classList.add("has-nowplaying");
    barId = id;
    barCloseFn = onCloseFn || null;
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
    const nav = document.querySelector(".bottom-nav");
    if (nav) nav.classList.remove("has-nowplaying");
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

  // Shared drag-to-seek wiring for the now-playing bar's progress track --
  // both js/spotify.js and js/backingtrack.js want the same tap-or-drag
  // scrubbing behaviour, so it lives here once instead of twice. Returns
  // `{ isDragging }` so the caller's own periodic position updates (from a
  // player_state_changed event, a polling interval, ...) know to skip
  // writing to the fill/time while the user's finger is still on it --
  // otherwise the live position would fight the drag preview every tick.
  function wireSeekBar(progressEl, fillEl, timeEl, opts) {
    let dragging = false;

    function fracFromEvent(e) {
      const rect = progressEl.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    }
    function preview(frac) {
      fillEl.style.width = frac * 100 + "%";
      if (timeEl && opts.formatTime) timeEl.textContent = opts.formatTime(frac * (opts.getDuration() || 0));
    }
    function end(e) {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      const dur = opts.getDuration() || 0;
      if (dur) opts.onSeek(fracFromEvent(e) * dur);
    }
    function onMove(e) {
      if (dragging) preview(fracFromEvent(e));
    }

    progressEl.addEventListener("pointerdown", (e) => {
      if (!opts.getDuration()) return; // nothing loaded yet -- ignore stray taps
      dragging = true;
      preview(fracFromEvent(e));
      // On document, not progressEl -- a drag's pointermove/pointerup routinely
      // ends up outside the (thin) track once the finger moves at all.
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", end);
    });

    return { isDragging: () => dragging };
  }

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
    wireSeekBar,
  };
})();
