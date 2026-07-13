// Swallow benign MV3 service-worker lifecycle rejections (e.g. "No SW" when the worker is spun
// down as a promise settles) so they don't surface as scary "Uncaught (in promise)" errors on the
// extensions page. Real logic errors still surface via their own try/catch/console paths.
self.addEventListener('unhandledrejection', function (e) {
  var msg = (e && e.reason && (e.reason.message || e.reason)) || '';
  if (/No SW|Extension context|message channel closed|Receiving end does not exist/i.test(String(msg))) {
    e.preventDefault();
  }
});

// setPanelBehavior returns a promise that can reject with "No SW" during worker startup — catch it.
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {}); } catch (e) {}

// ===== External-ATS application sessions =====
// When the user clicks "Auto-Fill Open Application" on a non-LinkedIn page, sidepanel.js
// records a session for that tab and injects autofill.js. Many ATS flows do real page
// navigations (careers page -> account creation -> application wizard), which kill the
// injected script — so while a session is fresh we re-inject autofill.js on every page load
// in that tab, as long as the page is the same site or a known ATS domain. The engine itself
// never clicks Submit/Apply/Create-Account buttons; the human always does that.
var ATS_SESSION_TTL_MS = 20 * 60 * 1000;
var ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|oraclecloud|successfactors|workable|bamboohr|adp|paylocity|paycom|ultipro|ukg|dayforcehcm|eightfold|phenompeople|avature|breezy|jazz|recruitee|teamtailor|zohorecruit)\.(com|io|co|net|hr|ai)$/i;
// Job aggregators/redirectors that sit BETWEEN a search result and the real employer application
// (they show email-capture interstitials, then bounce to the employer's ATS). For an explicit
// web-app apply we auto-advance through these to reach the real form.
var AGGREGATOR_HOST_RE = /(^|\.)(adzuna|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice|talent|jooble|neuvoo|jobgether|lensa|whatjobs|appcast|jobrapido|jobcase|careerjet|careerbuilder|snagajob|jobisjob|joblist|getwork|resume-library)\.(com|net|co\.uk|ca|com\.au|de|fr|io|org)$/i;

// The extension runs on the user's RESIDENTIAL IP (and with their cookies), so unlike the Vercel
// backend it isn't blocked by Adzuna/Cloudflare and can follow an Adzuna redirect straight to the
// employer. Given an adzuna URL, follow it to completion and return the final employer URL if it
// landed on a real employer/ATS host (not another aggregator and not Adzuna's login wall); else null.
function isEmployerHost(host) {
  return !!host && !/(^|\.)adzuna\./i.test(host) && !AGGREGATOR_HOST_RE.test(host);
}
async function resolveAdzunaViaFetch(url) {
  try {
    var r = await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'include', headers: { Accept: 'text/html' } });
    var finalUrl = r && r.url;
    if (!finalUrl || /\/authenticate|after_login=|interstitial=/i.test(finalUrl)) return null;
    var host = ''; try { host = new URL(finalUrl).hostname; } catch (e) { return null; }
    return isEmployerHost(host) ? finalUrl : null;
  } catch (e) { return null; }
}

function baseDomain(host) {
  var parts = (host || '').split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

// Normalize a URL to host+pathname (no scheme/www/query/hash) for matching web-app apply requests
// to the tabs the web app opens. Scheme and "www." are dropped on purpose: an http->https upgrade
// or a www redirect used to break the exact-equality match and orphan the session.
function normUrl(u) {
  try {
    var x = new URL(u);
    return (x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname).replace(/\/+$/, '');
  } catch (e) { return String(u || '').split('?')[0].replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, ''); }
}
var PENDING_APPLY_TTL_MS = 10 * 60 * 1000;

// Match a tab URL against pendingApplyUrls: exact normalized key first, else a same-host entry
// whose path is a '/'-boundary prefix of the tab's path (or vice versa). Custom-domain postings
// (Stripe: /jobs/listing/x/123 -> /jobs/listing/x/123/apply) change pathname between the listing
// and the real form, which exact matching can never bind. Same-host-prefix is strictly narrower
// than what an explicit session may already follow via redirects, so this loosens nothing safety-
// relevant. Returns { key, entry } or null.
function findPendingMatch(pending, url) {
  var key = normUrl(url);
  var now = Date.now();
  var live = function (k) { return pending[k] && now - (pending[k].ts || 0) <= PENDING_APPLY_TTL_MS; };
  if (live(key)) return { key: key, entry: pending[key] };
  var host = key.split('/')[0];
  var ks = Object.keys(pending);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    if (!live(k) || k.split('/')[0] !== host) continue;
    if (key.indexOf(k + '/') === 0 || k.indexOf(key + '/') === 0) return { key: k, entry: pending[k] };
  }
  return null;
}

