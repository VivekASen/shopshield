// contentScript.js — adaptive modal colors, google-search exclusion, hover note on disabled buttons
// Preserves: overrides-by-origin, whitelist, expiry, session suppression, heuristics, inline resources, robust modal

/* ---------- storage & settings helpers ---------- */
async function getSettings() {
  return await chrome.storage.local.get(["enabled","delaySeconds","overrideExpiryHours","sensitivity"]);
}
async function saveLastModalReason(origin, reason) {
  try {
    const d = await chrome.storage.local.get(["lastModalReason"]);
    const map = d.lastModalReason || {};
    map[origin] = { reason, ts: Date.now() };
    await chrome.storage.local.set({ lastModalReason: map });
  } catch (e) { console.warn("ShopShield: failed to save lastModalReason", e); }
}

/* ---------- whitelist & overrides ---------- */
async function isWhitelistedOrigin() {
  try { const d = await chrome.storage.local.get(["whitelist"]); const whitelist = d.whitelist || {}; return !!whitelist[location.origin]; }
  catch (e) { return false; }
}
async function getOverridesObj() { const d = await chrome.storage.local.get(["overrides"]); return d.overrides || {}; }
async function saveOverridesObj(obj) { await chrome.storage.local.set({ overrides: obj }); }
async function isOverrideActive() {
  try {
    const origin = location.origin;
    const overrides = await getOverridesObj();
    const entry = overrides[origin];
    if (!entry || !entry.ts) return false;
    const d = await chrome.storage.local.get(["overrideExpiryHours"]);
    const expiryHours = Number(d.overrideExpiryHours ?? 24);
    if (expiryHours <= 0) return true;
    const ageMs = Date.now() - (entry.ts || 0);
    const expiryMs = expiryHours * 3600 * 1000;
    if (ageMs <= expiryMs) return true;
    delete overrides[origin];
    await saveOverridesObj(overrides);
    return false;
  } catch (e) { console.warn("ShopShield isOverrideActive error", e); return false; }
}

/* ---------- session suppression ---------- */
function setSessionSuppressed(value = true) {
  try { if (value) sessionStorage.setItem("shopshield_suppressed","1"); else sessionStorage.removeItem("shopshield_suppressed"); } catch (e) {}
}
function isSessionSuppressed() { try { return sessionStorage.getItem("shopshield_suppressed") === "1"; } catch (e) { return false; } }

/* ---------- adaptive color helpers ---------- */
function parseRgbString(rgb) {
  // accepts "rgb(r,g,b)" or "rgba(r,g,b,a)"
  if (!rgb) return null;
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  return [parseInt(m[1],10), parseInt(m[2],10), parseInt(m[3],10)];
}
function relativeLuminance([r,g,b]) {
  // sRGB to linear => luminance per WCAG
  const srgb = [r,g,b].map(v => v/255).map(c => (c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4)));
  return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
}
function chooseOverlayAndCardColors() {
  try {
    const cs = window.getComputedStyle(document.body);
    let bg = cs && (cs.backgroundColor || cs.background) || "";
    if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
      // try to sample top-most element color as fallback
      const el = document.elementFromPoint(window.innerWidth/2, window.innerHeight/4);
      if (el) bg = window.getComputedStyle(el).backgroundColor || bg;
    }
    const rgb = parseRgbString(bg);
    let luminance = 0.8; // assume light by default
    if (rgb) luminance = relativeLuminance(rgb);
    // if page is light (high luminance) use dark overlay; if dark, use a light, subtle overlay
    if (luminance > 0.6) {
      return {
        overlay: "rgba(0,0,0,0.55)",
        cardBg: "#ffffff",
        cardText: "#111111"
      };
    } else {
      return {
        overlay: "rgba(255,255,255,0.12)",
        cardBg: "#111217", // dark card for dark pages
        cardText: "#ffffff"
      };
    }
  } catch (e) {
    return { overlay: "rgba(0,0,0,0.55)", cardBg: "#fff", cardText: "#111" };
  }
}

// Add or replace these functions in contentScript.js

