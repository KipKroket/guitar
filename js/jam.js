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
  const HOST_TICK_MS = 800;
  const FOLLOW_POLL_MS = 1000;
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
  let followerLastMarkTs = null; // last poll's data.mark.ts already flashed, so the same mark doesn't replay every poll
  let followerLastData = null; // most recent /poll response, reapplied after an instrument-toggle rebuild
  // Continuous scroll-follow: the host only reports its position once a
  // poll (~1s), which used to mean applyFollowerScroll() drove one
  // .scrollTo({behavior:"smooth"}) per poll -- each one starts and stops
  // its own short animation, so motion visibly stepped once a second
  // instead of gliding. A first fix eased followerRenderedLine toward the
  // latest poll's target every frame -- smoother, but still visibly
  // stop-start: the ease reaches a poll's (already-stale) target well
  // inside one poll interval, then sits still until the next poll moves
  // the target again. Now applyFollowerScroll() also estimates the host's
  // *speed* (lines/sec) from how far the target moved since the previous
  // poll, and followerScrollFrame() keeps extrapolating forward at that
  // speed every frame -- a dead-reckoning glide that doesn't stall between
  // polls -- while a slow correction term nudges it back onto the actual
  // reported target in case the estimate drifts.
  let followerScrollRAF = null;
  let followerScrollLastTs = null;
  let followerTargetLine = null;
  let followerTargetTs = null; // performance.now() timestamp the target line was last set
  let followerRenderedLine = null;
  let followerVelocity = 0; // estimated host scroll speed, in lines/sec
  const FOLLOWER_MAX_VELOCITY = 8; // lines/sec clamp -- guards against a noisy poll spiking the estimate
  // Whether the host's autoscroll is currently on (see songsheet.js
  // getJamSnapshot() -- it only reports a position while autoscroll.on is
  // true, manual scrolling underneath doesn't count) -- drives the
  // scroll-follow FAB's colour independent of autoFollow, and turns on/off
  // in lockstep with the host's own autoscroll toggle.
  let followerScrollActive = false;
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
    setStatus(settingsEls.hostStatus, "Starting…", false);
    try {
      const data = await api("/create", { song: {}, sheet: { raw: "" } });
      saveSession({ role: "host", code: data.code, hostToken: data.hostToken });
      lastSentSnapshot = null;
      hostParticipantCount = 0;
      setStatus(settingsEls.hostStatus, "", false);
      hostTimer = setInterval(hostTick, HOST_TICK_MS);
      hostTick();
      render();
    } catch (err) {
      setStatus(settingsEls.hostStatus, err.message || "Couldn't start a jam.", true);
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

  // Fired straight from js/songsheet.js's markLine() -- fires its own
  // /update right away rather than waiting for the next hostTick (up to
  // HOST_TICK_MS later), since a quick "look here" pulse loses its point
  // if it lands a beat late. No-ops if this device isn't actually hosting.
  async function hostMarkLine(idx) {
    if (!session || session.role !== "host" || !Number.isFinite(idx)) return;
    try {
      await api("/update", { code: session.code, hostToken: session.hostToken, mark: { line: idx } });
    } catch (err) {
      /* best effort -- a missed mark isn't worth retrying or surfacing */
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

  // `triggerBtn` is whichever share button was actually tapped -- the
  // Settings card's text button or the pill's round icon button (see
  // renderIsland()) -- so the clipboard-fallback "Copied!" feedback lands
  // on the right one instead of always the Settings button.
  async function shareJamLink(triggerBtn) {
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
        if (triggerBtn) {
          const original = triggerBtn.textContent;
          triggerBtn.textContent = "Copied!";
          setTimeout(() => {
            triggerBtn.textContent = original;
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
      setStatus(settingsEls.joinStatus, "Enter the 4-letter code.", true);
      return;
    }
    if (session && session.role === "host") await stopJam();
    setStatus(settingsEls.joinStatus, "Joining…", false);
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
      setStatus(
        settingsEls.joinStatus,
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
        setStatus(settingsEls.joinStatus, "The jam has ended.", false);
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

    // Same segmented icon slider as the library/chord-book headers (see
    // .instrument-switch in css/style.css) rather than a plain text pill --
    // it needs its own data-instrument (not body[data-instrument]) since it
    // tracks only this follower's chord-diagram choice.
    const instrumentToggle = el("button", "instrument-switch");
    instrumentToggle.type = "button";
    instrumentToggle.setAttribute("role", "switch");
    instrumentToggle.setAttribute("aria-label", "Switch chord diagrams between guitar and piano");
    instrumentToggle.innerHTML =
      '<span class="instrument-switch__icon instrument-switch__icon--guitar" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 3.5h6l-1.6 7h-2.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8 6.2h1.9M8 9.3h2.3M16 6.2h-1.9M16 9.3h-2.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="12" y1="10.5" x2="12" y2="20.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
      '</span>' +
      '<span class="instrument-switch__icon instrument-switch__icon--piano" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="5" width="18" height="14" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 5v9M12 5v9M16 5v9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      '</span>' +
      '<span class="instrument-switch__thumb" aria-hidden="true"></span>';
    instrumentToggle.addEventListener("click", () => {
      followerInstrument = followerInstrument === "piano" ? "guitar" : "piano";
      updateInstrumentToggleUI();
      if (followerShown) {
        const SS = window.GuitarSongSheet;
        const scrollTop = followerEls.body.scrollTop;
        renderFollowerChips(SS, followerShown);
        renderFollowerBody(SS, followerShown);
        followerEls.body.scrollTop = scrollTop;
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

    // Bottom-right FAB -- this follower's own on/off for being carried
    // along by the host's scroll position, independent of the host and of
    // every other follower. See applyFollowerScroll()/updateScrollFabUI().
    const scrollFab = el("button", "jam-view__scroll-fab");
    scrollFab.type = "button";
    scrollFab.setAttribute("aria-label", "Toggle following the host's scroll");
    scrollFab.innerHTML =
      '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M6 6l6 6 6-6M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    scrollFab.addEventListener("click", () => {
      autoFollow = !autoFollow;
      updateScrollFabUI();
    });
    root.appendChild(scrollFab);

    followerEls = { root, art, title, artist, instrumentToggle, waiting, chipsWrap, body, scrollFab };
    updateScrollFabUI();
    updateInstrumentToggleUI();
    if (followerScrollRAF == null) followerScrollRAF = requestAnimationFrame(followerScrollFrame);
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
    followerLastMarkTs = null;
    if (followerScrollRAF != null) {
      cancelAnimationFrame(followerScrollRAF);
      followerScrollRAF = null;
    }
    followerScrollLastTs = null;
    followerTargetLine = null;
    followerTargetTs = null;
    followerRenderedLine = null;
    followerVelocity = 0;
    followerScrollActive = false;
  }

  function updateScrollFabUI() {
    if (!followerEls || !followerEls.scrollFab) return;
    const following = autoFollow && followerScrollActive;
    followerEls.scrollFab.classList.toggle("is-following", following);
    followerEls.scrollFab.setAttribute("aria-pressed", following ? "true" : "false");
  }

  function updateInstrumentToggleUI() {
    if (!followerEls) return;
    const piano = followerInstrument === "piano";
    followerEls.instrumentToggle.dataset.instrument = followerInstrument;
    followerEls.instrumentToggle.setAttribute("aria-checked", piano ? "true" : "false");
    // Recolours the whole full-screen view to match, same as switching
    // instrument does app-wide -- see .jam-view[data-instrument] in
    // css/style.css. Deliberately independent of body[data-instrument]
    // (this follower's real app mode), same as followerInstrument itself.
    followerEls.root.dataset.instrument = followerInstrument;
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
      followerEls.body.scrollTop = 0;
      // A new song/sheet renumbers every line -- the last song's target/
      // rendered position means nothing here, so don't glide in from it.
      followerTargetLine = null;
      followerTargetTs = null;
      followerRenderedLine = null;
      followerVelocity = 0;
      followerLastMarkTs = null;
    }

    applyFollowerHighlight(data);
    applyFollowerScroll(data);
    applyFollowerMark(data);
  }

  // Replays the host's line-mark pulse (js/songsheet.js flashLine(), see
  // markLine()/hostMarkLine()) on this follower's own copy of the line.
  // data.mark is only present while fresh (worker.js's JAM_MARK_STALE_MS),
  // and ts is stamped server-side, so this needs no clock-skew handling --
  // dedupe purely on "is this the same mark we already flashed".
  function applyFollowerMark(data) {
    const mark = data.mark;
    if (!mark || mark.ts == null || mark.ts === followerLastMarkTs) return;
    followerLastMarkTs = mark.ts;
    const SS = window.GuitarSongSheet;
    if (SS && SS.flashLine && followerEls) SS.flashLine(followerEls.body, mark.line);
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

  // Records what the latest poll says the host is doing -- the actual
  // scrolling happens continuously in followerScrollFrame() below, not
  // here, so a poll landing doesn't itself cause a visible step. Also
  // estimates the host's scroll *speed* from how far the target moved since
  // the previous poll, so followerScrollFrame() can keep gliding forward
  // between polls instead of sitting still once it catches up to a stale
  // target (see the comment above followerScrollRAF's declaration).
  function applyFollowerScroll(data) {
    const active = data.mode === "timestamps" || data.mode === "autoscroll";
    followerScrollActive = active;
    updateScrollFabUI();
    if (!active || !data.pos || data.pos.line == null) {
      followerVelocity = 0;
      return;
    }
    const now = performance.now();
    const newTarget = data.pos.line;
    // First sample for this song, or a big jump (host opened a different
    // part of a long sheet, or a seek) -- snap instead of gliding across
    // the whole visible sheet over the next second, and don't derive a
    // velocity from a jump that was never real continuous motion.
    if (followerRenderedLine == null || Math.abs(newTarget - followerRenderedLine) > 8) {
      followerRenderedLine = newTarget;
      followerVelocity = 0;
    } else if (followerTargetTs != null) {
      const dt = (now - followerTargetTs) / 1000;
      if (dt > 0.05) {
        const v = (newTarget - followerTargetLine) / dt;
        followerVelocity = Math.max(-FOLLOWER_MAX_VELOCITY, Math.min(FOLLOWER_MAX_VELOCITY, v));
      }
    }
    followerTargetLine = newTarget;
    followerTargetTs = now;
  }

  // Runs continuously (not just once per poll) while the follower view
  // exists. A poll only lands once a second, which isn't often enough to
  // itself drive smooth motion -- gliding at followerVelocity (the host's
  // estimated lines/sec, see applyFollowerScroll) is what keeps the view
  // moving in between polls instead of reaching a poll's target and
  // visibly stalling until the next one arrives. A slow correction term
  // then nudges followerRenderedLine back onto the actual reported
  // followerTargetLine, so an imperfect speed estimate can't drift the
  // view away from where the host really is. autoFollow (this follower's
  // own pause) gates it the same way it always has.
  function followerScrollFrame(ts) {
    followerScrollRAF = requestAnimationFrame(followerScrollFrame);
    if (!followerEls || followerEls.body.hidden || !autoFollow || followerTargetLine == null || followerRenderedLine == null) {
      followerScrollLastTs = ts;
      return;
    }
    const dt = followerScrollLastTs != null ? (ts - followerScrollLastTs) / 1000 : 0;
    followerScrollLastTs = ts;
    if (dt > 0) {
      followerRenderedLine += followerVelocity * dt;
      // Correction tau is deliberately slower than the old ease-only
      // approach (0.4s) -- the velocity term above already does most of
      // the work of tracking the host, this just keeps it honest.
      const correctionTau = 0.8;
      const k = 1 - Math.exp(-dt / correctionTau);
      followerRenderedLine += (followerTargetLine - followerRenderedLine) * k;
    }
    const box = followerEls.body;
    const y = followerVirtualLineToScrollTop(box, followerRenderedLine);
    if (y != null) box.scrollTop = Math.max(0, Math.round(y));
  }

  /* =====================================================================
     Settings-page UI (start/join) + the persistent island
     ===================================================================== */

  const settingsEls = {
    hostGroup: document.getElementById("jam-host-group"),
    joinGroup: document.getElementById("jam-join-group"),
    hostIdle: document.getElementById("jam-host-idle"),
    hostStatus: document.getElementById("jam-host-status"),
    startBtn: document.getElementById("jam-start-btn"),
    joinIdle: document.getElementById("jam-join-idle"),
    joinStatus: document.getElementById("jam-join-status"),
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

  function setStatus(el, msg, isError) {
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  function renderSettings() {
    if (!settingsEls.hostGroup) return;
    const isHost = session && session.role === "host";
    const isFollower = session && session.role === "follower";
    // Hosting and following are mutually exclusive, so each card is hidden
    // entirely while the other role is active rather than showing a
    // disabled state -- one fewer thing to explain in the UI.
    settingsEls.hostGroup.hidden = isFollower;
    settingsEls.joinGroup.hidden = isHost;
    settingsEls.hostIdle.hidden = !!session;
    settingsEls.hosting.hidden = !isHost;
    settingsEls.joinIdle.hidden = !!session;
    settingsEls.following.hidden = !isFollower;
    if (isHost) {
      settingsEls.hostCode.textContent = session.code;
      settingsEls.hostCount.textContent = String(hostParticipantCount);
    }
    if (isFollower) {
      settingsEls.followCode.textContent = session.code;
    }
  }

  // Where the pill is allowed to show, and where exactly it sits within
  // that spot -- it has no position of its own any more (see .jam-island in
  // css/style.css), so js/app.js's current page and js/library.js's detail
  // overlay both have to be checked fresh on every render, not just once.
  function placeJamIsland(island) {
    if (window.GuitarLibrary && window.GuitarLibrary.isDetailOpen && window.GuitarLibrary.isDetailOpen()) {
      const detail = document.getElementById("song-detail");
      if (detail) {
        if (island.parentElement !== detail || island !== detail.firstChild) {
          detail.insertBefore(island, detail.firstChild);
        }
        return true;
      }
    }
    const page = window.GuitarApp && window.GuitarApp.getCurrentPage ? window.GuitarApp.getCurrentPage() : null;
    if (page === "library") {
      const header = document.querySelector("#page-library .library__header");
      const actions = document.querySelector("#page-library .library__actions");
      if (header && actions) {
        if (island.nextElementSibling !== actions || island.parentElement !== header) {
          header.insertBefore(island, actions);
        }
        return true;
      }
    }
    return false;
  }

  function renderIsland() {
    const island = document.getElementById("jam-island");
    if (!island) return;
    const allowedHere = placeJamIsland(island);
    if (!session || !allowedHere) {
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
        const row = el("div", "jam-island__row");
        const stop = el("button", "jam-island__btn jam-island__btn--danger", "Stop jam");
        stop.type = "button";
        stop.addEventListener("click", () => {
          confirmStop = true;
          renderIsland();
        });
        row.appendChild(stop);
        // Round share button -- same link as Settings' "Share link", just
        // reachable without leaving whatever page the pill is on. Apple's
        // standard share glyph (a box with an arrow out of its top), not a
        // custom icon, so it reads as "share" at a glance.
        const share = el("button", "jam-island__btn jam-island__share");
        share.type = "button";
        share.setAttribute("aria-label", "Share jam link");
        share.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3v12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11v7a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        share.addEventListener("click", () => shareJamLink(share));
        row.appendChild(share);
        panel.appendChild(row);
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
    if (!settingsEls.hostGroup) return;
    settingsEls.startBtn.addEventListener("click", startJam);
    settingsEls.joinBtn.addEventListener("click", () => joinJam(settingsEls.joinInput.value));
    settingsEls.joinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinJam(settingsEls.joinInput.value);
    });
    settingsEls.hostShareBtn.addEventListener("click", () => shareJamLink(settingsEls.hostShareBtn));
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

  // Neither of these fires anything else the island cares about (its own
  // session-state changes already call render()/renderIsland() directly) --
  // just a reposition-or-hide pass for whatever page/overlay is now showing.
  document.addEventListener("pagechange", renderIsland);
  document.addEventListener("songdetailchange", renderIsland);

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

  window.GuitarJam = { startJam, stopJam, joinJam, leaveJam, hostMarkLine };
})();