// Injected into an aggregator landing page (Adzuna/Indeed/etc.) during an explicit apply session:
// dismiss the email-capture modal and click through to the employer's application. The pop-up/button
// can appear a beat after load (or after the first interaction), so POLL for ~12s and click as soon
// as a matching control shows up — clicking "…take me to the job" / "Apply" navigates to the
// employer, at which point this page unloads and the engine takes over there. Best-effort.
function skipAggregatorInterstitial() {
  try {
    // Adzuna login/authenticate wall — a logged-out user can't get through it, and clicking "Apply"
    // just reopens the login modal. Don't fight it (the backend resolves Adzuna links to the employer
    // up front, so this only appears for the rare unresolved row). Bail rather than spam clicks.
    if (/adzuna\./i.test(location.hostname) && /\/authenticate|after_login=|interstitial=/i.test(location.href) &&
        /log ?in|sign ?in|password/i.test((document.body && document.body.innerText) || '')) return;
    var PROCEED = [/take me to the job/i, /apply (for|on) /i, /apply for (this )?job/i, /^apply now$/i, /^apply$/i, /continue to (apply|application|job)/i, /view (the )?job/i, /go to (the )?job/i];
    var DISMISS = [/^no,?\s*thanks/i, /^skip( for now)?$/i, /not now/i, /maybe later/i, /^close$/i, /^dismiss$/i, /×/];
    var clickByText = function (patterns) {
      var els = document.querySelectorAll('a,button,[role="button"],input[type="submit"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el.offsetParent && el.tagName !== 'A') continue; // visible only
        var t = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        if (!t || t.length > 60) continue;
        for (var r = 0; r < patterns.length; r++) {
          if (patterns[r].test(t)) { try { el.click(); return true; } catch (e) {} }
        }
      }
      return false;
    };
    var tries = 0;
    (function attempt() {
      tries++;
      // Dismiss any email/interstitial modal FIRST (the "Apply" button is often behind it and a
      // no-op while it's open), THEN click through to the employer application on the next tick.
      clickByText(DISMISS);
      clickByText(PROCEED);
      if (tries < 12) setTimeout(attempt, 1000); // poll ~12s; page nav ends this when it works
    })();
  } catch (e) {}
}

// Single shared decision used by every place that's about to act on a tab's explicit-session host:
// aggregator/lead-gen domain -> click through, never fill; anything else -> inject autofill.js.
// Duplicated inline in three places before this existed (onUpdated, onHistoryStateUpdated, and the
// WEBAPP_APPLY race-recovery check below) is exactly how the AGGREGATOR_HOST_RE check went missing
// from onHistoryStateUpdated for as long as it did -- one shared function means a future new call
// site can't repeat that mistake.
// Injected into an aggregator page ONLY when the click-through below verifiably failed: tells the
// human where things stand instead of leaving a silently stalled tab.
function showAggregatorStuckBanner() {
  try {
    var el = document.getElementById('alicia-apply-banner') || document.createElement('div');
    el.id = 'alicia-apply-banner';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:10px 16px;border-radius:8px;color:#fff;font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:340px;cursor:pointer;background:#e0a800;';
    el.title = 'Click to dismiss';
    el.onclick = function () { el.remove(); };
    el.textContent = 'Alicia couldn’t get past this job-board page automatically — please click through to the employer’s application yourself and she’ll take it from there.';
    (document.body || document.documentElement).appendChild(el);
  } catch (e) {}
}

// How long the click-through gets before we check whether it actually worked: its own poll runs
// ~12s (see skipAggregatorInterstitial), so checking at 15s is after it has fully given up.
var AGGREGATOR_CLICKTHROUGH_CHECK_MS = 15000;

function routeAggregatorOrInject(tabId, s, host, label) {
  if (s.explicit && AGGREGATOR_HOST_RE.test(host)) {
    console.log('[Alicia][apply-debug] ' + label + ': tab', tabId, 'host', host, 'matched AGGREGATOR_HOST_RE — clicking through instead of injecting autofill.js');
    chrome.scripting.executeScript({ target: { tabId: tabId }, func: skipAggregatorInterstitial }).catch(function () {});
    // Closed-loop confirmation, exactly ONCE per routing decision (no retry loop): if the tab is
    // still parked on an aggregator host after the click-through's entire poll window, it verifiably
    // failed -- surface that on the page and in the side panel instead of leaving a stalled tab the
    // user has to notice on their own. A successful click-through navigates the tab off-host, which
    // makes this check a silent no-op (as does the user closing the tab: tabs.get errors, no-op).
    setTimeout(function () {
      chrome.tabs.get(tabId, function (t) {
        if (chrome.runtime.lastError || !t || !t.url) return;
        var h2 = ''; try { h2 = new URL(t.url).hostname; } catch (e) { return; }
        if (!AGGREGATOR_HOST_RE.test(h2)) return; // it worked — tab moved on to the employer
        console.log('[Alicia][apply-debug] ' + label + ': tab', tabId, 'STILL on aggregator host', h2, 'after click-through window — reporting stuck');
        chrome.scripting.executeScript({ target: { tabId: tabId }, func: showAggregatorStuckBanner }).catch(function () {});
        try { chrome.runtime.sendMessage({ type: 'UNIVERSAL_FILL_RESULT', result: { filled: 0, status: 'aggregator_stuck', ats: 'generic', aiAnswered: 0, learnedUsed: 0, resumeAttached: 0, eeoFilled: 0, readyButtonText: null, generatedPassword: null } }).catch(function () {}); } catch (e) {}
      });
    }, AGGREGATOR_CLICKTHROUGH_CHECK_MS);
  } else {
    console.log('[Alicia][apply-debug] ' + label + ': tab', tabId, 'injecting autofill.js now (host', host, ')');
    injectAutofillWithTailoredResume(tabId, s);
  }
}

