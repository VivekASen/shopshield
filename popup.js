// popup.js — extended: session timer, remember-until-close, protect the enable toggle
// NOTE: client-side deterrent only.

// --- configuration ---
const SESSION_DURATION_MS = 15 * 60 * 1000; // 15 minutes default
const PBKDF2_ITERATIONS = 150000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;

// --- DOM refs ---
const delayInput = document.getElementById("delay");
// const clearBtn = document.getElementById("clearLogs");
const clearOverridesBtn = document.getElementById("clearOverrides");
const clearWhitelistBtn = document.getElementById("clearWhitelist");
const whitelistCurrentBtn = document.getElementById("whitelistCurrent");
const logDiv = document.getElementById("log");
const overridesList = document.getElementById("overridesList");
const whitelistList = document.getElementById("whitelistList");
const sensitivitySelect = document.getElementById("sensitivity");
const currentReasonEl = document.getElementById("currentReason");

// auth DOM
const lockStatus = document.getElementById("lockStatus");
const newPassword = document.getElementById("newPassword");
const newPasswordConfirm = document.getElementById("newPasswordConfirm");
const setPasswordBtn = document.getElementById("setPasswordBtn");
const removePasswordBtn = document.getElementById("removePasswordBtn");
const unlockPassword = document.getElementById("unlockPassword");
const unlockBtn = document.getElementById("unlockBtn");
const logoutBtn = document.getElementById("logoutBtn");
const persistUntilClose = document.getElementById("persistUntilClose");
const sessionTimerEl = document.getElementById("sessionTimer");
const changePasswordArea = document.getElementById("changePasswordArea");
const changeOld = document.getElementById("changeOld");
const changeNew = document.getElementById("changeNew");
const changePasswordBtn = document.getElementById("changePasswordBtn");

// --- crypto helpers ---
function b64FromArrayBuffer(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function arrayBufferFromB64(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
async function randomSalt(n = SALT_BYTES) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr.buffer;
}
async function deriveKeyFromPassword(password, saltBuf) {
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    passKey,
    256
  );
  return derived; // ArrayBuffer
}

// --- storage helpers ---
function storageGet(keys) { return new Promise(res => chrome.storage.local.get(keys, r => res(r))); }
function storageSet(obj) { return new Promise(res => chrome.storage.local.set(obj, () => res())); }
function storageRemove(key) { return new Promise(res => chrome.storage.local.remove(key, () => res())); }

// helper to try session storage (if supported)
function hasSessionStorageArea() {
  try {
    return (!!chrome.storage && !!chrome.storage.session && typeof chrome.storage.session.set === "function");
  } catch (e) { return false; }
}
function sessionSet(obj) {
  return new Promise((res, rej) => {
    if (!hasSessionStorageArea()) return rej(new Error("session storage not supported"));
    chrome.storage.session.set(obj, () => res());
  });
}
function sessionGet(keys) {
  return new Promise((res, rej) => {
    if (!hasSessionStorageArea()) return rej(new Error("session storage not supported"));
    chrome.storage.session.get(keys, r => res(r));
  });
}
function sessionRemove(key) {
  return new Promise((res, rej) => {
    if (!hasSessionStorageArea()) return rej(new Error("session storage not supported"));
    chrome.storage.session.remove(key, () => res());
  });
}

// --- auth primitives ---
async function passwordExists() {
  const d = await storageGet(["shopshield_password"]);
  return !!(d.shopshield_password && d.shopshield_password.hash && d.shopshield_password.salt);
}
async function setPassword(password) {
  if (!password || password.length < 4) throw new Error("Password too short (min 4 chars).");
  const saltBuf = await randomSalt();
  const hashBuf = await deriveKeyFromPassword(password, saltBuf);
  const payload = { salt: b64FromArrayBuffer(saltBuf), hash: b64FromArrayBuffer(hashBuf) };
  await storageSet({ shopshield_password: payload });
  // create a session
  await createAuthSession({ persistUntilClose: persistUntilClose.checked });
}
async function verifyPassword(password) {
  const d = await storageGet(["shopshield_password"]);
  if (!d.shopshield_password) return false;
  const saltBuf = arrayBufferFromB64(d.shopshield_password.salt);
  const hashBuf = await deriveKeyFromPassword(password, saltBuf);
  const hashB64 = b64FromArrayBuffer(hashBuf);
  return hashB64 === d.shopshield_password.hash;
}
async function removePassword(password) {
  const ok = await verifyPassword(password);
  if (!ok) throw new Error("Incorrect password");
  await storageSet({ shopshield_password: null });
  // clear sessions in both storage types
  try { await storageSet({ shopshield_auth: null }); } catch (e) {}
  if (hasSessionStorageArea()) { try { await sessionRemove(["shopshield_auth"]); } catch (e) {} }
}

