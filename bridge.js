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
    if (e.data.type !== 'ALICIA_APPLY') return;
    var nonce = e.data.nonce;
    var jobs = Array.isArray(e.data.jobs) ? e.data.jobs.slice(0, 5) : []; // cap 5 per batch
    try {
      chrome.runtime.sendMessage({ type: 'WEBAPP_APPLY', jobs: jobs, options: e.data.options || {} }, function () {
        // Ack regardless of runtime.lastError — the page just needs to know we received it.
        try { window.postMessage({ source: 'alicia-ext', type: 'APPLY_ACK', nonce: nonce }, '*'); } catch (e2) {}
      });
    } catch (err) {
      try { window.postMessage({ source: 'alicia-ext', type: 'APPLY_ACK', nonce: nonce, error: String(err) }, '*'); } catch (e2) {}
    }
  });
})();
