// ============================================================
//  Smart Autofill — Popup Script
//  Handles: Autofill, LinkedIn Bot controls, Applied Jobs
// ============================================================

let botIsRunning = false;

// ====== INITIALIZATION ======

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  await loadBotStatus();
  await loadAppliedJobs();
});

// ====== TAB SYSTEM ======

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      document.getElementById(`${tabName}-tab`).classList.add('active');

      // Refresh data when switching tabs
      if (tabName === 'applied') loadAppliedJobs();
      if (tabName === 'bot') loadBotStatus();
    });
  });
}

// ====== AUTOFILL TAB ======

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

  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') || url.startsWith('about:')) {
    showStatusError(statusMsg, 'Cannot run on browser system pages.');
    return;
  }

  try {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fuse.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) { /* already injected */ }

    await new Promise(r => setTimeout(r, 150));

    chrome.tabs.sendMessage(tab.id, { action: 'DO_AUTOFILL' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatusError(statusMsg, 'Refresh the page and try again.');
        return;
      }

      if (response && response.status === 'success') {
        if (response.filledCount > 0) {
          statusMsg.textContent = `✅ Filled ${response.filledCount} field(s)!`;
        } else {
          statusMsg.textContent = 'ℹ️ No matching fields found.';
        }
      } else if (response && response.status === 'error') {
        showStatusError(statusMsg, `Error: ${response.error}`);
      } else {
        statusMsg.textContent = 'ℹ️ No fields were autofilled.';
      }
      scheduleHide(statusMsg);
    });
  } catch (e) {
    showStatusError(statusMsg, 'Unexpected error — check console.');
    console.error('[Smart Autofill Popup]', e);
  }
});

function showStatusError(el, msg) {
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

// ====== LINKEDIN BOT TAB ======

// Load bot status from storage
async function loadBotStatus() {
  const local = await chrome.storage.local.get(['isRunning', 'appliedCount', 'skippedCount']);
  botIsRunning = local.isRunning || false;
  updateBotUI(botIsRunning);
  document.getElementById('applied-count').textContent = local.appliedCount || 0;
  document.getElementById('skipped-count').textContent = local.skippedCount || 0;
}

function updateBotUI(running) {
  botIsRunning = running;
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.getElementById('bot-status-text');
  const startBtn = document.getElementById('btn-start-bot');
  const stopBtn = document.getElementById('btn-stop-bot');

  if (running) {
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Running';
    statusText.style.color = '#10b981';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    statusDot.className = 'status-dot stopped';
    statusText.textContent = 'Stopped';
    statusText.style.color = '';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// Start Bot
document.getElementById('btn-start-bot').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      showToast('No active tab found.', 'error');
      return;
    }

    if (!tab.url.includes('linkedin.com')) {
      showToast('Please open a LinkedIn jobs page first!', 'warning', 5000);
      return;
    }

    if (!tab.url.includes('/jobs/')) {
      showToast('Navigate to LinkedIn Jobs page (linkedin.com/jobs/search/)', 'warning', 5000);
      return;
    }

    // Check if profile has data
    const storageData = await chrome.storage.local.get(null);
    let hasProfile = false;
    if (storageData.profiles && storageData.activeProfileId) {
      const profile = storageData.profiles[storageData.activeProfileId];
      if (profile && profile.data && (profile.data.email || profile.data.firstName)) {
        hasProfile = true;
      }
    }
    if (!hasProfile) {
      showToast('Please fill your profile in Settings first!', 'warning', 5000);
      return;
    }

    showToast('Injecting bot script...', 'info', 2000);

    // Inject Fuse.js and the bot script
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fuse.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['linkedin-bot.js'] });
    } catch (injectError) {
      console.log('Script may already be injected:', injectError.message);
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // Send start command
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'startBot' });

    if (response && response.success) {
      updateBotUI(true);
      showToast('🚀 Bot started! Auto-applying to jobs...', 'success');
    } else {
      showToast(`Failed to start: ${response?.error || 'Unknown error'}`, 'error');
    }
  } catch (error) {
    console.error('Start error:', error);
    showToast('Error starting bot. Reload the LinkedIn page and try again.', 'error');
  }
});

