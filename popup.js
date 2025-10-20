// popup.js — extended: session timer, remember-until-close, offline recovery export/import, protect the enable toggle
// NOTE: client-side deterrent only. Keep recovery code secret if you export it.

// --- configuration ---
const SESSION_DURATION_MS = 15 * 60 * 1000; // 15 minutes default
const PBKDF2_ITERATIONS = 150000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;

// --- DOM refs ---
const delayInput = document.getElementById("delay");
const clearBtn = document.getElementById("clearLogs");
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

// recovery UI
const exportRecoveryBtn = document.getElementById("exportRecoveryBtn");
const importRecoveryBtn = document.getElementById("importRecoveryBtn");
const recoveryArea = document.getElementById("recoveryArea");
const importRecoveryConfirm = document.getElementById("importRecoveryConfirm");

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
  const d = await storageGet(["enabled","delaySeconds","reflectionLogs","overrides","overrideExpiryHours","whitelist","sensitivity","lastModalReason","shopshield_password"]);
  if (typeof d.enabled === "undefined") defaults.enabled = true;
  if (typeof d.delaySeconds === "undefined") defaults.delaySeconds = 60;
  if (typeof d.sensitivity === "undefined") defaults.sensitivity = "normal";
  if (Object.keys(defaults).length) await storageSet(defaults);

  const data = await storageGet(["enabled","delaySeconds","reflectionLogs","overrides","overrideExpiryHours","whitelist","sensitivity","lastModalReason","shopshield_password"]);
  delayInput.value = data.delaySeconds ?? 60;
  sensitivitySelect.value = data.sensitivity || "normal";

  // logs
  logDiv.innerHTML = "";
  const logs = data.reflectionLogs || [];
  if (!logs.length) logDiv.textContent = "No reflections yet.";
  else logs.forEach(entry => {
    const div = document.createElement("div");
    const time = new Date(entry.timestamp).toLocaleString();
    div.style.marginBottom = "8px";
    div.innerHTML = `<div style="font-weight:600;">${escapeHtml(entry.text)}</div><div class="small">${escapeHtml(time)} — ${escapeHtml(entry.url)}</div>`;
    logDiv.appendChild(div);
  });

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

  // last modal reason for active tab
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].url) { currentReasonEl.textContent = "—"; return; }
      try {
        const origin = new URL(tabs[0].url).origin;
        const map = data.lastModalReason || {};
        currentReasonEl.textContent = map[origin] ? friendlyReason(map[origin]) : "—";
      } catch (e) { currentReasonEl.textContent = "—"; }
    });
  } catch (e) { currentReasonEl.textContent = "—"; }
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

  // clear logs (not protected)
  clearBtn.addEventListener("click", async () => {
    await storageSet({ reflectionLogs: [] });
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

  // export recovery code (offline)
  exportRecoveryBtn.addEventListener("click", async () => {
    const pwExists = await passwordExists();
    if (!pwExists) { alert("No password set to export."); return; }
    const d = await storageGet(["shopshield_password"]);
    const payload = d.shopshield_password;
    if (!payload) { alert("Nothing to export."); return; }
    // show JSON in a modal textarea (or copy to clipboard)
    const json = JSON.stringify({ shopshield_password: payload });
    // attempt to copy to clipboard then show the code in recoveryArea
    try {
      await navigator.clipboard.writeText(json);
      alert("Recovery code copied to clipboard. Save it securely. You can also keep it in the text area below.");
    } catch (e) {
      // ignore copy failure
    }
    recoveryArea.style.display = "block";
    recoveryArea.value = json;
  });

  // import recovery code (show textarea)
  importRecoveryBtn.addEventListener("click", () => {
    recoveryArea.style.display = recoveryArea.style.display === "block" ? "none" : "block";
    importRecoveryConfirm.style.display = recoveryArea.style.display === "block" ? "inline-block" : "none";
  });

  importRecoveryConfirm.addEventListener("click", async () => {
    const txt = recoveryArea.value && recoveryArea.value.trim();
    if (!txt) { alert("Paste recovery JSON into the box first."); return; }
    try {
      const obj = JSON.parse(txt);
      if (!obj || !obj.shopshield_password || !obj.shopshield_password.hash || !obj.shopshield_password.salt) {
        alert("Invalid recovery code format.");
        return;
      }
      // Overwrite stored shopshield_password with imported one
      await storageSet({ shopshield_password: obj.shopshield_password });
      alert("Imported recovery code. Password restored. You may want to unlock now.");
      recoveryArea.value = "";
      recoveryArea.style.display = "none";
      importRecoveryConfirm.style.display = "none";
      await renderUIState();
      await updateLockUI();
    } catch (e) {
      console.error(e);
      alert("Import failed: " + (e.message || e));
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

// --- protect enable toggle (popup-level only) ---
// We don't include the toggle input field in this popup version,
// but if you had an enable checkbox, you'd verify auth before allowing changes.
// Example (if you add the checkbox):
// enabledCheckbox.addEventListener('change', async () => {
//   if (!await isAuthenticated()) { alert('Unlock to change enable state'); enabledCheckbox.checked = !enabledCheckbox.checked; return; }
//   await storageSet({ enabled: enabledCheckbox.checked });
// });

// --- lock UI update ---
async function updateLockUI(forceAuthState = null) {
  const exists = await passwordExists();
  const authed = (typeof forceAuthState === "boolean") ? forceAuthState : await isAuthenticated();
  lockStatus.textContent = authed ? "Unlocked" : "Locked";
  // show/hide unlock controls
  if (authed) {
    unlockPassword.style.display = "none";
    unlockBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    changePasswordArea.style.display = "block";
  } else {
    unlockPassword.style.display = exists ? "inline-block" : "none";
    unlockBtn.style.display = exists ? "inline-block" : "none";
    logoutBtn.style.display = "none";
    changePasswordArea.style.display = "none";
  }
  document.getElementById("setPasswordArea").style.display = exists ? "none" : "block";

  // toggle sensitive UI
  const sensitiveEls = document.querySelectorAll(".sensitive");
  sensitiveEls.forEach(el => {
    if (!authed) {
      el.classList.add("disabled");
      el.classList.add("sensitive");
      el.setAttribute("disabled", "true");
    } else {
      el.classList.remove("disabled");
      el.classList.add("sensitive");
      el.removeAttribute("disabled");
    }
  });
  // start/stop session timer
  if (authed) startSessionTimer(); else { stopSessionTimer(); sessionTimerEl.textContent = "—"; }
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
