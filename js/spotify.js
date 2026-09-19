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
    const attempt = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Couldn't load Spotify.")), 15000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        clearTimeout(timer);
        resolve(window.Spotify);
      };
      const s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Couldn't load Spotify."));
      };
      document.head.appendChild(s);
    });
    // A failed load (offline, blocked, timed out) must not stay cached, or
    // every later tap replays the same failure until the app is restarted.
    attempt.catch(() => {
      if (sdkPromise === attempt) sdkPromise = null;
      document.querySelectorAll('script[src*="sdk.scdn.co"]').forEach((n) => n.remove());
    });
    sdkPromise = attempt;
    return attempt;
  }

  let player = null;
  let deviceId = null;
  let playerPromise = null;
  let currentTrackId = null; // set by playSong() -- read by getSourceKey() for lyric sync
  let lastState = null; // most recent player_state_changed payload
  let lastStateAt = 0; // Date.now() when lastState arrived -- see posTicker
  let onStateChange = null; // set by the open panel while it's on screen
  // player_state_changed only fires on notable events (play/pause/seek/track
  // change), not on a steady clock -- without this the bar's clock just sat
  // frozen between those events instead of visibly counting up. Ticks by
  // interpolating from lastState/lastStateAt rather than polling the SDK
  // (there's no getCurrentTime()-style call on it).
  let posTicker = null;
  function stopPosTicker() {
    if (posTicker != null) {
      clearInterval(posTicker);
      posTicker = null;
    }
  }

  // Waiters for the *next* "ready" event, used when the device has gone
  // not_ready since ensurePlayer() last resolved (see waitForDevice() and
  // playSong() below).
  let deviceWaiters = [];

  // Resolved once by the SDK's own "ready" event and then cached forever --
  // deliberately, connecting is slow and only needs to happen once. The
  // trouble is a *rejected* playerPromise used to stay cached just as
  // permanently: one bad token/init hiccup and every later attempt replayed
  // that exact same stale error, with no way out short of a full reload
  // (a fresh page load is a fresh module scope, i.e. a fresh null
  // playerPromise) -- which is exactly the "close the app and reopen it"
  // workaround this was causing. Dropping the promise on rejection instead
  // lets the very next tap start a genuinely new connect attempt.
  function ensurePlayer() {
    if (playerPromise) return playerPromise;
    const attempt = loadSdk().then(
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
            const waiters = deviceWaiters;
            deviceWaiters = [];
            waiters.forEach((w) => w(device_id));
          });
          // Spotify drops an idle Connect device after a while (and a
          // backgrounded iOS tab can simply lose the connection outright)
          // -- noting that here is what lets playSong() below notice
          // *before* it fires a play request at a device_id that's gone
          // stale, rather than letting Spotify silently route that request
          // to whatever device happens to be active instead (see
          // waitForDevice()).
          player.addListener("not_ready", () => {
            deviceId = null;
          });
          player.addListener("player_state_changed", (state) => {
            lastState = state;
            lastStateAt = Date.now();
            if (onStateChange) onStateChange(state);
          });
          player.addListener("initialization_error", ({ message }) => reject(new Error(message)));
          player.addListener("authentication_error", () => {
            clearAuth();
            reject(new Error("Your Spotify session has expired -- log in again."));
          });
          player.addListener("account_error", () =>
            reject(new Error("This only works with Spotify Premium."))
          );
          // "ready" never arriving (dead websocket, SDK stuck) used to hang
          // on "Connecting…" forever -- treat it as a failed attempt.
          const readyTimer = setTimeout(() => reject(new Error("Couldn't connect to Spotify.")), 15000);
          player.addListener("ready", () => clearTimeout(readyTimer));
          player.connect();
        })
    );
    attempt.catch(() => {
      if (playerPromise === attempt) resetPlayer();
    });
    playerPromise = attempt;
    return playerPromise;
  }

  // Throws away the current SDK player entirely, so the next ensurePlayer()
  // builds a fresh one. Reconnecting the *same* player object after the
  // connection has gone bad is what used to leave "Spotify couldn't
  // connect" stuck until the whole app was restarted.
  function resetPlayer() {
    if (player) {
      try {
        player.disconnect();
      } catch (e) {
        /* already gone */
      }
    }
    player = null;
    deviceId = null;
    playerPromise = null;
    lastState = null;
  }

  // A backgrounded iOS app routinely loses the SDK's connection; nudge it
  // back the moment the app is visible again instead of waiting for the
  // next play tap to discover it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && player && !deviceId) player.connect();
  });

  function waitForDevice() {
    if (deviceId) return Promise.resolve(deviceId);
    if (!player) return Promise.reject(new Error("Spotify isn't connected."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        deviceWaiters = deviceWaiters.filter((w) => w !== onReady);
        reject(new Error("Couldn't reconnect to Spotify."));
      }, 8000);
      function onReady(id) {
        clearTimeout(timer);
        resolve(id);
      }
      deviceWaiters.push(onReady);
      // Nudges the SDK to re-establish its Connect session; a no-op if it's
      // already (re)connecting on its own.
      player.connect();
    });
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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Connects (fresh player if needed) and returns a usable device_id.
  async function readyDevice() {
    await ensurePlayer();
    // The device the SDK registered can have gone stale since (idle
    // timeout, a backgrounded tab losing its connection, ...) without us
    // finding out until now. Firing /play at a dead device_id doesn't
    // reliably error out -- Spotify can instead just resume whatever
    // *other* device (phone, desktop, ...) happens to be active, with
    // whatever it already had playing. Reconnecting first is what actually
    // prevents that "plays a random already-going track" behaviour.
    if (!deviceId) await waitForDevice();
    return deviceId;
  }

  async function playSong(song) {
    if (!(await getValidToken())) throw new Error("not-logged-in");
    // Whatever the previous song left behind must not be mistaken for this
    // one's state (see the verification below and renderState()).
    lastState = null;
    let device;
    try {
      device = await readyDevice();
    } catch (err) {
      // One clean retry on a brand-new player before giving up.
      resetPlayer();
      device = await readyDevice();
    }
    const trackId = await resolveTrackId(song);
    if (!trackId) throw new Error("Couldn't find this song on Spotify.");
    currentTrackId = trackId;

    // Spotify's /play can return 204 while the device keeps (or resumes)
    // the previous track -- so after each request, check what the player
    // actually loaded and re-send if it's not this song.
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await getValidToken();
      if (!token) throw new Error("not-logged-in");
      const res = await fetch("https://api.spotify.com/v1/me/player/play?device_id=" + device, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: ["spotify:track:" + trackId] }),
      });
      if (!res.ok && res.status !== 204) {
        // A 404 here means Spotify no longer recognises this device_id at
        // all -- drop the player so the next attempt reconnects from scratch
        // instead of repeating the same failing request against a dead id.
        if (res.status === 404) resetPlayer();
        throw new Error("Playback failed.");
      }
      await sleep(1200);
      if (currentTrackId !== trackId) return; // user already moved on to another song
      const st = player && (await player.getCurrentState().catch(() => null));
      const cur = st && st.track_window && st.track_window.current_track;
      if (!cur) continue;
      if (cur.id === trackId || (cur.linked_from && cur.linked_from.id === trackId)) return;
    }
  }

  function pause() {
    if (player) player.pause().catch(() => {});
  }
  function stop() {
    pause();
  }
  function seekTo(ms) {
    if (player) player.seek(Math.max(0, ms | 0)).catch(() => {});
  }

  // Read by js/songsheet.js for lyric-sync autoscroll -- same interpolation
  // renderTick() uses for the now-playing bar's clock, just exposed outside
  // this closure. null while nothing has ever reported a state yet.
  function getPosition() {
    if (!lastState) return null;
    return lastState.paused ? lastState.position : lastState.position + (Date.now() - lastStateAt);
  }
  // Sync points are stored per source *recording*, not per song -- a
  // different Spotify track for the same song has different timing.
  function getSourceKey() {
    return currentTrackId ? "spotify:" + currentTrackId : null;
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

  // Setup-only popover: shown while logged out, so login (and the fallback
  // link) has somewhere to live. Once logged in, tapping the dock button
  // skips this entirely and goes straight to the now-playing bar below --
  // playback controls never live in a card floating over the lyrics.
  function buildLoginPanel(song) {
    const panel = el("div", "audio-dock__panel");
    panel.appendChild(el("p", "audio-dock__hint", "Log in with your own Spotify account to play this song here."));
    const loginBtn = el("button", "songsheet__btn songsheet__btn--primary", "Log in with Spotify");
    loginBtn.type = "button";
    loginBtn.addEventListener("click", () => login());
    panel.appendChild(loginBtn);
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

  // The persistent now-playing bar (js/audiodock.js's showNowPlaying) --
  // slim on purpose: art thumbnail, play/pause, a tap-to-seek progress
  // track, time, and a close button. No title/artist text -- the point is
  // to stay out of the way of the lyrics, not to restate what's already on
  // the song detail page above it.
  function buildNowPlayingBar(song) {
    // A fragment, not a wrapping div -- these need to be direct children of
    // .audio-dock__bar (the flex row created by js/audiodock.js) themselves,
    // not nested inside another box.
    const bar = document.createDocumentFragment();

    const art = el("img", "audio-dock__bar-thumb");
    art.alt = "";
    art.src = song.artworkUrl || "";
    bar.appendChild(art);

    const status = el("p", "audio-dock__bar-status", "Connecting…");
    bar.appendChild(status);

    const playPause = el("button", "audio-dock__playpause", "");
    playPause.type = "button";
    playPause.setAttribute("aria-label", "Play/pause");
    playPause.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>';
    playPause.disabled = true;
    playPause.hidden = true;
    bar.appendChild(playPause);

    const progress = el("div", "audio-dock__progress");
    const progressFill = el("div", "audio-dock__progress-fill");
    progress.appendChild(progressFill);
    progress.hidden = true;
    bar.appendChild(progress);

    const time = el("span", "audio-dock__time", "0:00");
    time.hidden = true;
    bar.appendChild(time);

    const close = el("button", "audio-dock__bar-close", "");
    close.type = "button";
    close.setAttribute("aria-label", "Stop");
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.addEventListener("click", () => window.GuitarAudioDock.hideNowPlaying());
    bar.appendChild(close);

    let started = false;
    let lastDur = 0;
    // playSong() below starts playback immediately (the Web API's /play
    // endpoint has no "load but don't play" mode) -- armed until the first
    // genuinely-playing state comes back, at which point it's paused right
    // back, so opening the bar *loads* the track rather than launching into
    // it. A brief flash of audio during that round-trip is the tradeoff.
    let autoPauseArmed = true;
    const seekBar = window.GuitarAudioDock.wireSeekBar(progress, progressFill, time, {
      getDuration: () => lastDur,
      onSeek: (ms) => seekTo(ms),
      formatTime: (ms) => formatTime(ms) + " / " + formatTime(lastDur),
    });

    function renderState(state) {
      if (!state) return;
      if (autoPauseArmed && !state.paused) {
        // Only the track we actually asked for counts -- a leftover state
        // from the previous song must not use up the armed auto-pause
        // (playSong() re-sends /play until the right track is loaded).
        const cur = state.track_window && state.track_window.current_track;
        if (!cur || (cur.id !== currentTrackId && !(cur.linked_from && cur.linked_from.id === currentTrackId))) return;
        autoPauseArmed = false;
        pause();
        return; // the pause() call re-fires this listener with paused:true
      }
      status.hidden = true;
      playPause.hidden = false;
      progress.hidden = false;
      time.hidden = false;
      playPause.disabled = false;
      playPause.classList.toggle("is-playing", !state.paused);
      playPause.innerHTML = state.paused
        ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="7" y="5.5" width="4" height="13" fill="currentColor"/><rect x="14" y="5.5" width="4" height="13" fill="currentColor"/></svg>';
      const dur = (state.duration || state.track_window.current_track.duration_ms) || 0;
      lastDur = dur;
      stopPosTicker();
      if (!state.paused) posTicker = setInterval(renderTick, 400);
      renderTick();
    }

    // Interpolates from the last known state rather than re-reading it --
    // player_state_changed doesn't fire on a steady clock, so this is what
    // actually makes the displayed time count up while playing.
    function renderTick() {
      if (seekBar.isDragging() || !lastState) return; // don't fight the drag preview
      const dur = lastDur;
      const pos = lastState.paused ? lastState.position : lastState.position + (Date.now() - lastStateAt);
      const clamped = dur ? Math.min(dur, pos) : pos;
      const pct = dur ? Math.min(100, (clamped / dur) * 100) : 0;
      progressFill.style.width = pct + "%";
      time.textContent = formatTime(clamped) + " / " + formatTime(dur);
    }

    onStateChange = renderState;

    playPause.addEventListener("click", () => {
      if (!player || !started) return; // still connecting -- ignore stray taps
      player.togglePlay().catch(() => {});
    });

    playSong(song)
      .then(() => {
        started = true;
        if (lastState) renderState(lastState);
      })
      .catch((err) => {
        // Playback never got going -- the slim bar has no room for an error
        // message, so drop back to the login/fallback popover instead.
        window.GuitarAudioDock.hideNowPlaying();
        const msg =
          (err && err.message === "not-logged-in"
            ? "Log in again."
            : (err && err.message) || "Playback failed.") +
          " You can also open the song in the actual app.";
        window.GuitarAudioDock.togglePanel(
          "spotify",
          () => {
            const panel = el("div", "audio-dock__panel");
            const p = el("p", "audio-dock__status audio-dock__status--error", msg);
            panel.appendChild(p);
            if (!isLoggedIn()) {
              const loginBtn = el("button", "songsheet__btn songsheet__btn--primary", "Log in again");
              loginBtn.type = "button";
              loginBtn.addEventListener("click", () => login());
              panel.appendChild(loginBtn);
            }
            panel.appendChild(fallbackLink(song));
            return panel;
          },
          null
        );
      });

    return bar;
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
      if (window.GuitarAudioDock.isNowPlaying("spotify")) {
        window.GuitarAudioDock.hideNowPlaying(); // tapping again stops it
        return;
      }
      onStateChange = null;
      if (window.GuitarBackingTrack) window.GuitarBackingTrack.stop();
      if (!isLoggedIn()) {
        window.GuitarAudioDock.togglePanel("spotify", () => buildLoginPanel(ctx.song), null);
        return;
      }
      window.GuitarAudioDock.showNowPlaying("spotify", buildNowPlayingBar(ctx.song), () => {
        onStateChange = null;
        stopPosTicker();
        pause();
      });
    });
    document.addEventListener("audiodockpanelchange", (e) => {
      btn.classList.toggle("is-active", e.detail && e.detail.openId === "spotify");
    });
    window.GuitarAudioDock.registerButton(btn);
  }

  window.GuitarSpotify = { stop, pause, getPosition, getSourceKey };
})();
