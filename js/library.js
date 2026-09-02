// Guitar — Library page: saved songs, search-to-add, and the open/save
// distinction (searching and opening a song is *not* the same as saving it
// to the library -- only "Save" persists it).
(function () {
  // One saved list per instrument -- guitar songs and piano songs never mix.
  // Guitar keeps the original key so any songs saved before piano existed
  // stay put.
  const STORAGE_KEYS = { guitar: "guitar-library", piano: "piano-library" };
  const SEARCH_DEBOUNCE_MS = 550;
  // The iTunes endpoint occasionally drops a request (a brief rate-limit spike
  // returns a 403 with no CORS header, which the browser surfaces as a plain
  // network error). One quiet retry after a short pause turns almost all of
  // those back into a normal result instead of an error message.
  const SEARCH_RETRIES = 1;
  const SEARCH_RETRY_DELAY_MS = 1200;

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
  const detailChordSub = document.getElementById("chord-links-sub");
  const detailTabLinks = document.getElementById("detail-tab-links");
  const detailTabGroup = document.getElementById("tab-links-group");
  const songLinksEl = document.getElementById("song-links");
  const detailMetronomeBtn = document.getElementById("detail-metronome-btn");
  const detailBpmValue = document.getElementById("detail-bpm-value");
  const detailSpotifyBtn = document.getElementById("detail-spotify-btn");

  const customToggle = document.getElementById("custom-song-toggle");
  const customForm = document.getElementById("custom-song-form");
  const customTitleInput = document.getElementById("custom-song-title");
  const customArtistInput = document.getElementById("custom-song-artist");
  const customCancelBtn = document.getElementById("custom-song-cancel");

  // Transparent background so the element's own `--surface-raised` shows
  // through -- keeps the placeholder in step with whichever palette is
  // active. Neutral grey glyph reads fine on both the warm and cool skins.
  const FALLBACK_ART =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpath d='M35 65a8 8 0 1 1-8-8 8 8 0 0 1 8 8Zm0 0V32l30-6v31' fill='none' stroke='%23A6ABAF' stroke-width='3'/%3E%3C/svg%3E";

  /* ---------- Storage ---------- */
  function currentInstrument() {
    const get = window.GuitarApp && window.GuitarApp.getInstrument;
    return (get && get()) || "guitar";
  }

  function storageKey() {
    return STORAGE_KEYS[currentInstrument()] || STORAGE_KEYS.guitar;
  }

  function loadLibrary() {
    try {
      const raw = localStorage.getItem(storageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveLibrary(list) {
    localStorage.setItem(storageKey(), JSON.stringify(list));
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
    resetCustomForm();
    setTimeout(() => searchInput.focus(), 50);
  }

  function closeSearch() {
    searchOverlay.hidden = true;
    if (searchAbortController) searchAbortController.abort();
  }

  /* ---------- Custom song (not in the catalogue) ---------- */
  function resetCustomForm() {
    customForm.hidden = true;
    customForm.reset();
    customToggle.hidden = false;
  }

  customToggle.addEventListener("click", () => {
    if (searchAbortController) searchAbortController.abort();
    clearTimeout(searchDebounceTimer);
    searchResultsEl.innerHTML = "";
    searchStatusEl.textContent = "";
    customToggle.hidden = true;
    customForm.hidden = false;
    setTimeout(() => customTitleInput.focus(), 30);
  });

  customCancelBtn.addEventListener("click", resetCustomForm);

  customForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = customTitleInput.value.trim();
    if (!title) return;
    library.push({
      id: `custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      title,
      artist: customArtistInput.value.trim(),
      album: "",
      year: "",
      artworkUrl: "",
      custom: true,
      favorite: false,
      savedAt: Date.now(),
    });
    saveLibrary(library);
    renderLibraryList();
    closeSearch();
  });

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
    const signal = searchAbortController.signal;

    async function fetchResults() {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(`Search failed: ${res.status}`);
          return await res.json();
        } catch (err) {
          if (err.name === "AbortError" || attempt >= SEARCH_RETRIES) throw err;
          await new Promise((r) => setTimeout(r, SEARCH_RETRY_DELAY_MS));
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        }
      }
    }

    try {
      const data = await fetchResults();
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
      searchStatusEl.textContent =
        "Couldn't reach the music search. Check your connection, or try again in a moment.";
    }
  }

  searchInput.addEventListener("input", () => {
    // Typing a search means they're done with the custom-song form -- fold it
    // back up (without wiping what they'd typed there).
    if (!customForm.hidden) {
      customForm.hidden = true;
      customToggle.hidden = false;
    }
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
  // pre-filled. Chord sources differ per instrument: guitar goes to the
  // guitar tab/chord sites, piano goes to piano-oriented ones. Ultimate
  // Guitar's `type[]` filter separates guitar formats: 300 = Chords,
  // 200 = Tab, 500 = Guitar Pro.
  const CHORD_SOURCES = {
    guitar: [
      { name: "Ultimate Guitar", url: (q) => `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}&type[]=300` },
      { name: "e-chords",        url: (q) => `https://www.e-chords.com/search-all/${q}` },
      { name: "Chordify",        url: (q) => `https://chordify.net/search/${q}` },
    ],
    piano: [
      { name: "Chordify",      url: (q) => `https://chordify.net/search/${q}` },
      { name: "OnlinePianist", url: (q) => `https://www.onlinepianist.com/search?q=${q}` },
      { name: "Musescore",     url: (q) => `https://musescore.com/sheetmusic?text=${q}` },
    ],
  };
  // Guitar only -- piano mode hides the Tabs section entirely.
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

  /* ---------- Tempo lookup (best effort) ---------- */
  // The iTunes catalogue carries no tempo. TheAudioDB does (`intTempo`), is
  // keyless (public test key "2"), and sends CORS headers, so a plain fetch
  // works -- but it's only filled in for a subset of tracks. When it's
  // missing or the request fails we just don't show a tempo.
  const bpmCache = new Map();

  async function fetchBpm(artist, title) {
    const cacheKey = `${artist}␟${title}`.toLowerCase();
    if (bpmCache.has(cacheKey)) return bpmCache.get(cacheKey);
    let bpm = null;
    try {
      const s = encodeURIComponent((artist || "").trim());
      const t = encodeURIComponent(cleanTitleForSearch(title || "").trim());
      const res = await fetch(
        `https://www.theaudiodb.com/api/v1/json/2/searchtrack.php?s=${s}&t=${t}`
      );
      if (res.ok) {
        const data = await res.json();
        const track = data && data.track && data.track[0];
        const value = track && parseInt(track.intTempo, 10);
        if (Number.isFinite(value) && value >= 40 && value <= 260) bpm = value;
      }
    } catch (err) {
      /* offline / blocked -- no tempo shown, no error surfaced */
    }
    bpmCache.set(cacheKey, bpm);
    return bpm;
  }

  /* ---------- Song detail overlay ---------- */
  // "Opening" a song (from search or from the library) just shows this page
  // -- it is NOT saved to the library until the Save button is tapped. If
  // the song is already in the library, that saved entry (with its
  // favorite flag) is shown instead of a fresh transient copy.
  let currentDetailId = null;
  let currentDetailSong = null;
  let detailSeq = 0;      // guards against a late BPM response landing on the wrong song
  let detailBpm = null;

  function setDetailMeta(bpm) {
    const parts = [
      currentDetailSong && currentDetailSong.album,
      currentDetailSong && currentDetailSong.year,
      bpm ? `${bpm} BPM` : null,
    ].filter(Boolean);
    detailMeta.textContent = parts.join(" · ");
    detailMeta.hidden = parts.length === 0;
  }

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
    const custom = Boolean(currentDetailSong.custom);
    const mySeq = ++detailSeq;
    detailBpm = null;
    detailMetronomeBtn.hidden = true;

    detailArt.src = song.artworkUrl || FALLBACK_ART;
    detailArt.onerror = () => { detailArt.onerror = null; detailArt.src = FALLBACK_ART; };
    detailTitle.textContent = song.title;
    detailArtist.textContent = song.artist || "";
    detailArtist.hidden = !song.artist;
    setDetailMeta(null);

    // Opens the track in the Spotify app (or web player) via a search deep
    // link -- we only have iTunes metadata, not a Spotify track id, and
    // resolving one needs an authenticated API. Works for custom songs too.
    const spotifyQuery = `${song.artist || ""} ${cleanTitleForSearch(song.title)}`.trim();
    detailSpotifyBtn.href =
      "https://open.spotify.com/search/" + encodeURIComponent(spotifyQuery);

    // Custom songs have no external chord/tab pages and no catalogue tempo --
    // the detail view is then just art + title + save/remove.
    songLinksEl.hidden = custom;
    if (!custom) {
      const linkQuery = `${song.artist} ${cleanTitleForSearch(song.title)}`.trim();
      const piano = currentInstrument() === "piano";
      renderSourceButtons(detailChordLinks, CHORD_SOURCES[piano ? "piano" : "guitar"], linkQuery);
      if (detailChordSub) {
        detailChordSub.textContent = piano
          ? "Lyrics with the chords written above them — for playing along on the keys."
          : "Lyrics with the chords to play above them — for strumming and campfire play.";
      }
      if (detailTabGroup) detailTabGroup.hidden = piano;
      if (piano) {
        detailTabLinks.innerHTML = "";
      } else {
        renderSourceButtons(detailTabLinks, TAB_SOURCES, linkQuery);
      }
    }

    updateSaveButton(saved);
    detailFavBtn.setAttribute("aria-pressed", currentDetailSong.favorite ? "true" : "false");

    detailOverlay.hidden = false;
    closeSearch();

    // Best-effort tempo: if TheAudioDB knows it, show it beside the year and
    // reveal the "open in metronome" button.
    if (!custom) {
      fetchBpm(currentDetailSong.artist, currentDetailSong.title).then((bpm) => {
        if (mySeq !== detailSeq || detailOverlay.hidden || !bpm) return;
        detailBpm = bpm;
        detailBpmValue.textContent = String(bpm);
        setDetailMeta(bpm);
        detailMetronomeBtn.hidden = false;
      });
    }
  }

  function closeDetail() {
    detailOverlay.hidden = true;
    currentDetailId = null;
    currentDetailSong = null;
    detailBpm = null;
    detailSeq++; // invalidate any in-flight tempo lookup
  }

  detailMetronomeBtn.addEventListener("click", () => {
    if (!detailBpm || !window.GuitarMetronome) return;
    const bpm = detailBpm;
    closeDetail();
    window.GuitarMetronome.playAtBpm(bpm, null, { autostart: false });
  });

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

  // Switching instrument (guitar <-> piano) means a different saved list and
  // different chord sources, so reload from the other key and drop any open
  // overlay (its song ids belong to the list we just left).
  document.addEventListener("instrumentchange", () => {
    closeSearch();
    closeDetail();
    library = loadLibrary();
    renderLibraryList();
  });

  /* ---------- Init ---------- */
  renderLibraryList();
})();