// create auth session
async function createAuthSession(opts = {}) {
  const { persistUntilClose = false } = opts;
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const sessionObj = { expiresAt, persistUntilClose: !!persistUntilClose };
  // If user wants persist until browser close and session storage is available, store there
  if (persistUntilClose && hasSessionStorageArea()) {
    try {
      await sessionSet({ shopshield_auth: sessionObj });
      // also clear local fallback auth
      await storageSet({ shopshield_auth: null });
      startSessionTimer();
      return;
    } catch (e) {
      // fall through to local storage fallback
      console.warn("session storage failed, falling back to local", e);
    }
  }
  await storageSet({ shopshield_auth: sessionObj });
  startSessionTimer();
}
async function clearAuthSession() {
  await storageSet({ shopshield_auth: null });
  if (hasSessionStorageArea()) {
    try { await sessionRemove(["shopshield_auth"]); } catch (e) {}
  }
  stopSessionTimer();
}
async function readAuthSession() {
  // First try session area
  if (hasSessionStorageArea()) {
    try {
      const s = await sessionGet(["shopshield_auth"]);
      if (s && s.shopshield_auth && s.shopshield_auth.expiresAt) return s.shopshield_auth;
    } catch (e) {
      // ignore
    }
  }
  const d = await storageGet(["shopshield_auth"]);
  return d.shopshield_auth || null;
}
async function isAuthenticated() {
  const pw = await storageGet(["shopshield_password"]);
  if (!pw || !pw.shopshield_password || !pw.shopshield_password.hash) return true; // no password set => unprotected
  const sess = await readAuthSession();
  if (!sess || !sess.expiresAt) return false;
  return Date.now() < sess.expiresAt;
}

// --- session timer UI ---
let sessionTimerInterval = null;
async function startSessionTimer() {
  stopSessionTimer();
  // update UI once immediately
  updateSessionTimerUI();
  sessionTimerInterval = setInterval(updateSessionTimerUI, 1000);
}
function stopSessionTimer() {
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
  sessionTimerEl.textContent = "—";
}
async function updateSessionTimerUI() {
  const sess = await readAuthSession();
  if (!sess || !sess.expiresAt) {
    sessionTimerEl.textContent = "—";
    updateLockUI(false);
    stopSessionTimer();
    return;
  }
  const msLeft = sess.expiresAt - Date.now();
  if (msLeft <= 0) {
    // session expired
    await clearAuthSession();
    updateLockUI(false);
    sessionTimerEl.textContent = "Expired";
    stopSessionTimer();
    return;
  }
  // if persistUntilClose and stored in session storage without an expiresAt long-term, still show remain
  const mins = Math.floor(msLeft / 60000);
  const secs = Math.floor((msLeft % 60000) / 1000);
  sessionTimerEl.textContent = `${mins}m ${secs}s`;
  updateLockUI(true);
}

