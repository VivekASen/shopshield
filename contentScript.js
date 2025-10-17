// contentScript.js — runs on every page

async function getSettings() {
  return await chrome.storage.local.get(["enabled", "delaySeconds"]);
}

// Function to hide checkout buttons and credit card fields
async function blockCheckout() {
  const { enabled } = await getSettings();
  if (!enabled) return; // Do nothing if extension is disabled

  // Hide checkout buttons
  const checkoutButtons = document.querySelectorAll('button, input[type="submit"]');
  checkoutButtons.forEach(btn => {
    if (btn.innerText.toLowerCase().includes("checkout") || btn.name.toLowerCase().includes("checkout")) {
      btn.style.display = "none";
    }
  });

  // Hide credit card input fields
  const ccFields = document.querySelectorAll(
    'input[type="credit-card"], input[name*="card"], input[name*="cc"]'
  );
  ccFields.forEach(f => f.style.display = "none");
}

// Function to show a delay modal
async function showDelayModal() {
  const { delaySeconds, enabled } = await getSettings();
  if (!enabled) return;

  // Check if modal already exists
  if (document.getElementById("shopshield-delay-modal")) return;

  const modal = document.createElement("div");
  modal.id = "shopshield-delay-modal";
  modal.style.position = "fixed";
  modal.style.top = "0";
  modal.style.left = "0";
  modal.style.width = "100%";
  modal.style.height = "100%";
  modal.style.backgroundColor = "rgba(0,0,0,0.75)";
  modal.style.color = "#fff";
  modal.style.display = "flex";
  modal.style.flexDirection = "column";
  modal.style.justifyContent = "center";
  modal.style.alignItems = "center";
  modal.style.zIndex = "999999";
  modal.style.fontSize = "20px";
  modal.innerHTML = `
    <div style="text-align:center; max-width: 400px;">
      <p>Take a deep breath! Pause for <span id="shopshield-timer">${delaySeconds}</span> seconds before purchasing.</p>
      <button id="shopshield-close-btn" style="margin-top:20px; padding:10px;">Override</button>
    </div>
  `;
  document.body.appendChild(modal);

  const timerEl = document.getElementById("shopshield-timer");
  let seconds = delaySeconds;

  const interval = setInterval(() => {
    seconds--;
    timerEl.textContent = seconds;
    if (seconds <= 0) {
      clearInterval(interval);
      modal.remove();
    }
  }, 1000);

  // Allow manual override
  document.getElementById("shopshield-close-btn").addEventListener("click", async () => {
    clearInterval(interval);
    modal.remove();

    // Log override in storage
    const { reflectionLogs } = await chrome.storage.local.get("reflectionLogs");
    const logs = reflectionLogs || [];
    logs.unshift({
      text: "Override clicked",
      timestamp: Date.now(),
      url: window.location.href
    });
    await chrome.storage.local.set({ reflectionLogs: logs });
  });
}

// Run the functions initially
blockCheckout();
showDelayModal();

// Observe DOM changes (some checkout buttons appear dynamically)
const observer = new MutationObserver(() => {
  blockCheckout();
});
observer.observe(document.body, { childList: true, subtree: true });