// Cap how many page navigations an explicit (web-app) apply session may follow. Explicit sessions
// deliberately bypass the same-site/known-ATS scoping (redirect chains land anywhere), but without
// a bound the engine would follow that TAB to unrelated sites for the full 20-minute TTL.
var EXPLICIT_SESSION_MAX_NAVS = 10;

// Bind a web-app-registered apply URL to its tab on the FIRST navigation — aggregator/short-link
// postings often 302 before the first 'complete', so matching only the final URL never adopted
// the tab and nothing filled (silently, since APPLY_ACK had already reported ok).
chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.frameId !== 0 || !/^https?:/i.test(details.url || '')) return;
  chrome.storage.local.get(['autofillSessions', 'pendingApplyUrls'], function (data) {
    var sessions = data.autofillSessions || {};
    if (sessions[String(details.tabId)]) { console.log('[Alicia][apply-debug] onBeforeNavigate: tab', details.tabId, 'already has a session — skipping'); return; }
    var pending = data.pendingApplyUrls || {};
    var m = findPendingMatch(pending, details.url);
    console.log('[Alicia][apply-debug] onBeforeNavigate: tab', details.tabId, 'url', details.url, 'normalized key', normUrl(details.url), 'pending keys', Object.keys(pending), 'match?', !!m);
    if (!m) { console.log('[Alicia][apply-debug] onBeforeNavigate: no matching pending entry (or expired) — session NOT created for tab', details.tabId); return; }
    var mHost = '';
    try { mHost = new URL(details.url).hostname; } catch (e) {}
    sessions[String(details.tabId)] = {
      hostname: mHost, startedAt: Date.now(), explicit: true,
      tailoredResume: m.entry.resumeText || '', origUrl: m.key, navs: 0,
    };
    delete pending[m.key];
    console.log('[Alicia][apply-debug] onBeforeNavigate: BOUND explicit session for tab', details.tabId, 'hostname', mHost);
    chrome.storage.local.set({ autofillSessions: sessions, pendingApplyUrls: pending });
  });
});

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (!/^https?:/i.test(tab.url) || /(^|\.)linkedin\.com/i.test(tab.url)) return;
  chrome.storage.local.get(['autofillSessions', 'pendingApplyUrls'], function (data) {
    var sessions = data.autofillSessions || {};
    var pending = data.pendingApplyUrls || {};
    var s = sessions[String(tabId)];
    console.log('[Alicia][apply-debug] onUpdated complete: tab', tabId, 'url', tab.url, 'existing session?', !!s);
    if (!s) {
      // Late adoption fallback (final URL matched, possibly by host+path-prefix, or
      // onBeforeNavigate missed it).
      var m = findPendingMatch(pending, tab.url);
      if (m) {
        var mHost = '';
        try { mHost = new URL(tab.url).hostname; } catch (e) {}
        s = { hostname: mHost, startedAt: Date.now(), explicit: true, tailoredResume: m.entry.resumeText || '', origUrl: m.key, navs: 0 };
        sessions[String(tabId)] = s;
        delete pending[m.key];
        console.log('[Alicia][apply-debug] onUpdated: late-adopted tab', tabId, 'via pending match', m.key);
        chrome.storage.local.set({ autofillSessions: sessions, pendingApplyUrls: pending });
      } else {
        console.log('[Alicia][apply-debug] onUpdated: tab', tabId, 'has no session and no pending match (key would be', normUrl(tab.url), ') — nothing will be injected');
        return;
      }
    }
    if (Date.now() - (s.startedAt || 0) > ATS_SESSION_TTL_MS) {
      console.log('[Alicia][apply-debug] onUpdated: session for tab', tabId, 'expired — dropping');
      delete sessions[String(tabId)];
      chrome.storage.local.set({ autofillSessions: sessions });
      return;
    }
    var host = '';
    try { host = new URL(tab.url).hostname; } catch (e) {}
    var sameSite = host && s.hostname && baseDomain(host) === baseDomain(s.hostname);
    // Explicit web-app applies act on ANY employer page they land on (the user chose this job) —
    // but only for a bounded number of navigations; manual/auto-detect sessions stay scoped to
    // same-site or the known-ATS allowlist.
    if (s.explicit) {
      s.navs = (s.navs || 0) + 1;
      if (s.navs > EXPLICIT_SESSION_MAX_NAVS && !sameSite && !ATS_HOST_RE.test(host)) {
        console.log('[Alicia][apply-debug] onUpdated: tab', tabId, 'exceeded nav cap off-site — dropping session');
        delete sessions[String(tabId)];
        chrome.storage.local.set({ autofillSessions: sessions });
        return;
      }
      chrome.storage.local.set({ autofillSessions: sessions });
    } else if (!sameSite && !ATS_HOST_RE.test(host)) {
      console.log('[Alicia][apply-debug] onUpdated: tab', tabId, 'non-explicit session, off-site + unknown ATS — leaving alone');
      return; // user wandered off — leave the page alone
    }
    // On an Adzuna page during an explicit apply: resolve to the employer from the residential IP
    // (Vercel can't — it's IP-blocked) and navigate the tab straight there, skipping Adzuna. One
    // attempt per tab (s.adzunaTried) so a login-wall result can't loop; on failure fall through to
    // the aggregator click-through (which itself bails on the login wall).
    if (s.explicit && /(^|\.)adzuna\./i.test(host) && !s.adzunaTried) {
      s.adzunaTried = true;
      sessions[String(tabId)] = s;
      chrome.storage.local.set({ autofillSessions: sessions });
      resolveAdzunaViaFetch(tab.url).then(function (employer) {
        if (employer) { chrome.tabs.update(tabId, { url: employer }).catch(function () {}); }
        else { chrome.scripting.executeScript({ target: { tabId: tabId }, func: skipAggregatorInterstitial }).catch(function () {}); }
      });
      return;
    }
    setTimeout(function () {
      s.routed = true;
      sessions[String(tabId)] = s;
      chrome.storage.local.set({ autofillSessions: sessions });
      routeAggregatorOrInject(tabId, s, host, 'onUpdated');
    }, 800);
  });
});

