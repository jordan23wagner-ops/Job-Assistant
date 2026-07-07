chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ===== External-ATS application sessions =====
// When the user clicks "Auto-Fill Open Application" on a non-LinkedIn page, sidepanel.js
// records a session for that tab and injects autofill.js. Many ATS flows do real page
// navigations (careers page -> account creation -> application wizard), which kill the
// injected script — so while a session is fresh we re-inject autofill.js on every page load
// in that tab, as long as the page is the same site or a known ATS domain. The engine itself
// never clicks Submit/Apply/Create-Account buttons; the human always does that.
var ATS_SESSION_TTL_MS = 20 * 60 * 1000;
var ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|oraclecloud|successfactors|workable|bamboohr|adp|paylocity|paycom|ultipro|ukg|dayforcehcm|eightfold|phenompeople|avature|breezy|jazz|recruitee|teamtailor)\.(com|io|co|net|hr|ai)$/i;
// Job aggregators/redirectors that sit BETWEEN a search result and the real employer application
// (they show email-capture interstitials, then bounce to the employer's ATS). For an explicit
// web-app apply we auto-advance through these to reach the real form.
var AGGREGATOR_HOST_RE = /(^|\.)(adzuna|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice|talent|jooble|neuvoo)\.(com|net|co\.uk|ca|com\.au|de|fr)$/i;

function baseDomain(host) {
  var parts = (host || '').split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

// Normalize a URL to origin+pathname (no query/hash) for matching web-app apply requests to the
// tabs the web app opens.
function normUrl(u) {
  try { var x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, ''); } catch (e) { return String(u || '').split('?')[0].replace(/\/+$/, ''); }
}
var PENDING_APPLY_TTL_MS = 10 * 60 * 1000;

