// bridge.js — connects the Wagner-GPT web app (Jobs tab) to this extension.
//
// Injected as a content script on the Wagner-GPT origin (+ localhost during dev). It:
//   1. Announces the extension to the page so the web app can enable hands-off auto-fill:
//        document.documentElement.dataset.aliciaExt = "<version>"
//        window.postMessage({ source:'alicia-ext', type:'PRESENT', version })
//   2. Relays the page's apply request to the background service worker:
//        page -> window.postMessage({ source:'wagner-jobs', type:'ALICIA_APPLY', nonce, jobs, options })
//        -> chrome.runtime.sendMessage({ type:'WEBAPP_APPLY', jobs, options })
//        -> ack back to the page: window.postMessage({ source:'alicia-ext', type:'APPLY_ACK', nonce })
//
// The background worker opens each posting (paced) and starts the normal autofill session, which
// stops before the final Submit — a human always clicks Submit. This script never fills anything.
(function () {
  'use strict';
  var VERSION = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1';

  function announce() {
    try { document.documentElement.dataset.aliciaExt = VERSION; } catch (e) {}
    try { window.postMessage({ source: 'alicia-ext', type: 'PRESENT', version: VERSION }, '*'); } catch (e) {}
  }
  announce();
  // Re-announce shortly after load in case the web app mounts after document_start.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce);
  }
  setTimeout(announce, 800);

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'wagner-jobs') return;
    if (e.data.type === 'ALICIA_PING') { announce(); return; }
    if (e.data.type === 'ALICIA_SYNC') {
      // Web app pushes its résumé/profile into the extension (Wagner-GPT is the source of truth).
      var sNonce = e.data.nonce;
      try {
        chrome.runtime.sendMessage({ type: 'WEBAPP_SYNC', data: e.data.data || {} }, function (resp) {
          var sok = !chrome.runtime.lastError && resp && resp.ok;
          try { window.postMessage({ source: 'alicia-ext', type: 'SYNC_ACK', nonce: sNonce, ok: !!sok, synced: (resp && resp.synced) || [] }, '*'); } catch (e2) {}
        });
      } catch (err) {
        try { window.postMessage({ source: 'alicia-ext', type: 'SYNC_ACK', nonce: sNonce, ok: false }, '*'); } catch (e2) {}
      }
      return;
    }
    if (e.data.type !== 'ALICIA_APPLY') return;
    var nonce = e.data.nonce;
    var jobs = Array.isArray(e.data.jobs) ? e.data.jobs.slice(0, 10) : []; // cap 10 per batch
    try {
      chrome.runtime.sendMessage({ type: 'WEBAPP_APPLY', jobs: jobs, options: e.data.options || {} }, function (resp) {
        // ok=true only if the background worker actually opened+bound at least one tab (so the
        // web app's status is honest, not just "message received").
        var ok = !chrome.runtime.lastError && resp && resp.ok && resp.count > 0;
        try { window.postMessage({ source: 'alicia-ext', type: 'APPLY_ACK', nonce: nonce, ok: !!ok, count: (resp && resp.count) || 0, requested: (resp && resp.requested) || jobs.length, tabIds: (resp && resp.tabIds) || [] }, '*'); } catch (e2) {}
      });
    } catch (err) {
      try { window.postMessage({ source: 'alicia-ext', type: 'APPLY_ACK', nonce: nonce, ok: false, error: String(err) }, '*'); } catch (e2) {}
    }
  });

  // Fill-status feedback: background forwards autofill results here; relay them to the page so
  // the Jobs tracker can show live application state (filled / needs input / ready to submit).
  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== 'ALICIA_STATUS') return;
      try { window.postMessage({ source: 'alicia-ext', type: 'FILL_STATUS', payload: message.payload || {} }, '*'); } catch (e2) {}
    });
  } catch (e) {}
})();