// create a simple styled tooltip element
function createTooltipNode(text) {
  const tip = document.createElement("div");
  tip.className = "shopshield-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.style.position = "fixed";
  tip.style.zIndex = "2147483647"; // very high to show above page UI
  tip.style.background = "rgba(0,0,0,0.85)";
  tip.style.color = "#fff";
  tip.style.padding = "6px 8px";
  tip.style.borderRadius = "6px";
  tip.style.fontSize = "12px";
  tip.style.maxWidth = "260px";
  tip.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
  tip.style.pointerEvents = "none"; // don't block mouse events to underlying UI
  tip.style.opacity = "0";
  tip.style.transition = "opacity 140ms ease-out, transform 140ms ease-out";
  tip.style.transform = "translateY(4px)";
  tip.innerText = text;
  document.body.appendChild(tip);
  // force reflow then show
  void tip.offsetWidth;
  tip.style.opacity = "1";
  tip.style.transform = "translateY(0)";
  return tip;
}

// position tooltip near an element, but keep inside viewport
function positionTooltipNearElement(tipEl, targetEl) {
  if (!tipEl || !targetEl) return;
  const rect = targetEl.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();

  // default: above the element, centered
  let top = rect.top - tipRect.height - 8;
  let left = rect.left + (rect.width - tipRect.width) / 2;

  // if not enough room above, place below
  if (top < 8) top = rect.bottom + 8;

  // keep inside viewport horizontally
  const margin = 8;
  if (left < margin) left = margin;
  if (left + tipRect.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - tipRect.width);

  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.style.left = `${Math.round(left)}px`;
}

