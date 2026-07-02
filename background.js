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

// ===== Self-healing content-script injection on LinkedIn =====
// Manifest-registered content scripts only reach frames created AFTER the extension load and
// never heal orphaned copies left behind by an extension reload. That made every fix depend on
// a perfectly-timed manual reload + tab refresh — and left LinkedIn's same-origin /preload
// apply iframe (where ATS-powered Easy Apply forms actually live) unscripted whenever timing
// was off. So we also inject programmatically: on every completed navigation in any LinkedIn
// frame, on SPA history updates, and into all existing LinkedIn tabs the moment the extension
// (re)loads. content.js carries a run-once-per-frame guard, so repeat injection is a no-op.
function injectContentScript(tabId, frameIds) {
  var target = { tabId: tabId };
  if (frameIds) target.frameIds = frameIds; else target.allFrames = true;
  chrome.scripting.executeScript({ target: target, files: ['content.js'] }).catch(function () {});
}

chrome.webNavigation.onCompleted.addListener(function (details) {
  injectContentScript(details.tabId, [details.frameId]);
}, { url: [{ hostSuffix: 'linkedin.com' }] });

chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  injectContentScript(details.tabId, [details.frameId]);
}, { url: [{ hostSuffix: 'linkedin.com' }] });

chrome.runtime.onInstalled.addListener(function () {
  chrome.tabs.query({ url: '*://*.linkedin.com/*' }, function (tabs) {
    (tabs || []).forEach(function (t) { injectContentScript(t.id); });
  });
});

// ===== ATS forms embedded in an iframe ON linkedin.com itself =====
// Some "Easy Apply" postings actually show the employer's real ATS page (Lever, Greenhouse,
// etc.) inside a cross-origin iframe layered on top of the LinkedIn page, rather than
// LinkedIn's own native Easy Apply form. content.js (matched only to linkedin.com, top frame)
// cannot see inside that iframe at all — cross-origin frames are opaque to a content script
// that isn't itself running in them. The fix: when content.js notices an unfamiliar
// cross-origin iframe sitting inside an open modal, it messages here, and we inject autofill.js
// directly INTO that frame (permitted because host_permissions covers every origin) — once
// injected, autofill.js runs natively inside the iframe's own document and can fill/advance it
// like any other external ATS page. Only frames whose hostname matches a known ATS provider are
// targeted, so this never touches LinkedIn's own ad/chat/video iframes.
function injectAtsFrames(tabId) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return;
  chrome.webNavigation.getAllFrames({ tabId: tabId }, function (frames) {
    if (!frames) return;
    frames.forEach(function (f) {
      if (f.frameId === 0) return;                 // top frame is linkedin.com — content.js owns it
      if (!/^https?:/i.test(f.url || '')) return;  // skip about:blank / data: / chrome-extension frames
      var host = '';
      try { host = new URL(f.url).hostname; } catch (e) { return; }
      if (/(^|\.)linkedin\.com$|(^|\.)licdn\.com$/i.test(host)) return; // LinkedIn's own subframes
      // Inject into recognized ATS domains OR any direct child frame of the top page (the
      // embedded employer application is a direct child; nested tracking/ad frames are not).
      // autofill.js self-guards: it does nothing on a frame with no recognized form and never
      // clicks Submit/Apply, so injecting into a non-application frame is harmless.
      if (!ATS_HOST_RE.test(host) && f.parentFrameId !== 0) return;
      chrome.scripting.executeScript({ target: { tabId: tabId, frameIds: [f.frameId] }, files: ['autofill.js'] }).catch(function () {});
    });
  });
}

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (message && message.type === 'CHECK_ATS_IFRAME' && sender.tab) {
    var tabId = sender.tab.id;
    // Lever/Greenhouse-style embeds often render their real form asynchronously after the
    // iframe's initial (near-empty) document loads, so try a couple of times.
    setTimeout(function () { injectAtsFrames(tabId); }, 1200);
    setTimeout(function () { injectAtsFrames(tabId); }, 3000);
  }
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
  if (message.type === 'COLLECT_QUEUE') {
    // Relay to the active tab's content script (a side-panel runtime.sendMessage does NOT reach
    // content scripts), re-injecting content.js once if it isn't there yet — same pattern as SCAN_JOBS.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'COLLECT_QUEUE' }, (response) => {
          if (chrome.runtime.lastError) {
            chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content.js']
            }).then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'COLLECT_QUEUE' }).catch(() => {});
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

