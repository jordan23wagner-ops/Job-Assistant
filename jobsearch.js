// Alicia — Job Search (full-page tab).
// Calls the backend /api/jobs proxy (Adzuna; key stays server-side), ranks results by résumé fit,
// and renders cards. "Apply" opens the posting — where the auto-detect offer (detect.js) fires on a
// known ATS. Phase 1: search + filters + ranked results. (Apply hand-off tightening = Phase 2,
// résumé tailoring = Phase 3.)
(function () {
  'use strict';
  var BACKEND = 'https://chatwillow.com/api';

  // Curated industries. Each resolves to an Adzuna category (matched by label against the live
  // category list, so we never hardcode a possibly-wrong tag) plus optional keyword augmentation
  // for sub-fields Adzuna doesn't categorize (Cybersecurity, AI) — those live inside "IT Jobs".
  var INDUSTRIES = [
    { name: 'Any industry', match: null, keywords: '' },
    { name: 'Software / IT', match: /it jobs/i, keywords: '' },
    { name: 'Cybersecurity', match: /it jobs/i, keywords: 'cybersecurity security' },
    { name: 'AI / Machine Learning', match: /it jobs/i, keywords: 'machine learning artificial intelligence' },
    { name: 'Oil & Gas / Energy', match: /energy|oil/i, keywords: '' },
    { name: 'Healthcare Tech', match: /healthcare|nursing/i, keywords: 'technology software data' },
    { name: 'Manufacturing', match: /manufacturing/i, keywords: '' },
    { name: 'Engineering', match: /engineering/i, keywords: '' }
  ];

  // Known ATS hosts our adapters auto-fill — used to badge "auto-fill ready" results.
  var ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|workable|bamboohr)\.(com|io|co|net)/i;

  var el = function (id) { return document.getElementById(id); };
  var categories = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(t) { el('status').textContent = t || ''; }

  function initIndustries() {
    var sel = el('industry');
    INDUSTRIES.forEach(function (ind, i) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = ind.name;
      sel.appendChild(o);
    });
  }

  function loadCategories() {
    return fetch(BACKEND + '/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'categories', country: el('country').value })
    }).then(function (r) { return r.json(); }).then(function (d) {
      categories = (d && d.categories) || [];
    }).catch(function () { categories = []; }); // degrade to keyword-only industries
  }

  function resolveCategoryTag(industry) {
    if (!industry.match || !categories.length) return '';
    var hit = categories.filter(function (c) { return industry.match.test(c.label); })[0];
    return hit ? hit.tag : '';
  }

  function getResume() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(['resumeText', 'savedResumes'], function (d) {
          var txt = (d && d.resumeText) || '';
          if (!txt && d && Array.isArray(d.savedResumes)) {
            var active = d.savedResumes.filter(function (r) { return r.isActive; })[0] || d.savedResumes[0];
            if (active) txt = active.text || '';
          }
          resolve(txt || '');
        });
      } catch (e) { resolve(''); }
    });
  }

  // ---- backend chat (NDJSON delta stream, same shape as autofill.js) ----
  function stripThinking(t) {
    if (!t) return t;
    var c = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (/<\/think>/i.test(c)) c = c.replace(/[\s\S]*<\/think>/i, '');
    return c.replace(/<\/?think>/gi, '').trim();
  }
  function backendText(sys, user) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(['alicia_session'], function (stored) {
        var headers = { 'Content-Type': 'application/json' };
        var s = stored && stored.alicia_session;
        if (s && s.access_token && Date.now() < (s.expires_at || 0) - 60000) headers['Authorization'] = 'Bearer ' + s.access_token;
        fetch(BACKEND + '/chat', {
          method: 'POST', headers: headers,
          body: JSON.stringify({ messages: [{ role: 'system', content: sys }], newMessage: user, model: 'auto' })
        }).then(function (resp) {
          if (!resp.ok) throw new Error('Backend ' + resp.status);
          var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '', text = '';
          (function pump() {
            reader.read().then(function (ch) {
              if (ch.done) { if (buf.trim()) { try { var f = JSON.parse(buf.trim()); if (f.delta) text += f.delta; } catch (e) {} } resolve(text); return; }
              buf += dec.decode(ch.value, { stream: true });
              var lines = buf.split('\n'); buf = lines.pop();
              for (var i = 0; i < lines.length; i++) {
                var ln = lines[i].trim(); if (!ln) continue;
                try { var ev = JSON.parse(ln); if (ev.delta) text += ev.delta; else if (ev.error) throw new Error(ev.error); } catch (e) {}
              }
              pump();
            }).catch(reject);
          })();
        }).catch(reject);
      });
    });
  }

  function lexicalRank(results, resume) {
    var rt = (resume || '').toLowerCase();
    var toks = {};
    rt.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).forEach(function (w) { if (w.length > 3) toks[w] = 1; });
    var keys = Object.keys(toks);
    return results.map(function (j) {
      var hay = ((j.title || '') + ' ' + (j.description || '') + ' ' + (j.category || '')).toLowerCase();
      var hits = 0;
      keys.forEach(function (w) { if (hay.indexOf(w) >= 0) hits++; });
      var score = keys.length ? Math.min(95, Math.round((hits / Math.min(keys.length, 40)) * 100)) : 50;
      return { i: 0, score: score, reason: '' };
    });
  }

  function aiRank(results, resume) {
    var sys = 'You are Alicia, a job-fit rater. Given the candidate résumé and a numbered list of jobs, ' +
      'score each job 0-100 for how well the candidate fits it (skills, seniority, domain), and give a ' +
      'terse 6-12 word reason. Respond ONLY with a strict JSON array, no prose, no code fences: ' +
      '[{"i":<job number>,"score":<0-100>,"reason":"<short>"}]';
    var lines = results.map(function (j, i) {
      return (i + 1) + '. ' + (j.title || '') + ' @ ' + (j.company || '') + ' | ' + (j.location || '') +
        ' | ' + (j.category || '') + ' | ' + (j.description || '').slice(0, 240);
    }).join('\n');
    var user = 'Résumé:\n' + (resume || '').slice(0, 6000) + '\n\nJobs:\n' + lines;
    return backendText(sys, user).then(function (raw) {
      var clean = stripThinking(raw).replace(/^```json\s*/i, '').replace(/```$/, '').trim();
      var arr = null;
      try { arr = JSON.parse(clean); } catch (e) { var m = clean.match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch (e2) {} } }
      if (!Array.isArray(arr)) throw new Error('bad rank json');
      return arr;
    });
  }

  function salaryText(j) {
    if (!j.salaryMin && !j.salaryMax) return '';
    var fmt = function (n) { return '$' + Math.round(n / 1000) + 'k'; };
    var s = j.salaryMin && j.salaryMax ? (fmt(j.salaryMin) + '–' + fmt(j.salaryMax))
      : fmt(j.salaryMin || j.salaryMax);
    return s + (j.salaryPredicted ? ' est.' : '');
  }
  function fitColor(score) {
    if (score >= 75) return '#2e7d32';
    if (score >= 50) return '#7a6a12';
    return '#5a3030';
  }

  function render(results) {
    var wrap = el('results');
    wrap.innerHTML = '';
    el('empty').style.display = results.length ? 'none' : 'block';
    if (!results.length) { el('empty').textContent = 'No jobs found — try broader titles, fewer filters, or a different industry.'; return; }
    results.forEach(function (j) {
      var atsReady = ATS_HOST_RE.test((j.url || '').replace(/^https?:\/\//, ''));
      var card = document.createElement('div');
      card.className = 'card';
      var scoreShown = typeof j._score === 'number';
      card.innerHTML =
        '<div class="fit" style="background:' + (scoreShown ? fitColor(j._score) : 'var(--accent2)') + '">' +
          (scoreShown ? j._score : '—') + '</div>' +
        '<div>' +
          '<h3>' + esc(j.title) + '</h3>' +
          '<div class="meta">' + esc(j.company || 'Company undisclosed') + (j.location ? ' · ' + esc(j.location) : '') + '</div>' +
          '<div class="tags">' +
            (salaryText(j) ? '<span class="pill salary">' + esc(salaryText(j)) + '</span>' : '') +
            (j.category ? '<span class="pill">' + esc(j.category) + '</span>' : '') +
            (j.contractTime ? '<span class="pill">' + esc(j.contractTime.replace('_', '-')) + '</span>' : '') +
            (atsReady ? '<span class="pill" style="color:var(--accent);border-color:var(--accent)">⚡ auto-fill ready</span>' : '') +
          '</div>' +
          (j._reason ? '<div class="reason">' + esc(j._reason) + '</div>' : '') +
          (j.description ? '<div class="snippet">' + esc(j.description.slice(0, 260)) + '…</div>' : '') +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn" data-url="' + esc(j.url) + '">Apply</button>' +
          '<a class="btn ghost" href="' + esc(j.url) + '" target="_blank" rel="noopener" style="text-decoration:none;">View posting</a>' +
        '</div>';
      wrap.appendChild(card);
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('button[data-url]'), function (b) {
      b.addEventListener('click', function () { if (b.dataset.url) window.open(b.dataset.url, '_blank', 'noopener'); });
    });
  }

  function doSearch() {
    var titles = el('titles').value.trim();
    var ind = INDUSTRIES[parseInt(el('industry').value, 10) || 0];
    if (!titles && (!ind || !ind.match) && !ind.keywords) { setStatus('Enter at least one job title or pick an industry.'); return; }

    var what = [titles, ind ? ind.keywords : ''].filter(Boolean).join(' ').trim();
    var payload = {
      action: 'search',
      what: what,
      category: ind ? resolveCategoryTag(ind) : '',
      where: el('location').value.trim(),
      salaryMin: el('salaryMin').value.trim(),
      remote: el('remote').checked,
      fullTime: el('fullTime').checked,
      country: el('country').value,
      resultsPerPage: 25
    };

    el('searchBtn').disabled = true;
    setStatus('Searching…');
    el('results').innerHTML = '';
    el('empty').style.display = 'none';

    fetch(BACKEND + '/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error) { setStatus(d.error); el('empty').style.display = 'block'; el('empty').textContent = d.error; return; }
      var results = (d && d.results) || [];
      if (!results.length) { setStatus('No results.'); render([]); return; }
      setStatus('Found ' + results.length + ' — ranking by fit…');
      return getResume().then(function (resume) {
        var deep = el('deepFit').checked && resume;
        var rankPromise = deep ? aiRank(results, resume).catch(function () { return lexicalRank(results, resume); })
          : Promise.resolve(lexicalRank(results, resume));
        return rankPromise.then(function (scores) {
          var byI = {};
          scores.forEach(function (s, idx) { var k = (typeof s.i === 'number' && s.i >= 1) ? s.i - 1 : idx; byI[k] = s; });
          results.forEach(function (j, idx) { var s = byI[idx] || {}; j._score = typeof s.score === 'number' ? s.score : 50; j._reason = s.reason || ''; });
          results.sort(function (a, b) { return (b._score || 0) - (a._score || 0); });
          setStatus('Showing ' + results.length + ' jobs, best fit first' + (resume ? '' : ' (add a résumé for smarter ranking)') + '.');
          render(results);
        });
      });
    }).catch(function (err) {
      setStatus('Search failed: ' + (err && err.message || 'unknown') + '. Is the backend job endpoint deployed?');
      el('empty').style.display = 'block';
    }).then(function () { el('searchBtn').disabled = false; });
  }

  // ---- init ----
  initIndustries();
  loadCategories();
  el('searchBtn').addEventListener('click', doSearch);
  el('country').addEventListener('change', loadCategories);
  ['titles', 'location', 'salaryMin'].forEach(function (id) {
    el(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  });
})();
