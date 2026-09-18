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
// Screens (three overlays, reusing the exact same .overlay shell as
// js/library.js's own search/detail overlays -- see index.html):
//   - #setlists-overlay      every saved setlist, "+" makes a new one
//   - #setlist-detail-overlay  one setlist's songs -- Play / Organize / +
//   - #setlist-add-overlay   picker: toggle songs already in your library,
//                             or "Search for a new song" to fall through to
//                             js/library.js's own search+save flow
// Exactly one of these (and library.js's own overlays) is ever visible at a
// time -- opening one hides whichever else was open, same discipline
// library.js already uses for its own two.
//
// Opening a song FROM a setlist reuses js/library.js's own openDetail() --
// the only thing this file changes about that page is where "back" lands
// (see onDetailBack, wired into library.js's own back button) and, while a
// "Play setlist" session is running, a floating prev/next control (see
// setlist-playbar below).
(function () {
  const setlistsOpenBtn = document.getElementById("setlists-open-btn");
  const setlistsOverlay = document.getElementById("setlists-overlay");
  if (!setlistsOpenBtn || !setlistsOverlay) return;
  const setlistsBackBtn = document.getElementById("setlists-back");
  const setlistsNewBtn = document.getElementById("setlists-new-btn");
  const setlistsListEl = document.getElementById("setlists-list");
  const setlistsEmptyEl = document.getElementById("setlists-empty");
  const newForm = document.getElementById("setlist-new-form");
  const newNameInput = document.getElementById("setlist-new-name");
  const newCancelBtn = document.getElementById("setlist-new-cancel");

  const slOverlay = document.getElementById("setlist-detail-overlay");
  const slBackBtn = document.getElementById("setlist-detail-back");
  const slTitleEl = document.getElementById("setlist-detail-title");
  const slDeleteBtn = document.getElementById("setlist-detail-delete-btn");
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
  const addSearchBtn = document.getElementById("setlist-add-search-btn");
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
      return Array.isArray(parsed) ? parsed : [];
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
  function deleteSetlist(id) {
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

  function syncSettingsFab() {
    if (window.GuitarLibrary && window.GuitarLibrary.syncSettingsFab) window.GuitarLibrary.syncSettingsFab();
  }

  function anyOverlayOpen() {
    return !setlistsOverlay.hidden || !slOverlay.hidden || !addOverlay.hidden;
  }

  function closeAll() {
    setlistsOverlay.hidden = true;
    slOverlay.hidden = true;
    addOverlay.hidden = true;
    newForm.hidden = true;
    slDeleteConfirm.hidden = true;
    organizing = false;
    openSetlistId = null;
    pendingSetlistId = null;
    returnTarget = null;
    endPlaySession();
    syncSettingsFab();
  }

  /* ---------------- Setlists overview ---------------- */

  function openSetlistsOverview() {
    slOverlay.hidden = true;
    addOverlay.hidden = true;
    newForm.hidden = true;
    setlistsOverlay.hidden = false;
    renderSetlistsList();
    syncSettingsFab();
  }

  function renderSetlistsList() {
    const lists = readSetlists().sort((a, b) => b.updatedAt - a.updatedAt);
    setlistsListEl.textContent = "";
    setlistsEmptyEl.hidden = lists.length > 0;
    lists.forEach((sl) => {
      const li = document.createElement("li");
      li.className = "song-item";
      const info = document.createElement("div");
      info.className = "song-item__info";
      const title = document.createElement("div");
      title.className = "song-item__title";
      title.textContent = sl.name;
      const sub = document.createElement("div");
      sub.className = "song-item__artist";
      sub.textContent = sl.songIds.length === 1 ? "1 song" : sl.songIds.length + " songs";
      info.appendChild(title);
      info.appendChild(sub);
      li.appendChild(info);
      li.addEventListener("click", () => openSetlistDetail(sl.id));
      setlistsListEl.appendChild(li);
    });
  }

  setlistsOpenBtn.addEventListener("click", openSetlistsOverview);
  setlistsBackBtn.addEventListener("click", () => {
    setlistsOverlay.hidden = true;
    newForm.hidden = true;
    syncSettingsFab();
  });

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
    openSetlistDetail(sl.id);
  });

  /* ---------------- One setlist ---------------- */

  function openSetlistDetail(setlistId) {
    if (!getSetlist(setlistId)) return;
    openSetlistId = setlistId;
    organizing = false;
    setlistsOverlay.hidden = true;
    addOverlay.hidden = true;
    slOverlay.hidden = false;
    renderSetlistDetail();
    syncSettingsFab();
  }

  function renderSetlistDetail() {
    const sl = getSetlist(openSetlistId);
    if (!sl) {
      // Deleted from under us (or a stale id) -- fall back to the overview
      // rather than showing an empty, un-openable page.
      openSetlistsOverview();
      return;
    }
    slTitleEl.textContent = sl.name;
    slDeleteConfirm.hidden = true;
    slOrganizeBtn.textContent = organizing ? "Done" : "Organize";
    slOrganizeBtn.classList.toggle("is-active", organizing);
    slAddSongsBtn.hidden = organizing;
    slDeleteBtn.hidden = organizing;

    const songs = resolvedSongs(sl);
    slPlayBtn.disabled = songs.length === 0;
    slEmptyEl.hidden = songs.length > 0 || organizing;
    slListEl.textContent = "";
    if (organizing) {
      songs.forEach((song, idx) => slListEl.appendChild(renderOrganizeRow(sl.id, song, idx)));
    } else {
      songs.forEach((song) => {
        slListEl.appendChild(
          window.GuitarLibrary.renderSongRow(song, {
            withFavStar: true,
            onOpen: (s) => {
              returnTarget = { type: "setlist-detail", setlistId: sl.id };
              window.GuitarLibrary.openDetail(s);
            },
          })
        );
      });
    }
  }

  slBackBtn.addEventListener("click", () => {
    slOverlay.hidden = true;
    openSetlistId = null;
    organizing = false;
    setlistsOverlay.hidden = false;
    renderSetlistsList();
    syncSettingsFab();
  });

  slOrganizeBtn.addEventListener("click", () => {
    organizing = !organizing;
    renderSetlistDetail();
  });

  slDeleteBtn.addEventListener("click", () => {
    slDeleteConfirm.hidden = false;
  });
  slDeleteNoBtn.addEventListener("click", () => {
    slDeleteConfirm.hidden = true;
  });
  slDeleteYesBtn.addEventListener("click", () => {
    if (!openSetlistId) return;
    deleteSetlist(openSetlistId);
    openSetlistId = null;
    openSetlistsOverview();
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

    handle.addEventListener("pointerdown", (e) => startDrag(e, setlistId, li));
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
    e.preventDefault();
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

  function onDragMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    e.preventDefault();
    applyDragTransform(e);
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
    const newOrder = Array.from(slListEl.children).map((row) => row.dataset.songId);
    reorderSetlist(dragState.setlistId, newOrder);
    dragState = null;
  }

  /* ---------------- Add songs to a setlist ---------------- */

  function openAddSongs(setlistId) {
    if (!getSetlist(setlistId)) return;
    slOverlay.hidden = true;
    addOverlay.hidden = false;
    addFilterInput.value = "";
    renderAddList(setlistId, "");
    syncSettingsFab();
  }

  function renderAddList(setlistId, query) {
    const sl = getSetlist(setlistId);
    if (!sl || !window.GuitarLibrary) return;
    const q = query.trim().toLowerCase();
    const all = window.GuitarLibrary.sortedLibrary();
    const filtered = q ? all.filter((s) => (s.title + " " + (s.artist || "")).toLowerCase().includes(q)) : all;
    addEmptyEl.hidden = all.length > 0;
    addListEl.textContent = "";
    filtered.forEach((song) => {
      const added = sl.songIds.includes(song.id);
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
        if (sl.songIds.includes(song.id)) removeSongFromSetlist(setlistId, song.id);
        else addSongToSetlist(setlistId, song.id);
        renderAddList(setlistId, addFilterInput.value);
      });
      addListEl.appendChild(li);
    });
  }

  addFilterInput.addEventListener("input", () => {
    if (openSetlistId) renderAddList(openSetlistId, addFilterInput.value);
  });

  addBackBtn.addEventListener("click", () => {
    addOverlay.hidden = true;
    slOverlay.hidden = false;
    renderSetlistDetail();
    syncSettingsFab();
  });

  // Falls through to js/library.js's own search+save flow for a song that
  // isn't in the library yet -- notifySongSaved() below picks it up the
  // moment it's actually saved there and adds it to this setlist too.
  addSearchBtn.addEventListener("click", () => {
    if (!openSetlistId) return;
    pendingSetlistId = openSetlistId;
    returnTarget = { type: "setlist-add", setlistId: openSetlistId };
    if (window.GuitarLibrary && window.GuitarLibrary.openSearch) window.GuitarLibrary.openSearch();
  });

  /* ---------------- Play setlist ----------------
     Opens the first song straight into its expanded lyrics/chords view
     (js/songsheet.js's opts.expanded), then a small floating prev/next
     (see .setlist-playbar in style.css) steps through the rest without
     detouring back through the setlist page each time. Deliberately its
     own floating control, not a takeover of .bottom-nav like the audio
     dock's now-playing bar -- the two need to coexist (playing a backing
     track *while* running the setlist is the whole point). */

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
    // A child of .bottom-nav, same anchoring trick as .songsheet__fab --
    // bottom:100% of that exact element always lands right on its top edge.
    (document.querySelector(".bottom-nav") || document.querySelector(".app") || document.body).appendChild(playbarEl);
    return playbarEl;
  }

  function renderPlaybar() {
    if (!playSession || !playbarEl) return;
    playbarEl._count.textContent = playSession.index + 1 + " / " + playSession.songs.length;
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
    setlistsOverlay.hidden = true;
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

  window.GuitarSetlists = { notifySongSaved, onDetailBack, anyOverlayOpen, closeAll };
})();
