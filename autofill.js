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
//      goes to the free Chatwillow backend in ONE batched AI call.
//   4. If the AI answered anything, it STOPS and asks the human to review — the click on
//      Next/Continue that the human makes is what confirms + saves those answers to the
//      learned bank (then filling automatically resumes).
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

  // Workday-style dropdowns: no native <select>, just a button with role=combobox that opens
  // a portaled listbox. Open it, pick the best-matching option, or Escape out.
  async function fillEeoComboboxes(eeo) {
    var filled = 0;
    var triggers = document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]');
    for (var ti = 0; ti < triggers.length; ti++) {
      var trig = triggers[ti];
      try {
        if (trig.tagName === 'SELECT' || trig.tagName === 'INPUT' || trig.disabled || !visible(trig)) continue;
        var curText = norm(getText(trig) || trig.value || '');
        if (curText && !/select|choose|--|^$/.test(curText)) continue;
        var tKey = eeoKey(signals(trig));
        if (!tKey || !eeo[tKey]) continue;

        fireClick(trig);
        await sleep(250);

        var opts = document.querySelectorAll('[role="option"]:not([aria-disabled="true"]), [role="listbox"] li');
        var tBest = null, tbs = 0;
        for (var oi = 0; oi < opts.length; oi++) {
          var opt = opts[oi];
          if (!visible(opt)) continue;
          var sc = score(getText(opt), eeo[tKey]);
          if (sc > tbs) { tbs = sc; tBest = opt; }
        }
        if (tBest && tbs >= 45) {
          fireClick(tBest);
          await sleep(120);
          filled++;
        } else {
          trig.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }
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
  function attachResume(resumeFileRec) {
    if (!resumeFileRec || !resumeFileRec.b64) return 0;
    var attached = 0;
    var fileInputs = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < fileInputs.length; i++) {
      var el = fileInputs[i];
      if (el.disabled) continue;
      if (el.files && el.files.length) continue;
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
        dt.items.add(b64ToFile(resumeFileRec));
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        attached++;
      } catch (e) {}
    }
    return attached;
  }

  // ---------- custom questions (learned bank first, then one batched AI call) ----------
  function findUnansweredCustomQuestions(eeo) {
    var out = [];
    var seenControls = [];

    function pushItem(item) { if (out.length < CUSTOM_QA_MAX_PER_STEP) out.push(item); }

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
      var options = [];
      for (var o = 0; o < sel.options.length; o++) { if (sel.options[o].value) options.push(getText(sel.options[o]) || sel.options[o].value); }
      if (!options.length || options.length > 30) continue;
      seenControls.push(sel);
      pushItem({ type: 'select', control: sel, container: sel.closest('fieldset,.form-group,div') || sel.parentElement, label: label, options: options });
    }

    // Radio groups that aren't EEO and have nothing checked.
    var groups = radioGroups();
    Object.keys(groups).forEach(function (nm) {
      var rs = groups[nm];
      if (rs.some(function (x) { return x.checked; })) return;
      var qlabel = groupQuestionLabel(rs);
      if (!qlabel || qlabel.length < 8) return;
      if (eeoKey(norm(qlabel))) return;
      var ropts = rs.map(radioLabel).filter(Boolean);
      if (ropts.length < 2 || ropts.length > 15) return;
      pushItem({ type: 'radio', control: null, radios: rs, container: rs[0].closest('fieldset,.form-group,div'), label: qlabel, options: ropts });
    });

    // Text inputs / textareas with a question-looking label, still empty, not contact fields.
    var texts = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
    for (var i = 0; i < texts.length; i++) {
      var el = texts[i];
      if (!visible(el) || el.disabled || el.readOnly) continue;
      if (el.value && el.value.trim()) continue;
      var sig = signals(el);
      if (!sig || isKnownContactField(sig, el) || eeoKey(sig)) continue;
      var lbl = labelText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      lbl = lbl.replace(/\s+/g, ' ').trim();
      // Only fields whose label reads like an actual question/requirement — not bare
      // one-word fields we can't safely interpret (those stay empty for the human).
      var wordy = lbl.split(' ').length >= 4 || /\?/.test(lbl) || /years|experience|salary|notice|available|start date|why|describe|how did you hear/i.test(lbl);
      if (!lbl || lbl.length < 8 || !wordy) continue;
      seenControls.push(el);
      pushItem({ type: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', control: el, container: el.closest('fieldset,.form-group,div') || el.parentElement, label: lbl, options: [] });
    }

    return out;
  }

  function applyAnswerToItem(item, answerText) {
    if (!answerText) return false;
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
      var typeLabel = (it.type === 'select' || it.type === 'radio')
        ? ('[choose one: ' + it.options.join(' | ') + ']')
        : (it.type === 'textarea' ? '[short paragraph]' : '[short answer]');
      return (i + 1) + '. ' + typeLabel + ' ' + it.label;
    }).join('\n');
    var user = pageJobContext() + '\n\nCandidate Resume:\n' + (resumeText || '').slice(0, 6000) + '\n\nQuestions:\n' + qLines;
    var text = await fetchBackendText(sys, user);
    return parseAnswersJson(text);
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
      var t = norm((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.value || el.textContent || ''));
      for (var p = 0; p < patterns.length; p++) { if (patterns[p].test(t)) return el; }
    }
    return null;
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

  // ---------- main ----------
  window.__aliciaAutofillRun = async function () {
    if (busy) return;
    busy = true;
    var state = { generatedCredential: null };
    var result = { filled: 0, status: 'done_no_more_fields', readyButtonText: null, generatedPassword: null, aiAnswered: 0, learnedUsed: 0, resumeAttached: 0 };

    try {
      var data = await storageGet(['profile', 'eeoPrefs', 'siteCredentials', 'customQA', 'resumeText', 'resumeFile']);
      var profile = data.profile || {};
      var eeo = data.eeoPrefs || {};
      var siteCredentials = data.siteCredentials || {};
      var bank = Array.isArray(data.customQA) ? data.customQA : [];
      var resumeText = data.resumeText || '';
      var resumeFile = data.resumeFile || null;

      if (!Object.keys(profile).length && !Object.keys(eeo).length) {
        result.status = 'no_profile';
        report(result);
        return result;
      }

      async function fillOnePass() {
        var n = 0;
        n += fillStdFields(profile);
        n += fillPasswordFields(profile, siteCredentials, state);
        n += fillEeoSelects(eeo);
        n += fillEeoRadios(eeo);
        n += await fillEeoComboboxes(eeo);
        var ra = attachResume(resumeFile);
        result.resumeAttached += ra;
        n += ra;

        // Learned answers for custom questions on this step.
        var items = findUnansweredCustomQuestions(eeo);
        var unanswered = [];
        items.forEach(function (item) {
          var learned = findLearnedAnswer(bank, item.label);
          if (learned && applyAnswerToItem(item, learned.answer)) {
            learned.lastUsedAt = Date.now();
            result.learnedUsed++;
            n++;
          } else if (!learned) {
            unanswered.push(item);
          }
        });
        if (result.learnedUsed) storageSet({ customQA: bank });
        return { filled: n, unanswered: unanswered };
      }

      var pass = await fillOnePass();
      result.filled += pass.filled;

      if (!hasRecognizedForm()) {
        result.status = 'no_fields_found';
      } else {
        for (var step = 0; step < MAX_STEPS; step++) {
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
              pass.unanswered.forEach(function (item, i) {
                var ans = byIndex[i + 1];
                if (ans && applyAnswerToItem(item, ans)) answeredItems.push(item);
              });
            }
            var needHuman = pass.unanswered.filter(function (it) { return !String(itemFinalValue(it) || '').trim(); });

            if (answeredItems.length || needHuman.length) {
              result.aiAnswered += answeredItems.length;
              result.filled += answeredItems.length;
              pendingLearnItems = (pendingLearnItems || []).concat(pass.unanswered);
              attachConfirmCapture();
              if (needHuman.length) {
                result.status = 'stopped_needs_input';
                showBanner('New question' + (needHuman.length === 1 ? '' : 's') + ' here (' + needHuman.length + ') — fill in and click Continue. Alicia will remember your answer' + (needHuman.length === 1 ? '' : 's') + ' and keep going.', '#e0a800');
              } else {
                result.status = 'answered_review';
                showBanner('Alicia answered ' + answeredItems.length + ' question' + (answeredItems.length === 1 ? '' : 's') + ' here — review/edit, then click Continue yourself.', '#e0a800');
              }
              break;
            }
          }

          var stopBtn = findButton(STOP_PATTERNS);
          if (stopBtn) {
            result.status = 'ready_to_submit';
            result.readyButtonText = (stopBtn.innerText || stopBtn.value || '').trim();
            showBanner('Filled and ready — review everything, then click "' + result.readyButtonText + '" yourself.', '#4caf50');
            break;
          }
          if (hasVisibleError()) {
            result.status = 'stopped_needs_input';
            showBanner('Filled what it could — this step needs your input.', '#e0a800');
            break;
          }
          var nextBtn = findButton(ADVANCE_PATTERNS);
          if (!nextBtn) { result.status = 'done_no_more_fields'; break; }

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

  window.__aliciaAutofillRun();
})();
