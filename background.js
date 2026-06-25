chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'JOB_DETECTED') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
  if (message.type === 'DETECT_JOB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'DETECT_JOB' }, (response) => {
          if (chrome.runtime.lastError) {
            console.log('Content script not ready, injecting...');
            chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content.js']
            }).catch(() => {});
          }
        });
      }
    });
  }
  if (message.type === 'AUTOFILL_EEO') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content.js']
            }).then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
              }, 500);
            }).catch(() => {});
          }
        });
      }
    });
  }
});