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
  statusMsg.textContent = "Starting autofill...";

  // Query active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (tab) {
    // Send message to content script
    try {
      chrome.tabs.sendMessage(tab.id, { action: "DO_AUTOFILL" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script may not be injected or the page is restricted (e.g. chrome://)
          statusMsg.textContent = "Cannot autofill this page.";
          statusMsg.style.color = "red";
          statusMsg.style.background = "rgba(255,0,0,0.1)";
          return;
        }

        if (response && response.status === "success") {
          statusMsg.textContent = `Autofilled ${response.filledCount} fields!`;
        } else {
          statusMsg.textContent = "No fields were autofilled.";
        }
      });
    } catch (e) {
      statusMsg.textContent = "Error executing autofill.";
    }
  } else {
    statusMsg.textContent = "No active tab found.";
  }

  setTimeout(() => {
    statusMsg.classList.add('hidden');
    statusMsg.style.color = "var(--primary)";
    statusMsg.style.background = "rgba(94, 23, 235, 0.1)";
  }, 3000);
});
