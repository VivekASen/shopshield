/* contentScript.js
   ShopShield MVP content script.
   - Detect checkout / payment UI by scanning for keywords in buttons/inputs/form ids/names/placeholders/aria-labels.
   - Disable/hide those elements and show a modal asking user to pause.
   - Does NOT read or store form field values (we only inspect attributes/text).
*/

// Configuration: detection keywords (can be expanded)
const CHECKOUT_KEYWORDS = [
  "checkout", "place order", "place my order", "buy now", "complete order", "proceed to checkout",
  "payment", "card number", "credit card", "cc-number", "card-number", "billing", "pay now"
];

const SHOPSHIELD_ATTR = 'data-shopshield-blocked';
const MODAL_ID = 'shopshield-modal-root';

// Default settings (will be overwritten by storage if user changed)
const DEFAULT_SETTINGS = {
  enabled: true,
  delaySeconds: 60,
  autoHideAfterDelay: false,
  showLogsOnPopup: true,
  whitelistDomains: [] // domains where extension won't block if user adds them
};

// Utility: normalize text for matching
function norm(s) { return (s || "").toString().trim().toLowerCase(); }

// Check if the current domain is whitelisted
async function isWhitelisted() {
  const url = new URL(location.href);
  const domain = url.hostname;
  const data = await chrome.storage.local.get(['settings']);
  const settings = data.settings || DEFAULT_SETTINGS;
  return settings.whitelistDomains && settings.whitelistDomains.includes(domain);
}

// Return true if element looks like a checkout/payment trigger
function looksLikeCheckout(el) {
  if (!el) return false;
  // skip if already processed
  if (el.hasAttribute(SHOPSHIELD_ATTR)) return false;

  const texts = [
    el.innerText,
    el.value,
    el.getAttribute && el.getAttribute('aria-label'),
    el.getAttribute && el.getAttribute('name'),
    el.getAttribute && el.getAttribute('id'),
    el.getAttribute && el.getAttribute('placeholder'),
    el.getAttribute && el.getAttribute('role')
  ].map(norm).filter(Boolean);

  // examine each text for any checkout keyword
  for (const t of texts) {
    for (const kw of CHECKOUT_KEYWORDS) {
      if (t.includes(kw)) return true;
    }
  }

  // additional heuristic: input fields likely to be credit-card related
  if (el.tagName && el.tagName.toLowerCase() === 'input') {
    const type = norm(el.type);
    if (type === 'tel' || type === 'text') {
      const name = norm(el.name || '');
      if (name.includes('card') || name.includes('cc') || name.includes('cvv') || name.includes('expiry') || name.includes('cvc')) {
        return true;
      }
    }
  }

  return false;
}

// Apply an unobtrusive block to matched elements (do not remove form elements; either hide or disable)
function blockElement(el) {
  try {
    el.setAttribute(SHOPSHIELD_ATTR, '1');

    // Prefer to disable interactive elements rather than permanently remove
    if (typeof el.disabled !== 'undefined') {
      el.disabled = true;
      // mark visually
      el.style.opacity = '0.35';
      el.style.pointerEvents = 'none';
    } else {
      // fallback: hide with a button replacement
      const wrapper = document.createElement('div');
      wrapper.style.display = 'inline-block';
      wrapper.style.opacity = '0.35';
      wrapper.style.pointerEvents = 'none';
      el.parentNode && el.parentNode.replaceChild(wrapper, el);
      wrapper.appendChild(el);
    }
  } catch (e) {
    // don't break the page
    console.warn('ShopShield block failed', e);
  }
}

// Re-enable element (used when user overrides)
function unblockElement(el) {
  try {
    if (el.hasAttribute(SHOPSHIELD_ATTR)) {
      el.removeAttribute(SHOPSHIELD_ATTR);
      if (typeof el.disabled !== 'undefined') el.disabled = false;
      el.style.opacity = '';
      el.style.pointerEvents = '';
    }
  } catch (e) {}
}

// Scan the page for possible checkout/payment UI elements and return them
function findCheckoutCandidates() {
  const all = Array.from(document.querySelectorAll('button, input, a, form, [role="button"], [type="submit"]'));
  const candidates = [];
  for (const el of all) {
    if (looksLikeCheckout(el)) candidates.push(el);
  }
  return candidates;
}

