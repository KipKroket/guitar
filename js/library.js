// Guitar — Library page: saved songs, search-to-add, and the open/save
// distinction (searching and opening a song is *not* the same as saving it
// to the library -- only "Save" persists it).
(function () {
  const STORAGE_KEY = "guitar-library";
  const SEARCH_DEBOUNCE_MS = 400;

  /* ---------- Elements ---------- */
  const addBtn = document.getElementById("library-add-btn");
  const listEl = document.getElementById("library-list");
  const emptyEl = document.getElementById("library-empty");

  const searchOverlay = document.getElementById("search-overlay");
  const searchBackBtn = document.getElementById("search-back");
  const searchInput = document.getElementById("search-input");
  const searchStatusEl = document.getElementById("search-status");
  const searchResultsEl = document.getElementById("search-results");

  const detailOverlay = document.getElementById("detail-overlay");
  const detailBackBtn = document.getElementById("detail-back");
  const detailArt = document.getElementById("detail-art");
  const detailTitle = document.getElementById("detail-title");
  const detailArtist = document.getElementById("detail-artist");
  const detailMeta = document.getElementById("detail-meta");
  const detailSaveBtn = document.getElementById("detail-save-btn");
  const detailFavBtn = document.getElementById("detail-favorite-btn");
  const detailChordLinks = document.getElementById("detail-chord-links");
  const detailTabLinks = document.getElementById("detail-tab-links");

  const FALLBACK_ART =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23E9D6AC'/%3E%3Cpath d='M35 65a8 8 0 1 1-8-8 8 8 0 0 1 8 8Zm0 0V32l30-6v31' fill='none' stroke='%23C9A96E' stroke-width='3'/%3E%3C/svg%3E";

  /* ---------- Storage ---------- */
  function loadLibrary() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveLibrary(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  let library = loadLibrary();

  function findEntry(id) {
    return library.find((s) => s.id === id) || null;
  }

  function sortedLibrary() {
    return [...library].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });
  }

  /* ---------- Rendering: shared song row ---------- */
  // `withFavStar` toggles the little star button on each row (only saved
  // songs in the library list get one -- search results don't, since they
  // aren't saved yet).
  function renderSongRow(song, { withFavStar }) {
    const li = document.createElement("li");
    li.className = "song-item";
    li.dataset.id = song.id;

    if (withFavStar) {
      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = "song-item__fav";
      favBtn.setAttribute("aria-label", "Toggle favorite");
      favBtn.setAttribute("aria-pressed", song.favorite ? "true" : "false");
      favBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.8l2.55 5.4 5.7.66-4.24 4.03 1.13 5.86L12 16.9l-5.14 2.85 1.13-5.86-4.24-4.03 5.7-.66Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(song.id);
      });
      li.appendChild(favBtn);
    }

    const img = document.createElement("img");
    img.className = "song-item__art";
    img.loading = "lazy";
    img.alt = "";
    img.src = song.artworkUrl || FALLBACK_ART;
    img.onerror = () => { img.onerror = null; img.src = FALLBACK_ART; };
    li.appendChild(img);

    const info = document.createElement("div");
    info.className = "song-item__info";
    info.innerHTML = `
      <div class="song-item__title"></div>
      <div class="song-item__artist"></div>
    `;
    info.querySelector(".song-item__title").textContent = song.title;
    info.querySelector(".song-item__artist").textContent = song.artist;
    li.appendChild(info);

    li.addEventListener("click", () => openDetail(song));
    return li;
  }

  function renderLibraryList() {
    const sorted = sortedLibrary();
    listEl.innerHTML = "";
    emptyEl.hidden = sorted.length > 0;
    sorted.forEach((song) => {
      listEl.appendChild(renderSongRow(song, { withFavStar: true }));
    });
  }

  function toggleFavorite(id) {
    const entry = findEntry(id);
    if (!entry) return;
    entry.favorite = !entry.favorite;
    saveLibrary(library);
    renderLibraryList();
    if (currentDetailId === id) {
      detailFavBtn.setAttribute("aria-pressed", entry.favorite ? "true" : "false");
    }
  }

  /* ---------- Search overlay ---------- */
  // Song metadata comes from the iTunes Search API: a free, keyless endpoint
  // that -- unlike a raw MusicBrainz text query -- already ranks results by
  // relevance and popularity, so "wonderwall" returns Oasis at the top instead
  // of an obscure cover. It now sends `Access-Control-Allow-Origin: *`, so a
  // plain browser fetch works (no JSONP or proxy needed), and artwork comes
  // back in the same response, so there's no separate cover-art lookup.
  // A single `term` matches across track, artist and album, so one search box
  // covers "wonderwall", "oasis wonderwall" and "morning glory" alike.
  const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";

  let searchAbortController = null;
  let searchDebounceTimer = null;

  function openSearch() {
    searchOverlay.hidden = false;
    searchResultsEl.innerHTML = "";
    searchStatusEl.textContent = "";
    searchInput.value = "";
    setTimeout(() => searchInput.focus(), 50);
  }

  function closeSearch() {
    searchOverlay.hidden = true;
    if (searchAbortController) searchAbortController.abort();
  }

  // iTunes returns the same recording once per release it appears on (single,
  // album, deluxe reissue, live version...). Collapse those to the first --
  // and therefore highest-ranked -- instance so the list isn't three
  // near-identical rows deep before the next actual song.
  function dedupeByTrack(songs) {
    const seen = new Set();
    return songs.filter((s) => {
      const key = `${s.title.toLowerCase()}␟${s.artist.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function itunesResultToSong(r) {
    const art = r.artworkUrl100 || r.artworkUrl60 || "";
    return {
      id: `itunes:${r.trackId}`,
      title: r.trackName || "Untitled",
      artist: r.artistName || "Unknown artist",
      album: r.collectionName || "",
      year: (r.releaseDate || "").slice(0, 4),
      // artworkUrl100 is a 100px thumbnail; the size is just a path segment,
      // so ask for a larger square for the detail view's bigger art.
      artworkUrl: art.replace(/\/100x100bb\.(jpg|png)(\?.*)?$/, "/400x400bb.$1"),
    };
  }

  async function runSearch(term) {
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    searchStatusEl.textContent = "Searching…";
    searchResultsEl.innerHTML = "";

    const url =
      `${ITUNES_SEARCH_URL}?media=music&entity=song&limit=25&term=${encodeURIComponent(term)}`;

    try {
      const res = await fetch(url, { signal: searchAbortController.signal });
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data = await res.json();
      const results = dedupeByTrack((data.results || []).map(itunesResultToSong));

      if (results.length === 0) {
        searchStatusEl.textContent = "No songs found.";
        return;
      }
      searchStatusEl.textContent = "";
      results.forEach((song) => {
        searchResultsEl.appendChild(renderSongRow(song, { withFavStar: false }));
      });
    } catch (err) {
      if (err.name === "AbortError") return; // superseded by a newer search
      searchStatusEl.textContent = "Couldn't reach the music search. Check your connection.";
    }
  }

  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim();
    clearTimeout(searchDebounceTimer);

    if (term.length < 2) {
      if (searchAbortController) searchAbortController.abort();
      searchResultsEl.innerHTML = "";
      searchStatusEl.textContent = "";
      return;
    }

    searchDebounceTimer = setTimeout(() => runSearch(term), SEARCH_DEBOUNCE_MS);
  });

  addBtn.addEventListener("click", openSearch);
  searchBackBtn.addEventListener("click", closeSearch);

  /* ---------- External chord / tab sources ---------- */
  // The app never stores or scrapes chord/tab content itself -- each button
  // just deep-links to a search on an external site with "<artist> <title>"
  // pre-filled. Chords = lyrics with the chords to play written above them
  // (strumming songs); Tabs = string-by-string tablature (fingerpicking,
  // solos). Ultimate Guitar's `type[]` filter separates the two: 300 = Chords,
  // 200 = Tab, 500 = Guitar Pro.
  const CHORD_SOURCES = [
    { name: "Ultimate Guitar", url: (q) => `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}&type[]=300` },
    { name: "e-chords",        url: (q) => `https://www.e-chords.com/search-all/${q}` },
    { name: "Chordify",        url: (q) => `https://chordify.net/search/${q}` },
  ];
  const TAB_SOURCES = [
    { name: "Ultimate Guitar", url: (q) => `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}&type[]=200&type[]=500` },
    { name: "Songsterr",       url: (q) => `https://www.songsterr.com/?pattern=${q}` },
  ];

  // iTunes track names often carry a trailing qualifier -- "(Remastered)",
  // "(2009 Remaster)", "(Live)", "- Single Version" -- that only hurts a
  // search on a chords/tabs site. Strip those, but leave real parenthetical
  // titles (e.g. "(Sittin' On) The Dock of the Bay") alone.
  const TITLE_NOISE = /\b(remaster(ed)?|mono|stereo|version|live|unplugged|acoustic|deluxe|edition|edit|mix|remix|re-?recorded|anniversary|radio|single|explicit|clean|bonus|take \d+|feat\.?)\b/i;

  function cleanTitleForSearch(title) {
    return title
      .replace(/\s*[([][^)\]]*[)\]]\s*$/g, (m) => (TITLE_NOISE.test(m) ? " " : m))
      .replace(/\s*[-–—]\s*[^-–—]*$/, (m) => (TITLE_NOISE.test(m) ? "" : m))
      .replace(/\s{2,}/g, " ")
      .trim() || title;
  }

  function renderSourceButtons(container, sources, query) {
    const q = encodeURIComponent(query);
    container.innerHTML = "";
    sources.forEach((src) => {
      const a = document.createElement("a");
      a.className = "source-link";
      a.href = src.url(q);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML =
        `<span>${src.name}</span>` +
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14 5h5v5M19 5l-8.5 8.5M12 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      container.appendChild(a);
    });
  }

  /* ---------- Song detail overlay ---------- */
  // "Opening" a song (from search or from the library) just shows this page
  // -- it is NOT saved to the library until the Save button is tapped. If
  // the song is already in the library, that saved entry (with its
  // favorite flag) is shown instead of a fresh transient copy.
  let currentDetailId = null;
  let currentDetailSong = null;

  function updateSaveButton(isSaved) {
    detailSaveBtn.classList.toggle("is-saved", isSaved);
    detailSaveBtn.textContent = isSaved ? "Saved · Tap to remove" : "Save to Library";
    detailFavBtn.hidden = !isSaved;
  }

  function openDetail(song) {
    const existing = findEntry(song.id);
    const saved = Boolean(existing);
    currentDetailId = song.id;
    currentDetailSong = existing || { ...song, favorite: false };

    detailArt.src = song.artworkUrl || FALLBACK_ART;
    detailArt.onerror = () => { detailArt.onerror = null; detailArt.src = FALLBACK_ART; };
    detailTitle.textContent = song.title;
    detailArtist.textContent = song.artist;
    detailMeta.textContent = [song.album, song.year].filter(Boolean).join(" · ");

    const linkQuery = `${song.artist} ${cleanTitleForSearch(song.title)}`.trim();
    renderSourceButtons(detailChordLinks, CHORD_SOURCES, linkQuery);
    renderSourceButtons(detailTabLinks, TAB_SOURCES, linkQuery);

    updateSaveButton(saved);
    detailFavBtn.setAttribute("aria-pressed", currentDetailSong.favorite ? "true" : "false");

    detailOverlay.hidden = false;
    closeSearch();
  }

  function closeDetail() {
    detailOverlay.hidden = true;
    currentDetailId = null;
    currentDetailSong = null;
  }

  detailBackBtn.addEventListener("click", closeDetail);

  detailSaveBtn.addEventListener("click", () => {
    if (!currentDetailId) return;
    const existing = findEntry(currentDetailId);

    if (existing) {
      // Remove from library.
      library = library.filter((s) => s.id !== currentDetailId);
      saveLibrary(library);
      currentDetailSong = { ...currentDetailSong, favorite: false };
      updateSaveButton(false);
      detailFavBtn.setAttribute("aria-pressed", "false");
    } else {
      // Save to library.
      const entry = { ...currentDetailSong, favorite: false, savedAt: Date.now() };
      library.push(entry);
      saveLibrary(library);
      currentDetailSong = entry;
      updateSaveButton(true);
    }
    renderLibraryList();
  });

  detailFavBtn.addEventListener("click", () => {
    if (!currentDetailId) return;
    toggleFavorite(currentDetailId);
  });

  // If the user switches to another tab (Tuner/Metronome/Settings) while a
  // search or detail overlay is open, close it -- otherwise it would still
  // be sitting open, hidden behind the other page, the next time they come
  // back to Library.
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.target !== "library") {
        closeSearch();
        closeDetail();
      }
    });
  });

  /* ---------- Init ---------- */
  renderLibraryList();
})();
