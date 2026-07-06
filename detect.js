// Alicia AI — auto-detect + offer.
// Injected by background.js on known-ATS pages (Workday/Greenhouse/Lever/etc.) when there is NO
// active autofill session for the tab and the host wasn't recently dismissed. It runs a cheap
// "does this page look like an application form?" check and, if so, floats a small prompt asking
// whether Alicia should auto-fill it. Accepting messages background.js, which starts the normal
// autofill session (same mechanism as the side panel's manual button). This script NEVER fills,
// clicks form buttons, or submits anything — it only shows the offer.
(function () {
  'use strict';
  if (window.__aliciaDetectRan) return;
  window.__aliciaDetectRan = true;
  if (/(^|\.)linkedin\.com$/i.test(location.hostname)) return; // content.js owns LinkedIn

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

  function send(msg) { try { chrome.runtime.sendMessage(msg).catch(function () {}); } catch (e) {} }

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
    fill.onclick = function () { box.remove(); send({ type: 'ATS_OFFER_ACCEPT' }); };
    no.onclick = function () { box.remove(); send({ type: 'ATS_OFFER_DISMISS', host: location.hostname }); };
    // Visually auto-dismiss after 30s; not clicking "Not now" means we may offer again later.
    setTimeout(function () { if (box.parentNode) box.remove(); }, 30000);
  }

  // The form may render after initial load (SPA), so poll briefly.
  var tries = 0;
  (function poll() {
    if (hasApplicationForm()) { showOffer(); return; }
    if (++tries > 8) return;
    setTimeout(poll, 500);
  })();
})();