// Some ATS platforms (notably ADP Workforce Now career sites) render the actual application form
// inside a same-tab iframe rather than the top-level document — top-frame-only injection then sees
// no recognized form at all and silently does nothing (First/Last/Email/Phone all stay blank, with
// no error). Mirrors injectAtsFrames' existing safe pattern (used for LinkedIn's embedded-ATS case):
// only inject into a child frame whose hostname is the SAME as the top frame's (near-certainly part
// of the same application) or matches a known ATS host — never an arbitrary third-party ad/chat/
// newsletter iframe, since autofill.js's own self-guard (>=3 visible inputs) isn't a strong enough
// filter on its own to make that safe.
function injectIntoRecognizedChildFrames(tabId, topHost) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames || !topHost) return;
  chrome.webNavigation.getAllFrames({ tabId: tabId }, function (frames) {
    if (!frames) return;
    frames.forEach(function (f) {
      if (f.frameId === 0 || !/^https?:/i.test(f.url || '')) return;
      var host = ''; try { host = new URL(f.url).hostname; } catch (e) { return; }
      if (host !== topHost && !ATS_HOST_RE.test(host)) return;
      chrome.scripting.executeScript({ target: { tabId: tabId, frameIds: [f.frameId] }, files: ['autofill.js'] }).catch(function () {});
    });
  });
}

// A one-time child-frame scan at injection time misses ATS forms embedded as an iframe that isn't
// populated with a real src until AFTER a same-page "Apply"/reveal click — confirmed live: Databricks
// embeds its Greenhouse form as <iframe id="grnhse_iframe">, empty/unrecognized at initial injection,
// which left the top-frame instance looping the nav-choice panel forever (it can never find a form
// in ITS OWN document, since the real fields are in a separate document the top frame can't see).
// This listener catches the frame's real navigation (its src actually being set/changed) as it
// happens, and injects immediately — no dependency on WHEN inside the page lifecycle that occurs.
chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId === 0 || !/^https?:/i.test(details.url || '')) return;
  var host = ''; try { host = new URL(details.url).hostname; } catch (e) { return; }
  if (!ATS_HOST_RE.test(host)) return; // only known ATS iframe hosts — never an arbitrary third-party frame
  chrome.storage.local.get('autofillSessions', function (data) {
    var s = (data.autofillSessions || {})[String(details.tabId)];
    if (!s || Date.now() - (s.startedAt || 0) > ATS_SESSION_TTL_MS) return; // no live session for this tab
    console.log('[Alicia][apply-debug] onCommitted: ATS child frame', host, 'appeared in tab', details.tabId, '— injecting');
    var inject = function () {
      chrome.scripting.executeScript({ target: { tabId: details.tabId, frameIds: [details.frameId] }, files: ['autofill.js'] }).catch(function () {});
    };
    if (s.tailoredResume) {
      chrome.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        func: function (t) { window.__aliciaTailoredResume = t; },
        args: [s.tailoredResume],
      }).then(inject, inject);
    } else inject();
  });
});

// Companion to the listener above: when autofill.js's own top-frame retry loop (the nav-choice
// panel, or a plain "still no recognized form here") suspects the real form lives in a child frame
// it can't see, it asks the background script to rescan NOW rather than only relying on the
// onCommitted listener catching a frame src change it may have already missed before injection.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'RESCAN_CHILD_FRAMES' || !sender.tab) return;
  var host = ''; try { host = new URL(sender.tab.url).hostname; } catch (e) { return; }
  injectIntoRecognizedChildFrames(sender.tab.id, host);
});

