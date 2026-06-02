document.getElementById('btn-settings').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

document.getElementById('btn-autofill').addEventListener('click', async () => {
  const statusMsg = document.getElementById('status-message');
  statusMsg.classList.remove('hidden');
  statusMsg.style.color = 'var(--primary)';
  statusMsg.style.background = 'rgba(94, 23, 235, 0.1)';
  statusMsg.textContent = 'Starting autofill…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    statusMsg.textContent = 'No active tab found.';
    scheduleHide(statusMsg);
    return;
  }

  // Reject browser system pages that extensions can't touch
  const url = tab.url || '';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:')
  ) {
    showError(statusMsg, 'Cannot run on browser system pages.');
    return;
  }

  try {
    // ── Step 1: Ensure scripts are injected ─────────────────────────────
    // This handles the case where the tab was already open before the
    // extension was installed/reloaded.  The guard in content.js
    // (window.__smartAutofillLoaded) prevents double-initialization.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['fuse.js']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (_) {
      // Scripts were already injected by the manifest — that's fine.
    }

    // ── Step 2: Trigger autofill ─────────────────────────────────────────
    // Small delay so the just-injected content.js has time to register
    // its message listener before we fire the message.
    await new Promise(r => setTimeout(r, 150));

    chrome.tabs.sendMessage(tab.id, { action: 'DO_AUTOFILL' }, (response) => {
      if (chrome.runtime.lastError) {
        showError(statusMsg, 'Refresh the page and try again.');
        return;
      }

      if (response && response.status === 'success') {
        if (response.filledCount > 0) {
          statusMsg.textContent = `✅ Filled ${response.filledCount} field(s)!`;
        } else {
          statusMsg.textContent = 'ℹ️ No matching fields found.';
        }
      } else if (response && response.status === 'error') {
        showError(statusMsg, `Error: ${response.error}`);
      } else {
        statusMsg.textContent = 'ℹ️ No fields were autofilled.';
      }

      scheduleHide(statusMsg);
    });

  } catch (e) {
    showError(statusMsg, 'Unexpected error — check console.');
    console.error('[Smart Autofill Popup]', e);
  }
});

function showError(el, msg) {
  el.textContent = '❌ ' + msg;
  el.style.color = '#ef4444';
  el.style.background = 'rgba(239,68,68,0.1)';
  scheduleHide(el);
}

function scheduleHide(el) {
  setTimeout(() => {
    el.classList.add('hidden');
    el.style.color = 'var(--primary)';
    el.style.background = 'rgba(94, 23, 235, 0.1)';
  }, 4000);
}
