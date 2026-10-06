// Guitar — Setlists: ordered groups of a few saved songs, for running
// through a whole set (rehearsal, a gig) without going back to the library
// between every song.
//
// Storage is its own pair of keys (guitar-setlists / piano-setlists), same
// per-instrument split as the library itself -- a setlist stores song IDS
// only, resolved against the current library at render time, so renaming a
// song's saved fields or removing it from the library just makes it quietly
// drop out of any setlist that referenced it (no dangling copies to keep in
// sync).
//
// Screens:
//   - the Setlists tab (#page-setlists)  every saved setlist as a card, "+" makes a new one
//   - #setlist-detail-overlay  one setlist's songs -- Play / Add songs, and a
//                              "..." menu for Reorder / Rename / Delete
//   - #setlist-add-overlay     picker: toggle songs already in your library,
//                              then "Save" to store the selection
// Exactly one of the two overlays (and library.js's own) is ever visible at a
// time -- opening one hides whichever else was open.
//
// Opening a song FROM a setlist reuses js/library.js's own openDetail() --
// the only thing this file changes about that screen is where "back" lands
// (see onDetailBack, wired into library.js's own back button) and, while a
// "Play setlist" session is running, a small prev/next control in the song
// screen's sub row (see setlist-playbar below).
(function () {
  const setlistsNewBtn = document.getElementById("setlists-new-btn");
  const setlistsListEl = document.getElementById("setlists-list");
  const setlistsEmptyEl = document.getElementById("setlists-empty");
  const setlistsCountEl = document.getElementById("setlists-count");
  if (!setlistsListEl) return;
  const newForm = document.getElementById("setlist-new-form");
  const newNameInput = document.getElementById("setlist-new-name");
  const newCancelBtn = document.getElementById("setlist-new-cancel");

  const slOverlay = document.getElementById("setlist-detail-overlay");
  const slBackBtn = document.getElementById("setlist-detail-back");
  const slTitleEl = document.getElementById("setlist-detail-title");
  const slMenuBtn = document.getElementById("setlist-detail-menu-btn");
  const renameForm = document.getElementById("setlist-rename-form");
  const renameInput = document.getElementById("setlist-rename-name");
  const renameCancelBtn = document.getElementById("setlist-rename-cancel");
  const slAddSongsBtn = document.getElementById("setlist-add-songs-btn");
  const slPlayBtn = document.getElementById("setlist-play-btn");
  const slOrganizeBtn = document.getElementById("setlist-organize-btn");
  const slDeleteConfirm = document.getElementById("setlist-delete-confirm");
  const slDeleteYesBtn = document.getElementById("setlist-delete-yes");
  const slDeleteNoBtn = document.getElementById("setlist-delete-no");
  const slListEl = document.getElementById("setlist-detail-list");
  const slEmptyEl = document.getElementById("setlist-detail-empty");

  const addOverlay = document.getElementById("setlist-add-overlay");
  const addBackBtn = document.getElementById("setlist-add-back");
  const addFilterInput = document.getElementById("setlist-add-filter");
  let saveBarEl = null;
  function setSaveBar(on) {
    const nav = document.querySelector(".bottom-nav");
    if (!nav) return;
    if (on && !saveBarEl) {
      saveBarEl = document.createElement("div");
      saveBarEl.className = "setlist-savebar";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "save-button";
      btn.textContent = "Save";
      btn.addEventListener("click", () => {
        if (openSetlistId && stagedIds) reorderSetlist(openSetlistId, stagedIds);
        leaveAddSongs();
      });
      saveBarEl.appendChild(btn);
      nav.appendChild(saveBarEl);
    }
    if (!on && saveBarEl) {
      saveBarEl.remove();
      saveBarEl = null;
    }
    nav.classList.toggle("has-savebar", on);
  }
  const addListEl = document.getElementById("setlist-add-list");
  const addEmptyEl = document.getElementById("setlist-add-empty");

  /* ---------------- Storage ---------------- */

  function currentInstrument() {
    return (window.GuitarApp && window.GuitarApp.getInstrument()) || document.body.dataset.instrument || "guitar";
  }
  function storageKey() {
    return currentInstrument() === "piano" ? "piano-setlists" : "guitar-setlists";
  }
  function readSetlists() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey()) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((s) => s && typeof s === "object" && s.id != null)
        .map((s) => ({ ...s, name: typeof s.name === "string" ? s.name : "Untitled", songIds: Array.isArray(s.songIds) ? s.songIds : [] }));
    } catch (e) {
      return [];
    }
  }
  function writeSetlists(list) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(list));
    } catch (e) {
      /* quota -- nothing sensible to do here for a personal tool */
    }
    document.dispatchEvent(new CustomEvent("userdatachange")); // cloud sync
  }
  function genId() {
    return "sl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function getSetlist(id) {
    return readSetlists().find((s) => s.id === id) || null;
  }
  function createSetlist(name) {
    const list = readSetlists();
    const entry = { id: genId(), name: name.trim() || "Untitled", songIds: [], updatedAt: Date.now() };
    list.push(entry);
    writeSetlists(list);
    return entry;
  }
  // Deletions leave a tombstone (like js/library.js) so cloud sync / a backup
  // file can't resurrect the setlist from another copy.
  function deleteSetlist(id) {
    const tombKey = currentInstrument() + "-setlists-tomb";
    try {
      const tombs = JSON.parse(localStorage.getItem(tombKey) || "[]").filter((t) => t && t.id !== id);
      tombs.push({ id, deletedAt: Date.now() });
      localStorage.setItem(tombKey, JSON.stringify(tombs));
    } catch (e) {
      /* corrupt/full storage -- deletion itself still goes through */
    }
    writeSetlists(readSetlists().filter((s) => s.id !== id));
  }
  function addSongToSetlist(setlistId, songId) {
    const list = readSetlists();
    const sl = list.find((s) => s.id === setlistId);
    if (!sl || sl.songIds.includes(songId)) return;
    sl.songIds.push(songId);
    sl.updatedAt = Date.now();
    writeSetlists(list);
  }
  function removeSongFromSetlist(setlistId, songId) {
    const list = readSetlists();
    const sl = list.find((s) => s.id === setlistId);
    if (!sl) return;
    sl.songIds = sl.songIds.filter((id) => id !== songId);
    sl.updatedAt = Date.now();
    writeSetlists(list);
  }
  function reorderSetlist(setlistId, newSongIds) {
    const list = readSetlists();
    const sl = list.find((s) => s.id === setlistId);
    if (!sl) return;
    sl.songIds = newSongIds;
    sl.updatedAt = Date.now();
    writeSetlists(list);
  }
  // Drops any id that no longer resolves to a real library song (removed
  // from the library since being added here) -- silently, rather than
  // pruning storage, in case it's a transient gap (e.g. mid-sync).
  function resolvedSongs(sl) {
    if (!sl || !window.GuitarLibrary) return [];
    return sl.songIds.map((id) => window.GuitarLibrary.getSong(id)).filter(Boolean);
  }

  /* ---------------- Navigation state ----------------
     At most one of these describes where a song's detail page (opened via
     js/library.js's own openDetail()) should send "back" to -- see
     onDetailBack(), wired into library.js's own back button. `playSession`
     takes priority over `returnTarget` since a "Play setlist" run can visit
     many songs one after another; the plain `returnTarget` is for the
     single-hop cases (tapped a song card, or just saved one via search). */
  let returnTarget = null; // { type: "setlist-detail" | "setlist-add", setlistId }
  let pendingSetlistId = null; // armed by "Search for a new song", consumed by notifySongSaved
  let openSetlistId = null; // whichever setlist #setlist-detail-overlay is currently showing
  let organizing = false;
  let playSession = null; // { setlistId, songs: [...], index }
  // Set around goToSong()'s own close+reopen of the detail overlay so the
  // songdetailchange listener below doesn't read that as "the user left",
  // which would otherwise end the very session that transition belongs to.
  let internalTransition = false;

  function anyOverlayOpen() {
    return !slOverlay.hidden || !addOverlay.hidden;
  }

  // Leaves every setlist overlay (not the Setlists tab itself, which is an
  // ordinary page) and drops any half-finished state.
  function closeAll() {
    slOverlay.hidden = true;
    addOverlay.hidden = true;
    newForm.hidden = true;
    renameForm.hidden = true;
    slDeleteConfirm.hidden = true;
    organizing = false;
    stagedIds = null;
    setSaveBar(false);
    openSetlistId = null;
    pendingSetlistId = null;
    returnTarget = null;
    endPlaySession();
    if (window.GuitarUI) window.GuitarUI.close();
  }

  /* ---------------- Setlists overview ---------------- */

  // Back on the Setlists tab, e.g. after leaving a setlist or deleting one.
  function openSetlistsOverview() {
    slOverlay.hidden = true;
    addOverlay.hidden = true;
    newForm.hidden = true;
    renderSetlistsList();
    if (window.GuitarApp && window.GuitarApp.getCurrentPage() !== "setlists") window.GuitarApp.showPage("setlists");
  }

  function renderSetlistsList() {
    const lists = readSetlists().sort((a, b) => b.updatedAt - a.updatedAt);
    setlistsListEl.textContent = "";
    setlistsEmptyEl.hidden = lists.length > 0;
    setlistsCountEl.textContent = lists.length === 0 ? "" : lists.length === 1 ? "1 setlist" : lists.length + " setlists";
    lists.forEach((sl) => {
      const songs = resolvedSongs(sl);
      const li = document.createElement("li");
      li.className = "setlist-card";

      // A small collage of the first few covers -- tells sets apart at a glance.
      const mosaic = document.createElement("span");
      mosaic.className = "setlist-card__mosaic";
      for (let i = 0; i < 4; i++) {
        const cell = document.createElement("i");
        const art = songs[i] && songs[i].artworkUrl;
        if (art) cell.style.backgroundImage = "url(\"" + art.replace(/"/g, "%22") + "\")";
        mosaic.appendChild(cell);
      }
      li.appendChild(mosaic);

      const text = document.createElement("span");
      text.className = "setlist-card__text";
      const title = document.createElement("b");
      title.textContent = sl.name;
      const sub = document.createElement("span");
      sub.textContent = sl.songIds.length === 1 ? "1 song" : sl.songIds.length + " songs";
      text.appendChild(title);
      text.appendChild(sub);
      li.appendChild(text);

      const chev = document.createElement("span");
      chev.className = "setlist-card__chev";
      chev.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      li.appendChild(chev);

      li.addEventListener("click", () => openSetlistDetail(sl.id));
      setlistsListEl.appendChild(li);
    });
  }

  setlistsNewBtn.addEventListener("click", () => {
    newForm.hidden = !newForm.hidden;
    if (!newForm.hidden) {
      newNameInput.value = "";
      newNameInput.focus();
    }
  });
  newCancelBtn.addEventListener("click", () => {
    newForm.hidden = true;
  });
  newForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = newNameInput.value.trim();
    if (!name) return;
    const sl = createSetlist(name);
    newForm.hidden = true;
    renderSetlistsList();
    openSetlistDetail(sl.id);
  });

  /* ---------------- One setlist ---------------- */

  function openSetlistDetail(setlistId) {
    if (!getSetlist(setlistId)) return;
    openSetlistId = setlistId;
    organizing = false;
    addOverlay.hidden = true;
    renameForm.hidden = true;
    slOverlay.hidden = false;
    renderSetlistDetail();
  }

  function renderSetlistDetail() {
    const sl = getSetlist(openSetlistId);
    if (!sl) {
      // Deleted from under us (or a stale id) -- fall back to the overview
      // rather than showing an empty, un-openable page.
      slOverlay.hidden = true;
      renderSetlistsList();
      return;
    }
    slTitleEl.textContent = sl.name;
    slDeleteConfirm.hidden = true;
    // While reordering, "Done" takes the place of Play / Add songs.
    slOrganizeBtn.hidden = !organizing;
    slAddSongsBtn.hidden = organizing;
    slPlayBtn.hidden = organizing;

    const songs = resolvedSongs(sl);
    slPlayBtn.disabled = songs.length === 0;
    slEmptyEl.hidden = songs.length > 0 || organizing;
    slListEl.textContent = "";
    if (organizing) {
      songs.forEach((song, idx) => slListEl.appendChild(renderOrganizeRow(sl.id, song, idx)));
    } else {
      // Tapping a song opens its lyrics & chords and carries on through the
      // rest of the setlist from there (prev/next in the playbar).
      songs.forEach((song, idx) => {
        slListEl.appendChild(
          window.GuitarLibrary.renderSongRow(song, {
            withFavStar: true,
            onOpen: () => startPlaySession(sl.id, songs, idx),
          })
        );
      });
    }
  }

  slBackBtn.addEventListener("click", () => {
    slOverlay.hidden = true;
    openSetlistId = null;
    organizing = false;
    renameForm.hidden = true;
    renderSetlistsList();
  });

  slOrganizeBtn.addEventListener("click", () => {
    organizing = false;
    renderSetlistDetail();
  });

  // Everything you do now and then to a setlist.
  slMenuBtn.addEventListener("click", () => {
    const sl = getSetlist(openSetlistId);
    if (!sl) return;
    const hasSongs = resolvedSongs(sl).length > 0;
    window.GuitarUI.openMenu(slMenuBtn, [
      {
        label: "Reorder songs",
        icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14M8 5 5 8M8 5l3 3M16 19V5M16 19l-3-3M16 19l3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        hidden: !hasSongs,
        onClick: () => {
          organizing = true;
          renderSetlistDetail();
        },
      },
      {
        label: "Rename",
        icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2V20z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
        onClick: () => {
          renameForm.hidden = false;
          renameInput.value = sl.name;
          renameInput.focus();
          renameInput.select();
        },
      },
      { divider: true },
      {
        label: "Delete setlist",
        icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 7h14M9 7V5.2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7m-8 0 .7 12.2a1 1 0 0 0 1 .8h6.600a1 1 0 0 0 1-.8L17 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
        danger: true,
        onClick: () => {
          slDeleteConfirm.hidden = false;
        },
      },
    ]);
  });

  renameCancelBtn.addEventListener("click", () => {
    renameForm.hidden = true;
  });
  renameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = renameInput.value.trim();
    if (!name || !openSetlistId) return;
    const list = readSetlists();
    const sl = list.find((x) => x.id === openSetlistId);
    if (!sl) return;
    sl.name = name;
    sl.updatedAt = Date.now();
    writeSetlists(list);
    renameForm.hidden = true;
    renderSetlistDetail();
  });
  slDeleteNoBtn.addEventListener("click", () => {
    slDeleteConfirm.hidden = true;
  });
  slDeleteYesBtn.addEventListener("click", () => {
    if (!openSetlistId) return;
    deleteSetlist(openSetlistId);
    openSetlistId = null;
    slOverlay.hidden = true;
    renderSetlistsList();
  });

  slAddSongsBtn.addEventListener("click", () => {
    if (openSetlistId) openAddSongs(openSetlistId);
  });

  slPlayBtn.addEventListener("click", () => {
    const sl = getSetlist(openSetlistId);
    const songs = sl && resolvedSongs(sl);
    if (!songs || !songs.length) return;
    startPlaySession(sl.id, songs, 0);
  });

  /* ---- Organize mode: touch/pointer drag reorder ----
     Native HTML5 drag/drop doesn't work well on mobile Safari/Chrome, so
     this drives a plain translateY() on the dragged row from pointermove,
     live-swapping DOM order with whichever neighbor it's crossed past --
     the same technique most touch reorder widgets use under the hood.
     Only the row's own drag handle starts a drag (touch-action: none is
     scoped to the handle in CSS too) so the rest of the row can still be
     scrolled past normally. */
  let dragState = null; // { li, setlistId, pointerId, grabOffsetY }
  let holdState = null; // touch press waiting out its long-press delay
  const HOLD_MS = 220;
  const HOLD_SLOP = 8;

  // The whole card is the drag target. A mouse drags at once; a finger has
  // to hold for a moment first, so a plain swipe over the cards still
  // scrolls the list (touch-action: pan-y on the row, see CSS).
  function onRowPointerDown(e, setlistId, li) {
    if (e.target.closest(".setlist-row__delete")) return;
    // The dotted handle on the left grabs at once; elsewhere on the card a
    // finger has to hold first (a mouse always drags at once).
    if (e.pointerType === "mouse" || e.target.closest(".setlist-row__handle")) {
      if (e.button === 0) startDrag(e, setlistId, li);
      return;
    }
    cancelHold();
    holdState = { li, setlistId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, last: e };
    holdState.timer = setTimeout(() => {
      const h = holdState;
      cancelHold();
      startDrag(h.last, h.setlistId, h.li);
    }, HOLD_MS);
    document.addEventListener("pointermove", onHoldMove);
    document.addEventListener("pointerup", cancelHold);
    document.addEventListener("pointercancel", cancelHold);
  }
  function onHoldMove(e) {
    if (!holdState || e.pointerId !== holdState.pointerId) return;
    holdState.last = e;
    if (Math.abs(e.clientX - holdState.x) > HOLD_SLOP || Math.abs(e.clientY - holdState.y) > HOLD_SLOP) cancelHold();
  }
  function cancelHold() {
    if (!holdState) return;
    clearTimeout(holdState.timer);
    holdState = null;
    document.removeEventListener("pointermove", onHoldMove);
    document.removeEventListener("pointerup", cancelHold);
    document.removeEventListener("pointercancel", cancelHold);
  }
  // Once a drag is running, stop the page from scrolling under the finger.
  document.addEventListener("touchmove", (e) => { if (dragState) e.preventDefault(); }, { passive: false });

  function renderOrganizeRow(setlistId, song, idx) {
    const li = document.createElement("li");
    li.className = "song-item setlist-row--organize";
    li.dataset.songId = song.id;

    const handle = document.createElement("div");
    handle.className = "setlist-row__handle";
    handle.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="9" cy="6" r="1.5" fill="currentColor"/><circle cx="15" cy="6" r="1.5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="9" cy="18" r="1.5" fill="currentColor"/><circle cx="15" cy="18" r="1.5" fill="currentColor"/></svg>';
    li.appendChild(handle);

    const info = document.createElement("div");
    info.className = "song-item__info";
    const title = document.createElement("div");
    title.className = "song-item__title";
    title.textContent = song.title;
    const artist = document.createElement("div");
    artist.className = "song-item__artist";
    artist.textContent = song.artist || "";
    info.appendChild(title);
    info.appendChild(artist);
    li.appendChild(info);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "setlist-row__delete";
    del.setAttribute("aria-label", "Remove from setlist");
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSongFromSetlist(setlistId, song.id);
      renderSetlistDetail();
    });
    li.appendChild(del);

    li.addEventListener("pointerdown", (e) => onRowPointerDown(e, setlistId, li));
    return li;
  }

  // Clears any transform, measures the row's true (untransformed) position,
  // then re-applies a transform that puts it exactly under the pointer --
  // called again after every DOM swap so the row keeps following the
  // finger smoothly across a reorder instead of jumping.
  function applyDragTransform(e) {
    const li = dragState.li;
    li.style.transform = "";
    const rect = li.getBoundingClientRect();
    const desiredTop = e.clientY - dragState.grabOffsetY;
    li.style.transform = "translateY(" + (desiredTop - rect.top) + "px)";
  }

  function startDrag(e, setlistId, li) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();
    const rect = li.getBoundingClientRect();
    dragState = { li, setlistId, pointerId: e.pointerId, grabOffsetY: e.clientY - rect.top };
    try {
      li.setPointerCapture(e.pointerId);
    } catch (err) {
      /* best effort */
    }
    li.classList.add("setlist-row--dragging");
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
    document.addEventListener("pointercancel", onDragEnd);
  }

  // Keeps the overlay scrolling while a card is held near its top/bottom edge.
  let edgeRaf = 0;
  let edgeY = 0;
  function edgeScrollTick() {
    edgeRaf = 0;
    if (!dragState) return;
    const r = slOverlay.getBoundingClientRect();
    const zone = 70;
    let dy = 0;
    if (edgeY < r.top + zone) dy = -Math.ceil((r.top + zone - edgeY) / 6);
    else if (edgeY > r.bottom - zone) dy = Math.ceil((edgeY - (r.bottom - zone)) / 6);
    if (dy) {
      slOverlay.scrollTop += dy;
      applyDragTransform({ clientY: edgeY });
      reorderAround({ clientY: edgeY });
    }
    edgeRaf = requestAnimationFrame(edgeScrollTick);
  }
  function stopEdgeScroll() {
    if (edgeRaf) cancelAnimationFrame(edgeRaf);
    edgeRaf = 0;
  }

  function onDragMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    e.preventDefault();
    edgeY = e.clientY;
    if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeScrollTick);
    applyDragTransform(e);
    reorderAround(e);
  }

  function reorderAround(e) {
    const li = dragState.li;
    // Repeatedly swap with whichever immediate neighbor the dragged row's
    // current (transformed) center has crossed past, re-measuring after
    // each swap -- handles a fast drag jumping more than one row at once.
    let moved = true;
    while (moved) {
      moved = false;
      const liRect = li.getBoundingClientRect();
      const liCenter = liRect.top + liRect.height / 2;
      const prev = li.previousElementSibling;
      if (prev) {
        const pr = prev.getBoundingClientRect();
        if (liCenter < pr.top + pr.height / 2) {
          slListEl.insertBefore(li, prev);
          applyDragTransform(e);
          moved = true;
          continue;
        }
      }
      const next = li.nextElementSibling;
      if (next) {
        const nr = next.getBoundingClientRect();
        if (liCenter > nr.top + nr.height / 2) {
          slListEl.insertBefore(next, li);
          applyDragTransform(e);
          moved = true;
        }
      }
    }
  }

  function onDragEnd(e) {
    if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
    const li = dragState.li;
    li.style.transform = "";
    li.classList.remove("setlist-row--dragging");
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    document.removeEventListener("pointercancel", onDragEnd);
    stopEdgeScroll();
    const newOrder = Array.from(slListEl.children).map((row) => row.dataset.songId);
    reorderSetlist(dragState.setlistId, newOrder);
    dragState = null;
  }

  /* ---------------- Add songs to a setlist ---------------- */

  // The picker works on a staged copy of the setlist's song ids; nothing is
  // written until "Save" (back discards).
  let stagedIds = null;

  function openAddSongs(setlistId) {
    const sl = getSetlist(setlistId);
    if (!sl) return;
    stagedIds = sl.songIds.slice();
    slOverlay.hidden = true;
    addOverlay.hidden = false;
    addFilterInput.value = "";
    renderAddList(setlistId, "");
    setSaveBar(true);
  }

  function renderAddList(setlistId, query) {
    if (!stagedIds || !window.GuitarLibrary) return;
    const q = query.trim().toLowerCase();
    const all = window.GuitarLibrary.sortedLibrary();
    const filtered = q ? all.filter((s) => (s.title + " " + (s.artist || "")).toLowerCase().includes(q)) : all;
    addEmptyEl.hidden = all.length > 0;
    addListEl.textContent = "";
    filtered.forEach((song) => {
      const added = stagedIds.includes(song.id);
      const li = document.createElement("li");
      li.className = "song-item setlist-pick-row" + (added ? " is-added" : "");

      const info = document.createElement("div");
      info.className = "song-item__info";
      const title = document.createElement("div");
      title.className = "song-item__title";
      title.textContent = song.title;
      const artist = document.createElement("div");
      artist.className = "song-item__artist";
      artist.textContent = song.artist || "";
      info.appendChild(title);
      info.appendChild(artist);
      li.appendChild(info);

      const toggle = document.createElement("span");
      toggle.className = "setlist-pick-row__toggle";
      toggle.setAttribute("aria-hidden", "true");
      toggle.innerHTML = added
        ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 13l4.5 4.5L19 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      li.appendChild(toggle);

      li.addEventListener("click", () => {
        if (stagedIds.includes(song.id)) stagedIds = stagedIds.filter((id) => id !== song.id);
        else stagedIds.push(song.id);
        renderAddList(setlistId, addFilterInput.value);
      });
      addListEl.appendChild(li);
    });
  }

  addFilterInput.addEventListener("input", () => {
    if (openSetlistId) renderAddList(openSetlistId, addFilterInput.value);
  });

  function leaveAddSongs() {
    stagedIds = null;
    setSaveBar(false);
    addOverlay.hidden = true;
    slOverlay.hidden = false;
    renderSetlistDetail();
  }

  addBackBtn.addEventListener("click", leaveAddSongs);

  /* ---------------- Play setlist ----------------
     Opens the first song straight into its lyrics/chords view, then a small
     prev/next control (see .setlist-playbar in style.css) in the song
     screen's sub row steps through the rest without detouring back through
     the setlist each time. */

  let playbarEl = null;

  function ensurePlaybar() {
    if (playbarEl) return playbarEl;
    playbarEl = document.createElement("div");
    playbarEl.className = "setlist-playbar";

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "setlist-playbar__btn";
    prev.setAttribute("aria-label", "Previous song");
    prev.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    prev.addEventListener("click", () => goToSong(-1));

    const count = document.createElement("span");
    count.className = "setlist-playbar__count";

    const next = document.createElement("button");
    next.type = "button";
    next.className = "setlist-playbar__btn";
    next.setAttribute("aria-label", "Next song");
    next.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    next.addEventListener("click", () => goToSong(1));

    playbarEl.appendChild(prev);
    playbarEl.appendChild(count);
    playbarEl.appendChild(next);
    playbarEl._prev = prev;
    playbarEl._next = next;
    playbarEl._count = count;
    const slot = document.getElementById("detail-sub") || document.body;
    slot.insertBefore(playbarEl, slot.firstChild);
    return playbarEl;
  }

  function renderPlaybar() {
    if (!playSession || !playbarEl) return;
    playbarEl._count.textContent = playSession.index + 1 + " of " + playSession.songs.length;
    playbarEl._prev.disabled = playSession.index <= 0;
    playbarEl._next.disabled = playSession.index >= playSession.songs.length - 1;
  }

  function removePlaybar() {
    if (playbarEl) {
      playbarEl.remove();
      playbarEl = null;
    }
  }

  function startPlaySession(setlistId, songs, index) {
    playSession = { setlistId, songs, index };
    slOverlay.hidden = true;
    ensurePlaybar();
    window.GuitarLibrary.openDetail(songs[index], { expanded: true });
    renderPlaybar();
  }

  function goToSong(delta) {
    if (!playSession) return;
    const idx = playSession.index + delta;
    if (idx < 0 || idx >= playSession.songs.length) return;
    playSession.index = idx;
    internalTransition = true;
    if (window.GuitarSongSheet) window.GuitarSongSheet.close();
    window.GuitarLibrary.closeDetail();
    window.GuitarLibrary.openDetail(playSession.songs[idx], { expanded: true });
    internalTransition = false;
    renderPlaybar();
  }

  function endPlaySession() {
    if (!playSession) return;
    playSession = null;
    removePlaybar();
  }

  // Any close of the song detail page that ISN'T this file's own
  // goToSong() transition means the user actually left it (the back arrow,
  // or a raw bottom-nav tap) -- end the session and drop the floating
  // control either way. onDetailBack() below handles landing back on the
  // setlist page for the back-arrow path specifically.
  document.addEventListener("songdetailchange", (e) => {
    if (internalTransition) return;
    if (!(e.detail && e.detail.open)) endPlaySession();
  });

  /* ---------------- Public API (called from js/library.js) ---------------- */

  // A song just saved from the search overlay -- if that search was opened
  // from "Search for a new song" on the add-songs screen, fold it into that
  // setlist right away. `noDetailPage` is set by the "isn't listed" custom-
  // song quick-add, which saves straight to the library and lands back on
  // the add-songs screen without ever visiting the song's own detail page
  // -- unlike the normal search-result route, there's no upcoming "back"
  // tap from a detail page for returnTarget to govern, so it's cleared
  // right away instead of lingering to misfire on some later, unrelated one.
  function notifySongSaved(song, opts) {
    if (!pendingSetlistId) return;
    const setlistId = pendingSetlistId;
    addSongToSetlist(setlistId, song.id);
    pendingSetlistId = null;
    if (opts && opts.noDetailPage) {
      returnTarget = null;
      // closeSearch() (library.js) just un-hides whatever was underneath --
      // if that's this screen, refresh it so the new song shows up checked
      // right away instead of only after the next filter keystroke.
      if (!addOverlay.hidden) renderAddList(setlistId, addFilterInput.value);
    }
  }

  // Called from library.js's detail-back button click, before its own
  // closeDetail(). Returns true once it has taken over (and already closed
  // the detail overlay itself) -- false means "not our concern, do the
  // normal thing".
  function onDetailBack() {
    if (playSession) {
      const setlistId = playSession.setlistId;
      endPlaySession();
      window.GuitarLibrary.closeDetail();
      openSetlistDetail(setlistId);
      return true;
    }
    if (!returnTarget) return false;
    const target = returnTarget;
    returnTarget = null;
    window.GuitarLibrary.closeDetail();
    if (target.type === "setlist-detail") openSetlistDetail(target.setlistId);
    else if (target.type === "setlist-add") openAddSongs(target.setlistId);
    return true;
  }

  // A sync or import may have changed the lists under an open overview.
  document.addEventListener("setlistsapplied", () => {
    renderSetlistsList();
    if (!slOverlay.hidden) {
      if (getSetlist(openSetlistId)) renderSetlistDetail();
      else {
        slOverlay.hidden = true;
      }
    }
  });

  // Keep the Setlists tab fresh whenever it is opened or the instrument changes.
  document.addEventListener("pagechange", (e) => {
    if (e.detail && e.detail.page === "setlists") renderSetlistsList();
  });
  document.addEventListener("instrumentchange", renderSetlistsList);

  /* ---------------- Add the open song to a setlist (song screen's ... menu) ---------------- */
  function openPicker(song) {
    if (!song) return;
    window.GuitarUI.openSheet({
      title: "Add to setlist",
      render(body, api) {
        function draw() {
          body.textContent = "";
          const lists = readSetlists().sort((a, b) => b.updatedAt - a.updatedAt);
          lists.forEach((sl) => {
            const has = sl.songIds.includes(song.id);
            const row = document.createElement("button");
            row.type = "button";
            row.className = "ui-listrow" + (has ? " is-on" : "");
            const name = document.createElement("span");
            name.textContent = sl.name;
            const mark = document.createElement("span");
            mark.className = "ui-listrow__mark";
            mark.innerHTML = has
              ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 13l4.5 4.5L19 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
              : '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
            row.appendChild(name);
            row.appendChild(mark);
            row.addEventListener("click", () => {
              if (has) removeSongFromSetlist(sl.id, song.id);
              else addSongToSetlist(sl.id, song.id);
              draw();
            });
            body.appendChild(row);
          });
          const create = document.createElement("form");
          create.className = "ui-inline-form";
          const input = document.createElement("input");
          input.type = "text";
          input.className = "custom-song__input";
          input.placeholder = lists.length ? "New setlist…" : "Name your first setlist";
          input.maxLength = 60;
          input.setAttribute("aria-label", "New setlist name");
          const add = document.createElement("button");
          add.type = "submit";
          add.className = "songsheet__btn songsheet__btn--primary";
          add.textContent = "Create";
          create.appendChild(input);
          create.appendChild(add);
          create.addEventListener("submit", (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            const sl = createSetlist(name);
            addSongToSetlist(sl.id, song.id);
            draw();
          });
          body.appendChild(create);
        }
        draw();
      },
    });
  }

  renderSetlistsList();

  window.GuitarSetlists = { notifySongSaved, onDetailBack, anyOverlayOpen, closeAll, openPicker };
})();