// Deliver the web app's per-job TAILORED résumé to the engine before it runs — autofill.js prefers
// window.__aliciaTailoredResume over the stored generic resumeText — then inject/re-run autofill.js.
// Clears the side panel Stop button's cooperative halt flag in every frame of a tab. Called on
// every EXPLICIT fill start (panel button, web-app apply, detect.js offer accept) right before
// autofill.js is injected — a Stop stays in force until the human deliberately starts a new fill,
// and nothing automatic (SPA re-inject, mutation rerun) can clear it, because those paths only
// run while a session is live and Stop deletes all sessions.
function clearStopFlag(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    // Also clear any leftover preview flag: window persists across injections on the same page, so
    // a "Preview Fill" followed by a REAL fill on the same tab would otherwise silently run the
    // real fill in preview mode (nothing written) — the inverse of preview's own safety promise.
    func: function () { window.__aliciaStopRequested = false; window.__aliciaPreviewMode = false; },
  }).catch(function () {});
}

// Side panel "Stop Autofill" pressed: interrupt any in-progress run immediately. Sets the halt
// flag in every frame of every tab with a live autofill session (plus the active tab, in case its
// session already expired), dispatches the stop event so autofill.js can tear down its timers and
// show feedback, deletes ALL sessions so no navigation/SPA event re-injects, and halts a running
// Easy Apply queue between items too.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'STOP_AUTOFILL') return;
  console.log('[Alicia][apply-debug] STOP_AUTOFILL received at', new Date().toISOString());
  chrome.storage.local.get('autofillSessions', function (data) {
    var ids = Object.keys(data.autofillSessions || {}).map(function (k) { return parseInt(k, 10); }).filter(function (n) { return !isNaN(n); });
    chrome.tabs.query({ active: true }, function (tabs) {
      (tabs || []).forEach(function (t) { if (t && t.id && ids.indexOf(t.id) === -1) ids.push(t.id); });
      ids.forEach(function (tabId) {
        chrome.scripting.executeScript({
          target: { tabId: tabId, allFrames: true },
          func: function () {
            window.__aliciaStopRequested = true;
            try { window.dispatchEvent(new Event('alicia-stop-autofill')); } catch (e) {}
          },
        }).catch(function () {}); // chrome:// / extension pages can't be scripted — fine, nothing runs there
      });
      chrome.storage.local.set({ autofillSessions: {}, queueActive: false, queuePaused: false }, function () {
        try { sendResponse({ ok: true, stopped: ids.length }); } catch (e) {}
      });
    });
  });
  return true; // async sendResponse
});

function injectAutofillWithTailoredResume(tabId, s) {
  var inject = function () {
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['autofill.js'] }).catch(function () {});
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab || !tab.url) return;
      var host = ''; try { host = new URL(tab.url).hostname; } catch (e) { return; }
      injectIntoRecognizedChildFrames(tabId, host);
    });
  };
  var afterClear = function () {
    if (s && s.tailoredResume) {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function (t) { window.__aliciaTailoredResume = t; },
        args: [s.tailoredResume],
      }).then(inject, inject);
    } else {
      inject();
    }
  };
  // Only reached while a session is live (Stop deletes all sessions), so clearing is always safe.
  clearStopFlag(tabId).then(afterClear, afterClear);
}

