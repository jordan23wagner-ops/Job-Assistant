// Alicia AI — Universal ATS autofill engine.
// Injected (via chrome.scripting.executeScript files:['autofill.js']) into NON-LinkedIn
// application pages: Workday, Greenhouse, Lever, iCIMS, Ashby, SmartRecruiters, company
// career portals, etc. LinkedIn Easy Apply is handled by content.js instead.
//
// What one run does, in order:
//   1. Reads the saved profile / EEO answers / learned Q&A bank / resume file from storage.
//   2. Fills contact + standard fields, EEO selects/radios/ARIA-comboboxes, password fields
//      (generating + saving a per-site credential when the page wants an account created),
//      and attaches the stored resume file to empty resume/CV file inputs.
//   3. Answers leftover custom questions from the learned bank; anything still unanswered
//      goes to the free Chatwillow backend in ONE batched AI call. Dropdown-style questions
//      (native <select>, ARIA/react-select comboboxes, radios) are always answered by
//      SELECTING an option — never by typing free text into the widget.
//   4. If the AI answered anything, it STOPS and asks the human to review — the click on
//      Next/Continue that the human makes is what confirms + saves those answers to the
//      learned bank (then filling automatically resumes). Questions the AI could NOT answer
//      are asked directly in an on-page panel; saved answers are banked and reused next time.
//   5. Otherwise it advances through the wizard: click Next/Continue (allowlist only),
//      wait for the SPA to settle, re-fill, repeat — stopping the moment a Submit/Apply/
//      Create Account button appears. THAT BUTTON IS NEVER CLICKED. A human always submits.
//
// Real page navigations end this script's life; background.js re-injects it on the next
// page load while the application session (started from the side panel) is active.
(function () {
  'use strict';

  if (window.__aliciaAutofillRun) { window.__aliciaAutofillRun(); return; }
  if (/(^|\.)linkedin\.com$/i.test(location.hostname)) return; // content.js owns LinkedIn

  var BACKEND_URL = 'https://chatwillow.com/api/chat';
  var MAX_STEPS = 20;
  var CUSTOM_QA_MATCH_THRESHOLD = 65;
  var CUSTOM_QA_MAX_PER_STEP = 10;
  var busy = false;

  // ---------- tiny utils ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function getText(el) { return el ? ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()) : ''; }
  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fireClick(el) {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
  }
  function visible(el) { return !!el && el.offsetParent !== null; }

  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function storageGet(keys) {
    return new Promise(function (resolve) {
      if (!extAlive()) { resolve({}); return; }
      try { chrome.storage.local.get(keys, function (d) { resolve(d || {}); }); } catch (e) { resolve({}); }
    });
  }
  function storageSet(obj) {
    if (!extAlive()) return;
    try { chrome.storage.local.set(obj); } catch (e) {}
  }
  function report(result) {
    if (!extAlive()) return;
    try { chrome.runtime.sendMessage({ type: 'UNIVERSAL_FILL_RESULT', result: result }).catch(function () {}); } catch (e) {}
  }

  function showBanner(text, color) {
    var el = document.getElementById('alicia-apply-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'alicia-apply-banner';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:10px 16px;border-radius:8px;color:#fff;font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:340px;cursor:pointer;';
      el.title = 'Click to dismiss';
      el.onclick = function () { el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = text;
    clearTimeout(el.hideTimer);
    el.hideTimer = setTimeout(function () { if (el.parentNode) el.remove(); }, 15000);
  }

  // ---------- ask-the-human panel ----------
  // When a question has no learned answer and the AI couldn't answer it, ASK the human directly in
  // a small on-page panel instead of just hoping they find the field. Dropdown questions get a real
  // <select> of the harvested options, so the answer always commits as a proper selection. Saving
  // applies each answer to the form AND banks it in the learned Q&A store — the next application
  // that asks the same question is answered automatically.
  function removeQuestionPanel() {
    var p = document.getElementById('alicia-question-panel');
    if (p) p.remove();
  }
  function showQuestionPanel(items) {
    removeQuestionPanel();
    var panel = document.createElement('div');
    panel.id = 'alicia-question-panel';
    panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;width:360px;max-height:70vh;overflow:auto;background:#1e1e2e;color:#eee;border-radius:12px;padding:14px 16px;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.45);';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    var title = document.createElement('strong');
    title.style.fontSize = '14px';
    title.textContent = 'Alicia needs ' + items.length + ' answer' + (items.length === 1 ? '' : 's');
    head.appendChild(title);
    var x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Dismiss — fill the fields on the page yourself instead';
    x.style.cssText = 'background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;padding:0 2px;';
    x.onclick = removeQuestionPanel;
    head.appendChild(x);
    panel.appendChild(head);

    var controls = [];
    items.forEach(function (item) {
      var block = document.createElement('div');
      block.style.cssText = 'margin-bottom:10px;';
      var lab = document.createElement('div');
      lab.textContent = item.label.length > 160 ? item.label.slice(0, 157) + '…' : item.label;
      lab.style.cssText = 'margin-bottom:4px;color:#cdd6f4;';
      block.appendChild(lab);
      var ctrl;
      if (item.options && item.options.length) {
        ctrl = document.createElement('select');
        ctrl.style.cssText = 'width:100%;padding:6px;border-radius:6px;border:1px solid #444;background:#2a2a3c;color:#eee;box-sizing:border-box;';
        var ph = document.createElement('option');
        ph.value = ''; ph.textContent = '— choose —';
        ctrl.appendChild(ph);
        item.options.forEach(function (o) {
          var op = document.createElement('option');
          op.value = o; op.textContent = o;
          ctrl.appendChild(op);
        });
      } else {
        ctrl = document.createElement('textarea');
        ctrl.rows = 2;
        ctrl.placeholder = 'Your answer…';
        ctrl.style.cssText = 'width:100%;padding:6px;border-radius:6px;border:1px solid #444;background:#2a2a3c;color:#eee;resize:vertical;box-sizing:border-box;font:inherit;';
      }
      block.appendChild(ctrl);
      panel.appendChild(block);
      controls.push({ item: item, ctrl: ctrl });
    });

    var save = document.createElement('button');
    save.textContent = 'Save answers & continue';
    save.style.cssText = 'width:100%;padding:8px;border:none;border-radius:8px;background:#4caf50;color:#fff;font-weight:600;cursor:pointer;font:inherit;';
    save.onclick = async function () {
      save.disabled = true;
      save.textContent = 'Filling…';
      for (var i = 0; i < controls.length; i++) {
        var v = (controls[i].ctrl.value || '').trim();
        if (!v) continue;
        var item = controls[i].item;
        // Remember FIRST — the human's answer is truth even if applying to this widget fails.
        upsertLearnedAnswer(item.label, v, item.type, item.options);
        try { await applyAnswerToItem(item, v); } catch (e) {}
      }
      removeQuestionPanel();
      showBanner('Answers saved — Alicia will remember them for next time.', '#4caf50');
      setTimeout(function () { window.__aliciaAutofillRun(); }, 800);
    };
    panel.appendChild(save);
    document.body.appendChild(panel);
  }

  // ---------- navigation decision ask-and-remember ----------
  // Some pages BETWEEN the job posting and the application form present ambiguous choices the
  // allowlist can't resolve: aggregator "Did you apply?" modals (jobgether, etc.), multi-button
  // landing pages, consent gates. Rather than stall with "click Apply yourself", surface the
  // prominent clickable options and let the human pick which one moves the application forward —
  // then remember that choice (keyed by host + normalized button text) so the NEXT time we hit the
  // same site we click it automatically. This is the field ask-and-remember, applied to navigation.
  function isInAliciaUi(el) {
    return !!(el.closest && el.closest('#alicia-question-panel, #alicia-apply-banner, #alicia-nav-panel'));
  }
  // Rank a candidate by how likely it moves an application FORWARD (apply/continue high; the
  // aggregator "I applied / engage" engagement buttons low — those are dark-pattern dead-ends).
  function navScore(text) {
    var n = norm(text);
    // Dead-ends FIRST — the aggregator engagement buttons ("I applied…", "I didn't actually
    // apply") contain the word "apply", so they'd otherwise tie the real Apply button.
    if (/i applied|contact hiring|engage later|didn.?t (actually )?apply|try premium|^premium$|sign in|log ?in|review \w/.test(n)) return 1;
    if (/apply now|apply for|apply on|^apply$|^apply .{0,20}$/.test(n)) return 6;
    if (/continue to (apply|application|job)|start application|begin application|proceed|go to (the )?job|view (the )?job|take me to/.test(n)) return 5;
    if (/^continue$|^next$|^start$/.test(n)) return 4;
    if (/\bapply\b/.test(n)) return 3;
    return 2;
  }
  // Buttons on real ATS pages aren't always <button>/<a href> — Oracle Recruiting Cloud, Workday,
  // etc. render "Apply Now" as a styled <a> without href, a role=button div, or a custom component.
  function isClickableEl(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') return true;
    var role = el.getAttribute && el.getAttribute('role');
    if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab') return true;
    if (el.getAttribute && (el.getAttribute('onclick') || el.hasAttribute('jsaction'))) return true;
    if (el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type || '')) return true;
    var cls = el.className;
    cls = String((cls && cls.baseVal !== undefined) ? cls.baseVal : (cls || ''));
    return /\b(btn|button|apply|cta)\b/i.test(cls);
  }
  function nearestClickable(el) {
    var cur = el;
    for (var i = 0; i < 5 && cur && cur !== document.body; i++) {
      if (isClickableEl(cur)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  // Noise that is never the "move the application forward" button — account/nav/legal chrome that
  // clutters (and could mislead) the choice list. Matched as the WHOLE normalized label.
  var NAV_NOISE_RE = /^(close|dismiss|cancel|back|menu|open menu|share|save|like|report|home|go to home page|help|blog|about us|for talent|for companies|privacy statement|terms of use|cookie[a-z ]*|sign out|log out|sign in|log in|manage profile|profile|my profile|account|settings|view more jobs|similar jobs|search jobs|save job|save to favorites)$/;
  // Never offer these as a nav-panel option, regardless of score. Final-submission text
  // (Submit/Finish/Complete Application) should never be clicked by this generic panel — that's
  // the whole point of the app never auto-submitting. Account-creation text (Create Account/Sign
  // Up/Register) is excluded too: clicking it blind, without the dedicated password-generation +
  // agreement-tick groundwork the Workday/account-gate ADAPTERS do first, can submit a signup with
  // an empty password. "Apply"/"Apply Now" are deliberately NOT here — recognizing and clicking
  // those to OPEN an application (never submit one) is this panel's entire purpose.
  var NAV_NEVER_RE = /submit application|submit your application|^submit$|finish application|complete application|create (my |your )?(account|profile)|^sign up$|^register$/i;
  function navCandidates() {
    var out = [], seen = {}, seenEl = [];
    var push = function (el, t) {
      if (!el || !visible(el) || el.disabled || isInAliciaUi(el)) return;
      t = (t || getText(el) || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60) return;
      var key = norm(t);
      if (!key || seen[key] || seenEl.indexOf(el) >= 0 || NAV_NOISE_RE.test(key) || NAV_NEVER_RE.test(key)) return;
      seen[key] = 1; seenEl.push(el);
      out.push({ el: el, text: t, score: navScore(t) });
    };
    // Primary: broad clickable selector (covers custom/styled buttons, not just <button>/<a href>).
    document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick], [class*="btn"], [class*="button"], [class*="apply"], [class*="cta"], [data-automation-id]')
      .forEach(function (el) { push(el); });
    // Backstop: if nothing clearly forward-looking surfaced, sweep leaf-ish elements whose own short
    // text reads like a forward action and resolve each to its nearest clickable ancestor. Catches
    // Apply buttons the selector missed entirely (plain div/span with a click handler).
    if (!out.some(function (c) { return c.score >= 5; })) {
      var all = document.querySelectorAll('div, span, a, p, li, td');
      for (var i = 0; i < all.length && out.length < 40; i++) {
        var e = all[i];
        if (e.children && e.children.length > 2) continue;
        var tx = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (!tx || tx.length > 40) continue;
        if (!/\bapply\b|continue to (apply|application|job)|start application|go to (the )?job|view (the )?job|proceed/i.test(tx)) continue;
        if (/i applied|didn.?t (actually )?apply|engage/i.test(tx)) continue;
        push(nearestClickable(e), tx);
      }
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 8);
  }
  function saveNavChoice(host, text) {
    storageGet('navChoices').then(function (d) {
      var bank = (d && d.navChoices) || {};
      bank[host] = { pattern: norm(text), text: text, savedAt: Date.now() };
      storageSet({ navChoices: bank });
    });
  }
  // If we've learned which button proceeds on this host, click it. Returns whether it clicked.
  async function tryLearnedNavClick() {
    var data = await storageGet('navChoices');
    var rec = (data && data.navChoices || {})[location.hostname];
    if (!rec || !rec.pattern) return false;
    var cands = navCandidates();
    for (var i = 0; i < cands.length; i++) {
      var n = norm(cands[i].text);
      if (n && (n.indexOf(rec.pattern) >= 0 || rec.pattern.indexOf(n) >= 0)) { fireClick(cands[i].el); return true; }
    }
    return false;
  }
  function removeNavPanel() { var p = document.getElementById('alicia-nav-panel'); if (p) p.remove(); }
  function showNavChoicePanel(cands) {
    removeNavPanel();
    var panel = document.createElement('div');
    panel.id = 'alicia-nav-panel';
    panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;width:340px;max-height:70vh;overflow:auto;background:#1e1e2e;color:#eee;border-radius:12px;padding:14px 16px;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.45);';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
    var title = document.createElement('strong');
    title.style.fontSize = '14px';
    title.textContent = 'Which button opens the application?';
    head.appendChild(title);
    var x = document.createElement('button');
    x.textContent = '✕'; x.title = 'Dismiss';
    x.style.cssText = 'background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;padding:0 2px;';
    x.onclick = removeNavPanel;
    head.appendChild(x);
    panel.appendChild(head);
    var hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#9aa;margin-bottom:10px;';
    hint.textContent = "This page is between the listing and the form. Pick the button that moves forward — Alicia will click it here and remember it for " + location.hostname + " next time.";
    panel.appendChild(hint);
    cands.forEach(function (c, i) {
      var b = document.createElement('button');
      b.textContent = String.fromCharCode(97 + i) + ')  ' + c.text;
      b.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:6px;padding:8px 10px;border:1px solid #3a3a4c;border-radius:8px;background:#2a2a3c;color:#eee;cursor:pointer;font:inherit;';
      b.onmouseenter = function () { b.style.background = '#33334a'; };
      b.onmouseleave = function () { b.style.background = '#2a2a3c'; };
      b.onclick = function () {
        saveNavChoice(location.hostname, c.text); // remember FIRST — the click may navigate away
        removeNavPanel();
        showBanner('Opening the application…', '#4caf50');
        try { fireClick(c.el); } catch (e) {}
        setTimeout(function () { window.__aliciaAutofillRun(); }, 2500);
      };
      panel.appendChild(b);
    });
    document.body.appendChild(panel);
  }

  // ---------- label discovery ----------
  function labelText(el) {
    var t = '';
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (l) t = getText(l);
      }
    } catch (e) {}
    if (!t) {
      var lbAttr = el.getAttribute('aria-labelledby');
      if (lbAttr) { var lb = document.getElementById(lbAttr.split(' ')[0]); if (lb) t = getText(lb); }
    }
    if (!t) { var p = el.closest('label'); if (p) t = getText(p); }
    if (!t) {
      var c = el.closest('.form-group,fieldset,li,div,section');
      if (c) { var li = c.querySelector('label,legend'); if (li) t = getText(li); }
    }
    return t;
  }
  function signals(el) {
    return norm([el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('data-automation-id'), labelText(el)].filter(Boolean).join(' '));
  }

  // ---------- answer matching ----------
  function canon(s) {
    var n = norm(s);
    if (/(decline|prefer not|do not wish|dont wish|not to answer|wish not|not to disclose)/.test(n)) return 'declined';
    return n;
  }
  function score(a, b) {
    a = canon(a); b = canon(b); if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 80;
    var at = a.split(' '), bt = b.split(' '), c = 0;
    for (var i = 0; i < bt.length; i++) { if (bt[i].length > 2 && at.indexOf(bt[i]) >= 0) c++; }
    return bt.length ? (c / bt.length) * 60 : 0;
  }

  var QUESTION_STOPWORDS = ['a', 'an', 'the', 'is', 'are', 'do', 'you', 'your', 'of', 'with', 'for', 'to', 'in', 'on', 'and', 'have', 'has', 'this', 'that', 'what', 'how', 'many', 'will', 'would', 'can', 'could', 'please', 'describe', 'did', 'does'];
  function questionContentTokens(s) {
    return norm(s).split(' ').filter(function (w) { return w.length > 2 && QUESTION_STOPWORDS.indexOf(w) === -1; });
  }
  function questionSimilarity(a, b) {
    var na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    if (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0) return 90;
    var at = questionContentTokens(a), bt = questionContentTokens(b);
    if (!at.length || !bt.length) return 0;
    var common = 0;
    at.forEach(function (w) { if (bt.indexOf(w) >= 0) common++; });
    var denom = Math.min(at.length, bt.length);
    return denom ? (common / denom) * 100 : 0;
  }
  function findLearnedAnswer(bank, question) {
    var best = null, bs = 0;
    bank.forEach(function (rec) {
      var sc = questionSimilarity(rec.question, question);
      if (sc > bs) { bs = sc; best = rec; }
    });
    return bs >= CUSTOM_QA_MATCH_THRESHOLD ? best : null;
  }
  function upsertLearnedAnswer(question, answer, fieldType, options) {
    storageGet('customQA').then(function (data) {
      var bank = Array.isArray(data.customQA) ? data.customQA : [];
      var existing = findLearnedAnswer(bank, question);
      if (existing) {
        existing.answer = answer;
        existing.lastUsedAt = Date.now();
      } else {
        bank.push({
          id: 'qa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
          question: question, answer: answer, fieldType: fieldType || 'text',
          options: options || [], createdAt: Date.now(), lastUsedAt: Date.now()
        });
      }
      if (bank.length > 300) bank = bank.slice(bank.length - 300);
      storageSet({ customQA: bank });
    });
  }

  // ---------- backend (NDJSON delta stream, same shape as content.js/sidepanel.js) ----------
  function stripThinkingTags(text) {
    if (!text) return text;
    var cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (/<\/think>/i.test(cleaned)) cleaned = cleaned.replace(/[\s\S]*<\/think>/i, '');
    return cleaned.replace(/<\/?think>/gi, '').trim();
  }
  async function fetchBackendText(sys, user) {
    // Signed-in Chatwillow session (higher daily allowance) if present and fresh;
    // stale/absent just means the anonymous tier. storageGet never throws.
    var headers = { 'Content-Type': 'application/json' };
    var stored = await storageGet(['alicia_session']);
    var session = stored && stored.alicia_session;
    if (session && session.access_token && Date.now() < (session.expires_at || 0) - 60000) {
      headers['Authorization'] = 'Bearer ' + session.access_token;
    }
    var resp = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ messages: [{ role: 'system', content: sys }], newMessage: user, model: 'auto' })
    });
    if (!resp.ok) throw new Error('Backend error: ' + resp.status);
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '', text = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var evt;
        try { evt = JSON.parse(line); } catch (e) { continue; }
        if (evt.delta) text += evt.delta;
        else if (evt.error) throw new Error(evt.error);
      }
    }
    if (buffer.trim()) { try { var fin = JSON.parse(buffer.trim()); if (fin.delta) text += fin.delta; } catch (e) {} }
    return text;
  }
  function parseAnswersJson(raw) {
    var clean = stripThinkingTags(raw).replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    try { var v = JSON.parse(clean); if (Array.isArray(v)) return v; } catch (e) {}
    var m = clean.match(/\[[\s\S]*\]/);
    if (m) { try { var v2 = JSON.parse(m[0]); if (Array.isArray(v2)) return v2; } catch (e2) {} }
    return [];
  }

  // ---------- field matchers ----------
  function buildStdMatchers(profile) {
    var fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    return [
      { v: profile.email,     t: function (s, el) { return el.type === 'email' || /\bemail\b/.test(s); } },
      { v: profile.phone,     t: function (s, el) { return el.type === 'tel' || /\b(phone|mobile|cell|telephone)\b/.test(s); } },
      { v: profile.firstName, t: function (s) { return /\b(given name|first name|firstname|fname|legal first)\b/.test(s); } },
      { v: profile.lastName,  t: function (s) { return /\b(family name|last name|lastname|surname|lname|legal last)\b/.test(s); } },
      { v: profile.linkedin,  t: function (s) { return /linkedin/.test(s); } },
      { v: profile.website,   t: function (s) { return /\b(website|portfolio|personal site)\b/.test(s); } },
      { v: profile.city,      t: function (s) { return /\b(address level2|city|town)\b/.test(s); } },
      { v: profile.state,     t: function (s) { return /\b(address level1|state|province|region)\b/.test(s); } },
      { v: profile.zip,       t: function (s) { return /\b(postal code|postcode|zip)\b/.test(s); } },
      { v: fullName,          t: function (s) { return /\bfull name\b/.test(s) || (/\bname\b/.test(s) && !/first|last|given|family|user|company|file|nick|middle|legal/.test(s)); } }
    ];
  }
  function isKnownContactField(s, el) {
    var elObj = el || {};
    return buildStdMatchers({ firstName: 'x', lastName: 'x', email: 'x', phone: 'x', linkedin: 'x', website: 'x', city: 'x', state: 'x', zip: 'x' })
      .some(function (m) { return m.t(s, elObj); });
  }
  var EEO = [
    { key: 'eeo-sponsorship',   pats: [/sponsor/, /visa status/] },
    { key: 'eeo-authorization', pats: [/authoriz/, /legally (authorized|eligible|entitled)/, /right to work/, /eligible to work/] },
    { key: 'eeo-gender',        pats: [/\bgender\b/, /\bsex\b/] },
    { key: 'eeo-race',          pats: [/\brace\b/, /ethnic/] },
    { key: 'eeo-veteran',       pats: [/veteran/] },
    { key: 'eeo-disability',    pats: [/disabilit/, /\bdisabled\b/] }
  ];
  function eeoKey(s) {
    if (/sponsor/.test(s)) return 'eeo-sponsorship'; // sponsorship wins when a label mentions both
    for (var i = 0; i < EEO.length; i++) {
      for (var p = 0; p < EEO[i].pats.length; p++) { if (EEO[i].pats[p].test(s)) return EEO[i].key; }
    }
    return null;
  }
  // A CAPTCHA must NEVER reach the custom-question AI-answer pipeline — a text-only backend call
  // has no way to actually read the challenge, and asking it anyway risks it answering with some
  // plausible-looking text (observed: "No image provided." — an honest disclaimer from the model,
  // but our code had no way to recognize that as "couldn't answer" and typed it into the field
  // like a real answer). CAPTCHA fields are excluded exactly like EEO/contact fields — never
  // discovered as a question at all, so they can only ever reach the human via the ask panel.
  function looksLikeCaptcha(label, container) {
    var n = norm(label || '');
    if (/captcha|verify (that )?you.?re? (a )?human|i.?m not a robot|security check|security code|verification code|confirmation code|prove (that )?you.?re? human|type the (text|characters|code) (you see|shown|above|below)|enter the code (shown|above|below)|are you (a )?human|are you a robot|anti.?spam|bot check|human (check|verification)|prove you.?re? not a robot|solve (the )?(following|this|below)|type what you see/.test(n)) return true;
    // A simple arithmetic challenge ("3 + 5 = ?", "What is 4 x 2?") has no "captcha" wording at all —
    // catch it by shape instead, checking the RAW label (norm() strips +/=/? entirely, so the check
    // has to run before that normalization). A short label with an explicit operator AND "=" or "?"
    // is not something a real job-application question ever looks like.
    if (label && label.length <= 40 && /\d\s*[+\-×x]\s*\d.{0,10}(=|\?)/i.test(label)) return true;
    if (container && container.querySelector && container.querySelector('img[alt*="captcha" i], img[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="recaptcha" i], [class*="hcaptcha" i]')) return true;
    return false;
  }
  // Second, content-based safety net independent of label wording: if the AI-answer backend hands
  // back something that reads like "I couldn't actually answer this" (observed twice now, in two
  // different literal forms — "No image provided." and "N/A" — both from a CAPTCHA-style challenge
  // looksLikeCaptcha's label/DOM check didn't catch), never type that in as if it were a real answer.
  // Leaving the field empty routes it into the existing needHuman/ask-panel path instead.
  function looksLikeRefusalAnswer(ans) {
    var n = norm(ans);
    if (!n || n.length > 60) return false;
    var img = '( (the |an? |any )?image)?';
    return new RegExp('^(n ?a|not applicable|no image( provided| was provided)?|no image available|' +
      'unable to (view|see|access|answer)' + img + '|cannot (see|view|access)' + img + '|can ?t (see|view|access)' + img + '|' +
      'i (do not|don.?t|cannot|can.?t) (have|see|view|access)' + img + '|no access to (an? )?image|i.?m unable to (see|view|access)' + img + ')$').test(n);
  }
  function generatePassword() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    var arr = new Uint32Array(16);
    crypto.getRandomValues(arr);
    var pw = '';
    for (var i = 0; i < arr.length; i++) pw += chars[arr[i] % chars.length];
    return pw;
  }

  // ---------- fill passes ----------
  function fillStdFields(profile) {
    var STD = buildStdMatchers(profile);
    var filled = 0;
    var inputs = document.querySelectorAll('input, textarea');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var ty = (el.type || '').toLowerCase();
      if (['hidden', 'password', 'file', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'search'].indexOf(ty) >= 0) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.value && el.value.trim()) continue;
      if (!visible(el)) continue;
      if (isComboControl(el)) continue; // dropdown widgets are SELECTED (fillStdCombos), never typed into
      var s = signals(el);
      if (!s) continue;
      for (var f = 0; f < STD.length; f++) {
        if (STD[f].v && STD[f].t(s, el)) { setNativeValue(el, STD[f].v); fire(el); filled++; break; }
      }
    }
    return filled;
  }

  function fillPasswordFields(profile, siteCredentials, state) {
    var pwFields = Array.prototype.filter.call(document.querySelectorAll('input[type="password"]'), function (p) {
      return visible(p) && !p.value;
    });
    if (!pwFields.length) return 0;
    var host = location.hostname;
    var cred = siteCredentials[host];
    if (!cred) {
      cred = { email: profile.email || '', password: generatePassword(), createdAt: Date.now() };
      siteCredentials[host] = cred;
      storageSet({ siteCredentials: siteCredentials });
      state.generatedCredential = { hostname: host, email: cred.email, password: cred.password };
    }
    pwFields.forEach(function (pf) { setNativeValue(pf, cred.password); fire(pf); });
    return pwFields.length;
  }

  function fillEeoSelects(eeo) {
    var filled = 0;
    var selects = document.querySelectorAll('select');
    for (var si = 0; si < selects.length; si++) {
      var sel = selects[si];
      var cur = (sel.value || '').toLowerCase();
      if (cur && !/select|choose|--|^$/.test(cur)) continue;
      var key = eeoKey(signals(sel)); if (!key || !eeo[key]) continue;
      var best = null, bs = 0;
      for (var o = 0; o < sel.options.length; o++) {
        var op = sel.options[o]; if (!op.value) continue;
        var sc = Math.max(score(op.textContent, eeo[key]), score(op.value, eeo[key]));
        if (sc > bs) { bs = sc; best = op; }
      }
      if (best && bs >= 45) { sel.value = best.value; fire(sel); filled++; }
    }
    return filled;
  }

  // ---- Standard fields that are DROPDOWNS (e.g. State, Country) ----
  // Some forms make State/Country a <select> or ARIA combobox, not a free-text box. Typing "Texas"
  // there fails validation; the correct move is to SELECT the matching option. These helpers pick the
  // right option (matching a full name OR its abbreviation), and the correctErrors() pass re-runs on
  // the specific fields a form flags invalid after you try to advance.
  var US_STATES = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
    connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
    illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
    maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
    missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
    oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
    washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC'
  };
  var US_ABBR = {}; (function () { for (var k in US_STATES) US_ABBR[US_STATES[k]] = k; })();
  function titleCase(s) { return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function stateVariants(v) {
    var raw = (v || '').trim(); if (!raw) return [];
    var low = raw.toLowerCase(), out = [raw];
    if (US_STATES[low]) out.push(US_STATES[low]);                       // full name -> abbrev
    else if (US_ABBR[raw.toUpperCase()]) out.push(titleCase(US_ABBR[raw.toUpperCase()])); // abbrev -> full name
    return out;
  }
  function countryVariants(v) {
    var raw = (v || 'United States').trim(), low = raw.toLowerCase();
    if (/united states|u\.?s\.?a?|america/.test(low)) return ['United States', 'United States of America', 'USA', 'US'];
    return [raw];
  }
  function selectHasRealValue(sel) {
    if (sel.selectedIndex <= 0 || !sel.value) return false;
    var t = norm(getText(sel.options[sel.selectedIndex] || {}));
    return t !== '' && !/^(select|choose|--|please|pick)/.test(t);
  }
  // Pick the option best matching any of desiredArr (exact case-insensitive match wins outright).
  function pickSelectOption(sel, desiredArr, threshold) {
    var best = null, bs = 0;
    for (var o = 0; o < sel.options.length; o++) {
      var op = sel.options[o]; if (op.value === '' && !getText(op)) continue;
      for (var d = 0; d < desiredArr.length; d++) {
        var want = desiredArr[d]; if (!want) continue;
        var sc = Math.max(score(op.textContent, want), score(op.value, want));
        if (norm(op.textContent) === norm(want) || (op.value && norm(op.value) === norm(want))) sc = 100;
        if (sc > bs) { bs = sc; best = op; }
      }
    }
    if (best && bs >= (threshold || 60)) { sel.value = best.value; fire(sel); return true; }
    return false;
  }
  function stdSelectDesired(sig, profile) {
    if (/\b(address level1|state|province|region)\b/.test(sig) && profile.state) return stateVariants(profile.state);
    if (/\bcountry\b/.test(sig)) return countryVariants(profile.country);
    if (/\b(address level2|city|town)\b/.test(sig) && profile.city) return [profile.city];
    return null;
  }
  // Proactively fill standard <select> dropdowns (State/Country/City) by selecting the option.
  function fillStdSelects(profile) {
    var filled = 0, selects = document.querySelectorAll('select');
    for (var si = 0; si < selects.length; si++) {
      var sel = selects[si];
      if (sel.disabled || !visible(sel) || selectHasRealValue(sel)) continue;
      var desired = stdSelectDesired(signals(sel), profile);
      if (desired && desired.length && pickSelectOption(sel, desired, 65)) filled++;
    }
    return filled;
  }
  // After a form flags fields invalid (red boxes) on advance, re-select the matching dropdown option
  // for any unset <select> — both standard (State/Country) and EEO — so a mistyped free-text value
  // gets corrected to a proper selection. Returns how many it fixed.
  async function correctErrors(profile, eeo) {
    var n = 0;
    n += fillStdSelects(profile);
    try { n += await fillStdCombos(profile); } catch (e) {}
    n += fillEeoSelects(eeo);
    try { n += await fillEeoComboboxes(eeo); } catch (e) {}
    var flagged = document.querySelectorAll(
      'select[aria-invalid="true"], .error select, .has-error select, .invalid select, [class*="error"] select, [class*="invalid"] select'
    );
    for (var i = 0; i < flagged.length; i++) {
      var sel = flagged[i];
      if (sel.tagName !== 'SELECT' || !visible(sel) || selectHasRealValue(sel)) continue;
      var desired = stdSelectDesired(signals(sel), profile);
      if (!desired) { var key = eeoKey(signals(sel)); if (key && eeo[key]) desired = [eeo[key]]; }
      if (desired && pickSelectOption(sel, desired, 55)) n++;
    }
    return n;
  }

  function radioLabel(r) {
    var w = r.closest('label');
    if (w) return getText(w);
    if (r.id) { var l = document.querySelector('label[for="' + r.id + '"]'); if (l) return getText(l); }
    return r.value || '';
  }
  function radioGroups() {
    var radios = document.querySelectorAll('input[type="radio"]');
    var groups = {};
    for (var ri = 0; ri < radios.length; ri++) {
      var r = radios[ri];
      if (!visible(r) && !visible(r.closest('label'))) continue; // some ATS visually hide the input itself
      var nm = r.name || ('__' + ri);
      (groups[nm] = groups[nm] || []).push(r);
    }
    return groups;
  }
  function groupQuestionLabel(rs) {
    var cont = rs[0].closest('fieldset, .form-group, [role="group"], [role="radiogroup"], div');
    if (!cont) return '';
    var lg = cont.querySelector('legend, label');
    var t = lg ? getText(lg) : '';
    if (!t || rs.some(function (x) { return norm(radioLabel(x)) === norm(t); })) {
      t = (cont.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return t;
  }
  function pickRadio(rs, desired) {
    var best = null, bs = 0;
    rs.forEach(function (x) { var sc = score(radioLabel(x), desired); if (sc > bs) { bs = sc; best = x; } });
    if (best && bs >= 45) {
      if (!best.checked) {
        best.checked = true;
        best.dispatchEvent(new Event('click', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    return false;
  }
  function fillEeoRadios(eeo) {
    var filled = 0;
    var groups = radioGroups();
    Object.keys(groups).forEach(function (nm) {
      var rs = groups[nm];
      if (rs.some(function (x) { return x.checked; })) return;
      var key = eeoKey(norm(groupQuestionLabel(rs)));
      if (!key || !eeo[key]) return;
      if (pickRadio(rs, eeo[key])) filled++;
    });
    return filled;
  }

  // EEO/demographic dropdowns rendered as comboboxes: Workday-style listbox buttons AND
  // react-select inputs (Greenhouse demographic questions — the old pass skipped INPUT triggers,
  // so those were typed into by nothing and left unanswered). Selects the option from saved prefs.
  async function fillEeoComboboxes(eeo) {
    var filled = 0, combos = visibleComboTriggers();
    for (var ti = 0; ti < combos.length; ti++) {
      var c = combos[ti];
      try {
        if (comboValueText(c.trig, c.container)) continue; // already has a real selection
        var tKey = eeoKey(signals(c.trig));
        if (!tKey || !eeo[tKey]) continue;
        if (await selectFromCombobox(c.trig, eeo[tKey])) filled++;
      } catch (e) { /* one odd widget shouldn't abort the rest */ }
    }
    return filled;
  }

  // ---------- generic combobox / react-select support ----------
  // New Greenhouse (job-boards.greenhouse.io) and many modern forms render dropdown questions as
  // react-select comboboxes — an <input role="combobox"> that filters a portaled listbox — NOT a
  // native <select>. Typing an answer into them filters options but never commits a selection, so
  // the form rejects it ("This field is required"). These helpers OPEN the menu and CLICK the
  // matching option instead of typing.
  // A combo control must be SELECTED-from, never typed-into as free text. Detection uses strong
  // signals only: ARIA combobox semantics, readonly menu-trigger inputs, or react-select's specific
  // class shapes. NOTE: a bare [class*="-control"] match is NOT enough — Bootstrap's `form-control`
  // sits on plain text inputs, and misclassifying those made the engine skip real free-text
  // questions entirely (field left blank -> "required" error on advance).
  function isComboControl(el) {
    if (!el || !el.getAttribute) return false;
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return true;
    var ac = el.getAttribute('aria-autocomplete');
    if (ac === 'list' || ac === 'both') return true;
    if (!el.closest || el.closest('select')) return false;
    if (el.closest('[role="combobox"], [aria-haspopup="listbox"]')) return true;
    if (el.tagName === 'INPUT' && el.readOnly && el.closest('[aria-expanded], [class*="dropdown"], [class*="Dropdown"]')) return true;
    var rs = el.closest('[class*="select__control"], [class*="Select-control"], [class*="-control"]');
    if (rs) {
      var cls = String(rs.className || '');
      if (/select__control|Select-control/.test(cls)) return true; // react-select BEM / legacy classes
      // react-select emotion classes look like `css-13cymwt-control`; require a dropdown indicator
      // inside so a random `*-control` styling class on a plain wrapper can't misfire.
      if (/(^|\s)css-[^\s]*-control(\s|$)/.test(cls) && rs.querySelector('[class*="ndicator"], svg')) return true;
    }
    return false;
  }
  function collectMenuOptions() {
    var out = [];
    document.querySelectorAll('[role="option"]').forEach(function (o) { if (visible(o) && o.getAttribute('aria-disabled') !== 'true') out.push(o); });
    if (!out.length) document.querySelectorAll('[role="listbox"] li').forEach(function (o) { if (visible(o)) out.push(o); });
    if (!out.length) document.querySelectorAll('[class*="menu"] [class*="option"], [class*="MenuList"] [class*="option"]').forEach(function (o) { if (visible(o) && o.getAttribute('aria-disabled') !== 'true') out.push(o); });
    return out;
  }
  async function openComboMenu(trig) {
    try { trig.focus(); } catch (e) {}
    fireClick(trig);
    await sleep(280);
    var opts = collectMenuOptions();
    if (!opts.length) { // some react-selects only open on ArrowDown after focus
      trig.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await sleep(240);
      opts = collectMenuOptions();
    }
    return opts;
  }
  function closeComboMenu(trig) {
    try { trig.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); } catch (e) {}
  }
  // Placeholder texts ("Select…", "Choose an option", "Please select", "--") mean NO value yet.
  // The old exact-match test treated "Select an option" as a real value, so those dropdowns were
  // skipped as already-answered and the form errored on advance.
  function isComboPlaceholder(t) {
    var n = norm(t);
    return !n || /^(select|choose|please|pick|search)\b/.test(n) || /^-+$/.test(n.replace(/\s/g, ''));
  }
  function comboValueText(trig, container) {
    var sv = container && container.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"]');
    if (sv && getText(sv)) return getText(sv);
    var t = getText(trig) || trig.value || '';
    return isComboPlaceholder(t) ? '' : t;
  }
  function bestMenuOption(opts, wants) {
    var best = null, bs = 0;
    for (var i = 0; i < opts.length; i++) {
      var opt = opts[i]; if (!visible(opt)) continue;
      var otext = getText(opt);
      for (var w = 0; w < wants.length; w++) {
        var want = wants[w]; if (!want) continue;
        var sc = score(otext, want);
        if (norm(otext) === norm(want)) sc = 100;
        if (sc > bs) { bs = sc; best = opt; }
      }
    }
    return { el: best, score: bs };
  }
  // The typeable input inside/behind a combobox trigger (react-select puts it inside the control).
  function comboTextInput(trig) {
    if (trig.tagName === 'INPUT') return trig;
    if (!trig.querySelector) return null;
    return trig.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
  }
  // Open the combobox, click the option best matching `desired` (string or array of acceptable
  // strings), and return whether a selection was made. SEARCHABLE combos (long lists that render
  // no options until you type — locations, schools, countries) get a type-to-filter fallback. On
  // failure any typed text is CLEARED before closing: stray free text left in a combobox is
  // exactly what fails form validation. Leaves the menu closed either way.
  async function selectFromCombobox(trig, desired) {
    var wants = Array.isArray(desired) ? desired : [desired];
    var r = bestMenuOption(await openComboMenu(trig), wants);
    if (!(r.el && r.score >= 45)) {
      var input = comboTextInput(trig);
      if (input && visible(input) && !input.disabled && !input.readOnly) {
        try {
          input.focus();
          setNativeValue(input, wants[0]);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(700);
          r = bestMenuOption(collectMenuOptions(), wants);
          if (!(r.el && r.score >= 45)) {
            setNativeValue(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } catch (e) {}
      }
    }
    if (r.el && r.score >= 45) { fireClick(r.el); await sleep(150); return true; }
    closeComboMenu(trig);
    return false;
  }
  // Briefly open a combobox to read its option texts (so the AI can pick an exact one), then close.
  async function harvestComboOptions(trig) {
    try {
      var opts = await openComboMenu(trig);
      var texts = [];
      for (var i = 0; i < opts.length && texts.length < 40; i++) {
        var t = getText(opts[i]);
        if (t && t.length < 120 && texts.indexOf(t) < 0) texts.push(t);
      }
      closeComboMenu(trig);
      await sleep(60);
      return texts;
    } catch (e) { return []; }
  }

  // Every dropdown-widget trigger on the page, ONE per widget. Covers ARIA comboboxes, listbox
  // buttons, aria-autocomplete inputs, and react-select control divs (a react-select matches both
  // its control div and its inner input — the container dedupe keeps the first).
  var COMBO_TRIGGER_SELECTOR = '[role="combobox"], [aria-haspopup="listbox"], input[aria-autocomplete="list"], input[aria-autocomplete="both"], [class*="select__control"], [class*="Select-control"]';
  function comboContainer(trig) {
    return trig.closest('fieldset,.form-group,[class*="field"],[class*="question"],div') || trig.parentElement;
  }
  function visibleComboTriggers() {
    var seen = [], out = [];
    var nodes = document.querySelectorAll(COMBO_TRIGGER_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var trig = nodes[i];
      if (trig.tagName === 'SELECT' || trig.disabled || !visible(trig)) continue;
      var cont = comboContainer(trig);
      if (cont && seen.indexOf(cont) >= 0) continue;
      seen.push(cont);
      out.push({ trig: trig, container: cont });
    }
    return out;
  }
  // Proactively fill standard dropdowns rendered as comboboxes (State/Country/City) by SELECTING
  // the option — the combobox twin of fillStdSelects. Typing "Texas" into a State combobox filters
  // the menu but never commits, so the form rejects it; this picks the option instead.
  async function fillStdCombos(profile) {
    var filled = 0, combos = visibleComboTriggers();
    for (var i = 0; i < combos.length; i++) {
      var c = combos[i];
      try {
        if (comboValueText(c.trig, c.container)) continue; // already has a selection
        var sig = signals(c.trig);
        if (eeoKey(sig)) continue; // EEO combos are filled from saved prefs elsewhere
        var desired = stdSelectDesired(sig, profile);
        if (desired && desired.length && await selectFromCombobox(c.trig, desired)) filled++;
      } catch (e) { /* one odd widget shouldn't abort the rest */ }
    }
    return filled;
  }

  // ---------- resume file attach ----------
  function b64ToFile(rec) {
    var bin = atob(rec.b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], rec.name || 'resume.pdf', { type: rec.type || 'application/pdf' });
  }
  function acceptsTxt(el) {
    var a = (el.getAttribute('accept') || '').toLowerCase();
    return !a || a.indexOf('.txt') >= 0 || a.indexOf('text/plain') >= 0 || a.indexOf('*') >= 0;
  }
  function attachResume(resumeFileRec, tailoredText) {
    var hasStored = !!(resumeFileRec && resumeFileRec.b64);
    if (!hasStored && !tailoredText) return 0;
    var attached = 0;
    var fileInputs = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < fileInputs.length; i++) {
      var el = fileInputs[i];
      if (el.disabled) continue;
      if (el.files && el.files.length) continue;
      // The DOM's own `.files.length` guard above isn't enough on its own: some ATS upload
      // widgets (observed on Zoho Recruit) clear the underlying input's files after "parsing" the
      // résumé for their own preview UI — which looks identical to "never attached" to the check
      // above. With the mutation-driven re-scan now re-running fillOnePass repeatedly on content
      // changes (the parse itself IS a content change), that defeat re-triggered a fresh attach
      // every time, uploading 3+ duplicates. This marker is OUR OWN property on the element, which
      // the page's own JS has no reason to touch, so it survives regardless of what happens to
      // `.files`.
      if (el.__aliciaResumeAttached) continue;
      var s = signals(el);
      // Only target inputs that look like resume/CV uploads; if the page has exactly one
      // file input and the page text mentions a resume, assume it's the one. Cover letters
      // and "other documents" are left for the human. File inputs are often visually hidden
      // behind an "Attach" button, so visibility is NOT required here.
      var looksResume = /resume|cv\b|curriculum/.test(s);
      if (!looksResume && !(fileInputs.length === 1 && /resume|curriculum vitae/i.test(document.body.innerText || ''))) continue;
      if (/cover letter|coverletter/.test(s)) continue;
      try {
        var dt = new DataTransfer();
        // With a per-job tailored résumé, attach THAT (as .txt) when the input accepts it, so
        // the uploaded document matches the tailored answers — otherwise the stored original.
        if (tailoredText && acceptsTxt(el)) dt.items.add(new File([tailoredText], 'Resume.txt', { type: 'text/plain' }));
        else if (hasStored) dt.items.add(b64ToFile(resumeFileRec));
        else continue; // tailored-only but this input rejects .txt — leave it for the human
        el.files = dt.files;
        el.__aliciaResumeAttached = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        attached++;
      } catch (e) {}
    }
    return attached;
  }

  // ---------- custom questions (learned bank first, then one batched AI call) ----------
  async function findUnansweredCustomQuestions(eeo) {
    var out = [];
    var seenControls = [];

    function pushItem(item) { if (out.length < CUSTOM_QA_MAX_PER_STEP) out.push(item); }

    // react-select / listbox combobox questions that aren't EEO and have no selection yet. These
    // MUST be picked from a menu, not typed, so give each an apply()/getValue() that drives the
    // combobox. Harvest the option texts up front so the AI can return one verbatim.
    var combos = visibleComboTriggers();
    for (var ki = 0; ki < combos.length; ki++) {
      var trig = combos[ki].trig;
      var kcont = combos[ki].container;
      if (comboValueText(trig, kcont)) continue; // already has a selection
      var klabel = (labelText(trig) || trig.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!klabel || klabel.length < 8) continue;
      if (eeoKey(norm(klabel))) continue; // EEO comboboxes handled by fillEeoComboboxes
      if (looksLikeCaptcha(klabel, kcont)) continue; // never AI-answer a CAPTCHA
      var kopts = await harvestComboOptions(trig);
      seenControls.push(trig);
      out.push((function (t, c, lbl, opts) {
        return {
          type: 'combobox', control: t, container: c, label: lbl, options: opts,
          apply: function (ans) { return selectFromCombobox(t, ans); },
          getValue: function () { return comboValueText(t, c); }
        };
      })(trig, kcont, klabel, kopts));
      if (out.length >= CUSTOM_QA_MAX_PER_STEP) return out;
    }

    // Selects that aren't EEO and have no value yet.
    var selects = document.querySelectorAll('select');
    for (var si = 0; si < selects.length; si++) {
      var sel = selects[si];
      if (!visible(sel) || sel.disabled) continue;
      var cur = (sel.value || '').toLowerCase();
      if (cur && !/select|choose|--|^$/.test(cur)) continue;
      var s = signals(sel);
      if (eeoKey(s)) continue;
      var label = labelText(sel) || sel.getAttribute('aria-label') || '';
      if (!label || label.length < 8) continue;
      var selCont = sel.closest('fieldset,.form-group,div') || sel.parentElement;
      if (looksLikeCaptcha(label, selCont)) continue; // never AI-answer a CAPTCHA
      var options = [];
      for (var o = 0; o < sel.options.length; o++) { if (sel.options[o].value) options.push(getText(sel.options[o]) || sel.options[o].value); }
      if (!options.length || options.length > 30) continue;
      seenControls.push(sel);
      pushItem({ type: 'select', control: sel, container: selCont, label: label, options: options });
    }

    // Radio groups that aren't EEO and have nothing checked.
    var groups = radioGroups();
    Object.keys(groups).forEach(function (nm) {
      var rs = groups[nm];
      if (rs.some(function (x) { return x.checked; })) return;
      var qlabel = groupQuestionLabel(rs);
      if (!qlabel || qlabel.length < 8) return;
      if (eeoKey(norm(qlabel))) return;
      var rGroupCont = rs[0].closest('fieldset,.form-group,div');
      if (looksLikeCaptcha(qlabel, rGroupCont)) return; // never AI-answer a CAPTCHA
      var ropts = rs.map(radioLabel).filter(Boolean);
      if (ropts.length < 2 || ropts.length > 15) return;
      pushItem({ type: 'radio', control: null, radios: rs, container: rGroupCont, label: qlabel, options: ropts });
    });

    // Text inputs / textareas with a question-looking label, still empty, not contact fields.
    var texts = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
    for (var i = 0; i < texts.length; i++) {
      var el = texts[i];
      if (!visible(el) || el.disabled || el.readOnly) continue;
      if (isComboControl(el)) continue; // react-select input — handled by the combobox pass, never typed
      if (el.value && el.value.trim()) continue;
      var sig = signals(el);
      if (!sig || isKnownContactField(sig, el) || eeoKey(sig)) continue;
      var lbl = labelText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      lbl = lbl.replace(/\s+/g, ' ').trim();
      // Only fields whose label reads like an actual question/requirement — not bare
      // one-word fields we can't safely interpret (those stay empty for the human).
      var wordy = lbl.split(' ').length >= 4 || /\?/.test(lbl) || /years|experience|salary|notice|available|start date|why|describe|how did you hear/i.test(lbl);
      if (!lbl || lbl.length < 8 || !wordy) continue;
      var textCont = el.closest('fieldset,.form-group,div') || el.parentElement;
      if (looksLikeCaptcha(lbl, textCont)) continue; // never AI-answer a CAPTCHA — always ask the human
      seenControls.push(el);
      pushItem({ type: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', control: el, container: textCont, label: lbl, options: [] });
    }

    return out;
  }

  async function applyAnswerToItem(item, answerText) {
    if (!answerText) return false;
    if (item.apply) return await item.apply(answerText); // adapter-provided (e.g. Workday prompt-option dropdown)
    if (item.type === 'select') {
      var sel = item.control;
      var best = null, bs = 0;
      for (var o = 0; o < sel.options.length; o++) {
        var op = sel.options[o]; if (!op.value) continue;
        var sc = Math.max(score(op.textContent, answerText), score(op.value, answerText));
        if (sc > bs) { bs = sc; best = op; }
      }
      if (best && bs >= 45) { sel.value = best.value; fire(sel); return true; }
      return false;
    }
    if (item.type === 'radio') return pickRadio(item.radios, answerText);
    if (item.control.value && item.control.value.trim()) return false;
    setNativeValue(item.control, answerText);
    fire(item.control);
    return true;
  }

  function itemFinalValue(item) {
    if (item.getValue) return item.getValue(); // adapter-provided (e.g. Workday prompt-option dropdown)
    if (item.type === 'select') return item.control && item.control.value;
    if (item.type === 'radio') {
      var checked = item.radios.filter(function (r) { return r.checked; })[0];
      return checked ? radioLabel(checked) : '';
    }
    return item.control && item.control.value;
  }

  function pageJobContext() {
    var h1 = document.querySelector('h1');
    return 'Page title: ' + (document.title || '') + (h1 ? ('\nHeading: ' + getText(h1)) : '');
  }

  async function callCustomAnswerBackend(items, resumeText) {
    var sys = 'You are Alicia, helping fill out a real job application truthfully using the candidate\'s resume. You are given the job page context, the resume, and a numbered list of application questions. Some are multiple choice — you MUST answer with one of the exact option strings given, verbatim. Free-text questions get a short, professional answer (1-2 sentences, or just a number for a numeric question) based only on facts in the resume — never invent employers, dates, skills, or credentials that are not in it. If you cannot reasonably answer from the resume, give the most conservative reasonable answer. Respond ONLY with a strict JSON array, no markdown fences, no prose: [{"i":<question number, 1-based>,"answer":"<answer text>"}]';
    var qLines = items.map(function (it, i) {
      var typeLabel = it.multi
        ? '[list one or more values from the resume, comma-separated]'
        : ((it.type === 'select' || it.type === 'radio' || it.type === 'combobox') && it.options && it.options.length)
          ? ('[choose one: ' + it.options.join(' | ') + ']')
          : (it.type === 'textarea' ? '[short paragraph]' : '[short answer]');
      return (i + 1) + '. ' + typeLabel + ' ' + it.label;
    }).join('\n');
    var user = pageJobContext() + '\n\nCandidate Resume:\n' + (resumeText || '').slice(0, 6000) + '\n\nQuestions:\n' + qLines;
    var text = await fetchBackendText(sys, user);
    return parseAnswersJson(text);
  }

  // ---------- dynamic fallback: label unrecognized controls, then reuse the normal pipeline ----------
  // Static heuristics (labelText/signals) only find a field's meaning when the page exposes it via
  // <label for>, aria-label/aria-labelledby, or a close ancestor <label> — conventions major ATS
  // platforms (Workday, Greenhouse, Lever, ...) mostly follow, but arbitrary company career sites
  // routinely don't (caption sits in a sibling <div> two levels up, or nowhere discoverable at all).
  // Those fields are invisible to every pass above — this is the reported "we struggle with company
  // sites because they're all different" gap. This tier widens label discovery for FREE (ancestor/
  // sibling text scrape, not just accessible-name APIs), and only for controls that STILL have no
  // caption spends ONE bounded AI call inferring what the control represents from its attributes/
  // options/page context. The inferred label is then run through the SAME contact/EEO matchers
  // (filled from the trusted profile/prefs — never AI-invented) or added as an ordinary custom
  // question, flowing through the identical learned-bank -> AI-answer -> ask-and-remember pipeline
  // as everything else. Only runs on non-ATS ('generic') pages — known ATS adapters already have
  // good structural coverage, so this only spends effort where it's actually needed.
  function widerLabelGuess(el) {
    var texts = [];
    var node = el;
    for (var depth = 0; depth < 4 && node && node !== document.body; depth++) {
      var parent = node.parentElement;
      if (!parent) break;
      for (var i = 0; i < parent.childNodes.length; i++) {
        var child = parent.childNodes[i];
        if (child === node) break; // only text that appears BEFORE the control at this level
        var t = child.nodeType === 3 ? child.textContent : (child.nodeType === 1 ? getText(child) : '');
        t = (t || '').replace(/\s+/g, ' ').trim();
        if (t && t.length >= 2 && t.length <= 150) texts.push(t);
      }
      node = parent;
    }
    return texts.slice(-3).join(' ').trim(); // nearest few text fragments, closest-first order lost is fine
  }
  function scrapeOrphanControls(claimedEls) {
    var out = [];
    var nodes = document.querySelectorAll('input, textarea, select');
    for (var i = 0; i < nodes.length && out.length < 20; i++) {
      var el = nodes[i];
      var ty = (el.tagName === 'INPUT') ? (el.type || 'text').toLowerCase() : '';
      if (['hidden', 'password', 'file', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'search'].indexOf(ty) >= 0) continue;
      if (el.disabled || el.readOnly || !visible(el)) continue;
      if (claimedEls.indexOf(el) >= 0) continue;
      if (isComboControl(el)) continue; // handled by the existing generic combobox discovery
      if (el.tagName === 'SELECT') { if (selectHasRealValue(el)) continue; }
      else if (el.value && el.value.trim()) continue;
      var existingLabel = labelText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      var wide = existingLabel && existingLabel.length >= 4 ? existingLabel : widerLabelGuess(el);
      out.push({ el: el, wideLabel: wide });
    }
    var groups = radioGroups();
    Object.keys(groups).forEach(function (nm) {
      var rs = groups[nm];
      if (rs.some(function (r) { return r.checked; })) return;
      if (rs.some(function (r) { return claimedEls.indexOf(r) >= 0; })) return;
      var lbl = groupQuestionLabel(rs);
      out.push({ el: rs[0], radios: rs, wideLabel: lbl && lbl.length >= 4 ? lbl : widerLabelGuess(rs[0]) });
    });
    return out;
  }
  // For controls with NO discoverable caption at all, ask the AI to infer one from technical hints
  // only (type/name/id/class/options) — a scoped labeling task, not a PII/EEO-invention risk, since
  // the inferred label only ever routes into the SAME trusted contact/EEO/custom-question pipeline.
  async function aiInferLabels(items) {
    if (!items.length) return {};
    var sys = 'You are looking at an unfamiliar job application form whose fields have no visible caption our tool could detect. For each numbered UI control below (given only its technical attributes — you are never shown real page text), infer the SHORT question/label it most likely represents (e.g. "First name", "Phone number", "Years of experience with Python", "How did you hear about us?"). If you cannot reasonably infer anything specific, respond with an empty string for that item — do NOT guess wildly. Respond ONLY with a strict JSON array, no prose, no markdown fences: [{"i":<1-based index>,"label":"<short label, or empty string if unknown>"}]';
    var lines = items.map(function (it, i) {
      var el = it.el;
      var parts = ['type=' + (it.radios ? 'radio-group' : (el.tagName.toLowerCase() + (el.type ? ':' + el.type : '')))];
      if (el.name) parts.push('name="' + el.name + '"');
      if (el.id) parts.push('id="' + el.id + '"');
      var cls = String(el.className || '').slice(0, 100); if (cls) parts.push('class="' + cls + '"');
      if (el.tagName === 'SELECT') {
        var opts = []; for (var o = 0; o < el.options.length && opts.length < 8; o++) { var t = getText(el.options[o]); if (t) opts.push(t); }
        if (opts.length) parts.push('options=[' + opts.join('|') + ']');
      }
      if (it.radios) parts.push('options=[' + it.radios.map(radioLabel).filter(Boolean).slice(0, 8).join('|') + ']');
      return (i + 1) + '. ' + parts.join(' ');
    }).join('\n');
    var user = pageJobContext() + '\n\nControls (no visible caption detected):\n' + lines;
    try {
      var text = await fetchBackendText(sys, user);
      var arr = parseAnswersJson(text); // shape-agnostic array extractor — reused as-is
      var byIndex = {};
      arr.forEach(function (a) { if (a && typeof a.i === 'number' && typeof a.label === 'string') byIndex[a.i] = a.label.trim(); });
      return byIndex;
    } catch (e) { return {}; }
  }
  function classifyDynamicItem(o, profile) {
    var label = o.wideLabel || o.aiLabel || '';
    if (!label || label.length < 4) return null; // truly nothing to go on — don't guess, don't spam the human
    var normLabel = norm(label);
    var itemCont = (o.radios ? o.radios[0] : o.el).closest && (o.radios ? o.radios[0] : o.el).closest('fieldset,.form-group,div');
    if (looksLikeCaptcha(label, itemCont)) return null; // never AI-answer a CAPTCHA — always ask the human
    // Contact/EEO classification is ONLY trusted when the label is GROUNDED — actually read from
    // the page's own text (o.wideLabel) — never when it's a blind AI GUESS (o.aiLabel) from bare
    // technical hints alone. Observed in practice: the AI-inference step mislabeled unrelated
    // fields as "Facebook"/"LinkedIn"/"First Name" (a phone number landed in a Street Address
    // field, "Texas" landed in a field guessed as "LinkedIn", first/last name got swapped) — a
    // wrong CONTACT/EEO auto-fill silently inserts wrong PII/demographic data with no visible sign
    // anything is off. A wrong CUSTOM-QUESTION guess, by contrast, still flows through the
    // résumé-grounded AI-answer step and is reviewable before submit — a far more benign failure
    // mode. So an ungrounded guess may only ever become a 'question' item, never 'contact'/'eeo'.
    // Passing {} (not o.el) also means the phone/email matchers' `el.type==='tel'|'email'` fallback
    // can never override the label on its own — with a real label already required to reach this
    // point, that type-only fallback (needed elsewhere for truly unlabeled fields) has no business
    // deciding anything here.
    var labelIsGrounded = !!(o.wideLabel && o.wideLabel.length >= 4);
    if (labelIsGrounded && isKnownContactField(normLabel, {})) {
      var matched = buildStdMatchers(profile).find(function (m) { return m.v && m.t(normLabel, {}); });
      return matched ? { kind: 'contact', value: matched.v, el: o.el } : null;
    }
    var eKey = labelIsGrounded ? eeoKey(normLabel) : null;
    if (eKey) return { kind: 'eeo', key: eKey, el: o.el, radios: o.radios };
    if (o.radios) {
      return { kind: 'question', item: { container: o.radios[0].closest('fieldset,.form-group,div') || o.radios[0].parentElement, control: null, radios: o.radios, type: 'radio', label: label, options: o.radios.map(radioLabel).filter(Boolean) } };
    }
    if (o.el.tagName === 'SELECT') {
      var options = []; for (var oi = 0; oi < o.el.options.length; oi++) { if (o.el.options[oi].value) options.push(getText(o.el.options[oi]) || o.el.options[oi].value); }
      if (!options.length) return null;
      return { kind: 'question', item: { container: o.el.closest('fieldset,.form-group,div') || o.el.parentElement, control: o.el, type: 'select', label: label, options: options } };
    }
    // Plain text/textarea: only treat as a real question if the label actually READS like one —
    // same "wordy" gate the normal generic-text discovery already applies, so a stray one-word
    // guess ("Search", "Filter") can't get promoted into an AI-answered/asked question.
    var wordy = label.split(' ').length >= 4 || /\?/.test(label) || /years|experience|salary|notice|available|start date|why|describe|how did you hear/i.test(label);
    if (!wordy) return null;
    return { kind: 'question', item: { container: o.el.closest('fieldset,.form-group,div') || o.el.parentElement, control: o.el, type: (o.el.tagName === 'TEXTAREA' ? 'textarea' : 'text'), label: label, options: [] } };
  }
  async function findDynamicFallbackItems(profile, eeo, claimedEls) {
    var orphans = scrapeOrphanControls(claimedEls);
    if (!orphans.length) return { contactFilled: 0, eeoFilled: 0, questionItems: [] };
    var needAi = orphans.filter(function (o) { return !o.wideLabel || o.wideLabel.length < 4; });
    if (needAi.length) {
      var aiLabels = await aiInferLabels(needAi);
      needAi.forEach(function (o, idx) { o.aiLabel = aiLabels[idx + 1] || ''; });
    }
    var contactFilled = 0, eeoFilled = 0, questionItems = [];
    orphans.forEach(function (o) {
      var c = classifyDynamicItem(o, profile);
      if (!c) return;
      if (c.kind === 'contact') {
        setNativeValue(c.el, c.value); fire(c.el); contactFilled++;
      } else if (c.kind === 'eeo') {
        if (!eeo[c.key]) return;
        if (c.radios) { if (pickRadio(c.radios, eeo[c.key])) eeoFilled++; }
        else if (c.el.tagName === 'SELECT') { if (pickSelectOption(c.el, [eeo[c.key]], 45)) eeoFilled++; }
        // Plain-text EEO fields are intentionally left alone — demographic answers come from a
        // controlled selection, never typed free text, to avoid a mismatched/garbled answer.
      } else if (c.kind === 'question') {
        questionItems.push(c.item);
      }
    });
    return { contactFilled: contactFilled, eeoFilled: eeoFilled, questionItems: questionItems };
  }

  // When the human clicks any advance/submit-looking button after reviewing AI answers,
  // capture whatever is in those fields (including their edits) as the confirmed, learned
  // answer — then resume auto-filling for the following steps.
  var pendingLearnItems = null;
  var confirmListenerAttached = false;
  function attachConfirmCapture() {
    if (confirmListenerAttached) return;
    confirmListenerAttached = true;
    document.addEventListener('click', function (e) {
      if (!pendingLearnItems || !pendingLearnItems.length) return;
      var btn = e.target && e.target.closest ? e.target.closest('button, input[type="submit"], a[role="button"], [role="button"]') : null;
      if (!btn) return;
      var t = norm((btn.getAttribute('aria-label') || '') + ' ' + (btn.innerText || btn.value || ''));
      var isAction = ADVANCE_PATTERNS.concat(STOP_PATTERNS).some(function (p) { return p.test(t); });
      if (!isAction) return;
      var items = pendingLearnItems;
      pendingLearnItems = null;
      items.forEach(function (item) {
        var v = itemFinalValue(item);
        if (v && String(v).trim()) upsertLearnedAnswer(item.label, String(v).trim(), item.type, item.options);
      });
      // The human just confirmed this step — keep going on the next one.
      setTimeout(function () { window.__aliciaAutofillRun(); }, 1200);
    }, true);
  }

  // ---------- advance / stop buttons ----------
  // Allowlist only — an unrecognized button label is left alone rather than guessed at.
  // STOP patterns are checked first every pass; those buttons are NEVER clicked.
  var ADVANCE_PATTERNS = [/^next$/, /^continue$/, /save (and )?continue/, /continue application/, /next step/, /^proceed$/, /^review$/];
  var STOP_PATTERNS = [/submit application/, /submit your application/, /^submit$/, /create (my |your )?(account|profile)/, /^sign up$/, /^register$/, /finish application/, /complete application/, /^apply$/, /^apply now$/];

  function findButton(patterns) {
    var els = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.disabled || !visible(el)) continue;
      // Workday (and similar adapters) suffix purely-navigational toggle links — Create Account
      // <-> Sign In, Forgot Password — with "Link" in data-automation-id, distinct from real
      // submit buttons ("...SubmitButton"). Clicking a toggle just swaps the visible form (can
      // even reset fields the human/AI already filled) while looking identical to a step
      // genuinely advancing — exclude these from every advance/stop search.
      if (/link$/i.test(el.getAttribute('data-automation-id') || '')) continue;
      var t = norm((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.value || el.textContent || ''));
      for (var p = 0; p < patterns.length; p++) { if (patterns[p].test(t)) return el; }
    }
    return null;
  }

  // Buttons/links that OPEN an application from a job *details* page (e.g. hirebridge details.aspx,
  // Greenhouse/Lever posting pages). These land you ON the form — the opposite of STOP_PATTERNS,
  // which submit a form. Only used when no fillable form is present, so there's nothing to submit.
  var APPLY_START_PATTERNS = [/^apply now$/, /^apply for (this )?(job|position|role|opening)/, /^apply online$/, /^apply externally$/, /^apply on company site$/, /^apply$/, /start (your )?application/, /begin application/, /^i'?m interested$/];
  function findApplyStartButton() {
    var els = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.disabled || !visible(el)) continue;
      var t = norm((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.value || el.textContent || ''));
      if (!t || t.length > 40) continue;
      for (var p = 0; p < APPLY_START_PATTERNS.length; p++) { if (APPLY_START_PATTERNS[p].test(t)) return el; }
    }
    return null;
  }
  // From a details page, click through "Apply" (details -> intermediate -> form) until a real form
  // appears. The human only steps in for a captcha/bot-check or the final Submit — never for these
  // navigational "Apply" hops — so click through up to 3 of them.
  async function advanceToApplicationForm() {
    for (var hop = 0; hop < 3; hop++) {
      if (hasRecognizedForm()) return true;
      var btn = findApplyStartButton();
      if (!btn) return hasRecognizedForm();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitForDomSettle(4000);
    }
    return hasRecognizedForm();
  }
  function hasRecognizedForm() {
    if (document.querySelector('input[type="password"], input[type="file"]')) return true;
    return document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type]), select, textarea').length >= 3;
  }
  function hasVisibleError() {
    var errs = document.querySelectorAll('[role="alert"], .error, [aria-invalid="true"]');
    for (var i = 0; i < errs.length; i++) { if (visible(errs[i]) && getText(errs[i])) return true; }
    return false;
  }
  // Wait for the SPA to settle after an advance click: quiet mutations or timeout.
  function waitForDomSettle(maxMs) {
    return new Promise(function (resolve) {
      var last = Date.now();
      var mo = new MutationObserver(function () { last = Date.now(); });
      mo.observe(document.body, { childList: true, subtree: true });
      var start = Date.now();
      (function check() {
        if (Date.now() - last > 500 || Date.now() - start > maxMs) { mo.disconnect(); resolve(); return; }
        setTimeout(check, 200);
      })();
    });
  }

  // ---------- ATS detection + adapter registry ----------
  // Phase 1 establishes the seam only: every ATS resolves to behavior identical to today's
  // generic engine. Phase 2/3 fill in the workday/greenhouse/lever adapters by adding optional
  // hooks to their object here — anything a hook omits falls back to the shared generic engine,
  // so an empty adapter {} is byte-for-byte today's behavior. Recognized hooks:
  //   adapter.fillDropdowns(eeo,profile)-> async; ATS-specific custom dropdowns (e.g. Workday's
  //                                     portaled "prompt option" listboxes, incl. searchable
  //                                     type-to-search ones). Fills EEO/demographics from prefs and
  //                                     State/Country from the profile. Runs BEFORE the generic
  //                                     combobox pass. Returns a fill count.
  //   adapter.fillTypeaheads(profile)-> async; ATS-specific autocomplete inputs that need a
  //                                     type-then-pick (e.g. Greenhouse/Lever location). Returns
  //                                     a fill count. On pick-failure it leaves the typed value,
  //                                     so it never regresses the generic text fill.
  //   adapter.findDropdownQuestions(eeo)-> async; returns custom-question items for ATS dropdowns
  //                                     the generic <select>/radio/text discovery can't see (e.g.
  //                                     Workday's single-select prompt dropdowns AND multi-select
  //                                     chip fields). Each item carries its own async apply(answerText)
  //                                     + getValue() so it flows through the learned-bank -> AI ->
  //                                     learn-from-human pipeline; multi-select items set multi:true
  //                                     (AI returns comma-separated values). EEO/demographic dropdowns
  //                                     are excluded (never AI-answered).
  //   adapter.blockingWall()         -> string|null; a hard human-only blocker (e.g. Workday's
  //                                     verify-email wall). Non-null message => stop with a banner.
  //   adapter.advancePatterns        -> RegExp[] replacing ADVANCE_PATTERNS for this ATS.
  //   adapter.stopPatterns           -> RegExp[] replacing STOP_PATTERNS for this ATS.
  function detectATS() {
    var h = location.hostname.toLowerCase();
    if (/(^|\.)(myworkdayjobs|myworkdaysite|workday)\./.test(h) || document.querySelector('[data-automation-id]')) return 'workday';
    if (/(^|\.)greenhouse\.io$/.test(h) || document.getElementById('grnhse_app') || document.querySelector('form[action*="greenhouse"]')) return 'greenhouse';
    if (/(^|\.)lever\.co$/.test(h) || document.querySelector('.application-form, [data-qa="application-form"], form[action*="lever"]')) return 'lever';
    if (/(^|\.)icims\.com$/.test(h) || document.querySelector('.iCIMS_MainWrapper, #icims_content, form#quickForm, [id^="icims_"]')) return 'icims';
    if (/(^|\.)ashbyhq\.com$/.test(h) || document.querySelector('[class*="ashby"], [id*="ashby"]')) return 'ashby';
    if (/(^|\.)smartrecruiters\.com$/.test(h) || document.querySelector('#smartr, .sr-application, [class*="smartrecruiters"]')) return 'smartrecruiters';
    // Taleo/BrassRing are hostname-only: their account-gate auto-create is riskier than a location
    // typeahead, so we don't want a weak DOM signature misfiring on an unrelated page.
    if (/(^|\.)taleo\.net$/.test(h)) return 'taleo';
    if (/(^|\.)brassring\.com$/.test(h)) return 'brassring';
    return 'generic';
  }
  // ---------- shared account-gate helpers (Workday, iCIMS) ----------
  // Tick the agree-to-terms checkbox on an account-creation page so Create Account / Register can
  // submit. Only the agreement box (by data-automation-id or an agree/terms/consent label), or — if
  // there's exactly one checkbox on the page — that one. Avoids opting into a marketing box. Returns
  // the number ticked.
  function tickAccountAgreement() {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'));
    var candidates = boxes.filter(function (cb) {
      if (cb.checked || cb.disabled) return false;
      var sig = signals(cb) + ' ' + norm(labelText(cb));
      var aid = norm(cb.getAttribute('data-automation-id') || '');
      return /agree|terms|consent|acknowledge|privacy|create account/.test(sig) || /createaccount|agree|terms/.test(aid);
    });
    if (!candidates.length && boxes.length === 1 && !boxes[0].checked && !boxes[0].disabled) candidates = boxes;
    candidates.forEach(function (cb) { try { cb.click(); } catch (e) {} });
    return candidates.length;
  }
  // True when the page is essentially just an email-verification wall: verify phrases present AND
  // almost no form to fill (so it's the wall itself, not a normal page that merely mentions it).
  function isVerifyEmailWall() {
    if (!document.body) return false;
    var t = norm(document.body.innerText || '');
    var verify = /verify your email|verify email address|check your email|verification email|verification link|we sent you|we have sent you|we emailed you|please verify your email/.test(t);
    if (!verify) return false;
    var ctrls = document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), select, textarea');
    var visibleCtrls = 0;
    for (var i = 0; i < ctrls.length; i++) { if (visible(ctrls[i])) visibleCtrls++; }
    return visibleCtrls < 2;
  }

  // ---------- Workday adapter (Phase 2) ----------
  // Workday differs from a plain HTML form in three ways this adapter handles:
  //  1. Dropdowns aren't <select> or role=combobox+role=option — they're a button
  //     (aria-haspopup="listbox") that opens a PORTALED list of [data-automation-id="promptOption"]
  //     items rendered at the end of <body>. wdFillDropdowns opens EEO/known ones and picks.
  //  2. An account is created BEFORE the form (email + password + verifyPassword + an agree
  //     checkbox + a "Create Account" button). Per the product decision, Create Account IS
  //     auto-clicked (it's in WD_ADVANCE, and removed from WD_STOP); the agree checkbox is ticked
  //     here. Generic fillPasswordFields fills BOTH password fields with the same generated value,
  //     so they match. The FINAL application "Submit" is still never auto-clicked.
  //  3. After Create Account, Workday shows an email-verification wall (a real page nav, so
  //     autofill.js is re-injected and re-runs) — wdBlockingWall detects it and stops with a
  //     clear banner, since only the human can click the link in the inbox.
  // The search input that appears inside an open SEARCHABLE Workday dropdown popup.
  function wdSearchBox() {
    return document.querySelector('input[data-automation-id="searchBox"], [data-automation-id="promptSearchBox"] input, [role="listbox"] input[type="text"], [data-automation-widget="wd-popup"] input[type="text"]');
  }
  function wdVisibleOptions() {
    var opts = document.querySelectorAll('[data-automation-id="promptOption"], [role="option"]');
    var out = [];
    for (var i = 0; i < opts.length; i++) { if (visible(opts[i])) out.push(opts[i]); }
    return out;
  }
  // Open a Workday dropdown and select the option best matching `desired`. Handles BOTH kinds:
  // small enumerated lists (options render immediately) and SEARCHABLE lists (Country, School,
  // State) that render nothing until you type — for those, type `desired` into the popup search
  // box, wait for it to filter, then pick. Leaves the dropdown closed (Escape) on no match.
  async function wdPickOption(trigger, desired) {
    if (!desired) return false;
    fireClick(trigger);
    await sleep(300);
    var opts = wdVisibleOptions();
    if (!opts.length) {
      var search = wdSearchBox();
      if (search && visible(search)) {
        search.focus();
        setNativeValue(search, desired);
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(750);
        opts = wdVisibleOptions();
      }
    }
    var best = null, bs = 0;
    for (var i = 0; i < opts.length; i++) {
      var otext = opts[i].getAttribute('data-automation-label') || getText(opts[i]);
      var sc = score(otext, desired);
      if (sc > bs) { bs = sc; best = opts[i]; }
    }
    if (best && bs >= 45) { fireClick(best); await sleep(150); return true; }
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(120);
    return false;
  }

  async function wdFillDropdowns(eeo, profile) {
    var filled = 0;

    // (a) Account-creation page: tick the agree-to-terms checkbox so Create Account can submit.
    if (document.querySelector('[data-automation-id="createAccountSubmitButton"], [data-automation-id="createAccountCheckbox"]')) {
      filled += tickAccountAgreement();
    }

    // (b) Workday prompt-option dropdowns: EEO/demographics from saved prefs, plus State/Province
    // and Country from the profile. Both small enumerated AND searchable (type-to-search) lists are
    // handled by wdPickOption. Note Workday's State/Province field is often "countryRegion" — the
    // state check runs before the country check and matches "region", so it routes correctly.
    // Anything else is left for the custom-question flow / the human.
    var triggers = document.querySelectorAll('button[aria-haspopup="listbox"], [aria-haspopup="listbox"]');
    for (var ti = 0; ti < triggers.length; ti++) {
      var trig = triggers[ti];
      try {
        if (trig.tagName === 'SELECT' || trig.tagName === 'INPUT' || trig.disabled || !visible(trig)) continue;
        var cur = norm(getText(trig));
        var isEmpty = !cur || /^(select|choose|please select)/.test(cur);
        if (!isEmpty) continue; // already has a real selection
        var ff = trig.closest('[data-automation-id^="formField-"]');
        var s = norm([signals(trig), ff ? ff.getAttribute('data-automation-id') : ''].filter(Boolean).join(' '));
        var key = eeoKey(s);
        var desired = null;
        if (key && eeo[key]) desired = eeo[key];
        else if (profile && profile.state && /\b(state|province|region)\b/.test(s)) desired = profile.state;
        else if (profile && profile.country && /\bcountry\b/.test(s)) desired = profile.country;
        if (!desired) continue;
        if (await wdPickOption(trig, desired)) filled++;
      } catch (e) { /* one odd widget shouldn't abort the rest */ }
    }
    return filled;
  }

  function wdBlockingWall() {
    if (!isVerifyEmailWall()) return null;
    return 'Workday sent a verification email — open it and click the link to verify Alicia’s account, then reload this page to continue the application.';
  }

  // Open a Workday prompt-option dropdown to learn what it is, then close it. Workday only renders
  // the [data-automation-id="promptOption"] items while the list is open, so custom-question
  // discovery has to open each candidate. Returns { options, searchable }: enumerated lists come
  // back with their labels; searchable lists (Country, School) render no options until you type, so
  // they come back with options=[] and searchable=true (a search box is present in the popup).
  async function wdReadOptions(trigger) {
    fireClick(trigger);
    await sleep(300);
    var opts = wdVisibleOptions();
    var labels = [];
    for (var i = 0; i < opts.length; i++) {
      var lab = opts[i].getAttribute('data-automation-label') || getText(opts[i]);
      if (lab) labels.push(lab);
    }
    var sb = wdSearchBox();
    var searchable = !labels.length && !!(sb && visible(sb));
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(150);
    return { options: labels, searchable: searchable };
  }

  // ---- Workday MULTI-select prompt fields (Skills, Languages, multi-pick Source, …) ----
  // A typed input inside a [data-automation-id="multiSelectContainer"] whose picks render as chips
  // ([data-automation-id="selectedItem"]). Not a button[aria-haspopup="listbox"], so the single-
  // select scan can't see them. The AI returns comma-separated values; wdAddMultiValues types each
  // into the input, waits for the promptOption list, and clicks the best match to add a chip.
  function wdMultiselectContainers() {
    return document.querySelectorAll('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"]');
  }
  function wdMultiselectInput(container) {
    return container.querySelector('input[type="text"], input:not([type]), input[role="combobox"]');
  }
  function wdSelectedChips(container) {
    return container.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id^="selectedItem"]');
  }
  async function wdAddMultiValues(container, answerText) {
    if (!answerText) return false;
    var input = wdMultiselectInput(container);
    if (!input || !visible(input) || input.disabled) return false;
    var values = String(answerText).split(/[;,\n]/).map(function (v) { return v.trim(); }).filter(Boolean);
    if (!values.length) return false;
    fireClick(input);
    await sleep(150);
    var added = 0;
    for (var vi = 0; vi < values.length; vi++) {
      input.focus();
      setNativeValue(input, values[vi]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
      var opts = wdVisibleOptions();
      var best = null, bs = 0;
      for (var i = 0; i < opts.length; i++) {
        var otext = opts[i].getAttribute('data-automation-label') || getText(opts[i]);
        var sc = score(otext, values[vi]);
        if (sc > bs) { bs = sc; best = opts[i]; }
      }
      if (best && bs >= 45) { fireClick(best); await sleep(200); added++; }
      else { // no match — clear the stray typed text so it doesn't linger, then try the next value
        setNativeValue(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(120);
      }
    }
    return added > 0;
  }
  async function wdFindMultiselectQuestions(eeo) {
    var out = [];
    var conts = wdMultiselectContainers();
    for (var ci = 0; ci < conts.length; ci++) {
      var cont = conts[ci];
      try {
        if (!visible(cont) || wdSelectedChips(cont).length) continue; // hidden or already has picks
        var input = wdMultiselectInput(cont);
        if (!input || input.disabled) continue;
        var ff = cont.closest('[data-automation-id^="formField-"]');
        var sig = norm([signals(input), ff ? ff.getAttribute('data-automation-id') : '', labelText(cont)].filter(Boolean).join(' '));
        if (eeoKey(sig)) continue; // never AI-guess demographics
        var label = (labelText(input) || labelText(cont) || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length < 5) continue;
        out.push({
          type: 'text', multi: true,
          container: ff || cont,
          label: label,
          options: [],
          apply: (function (c) { return function (ans) { return wdAddMultiValues(c, ans); }; })(cont),
          getValue: (function (c) { return function () {
            return Array.prototype.map.call(wdSelectedChips(c), function (p) { return getText(p); }).filter(Boolean).join(', ');
          }; })(cont)
        });
      } catch (e) { /* one odd widget shouldn't abort discovery */ }
    }
    return out;
  }

  // Discover Workday's NON-EEO prompt-option dropdowns (single-select AND multi-select) as custom
  // questions so they flow through the learned-bank -> batched-AI -> learn-from-human pipeline like
  // any other question. EEO dropdowns are excluded (filled by wdFillDropdowns from saved prefs — we
  // never AI-guess demographics).
  async function wdFindDropdownQuestions(eeo) {
    var out = [];
    var triggers = document.querySelectorAll('button[aria-haspopup="listbox"]');
    for (var ti = 0; ti < triggers.length && out.length < CUSTOM_QA_MAX_PER_STEP; ti++) {
      var trig = triggers[ti];
      try {
        if (trig.disabled || !visible(trig)) continue;
        var cur = norm(getText(trig));
        var isEmpty = !cur || /^(select|choose|please select)/.test(cur);
        if (!isEmpty) continue; // already answered
        var ff = trig.closest('[data-automation-id^="formField-"]');
        var sig = norm([signals(trig), ff ? ff.getAttribute('data-automation-id') : ''].filter(Boolean).join(' '));
        if (eeoKey(sig)) continue; // demographics -> wdFillDropdowns, never the AI
        var label = (labelText(trig) || trig.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length < 5) continue;
        if (label.split(' ').length < 2 && !/\?/.test(label)) continue; // skip bare single-word selects (Country, State…)
        var read = await wdReadOptions(trig);
        var isSelect = read.options.length >= 2 && read.options.length <= 30;
        // Enumerated -> choose-one (AI must return an exact option). Searchable -> free-text (AI
        // returns the value, apply types it into the search box and picks). Neither (empty & not
        // searchable, or an absurdly long list) -> leave for the human.
        if (!isSelect && !read.searchable) continue;
        out.push({
          type: isSelect ? 'select' : 'text',
          container: ff || trig.parentElement,
          label: label,
          options: isSelect ? read.options : [],
          apply: (function (t) { return function (ans) { return wdPickOption(t, ans); }; })(trig),
          getValue: (function (t) { return function () { return getText(t); }; })(trig)
        });
      } catch (e) { /* one odd widget shouldn't abort discovery */ }
    }
    // Multi-select prompt fields (chips), same pipeline, capped alongside the single-selects.
    var ms = await wdFindMultiselectQuestions(eeo);
    for (var mi = 0; mi < ms.length && out.length < CUSTOM_QA_MAX_PER_STEP; mi++) out.push(ms[mi]);
    return out;
  }

  // Create Account is auto-clicked (advance); the final application Submit is not (stop).
  var WD_ADVANCE = ADVANCE_PATTERNS.concat([/create account/]);
  var WD_STOP = [/submit application/, /submit your application/, /^submit$/, /finish application/, /complete application/, /^apply$/, /^apply now$/];

  // ---------- account-gated legacy ATS (iCIMS, Taleo, BrassRing) ----------
  // These are largely standard HTML but REQUIRE creating a candidate account before/within the
  // application. Generic treats "Create Account" as a stop, so it halts at the gate and never reaches
  // the form — accountGateAdapter is what unblocks them. Per the Workday/iCIMS product decision it
  // auto-clicks Create Account/Register/Sign Up/New User (advance) and ticks the agreement checkbox on
  // the account page (password field + a create/register button present); it stops on the email-
  // verification wall and on the final Submit/Apply (never auto-clicked). "Login"/"Sign In" are not
  // auto-clicked. Standard fields, EEO, and native-select questions are filled by the generic engine;
  // if a provider turns out to use custom non-native dropdowns, give it a fillDropdowns/
  // findDropdownQuestions hook like Workday's.
  var ACCOUNT_GATE_ADVANCE = ADVANCE_PATTERNS.concat([/create account/, /create your account/, /^register$/, /^sign up$/, /new user/]);
  function isAccountCreationPage() {
    if (!document.querySelector('input[type="password"]')) return false;
    return !!findButton([/create account/, /create your account/, /^register$/, /^sign up$/, /new user/]);
  }
  function accountGateAdapter(providerName) {
    return {
      fillDropdowns: async function () { return isAccountCreationPage() ? tickAccountAgreement() : 0; },
      blockingWall: function () {
        return isVerifyEmailWall()
          ? (providerName + ' sent a verification email — open it and click the link to verify Alicia’s account, then reload this page to continue the application.')
          : null;
      },
      advancePatterns: ACCOUNT_GATE_ADVANCE,
      stopPatterns: WD_STOP // final Submit/Apply/Finish only
    };
  }

  // ---------- Greenhouse + Lever adapter (Phase 3) ----------
  // Greenhouse and Lever are single-page forms whose standard fields, EEO selects, and custom
  // questions are already handled by the generic engine (Submit is caught by the generic stop
  // patterns; there's no multi-step Next to tune). Their one shared generic gap is the LOCATION
  // field: it's a Google-Places / listbox autocomplete, and typing a value without picking a
  // suggestion can fail validation. atsFillLocationTypeahead types "City, State" and picks the
  // first suggestion; if no dropdown appears it leaves the typed value (identical to generic —
  // so this can only help, never regress). Best-effort selectors; see the console diagnostic in
  // the handoff if a specific site's location field doesn't pick.
  async function atsFillLocationTypeahead(profile) {
    var city = profile && profile.city;
    if (!city) return 0;
    var query = [city, profile.state].filter(Boolean).join(', ');
    var filled = 0;
    var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (!visible(el) || el.disabled || el.readOnly) continue;
      if (el.getAttribute('data-alicia-typeahead')) continue;
      if (!/\blocation\b/.test(signals(el))) continue; // location-specific only
      try {
        el.focus();
        setNativeValue(el, query);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        el.setAttribute('data-alicia-typeahead', '1');
        await sleep(650);
        var opts = document.querySelectorAll('.pac-item, #location_autocomplete_dropdown li, .location-dropdown li, ul[role="listbox"] li[role="option"], [role="listbox"] [role="option"]');
        var pick = null;
        for (var o = 0; o < opts.length; o++) { if (visible(opts[o])) { pick = opts[o]; break; } }
        if (pick) { fireClick(pick); await sleep(150); filled++; }
        // else: leave the typed value (same as the generic city fill would).
      } catch (e) { /* leave typed value */ }
    }
    return filled;
  }

  var ADAPTERS = {
    generic: {},
    workday: { fillDropdowns: wdFillDropdowns, findDropdownQuestions: wdFindDropdownQuestions, blockingWall: wdBlockingWall, advancePatterns: WD_ADVANCE, stopPatterns: WD_STOP },
    greenhouse: { fillTypeaheads: atsFillLocationTypeahead },
    lever: { fillTypeaheads: atsFillLocationTypeahead },
    ashby: { fillTypeaheads: atsFillLocationTypeahead },
    smartrecruiters: { fillTypeaheads: atsFillLocationTypeahead },
    icims: accountGateAdapter('iCIMS'),
    taleo: accountGateAdapter('Taleo'),
    brassring: accountGateAdapter('BrassRing')
  };

  // ---------- main ----------
  window.__aliciaAutofillRun = async function () {
    if (busy) return;
    // `window.__aliciaNavHandled` latches true once the nav panel is shown, and — since `window`
    // persists across SPA route changes (no full reload) — it stays true on every later
    // re-injection, even on a COMPLETELY DIFFERENT page reached by clicking that panel's own
    // "next" option. That silently no-ops all future runs on this tab ("no fields found", nothing
    // shown) and leaves the OLD panel sitting on screen with stale, page-specific options from the
    // page it was originally built for. Detecting a real URL change resets the guard (and clears
    // any stale panel) so each distinct page/step gets its own fresh evaluation.
    if (window.__aliciaLastUrl !== location.href) {
      window.__aliciaLastUrl = location.href;
      window.__aliciaNavHandled = false;
      try { removeNavPanel(); } catch (e) {}
    }
    busy = true;
    var state = { generatedCredential: null };
    var result = { filled: 0, status: 'done_no_more_fields', readyButtonText: null, generatedPassword: null, aiAnswered: 0, learnedUsed: 0, resumeAttached: 0, ats: 'generic' };
    var atsName = detectATS();
    var adapter = ADAPTERS[atsName] || {};
    result.ats = atsName;
    var advancePatterns = adapter.advancePatterns || ADVANCE_PATTERNS;
    var stopPatterns = adapter.stopPatterns || STOP_PATTERNS;

    try {
      var data = await storageGet(['profile', 'eeoPrefs', 'siteCredentials', 'customQA', 'resumeText', 'resumeFile']);
      var profile = data.profile || {};
      var eeo = data.eeoPrefs || {};
      var siteCredentials = data.siteCredentials || {};
      // Drop poisoned records (older builds could bank a "Select an option" placeholder as a
      // learned answer, permanently mis-answering that dropdown everywhere).
      var bank = (Array.isArray(data.customQA) ? data.customQA : []).filter(function (rec) {
        if (!rec) return false;
        var n = norm(rec.answer);
        return n && !/^-+$/.test(n.replace(/\s/g, '')) && !(n.length < 30 && /^(select|choose|pick|please select|please choose)\b/.test(n));
      });
      // A web-app apply session delivers the per-job TAILORED résumé via a window var (set by
      // background.js just before injection). Prefer it — the whole point of tailoring in the
      // Jobs tab is that THIS text answers the questions, not the stored generic résumé.
      var tailoredResume = (typeof window.__aliciaTailoredResume === 'string' && window.__aliciaTailoredResume.trim().length > 40)
        ? window.__aliciaTailoredResume.trim() : '';
      var resumeText = tailoredResume || data.resumeText || '';
      var resumeFile = data.resumeFile || null;

      if (!Object.keys(profile).length && !Object.keys(eeo).length) {
        result.status = 'no_profile';
        report(result);
        return result;
      }

      // Adapter-specific hard blocker (e.g. Workday's email-verification wall) — only the human
      // can clear it, so stop with a clear banner rather than churning on an empty page.
      if (adapter.blockingWall) {
        var wallMsg = adapter.blockingWall();
        if (wallMsg) {
          result.status = 'stopped_needs_input';
          showBanner(wallMsg, '#e0a800');
          report(result);
          return result;
        }
      }

      async function fillOnePass() {
        var n = 0;
        n += fillStdFields(profile);
        n += fillStdSelects(profile); // State/Country/City dropdowns → select the option, don't type
        try { n += await fillStdCombos(profile); } catch (e) {} // same, for combobox-style dropdowns
        if (adapter.fillTypeaheads) { try { n += await adapter.fillTypeaheads(profile); } catch (e) {} }
        n += fillPasswordFields(profile, siteCredentials, state);
        n += fillEeoSelects(eeo);
        n += fillEeoRadios(eeo);
        if (adapter.fillDropdowns) { try { n += await adapter.fillDropdowns(eeo, profile); } catch (e) {} }
        n += await fillEeoComboboxes(eeo);
        var ra = attachResume(resumeFile, tailoredResume);
        result.resumeAttached += ra;
        n += ra;

        // Learned answers for custom questions on this step. Native selects/radios/text come from
        // findUnansweredCustomQuestions; an adapter can add more (e.g. Workday's prompt-option
        // dropdowns, which aren't <select> so the generic pass can't see them).
        var items = await findUnansweredCustomQuestions(eeo);
        if (adapter.findDropdownQuestions) {
          try { items = items.concat(await adapter.findDropdownQuestions(eeo)); } catch (e) {}
        }
        // Non-ATS company sites: static label discovery routinely finds nothing for a control at
        // all (no <label for>/aria-label, caption sits in an unrelated sibling) — the reported
        // "every company site is different" gap. Only spends effort here (known ATS pages already
        // have good structural coverage via the passes above).
        if (atsName === 'generic') {
          try {
            var claimedEls = [];
            items.forEach(function (it) {
              if (it.control) claimedEls.push(it.control);
              if (it.radios) claimedEls = claimedEls.concat(it.radios);
            });
            var dyn = await findDynamicFallbackItems(profile, eeo, claimedEls);
            n += dyn.contactFilled + dyn.eeoFilled;
            items = items.concat(dyn.questionItems);
          } catch (e) {}
        }
        // Two different discovery passes can legitimately notice the SAME on-page question via
        // different code paths — e.g. Workday's "How Did You Hear About Us?" prompt dropdown was
        // observed picked up by BOTH the generic ARIA-combobox scan (findUnansweredCustomQuestions)
        // and the adapter's own wdFindDropdownQuestions scan, asking the human the identical question
        // twice, each rendered as a free-text box even though the field is really a dropdown. De-dupe
        // by normalized label before anything reaches the human or the AI, keeping whichever version
        // carries real options (a proper dropdown) over one that fell back to free text.
        (function dedupeByLabel() {
          var byLabel = {}, ordered = [];
          items.forEach(function (it) {
            var key = norm(it.label);
            if (!key) { ordered.push(it); return; }
            if (!byLabel[key]) { byLabel[key] = it; ordered.push(it); }
            else if ((it.options || []).length > (byLabel[key].options || []).length) {
              var idx = ordered.indexOf(byLabel[key]);
              if (idx >= 0) ordered[idx] = it;
              byLabel[key] = it;
            }
          });
          items = ordered;
        })();
        if (items.length > CUSTOM_QA_MAX_PER_STEP) items = items.slice(0, CUSTOM_QA_MAX_PER_STEP);
        var unanswered = [];
        for (var qi = 0; qi < items.length; qi++) {
          var qItem = items[qi];
          var learned = findLearnedAnswer(bank, qItem.label);
          if (learned && await applyAnswerToItem(qItem, learned.answer)) {
            learned.lastUsedAt = Date.now();
            result.learnedUsed++;
            n++;
          } else {
            // Includes learned-but-unappliable: a bank hit whose apply failed (option renamed,
            // widget changed) must still flow to the AI/ask panel — never silently dropped.
            unanswered.push(qItem);
          }
        }
        if (result.learnedUsed) storageSet({ customQA: bank });
        return { filled: n, unanswered: unanswered };
      }

      // On a job *details* page (e.g. hirebridge details.aspx, a Greenhouse/Lever posting) there's
      // no form yet — just an "Apply Now" button. Click through to the actual application before
      // giving up, so the user doesn't see "nothing happen" after landing on the details page.
      if (!hasRecognizedForm()) {
        showBanner('Opening the application…', '#4caf50');
        var advanced = await advanceToApplicationForm();
        if (advanced) result.advancedToForm = true;
      }

      var pass = await fillOnePass();
      result.filled += pass.filled;

      if (!hasRecognizedForm()) {
        // No form here — this is a listing/aggregator/interstitial page. Try a learned "click this
        // button to proceed" choice for this host; else ask the human which button moves forward
        // (and remember it). window.__aliciaNavHandled stops us re-asking on a re-injection.
        if (!window.__aliciaNavHandled) {
          window.__aliciaNavHandled = true;
          var navClicked = false;
          try { navClicked = await tryLearnedNavClick(); } catch (e) {}
          var cands = navClicked ? [] : navCandidates();
          var strong = cands.filter(function (c) { return c.score >= 6; }); // clear Apply/Apply Now
          if (navClicked || strong.length === 1) {
            // A learned choice, OR exactly ONE clear Apply button — proceed autonomously (Apply just
            // opens the form, it never submits, so a click here is safe and recoverable).
            if (!navClicked) { saveNavChoice(location.hostname, strong[0].text); try { fireClick(strong[0].el); } catch (e) {} }
            result.status = 'advancing';
            showBanner('Opening the application…', '#4caf50');
            setTimeout(function () { window.__aliciaNavHandled = false; window.__aliciaAutofillRun(); }, 2800);
          } else if (cands.length >= 1) {
            // Ambiguous — several forward-looking buttons, or none clearly dominant. Ask the human
            // which one moves forward and remember it for this host.
            result.status = 'stopped_needs_input';
            showNavChoicePanel(cands);
          } else {
            result.status = 'no_fields_found';
            showBanner('On the job page. Click "Apply" to open the form and I\'ll fill it in.', '#e0a800');
          }
        } else {
          result.status = 'no_fields_found';
        }
      } else {
        for (var step = 0; step < MAX_STEPS; step++) {
          var correctedThisStep = false; // one dropdown-correction attempt per step
          // A page nav may have landed us on an adapter hard blocker mid-wizard (e.g. Workday's
          // verify-email wall appears right after Create Account) — stop cleanly if so.
          if (adapter.blockingWall) {
            var midWall = adapter.blockingWall();
            if (midWall) { result.status = 'stopped_needs_input'; showBanner(midWall, '#e0a800'); break; }
          }

          // AI-answer whatever the learned bank couldn't cover; anything STILL empty after
          // that is a question Alicia has never seen — the Jobright loop: stop, let the human
          // fill it, and bank their answer the moment they click Continue (attachConfirmCapture
          // resumes filling automatically after that click).
          if (pass.unanswered.length) {
            var answeredItems = [];
            if (resumeText) {
              var answers = [];
              try { answers = await callCustomAnswerBackend(pass.unanswered, resumeText); } catch (e) {}
              var byIndex = {};
              answers.forEach(function (a) { if (a && typeof a.i === 'number') byIndex[a.i] = a.answer; });
              for (var ui = 0; ui < pass.unanswered.length; ui++) {
                var aiItem = pass.unanswered[ui];
                var ans = byIndex[ui + 1];
                if (ans && looksLikeRefusalAnswer(ans)) continue; // "No image provided."/"N/A"-style non-answer -> leave empty, ask the human instead
                if (ans && await applyAnswerToItem(aiItem, ans)) answeredItems.push(aiItem);
              }
            }
            var needHuman = pass.unanswered.filter(function (it) { return !String(itemFinalValue(it) || '').trim(); });

            if (answeredItems.length || needHuman.length) {
              result.aiAnswered += answeredItems.length;
              result.filled += answeredItems.length;
              pendingLearnItems = (pendingLearnItems || []).concat(pass.unanswered);
              attachConfirmCapture();
              if (needHuman.length) {
                result.status = 'stopped_needs_input';
                // Ask directly in an interactive panel (dropdowns get a real option list); saving
                // banks each answer in the learned store and resumes filling automatically. The
                // confirm-capture above still learns if they dismiss it and edit the page instead.
                showQuestionPanel(needHuman);
              } else {
                result.status = 'answered_review';
                showBanner('Alicia answered ' + answeredItems.length + ' question' + (answeredItems.length === 1 ? '' : 's') + ' here — review/edit, then click Continue yourself.', '#e0a800');
              }
              break;
            }
          }

          var stopBtn = findButton(stopPatterns);
          if (stopBtn) {
            result.status = 'ready_to_submit';
            result.readyButtonText = (stopBtn.innerText || stopBtn.value || '').trim();
            showBanner('Filled and ready — review everything, then click "' + result.readyButtonText + '" yourself.', '#4caf50');
            break;
          }
          if (hasVisibleError()) {
            // Validation errors (red boxes) — often a field that wanted a dropdown selection got
            // free text (e.g. State "Texas"). Try to auto-correct by selecting the right option,
            // then re-check; only stop for the human if it still can't be resolved.
            var recovered = false;
            if (!correctedThisStep) {
              correctedThisStep = true;
              var fixed = 0;
              try { fixed = await correctErrors(profile, eeo); } catch (e) {}
              if (fixed) { result.filled += fixed; await waitForDomSettle(800); recovered = !hasVisibleError(); }
            }
            if (!recovered) {
              result.status = 'stopped_needs_input';
              showBanner('Filled what it could — this step needs your input.', '#e0a800');
              break;
            }
          }
          var nextBtn = findButton(advancePatterns);
          if (!nextBtn) { result.status = 'done_no_more_fields'; break; }

          // Defense-in-depth against any allowlisted button that turns out to be a view-toggle
          // rather than a genuine advance (e.g. an unanticipated ATS quirk like Workday's Sign-In
          // <-> Create-Account switch) — if the SAME button (same URL + same visible label) gets
          // clicked repeatedly without the page ever reaching a stop button or losing its
          // recognized form, stop thrashing and ask the human to take it from here.
          var advKey = location.href + '|' + norm(getText(nextBtn) || nextBtn.value || '');
          window.__aliciaAdvanceLog = window.__aliciaAdvanceLog || {};
          window.__aliciaAdvanceLog[advKey] = (window.__aliciaAdvanceLog[advKey] || 0) + 1;
          if (window.__aliciaAdvanceLog[advKey] > 2) {
            result.status = 'stopped_needs_input';
            showBanner('This step keeps repeating instead of moving forward — please click through it yourself from here.', '#e0a800');
            break;
          }

          nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await waitForDomSettle(4000);
          pass = await fillOnePass();
          result.filled += pass.filled;

          if (!hasRecognizedForm()) { result.status = 'done_no_more_fields'; break; }
          if (step === MAX_STEPS - 1) result.status = 'stopped_step_cap';
        }
      }

      if (state.generatedCredential) {
        result.generatedPassword = state.generatedCredential;
        showBanner('Created an account password for ' + state.generatedCredential.hostname + ' — saved in the side panel under Site Passwords.', '#4caf50');
      }
      report(result);
      return result;
    } catch (err) {
      result.status = 'error';
      result.error = String(err && err.message || err);
      report(result);
      return result;
    } finally {
      busy = false;
    }
  };

  // ---------- self-triggering re-scan on DOM content changes ----------
  // background.js's navigation-based re-injection (full page loads, and SPA route changes via
  // history.pushState) covers most transitions, but two real gaps remain — both observed in
  // testing: (1) some SPA route changes never call pushState at all (a plain in-memory view swap),
  // so no navigation event fires for them at all (Zoho Recruit's "I'm interested" → Basic Info
  // form); (2) even when a real navigation IS detected, a heavy SPA form can take longer to
  // actually render its fields than the fixed re-injection delay, so a scan run at that instant
  // correctly finds "no form yet" and shows the nav panel — which then never re-evaluates once the
  // real form finally mounts a moment later (Workday's Create Account page). A MutationObserver
  // watching the page's own content for real changes closes both gaps, mirroring content.js's
  // existing polling approach for LinkedIn. Debounced + rate-floored to bound cost, and skipped
  // entirely while a custom-question ask panel is up (that one needs a human ANSWER — re-running
  // would just re-ask the same unanswerable question via a wasted AI call). The nav panel is NOT a
  // reason to skip: it only means "no form found yet," which is exactly what a genuine content
  // change should re-evaluate, so we also reset its one-shot guard and clear it before rerunning.
  var mutationRerunTimer = null;
  var lastMutationRerunAt = 0;
  var MUTATION_RERUN_MIN_INTERVAL_MS = 4000;
  function scheduleMutationRerun() {
    clearTimeout(mutationRerunTimer);
    mutationRerunTimer = setTimeout(function () {
      if (document.getElementById('alicia-question-panel')) return;
      var now = Date.now();
      if (now - lastMutationRerunAt < MUTATION_RERUN_MIN_INTERVAL_MS) return;
      lastMutationRerunAt = now;
      window.__aliciaNavHandled = false;
      try { removeNavPanel(); } catch (e) {}
      try { window.__aliciaAutofillRun(); } catch (e) {}
    }, 700);
  }
  try {
    var aliciaMutationObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var t = mutations[i].target;
        var el = t && t.nodeType === 1 ? t : (t && t.parentElement);
        if (el && isInAliciaUi(el)) continue; // ignore our own banner/panel DOM churn
        scheduleMutationRerun();
        return;
      }
    });
    aliciaMutationObserver.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}

  window.__aliciaAutofillRun();
})();
