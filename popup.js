// popup.js
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const enabledEl = document.getElementById('enabled');
  const delayEl = document.getElementById('delay');
  const openOptions = document.getElementById('openOptions');
  const clearLogsBtn = document.getElementById('clearLogs');
  const logsEl = document.getElementById('logs');

  // Fetch settings via runtime message
  chrome.runtime.sendMessage({ type: 'getSettings' }, (resp) => {
    const s = (resp && resp.settings) ? resp.settings : { enabled: true, delaySeconds: 60, whitelistDomains: [] };
    enabledEl.checked = !!s.enabled;
    delayEl.value = s.delaySeconds || 60;
  });

  // Load logs
  function loadLogs() {
    chrome.runtime.sendMessage({ type: 'getLogs' }, (resp) => {
      const logs = (resp && resp.logs) ? resp.logs : [];
      renderLogs(logs);
    });
  }

  function renderLogs(logs) {
    if (!logs.length) {
      logsEl.textContent = 'No override logs yet.';
      return;
    }
    logsEl.innerHTML = '';
    logs.slice(0, 50).forEach(l => {
      const d = new Date(l.ts);
      const div = document.createElement('div');
      div.className = 'log-item';
      div.innerHTML = `<strong>${d.toLocaleString()}</strong><div style="font-size:12px;color:#333;">${escapeHtml(l.note || '(no note)')}</div><div style="font-size:11px;color:#666;">${escapeHtml(l.url)}</div>`;
      logsEl.appendChild(div);
    });
  }

  function escapeHtml(s) {
    return (s||'').toString().replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  }

  enabledEl.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.enabled = enabledEl.checked;
    await setSettings(settings);
  });

  delayEl.addEventListener('change', async () => {
    const val = Number(delayEl.value) || 60;
    const settings = await getSettings();
    settings.delaySeconds = Math.max(5, Math.min(3600, val));
    await setSettings(settings);
    delayEl.value = settings.delaySeconds;
  });

  openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  clearLogsBtn.addEventListener('click', () => {
    chrome.storage.local.set({ overrideLogs_v1: [] }, () => {
      loadLogs();
    });
  });

  async function getSettings() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'getSettings' }, (resp) => {
        resolve(resp && resp.settings ? resp.settings : { enabled: true, delaySeconds: 60, whitelistDomains: [] });
      });
    });
  }
  async function setSettings(s) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'setSettings', settings: s }, (resp) => {
        resolve(resp);
      });
    });
  }

  loadLogs();
}
