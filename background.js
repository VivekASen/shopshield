// background.js — MV3 service worker

chrome.runtime.onInstalled.addListener(() => {
    console.log("ShopShield installed.");
    chrome.storage.local.set({
      enabled: true,
      delaySeconds: 60,
      reflectionLogs: []
    });
  });
  
  // Listen for messages (optional for future features)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "getSettings") {
      chrome.storage.local.get(["enabled", "delaySeconds"], sendResponse);
      return true; // async
    }
    if (msg.action === "logReflection") {
      chrome.storage.local.get(["reflectionLogs"], (data) => {
        const logs = data.reflectionLogs || [];
        logs.unshift({
          text: msg.text,
          timestamp: Date.now(),
          url: sender?.tab?.url || "unknown"
        });
        chrome.storage.local.set({ reflectionLogs: logs });
      });
    }
  });
  