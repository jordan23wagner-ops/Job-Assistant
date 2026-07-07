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
        : (it.type === 'select' || it.type === 'radio')
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
  // From a details page, click through "Apply" up to a couple of hops until a real form appears.
  async function advanceToApplicationForm() {
    for (var hop = 0; hop < 2; hop++) {
      var btn = findApplyStartButton();
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitForDomSettle(4000);
      if (hasRecognizedForm()) return true;
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
      var bank = Array.isArray(data.customQA) ? data.customQA : [];
      var resumeText = data.resumeText || '';
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
        if (adapter.fillTypeaheads) { try { n += await adapter.fillTypeaheads(profile); } catch (e) {} }
        n += fillPasswordFields(profile, siteCredentials, state);
        n += fillEeoSelects(eeo);
        n += fillEeoRadios(eeo);
        if (adapter.fillDropdowns) { try { n += await adapter.fillDropdowns(eeo, profile); } catch (e) {} }
        n += await fillEeoComboboxes(eeo);
        var ra = attachResume(resumeFile);
        result.resumeAttached += ra;
        n += ra;

        // Learned answers for custom questions on this step. Native selects/radios/text come from
        // findUnansweredCustomQuestions; an adapter can add more (e.g. Workday's prompt-option
        // dropdowns, which aren't <select> so the generic pass can't see them).
        var items = findUnansweredCustomQuestions(eeo);
        if (adapter.findDropdownQuestions) {
          try { items = items.concat(await adapter.findDropdownQuestions(eeo)); } catch (e) {}
        }
        if (items.length > CUSTOM_QA_MAX_PER_STEP) items = items.slice(0, CUSTOM_QA_MAX_PER_STEP);
        var unanswered = [];
        for (var qi = 0; qi < items.length; qi++) {
          var qItem = items[qi];
          var learned = findLearnedAnswer(bank, qItem.label);
          if (learned && await applyAnswerToItem(qItem, learned.answer)) {
            learned.lastUsedAt = Date.now();
            result.learnedUsed++;
            n++;
          } else if (!learned) {
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
        result.status = 'no_fields_found';
        showBanner('On the job page. Click "Apply" to open the form and I\'ll fill it in.', '#e0a800');
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
                showBanner('New question' + (needHuman.length === 1 ? '' : 's') + ' here (' + needHuman.length + ') — fill in and click Continue. Alicia will remember your answer' + (needHuman.length === 1 ? '' : 's') + ' and keep going.', '#e0a800');
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
