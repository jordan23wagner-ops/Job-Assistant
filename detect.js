// Alicia AI — auto-detect + offer.
// Injected by background.js on known-ATS pages (Workday/Greenhouse/Lever/etc.) when there is NO
// active autofill session for the tab and the host wasn't recently dismissed. It runs a cheap
// "does this page look like an application form?" check and, if so, floats a small prompt asking
// whether Alicia should auto-fill it. Accepting messages background.js, which starts the normal
// autofill session (same mechanism as the side panel's manual button). This script NEVER fills,
// clicks form buttons, or submits anything — it only shows the offer.
(function () {
  'use strict';
  if (/(^|\.)linkedin\.com$/i.test(location.hostname)) return; // content.js owns LinkedIn
  // A PERMANENT "ran once" guard used to live here — but content scripts survive same-page SPA
  // route changes (no fresh `window`), so once the FIRST load (e.g. an ATS listing page, no form
  // yet) finished its poll and found nothing, every LATER re-injection (background.js re-offers on
  // history.pushState navigation once the real form loads) was an instant no-op. Confirmed live:
  // zero Alicia UI/activity at all after clicking Greenhouse's own in-page "Apply" button, and on
  // ADP. Only guard against a poll that's already in flight or an offer that's already showing —
  // never block a genuinely fresh re-injection from re-scanning the (now different) page.
  if (window.__aliciaDetectPolling || document.getElementById('alicia-detect-offer')) return;

  function visible(el) { return !!el && el.offsetParent !== null; }

  // Same signal autofill.js uses for hasRecognizedForm: a password/file input, or >=3 visible
  // text-ish controls. Keeps us from offering on an ATS careers *listing* page (no form yet).
  function hasApplicationForm() {
    if (document.querySelector('input[type="password"], input[type="file"]')) return true;
    var ctrls = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type]), select, textarea');
    var v = 0;
    for (var i = 0; i < ctrls.length; i++) { if (visible(ctrls[i]) && (v = v + 1) >= 3) return true; }
    return false;
  }

  // Confirmed live: clicking "Auto-fill" produced no observable effect at all — window.__aliciaAutofillRun
  // stayed undefined in the page's own console afterward, meaning autofill.js never actually executed.
  // The old silent .catch(function(){}) swallowed whatever went wrong. Surface any messaging failure
  // to the PAGE console (readable without chrome://extensions access) so it's diagnosable next time.
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        if (chrome.runtime.lastError) console.error('[Alicia] background did not respond:', chrome.runtime.lastError.message, msg);
      });
    } catch (e) { console.error('[Alicia] sendMessage threw:', e); }
  }

  function showOffer() {
    if (document.getElementById('alicia-detect-offer')) return;
    var box = document.createElement('div');
    box.id = 'alicia-detect-offer';
    box.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#1f2430;color:#fff;padding:14px 16px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);font:500 13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;max-width:300px;';
    var msg = document.createElement('div');
    msg.textContent = '⚡ Looks like a job application. Let Alicia auto-fill it?';
    msg.style.marginBottom = '10px';
    box.appendChild(msg);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';
    var fill = document.createElement('button');
    fill.textContent = 'Auto-fill';
    fill.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:8px;padding:8px 10px;font-weight:600;background:#5b8cff;color:#fff;';
    var no = document.createElement('button');
    no.textContent = 'Not now';
    no.style.cssText = 'cursor:pointer;border:0;border-radius:8px;padding:8px 10px;font-weight:600;background:#3a4152;color:#cdd3df;';
    row.appendChild(fill);
    row.appendChild(no);
    box.appendChild(row);
    (document.body || document.documentElement).appendChild(box);
    fill.onclick = function () {
      // Visible feedback that the click registered at all, and a fallback message if autofill.js
      // never actually starts within a few seconds — otherwise a silent failure here looks IDENTICAL
      // to the box just quietly closing, with no signal that anything went wrong.
      msg.textContent = 'Starting…';
      row.style.display = 'none';
      send({ type: 'ATS_OFFER_ACCEPT' });
      setTimeout(function () {
        if (!document.getElementById('alicia-apply-banner')) {
          msg.textContent = '⚠️ Alicia didn’t start — try reloading the page.';
          setTimeout(function () { if (box.parentNode) box.remove(); }, 4000);
        } else if (box.parentNode) { box.remove(); }
      }, 3000);
    };
    no.onclick = function () { box.remove(); send({ type: 'ATS_OFFER_DISMISS', host: location.hostname }); };
    // Visually auto-dismiss after 30s; not clicking "Not now" means we may offer again later.
    setTimeout(function () { if (box.parentNode) box.remove(); }, 30000);
  }

  // The initial poll (form may render moments after load) plus an open-ended MutationObserver watch:
  // some SPA route changes never fire ANY browser navigation event at all (a plain in-memory view
  // swap with no history.pushState) — confirmed live on ADP Workforce Now, zero Alicia activity ever,
  // and this is the SAME documented gap autofill.js's own MutationObserver was built to close (see
  // its comment: "some SPA route changes never call pushState at all... no navigation event fires").
  // background.js's re-injection triggers (tabs.onUpdated, webNavigation.onHistoryStateUpdated) never
  // fire for these, so the OLD fixed 8-try/4s poll-then-give-up permanently missed any form that
  // rendered later — there was no second chance. Watching content directly removes the dependency on
  // any navigation event firing at all. Debounced/rate-floored to bound cost; bounded to 2 minutes
  // total so a tab left open indefinitely doesn't watch forever.
  window.__aliciaDetectPolling = true;
  var settled = false;
  function checkNow() {
    if (settled) return;
    if (hasApplicationForm()) { settled = true; window.__aliciaDetectPolling = false; showOffer(); }
  }
  var tries = 0;
  (function poll() {
    if (settled) return;
    checkNow();
    if (settled || ++tries > 8) return;
    setTimeout(poll, 500);
  })();
  var lastCheckAt = 0, debounceTimer = null, mo = null;
  try {
    mo = new MutationObserver(function () {
      if (settled) { mo.disconnect(); return; }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var now = Date.now();
        if (now - lastCheckAt < 1000) return;
        lastCheckAt = now;
        checkNow();
      }, 400);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  setTimeout(function () {
    settled = true;
    window.__aliciaDetectPolling = false;
    try { if (mo) mo.disconnect(); } catch (e) {}
  }, 120000);
})();
