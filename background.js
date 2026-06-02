// Service Worker for Smart Job Form Autofill + LinkedIn Bot
chrome.runtime.onInstalled.addListener(() => {
  console.log("Smart Autofill Extension Installed.");

  // Initialize LinkedIn bot storage keys
  chrome.storage.local.set({
    isRunning: false,
    appliedCount: 0,
    skippedCount: 0,
    appliedJobs: [],
    onboardingCompleted: false
  });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'incrementCount') {
    chrome.storage.local.get(['appliedCount'], (result) => {
      const newCount = (result.appliedCount || 0) + 1;
      chrome.storage.local.set({ appliedCount: newCount });
    });
  } else if (message.type === 'incrementSkippedCount') {
    chrome.storage.local.get(['skippedCount'], (result) => {
      const newCount = (result.skippedCount || 0) + 1;
      chrome.storage.local.set({ skippedCount: newCount });
    });
  } else if (message.type === 'setRunning') {
    chrome.storage.local.set({ isRunning: message.value });
  }
});
