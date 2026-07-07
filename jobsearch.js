// Alicia — Job Search (full-page tab).
// Calls the backend /api/jobs proxy (Adzuna; key stays server-side), ranks results by résumé fit,
// and renders cards. "Apply" opens the posting — where the auto-detect offer (detect.js) fires on a
// known ATS. Phase 1: search + filters + ranked results. (Apply hand-off tightening = Phase 2,
// résumé tailoring = Phase 3.)
(function () {
  'use strict';
  // Job Search runs on the Wagner-GPT backend (Jordon & Alicia's personal tool) — it holds the
  // Adzuna key server-side and also serves the fit-ranking /chat call. (The rest of the extension
  // still uses chatwillow.com; only this feature is on wagner-gpt.)
  var BACKEND = 'https://wagner-gpt.vercel.app/api';

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
  var lastResults = []; // stored so Apply/Tailor buttons can reference jobs by index
  var tailorState = null; // { job, history, pendingResume }

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

  // Multi-turn backend call — history is [{role,content},…]; last entry is the user turn.
  function backendChat(history) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(['alicia_session'], function (stored) {
        var headers = { 'Content-Type': 'application/json' };
        var s = stored && stored.alicia_session;
        if (s && s.access_token && Date.now() < (s.expires_at || 0) - 60000) headers['Authorization'] = 'Bearer ' + s.access_token;
        var last = history[history.length - 1];
        fetch(BACKEND + '/chat', {
          method: 'POST', headers: headers,
          body: JSON.stringify({ messages: history.slice(0, -1), newMessage: last.content, model: 'auto' })
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
    lastResults = results;
    var wrap = el('results');
    wrap.innerHTML = '';
    el('empty').style.display = results.length ? 'none' : 'block';
    if (!results.length) { el('empty').textContent = 'No jobs found — try broader titles, fewer filters, or a different industry.'; return; }
    results.forEach(function (j, idx) {
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
          '<button class="btn apply-btn" data-url="' + esc(j.url) + '" data-idx="' + idx + '">Apply</button>' +
          '<a class="btn ghost" href="' + esc(j.url) + '" target="_blank" rel="noopener" style="text-decoration:none;">View posting</a>' +
          '<button class="btn ghost tailor-btn" data-idx="' + idx + '">✏ Tailor résumé</button>' +
        '</div>';
      wrap.appendChild(card);
    });
    // Phase 2: Apply opens tab + auto-starts autofill session + saves to Tracker
    Array.prototype.forEach.call(wrap.querySelectorAll('.apply-btn'), function (b) {
      b.addEventListener('click', function () {
        if (!b.dataset.url) return;
        var url = b.dataset.url;
        var hostname = '';
        try { hostname = new URL(url).hostname; } catch (e) {}
        chrome.tabs.create({ url: url }, function (tab) {
          chrome.storage.local.get('autofillSessions', function (data) {
            var sessions = data.autofillSessions || {};
            sessions[String(tab.id)] = { hostname: hostname, startedAt: Date.now() };
            chrome.storage.local.set({ autofillSessions: sessions });
          });
        });
        var job = lastResults[parseInt(b.dataset.idx, 10)];
        if (job) saveToTracker(job);
        b.textContent = '✓ Opening…';
        b.disabled = true;
      });
    });
    // Phase 3: Tailor résumé opens the modal
    Array.prototype.forEach.call(wrap.querySelectorAll('.tailor-btn'), function (b) {
      b.addEventListener('click', function () {
        var job = lastResults[parseInt(b.dataset.idx, 10)];
        if (job) openTailorModal(job);
      });
    });
  }

  function saveToTracker(j) {
    chrome.storage.local.get('trackedJobs', function (d) {
      var jobs = d.trackedJobs || [];
      var url = j.url || '';
      if (url && jobs.some(function (t) { return t.url === url; })) return;
      jobs.unshift({
        id: 'tj_' + Date.now(),
        title: j.title || 'Untitled role',
        company: j.company || '',
        location: j.location || '',
        url: url,
        description: (j.description || '').slice(0, 2000),
        status: 'applied',
        notes: '',
        savedAt: Date.now()
      });
      chrome.storage.local.set({ trackedJobs: jobs });
    });
  }

  function saveResume(text, label) {
    chrome.storage.local.get('savedResumes', function (d) {
      var resumes = (d.savedResumes || []).map(function (r) { return Object.assign({}, r, { isActive: false }); });
      resumes.unshift({ id: 'r_' + Date.now(), label: label, text: text, isActive: true, savedAt: Date.now() });
      chrome.storage.local.set({ savedResumes: resumes, resumeText: text });
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

  // ---- Phase 3: Tailor résumé modal ----

  function openTailorModal(j) {
    tailorState = { job: j, history: [], pendingResume: null };
    el('tailor-title').textContent = (j.title || 'Tailor résumé') + (j.company ? ' @ ' + j.company : '');
    el('tailor-msgs').innerHTML = '';
    el('tailor-save-row').classList.add('hidden');
    el('tailor-save-btn').textContent = '💾 Save as active résumé';
    el('tailor-save-btn').disabled = false;
    el('tailor-input').value = '';
    el('tailor-modal').classList.remove('hidden');

    getResume().then(function (resume) {
      var sys = 'You are helping tailor a résumé for a specific job. Rules:\n' +
        '1. Ask ONE focused question at a time about the candidate\'s real experience that would strengthen their fit for this role.\n' +
        '2. Focus on gaps: skills, achievements, or scope not clearly shown in the current résumé.\n' +
        '3. NEVER add or invent anything the candidate hasn\'t explicitly confirmed.\n' +
        '4. After 3-5 questions — or if the user says "generate", "done", or "ready" — output ONLY the full tailored résumé text with no preamble.\n' +
        '5. Keep the résumé truthful. If nothing new was confirmed, return the original with only minor rephrasing toward the role.';
      var intro = 'Job: ' + (j.title || '') + (j.company ? ' at ' + j.company : '') + '\n\n' +
        'Description:\n' + (j.description || '(not provided)').slice(0, 1500) + '\n\n' +
        'Current résumé:\n' + (resume || '(no résumé saved — ask the candidate to describe their background)').slice(0, 4000) + '\n\n' +
        'Begin: review the job requirements vs. the résumé and ask your first targeted question.';
      tailorState.history = [
        { role: 'system', content: sys },
        { role: 'user', content: intro }
      ];
      tailorAiTurn();
    });
  }

  function closeTailorModal() {
    el('tailor-modal').classList.add('hidden');
    tailorState = null;
  }

  function appendTailorMsg(role, text) {
    var msgs = el('tailor-msgs');
    var div = document.createElement('div');
    var looksLikeResume = role === 'ai' && text.length > 800 &&
      /\b(EXPERIENCE|EDUCATION|SKILLS|SUMMARY|OBJECTIVE|WORK HISTORY|PROFESSIONAL EXPERIENCE)\b/i.test(text);
    div.className = 'tailor-msg ' + (role === 'user' ? 'user' : (looksLikeResume ? 'resume' : 'ai'));
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    if (looksLikeResume) {
      tailorState.pendingResume = text;
      el('tailor-save-row').classList.remove('hidden');
    }
  }

  function tailorAiTurn() {
    var sendBtn = el('tailor-send-btn');
    sendBtn.disabled = true;
    var typing = document.createElement('div');
    typing.className = 'tailor-msg ai'; typing.id = 'tailor-typing'; typing.textContent = '…';
    el('tailor-msgs').appendChild(typing);
    el('tailor-msgs').scrollTop = el('tailor-msgs').scrollHeight;

    backendChat(tailorState.history).then(function (raw) {
      var t = el('tailor-typing'); if (t) t.remove();
      var text = stripThinking(raw);
      tailorState.history.push({ role: 'assistant', content: text });
      appendTailorMsg('ai', text);
      sendBtn.disabled = false;
    }).catch(function (err) {
      var t = el('tailor-typing'); if (t) t.remove();
      appendTailorMsg('ai', 'Error: ' + (err && err.message || 'unknown'));
      sendBtn.disabled = false;
    });
  }

  function tailorUserSend() {
    if (!tailorState) return;
    var input = el('tailor-input');
    var text = input.value.trim();
    if (!text) return;
    appendTailorMsg('user', text);
    tailorState.history.push({ role: 'user', content: text });
    input.value = '';
    tailorAiTurn();
  }

  // ---- init ----
  initIndustries();
  loadCategories();
  el('searchBtn').addEventListener('click', doSearch);
  el('country').addEventListener('change', loadCategories);
  ['titles', 'location', 'salaryMin'].forEach(function (id) {
    el(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  });

  // Tailor modal wiring
  el('tailor-close').addEventListener('click', closeTailorModal);
  el('tailor-modal').addEventListener('click', function (e) { if (e.target === this) closeTailorModal(); });
  el('tailor-send-btn').addEventListener('click', tailorUserSend);
  el('tailor-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') tailorUserSend(); });
  el('tailor-save-btn').addEventListener('click', function () {
    if (!tailorState || !tailorState.pendingResume) return;
    var label = 'Tailored for ' + (tailorState.job.title || 'role') +
      (tailorState.job.company ? ' at ' + tailorState.job.company : '');
    saveResume(tailorState.pendingResume, label);
    el('tailor-save-btn').textContent = '✓ Saved as active résumé!';
    el('tailor-save-btn').disabled = true;
  });
})();