// Create and display mindful modal overlay (returns a control object)
function createModal(delaySeconds, onOverride) {
  // If modal already exists, return
  if (document.getElementById(MODAL_ID)) return null;

  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.style.position = 'fixed';
  root.style.top = '0';
  root.style.left = '0';
  root.style.right = '0';
  root.style.bottom = '0';
  root.style.zIndex = '2147483647'; // very high; reviewers may question this but overlay needed to pause interaction
  root.style.display = 'flex';
  root.style.alignItems = 'center';
  root.style.justifyContent = 'center';
  root.style.background = 'rgba(0,0,0,0.45)';
  root.style.fontFamily = 'Arial, sans-serif';

  const card = document.createElement('div');
  card.style.maxWidth = '520px';
  card.style.padding = '18px';
  card.style.borderRadius = '10px';
  card.style.background = '#fff';
  card.style.boxShadow = '0 8px 30px rgba(0,0,0,0.3)';
  card.style.textAlign = 'left';
  card.style.color = '#111';

  const title = document.createElement('h2');
  title.textContent = 'Pause and reflect';
  title.style.marginTop = '0';
  title.style.marginBottom = '8px';

  const body = document.createElement('div');
  body.innerHTML = `<p>Before completing this purchase, take a moment to reflect.</p>
    <ul>
      <li>Do I really need this?</li>
      <li>Can I wait 24 hours?</li>
      <li>Can I afford this right now?</li>
    </ul>`;

  const timerRow = document.createElement('div');
  timerRow.style.marginTop = '10px';
  timerRow.style.display = 'flex';
  timerRow.style.alignItems = 'center';
  timerRow.style.justifyContent = 'space-between';

  const timerLabel = document.createElement('div');
  timerLabel.id = 'shopshield-timer-label';
  timerLabel.textContent = `Please wait ${delaySeconds} second(s) before overriding.`;

  const buttons = document.createElement('div');

  const overrideBtn = document.createElement('button');
  overrideBtn.textContent = 'Override';
  overrideBtn.disabled = true;
  overrideBtn.style.marginRight = '8px';
  overrideBtn.style.padding = '8px 12px';
  overrideBtn.style.borderRadius = '6px';
  overrideBtn.style.border = 'none';
  overrideBtn.style.cursor = 'pointer';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.padding = '8px 12px';
  cancelBtn.style.borderRadius = '6px';
  cancelBtn.style.border = '1px solid #ccc';
  cancelBtn.style.cursor = 'pointer';
  cancelBtn.style.background = '#fff';

  buttons.appendChild(overrideBtn);
  buttons.appendChild(cancelBtn);
  timerRow.appendChild(timerLabel);
  timerRow.appendChild(buttons);

  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(timerRow);

  // small text for logging permission
  const logText = document.createElement('div');
  logText.style.marginTop = '10px';
  logText.style.fontSize = '12px';
  logText.style.color = '#666';
  logText.textContent = 'If you override, you will be prompted to optionally add a short reason which is stored only on this device.';
  card.appendChild(logText);

  root.appendChild(card);
  document.body.appendChild(root);

  // countdown
  let remaining = delaySeconds;
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      timerLabel.textContent = 'You may override now.';
      overrideBtn.disabled = false;
      clearInterval(interval);
    } else {
      timerLabel.textContent = `Please wait ${remaining} second(s) before overriding.`;
    }
  }, 1000);

  cancelBtn.addEventListener('click', () => {
    try { root.remove(); } catch(e){}
  });

  overrideBtn.addEventListener('click', async () => {
    // remove modal immediately to let user interact
    try { root.remove(); } catch(e){}
    // call onOverride callback to re-enable blocked elements and optionally log reason
    if (typeof onOverride === 'function') onOverride();
  });

  return {
    remove: () => { try { root.remove(); } catch(e){} },
  };
}

// Save override log (short note). We only store timestamp + url + short text — never any form values or payment info.
async function saveOverrideLog(note) {
  const key = 'overrideLogs_v1';
  const url = location.href;
  const entry = { ts: Date.now(), url, note: note ? String(note).slice(0,1000) : '' };
  const data = await chrome.storage.local.get([key]);
  const arr = data[key] || [];
  arr.unshift(entry);
  await chrome.storage.local.set({ [key]: arr });
}

// Main: attempt blocking and modal injection if enabled and not whitelisted
(async function main() {
  try {
    const settingsData = await chrome.storage.local.get(['settings']);
    const settings = settingsData.settings || DEFAULT_SETTINGS;
    if (!settings.enabled) return;
    if (await isWhitelisted()) return;

    // find candidate elements
    const candidates = findCheckoutCandidates();
    if (!candidates.length) return;

    // Block them
    candidates.forEach(blockElement);

    // Create modal with delay
    const modal = createModal(settings.delaySeconds || DEFAULT_SETTINGS.delaySeconds, async () => {
      // On override: restore blocked elements and prompt for optional note
      candidates.forEach(unblockElement);

      // Prompt for short reason (use native prompt to keep permission surface minimal)
      try {
        const reason = prompt('Optional: briefly why are you overriding the pause? (This stays on your device only.)', '');
        if (reason !== null) {
          await saveOverrideLog(reason);
        } else {
          // user pressed cancel => still allowed to proceed; no log saved
        }
      } catch (e) {
        // If prompt blocked, just proceed
      }
    });

    // Also observe dynamic DOM changes for new checkout buttons (SPAs)
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const added = Array.from(m.addedNodes || []).filter(n => n.nodeType === Node.ELEMENT_NODE);
        for (const node of added) {
          const sub = node.querySelectorAll ? node.querySelectorAll('button, input, a, form, [role="button"]') : [];
          for (const el of sub) {
            if (looksLikeCheckout(el) && !el.hasAttribute(SHOPSHIELD_ATTR)) {
              blockElement(el);
            }
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

  } catch (e) {
    console.error('ShopShield contentScript error', e);
  }
})();
