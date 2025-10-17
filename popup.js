// popup.js — controls popup UI

const enabledBox = document.getElementById("enabled");
const delayInput = document.getElementById("delay");
const clearBtn = document.getElementById("clearLogs");
const status = document.getElementById("status");
const logDiv = document.getElementById("log");

// Load settings from storage
async function loadSettings() {
  const data = await chrome.storage.local.get(["enabled", "delaySeconds", "reflectionLogs"]);
  enabledBox.checked = data.enabled ?? true;
  delayInput.value = data.delaySeconds ?? 60;
  renderLogs(data.reflectionLogs || []);
}

// Render reflection logs
function renderLogs(logs) {
  logDiv.innerHTML = "";
  if (!logs.length) {
    logDiv.textContent = "No reflections yet.";
    return;
  }
  logs.forEach(entry => {
    const div = document.createElement("div");
    const time = new Date(entry.timestamp).toLocaleString();
    div.innerHTML = `<div><strong>${entry.text}</strong></div>
                     <div class="small">${time} — ${entry.url}</div>`;
    logDiv.appendChild(div);
  });
}

// Update enabled toggle
enabledBox.addEventListener("change", async () => {
  const enabled = enabledBox.checked;
  await chrome.storage.local.set({ enabled });

  // Re-run content scripts in all tabs
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          // Re-run the blockCheckout and showDelayModal in the page
          if (typeof blockCheckout === "function") blockCheckout();
          if (typeof showDelayModal === "function") showDelayModal();
        }
      });
    });
  });

  status.textContent = "Settings updated";
  setTimeout(() => (status.textContent = ""), 1200);
});

// Update delay input
delayInput.addEventListener("change", async () => {
  const value = parseInt(delayInput.value) || 60;
  await chrome.storage.local.set({ delaySeconds: value });
  status.textContent = "Delay time updated.";
  setTimeout(() => (status.textContent = ""), 1200);
});

// Clear reflection logs
clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ reflectionLogs: [] });
  await loadSettings();
  status.textContent = "Logs cleared.";
  setTimeout(() => (status.textContent = ""), 1200);
});

loadSettings();