// ===== Easy Apply Queue orchestration =====
// A navigation kills the content script, so the queue's job-to-job stepping has to live here in
// the (event-driven, storage-backed) service worker. content.js opens+fills each job and, after
// the human clicks Submit, messages QUEUE_ITEM_SUBMITTED; a non-fillable job messages
// QUEUE_ITEM_SKIP. We mark the item, enforce the per-session cap, and navigate the queue tab to
// the next pending job. All pacing lives in content.js (page context) so an MV3 worker suspend
// can't drop a timer mid-wait. The human always clicks the final Submit — nothing here submits.
var QUEUE_SESSION_CAP = 20;

function queueOpenNext() {
  chrome.storage.local.get(['applyQueue', 'queueActive', 'queueTabId'], function (d) {
    if (!d.queueActive) return;
    var q = d.applyQueue || [];
    var idx = -1;
    for (var i = 0; i < q.length; i++) { if (q[i].status === 'pending') { idx = i; break; } }
    if (idx < 0) { // nothing left
      chrome.storage.local.set({ queueActive: false, queuePaused: false, queueStatusMsg: 'Queue complete — every job has been processed.' });
      return;
    }
    if (!d.queueTabId) return;
    chrome.storage.local.set({ queueIndex: idx }, function () {
      chrome.tabs.update(d.queueTabId, { url: q[idx].url }).catch(function () {});
    });
  });
}

function queueMarkAndAdvance(jobId, newStatus, incrementSession) {
  chrome.storage.local.get(['applyQueue', 'queueSessionCount', 'queueActive'], function (d) {
    if (!d.queueActive) return;
    var q = d.applyQueue || [];
    for (var i = 0; i < q.length; i++) {
      if (q[i].jobId === jobId && q[i].status === 'pending') { q[i].status = newStatus; break; }
    }
    var count = d.queueSessionCount || 0;
    if (incrementSession) count++;
    var updates = { applyQueue: q, queueSessionCount: count };
    if (incrementSession && count >= QUEUE_SESSION_CAP) {
      updates.queueActive = false;
      updates.queuePaused = false;
      updates.queueStatusMsg = 'Nice work — ' + count + ' applications this session. Pausing here to keep the account safe. Press Start when you want to continue.';
      chrome.storage.local.set(updates);
      return;
    }
    chrome.storage.local.set(updates, function () { queueOpenNext(); });
  });
}

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message) return;
  if (message.type === 'QUEUE_START') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tabId = (tabs && tabs[0]) ? tabs[0].id : (sender.tab ? sender.tab.id : null);
      chrome.storage.local.set({
        queueActive: true, queuePaused: false, queueSessionCount: 0, queueStatusMsg: '', queueTabId: tabId
      }, function () { queueOpenNext(); });
    });
  }
  if (message.type === 'QUEUE_ITEM_SUBMITTED') queueMarkAndAdvance(message.jobId, 'done', true);
  if (message.type === 'QUEUE_ITEM_SKIP') queueMarkAndAdvance(message.jobId, 'skipped', false);

  // LinkedIn's daily submission cap: stop the queue but leave remaining jobs PENDING (not skipped)
  // so the user can resume tomorrow with Start.
  if (message.type === 'QUEUE_DAILY_LIMIT') {
    chrome.storage.local.set({
      queueActive: false, queuePaused: false,
      queueStatusMsg: "LinkedIn's daily application limit was reached — the queue stopped and your remaining jobs are kept. Press Start tomorrow to continue."
    });
  }

  // Best-effort: open the side panel when the user clicks "Tailor my resume" on the in-page match
  // badge. sidePanel.open() wants a user gesture and messaging can break that chain, so if it's
  // rejected the pendingTailorJob fallback still fires when the user opens the panel themselves.
  if (message.type === 'OPEN_SIDE_PANEL' && sender.tab) {
    try {
      var p = chrome.sidePanel.open({ tabId: sender.tab.id });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
});