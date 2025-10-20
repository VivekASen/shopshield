// background.js — MV3 service worker (defensive)

async function cleanupExpiredOverrides() {
  try {
    const data = await chrome.storage.local.get(["overrides", "overrideExpiryHours"]);
    const overrides = data.overrides || {};
    const expiryHours = Number(data.overrideExpiryHours ?? 24);

    if (expiryHours <= 0) {
      // 0 => never expire
      return;
    }

    const now = Date.now();
    const expiryMs = expiryHours * 3600 * 1000;
    let changed = false;

    for (const origin of Object.keys(overrides)) {
      const entry = overrides[origin];
      if (!entry || !entry.ts) {
        delete overrides[origin];
        changed = true;
        continue;
      }
      if ((now - entry.ts) > expiryMs) {
        delete overrides[origin];
        changed = true;
      }
    }

    if (changed) {
      await chrome.storage.local.set({ overrides });
      console.log("ShopShield: cleaned expired overrides");
    }
  } catch (e) {
    console.warn("ShopShield: cleanupExpiredOverrides failed", e);
  }
}

async function ensureDefaults() {
  try {
    const data = await chrome.storage.local.get(["enabled", "delaySeconds", "overrideExpiryHours", "overrides"]);
    const toSet = {};
    if (typeof data.enabled === "undefined") toSet.enabled = true;
    if (typeof data.delaySeconds === "undefined") toSet.delaySeconds = 60;
    if (typeof data.overrideExpiryHours === "undefined") toSet.overrideExpiryHours = 24;
    if (typeof data.overrides === "undefined") toSet.overrides = {};
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  } catch (e) {
    console.warn("ShopShield: ensureDefaults failed", e);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("ShopShield installed");
  await ensureDefaults();
  // run cleanup once after install
  await cleanupExpiredOverrides();

  // create hourly alarms *only if* chrome.alarms exists
  if (chrome.alarms && typeof chrome.alarms.create === "function") {
    try {
      chrome.alarms.create("shopshield_cleanup", { periodInMinutes: 60 });
    } catch (e) {
      console.warn("ShopShield: failed to create alarm", e);
    }
  } else {
    console.warn("ShopShield: chrome.alarms not available in this context.");
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await cleanupExpiredOverrides();

  if (chrome.alarms && typeof chrome.alarms.create === "function") {
    try {
      // ensure alarm exists (will replace if exists)
      chrome.alarms.create("shopshield_cleanup", { periodInMinutes: 60 });
    } catch (e) {
      console.warn("ShopShield: failed to create alarm on startup", e);
    }
  }
});

chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === "shopshield_cleanup") {
    cleanupExpiredOverrides();
  }
});
