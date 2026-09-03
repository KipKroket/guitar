// Guitar — optional cloud sync.
//
// When SYNC_URL below is filled in with a deployed Worker URL (see
// /server/README.md), the Settings page grows an "Account & sync" section:
// a username + 6-digit passcode signs you in, and your library is merged
// with a copy kept by a tiny Cloudflare Worker. No email, no confirmation.
//
// The passcode is never stored on the device -- the server returns an opaque
// token, and that is what the app keeps. Losing it (cleared storage, new
// phone) just means signing in once more; the library itself is safe in the
// cloud copy.
//
// While SYNC_URL is empty this file does nothing and the Account section
// stays hidden -- the app is exactly as it was, backup/restore via the
// export/import buttons only.
(function () {
  const SYNC_URL = ""; // e.g. "https://guitar-sync.yourname.workers.dev"

  const ACCOUNT_KEY = "guitar-account"; // { username, token }
  const SYNC_DEBOUNCE_MS = 2500;

  const group = document.getElementById("account-group");
  if (!SYNC_URL || !group || !window.GuitarLibrary) return;
  group.hidden = false;

  const signedOutEl = document.getElementById("account-signed-out");
  const signedInEl = document.getElementById("account-signed-in");
  const userInput = document.getElementById("account-username");
  const passInput = document.getElementById("account-passcode");
  const loginBtn = document.getElementById("account-login-btn");
  const registerBtn = document.getElementById("account-register-btn");
  const logoutBtn = document.getElementById("account-logout-btn");
  const whoEl = document.getElementById("account-who");
  const statusEl = document.getElementById("account-status");
  const syncStatusEl = document.getElementById("account-sync-status");

  function loadAccount() {
    try {
      return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function saveAccount(a) {
    if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a));
    else localStorage.removeItem(ACCOUNT_KEY);
  }
  let account = loadAccount();

  function setStatus(el, msg, isError) {
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  function render() {
    const on = Boolean(account && account.token);
    signedOutEl.hidden = on;
    signedInEl.hidden = !on;
    if (on && whoEl) whoEl.textContent = account.username;
  }

  async function api(path, body) {
    const res = await fetch(SYNC_URL.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  function readCreds() {
    const u = (userInput.value || "").trim().toLowerCase();
    const p = (passInput.value || "").trim();
    if (!/^[a-z0-9_-]{3,20}$/.test(u)) {
      setStatus(statusEl, "Username: 3–20 letters, digits, - or _.", true);
      return null;
    }
    if (!/^\d{6}$/.test(p)) {
      setStatus(statusEl, "Passcode must be exactly 6 digits.", true);
      return null;
    }
    return { username: u, passcode: p };
  }

  async function authenticate(kind) {
    const creds = readCreds();
    if (!creds) return;
    setStatus(statusEl, kind === "register" ? "Creating account…" : "Signing in…");
    try {
      const { token } = await api(kind === "register" ? "/register" : "/login", creds);
      account = { username: creds.username, token: token };
      saveAccount(account);
      passInput.value = "";
      render();
      setStatus(statusEl, "");
      await syncNow(true);
    } catch (err) {
      if (err.status === 429) setStatus(statusEl, "Too many attempts — wait a bit and try again.", true);
      else if (err.status === 409) setStatus(statusEl, "That username is taken. Sign in instead?", true);
      else if (err.status === 401) setStatus(statusEl, "Wrong username or passcode.", true);
      else setStatus(statusEl, err.message || "Something went wrong.", true);
    }
  }

  let syncTimer = null;
  let syncing = false;

  async function syncNow(force) {
    if (!account || !account.token || syncing) return;
    if (!navigator.onLine && !force) return;
    syncing = true;
    setStatus(syncStatusEl, "Syncing…");
    try {
      const local = window.GuitarLibrary.getAllSnapshot();
      const { libraries } = await api("/sync", { token: account.token, libraries: local });
      if (libraries) window.GuitarLibrary.applySnapshot(libraries);
      const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setStatus(syncStatusEl, "Synced at " + t);
    } catch (err) {
      if (err.status === 401) {
        account = null;
        saveAccount(null);
        render();
        setStatus(statusEl, "Session expired — please sign in again.", true);
      } else {
        setStatus(syncStatusEl, "Sync failed — will retry.", true);
      }
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(false), SYNC_DEBOUNCE_MS);
  }

  if (loginBtn) loginBtn.addEventListener("click", () => authenticate("login"));
  if (registerBtn) registerBtn.addEventListener("click", () => authenticate("register"));
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      const tok = account && account.token;
      account = null;
      saveAccount(null);
      render();
      setStatus(statusEl, "Signed out.");
      setStatus(syncStatusEl, "");
      if (tok) {
        try {
          await api("/logout", { token: tok });
        } catch (e) {
          /* best effort */
        }
      }
    });
  }

  // Any local change (add / remove / favourite) schedules a debounced push.
  document.addEventListener("librarychange", () => {
    if (account) scheduleSync();
  });
  // Reconnecting, or coming back to the app, is a good moment to pull.
  window.addEventListener("online", () => {
    if (account) syncNow(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && account) syncNow(false);
  });

  render();
  if (account) syncNow(true);
})();
