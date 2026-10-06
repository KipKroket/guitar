// Guitar — shared audio sources for the song screen: the Spotify and
// backing-track buttons (js/spotify.js, js/backingtrack.js) and the now-
// playing bar. Everything lives inside the song screen's own transport
// container (#song-transport), above the autoscroll / Aa row that
// js/songsheet.js draws there -- nothing floats over the lyrics any more. It
// owns nothing about either source itself, only:
//  - the "sources" card: opened by the ♪ button in the transport row, it
//    lists the sources, and also hosts a source's setup popover (login prompt /
//    paste-a-link form) -- only one is open at a time (togglePanel/closePanel);
//  - the now-playing bar (showNowPlaying/hideNowPlaying), shown once a source
//    actually has something cued or playing. It sits directly above the
//    transport row.
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

  function container() {
    return document.getElementById("song-transport") || document.querySelector(".app") || document.body;
  }

  function ensureDock() {
    if (dock) return dock;
    dock = document.createElement("div");
    dock.className = "audio-dock";
    dock.hidden = true;
    container().appendChild(dock);
    return dock;
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.className = "audio-dock__bar";
    bar.hidden = true;
    container().appendChild(bar);
    return bar;
  }

  // Whether the sources card is open (the ♪ button), and whether the sheet is
  // in a state where audio makes sense at all (it has lyrics).
  let sourcesOpen = false;
  let canShow = false;

  function refreshDock() {
    const d = ensureDock();
    d.hidden = !(canShow && (sourcesOpen || openId));
    // A popover opened from the now-playing bar (playback speed, change
    // link) shows on its own, without the list of sources.
    d.classList.toggle("is-panel-only", !sourcesOpen);
  }

  // One event for both "a setup popover is open" and "this source is now
  // playing" -- each dock button just wants to know which id (if any) it
  // should highlight as active, not which of the two states that is.
  function notify() {
    document.dispatchEvent(
      new CustomEvent("audiodockpanelchange", { detail: { openId: openId || barId, sourcesOpen } })
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
    refreshDock();
    if (sourcesOpen) armOutsideHandler(); // the card itself is still open
    if (wasOpen) notify();
  }

  // The ♪ button in the transport row.
  function toggleSources() {
    if (!canShow) return;
    if (sourcesOpen || openId) {
      sourcesOpen = false;
      closePanel();
      refreshDock();
      notify();
      return;
    }
    sourcesOpen = true;
    refreshDock();
    armOutsideHandler();
    notify();
  }

  // Closes the sources card (and any popover) when you tap anywhere that
  // isn't the card, the transport's own buttons or the now-playing bar.
  function armOutsideHandler() {
    if (outsideHandler) document.removeEventListener("pointerdown", outsideHandler, true);
    setTimeout(() => {
      if (!(sourcesOpen || openId)) return;
      outsideHandler = (ev) => {
        if (!ev.target.closest) return;
        if (ev.target.closest(".audio-dock") || ev.target.closest(".transport__btn") || ev.target.closest(".ui-sheet")) return;
        sourcesOpen = false;
        closePanel();
        refreshDock();
        notify();
      };
      document.addEventListener("pointerdown", outsideHandler, true);
    }, 0);
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
    refreshDock();
    notify();
    armOutsideHandler();
    return true;
  }

  // Replaces the now-playing bar's content and shows it. Switching source
  // (or the setup popover taking over -- see closePanel above) tears down
  // the previous one via its own onCloseFn first, same contract as
  // togglePanel.
  function showNowPlaying(id, contentEl, onCloseFn) {
    if (barId && barId !== id) hideNowPlaying();
    sourcesOpen = false;
    closePanel(); // a setup popover and the bar are never shown at once
    const b = ensureBar();
    b.textContent = "";
    b.appendChild(contentEl);
    b.hidden = false;
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
    if (wasPlaying) notify();
  }

  document.addEventListener("songsheetexpand", (e) => {
    const d = e.detail || {};
    ctx = { song: d.song || null, inst: d.inst || null };
    canShow = Boolean(d.expanded && d.hasLyrics);
    if (!canShow) {
      sourcesOpen = false;
      closePanel();
      hideNowPlaying();
      refreshDock();
      return;
    }
    refreshDock();
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
    toggleSources,
    isActive: () => !!(sourcesOpen || openId || barId),
    showNowPlaying,
    hideNowPlaying,
    isNowPlaying: (id) => barId === id,
    getContext: () => ctx,
    wireSeekBar,
  };
})();