// --- UI helpers & rendering ---
function escapeHtml(s) { return (s || "").toString().replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function friendlyReason(reasonObj) {
  if (!reasonObj) return "—";
  let code = reasonObj; let ts = null;
  if (typeof reasonObj === "object") { code = reasonObj.reason || "unknown"; ts = reasonObj.ts || null; }
  const map = {
    "url": "URL contains checkout/cart/payment keywords",
    "button": "Found checkout-like button (e.g., 'Checkout', 'Place order')",
    "payment-input": "Detected payment/card input fields",
    "none": "No checkout indicators found",
    "error": "Detection error"
  };
  const human = map[code] || ("Detected: " + code);
  if (ts) { try { const time = new Date(ts).toLocaleString(); return `${human} — ${time}`; } catch (e) { return human; } }
  return human;
}
async function renderUIState() {
  // ensure defaults
  const defaults = {};
  const d = await storageGet(["enabled","delaySeconds","overrides","overrideExpiryHours","whitelist","sensitivity","shopshield_password"]);
  if (typeof d.enabled === "undefined") defaults.enabled = true;
  if (typeof d.delaySeconds === "undefined") defaults.delaySeconds = 60;
  if (typeof d.sensitivity === "undefined") defaults.sensitivity = "normal";
  if (Object.keys(defaults).length) await storageSet(defaults);

  const data = await storageGet(["enabled","delaySeconds","overrides","overrideExpiryHours","whitelist","sensitivity","shopshield_password"]);
  delayInput.value = data.delaySeconds ?? 60;
  sensitivitySelect.value = data.sensitivity || "normal";

  // overrides
  overridesList.innerHTML = "";
  const overrides = data.overrides || {};
  const ovKeys = Object.keys(overrides);
  if (!ovKeys.length) overridesList.textContent = "No active overrides.";
  else ovKeys.forEach(origin => {
    const entry = overrides[origin];
    const ts = entry && entry.ts ? new Date(entry.ts).toLocaleString() : "unknown";
    const container = document.createElement("div");
    container.className = "override-item";
    const left = document.createElement("div");
    left.innerHTML = `<strong>${escapeHtml(origin)}</strong><div class="small">Overridden at ${escapeHtml(ts)}</div>`;
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.addEventListener("click", async () => {
      const authed = await isAuthenticated();
      if (!authed) { alert("Unlock to remove an override."); return; }
      const d2 = await storageGet(["overrides"]);
      const ov2 = d2.overrides || {};
      delete ov2[origin];
      await storageSet({ overrides: ov2 });
      await renderUIState();
    });
    container.appendChild(left);
    container.appendChild(rm);
    overridesList.appendChild(container);
  });

  // whitelist
  whitelistList.innerHTML = "";
  const wl = data.whitelist || {};
  const wlKeys = Object.keys(wl);
  if (!wlKeys.length) whitelistList.textContent = "No whitelisted sites.";
  else wlKeys.forEach(origin => {
    const container = document.createElement("div");
    container.className = "override-item";
    const left = document.createElement("div");
    left.innerHTML = `<strong>${escapeHtml(origin)}</strong>`;
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.addEventListener("click", async () => {
      const authed = await isAuthenticated();
      if (!authed) { alert("Unlock to remove from whitelist."); return; }
      const d2 = await storageGet(["whitelist"]);
      const wl2 = d2.whitelist || {};
      delete wl2[origin];
      await storageSet({ whitelist: wl2 });
      await renderUIState();
    });
    container.appendChild(left);
    container.appendChild(rm);
    whitelistList.appendChild(container);
  });

  // last modal reason for active tab (optional)
  // try {
  //   chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  //     if (!tabs || !tabs[0] || !tabs[0].url) { currentReasonEl.textContent = "—"; return; }
  //     try {
  //       const origin = new URL(tabs[0].url).origin;
  //       const map = data.lastModalReason || {};
  //       currentReasonEl.textContent = map[origin] ? friendlyReason(map[origin]) : "—";
  //     } catch (e) { currentReasonEl.textContent = "—"; }
  //   });
  // } catch (e) { currentReasonEl.textContent = "—"; }
}

// --- UI wiring & protected actions ---
async function attachHandlers() {
  // sensitivity change (protected)
  sensitivitySelect.addEventListener("change", async () => {
    const authed = await isAuthenticated();
    if (!authed) { alert("Unlock to change sensitivity."); await renderUIState(); return; }
    const s = sensitivitySelect.value || "normal";
    await storageSet({ sensitivity: s });
    await renderUIState();
  });

  delayInput.addEventListener("change", async () => {
    const v = parseInt(delayInput.value) || 60;
    await storageSet({ delaySeconds: v });
    await renderUIState();
  });

  // clear overrides (protected)
  clearOverridesBtn.addEventListener("click", async () => {
    const authed = await isAuthenticated();
    if (!authed) { alert("Unlock to clear overrides."); return; }
    await storageSet({ overrides: {} });
    await renderUIState();
  });

  // clear whitelist (protected)
  clearWhitelistBtn.addEventListener("click", async () => {
    const authed = await isAuthenticated();
    if (!authed) { alert("Unlock to clear whitelist."); return; }
    await storageSet({ whitelist: {} });
    await renderUIState();
  });

  // whitelist current (protected)
  whitelistCurrentBtn.addEventListener("click", async () => {
    const authed = await isAuthenticated();
    if (!authed) { alert("Unlock to whitelist this site."); return; }
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) return;
      const origin = new URL(tabs[0].url).origin;
      const d = await storageGet(["whitelist"]);
      const wl = d.whitelist || {};
      wl[origin] = true;
      await storageSet({ whitelist: wl });
      await renderUIState();
    });
  });

  // set password
  setPasswordBtn.addEventListener("click", async () => {
    const p = newPassword.value || "";
    const pc = newPasswordConfirm.value || "";
    if (!p || p.length < 4) { alert("Pick a password of at least 4 characters."); return; }
    if (p !== pc) { alert("Passwords do not match."); return; }
    try {
      await setPassword(p);
      newPassword.value = ""; newPasswordConfirm.value = "";
      alert("Password set. Extension unlocked for the session.");
      await renderUIState();
      await updateLockUI();
      await startSessionTimer();
    } catch (e) {
      console.error(e);
      alert("Failed to set password: " + e.message);
    }
  });

  // remove password (requires current)
  removePasswordBtn.addEventListener("click", async () => {
    const cur = prompt("Enter current password to remove protection:");
    if (!cur) return;
    try {
      await removePassword(cur);
      alert("Password removed. Extension is now unprotected.");
      await renderUIState();
      await updateLockUI();
    } catch (e) {
      alert("Failed to remove password: " + e.message);
    }
  });

  // unlock
  unlockBtn.addEventListener("click", async () => {
    const p = unlockPassword.value || "";
    if (!p) { alert("Enter password to unlock."); return; }
    try {
      const ok = await verifyPassword(p);
      if (!ok) { alert("Incorrect password."); return; }
      await createAuthSession({ persistUntilClose: persistUntilClose.checked });
      unlockPassword.value = "";
      alert("Unlocked for this session.");
      await renderUIState();
      await updateLockUI(true);
      await startSessionTimer();
    } catch (e) {
      console.error(e);
      alert("Unlock failed.");
    }
  });

  // logout / lock
  logoutBtn.addEventListener("click", async () => {
    await clearAuthSession();
    alert("Locked.");
    await renderUIState();
    await updateLockUI(false);
  });

  // change password
  changePasswordBtn.addEventListener("click", async () => {
    const oldp = changeOld.value || "";
    const newp = changeNew.value || "";
    if (!oldp || !newp) { alert("Provide both current and new passwords."); return; }
    try {
      const ok = await verifyPassword(oldp);
      if (!ok) { alert("Incorrect current password."); return; }
      await setPassword(newp);
      changeOld.value = ""; changeNew.value = "";
      alert("Password changed.");
      await renderUIState();
      await updateLockUI(true);
    } catch (e) {
      console.error(e);
      alert("Failed to change password: " + e.message);
    }
  });

  // collapsibles
  const coll = document.querySelectorAll(".collapsible-btn");
  coll.forEach(btn => {
    const targetId = btn.dataset.target;
    btn.addEventListener("click", async () => {
      const target = document.getElementById(targetId);
      if (!target) return;
      const isHidden = target.style.display === "none";
      target.style.display = isHidden ? "block" : "none";
      btn.textContent = btn.textContent.replace(/(▼|▲)/, isHidden ? "▲" : "▼");
      if (isHidden) await renderUIState();
    });
  });
}

