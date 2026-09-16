// Guitar — "samen jammen": follow someone's lyrics & chords scroll live.
//
// Host: broadcasts what js/songsheet.js's getJamSnapshot() says it's
// currently showing (which song, which of the three autoscroll flavors --
// timestamps / fixed-tempo / play along -- and the position within it) to
// a tiny Cloudflare Worker+D1 relay (see /server/schema.sql, jam_sessions).
// Follower: polls that same session and renders a read-only view of it,
// reusing songsheet.js's own parse/transpose/render functions (exported on
// window.GuitarSongSheet) so it looks exactly like the host's screen.
//
// Polled, not pushed -- no WebSocket/Durable Object, so this stays on the
// same free Workers+D1 plan the rest of the backend runs on (see the
// server README). That means a second or two of lag, fine for following
// lyrics, not meant for anything tighter.
(function () {
  const API_BASE = "https://guitar-sync.julianleendertse.workers.dev/jam";
  const HOST_TICK_MS = 1200;
  const FOLLOW_POLL_MS = 2000;
  // sessionStorage, not localStorage -- a jam is a one-sitting thing, and a
  // stale "still hosting"/"still following" flag lingering into an
  // unrelated future app open would be worse than just starting fresh.
  const SESSION_KEY = "guitar-jam-session";

  let session = loadSession(); // {role:'host', code, hostToken} | {role:'follower', code, followerId} | null
  let hostTimer = null;
  let followTimer = null;
  let lastSentSnapshot = null; // {song, sheet} last actually sent, to skip resending unchanged text
  let hostParticipantCount = 0;
  let islandExpanded = false;
  let confirmStop = false;
  let autoFollow = true;

  let followerEls = null; // built lazily, see ensureFollowerView()
  let followerRenderedKey = null; // song identity currently rendered in followerEls.body
  let followerShown = null; // transposeModel() result for the currently rendered sheet
  let followerSteps = null; // buildChordSteps() result for the currently rendered sheet
  let followerChordEls = null; // "lineIdx:order" -> chord element, for incremental play-along highlighting
  let followerLastData = null; // most recent /poll response, reapplied after an instrument-toggle rebuild
  // Which instrument's diagrams a follower sees for chord chips/popovers --
  // independent of the host's own instrument and of this follower's own app
  // identity (switching that would also flip the tuner, nav colours, etc.
  // just to read a chord while jamming). Starts matching this follower's own
  // app so the common case -- a piano player joining -- needs no tap at all.
  let followerInstrument = (window.GuitarApp && window.GuitarApp.getInstrument()) || document.body.dataset.instrument || "guitar";

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function saveSession(s) {
    session = s;
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  }

  function randomId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  async function api(path, body) {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || "Request failed (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  /* =====================================================================
     Host
     ===================================================================== */

  async function startJam() {
    if (session && session.role === "follower") leaveJam();
    setIdleStatus("Starting…", false);
    try {
      const data = await api("/create", { song: {}, sheet: { raw: "" } });
      saveSession({ role: "host", code: data.code, hostToken: data.hostToken });
      lastSentSnapshot = null;
      hostParticipantCount = 0;
      setIdleStatus("", false);
      hostTimer = setInterval(hostTick, HOST_TICK_MS);
      hostTick();
      render();
    } catch (err) {
      setIdleStatus(err.message || "Couldn't start a jam.", true);
    }
  }

  async function hostTick() {
    if (!session || session.role !== "host") return;
    const SS = window.GuitarSongSheet;
    const snap = SS && SS.getJamSnapshot ? SS.getJamSnapshot() : null;

    const payload = { code: session.code, hostToken: session.hostToken };
    if (snap) {
      payload.mode = snap.mode;
      payload.pos = snap.pos;
      const changed =
        !lastSentSnapshot ||
        lastSentSnapshot.song.title !== snap.song.title ||
        lastSentSnapshot.song.artist !== snap.song.artist ||
        lastSentSnapshot.song.art !== snap.song.art ||
        lastSentSnapshot.sheet.raw !== snap.sheet.raw ||
        lastSentSnapshot.sheet.transpose !== snap.sheet.transpose;
      if (changed) {
        payload.song = snap.song;
        payload.sheet = snap.sheet;
        lastSentSnapshot = { song: snap.song, sheet: snap.sheet };
      }
    } else {
      payload.mode = "none";
    }

    try {
      const data = await api("/update", payload);
      hostParticipantCount = data.participantCount || 0;
      renderIsland();
      renderSettings();
    } catch (err) {
      // 403/404 means the session is gone server-side (expired, or this
      // browser's copy of hostToken is stale) -- stop cleanly rather than
      // hammering a dead session every tick. Any other error is presumed
      // transient (offline, Worker hiccup) and just retried next tick.
      if (err.status === 403 || err.status === 404) stopJamLocal();
    }
  }

  async function stopJam() {
    if (!session || session.role !== "host") return;
    if (hostTimer) {
      clearInterval(hostTimer);
      hostTimer = null;
    }
    try {
      await api("/end", { code: session.code, hostToken: session.hostToken });
    } catch (err) {
      /* best effort -- it'll expire on its own (JAM_STALE_MS) either way */
    }
    stopJamLocal();
  }

  // Clears local host state without an /end call -- used when the server
  // has already told us the session is gone.
  function stopJamLocal() {
    if (hostTimer) {
      clearInterval(hostTimer);
      hostTimer = null;
    }
    saveSession(null);
    lastSentSnapshot = null;
    hostParticipantCount = 0;
    confirmStop = false;
    islandExpanded = false;
    render();
  }

  async function shareJamLink() {
    if (!session || session.role !== "host") return;
    const url = new URL(location.origin + location.pathname);
    url.searchParams.set("jam", session.code);
    const link = url.toString();
    if (navigator.share) {
      try {
        await navigator.share({ title: "Join my jam", url: link });
      } catch (err) {
        /* user cancelled the share sheet -- fine */
      }
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(link);
        const btn = document.getElementById("jam-host-share-btn");
        if (btn) {
          const original = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = original;
          }, 1500);
        }
      } catch (err) {
        /* clipboard permission denied -- nothing more we can do here */
      }
    }
  }

  /* =====================================================================
     Follower
     ===================================================================== */

  async function joinJam(codeRaw) {
    const code = String(codeRaw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (code.length !== 4) {
      setIdleStatus("Enter the 4-letter code.", true);
      return;
    }
    if (session && session.role === "host") await stopJam();
    setIdleStatus("Joining…", false);
    const followerId = randomId();
    try {
      const data = await api("/poll", { code, followerId });
      saveSession({ role: "follower", code, followerId });
      autoFollow = true;
      ensureFollowerView();
      updateFollowerView(data);
      startFollowTimer();
      render();
    } catch (err) {
      setIdleStatus(
        err.status === 404 ? "That code wasn't found — check with the host." : "Couldn't join — try again.",
        true
      );
    }
  }

  function leaveJam() {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
    saveSession(null);
    teardownFollowerView();
    islandExpanded = false;
    render();
  }

  function startFollowTimer() {
    if (followTimer) clearInterval(followTimer);
    followTimer = setInterval(followTick, FOLLOW_POLL_MS);
  }

  async function followTick() {
    if (!session || session.role !== "follower") return;
    try {
      const data = await api("/poll", { code: session.code, followerId: session.followerId });
      updateFollowerView(data);
      renderIsland();
    } catch (err) {
      if (err.status === 404) {
        leaveJam();
        setIdleStatus("The jam has ended.", false);
      }
      // else: transient -- try again next tick
    }
  }

  /* ---- Follower's full-screen view --------------------------------- */

  function ensureFollowerView() {
    if (followerEls) return;
    const root = document.getElementById("jam-view");
    root.textContent = "";
    root.hidden = false;

    const header = el("div", "jam-view__header");
    const art = document.createElement("img");
    art.className = "jam-view__art";
    art.alt = "";
    art.hidden = true;
    header.appendChild(art);
    const meta = el("div", "jam-view__meta");
    const title = el("div", "jam-view__title");
    const artist = el("div", "jam-view__artist");
    meta.appendChild(title);
    meta.appendChild(artist);
    header.appendChild(meta);
    const leave = el("button", "jam-view__leave", "Leave");
    leave.type = "button";
    leave.addEventListener("click", leaveJam);
    header.appendChild(leave);
    root.appendChild(header);

    const followRow = el("div", "jam-view__follow-row");
    const followToggle = el("button", "jam-view__follow-toggle");
    followToggle.type = "button";
    followToggle.addEventListener("click", () => {
      autoFollow = !autoFollow;
      updateFollowToggleUI();
    });
    followRow.appendChild(followToggle);

    const instrumentToggle = el("button", "jam-view__follow-toggle");
    instrumentToggle.type = "button";
    instrumentToggle.addEventListener("click", () => {
      followerInstrument = followerInstrument === "piano" ? "guitar" : "piano";
      updateInstrumentToggleUI();
      if (followerShown) {
        const SS = window.GuitarSongSheet;
        const scrollTop = followerEls.root.scrollTop;
        renderFollowerChips(SS, followerShown);
        renderFollowerBody(SS, followerShown);
        followerEls.root.scrollTop = scrollTop;
        if (followerLastData) applyFollowerHighlight(followerLastData);
      }
    });
    followRow.appendChild(instrumentToggle);
    root.appendChild(followRow);

    const waiting = el("p", "jam-view__waiting", "Waiting for the host to open a song…");
    root.appendChild(waiting);

    const chipsWrap = el("div", "jam-view__chips-wrap");
    chipsWrap.hidden = true;
    root.appendChild(chipsWrap);

    const body = el("div", "jam-view__body songsheet__body");
    body.hidden = true;
    root.appendChild(body);

    followerEls = { root, art, title, artist, followToggle, instrumentToggle, waiting, chipsWrap, body };
    updateFollowToggleUI();
    updateInstrumentToggleUI();
  }

  function teardownFollowerView() {
    const root = document.getElementById("jam-view");
    root.hidden = true;
    root.textContent = "";
    followerEls = null;
    followerRenderedKey = null;
    followerShown = null;
    followerSteps = null;
    followerChordEls = null;
  }

  function updateFollowToggleUI() {
    if (!followerEls) return;
    followerEls.followToggle.textContent = autoFollow ? "Following" : "Paused — tap to resume";
    followerEls.followToggle.classList.toggle("is-active", autoFollow);
  }

  function updateInstrumentToggleUI() {
    if (!followerEls) return;
    followerEls.instrumentToggle.textContent = followerInstrument === "piano" ? "Piano chords" : "Guitar chords";
  }

  function updateFollowerView(data) {
    if (!followerEls) ensureFollowerView();
    followerLastData = data;
    const SS = window.GuitarSongSheet;
    const song = data.song || {};
    const sheet = data.sheet || { raw: "", transpose: 0 };
    const hasSong = !!(song.title || (sheet.raw && sheet.raw.trim()));

    followerEls.waiting.hidden = hasSong;
    followerEls.chipsWrap.hidden = !hasSong;
    followerEls.body.hidden = !hasSong;
    followerEls.art.hidden = !song.art;
    if (song.art) followerEls.art.src = song.art;
    followerEls.title.textContent = song.title || "";
    followerEls.artist.textContent = song.artist || "";

    if (!hasSong || !SS) return;

    const songKey = (song.title || "") + " " + (song.artist || "") + " " + sheet.raw + " " + (sheet.transpose | 0);
    if (songKey !== followerRenderedKey) {
      followerRenderedKey = songKey;
      const model = SS.parseSheet(sheet.raw);
      followerShown = SS.transposeModel(model, sheet.transpose | 0);
      followerSteps = SS.buildChordSteps(followerShown);
      renderFollowerChips(SS, followerShown);
      renderFollowerBody(SS, followerShown);
      followerEls.root.scrollTop = 0;
    }

    applyFollowerHighlight(data);
    applyFollowerScroll(data);
  }

  function renderFollowerChips(SS, shown) {
    followerEls.chipsWrap.textContent = "";
    const syms = SS.uniqueChords(shown);
    if (!syms.length) return;
    const row = el("div", "songsheet__chips");
    const card = el("div", "songsheet__chipcard");
    card.hidden = true;
    let openSym = null;
    syms.forEach((sym) => {
      const chip = el("button", "songsheet__chip", sym);
      chip.type = "button";
      chip.addEventListener("click", () => {
        if (openSym === sym) {
          openSym = null;
          card.hidden = true;
          card.textContent = "";
          Array.from(row.children).forEach((c) => c.classList.remove("is-active"));
          return;
        }
        openSym = sym;
        Array.from(row.children).forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        card.hidden = false;
        card.textContent = "";
        const ok = window.GuitarChords && window.GuitarChords.renderInto
          ? window.GuitarChords.renderInto(card, sym, followerInstrument)
          : false;
        if (!ok && !card.textContent) card.textContent = "No diagram for " + sym + ".";
      });
      row.appendChild(chip);
    });
    followerEls.chipsWrap.appendChild(row);
    followerEls.chipsWrap.appendChild(card);
  }

  function renderFollowerBody(SS, shown) {
    followerEls.body.textContent = "";
    let flatLineIdx = 0;
    shown.sections.forEach((section) => {
      const sec = el("div", "ss-section");
      if (section.label) sec.appendChild(el("div", "ss-section__label", section.label));
      section.lines.forEach((line) => {
        if (line == null) {
          sec.appendChild(el("div", "ss-break"));
          return;
        }
        const idx = flatLineIdx++;
        const lineEl = SS.renderLine(line, false, idx, null, followerInstrument);
        lineEl.dataset.lineIdx = String(idx);
        sec.appendChild(lineEl);
      });
      followerEls.body.appendChild(sec);
    });
    tagFollowerChordEls();
  }

  // Maps "lineIdx:order" (same numbering buildChordSteps() uses) to the
  // actual rendered chord element, so play-along highlighting can be
  // applied/cleared on poll updates without rebuilding the whole body (that
  // would reset whatever the follower has scrolled to manually).
  function tagFollowerChordEls() {
    followerChordEls = new Map();
    followerEls.body.querySelectorAll("[data-line-idx]").forEach((lineEl) => {
      const lineIdx = lineEl.dataset.lineIdx;
      let order = 0;
      lineEl.querySelectorAll(".ss-seg__chord").forEach((chordEl) => {
        const sym = chordEl.textContent.trim();
        if (!sym || !/^[A-G]/.test(sym)) return;
        followerChordEls.set(lineIdx + ":" + order, chordEl);
        order += 1;
      });
    });
  }

  function applyFollowerHighlight(data) {
    if (!followerChordEls) return;
    followerChordEls.forEach((chordEl) => chordEl.classList.remove("ss-seg__chord--playalong"));
    if (data.mode !== "playalong" || !followerSteps || !data.pos || data.pos.index == null) return;
    const step = followerSteps[data.pos.index];
    if (!step) return;
    step.occurrences.forEach((o) => {
      const target = followerChordEls.get(o.lineIdx + ":" + o.order);
      if (target) target.classList.add("ss-seg__chord--playalong");
    });
  }

  // Mirrors js/songsheet.js's own lineElAt()/virtualLineToScrollTop(), just
  // scoped to the follower's own DOM tree instead of the host's -- see
  // getJamSnapshot()'s comment in songsheet.js for why a *line* index
  // (rather than a pixel or scrollHeight fraction) is what travels over
  // the wire: it's the one unit that means the same thing regardless of
  // how differently the two screens wrap the same text.
  function followerLineElAt(idx) {
    return followerEls.body.querySelector('[data-line-idx="' + idx + '"]');
  }
  function followerVirtualLineToScrollTop(box, virtualLine) {
    const f = Math.floor(virtualLine);
    const elF = followerLineElAt(f);
    if (!elF) return null;
    const boxRect = box.getBoundingClientRect();
    const topF = elF.getBoundingClientRect().top - boxRect.top + box.scrollTop;
    let topC = topF;
    const frac = virtualLine - f;
    if (frac > 0) {
      const elC = followerLineElAt(f + 1);
      if (elC) topC = elC.getBoundingClientRect().top - boxRect.top + box.scrollTop;
    }
    return topF + (topC - topF) * frac - box.clientHeight * 0.3;
  }

  function applyFollowerScroll(data) {
    if (!autoFollow) return;
    if (data.mode !== "timestamps" && data.mode !== "autoscroll") return;
    if (!data.pos || data.pos.line == null) return;
    const box = followerEls.root;
    const y = followerVirtualLineToScrollTop(box, data.pos.line);
    if (y != null) box.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  /* =====================================================================
     Settings-page UI (start/join) + the persistent island
     ===================================================================== */

  const settingsEls = {
    group: document.getElementById("jam-group"),
    idle: document.getElementById("jam-idle"),
    idleStatus: document.getElementById("jam-idle-status"),
    startBtn: document.getElementById("jam-start-btn"),
    joinInput: document.getElementById("jam-join-code"),
    joinBtn: document.getElementById("jam-join-btn"),
    hosting: document.getElementById("jam-hosting"),
    hostCode: document.getElementById("jam-host-code"),
    hostCount: document.getElementById("jam-host-count"),
    hostShareBtn: document.getElementById("jam-host-share-btn"),
    hostStopBtn: document.getElementById("jam-host-stop-btn"),
    following: document.getElementById("jam-following"),
    followCode: document.getElementById("jam-follow-code"),
    leaveBtn: document.getElementById("jam-leave-btn"),
  };

  function setIdleStatus(msg, isError) {
    if (!settingsEls.idleStatus) return;
    settingsEls.idleStatus.textContent = msg || "";
    settingsEls.idleStatus.classList.toggle("is-error", Boolean(isError));
  }

  function renderSettings() {
    if (!settingsEls.group) return;
    const isHost = session && session.role === "host";
    const isFollower = session && session.role === "follower";
    settingsEls.idle.hidden = !!session;
    settingsEls.hosting.hidden = !isHost;
    settingsEls.following.hidden = !isFollower;
    if (isHost) {
      settingsEls.hostCode.textContent = session.code;
      settingsEls.hostCount.textContent = String(hostParticipantCount);
    }
    if (isFollower) {
      settingsEls.followCode.textContent = session.code;
    }
  }

  function renderIsland() {
    const island = document.getElementById("jam-island");
    if (!island) return;
    if (!session) {
      island.hidden = true;
      island.textContent = "";
      return;
    }
    island.hidden = false;
    island.textContent = "";

    const pill = el("button", "jam-island__pill", session.role === "host" ? "Jam · " + hostParticipantCount : "Jam");
    pill.type = "button";
    pill.addEventListener("click", () => {
      islandExpanded = !islandExpanded;
      renderIsland();
    });
    island.appendChild(pill);
    if (!islandExpanded) return;

    const panel = el("div", "jam-island__panel");
    if (session.role === "host") {
      panel.appendChild(el("p", "jam-island__code", session.code));
      panel.appendChild(
        el("p", "jam-island__note", hostParticipantCount + (hostParticipantCount === 1 ? " person following" : " people following"))
      );
      if (confirmStop) {
        panel.appendChild(el("p", "jam-island__confirm-label", "Stop this jam?"));
        const row = el("div", "jam-island__row");
        const yes = el("button", "jam-island__btn jam-island__btn--danger", "Stop");
        yes.type = "button";
        yes.addEventListener("click", stopJam);
        const no = el("button", "jam-island__btn", "Cancel");
        no.type = "button";
        no.addEventListener("click", () => {
          confirmStop = false;
          renderIsland();
        });
        row.appendChild(yes);
        row.appendChild(no);
        panel.appendChild(row);
      } else {
        const stop = el("button", "jam-island__btn jam-island__btn--danger", "Stop jam");
        stop.type = "button";
        stop.addEventListener("click", () => {
          confirmStop = true;
          renderIsland();
        });
        panel.appendChild(stop);
      }
    } else {
      panel.appendChild(el("p", "jam-island__note", "Following jam " + session.code));
      const leave = el("button", "jam-island__btn", "Leave jam");
      leave.type = "button";
      leave.addEventListener("click", leaveJam);
      panel.appendChild(leave);
    }
    island.appendChild(panel);
  }

  function render() {
    renderSettings();
    renderIsland();
  }

  function wireSettingsButtons() {
    if (!settingsEls.group) return;
    settingsEls.startBtn.addEventListener("click", startJam);
    settingsEls.joinBtn.addEventListener("click", () => joinJam(settingsEls.joinInput.value));
    settingsEls.joinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinJam(settingsEls.joinInput.value);
    });
    settingsEls.hostShareBtn.addEventListener("click", shareJamLink);
    settingsEls.hostStopBtn.addEventListener("click", stopJam);
    settingsEls.leaveBtn.addEventListener("click", leaveJam);
  }

  // A friend without the app (or who hasn't opened it recently) can land
  // straight in the follower view via a shared link's ?jam=CODE -- no need
  // to find Settings and type anything in.
  function checkUrlJoin() {
    const params = new URLSearchParams(location.search);
    const code = params.get("jam");
    if (!code) return;
    const url = new URL(location.href);
    url.searchParams.delete("jam");
    history.replaceState({}, "", url);
    if (session && session.role === "follower" && session.code === code.toUpperCase()) return;
    joinJam(code);
  }

  function boot() {
    wireSettingsButtons();
    render();

    if (session && session.role === "host") {
      hostTimer = setInterval(hostTick, HOST_TICK_MS);
      hostTick();
    } else if (session && session.role === "follower") {
      ensureFollowerView();
      startFollowTimer();
      followTick();
    }

    checkUrlJoin();
  }

  boot();

  window.GuitarJam = { startJam, stopJam, joinJam, leaveJam };
})();