// Injected into an aggregator landing page (Adzuna/Indeed/etc.) during an explicit apply session:
// dismiss the email-capture modal and click through to the employer's application. Best-effort.
function skipAggregatorInterstitial() {
  try {
    var clickByText = function (patterns) {
      var els = document.querySelectorAll('a,button,[role="button"]');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '').trim();
        if (!t || t.length > 60) continue;
        for (var r = 0; r < patterns.length; r++) {
          if (patterns[r].test(t)) { try { els[i].click(); return true; } catch (e) {} }
        }
      }
      return false;
    };
    // 1) dismiss any "leave your email" modal, preferring the option that proceeds to the job
    clickByText([/take me to the job/i, /^no,?\s*thanks/i, /^skip$/i, /not now/i, /^close$/i]);
    // 2) then click through to the employer application
    setTimeout(function () { clickByText([/take me to the job/i, /apply for (this )?job/i, /^apply now$/i, /^apply$/i]); }, 500);
  } catch (e) {}
}

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (!/^https?:/i.test(tab.url) || /(^|\.)linkedin\.com/i.test(tab.url)) return;
  chrome.storage.local.get(['autofillSessions', 'pendingApplyUrls'], function (data) {
    var sessions = data.autofillSessions || {};
    var pending = data.pendingApplyUrls || {};
    var s = sessions[String(tabId)];
    if (!s) {
      // Adopt a tab the web app opened for an apply: if this URL was registered by the Jobs tab,
      // turn it into an explicit autofill session so the engine fills it (and follows redirects).
      var key = normUrl(tab.url);
      var match = pending[key];
      if (match && Date.now() - (match.ts || 0) < PENDING_APPLY_TTL_MS) {
        var mHost = '';
        try { mHost = new URL(tab.url).hostname; } catch (e) {}
        s = { hostname: mHost, startedAt: Date.now(), explicit: true, tailoredResume: match.resumeText || '' };
        sessions[String(tabId)] = s;
        delete pending[key];
        chrome.storage.local.set({ autofillSessions: sessions, pendingApplyUrls: pending });
      } else {
        return;
      }
    }
    if (Date.now() - (s.startedAt || 0) > ATS_SESSION_TTL_MS) {
      delete sessions[String(tabId)];
      chrome.storage.local.set({ autofillSessions: sessions });
      return;
    }
    var host = '';
    try { host = new URL(tab.url).hostname; } catch (e) {}
    var sameSite = host && s.hostname && baseDomain(host) === baseDomain(s.hostname);
    // Explicit web-app applies act on ANY employer page they land on (the user chose this job);
    // manual/auto-detect sessions stay scoped to same-site or the known-ATS allowlist.
    if (!sameSite && !ATS_HOST_RE.test(host) && !s.explicit) return; // user wandered off — leave the page alone
    setTimeout(function () {
      if (s.explicit && AGGREGATOR_HOST_RE.test(host)) {
        // On an aggregator landing page: click through to the employer application instead of filling.
        chrome.scripting.executeScript({ target: { tabId: tabId }, func: skipAggregatorInterstitial }).catch(function () {});
      } else {
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['autofill.js'] }).catch(function () {});
      }
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

// ===== Auto-detect + offer on known ATS pages =====
// On a completed load of a known-ATS page (Workday/Greenhouse/Lever/etc.) with no active autofill
// session for that tab, inject detect.js — a tiny script that offers to auto-fill if the page
// looks like an application form. Scoped to ATS_HOST_RE so we never inject into arbitrary sites
// the user browses; plain company career sites still use the side panel's manual button. When the
// user accepts, we start the exact same session the manual button does. "Not now" suppresses the
// offer for that host for a while (in-memory; a worker restart may re-offer — harmless).
var atsOfferDismissed = {}; // host -> timestamp
var OFFER_DISMISS_TTL_MS = 6 * 60 * 60 * 1000;

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (!/^https?:/i.test(tab.url) || /(^|\.)linkedin\.com/i.test(tab.url)) return;
  var host = '';
  try { host = new URL(tab.url).hostname; } catch (e) { return; }
  if (!ATS_HOST_RE.test(host)) return;
  var dismissedAt = atsOfferDismissed[host];
  if (dismissedAt && Date.now() - dismissedAt < OFFER_DISMISS_TTL_MS) return;
  chrome.storage.local.get('autofillSessions', function (data) {
    var s = (data.autofillSessions || {})[String(tabId)];
    if (s && Date.now() - (s.startedAt || 0) < ATS_SESSION_TTL_MS) return; // autofill.js already owns this tab
    setTimeout(function () {
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['detect.js'] }).catch(function () {});
    }, 1200);
  });
});

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message || !sender || !sender.tab) return;
  if (message.type === 'ATS_OFFER_ACCEPT') {
    var tab = sender.tab;
    var host = '';
    try { host = new URL(tab.url).hostname; } catch (e) {}
    chrome.storage.local.get('autofillSessions', function (data) {
      var sessions = data.autofillSessions || {};
      sessions[String(tab.id)] = { hostname: host, startedAt: Date.now() };
      chrome.storage.local.set({ autofillSessions: sessions }, function () {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['autofill.js'] }).catch(function () {});
      });
    });
  }
  if (message.type === 'ATS_OFFER_DISMISS' && message.host) {
    atsOfferDismissed[message.host] = Date.now();
  }
});

// ===== Web-app handoff (Wagner-GPT "Jobs" tab -> auto-apply) =====
// bridge.js (content script on the Wagner-GPT origin) relays the web app's "apply to these jobs"
// request here. The WEB APP opens the posting tabs itself (reliable, gesture-preserved); we just
// REGISTER the URLs so that when each posting loads, the onUpdated handler above adopts that tab as
// an explicit autofill session and fills it (following redirects, skipping aggregator interstitials).
// As always, the engine stops before the final Submit; a human clicks Submit on each application.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'WEBAPP_APPLY') return;
  var jobs = Array.isArray(message.jobs) ? message.jobs.slice(0, 5) : [];
  chrome.storage.local.get('pendingApplyUrls', function (data) {
    var pending = data.pendingApplyUrls || {};
    var now = Date.now();
    Object.keys(pending).forEach(function (k) { if (now - (pending[k].ts || 0) > PENDING_APPLY_TTL_MS) delete pending[k]; });
    jobs.forEach(function (j) {
      if (j && j.url && /^https?:/i.test(j.url)) pending[normUrl(j.url)] = { ts: now, resumeText: j.resumeText || '' };
    });
    chrome.storage.local.set({ pendingApplyUrls: pending }, function () {
      try { sendResponse({ ok: true, count: jobs.length }); } catch (e) {}
    });
  });
  return true; // async sendResponse
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