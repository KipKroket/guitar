// Guitar — Spotify mini-player, in the audio dock (js/audiodock.js).
//
// Full Web Playback SDK integration: Authorization Code + PKCE (no client
// secret -- this is a static site, there's nowhere safe to keep one), so the
// track plays right here through the SDK's own Connect device instead of
// just deep-linking out to the Spotify app. Login is a full-page redirect
// rather than a popup, since popup-opener communication is unreliable in an
// installed PWA (display: standalone).
(function () {
  const CLIENT_ID = "99a246ef848b415495379456d334b121";
  // Must exactly match a redirect URI registered on the Spotify app -- only
  // works from the real deployed origin, not a local preview.
  const REDIRECT_URI = "https://kipkroket.github.io/guitar/";
  const SCOPES = "streaming user-read-email user-read-private";
  const AUTH_KEY = "guitar-spotify-auth"; // { access_token, refresh_token, expires_at }
  const PKCE_KEY = "guitar-spotify-pkce"; // sessionStorage, cleared right after the redirect back

  /* ---------- PKCE + token storage ---------- */

  function base64UrlEncode(bytes) {
    let str = "";
    bytes.forEach((b) => (str += String.fromCharCode(b)));
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomToken(len) {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(len)));
  }
  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64UrlEncode(new Uint8Array(digest));
  }

  function loadAuth() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function saveAuth(data, previous) {
    const auth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || (previous && previous.refresh_token) || null,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth;
  }
  function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
  }
  function isLoggedIn() {
    return Boolean(loadAuth());
  }

  async function tokenRequest(body) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
      throw new Error((data && data.error_description) || "Spotify login failed.");
    }
    return data;
  }

  // Refreshes ~1 minute ahead of expiry; returns null (and drops the stored
  // auth) if there's nothing to refresh with, or the refresh itself fails --
  // a revoked/expired session, which just means logging in again.
  async function getValidToken() {
    const auth = loadAuth();
    if (!auth) return null;
    if (auth.expires_at - Date.now() > 60000) return auth.access_token;
    if (!auth.refresh_token) {
      clearAuth();
      return null;
    }
    try {
      const data = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: auth.refresh_token,
        client_id: CLIENT_ID,
      });
      return saveAuth(data, auth).access_token;
    } catch (e) {
      clearAuth();
      return null;
    }
  }

  async function login() {
    const verifier = randomToken(64);
    const challenge = await pkceChallenge(verifier);
    const state = randomToken(16);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });
    location.href = "https://accounts.spotify.com/authorize?" + params.toString();
  }

  // Runs once at load: if Spotify just redirected back with ?code=&state=,
  // exchange it for tokens and strip the query string immediately -- both so
  // a reload doesn't try to redeem the same code twice, and so sw.js's
  // cache-first handler never sees (and caches) a one-off "?code=..." URL.
  (async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    } catch (e) {
      /* ignore */
    }
    sessionStorage.removeItem(PKCE_KEY);
    if (!saved || saved.state !== returnedState) return; // stale or foreign redirect -- ignore
    try {
      const data = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: saved.verifier,
      });
      saveAuth(data, null);
    } catch (e) {
      /* nothing sensible to show yet -- the panel isn't open. Tapping the
         Spotify button again just offers to log in once more. */
    }
  })();

  /* ---------- Web Playback SDK ---------- */

  let sdkPromise = null;
  function loadSdk() {
    if (window.Spotify) return Promise.resolve(window.Spotify);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
      const s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  let player = null;
  let deviceId = null;
  let playerPromise = null;
  let lastState = null; // most recent player_state_changed payload
  let onStateChange = null; // set by the open panel while it's on screen

  function ensurePlayer() {
    if (playerPromise) return playerPromise;
    playerPromise = loadSdk().then(
      (Spotify) =>
        new Promise((resolve, reject) => {
          player = new Spotify.Player({
            name: "Gitaar",
            getOAuthToken: (cb) => {
              getValidToken().then((t) => cb(t || ""));
            },
            volume: 1,
          });
          player.addListener("ready", ({ device_id }) => {
            deviceId = device_id;
            resolve(player);
          });
          player.addListener("not_ready", () => {
            deviceId = null;
          });
          player.addListener("player_state_changed", (state) => {
            lastState = state;
            if (onStateChange) onStateChange(state);
          });
          player.addListener("initialization_error", ({ message }) => reject(new Error(message)));
          player.addListener("authentication_error", () => {
            clearAuth();
            reject(new Error("Je Spotify-sessie is verlopen -- log opnieuw in."));
          });
          player.addListener("account_error", () =>
            reject(new Error("Dit werkt alleen met Spotify Premium."))
          );
          player.connect();
        })
    );
    return playerPromise;
  }

  async function resolveTrackId(song) {
    if (song.spotifyTrackId) return song.spotifyTrackId;
    const token = await getValidToken();
    if (!token) return null;
    const q = `${song.artist || ""} ${song.title || ""}`.trim();
    const res = await fetch(
      "https://api.spotify.com/v1/search?type=track&limit=1&q=" + encodeURIComponent(q),
      { headers: { Authorization: "Bearer " + token } }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const track = data && data.tracks && data.tracks.items && data.tracks.items[0];
    if (!track) return null;
    song.spotifyTrackId = track.id;
    if (window.GuitarLibrary && window.GuitarLibrary.setSongField) {
      window.GuitarLibrary.setSongField(song.id, { spotifyTrackId: track.id });
    }
    return track.id;
  }

  async function playSong(song) {
    const token = await getValidToken();
    if (!token) throw new Error("not-logged-in");
    await ensurePlayer();
    const trackId = await resolveTrackId(song);
    if (!trackId) throw new Error("Kon dit nummer niet vinden op Spotify.");
    const res = await fetch("https://api.spotify.com/v1/me/player/play?device_id=" + deviceId, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: ["spotify:track:" + trackId] }),
    });
    if (!res.ok && res.status !== 204) throw new Error("Afspelen is niet gelukt.");
  }

  function pause() {
    if (player) player.pause().catch(() => {});
  }
  function stop() {
    pause();
  }

  /* ---------- Fallback search link (unchanged from the old header button) ---------- */
  function fallbackUrl(song) {
    const q = `${song.artist || ""} ${song.title || ""}`.trim();
    return "https://open.spotify.com/search/" + encodeURIComponent(q);
  }

  /* ---------- Panel UI ---------- */

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function buildPanel(song) {
    const panel = el("div", "audio-dock__panel");

    if (!isLoggedIn()) {
      panel.appendChild(el("p", "audio-dock__hint", "Log in met je eigen Spotify-account om dit nummer hier af te spelen."));
      const loginBtn = el("button", "songsheet__btn songsheet__btn--primary", "Inloggen met Spotify");
      loginBtn.type = "button";
      loginBtn.addEventListener("click", () => login());
      panel.appendChild(loginBtn);
      panel.appendChild(fallbackLink(song));
      return panel;
    }

    const status = el("p", "audio-dock__status", "Verbinden…");
    panel.appendChild(status);

    const head = el("div", "audio-dock__track");
    const art = el("img", "audio-dock__art");
    art.alt = "";
    art.src = song.artworkUrl || "";
    head.appendChild(art);
    const meta = el("div", "audio-dock__track-meta");
    meta.appendChild(el("div", "audio-dock__track-title", song.title));
    meta.appendChild(el("div", "audio-dock__track-artist", song.artist || ""));
    head.appendChild(meta);
    panel.appendChild(head);
    head.hidden = true;

    const controls = el("div", "audio-dock__controls");
    const playPause = el("button", "audio-dock__playpause", "");
    playPause.type = "button";
    playPause.setAttribute("aria-label", "Play/pause");
    playPause.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>';
    playPause.disabled = true;
    controls.appendChild(playPause);
    const progress = el("div", "audio-dock__progress");
    const progressFill = el("div", "audio-dock__progress-fill");
    progress.appendChild(progressFill);
    controls.appendChild(progress);
    const time = el("span", "audio-dock__time", "0:00");
    controls.appendChild(time);
    panel.appendChild(controls);
    controls.hidden = true;

    let started = false;

    function renderState(state) {
      if (!state) return;
      head.hidden = false;
      controls.hidden = false;
      status.hidden = true;
      playPause.disabled = false;
      playPause.classList.toggle("is-playing", !state.paused);
      playPause.innerHTML = state.paused
        ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="7" y="5.5" width="4" height="13" fill="currentColor"/><rect x="14" y="5.5" width="4" height="13" fill="currentColor"/></svg>';
      const dur = (state.duration || state.track_window.current_track.duration_ms) || 0;
      const pct = dur ? Math.min(100, (state.position / dur) * 100) : 0;
      progressFill.style.width = pct + "%";
      time.textContent = formatTime(state.position) + " / " + formatTime(dur);
    }

    onStateChange = renderState;

    playPause.addEventListener("click", () => {
      if (!player) return;
      if (!started) return; // still connecting -- ignore stray taps
      player.togglePlay().catch(() => {});
    });

    playSong(song)
      .then(() => {
        started = true;
        if (lastState) renderState(lastState);
      })
      .catch((err) => {
        status.hidden = false;
        status.classList.add("audio-dock__status--error");
        status.textContent =
          (err && err.message === "not-logged-in"
            ? "Log opnieuw in."
            : (err && err.message) || "Afspelen is niet gelukt.") +
          " Je kunt het nummer ook in de echte app openen.";
      });

    panel.appendChild(fallbackLink(song));
    return panel;
  }

  function fallbackLink(song) {
    const a = el("a", "audio-dock__fallback", "Open in Spotify");
    a.href = fallbackUrl(song);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  /* ---------- Dock button ---------- */

  const SPOTIFY_SVG =
    '<svg viewBox="0 0 168 168" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M83.996.277C37.747.277.253 37.77.253 84.019c0 46.251 37.494 83.741 83.743 83.741 46.254 0 83.744-37.49 83.744-83.741 0-46.246-37.49-83.738-83.745-83.738l.001-.004zm38.404 120.78a5.217 5.217 0 01-7.18 1.73c-19.662-12.01-44.414-14.73-73.564-8.07a5.222 5.222 0 01-6.249-3.93 5.213 5.213 0 013.926-6.25c31.9-7.291 59.263-4.15 81.337 9.34 2.46 1.51 3.24 4.72 1.73 7.18zm10.25-22.805c-1.89 3.075-5.91 4.045-8.98 2.155-22.51-13.839-56.823-17.846-83.448-9.764-3.453 1.043-7.1-.903-8.148-4.35a6.538 6.538 0 014.354-8.143c30.413-9.228 68.222-4.758 94.072 11.127 3.07 1.89 4.04 5.91 2.15 8.98v-.005zm.88-23.744c-26.99-16.031-71.52-17.505-97.289-9.684-4.138 1.255-8.514-1.081-9.768-5.219a7.835 7.835 0 015.221-9.771c29.581-8.98 78.756-7.245 109.83 11.202a7.823 7.823 0 012.74 10.733c-2.2 3.722-7.02 4.949-10.73 2.739z"/></svg>';

  if (window.GuitarAudioDock) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "audio-dock__btn";
    btn.setAttribute("aria-label", "Spotify");
    btn.innerHTML = SPOTIFY_SVG;
    btn.addEventListener("click", () => {
      const ctx = window.GuitarAudioDock.getContext();
      if (!ctx.song) return;
      onStateChange = null;
      if (window.GuitarBackingTrack) window.GuitarBackingTrack.stop();
      window.GuitarAudioDock.togglePanel("spotify", () => buildPanel(ctx.song), () => {
        onStateChange = null;
        pause();
      });
    });
    document.addEventListener("audiodockpanelchange", (e) => {
      btn.classList.toggle("is-active", e.detail && e.detail.openId === "spotify");
    });
    window.GuitarAudioDock.registerButton(btn);
  }

  window.GuitarSpotify = { stop, pause };
})();