// Client-side ("SPA") route changes — e.g. clicking "Apply Manually" inside Workday, or "I'm
// interested" in Zoho Recruit — swap the page's content via history.pushState with NO full page
// navigation. chrome.webNavigation.onCompleted / chrome.tabs.onUpdated never fire for these, so
// without this listener autofill.js runs once on the FIRST load of an ATS site and then goes
// permanently silent for every subsequent in-app step (account creation, the real application
// form, ...) — exactly the "it works on the first page, then nothing happens" pattern on modern
// SPA-based ATS platforms (Workday, Zoho Recruit, Oracle Cloud, ...). This generalizes the
// LinkedIn-only version above to any tab with a live autofill session. Re-injection is a safe
// no-op if the script is already alive in that frame — see the run-once guard at the top of
// autofill.js, which just re-invokes the existing run function instead of re-declaring anything.
chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  if (details.frameId !== 0 || /(^|\.)linkedin\.com/i.test(details.url || '')) return; // LinkedIn handled above
  console.log('[Alicia][apply-debug] onHistoryStateUpdated (SPA nav): tab', details.tabId, 'new url', details.url);
  chrome.storage.local.get('autofillSessions', function (data) {
    var s = (data.autofillSessions || {})[String(details.tabId)];
    if (!s || Date.now() - (s.startedAt || 0) > ATS_SESSION_TTL_MS) { console.log('[Alicia][apply-debug] onHistoryStateUpdated: tab', details.tabId, 'has no live session — skipping re-inject'); return; }
    var host = '';
    try { host = new URL(details.url).hostname; } catch (e) {}
    // Mirror the SAME aggregator-host check the full-page-load listener (onUpdated, above) makes
    // before injecting -- this listener fires on client-side (SPA) route changes within the SAME
    // page, which is exactly how aggregator/lead-gen funnels advance between steps (a "leave your
    // email" popup appearing, a "how can we contact you" step rendering) without a real navigation.
    // Without this check, autofill.js got re-injected on those funnel steps regardless of host,
    // filling real name/email/phone into a job-board's own lead-gen form instead of recognizing it
    // as an aggregator page to click through -- confirmed live on jooble.org and lensa.com.
    setTimeout(function () {
      s.routed = true;
      var sessions = data.autofillSessions || {};
      sessions[String(details.tabId)] = s;
      chrome.storage.local.set({ autofillSessions: sessions });
      routeAggregatorOrInject(details.tabId, s, host, 'onHistoryStateUpdated (SPA nav)');
    }, 500); // let the SPA render the new view first
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

// A new tab opened FROM an explicit apply-session tab inherits that session. Aggregators
// (jobgether/Adzuna/etc.) routinely open the real employer application in a NEW tab — which had no
// session, so the engine never ran there and "nothing happened". The child tab now continues the
// same session (tailored résumé + status reporting included), so autofill.js runs on the real form.
chrome.tabs.onCreated.addListener(function (tab) {
  if (!tab || !tab.id || !tab.openerTabId) return;
  chrome.storage.local.get('autofillSessions', function (data) {
    var sessions = data.autofillSessions || {};
    var parent = sessions[String(tab.openerTabId)];
    if (!parent || !parent.explicit) return;
    if (Date.now() - (parent.startedAt || 0) > ATS_SESSION_TTL_MS) return;
    if (sessions[String(tab.id)]) return;
    sessions[String(tab.id)] = {
      hostname: '', startedAt: parent.startedAt, explicit: true,
      tailoredResume: parent.tailoredResume || '', origUrl: parent.origUrl || '',
      navs: 0, inherited: true,
    };
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

function maybeOfferAutofill(tabId, url) {
  if (!url || !/^https?:/i.test(url) || /(^|\.)linkedin\.com/i.test(url)) return;
  var host = '';
  try { host = new URL(url).hostname; } catch (e) { return; }
  if (!ATS_HOST_RE.test(host)) return;
  var dismissedAt = atsOfferDismissed[host];
  if (dismissedAt && Date.now() - dismissedAt < OFFER_DISMISS_TTL_MS) return;
  // Re-check for an active explicit session right before actually injecting, not just once up
  // front. The OTHER onUpdated listener above (the real apply-session handler) does its OWN
  // independent, unsynchronized storage read on this SAME 'complete' event and may still be
  // writing its session (its own late-adoption fallback + 800ms injection delay) at the moment
  // THIS listener's first read runs — a genuine time-of-check-to-time-of-use race. Observed live:
  // fields got filled by a real active session AND this passive offer still popped up regardless.
  // Waiting out this listener's own delay before reading storage gives the other listener's write
  // time to land first.
  setTimeout(function () {
    chrome.storage.local.get('autofillSessions', function (data) {
      var s = (data.autofillSessions || {})[String(tabId)];
      if (s && Date.now() - (s.startedAt || 0) < ATS_SESSION_TTL_MS) return; // autofill.js already owns this tab
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['detect.js'] }).catch(function () {});
    });
  }, 1200);
}

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== 'complete' || !tab) return;
  maybeOfferAutofill(tabId, tab.url);
});

// Some ATS hosts (confirmed on ADP Workforce Now: the listing and the specific job/application view
// are the SAME URL path, differentiated only by a query param the app updates via history.pushState)
// never fire a SECOND 'complete' event once the real application form loads — chrome.tabs.onUpdated
// only saw the FIRST, pre-form load, so the offer above either never fired or fired too early and
// found nothing to detect, then went silent forever (the total-stall pattern reported live). The
// active-session re-injection listener above already re-fires on this exact event for tabs WITH a
// session; mirror that here for tabs WITHOUT one yet, so the offer gets a second chance once the
// real form's URL/query params land.
chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  if (details.frameId !== 0) return;
  maybeOfferAutofill(details.tabId, details.url);
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
        var go = function () {
          chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['autofill.js'] }).catch(function () {});
          injectIntoRecognizedChildFrames(tab.id, host);
        };
        clearStopFlag(tab.id).then(go, go); // explicit human accept — a prior Stop no longer applies
      });
    });
  }
  if (message.type === 'ATS_OFFER_DISMISS' && message.host) {
    atsOfferDismissed[message.host] = Date.now();
  }
});