// attach hover/touch handlers and set disabled attributes
function addBlockedAttributes(el) {
  try {
    // set data attributes / accessible flags
    el.setAttribute("data-shopshield-hidden", "1");
    el.setAttribute("aria-disabled", "true");
    // Set a short native title as fallback; custom tooltip is preferred.
    el.setAttribute("title", "Blocked by ShopShield — open the extension popup to whitelist or override");

    // visual disable
    el.style.opacity = "0.35";
    el.style.pointerEvents = "none";

    // If we've already attached handlers, don't attach again.
    if (el._shopshield_handlers) return;

    // Handlers:
    let tooltipNode = null;
    const showTooltip = (e) => {
      // do not show for right-click or if element is not visible
      if (e && e.button === 2) return;
      // message can be customized
      const msg = "Blocked by ShopShield — open the extension popup to whitelist or override";
      tooltipNode = createTooltipNode(msg);
      positionTooltipNearElement(tooltipNode, el);
      // on window scroll/resize keep repositioning
      el._shopshield_handlers._posHandler = () => positionTooltipNearElement(tooltipNode, el);
      window.addEventListener("scroll", el._shopshield_handlers._posHandler, true);
      window.addEventListener("resize", el._shopshield_handlers._posHandler);
    };

    const hideTooltip = () => {
      try {
        if (tooltipNode) {
          tooltipNode.style.opacity = "0";
          tooltipNode.style.transform = "translateY(4px)";
          setTimeout(() => { try { tooltipNode.remove(); } catch (e) {} }, 180);
          tooltipNode = null;
        }
        if (el._shopshield_handlers && el._shopshield_handlers._posHandler) {
          try { window.removeEventListener("scroll", el._shopshield_handlers._posHandler, true); } catch (e) {}
          try { window.removeEventListener("resize", el._shopshield_handlers._posHandler); } catch (e) {}
          el._shopshield_handlers._posHandler = null;
        }
      } catch (e) {}
    };

    // touch support: show tooltip on long-press (~600ms)
    let touchTimer = null;
    const touchStart = (e) => {
      if (touchTimer) clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        showTooltip(e);
      }, 600);
    };
    const touchEnd = () => { if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; } hideTooltip(); };

    // We cannot attach regular mouseenter if pointer-events are none.
    // To allow hover detection while keeping the element visually disabled, we attach listeners on a wrapper: create an invisible hover-catcher.
    // But creating a wrapper changes layout; instead create a transparent overlay element sitting exactly over the target to capture hover events.
    const hoverOverlay = document.createElement("div");
    hoverOverlay.className = "shopshield-hover-overlay";
    // position overlay
    const rect = el.getBoundingClientRect();
    Object.assign(hoverOverlay.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(rect.width, 6)}px`,
      height: `${Math.max(rect.height, 6)}px`,
      zIndex: "2147483646", // just below tooltip
      background: "transparent",
      pointerEvents: "auto" // overlay receives pointer events
    });
    document.body.appendChild(hoverOverlay);

    // keep overlay in place if page scrolls/mutates (best-effort)
    const updateOverlayPos = () => {
      try {
        const r = el.getBoundingClientRect();
        hoverOverlay.style.left = `${r.left}px`;
        hoverOverlay.style.top = `${r.top}px`;
        hoverOverlay.style.width = `${Math.max(r.width, 6)}px`;
        hoverOverlay.style.height = `${Math.max(r.height, 6)}px`;
      } catch (e) {}
    };
    // small interval and mutation observer to keep overlay synced
    const intervalId = setInterval(updateOverlayPos, 350);
    const mo = new MutationObserver(updateOverlayPos);
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

    // attach pointer listeners to overlay
    hoverOverlay.addEventListener("mouseenter", showTooltip);
    hoverOverlay.addEventListener("mouseleave", hideTooltip);
    hoverOverlay.addEventListener("touchstart", touchStart, { passive: true });
    hoverOverlay.addEventListener("touchend", touchEnd);

    // store handlers and references so we can remove them later in removeBlockedAttributes
    el._shopshield_handlers = {
      hoverOverlay,
      intervalId,
      mo,
      touchStart,
      touchEnd,
      showTooltip,
      hideTooltip
    };
  } catch (e) {
    // fallback: if anything fails, at least set title and aria-disabled
    try { el.setAttribute("title", "Blocked by ShopShield — open popup"); el.setAttribute("aria-disabled","true"); } catch (e) {}
  }
}

// Removes disabled attributes and cleans up tooltip handlers/overlays.
// Call this when you restore the element (override or whitelist).
function removeBlockedAttributes(el) {
  try {
    el.removeAttribute("data-shopshield-hidden");
    el.removeAttribute("aria-disabled");
    el.removeAttribute("title");
    el.style.opacity = "";
    el.style.pointerEvents = "";
    // cleanup overlay and listeners if present
    const h = el._shopshield_handlers;
    if (h) {
      try {
        if (h.hoverOverlay) {
          h.hoverOverlay.removeEventListener("mouseenter", h.showTooltip);
          h.hoverOverlay.removeEventListener("mouseleave", h.hideTooltip);
          h.hoverOverlay.removeEventListener("touchstart", h.touchStart);
          h.hoverOverlay.removeEventListener("touchend", h.touchEnd);
          try { h.hoverOverlay.remove(); } catch (e) {}
        }
      } catch(e) {}
      try { if (h.intervalId) clearInterval(h.intervalId); } catch (e) {}
      try { if (h.mo) h.mo.disconnect(); } catch (e) {}
      // ensure any visible tooltip removed
      try {
        const existingTip = document.querySelector(".shopshield-tooltip");
        if (existingTip) existingTip.remove();
      } catch (e) {}
      // delete stored handlers
      try { delete el._shopshield_handlers; } catch (e) {}
    }
  } catch (e) {}
}

async function blockCheckout() {
  const settings = await getSettings();
  const enabled = settings.enabled ?? true;
  const overrideActive = await isOverrideActive();
  const whitelisted = await isWhitelistedOrigin();
  if (!enabled || overrideActive || whitelisted) { removeDelayModal(); return; }
  try {
    const els = document.querySelectorAll('button, input[type="submit"], a');
    for (let i = 0; i < els.length; i++) {
      const btn = els[i];
      const text = (btn.innerText || btn.value || "").toLowerCase();
      const name = (btn.name || btn.id || "").toLowerCase();
      if (
        text.includes("checkout") ||
        text.includes("place order") ||
        text.includes("proceed to checkout") ||
        text.includes("buy now") ||
        name.includes("checkout") ||
        name.includes("place-order") ||
        name.includes("buy-now")
      ) addBlockedAttributes(btn);
    }
    const ccFields = document.querySelectorAll(
      'input[autocomplete="cc-number"], input[type="credit-card"], input[name*="card"], input[name*="cc"], input[placeholder*="card"], input[placeholder*="Card"], input[type="tel"]'
    );
    for (let i=0;i<ccFields.length;i++) addBlockedAttributes(ccFields[i]);
  } catch (e) { console.warn("ShopShield blockCheckout error", e); }
}

/* ---------- detect if page is likely checkout (with google exclusion) ---------- */
function hostIsSearchPage() {
  try {
    const host = location.hostname || "";
    // common search hostnames (google, bing, duckduckgo)
    if (host.includes("google.")) {
      // if path is search or root with q param - treat as search
      const p = location.pathname || "";
      const q = new URLSearchParams(location.search || "");
      if (p.startsWith("/search") || q.has("q") || p === "/") return true;
    }
    if (host.includes("bing.") || host.includes("duckduckgo.") || host.includes("yahoo.")) {
      // treat main search engines as non-checkout unless heuristics match merchant signals
      const q = new URLSearchParams(location.search || "");
      const p = location.pathname || "";
      if (p === "/" || q.has("q")) return true;
    }
  } catch (e) {}
  return false;
}

function urlLooksLikeCheckout(url, sensitivity = "normal") {
  try {
    const u = url.toLowerCase();
    if (sensitivity === "conservative") {
      return /(\bcheckout\b|\bpayment\b|\bcart\b|\border\b)/i.test(u);
    }
    if (sensitivity === "aggressive") {
      const tokens = ["checkout","cart","basket","payment","order","purchase","buy","pay","spc","subscribe","donate","billing","confirm","paynow"];
      return new RegExp(tokens.join("|"), "i").test(u);
    }
    return /(\bcheckout\b|\bcart\b|\bbasket\b|\bpayment\b|\border\b|\bpurchase\b|\bbuy\b|\bspc\b)/i.test(u);
  } catch (e) { return false; }
}

function hasCheckoutButtonsInDOM(sensitivity = "normal") {
  try {
    const els = document.querySelectorAll('button, input[type="submit"], a');
    for (let i=0;i<els.length;i++){
      const el = els[i];
      const style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) continue;
      const text = (el.innerText || el.value || "").toLowerCase();
      const name = (el.name || el.id || "").toLowerCase();
      if (sensitivity === "conservative") {
        if (text.includes("checkout") || text.includes("place order") || name.includes("checkout")) return true;
      } else if (sensitivity === "aggressive") {
        if (
          text.includes("checkout") ||
          text.includes("place order") ||
          text.includes("buy now") ||
          text.includes("proceed to checkout") ||
          text.includes("add to cart") ||
          text.includes("subscribe")
        ) return true;
      } else {
        if (
          text.includes("checkout") ||
          text.includes("place order") ||
          text.includes("proceed to checkout") ||
          text.includes("buy now")
        ) return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

function hasPaymentInputsInDOM(sensitivity = "normal") {
  try {
    const fields = document.querySelectorAll(
      'input[autocomplete="cc-number"], input[type="credit-card"], input[name*="card"], input[name*="cc"], input[placeholder*="card"], input[placeholder*="Card"], input[type="tel"]'
    );
    if (!fields || fields.length === 0) return false;
    for (let i=0;i<fields.length;i++){
      const f = fields[i];
      const style = window.getComputedStyle(f);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) continue;
      if (sensitivity === "aggressive") return true;
      const name = (f.name||f.id||f.placeholder||"").toLowerCase();
      if (name.includes("card") || name.includes("cc") || f.getAttribute("autocomplete")==="cc-number") return true;
    }
    return false;
  } catch (e) { return false; }
}

async function isLikelyCheckoutPage() {
  try {
    // quick exclude search pages (Google/Bing/DuckDuckGo) to avoid false positives
    if (hostIsSearchPage()) return { likely: false, reason: "none" };
    const s = await getSettings();
    const sensitivity = (s.sensitivity || "normal");
    if (urlLooksLikeCheckout(window.location.href, sensitivity)) return { likely: true, reason: "url" };
    if (hasCheckoutButtonsInDOM(sensitivity)) return { likely: true, reason: "button" };
    if (hasPaymentInputsInDOM(sensitivity)) return { likely: true, reason: "payment-input" };
    return { likely: false, reason: "none" };
  } catch (e) { return { likely: false, reason: "error" }; }
}

/* ---------- robust modal with adaptive colors ---------- */
async function showDelayModal() {
  const s = await getSettings();
  const enabled = s.enabled ?? true;
  const delaySeconds = Number(s.delaySeconds ?? 60);
  const overrideActive = await isOverrideActive();
  const whitelisted = await isWhitelistedOrigin();
  if (!enabled || overrideActive || whitelisted) return;
  if (isSessionSuppressed()) return;
  if (document.getElementById("shopshield-delay-modal")) return;

  const guess = await isLikelyCheckoutPage();
  if (!guess.likely) return;
  await saveLastModalReason(location.origin, guess.reason);

  // pick colors based on page background for readability
  const colors = chooseOverlayAndCardColors();

  // create modal elements (closure-safe)
  const modal = document.createElement("div");
  modal.id = "shopshield-delay-modal";
  Object.assign(modal.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    backgroundColor: colors.overlay, color: colors.cardText, display: "flex",
    flexDirection: "column", justifyContent: "center", alignItems: "center",
    zIndex: "999999", fontSize: "18px"
  });

  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, { textAlign: "center", maxWidth: "720px", width: "90%", padding: "12px", borderRadius: "8px" });

  const card = document.createElement("div");
  card.id = "shopshield-modal-card";
  Object.assign(card.style, { background: colors.cardBg, color: colors.cardText, padding: "18px", borderRadius: "8px", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" });

  const title = document.createElement("h3"); title.textContent = "Pause and reflect";
  title.style.margin = "0 0 8px 0";
  const message = document.createElement("p");
  message.style.margin = "0 0 12px 0";
  message.innerHTML = `Take a deep breath. Pause for <span class="shopshield-timer">${delaySeconds}</span> second(s) before completing this purchase.`;

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, { display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap", marginBottom: "10px" });

  const overrideBtn = document.createElement("button"); overrideBtn.textContent = "Override";
  const cancelBtn = document.createElement("button"); cancelBtn.textContent = "Cancel";
  const learnBtn = document.createElement("button"); learnBtn.textContent = "📚 Learn more";
  [overrideBtn,cancelBtn,learnBtn].forEach(b=>{
    Object.assign(b.style, { padding:"8px 12px", borderRadius:"6px", cursor:"pointer" });
  });
  cancelBtn.style.border = "1px solid #ccc";
  learnBtn.style.border = "1px solid #2b7"; learnBtn.style.background = "#eaffea";

  btnRow.appendChild(overrideBtn); btnRow.appendChild(cancelBtn); btnRow.appendChild(learnBtn);

  const detected = document.createElement("div");
  detected.style.fontSize = "12px";
  detected.style.color = colors.cardText === "#ffffff" ? "#ddd" : "#666";
  detected.innerHTML = `(Detected reason: <strong class="shopshield-detect-reason">${guess.reason}</strong>)`;

  card.appendChild(title); card.appendChild(message); card.appendChild(btnRow); card.appendChild(detected);
  wrapper.appendChild(card); modal.appendChild(wrapper);
  document.body.appendChild(modal);

  // grab elements references
  const timerSpan = modal.querySelector(".shopshield-timer");
  const detectReasonEl = modal.querySelector(".shopshield-detect-reason");
  if (detectReasonEl) detectReasonEl.textContent = guess.reason;

  let seconds = delaySeconds;
  let intervalId = null;

  function cleanupAndRemove() {
    try { if (intervalId !== null) { clearInterval(intervalId); intervalId = null; } } catch (e) {}
    try { document.removeEventListener("mousedown", outsideClickHandler); } catch (e) {}
    try { modal.remove(); } catch (e) {}
  }

  function outsideClickHandler(e) {
    if (!card.contains(e.target)) {
      setSessionSuppressed(true); // set before removal to avoid immediate recreation
      cleanupAndRemove();
    }
  }

  document.addEventListener("mousedown", outsideClickHandler);

  intervalId = setInterval(() => {
    seconds -= 1;
    if (timerSpan) timerSpan.textContent = String(Math.max(seconds,0));
    if (seconds <= 0) {
      setSessionSuppressed(true);
      cleanupAndRemove();
    }
  }, 1000);

  cancelBtn.addEventListener("click", () => {
    setSessionSuppressed(true);
    cleanupAndRemove();
  });

  overrideBtn.addEventListener("click", async () => {
    cleanupAndRemove();
    // try {
    //   const d = await chrome.storage.local.get(["reflectionLogs"]);
    //   const logs = d.reflectionLogs || [];
    //   logs.unshift({ text: "Override clicked", timestamp: Date.now(), url: window.location.href });
    //   await chrome.storage.local.set({ reflectionLogs: logs });
    // } catch (e) { console.warn(e); }
    try {
      const origin = location.origin;
      const overrides = await getOverridesObj();
      overrides[origin] = { ts: Date.now() };
      await saveOverridesObj(overrides);
    } catch (e) { console.warn(e); }
    try {
      const hidden = document.querySelectorAll('[data-shopshield-hidden="1"]');
      hidden.forEach(el => { el.removeAttribute('data-shopshield-hidden'); el.removeAttribute('aria-disabled'); el.removeAttribute('title'); el.style.opacity=""; el.style.pointerEvents=""; });
    } catch (e) {}
  });

  learnBtn.addEventListener("click", () => {
    // show inline panel (same pattern)
    try {
      const existing = document.getElementById("shopshield-resources-panel");
      if (existing) { existing.style.display = existing.style.display === "none" ? "block" : "none"; return; }
      const panel = document.createElement("div");
      panel.id = "shopshield-resources-panel";
      Object.assign(panel.style, { marginTop:"12px", maxHeight: "50vh", overflowY:"auto", textAlign:"left" });
      panel.innerHTML = `
        <div style="background:#fbfbff; padding:12px; border-radius:6px; border:1px solid #e6ecff;">
          <h4 style="margin:0 0 6px 0;">Helpful resources — shopping & compulsive buying</h4>
          <p style="margin:0 0 8px 0; color:#555;">Short summaries and links:</p>
          <ul style="padding-left:18px; margin:0 0 8px 0;">
            <li><a href="https://www.healthline.com/health/addiction/shopping" target="_blank" rel="noopener" style="color:#0b66c3;">Healthline — Shopping addiction</a></li>
            <li><a href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1805733/" target="_blank" rel="noopener" style="color:#0b66c3;">Review: compulsive buying disorder</a></li>
            <li><a href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9669662/" target="_blank" rel="noopener" style="color:#0b66c3;">Therapeutic management (2022)</a></li>
            <li><a href="https://www.samhsa.gov/" target="_blank" rel="noopener" style="color:#0b66c3;">SAMHSA</a></li>
            <li><a href="https://www.verywellmind.com/self-help-groups-for-shopping-addiction-22351" target="_blank" rel="noopener" style="color:#0b66c3;">Verywell — self-help & groups</a></li>
            <li><a href="https://www.nhs.uk/mental-health/conditions/" target="_blank" rel="noopener" style="color:#0b66c3;">NHS — mental health info</a></li>
          </ul>
          <div style="font-size:12px; color:#666;">Close the panel when done.</div>
          <div style="margin-top:8px; display:flex; gap:8px; justify-content:flex-end;">
            <button id="shopshield-resources-close" style="padding:6px 10px; border-radius:6px; border:none; cursor:pointer;">Close</button>
          </div>
        </div>
      `;
      card.appendChild(panel);
      panel.querySelector("#shopshield-resources-close").addEventListener("click", () => { try { panel.remove(); } catch (e) {} });
    } catch (e) {
      try { window.open("https://www.google.com/search?q=shopping+addiction+help", "_blank"); } catch (_) {}
    }
  });
}

/* ---------- main apply loop ---------- */
async function applyShopShield() {
  const settings = await getSettings();
  const enabled = settings.enabled ?? true;
  const whitelisted = await isWhitelistedOrigin();
  const overrideActive = await isOverrideActive();
  if (!enabled || whitelisted || overrideActive) { removeDelayModal(); return; }
  await blockCheckout();
  if (!isSessionSuppressed()) {
    try { await showDelayModal(); } catch (e) { console.warn("ShopShield: showDelayModal failed", e); }
  }
}

/* ---------- init & observer ---------- */
applyShopShield();
const observer = new MutationObserver(() => { try { applyShopShield(); } catch (e) {} });
observer.observe(document.body, { childList: true, subtree: true });