// Stop Bot
document.getElementById('btn-stop-bot').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('linkedin.com')) {
      await chrome.storage.local.set({ isRunning: false });
      updateBotUI(false);
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'stopBot' });

    if (response && response.success) {
      updateBotUI(false);
      showToast('Bot stopped.', 'info');
    }
  } catch (error) {
    console.error('Stop error:', error);
    await chrome.storage.local.set({ isRunning: false });
    updateBotUI(false);
  }
});

// Reset Counters
document.getElementById('btn-reset-counters').addEventListener('click', async () => {
  if (!confirm('Reset all counters and clear applied jobs list?')) return;

  await chrome.storage.local.set({ appliedCount: 0, skippedCount: 0, appliedJobs: [] });
  document.getElementById('applied-count').textContent = '0';
  document.getElementById('skipped-count').textContent = '0';

  // Also notify content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('linkedin.com')) {
      await chrome.tabs.sendMessage(tab.id, { action: 'resetCounters' });
    }
  } catch (e) { /* content script not available */ }

  showToast('Counters reset!', 'success');
  loadAppliedJobs();
});

// Settings from bot tab
document.getElementById('btn-settings-from-bot').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'updateCount') {
    document.getElementById('applied-count').textContent = request.count;
  } else if (request.type === 'updateSkippedCount') {
    document.getElementById('skipped-count').textContent = request.count;
  } else if (request.type === 'botStarted') {
    updateBotUI(true);
  } else if (request.type === 'botStopped') {
    updateBotUI(false);
    if (request.reason) {
      showToast(`Bot stopped: ${request.reason}`, 'info');
    }
  }
});

// Poll counters every 2 seconds
setInterval(async () => {
  const local = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'isRunning']);
  document.getElementById('applied-count').textContent = local.appliedCount || 0;
  document.getElementById('skipped-count').textContent = local.skippedCount || 0;
  // Sync running state (in case content script changed it)
  if (botIsRunning !== (local.isRunning || false)) {
    updateBotUI(local.isRunning || false);
  }
}, 2000);

// ====== APPLIED JOBS TAB ======

async function loadAppliedJobs() {
  const { appliedJobs = [] } = await chrome.storage.local.get(['appliedJobs']);
  const listContainer = document.getElementById('applied-jobs-list');
  const countElement = document.getElementById('applied-jobs-count');

  countElement.textContent = appliedJobs.length;

  if (appliedJobs.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v3"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
        <p>No applications yet</p>
        <small>Start the bot to see your applications here</small>
      </div>
    `;
    return;
  }

  const sortedJobs = [...appliedJobs].sort((a, b) => new Date(b.date) - new Date(a.date));

  listContainer.innerHTML = sortedJobs.map(job => `
    <div class="job-card">
      <div class="job-card-header">
        <div>
          <h4 class="job-title">${escapeHtml(job.title || 'Untitled')}</h4>
          <p class="job-company">${escapeHtml(job.company || 'Unknown')}</p>
        </div>
        <span class="job-time">${formatTimeAgo(job.date)}</span>
      </div>
      <a href="${job.link}" target="_blank" class="job-link">
        View on LinkedIn
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// Export CSV
document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const { appliedJobs = [] } = await chrome.storage.local.get(['appliedJobs']);

  if (appliedJobs.length === 0) {
    showToast('No jobs to export yet.', 'info');
    return;
  }

  const headers = ['Date', 'Job Title', 'Company', 'Link'];
  const rows = appliedJobs.map(job => [
    new Date(job.date).toLocaleString(),
    `"${(job.title || '').replace(/"/g, '""')}"`,
    `"${(job.company || '').replace(/"/g, '""')}"`,
    job.link
  ]);

  const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `linkedin_applied_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${appliedJobs.length} jobs to CSV!`, 'success');
});

// Clear Applied Jobs
document.getElementById('btn-clear-applied').addEventListener('click', async () => {
  if (!confirm('Clear all applied jobs? This cannot be undone.')) return;

  await chrome.storage.local.set({ appliedJobs: [] });
  loadAppliedJobs();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.sendMessage(tab.id, { action: 'clearAppliedJobs' });
  } catch (e) { /* content script not available */ }

  showToast('Applied jobs cleared.', 'success');
});

// ====== TOAST NOTIFICATIONS ======

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-body">
      <div class="toast-icon">${icons[type]}</div>
      <div style="flex:1">${message}</div>
      <button class="toast-close">×</button>
    </div>
  `;

  container.appendChild(toast);
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());

  setTimeout(() => {
    toast.style.animation = 'toastSlideOut 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