// ===== Web-app handoff (Wagner-GPT "Jobs" tab -> auto-apply) =====
// bridge.js (content script on the Wagner-GPT origin) relays the web app's "apply to these jobs"
// request here. THE EXTENSION opens each posting tab itself via chrome.tabs.create — not the web
// app via window.open — and binds the explicit session to the exact returned tab.id in the SAME
// callback. This replaces the earlier URL-matching design (register a pending URL, hope a
// navigation-event listener matches it before/after the tab exists) which raced the web app's own
// window.open and lost on custom-domain postings with no redirect to retry on (confirmed live:
// Stripe and Databricks both got zero autofill activity even after the v1.13.35 registration-order
// + tab-adoption fix). chrome.tabs.create from a privileged extension background context is NOT
// subject to popup-blocking the way page-JS window.open is, so the web app no longer needs to open
// the tab itself for this path — see aliciaBridge.js's corresponding change. `pendingApplyUrls` /
// `findPendingMatch` are kept as a fallback for any tab that navigates to a matching URL through
// some other path (e.g. a redirect chain), but are no longer load-bearing for the common case.
// Binding a job's session is a read-modify-write on the SHARED autofillSessions map: read the
// whole map, add this tab's entry, write the whole map back. Doing that independently per job (as
// this used to) races every OTHER job in the SAME batch -- WEBAPP_APPLY's whole purpose is to open
// several postings at once, and chrome.tabs.create's callbacks for a multi-job batch fire in quick
// succession, so job B's read routinely lands before job A's write completes; job B's write then
// overwrites storage with a map that never included job A's session at all (lost update), exactly
// as if job A's session had never been bound. Same race family as the tabs.create-vs-onUpdated race
// fixed above, just between siblings instead of against a browser event. Fixed by running every
// job's read-modify-write (including its own race-recovery sub-check) through ONE serialized
// promise chain, so only one job's storage critical section is ever in flight at a time -- tab
// creation itself stays fully concurrent (unaffected), only the shared-map mutation is queued.
// MODULE-scoped (not per-message) on purpose: a per-message chain still let two near-simultaneous
// WEBAPP_APPLY batches race EACH OTHER with the identical lost-update -- one shared chain
// serializes binds across batches too. (A worker restart between batches resets the chain, but a
// restarted worker has no in-flight binds to race against, so that's inherently safe.)
var sessionBindChain = Promise.resolve();

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'WEBAPP_APPLY') return;
  var requested = Array.isArray(message.jobs) ? message.jobs.length : 0;
  var jobs = Array.isArray(message.jobs) ? message.jobs.slice(0, 10) : [];
  jobs = jobs.filter(function (j) { return j && j.url && /^https?:/i.test(j.url); });
  console.log('[Alicia][apply-debug] WEBAPP_APPLY: opening', jobs.length, 'tab(s) directly:', jobs.map(function (j) { return j && j.url; }));
  var opened = [];
  var remaining = jobs.length;
  if (!remaining) { try { sendResponse({ ok: true, count: 0, requested: requested, tabIds: [] }); } catch (e) {} return; }
  function bindWebappApplySession(tabId, host, j) {
    sessionBindChain = sessionBindChain.then(function () {
      return new Promise(function (resolveBind) {
        chrome.storage.local.get('autofillSessions', function (data) {
          var sessions = data.autofillSessions || {};
          sessions[String(tabId)] = {
            hostname: host, startedAt: Date.now(), explicit: true,
            tailoredResume: j.resumeText || '', origUrl: normUrl(j.url), navs: 0,
          };
          console.log('[Alicia][apply-debug] WEBAPP_APPLY: bound explicit session directly to new tab', tabId, 'for', j.url);
          chrome.storage.local.set({ autofillSessions: sessions }, function () {
            // chrome.tabs.onUpdated's 'complete' event for this SAME tab can fire before this async
            // session write lands (tab creation + storage round-trip race) -- confirmed live: an
            // aggregator page's popup just sat there un-clicked because onUpdated ran, found no
            // session yet, and gave up, with no later page-load event to retry on. If the tab has
            // ALREADY reached 'complete' by the time this write finishes, onUpdated already ran and
            // did nothing for it -- recover by routing it here, once, guarded by s.routed so a WON
            // race (onUpdated already handled it normally) never double-injects.
            chrome.tabs.get(tabId, function (t) {
              if (chrome.runtime.lastError || !t || t.status !== 'complete') { resolveBind(); return; }
              chrome.storage.local.get('autofillSessions', function (data2) {
                var sessions2 = data2.autofillSessions || {};
                var s2 = sessions2[String(tabId)];
                if (!s2 || s2.routed) { resolveBind(); return; } // already handled normally -- avoid double-injecting
                s2.routed = true;
                sessions2[String(tabId)] = s2;
                chrome.storage.local.set({ autofillSessions: sessions2 }, function () {
                  console.log('[Alicia][apply-debug] WEBAPP_APPLY: tab', tabId, 'was already complete when its session landed — race-recovery routing now');
                  routeAggregatorOrInject(tabId, s2, host, 'WEBAPP_APPLY race-recovery');
                  resolveBind();
                });
              });
            });
          });
        });
      });
    });
  }
  jobs.forEach(function (j) {
    chrome.tabs.create({ url: j.url, active: opened.length === 0 }, function (tab) {
      remaining--;
      if (chrome.runtime.lastError || !tab || !tab.id) {
        console.log('[Alicia][apply-debug] WEBAPP_APPLY: tabs.create failed for', j.url, chrome.runtime.lastError && chrome.runtime.lastError.message);
      } else {
        opened.push(tab.id);
        var host = ''; try { host = new URL(j.url).hostname; } catch (e) {}
        bindWebappApplySession(tab.id, host, j);
      }
      if (remaining === 0) { try { sendResponse({ ok: true, count: opened.length, requested: requested, tabIds: opened }); } catch (e) {} }
    });
  });
  return true; // async sendResponse
});