// --- improved lock UI update: hides sensitive elements until unlocked ---
async function updateLockUI(forceAuthState = null) {
  const exists = await passwordExists();
  // compute auth state
  const authed = (typeof forceAuthState === "boolean") ? forceAuthState : await isAuthenticated();

  // status text
  lockStatus.textContent = authed ? "Unlocked" : "Locked";

  // show/hide small control areas (these keep previous semantics)
  if (authed) {
    if (unlockPassword) unlockPassword.style.display = "none";
    if (unlockBtn) unlockBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "inline-block";
    if (changePasswordArea) changePasswordArea.style.display = "block";
  } else {
    if (unlockPassword) unlockPassword.style.display = exists ? "inline-block" : "none";
    if (unlockBtn) unlockBtn.style.display = exists ? "inline-block" : "none";
    if (logoutBtn) logoutBtn.style.display = "none";
    if (changePasswordArea) changePasswordArea.style.display = "none";
  }

  const setPwdArea = document.getElementById("setPasswordArea");
  if (setPwdArea) setPwdArea.style.display = exists ? "none" : "block";

  // --- Hide or show all .sensitive elements by toggling a "hidden" class ---
  const sensitiveEls = Array.from(document.querySelectorAll(".sensitive"));
  sensitiveEls.forEach(el => {
    const controls = el.querySelectorAll ? Array.from(el.querySelectorAll("input,button,select,textarea,a")) : [];
    if (!authed) {
      // hide visually and make non-focusable
      el.classList.add("hidden");
      el.setAttribute("aria-hidden", "true");
      controls.forEach(c => {
        c.dataset._savedTabIndex = c.getAttribute("tabindex");
        c.setAttribute("tabindex", "-1");
        if (c.hasAttribute("disabled")) c.dataset._wasDisabled = "1";
        else c.dataset._wasDisabled = "0";
        c.setAttribute("disabled", "true");
      });
    } else {
      // show and restore focusability
      el.classList.remove("hidden");
      el.removeAttribute("aria-hidden");
      controls.forEach(c => {
        if (c.dataset._savedTabIndex !== null && typeof c.dataset._savedTabIndex !== "undefined") {
          if (c.dataset._savedTabIndex === "null") c.removeAttribute("tabindex");
          else c.setAttribute("tabindex", c.dataset._savedTabIndex);
        } else {
          c.removeAttribute("tabindex");
        }
        if (c.dataset._wasDisabled === "0") c.removeAttribute("disabled");
        delete c.dataset._savedTabIndex;
        delete c.dataset._wasDisabled;
      });
    }
  });

  // Optionally collapse long lists: replace content with a small placeholder if it has class `collapsible-placeholder-target`
  const placeholders = Array.from(document.querySelectorAll(".collapsible-placeholder-target"));
  placeholders.forEach(el => {
    if (!authed) {
      if (!el.dataset._placeholderInserted) {
        const ph = document.createElement("div");
        ph.className = "collapsed-placeholder";
        ph.textContent = "Unlock to view details";
        ph.dataset._isPlaceholder = "true";
        el.style.display = "none";
        el.insertAdjacentElement("afterend", ph);
        el.dataset._placeholderInserted = "1";
      }
    } else {
      const ph = el.nextElementSibling;
      if (ph && ph.dataset && ph.dataset._isPlaceholder === "true") ph.remove();
      el.style.display = "";
      delete el.dataset._placeholderInserted;
    }
  });

  // start/stop session timer (same behavior)
  if (authed) startSessionTimer();
  else { stopSessionTimer(); sessionTimerEl.textContent = "—"; }
}

// --- init ---
async function init() {
  // ensure defaults
  const d = await storageGet(["enabled","delaySeconds","sensitivity"]);
  const toSet = {};
  if (typeof d.enabled === "undefined") toSet.enabled = true;
  if (typeof d.delaySeconds === "undefined") toSet.delaySeconds = 60;
  if (typeof d.sensitivity === "undefined") toSet.sensitivity = "normal";
  if (Object.keys(toSet).length) await storageSet(toSet);

  await attachHandlers();
  await renderUIState();
  await updateLockUI();
  // If auth session exists (in session or local), start timer
  const auth = await readAuthSession();
  if (auth && auth.expiresAt && Date.now() < auth.expiresAt) {
    startSessionTimer();
  } else {
    sessionTimerEl.textContent = "—";
  }

  // Wire persistUntilClose checkbox default: if session storage has shopshield_auth and persistUntilClose true, check it
  if (hasSessionStorageArea()) {
    try {
      const s = await sessionGet(["shopshield_auth"]);
      if (s && s.shopshield_auth && s.shopshield_auth.persistUntilClose) persistUntilClose.checked = true;
    } catch (e) {}
  }
}

init();
