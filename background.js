chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ===== External-ATS application sessions =====
// When the user clicks "Auto-Fill Open Application" on a non-LinkedIn page, sidepanel.js
// records a session for that tab and injects autofill.js. Many ATS flows do real page
// navigations (careers page -> account creation -> application wizard), which kill the
// injected script — so while a session is fresh we re-inject autofill.js on every page load
// in that tab, as long as the page is the same site or a known ATS domain. The engine itself
// never clicks Submit/Apply/Create-Account buttons; the human always does that.
var ATS_SESSION_TTL_MS = 20 * 60 * 1000;
var ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|jobvite|taleo|oraclecloud|successfactors|workable|bamboohr|adp|paylocity|paycom|ultipro|ukg|dayforcehcm|eightfold|phenompeople|avature|breezy|jazz|recruitee|teamtailor)\.(com|io|co|net|hr|ai)$/i;

function baseDomain(host) {
  var parts = (host || '').split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (!/^https?:/i.test(tab.url) || /(^|\.)linkedin\.com/i.test(tab.url)) return;
  chrome.storage.local.get('autofillSessions', function (data) {
    var sessions = data.autofillSessions || {};
    var s = sessions[String(tabId)];
    if (!s) return;
    if (Date.now() - (s.startedAt || 0) > ATS_SESSION_TTL_MS) {
      delete sessions[String(tabId)];
      chrome.storage.local.set({ autofillSessions: sessions });
      return;
    }
    var host = '';
    try { host = new URL(tab.url).hostname; } catch (e) {}
    var sameSite = host && s.hostname && baseDomain(host) === baseDomain(s.hostname);
    if (!sameSite && !ATS_HOST_RE.test(host)) return; // user wandered off — leave the page alone
    setTimeout(function () {
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['autofill.js'] }).catch(function () {});
    }, 800);
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.local.get('autofillSessions', function (data) {
    var sessions = data.autofillSessions || {};
    if (!sessions[String(tabId)]) return;
    delete sessions[String(tabId)];
    chrome.storage.local.set({ autofillSessions: sessions });
  });
});

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
  if (message.type === 'SCAN_JOBS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_JOBS' }, (response) => {
          if (chrome.runtime.lastError) {
            chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content.js']
            }).then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_JOBS' }).catch(() => {});
              }, 600);
            }).catch(() => {});
          }
        });
      }
    });
  }
  if (message.type === 'SCAN_PEOPLE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_PEOPLE' }, (response) => {
          if (chrome.runtime.lastError) {
            chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content.js']
            }).then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_PEOPLE' }).catch(() => {});
              }, 600);
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