// NOTE: `adoptOpenTabsForPending` used to live here — registration-time adoption of already-open
// tabs matching a pendingApplyUrls entry, from the era when the WEB APP opened posting tabs itself
// and the extension had to catch up. Deleted (2026-07-13, dead code): it was never called from
// anywhere, and nothing writes new entries into `pendingApplyUrls` anymore — WEBAPP_APPLY opens
// tabs via chrome.tabs.create and binds each session directly in the create callback, so there is
// never a pending entry for it to adopt. It also hand-rolled its own inline aggregator-host check
// instead of using routeAggregatorOrInject — exactly the duplicated-host-logic drift that caused
// the v1.13.45 data-leak bug — so keeping it around as dead code was a standing hazard for anyone
// reviving it by copy-paste. The remaining pendingApplyUrls READS in onBeforeNavigate/onUpdated are
// likewise producer-less and inert, left in place as harmless fallbacks pending a wider cleanup.

// ===== Web-app sync (Wagner-GPT is the source of truth for the résumé/profile) =====
// The Jobs tab pushes its active (or tailored) résumé + contact profile through bridge.js; store
// them under the same keys the fill engines already read, so the extension always fills with
// what the web app currently has — no more split-brain between the two résumé stores.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'WEBAPP_SYNC' || !message.data) return;
  var d = message.data;
  var updates = {};
  if (typeof d.resumeText === 'string' && d.resumeText.trim().length > 40) updates.resumeText = d.resumeText;
  if (d.resumeFile && d.resumeFile.b64 && d.resumeFile.name) {
    updates.resumeFile = { name: d.resumeFile.name, type: d.resumeFile.type || 'application/pdf', b64: d.resumeFile.b64 };
  }
  chrome.storage.local.get('profile', function (cur) {
    if (d.profile && typeof d.profile === 'object' && Object.keys(d.profile).length) {
      var merged = cur.profile || {};
      Object.keys(d.profile).forEach(function (k) { if (d.profile[k]) merged[k] = d.profile[k]; });
      updates.profile = merged;
    }
    if (Object.keys(updates).length) chrome.storage.local.set(updates);
    try { sendResponse({ ok: true, synced: Object.keys(updates) }); } catch (e) {}
  });
  return true; // async sendResponse
});

// ===== Fill-status feedback to the web app =====
// autofill.js reports UNIVERSAL_FILL_RESULT after each pass (to the side panel); ALSO forward it
// to any open Wagner-GPT tab so the Jobs tracker can show live application state (filled / needs
// input / ready to submit) instead of going dark after the handoff.
chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message || message.type !== 'UNIVERSAL_FILL_RESULT' || !sender || !sender.tab) return;
  var tabId = sender.tab.id;
  chrome.storage.local.get('autofillSessions', function (data) {
    var sessions = data.autofillSessions || {};
    var s = sessions[String(tabId)];
    var payload = {
      result: message.result || {},
      url: sender.tab.url || '',
      origUrl: (s && s.origUrl) || '',
      explicit: !!(s && s.explicit),
    };
    // The application reached its final screen — the human submits from here, so stop following
    // this tab around (an explicit session used to shadow the tab for the full 20-minute TTL).
    if (s && s.explicit && message.result && message.result.status === 'ready_to_submit') {
      delete sessions[String(tabId)];
      chrome.storage.local.set({ autofillSessions: sessions });
    }
    chrome.tabs.query({ url: ['https://wagner-gpt.vercel.app/*', 'http://localhost/*'] }, function (tabs) {
      (tabs || []).forEach(function (t) {
        chrome.tabs.sendMessage(t.id, { type: 'ALICIA_STATUS', payload: payload }, function () {
          void chrome.runtime.lastError; // no bridge in that tab — fine
        });
      });
    });
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
      // Inject ONLY into recognized ATS domains. (Any-direct-child was too loose: autofill.js's
      // "self-guard" is just ≥3 visible inputs, and inside e.g. a survey/newsletter iframe it
      // would fill contact info and even generate + save a password.)
      if (!ATS_HOST_RE.test(host)) return;
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
  if (!message || !message.type) return;
  // (JOB_DETECTED needs no relay: the content script's runtime.sendMessage already reaches the
  // side panel directly — re-broadcasting it here made displayJob run twice per detection.)
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
    // Drive the queue in a LinkedIn tab. Grabbing whatever tab was focused used to hijack and
    // navigate an unrelated page if the user started the queue while looking elsewhere.
    chrome.tabs.query({ url: '*://*.linkedin.com/*' }, function (liTabs) {
      var pick = (liTabs || []).find(function (t) { return t.active; }) || (liTabs && liTabs[0]);
      var start = function (tabId) {
        chrome.storage.local.set({
          queueActive: true, queuePaused: false, queueSessionCount: 0, queueStatusMsg: '', queueTabId: tabId
        }, function () { queueOpenNext(); });
      };
      if (pick) { start(pick.id); return; }
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        start((tabs && tabs[0]) ? tabs[0].id : (sender.tab ? sender.tab.id : null));
      });
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