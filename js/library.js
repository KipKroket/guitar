// Guitar — Library page: saved songs, search-to-add, and the open/save
// distinction (searching and opening a song is *not* the same as saving it
// to the library -- only "Save" persists it).
(function () {
  // One saved list per instrument -- guitar songs and piano songs never mix.
  // Guitar keeps the original key so any songs saved before piano existed
  // stay put. Alongside each list is a "tombstone" list: ids of songs the
  // user deleted, each with a timestamp. Every song row also carries an
  // `updatedAt`. That pair -- per-row timestamps + tombstones -- is what
  // lets two copies of a library (a backup file, or the cloud copy) be
  // *merged* instead of one clobbering the other. See mergeSnapshots().
  const STORAGE_KEYS = { guitar: "guitar-library", piano: "piano-library" };
  const TOMB_KEYS = { guitar: "guitar-library-tomb", piano: "piano-library-tomb" };
  const INSTRUMENTS = ["guitar", "piano"];
  // A deletion older than this has long since reached every device; drop it
  // so the tombstone list can't grow without bound.
  const TOMB_TTL_MS = 150 * 24 * 60 * 60 * 1000;
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

  function readList(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  function writeList(key, list) {
    localStorage.setItem(key, JSON.stringify(list));
  }

  // Songs saved before this change have no `updatedAt` -- seed it from
  // `savedAt` (or a low non-zero value) so every row can take part in a merge.
  function normalizeSongs(list) {
    return list.map((s) => (s && s.updatedAt ? s : { ...s, updatedAt: (s && s.savedAt) || 1 }));
  }

  function loadSongs(inst) {
    return normalizeSongs(readList(STORAGE_KEYS[inst]));
  }
  function loadTombs(inst) {
    return readList(TOMB_KEYS[inst]).filter((t) => t && t.id);
  }
  function persist(inst, songs, tombs) {
    writeList(STORAGE_KEYS[inst], songs);
    if (tombs) writeList(TOMB_KEYS[inst], tombs);
  }

  let library = loadSongs(currentInstrument());
  let tombstones = loadTombs(currentInstrument());

  // Persist the active instrument's state and let the (optional) cloud-sync
  // layer know something changed.
  function commit() {
    persist(currentInstrument(), library, tombstones);
    document.dispatchEvent(new CustomEvent("librarychange"));
  }

  function findEntry(id) {
    return library.find((s) => s.id === id) || null;
  }

  function dropTomb(id) {
    tombstones = tombstones.filter((t) => t.id !== id);
  }
  function addTomb(id) {
    dropTomb(id);
    tombstones.push({ id, deletedAt: Date.now() });
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
    entry.updatedAt = Date.now();
    commit();
    renderLibraryList();
    if (currentDetailId === id) {
      detailFavBtn.setAttribute("aria-pressed", entry.favorite ? "true" : "false");
    }
  }

  /* ---------- Search overlay ---------- */
  // Song metadata comes from a music catalogue API: keyless, ranked by
  // popularity ("wonderwall" -> Oasis at the top), with artwork in the same
  // response, and one query that matches track / artist / album alike.
  //
  // It is loaded as a <script> (JSONP), never fetch(): on iOS Safari a
  // cross-origin fetch() to these catalogues fails (ITP / missing CORS
  // headers), which is what surfaced as "Couldn't reach the music search".
  // A <script> load isn't subject to that.
  //
  // The primary catalogue is Deezer, NOT the iTunes Search API. iTunes'
  // JSONP response carries `Content-Disposition: attachment`, and WebKit
  // (i.e. every browser on iOS) then refuses to run the script -- so iTunes
  // JSONP works in a desktop preview but never on the phone. Deezer's JSONP
  // has no such header. iTunes is kept as a fallback for non-Safari clients
  // and in case Deezer is unreachable.
  const SEARCH_SOURCES = [
    {
      name: "Deezer",
      url: (term) =>
        "https://api.deezer.com/search?output=jsonp&limit=25&q=" + encodeURIComponent(term),
      // Deezer wraps the payload as `<cb>({ data: [ {track}, ... ] })`.
      toSongs: (data) =>
        (data && Array.isArray(data.data) ? data.data : []).map((r) => ({
          id: `deezer:${r.id}`,
          title: r.title || r.title_short || "Untitled",
          artist: (r.artist && r.artist.name) || "Unknown artist",
          album: (r.album && r.album.title) || "",
          year: "", // Deezer search rows carry no release date
          artworkUrl:
            (r.album && (r.album.cover_big || r.album.cover_medium || r.album.cover)) || "",
        })),
    },
    {
      name: "iTunes",
      url: (term) =>
        "https://itunes.apple.com/search?media=music&entity=song&limit=25&term=" +
        encodeURIComponent(term),
      toSongs: (data) =>
        (data && Array.isArray(data.results) ? data.results : []).map(itunesResultToSong),
    },
  ];

  // Load `${url}&callback=<fn>` as a <script>; resolves with the JSON object
  // the API passes to that callback. Honours an AbortSignal and times out.
  function loadJsonp(url, signal) {
    return new Promise((resolve, reject) => {
      const cbName = "__searchCb_" + Math.random().toString(36).slice(2);
      const script = document.createElement("script");
      let settled = false;

      function cleanup() {
        settled = true;
        delete window[cbName];
        script.remove();
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      function onAbort() {
        if (settled) return;
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      }

      window[cbName] = (data) => { if (settled) return; cleanup(); resolve(data); };
      script.onerror = () => { if (settled) return; cleanup(); reject(new Error("Search request failed")); };
      const timer = setTimeout(() => { if (settled) return; cleanup(); reject(new Error("Search timed out")); }, 10000);

      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort);
      }

      script.src = url + "&callback=" + cbName;
      document.head.appendChild(script);
    });
  }

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
    const now = Date.now();
    const id = `custom:${now}:${Math.random().toString(36).slice(2, 8)}`;
    dropTomb(id);
    library.push({
      id,
      title,
      artist: customArtistInput.value.trim(),
      album: "",
      year: "",
      artworkUrl: "",
      custom: true,
      favorite: false,
      savedAt: now,
      updatedAt: now,
    });
    commit();
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

    const signal = searchAbortController.signal;

    // Try each catalogue in turn (Deezer, then iTunes), with one quiet retry
    // apiece -- these endpoints occasionally drop a single request. The error
    // message only shows if every source fails.
    async function fetchSongs() {
      let lastErr = null;
      for (const source of SEARCH_SOURCES) {
        for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt++) {
          try {
            const data = await loadJsonp(source.url(term), signal);
            return source.toSongs(data);
          } catch (err) {
            if (err.name === "AbortError") throw err;
            lastErr = err;
            if (attempt < SEARCH_RETRIES) {
              await new Promise((r) => setTimeout(r, SEARCH_RETRY_DELAY_MS));
              if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            }
          }
        }
      }
      throw lastErr || new Error("Search failed");
    }

    try {
      const results = dedupeByTrack(await fetchSongs());

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

    // Lyrics-with-chords sheet (js/songsheet.js). Available for every song,
    // custom ones included -- a custom song is exactly where you'd paste
    // your own sheet.
    if (window.GuitarSongSheet) window.GuitarSongSheet.open(currentDetailSong);

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
    if (window.GuitarSongSheet) window.GuitarSongSheet.close();
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
      // Remove from library -- and record the deletion so a merge with an
      // older copy (backup file / another device) doesn't resurrect it.
      addTomb(currentDetailId);
      library = library.filter((s) => s.id !== currentDetailId);
      commit();
      currentDetailSong = { ...currentDetailSong, favorite: false };
      updateSaveButton(false);
      detailFavBtn.setAttribute("aria-pressed", "false");
    } else {
      // Save to library.
      const now = Date.now();
      dropTomb(currentDetailId);
      const entry = { ...currentDetailSong, favorite: false, savedAt: now, updatedAt: now };
      library.push(entry);
      commit();
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
    library = loadSongs(currentInstrument());
    tombstones = loadTombs(currentInstrument());
    renderLibraryList();
  });

  /* ---------- Merge, snapshots, backup ---------- */
  // Pure: fold two {songs, tombstones} snapshots of ONE instrument into one.
  // Union by song id; when an id is on both sides the row with the newer
  // `updatedAt` wins. A tombstone removes a song only when the deletion is
  // at least as new as that row -- so re-adding a song after deleting it on
  // another device sticks. Tombstones past their TTL, or for a song that was
  // re-added more recently, are dropped.
  //
  // NOTE: the Cloudflare Worker in /server runs an identical merge; keep the
  // two in step if this changes.
  function mergeSnapshots(a, b) {
    const now = Date.now();

    const tombs = new Map();
    [].concat(a.tombstones || [], b.tombstones || []).forEach((t) => {
      if (!t || !t.id) return;
      const prev = tombs.get(t.id);
      if (!prev || (t.deletedAt || 0) > (prev.deletedAt || 0)) {
        tombs.set(t.id, { id: t.id, deletedAt: t.deletedAt || 0 });
      }
    });

    const rows = new Map();
    [].concat(a.songs || [], b.songs || []).forEach((s) => {
      if (!s || !s.id) return;
      const prev = rows.get(s.id);
      if (!prev || (s.updatedAt || 0) >= (prev.updatedAt || 0)) rows.set(s.id, s);
    });

    const songs = [];
    rows.forEach((s, id) => {
      const t = tombs.get(id);
      if (t && (t.deletedAt || 0) >= (s.updatedAt || 0)) return; // stays deleted
      songs.push(s);
    });

    const keptTombs = [];
    tombs.forEach((t, id) => {
      if (now - (t.deletedAt || 0) > TOMB_TTL_MS) return;
      const s = rows.get(id);
      if (s && (s.updatedAt || 0) > (t.deletedAt || 0)) return; // re-added since
      keptTombs.push(t);
    });

    return { songs: songs, tombstones: keptTombs };
  }

  function snapshotOf(inst) {
    return { songs: loadSongs(inst), tombstones: loadTombs(inst) };
  }

  // The whole app's library state, both instruments -- what a backup file
  // holds and what the cloud sync sends up.
  function getAllSnapshot() {
    const out = {};
    INSTRUMENTS.forEach((inst) => (out[inst] = snapshotOf(inst)));
    return out;
  }

  // Merge an incoming {guitar:{songs,tombstones}, piano:{...}} into local
  // storage. Returns the merged result and re-renders the visible list.
  function applySnapshot(incoming) {
    if (!incoming || typeof incoming !== "object") return getAllSnapshot();
    const merged = {};
    INSTRUMENTS.forEach((inst) => {
      const inSnap = incoming[inst];
      merged[inst] = inSnap
        ? mergeSnapshots(snapshotOf(inst), {
            songs: normalizeSongs(Array.isArray(inSnap.songs) ? inSnap.songs : []),
            tombstones: Array.isArray(inSnap.tombstones) ? inSnap.tombstones : [],
          })
        : snapshotOf(inst);
      persist(inst, merged[inst].songs, merged[inst].tombstones);
    });
    const cur = currentInstrument();
    library = loadSongs(cur);
    tombstones = loadTombs(cur);
    renderLibraryList();
    return merged;
  }

  function exportData() {
    return JSON.stringify(
      { app: "guitar", format: 1, exportedAt: Date.now(), libraries: getAllSnapshot() },
      null,
      2
    );
  }

  // Takes the parsed contents of a backup file and merges it in. Throws if
  // it isn't a Guitar backup.
  function importData(obj) {
    if (!obj || obj.app !== "guitar" || !obj.libraries || typeof obj.libraries !== "object") {
      throw new Error("Not a Guitar backup file.");
    }
    return applySnapshot(obj.libraries);
  }

  function countSongs(snap) {
    return INSTRUMENTS.reduce(
      (n, inst) => n + ((snap[inst] && snap[inst].songs.length) || 0),
      0
    );
  }

  // Exposed for js/sync.js (optional cloud sync).
  window.GuitarLibrary = { getAllSnapshot, applySnapshot };

  /* ---------- Backup buttons (Settings) ---------- */
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFile = document.getElementById("import-file");
  const backupStatus = document.getElementById("backup-status");

  function setBackupStatus(msg, isError) {
    if (!backupStatus) return;
    backupStatus.textContent = msg || "";
    backupStatus.classList.toggle("is-error", Boolean(isError));
  }

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      try {
        const date = new Date().toISOString().slice(0, 10);
        const blob = new Blob([exportData()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `guitar-library-${date}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setBackupStatus(`Saved guitar-library-${date}.json`);
      } catch (err) {
        setBackupStatus("Couldn't export: " + err.message, true);
      }
    });
  }

  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const before = countSongs(getAllSnapshot());
          importData(JSON.parse(reader.result));
          const added = countSongs(getAllSnapshot()) - before;
          setBackupStatus(
            added > 0
              ? `Merged in — ${added} new song${added === 1 ? "" : "s"}.`
              : "Merged in — nothing new to add."
          );
        } catch (err) {
          setBackupStatus("Couldn't import: " + err.message, true);
        }
        importFile.value = "";
      };
      reader.onerror = () => {
        setBackupStatus("Couldn't read that file.", true);
        importFile.value = "";
      };
      reader.readAsText(file);
    });
  }

  /* ---------- Init ---------- */
  renderLibraryList();
})();
