// Whole file runs inside a run-once-per-frame IIFE: background.js force-injects this file
// programmatically (into every LinkedIn frame on navigation events AND immediately after
// every extension reload), in addition to the manifest registration — so the same frame can
// legitimately receive it multiple times. The guard makes repeat injection a no-op instead of
// stacking duplicate observers/listeners.
(function () {
if (window.__aliciaContentLoaded) return;
window.__aliciaContentLoaded = true;

function cleanText(text) {
  if (!text) return '';
  var clean = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code === 0xFEFF || code === 0xFFFD) continue;
    if (code >= 0x00 && code <= 0x08) continue;
    if (code === 0x0B || code === 0x0C) continue;
    if (code >= 0x0E && code <= 0x1F) continue;
    if (code === 0x2028 || code === 0x2029) { clean += ' '; continue; }
    clean += text[i];
  }
  return clean.replace(/\s+/g, ' ').trim();
}

function getText(el) {
  if (!el) return '';
  return cleanText(el.innerText || el.textContent || '');
}

// Reloading/updating the extension orphans this content script in any tab that was already
// open — chrome.runtime/chrome.storage calls then throw "Extension context invalidated"
// synchronously (not just a rejected promise), so a plain .catch() doesn't catch it. Every
// call site below goes through these wrappers instead of calling chrome.* directly.
function extAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

function safeSendMessage(msg) {
  if (!extAlive()) return;
  try { chrome.runtime.sendMessage(msg).catch(function () {}); } catch (e) {}
}

function safeStorageGet(keys, cb) {
  if (!extAlive()) return;
  try { chrome.storage.local.get(keys, cb); } catch (e) {}
}

function safeStorageSet(obj) {
  if (!extAlive()) return;
  try { chrome.storage.local.set(obj); } catch (e) {}
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// content.js runs in EVERY linkedin.com frame (manifest all_frames:true) because LinkedIn
// renders some Easy Apply forms — including ATS-powered ones like Lever — inside a
// SAME-ORIGIN linkedin.com/preload iframe that a top-frame-only script can't reach. Page-level
// features (job detection, the match overlay, job-list/people scraping) must run ONLY in the
// top frame, or a subframe would send spurious/empty results that clobber the real ones. The
// Easy Apply autofill + auto-advance run in ALL frames, so whichever frame actually holds the
// application form gets filled.
var IS_TOP = (function () { try { return window.top === window.self; } catch (e) { return false; } })();

// One-time marker so we can confirm from the console whether the script is injected into a
// given frame (especially LinkedIn's same-origin linkedin.com/preload apply iframe).
console.log('[Alicia] content script loaded in frame — IS_TOP=' + IS_TOP + ' url=' + location.href);

function trySelectors(selectors, minLen, maxLen) {
  for (var i = 0; i < selectors.length; i++) {
    try {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var t = getText(el);
        if (t.length >= (minLen || 1) && t.length <= (maxLen || 300)) return t;
      }
    } catch (e) {}
  }
  return null;
}

function expandJobDescription() {
  try {
    var allButtons = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < allButtons.length; i++) {
      var btn = allButtons[i];
      var text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
      if (text.includes('see more') || text.includes('show more') || text === '...more') {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }
  } catch (e) {
    console.log('[Alicia] expandJobDescription error:', e);
  }
}

function getTitleFromPageTitle() {
  var pageTitle = document.title || '';
  if (!pageTitle || pageTitle.indexOf('LinkedIn') === -1) return null;

  var cleaned = pageTitle
    .replace(/\s*\|\s*LinkedIn$/i, '')
    .replace(/\s*-\s*LinkedIn$/i, '')
    .replace(/\(\d+\)\s*/g, '');

  var parts = cleaned.split(/\s*\|\s*/);
  if (parts.length >= 1 && parts[0].trim().length > 2) {
    var title = parts[0].trim();
    var skipPhrases = ['jobs', 'search', 'feed', 'home', 'messaging', 'notifications', 'my network', 'sign in', 'log in'];
    var lower = title.toLowerCase();
    for (var i = 0; i < skipPhrases.length; i++) {
      if (lower === skipPhrases[i]) return null;
    }
    return title;
  }
  return null;
}

// On a jobs SEARCH page, document.title is the search query (e.g. "Project Manager
// OR Program Manager ... Jobs"), not the selected job. Detect that so we don't show it.
function looksLikeSearchQuery(title) {
  if (!title) return true;
  var t = title.trim();
  var orCount = (t.match(/\bOR\b/g) || []).length;
  if (orCount >= 2) return true;                       // multiple boolean ORs
  if (orCount >= 1 && /\bjobs?\s*$/i.test(t)) return true; // "... OR ... Jobs"
  if (/^jobs?\b/i.test(t)) return true;
  return false;
}

function getJobTitleFromDom() {
  return trySelectors([
    '.job-details-jobs-unified-top-card__job-title h1 a',
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title h2',
    '.job-details-jobs-unified-top-card__job-title a',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title a',
    '.jobs-unified-top-card__job-title',
    'h1.t-24.t-bold',
    'h1.t-24',
    'h2.t-24.t-bold',
    'h2.t-24',
    'h1.topcard__title',
    'h2.top-card-layout__title',
    '.t-24.t-bold.inline'
  ], 3, 200);
}

function getJobTitle() {
  // On search pages the active job lives in the right-hand detail pane; the page
  // <title> is the search query, so read the top card from the DOM first.
  var isSearchPage = /\/jobs\/search/i.test(location.href) || /[?&]currentJobId=/i.test(location.href);
  if (isSearchPage) {
    var domTitle = getJobTitleFromDom();
    if (domTitle) {
      console.log('[Alicia] Title from DOM (search page):', domTitle);
      return domTitle;
    }
  }

  var fromPage = getTitleFromPageTitle();
  if (fromPage && !looksLikeSearchQuery(fromPage)) {
    console.log('[Alicia] Title found from page title:', fromPage);
    return fromPage;
  }

  var title = getJobTitleFromDom();
  if (title) {
    console.log('[Alicia] Title found via selector:', title);
    return title;
  }

  if (fromPage) {
    console.log('[Alicia] Falling back to page title:', fromPage);
    return fromPage;
  }

  console.log('[Alicia] Title NOT found. document.title was:', document.title);
  return null;
}

function getCompany() {
  var company = trySelectors([
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.job-details-jobs-unified-top-card__primary-description-container a',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    'a.top-card-layout__company-url'
  ], 1, 100);
  if (company) { console.log('[Alicia] Company found via selector:', company); return company; }

  try {
    var links = document.querySelectorAll('a[href*="/company/"]');
    for (var j = 0; j < links.length; j++) {
      var t = getText(links[j]);
      if (t.length > 1 && t.length < 100) {
        var inSidebar = links[j].closest('.jobs-search__left-rail, .scaffold-layout__list');
        if (!inSidebar) {
          console.log('[Alicia] Company found via link fallback:', t);
          return t;
        }
      }
    }
    for (var k = 0; k < links.length; k++) {
      var t2 = getText(links[k]);
      if (t2.length > 1 && t2.length < 100) {
        console.log('[Alicia] Company found via any link:', t2);
        return t2;
      }
    }
  } catch (e) {}

  var fromPage = document.title || '';
  var parts = fromPage.replace(/\s*[\|\-]\s*LinkedIn$/i, '').split(/\s*\|\s*/);
  if (parts.length >= 2 && parts[1].trim().length > 1) {
    console.log('[Alicia] Company found from page title:', parts[1].trim());
    return parts[1].trim();
  }

  console.log('[Alicia] Company NOT found');
  return null;
}

function getLocation() {
  var loc = trySelectors([
    '.job-details-jobs-unified-top-card__bullet',
    '.job-details-jobs-unified-top-card__workplace-type',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    'span.top-card-layout__bullet'
  ], 1, 100);
  if (loc) { console.log('[Alicia] Location found via selector:', loc); return loc; }

  try {
    var companyLink = document.querySelector('a[href*="/company/"]');
    if (companyLink) {
      var container = companyLink.parentElement;
      for (var up = 0; up < 4 && container; up++) {
        var spans = container.querySelectorAll('span, li');
        for (var s = 0; s < spans.length; s++) {
          var st = getText(spans[s]);
          if (st.length > 2 && st.length < 80) {
            if (/\b(Remote|Hybrid|On-site|United States|Houston|Texas|TX|CA|NY|India|Canada|UK|Germany|Australia)\b/i.test(st)) {
              console.log('[Alicia] Location found near company:', st);
              return st;
            }
          }
        }
        container = container.parentElement;
      }
    }
  } catch (e) {}

  console.log('[Alicia] Location NOT found');
  return null;
}

function getDescription() {
  var jobDetailsEl = document.getElementById('job-details');
  if (jobDetailsEl) {
    var t = getText(jobDetailsEl);
    if (t.length > 50) { console.log('[Alicia] Description found via #job-details, length:', t.length); return t; }
  }

  var desc = trySelectors([
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    '.description__text',
    '.jobs-description'
  ], 50, 50000);
  if (desc) { console.log('[Alicia] Description found via selector, length:', desc.length); return desc; }

  try {
    var allEls = document.querySelectorAll('h2, h3, span, div');
    for (var j = 0; j < allEls.length; j++) {
      var elText = getText(allEls[j]);
      if (elText === 'About the job' || elText === 'Job description' || elText === 'Description') {
        var next = allEls[j].nextElementSibling;
        while (next) {
          var nt = getText(next);
          if (nt.length > 50) {
            console.log('[Alicia] Description found after header, length:', nt.length);
            return nt;
          }
          next = next.nextElementSibling;
        }
        var section = allEls[j].closest('section, article, div[class]');
        if (section) {
          var st = getText(section);
          if (st.length > 80) {
            var cleaned = st.replace(elText, '').trim();
            if (cleaned.length > 50) {
              console.log('[Alicia] Description found in section, length:', cleaned.length);
              return cleaned;
            }
          }
        }
      }
    }
  } catch (e) { console.log('[Alicia] Description header search error:', e); }

  console.log('[Alicia] Description NOT found');
  return null;
}

function detectJob() {
  console.log('[Alicia] Running job detection on:', window.location.href);

  var title = getJobTitle();
  var company = getCompany();
  var location = getLocation();
  var description = getDescription();

  console.log('[Alicia] Detection result:', { title: title, company: company, location: location, descLength: description ? description.length : 0 });

  if (title || company) {
    var job = { title: title, company: company, location: location, description: description, url: window.location.href, detectedAt: Date.now() };
    lastDetectedJob = job;
    safeSendMessage({ type: 'JOB_DETECTED', job: job });
    if (title && description) maybeShowMatchOverlay(job);
    return true;
  }
  return false;
}

// Kept up to date by detectJob() — the Easy Apply custom-question answerer needs the job
// context but the modal doesn't always re-trigger detection itself.
var lastDetectedJob = null;

// ========== Match Score overlay: mirrors the side panel's "Match Score" tool, but shows
// automatically on the job page itself (like Jobright), scored against the saved resume. ==========

var MATCH_BACKEND_URL = 'https://wagner-gpt.vercel.app/api/chat';
var matchScoreCache = {}; // "title|company" -> {score,matched,missing,summary}
var matchScoreInFlight = {};

function matchJobKey(job) { return (job.title || '') + '|' + (job.company || ''); }

// Qwen (and other reasoning models) emit chain-of-thought in <think>...</think> before the
// real answer — strip it so JSON parsing doesn't choke on it.
function stripThinkingTags(text) {
  if (!text) return text;
  var cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (/<\/think>/i.test(cleaned)) cleaned = cleaned.replace(/[\s\S]*<\/think>/i, '');
  return cleaned.replace(/<\/?think>/gi, '').trim();
}

function parseMatchJson(raw) {
  var clean = stripThinkingTags(raw).replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  var m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
  return null;
}

// Self-contained copy of sidepanel.js's rawBackendCall — content scripts run in a separate
// JS context and can't call into the side panel, so the NDJSON-stream client is duplicated
// here (shared by every AI-backed content.js feature: match score, custom-question answers).
async function fetchBackendText(sys, user) {
  var resp = await fetch(MATCH_BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function callMatchBackend(job, resumeText) {
  var sys = 'You are Alicia, a resume-to-job matching engine. Compare the candidate resume to the job posting. Respond ONLY with strict JSON, no markdown fences, no prose: {"score":<0-100 integer, overall fit>,"matched":[<up to 8 short keywords/skills from the job that the resume clearly covers>],"missing":[<up to 8 short keywords/skills the job wants that the resume does not clearly show>],"summary":"<one sentence on the overall fit>"}';
  var user = 'Job Title: ' + (job.title || '') + '\nCompany: ' + (job.company || '') + '\n\nJob Description:\n' + (job.description || '') + '\n\nCandidate Resume:\n' + resumeText.slice(0, 6000);
  var text = await fetchBackendText(sys, user);
  var data = parseMatchJson(text);
  if (!data || typeof data.score !== 'number') throw new Error('Could not parse a match score from the response.');
  return data;
}

function matchScoreColor(score) {
  if (score >= 75) return '#4caf50';
  if (score >= 50) return '#e0a800';
  return '#c0564b';
}

function escapeOverlayHtml(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function findMatchOverlayAnchor() {
  // Known top-card title selectors first.
  var known = document.querySelector(
    '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1.t-24.t-bold, h1.t-24, h2.top-card-layout__title'
  );
  if (known && known.offsetParent !== null) return known;
  // LinkedIn churns those classes — fall back to any visible <h1> that looks like a job title
  // (the job detail pane's heading). Skip the LinkedIn global nav/search area.
  var h1s = document.querySelectorAll('h1, h2.t-24, h2.t-bold');
  for (var i = 0; i < h1s.length; i++) {
    var h = h1s[i];
    if (h.offsetParent === null) continue;
    var t = getText(h);
    if (t.length > 3 && t.length < 200 && !/^(jobs|linkedin|messaging|my network|notifications)$/i.test(t)) return h;
  }
  return null;
}

function toggleMatchOverlayDetails(badgeEl, result) {
  var existing = document.getElementById('alicia-match-details');
  if (existing) { existing.remove(); if (existing.__forBadge === badgeEl) return; }

  var panel = document.createElement('div');
  panel.id = 'alicia-match-details';
  panel.__forBadge = badgeEl;
  var isFixed = badgeEl.parentNode === document.body; // floating badge → float the panel too
  panel.style.cssText = 'padding:10px 12px;border-radius:8px;background:#20203a;color:#e6e6f0;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:320px;box-shadow:0 2px 12px rgba(0,0,0,.4);'
    + (isFixed ? 'position:fixed;top:108px;right:20px;z-index:2147483646;' : 'margin:6px 0 10px;max-width:480px;');

  var html = result.summary ? '<div style="margin-bottom:4px;">' + escapeOverlayHtml(result.summary) + '</div>' : '';
  function chips(label, items, color) {
    if (!items || !items.length) return '';
    var s = '<div style="margin-top:6px;"><strong>' + label + ':</strong><br>';
    items.forEach(function (kw) {
      s += '<span style="display:inline-block;margin:3px 4px 0 0;padding:2px 8px;border-radius:10px;font-weight:600;background:' + color + '33;color:' + color + ';">' + escapeOverlayHtml(kw) + '</span>';
    });
    return s + '</div>';
  }
  html += chips('Matched', result.matched, '#4caf50');
  html += chips('Missing', result.missing, '#e0a800');
  panel.innerHTML = html;
  badgeEl.insertAdjacentElement('afterend', panel);
}

function renderMatchOverlay(state, result) {
  var anchor = findMatchOverlayAnchor();
  var el = document.getElementById('alicia-match-overlay');
  var fixed = !anchor; // no inline anchor found — pin a floating badge so it always shows
  if (!el) {
    el = document.createElement('div');
    el.id = 'alicia-match-overlay';
    if (anchor) anchor.insertAdjacentElement('afterend', el);
    else document.body.appendChild(el);
  } else if (anchor && el.parentNode === document.body) {
    // An anchor became available after we first showed a floating badge — move it inline.
    anchor.insertAdjacentElement('afterend', el);
    fixed = false;
  } else if (el.parentNode === document.body) {
    fixed = true;
  }

  var base = 'display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font:600 12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;user-select:none;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);';
  var placement = fixed
    ? 'position:fixed;top:72px;right:20px;z-index:2147483646;'
    : 'margin:8px 0;';
  el.style.cssText = base + placement;

  if (state === 'loading') {
    el.style.background = '#4a4a68';
    el.style.cursor = 'default';
    el.textContent = '⚡ Alicia is scoring your fit…';
    el.onclick = null;
  } else if (state === 'error') {
    el.style.background = '#6a4a4a';
    el.style.cursor = 'default';
    el.textContent = 'Could not score this job right now.';
    el.onclick = null;
  } else if (state === 'done') {
    el.style.background = matchScoreColor(result.score);
    el.style.cursor = 'pointer';
    el.textContent = '🎯 ' + result.score + '% match — tap for details';
    el.onclick = function () { toggleMatchOverlayDetails(el, result); };
  }
}

function maybeShowMatchOverlay(job) {
  safeStorageGet('resumeText', function (data) {
    var resumeText = data && data.resumeText;
    if (!resumeText) return; // nothing to score against — same gate as the side panel's button

    var key = matchJobKey(job);
    var cached = matchScoreCache[key];
    if (cached) { renderMatchOverlay('done', cached); return; }
    if (matchScoreInFlight[key]) return; // already scoring this job, avoid duplicate calls

    matchScoreInFlight[key] = true;
    renderMatchOverlay('loading');
    callMatchBackend(job, resumeText).then(function (result) {
      matchScoreCache[key] = result;
      delete matchScoreInFlight[key];
      // The user may have navigated to a different job while this was in flight.
      if (matchJobKey(currentJobForMatch()) === key) renderMatchOverlay('done', result);
    }).catch(function (err) {
      console.log('[Alicia] Match score error:', err);
      delete matchScoreInFlight[key];
      if (matchJobKey(currentJobForMatch()) === key) renderMatchOverlay('error');
    });
  });
}

// Re-reads title/company from the DOM to confirm the in-flight score still matches what's
// on screen (the SPA may have navigated to another job while the backend call was pending).
function currentJobForMatch() {
  return { title: getJobTitle(), company: getCompany() };
}

// ========== Scrape the job-search RESULTS LIST (for auto-pull + AI fit-filter) ==========

function getCardText(card, selectors) {
  for (var i = 0; i < selectors.length; i++) {
    try {
      var el = card.querySelector(selectors[i]);
      if (el) { var t = getText(el); if (t) return t; }
    } catch (e) {}
  }
  return '';
}

// Read the visible job cards on a /jobs/search results page into a lightweight list.
// LinkedIn churns these class names often, so every field has ordered fallbacks.
function scrapeJobList() {
  var nodes = document.querySelectorAll(
    'li.scaffold-layout__list-item, li.jobs-search-results__list-item, div.job-card-container, [data-occludable-job-id], [data-job-id]'
  );
  var out = [];
  var seen = {};
  for (var i = 0; i < nodes.length; i++) {
    var card = nodes[i];
    var jobId = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id') || '';
    var link = card.querySelector('a.job-card-container__link, a.job-card-list__title--link, a[href*="/jobs/view/"]');
    var url = link && link.href ? link.href.split('?')[0] : '';
    if (!jobId && url) { var m = url.match(/\/jobs\/view\/(\d+)/); if (m) jobId = m[1]; }
    var key = jobId || url;
    if (!key || seen[key]) continue;

    var title = getCardText(card, [
      '.job-card-list__title--link', '.job-card-list__title',
      'a.job-card-container__link span[aria-hidden="true"]',
      'a.job-card-container__link', '.artdeco-entity-lockup__title'
    ]);
    if (!title) continue;
    var company = getCardText(card, [
      '.job-card-container__primary-description', '.job-card-container__company-name',
      '.artdeco-entity-lockup__subtitle'
    ]);
    var location = getCardText(card, [
      '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption'
    ]);
    if (!url && jobId) url = 'https://www.linkedin.com/jobs/view/' + jobId + '/';

    seen[key] = true;
    out.push({ title: title, company: company, location: location, url: url });
    if (out.length >= 40) break;
  }
  console.log('[Alicia] Scraped', out.length, 'job cards from list');
  return out;
}

// ========== Scrape the "Meet the hiring team" people on a job posting ==========

function scrapeHiringTeam() {
  var containers = [];
  // Known container classes for the hiring-team / "who can help" module.
  document.querySelectorAll('.hirer-card__container, .job-details-people-who-can-help__section, .jobs-poster, .job-details-module').forEach(function (c) { containers.push(c); });
  // Also find the module by its header text, in case the classes changed.
  var heads = document.querySelectorAll('h2, h3, .t-16, .text-heading-large');
  for (var i = 0; i < heads.length; i++) {
    var ht = (heads[i].innerText || heads[i].textContent || '').toLowerCase();
    if (ht.indexOf('meet the hiring team') >= 0 || ht.indexOf('who can help') >= 0 || ht.indexOf('people you can reach') >= 0) {
      var sec = heads[i].closest('section, div');
      if (sec) containers.push(sec);
    }
  }

  var people = [];
  var seen = {};
  containers.forEach(function (c) {
    var anchors = c.querySelectorAll('a[href*="/in/"]');
    for (var a = 0; a < anchors.length; a++) {
      var anchor = anchors[a];
      var url = (anchor.href || '').split('?')[0];
      if (!url || seen[url]) continue;

      var name = getText(anchor);
      if (!name || name.length < 2) {
        var nameEl = anchor.querySelector('span[aria-hidden="true"], strong, .hirer-card__hirer-information span');
        if (nameEl) name = getText(nameEl);
      }
      if (!name || name.length < 2 || /^\d/.test(name)) continue;

      var title = '';
      var wrap = anchor.closest('.hirer-card__container, li, .artdeco-entity-lockup, div');
      if (wrap) {
        var subs = wrap.querySelectorAll('.hirer-card__hirer-job-title, .artdeco-entity-lockup__subtitle, .t-14, .t-12, .t-black--light');
        for (var s = 0; s < subs.length; s++) {
          var st = getText(subs[s]);
          if (st && st !== name && st.length > 1 && st.length < 120) { title = st; break; }
        }
      }
      seen[url] = true;
      people.push({ name: name, title: title, url: url });
      if (people.length >= 8) break;
    }
  });
  console.log('[Alicia] Found', people.length, 'hiring-team people');
  return people;
}

if (IS_TOP) {
  setTimeout(function() {
    expandJobDescription();
    setTimeout(function() {
      if (!detectJob()) {
        setTimeout(function() {
          expandJobDescription();
          detectJob();
        }, 3000);
      }
    }, 1000);
  }, 1500);

  var lastUrl = location.href;
  var observer = new MutationObserver(function() {
    if (!extAlive()) { observer.disconnect(); return; }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(function() {
        expandJobDescription();
        setTimeout(detectJob, 1000);
      }, 2000);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener(function(message) {
  // Page-level scrape/detect requests are only meaningful in the top frame; ignore them in
  // subframes so an empty subframe result can't overwrite the real one.
  if (!IS_TOP && (message.type === 'DETECT_JOB' || message.type === 'SCAN_JOBS' || message.type === 'SCAN_PEOPLE')) return;
  if (message.type === 'DETECT_JOB') {
    console.log('[Alicia] Manual detect triggered');
    expandJobDescription();
    setTimeout(function() {
      expandJobDescription();
      setTimeout(detectJob, 800);
    }, 500);
  }
  if (message.type === 'SCAN_JOBS') {
    console.log('[Alicia] Scan jobs triggered');
    var jobs = scrapeJobList();
    safeSendMessage({ type: 'JOBS_SCANNED', jobs: jobs });
  }
  if (message.type === 'SCAN_PEOPLE') {
    console.log('[Alicia] Scan people triggered');
    var people = scrapeHiringTeam();
    safeSendMessage({ type: 'PEOPLE_FOUND', people: people });
  }
  if (message.type === 'AUTOFILL_EEO') {
    console.log('[Alicia] Auto-fill EEO triggered (manual)');
    var p = message.prefs && Object.keys(message.prefs).length ? message.prefs : null;
    if (p) {
      autoFillEeo(p);
    } else {
      safeStorageGet('eeoPrefs', function (d) { autoFillEeo(d.eeoPrefs || {}); });
    }
  }
});

// ========== EEO / Demographic Auto-Fill ==========

var EEO_MATCHERS = [
  { patterns: [/\bgender\b/i, /\bsex\b/i], prefKey: 'eeo-gender' },
  { patterns: [/\brace\b/i, /\bethnicit/i], prefKey: 'eeo-race' },
  { patterns: [/\bveteran\b/i, /protected\s+veteran/i], prefKey: 'eeo-veteran' },
  { patterns: [/disabilit/i, /\bdisabled\b/i], prefKey: 'eeo-disability' },
  { patterns: [/authoriz\w*\s*(to)?\s*work/i, /work\s*authoriz/i, /legally\s*(authorized|eligible|entitled)/i, /right\s*to\s*work/i, /eligible\s*to\s*work/i], prefKey: 'eeo-authorization' },
  { patterns: [/sponsor/i, /visa\s*status/i, /require.*sponsor/i, /need.*sponsor/i], prefKey: 'eeo-sponsorship' }
];

function matchEeo(label) {
  if (!label) return null;
  // Sponsorship must win over work-authorization when a label mentions both.
  if (/sponsor/i.test(label)) {
    for (var s = 0; s < EEO_MATCHERS.length; s++) {
      if (EEO_MATCHERS[s].prefKey === 'eeo-sponsorship') return EEO_MATCHERS[s];
    }
  }
  for (var i = 0; i < EEO_MATCHERS.length; i++) {
    for (var p = 0; p < EEO_MATCHERS[i].patterns.length; p++) {
      if (EEO_MATCHERS[i].patterns[p].test(label)) return EEO_MATCHERS[i];
    }
  }
  return null;
}

function normTxt(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Collapse the many ways people phrase "prefer not to answer" into one token.
function canonicalAnswer(s) {
  var n = normTxt(s);
  if (/\b(decline|prefer not|do not wish|dont wish|not to answer|wish not|not wish|not to disclose|prefer not to)\b/.test(n)) return 'declined';
  return n;
}

function matchScore(optText, desired) {
  var a = canonicalAnswer(optText);
  var b = canonicalAnswer(desired);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 80;
  var at = a.split(' ');
  var bt = b.split(' ');
  var common = 0;
  for (var i = 0; i < bt.length; i++) {
    if (bt[i].length > 2 && at.indexOf(bt[i]) >= 0) common++;
  }
  return bt.length ? (common / bt.length) * 60 : 0;
}

// getRootNode() returns the shadow root when the element lives in a shadow tree, so label[for]
// lookups resolve within the same tree instead of failing against the light document.
function ownerRoot(el) {
  var r = el.getRootNode ? el.getRootNode() : document;
  return (r && r.querySelector) ? r : document;
}

function findLabelText(el) {
  var label = '';
  if (el.id) {
    var lbl = ownerRoot(el).querySelector('label[for="' + el.id + '"]');
    if (lbl) label = getText(lbl);
  }
  if (!label) {
    var parent = el.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, .jobs-easy-apply-form-section__grouping, .artdeco-text-input--container');
    if (parent) {
      var inner = parent.querySelector('label, legend, .fb-dash-form-element__label');
      label = getText(inner) || getText(parent);
    }
  }
  if (!label && el.parentElement) label = getText(el.parentElement);
  return label;
}

function selectBestOption(selectEl, desiredValue) {
  if (!desiredValue) return false;
  var options = selectEl.querySelectorAll('option');
  var best = null, bestScore = 0;
  for (var i = 0; i < options.length; i++) {
    var v = (options[i].value || '').toLowerCase();
    if (!options[i].value || v === 'select an option' || v === '') continue;
    var sc = Math.max(matchScore(options[i].textContent, desiredValue), matchScore(options[i].value, desiredValue));
    if (sc > bestScore) { bestScore = sc; best = options[i]; }
  }
  if (best && bestScore >= 45) {
    selectEl.value = best.value;
    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

function radioLabelText(radio) {
  var label = '';
  var wrap = radio.closest('label');
  if (wrap) label = getText(wrap);
  if (!label && radio.id) {
    var lblEl = ownerRoot(radio).querySelector('label[for="' + radio.id + '"]');
    if (lblEl) label = getText(lblEl);
  }
  if (!label) label = radio.value || '';
  return label;
}

function clickBestRadio(container, desiredValue) {
  if (!desiredValue) return false;
  var radios = container.querySelectorAll('input[type="radio"]');
  var best = null, bestScore = 0;
  for (var i = 0; i < radios.length; i++) {
    var sc = matchScore(radioLabelText(radios[i]), desiredValue);
    if (sc > bestScore) { bestScore = sc; best = radios[i]; }
  }
  if (best && bestScore >= 45) {
    if (!best.checked) {
      best.checked = true;
      best.dispatchEvent(new Event('click', { bubbles: true }));
      best.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }
  return false;
}

// Set a value on a React/Ember-controlled text input so the framework registers it.
function setNativeValue(el, value) {
  var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) { setter.set.call(el, value); }
  else { el.value = value; }
}

function fillTextInput(inputEl, desiredValue) {
  if (!desiredValue) return false;
  if (inputEl.value && inputEl.value.trim()) return false; // don't clobber what's already there
  setNativeValue(inputEl, desiredValue);
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function autoFillEeo(prefs) {
  if (!prefs || Object.keys(prefs).length === 0) {
    safeSendMessage({ type: 'EEO_FILL_RESULT', filled: 0 });
    return;
  }
  var filled = 0;
  var handled = [];

  // Process each question container so we can pick the right control type per question.
  // Search light DOM + shadow roots (the Easy Apply modal lives in a shadow tree).
  var containers = [];
  easyApplySearchRoots().forEach(function (root) {
    root.querySelectorAll('.fb-dash-form-element, .jobs-easy-apply-form-element, .jobs-easy-apply-form-section__grouping, fieldset').forEach(function (c) { containers.push(c); });
  });
  containers.forEach(function (container) {
    if (handled.indexOf(container) >= 0) return;
    if (!container.getClientRects().length) return; // hidden step — don't fill yet
    var label = getText(container.querySelector('label, legend, .fb-dash-form-element__label')) || getText(container).slice(0, 220);
    var matcher = matchEeo(label);
    if (!matcher) return;
    var value = prefs[matcher.prefKey];
    if (!value) return;

    var sel = container.querySelector('select');
    if (sel) {
      if (selectBestOption(sel, value)) { filled++; handled.push(container); console.log('[Alicia] Filled select:', label, '->', value); }
      return;
    }
    var radios = container.querySelectorAll('input[type="radio"]');
    if (radios.length) {
      if (clickBestRadio(container, value)) { filled++; handled.push(container); console.log('[Alicia] Filled radio:', label, '->', value); }
      return;
    }
    var text = container.querySelector('input[type="text"], input:not([type]), input[type="search"], textarea');
    if (text) {
      if (fillTextInput(text, value)) { filled++; handled.push(container); console.log('[Alicia] Filled text:', label, '->', value); }
      return;
    }
  });

  // Fallback: any stray <select> not inside a recognized container (across all roots).
  easyApplySearchRoots().forEach(function (root) {
    root.querySelectorAll('select').forEach(function (sel) {
      if (handled.some(function (c) { return c.contains(sel); })) return;
      var matcher = matchEeo(findLabelText(sel));
      if (!matcher) return;
      var value = prefs[matcher.prefKey];
      if (value && selectBestOption(sel, value)) { filled++; console.log('[Alicia] Filled stray select'); }
    });
  });

  console.log('[Alicia] Auto-fill complete, filled', filled, 'field(s)');
  safeSendMessage({ type: 'EEO_FILL_RESULT', filled: filled });
}

// Contact fields (name/email/phone/address/links) inside the Easy Apply modal — a separate
// pass from autoFillEeo above, since LinkedIn's own step often mixes contact inputs with EEO
// questions on the same page. Scoped strictly to the modal, same as the auto-advance buttons.
// Shared with the custom-question detector below: any field matching one of these is a known
// contact field, so it must never be swept into the AI-answered "custom question" pipeline
// even when it's empty (e.g. no phone number saved) — an AI shouldn't guess contact info.
var CONTACT_FIELD_MATCHERS = [
  { key: 'email',     test: function (s, el) { return el.type === 'email' || /\bemail\b/.test(s); } },
  { key: 'phone',     test: function (s, el) { return el.type === 'tel' || /\b(phone|mobile|cell|telephone)\b/.test(s); } },
  { key: 'firstName', test: function (s) { return /\b(given name|first name|firstname|fname)\b/.test(s); } },
  { key: 'lastName',  test: function (s) { return /\b(family name|last name|lastname|surname|lname)\b/.test(s); } },
  { key: 'linkedin',  test: function (s) { return /linkedin/.test(s); } },
  { key: 'website',   test: function (s) { return /\b(website|portfolio|personal site)\b/.test(s); } },
  { key: 'city',      test: function (s) { return /\b(address level2|city|town)\b/.test(s); } },
  { key: 'state',     test: function (s) { return /\b(address level1|state|province|region)\b/.test(s); } },
  { key: 'zip',       test: function (s) { return /\b(postal code|postcode|zip)\b/.test(s); } },
  { key: 'fullName',  test: function (s) { return /\bfull name\b/.test(s) || (/\bname\b/.test(s) && !/first|last|given|family|user|company|file|nick|middle|legal/.test(s)); } }
];

function isKnownContactField(s, el) {
  return CONTACT_FIELD_MATCHERS.some(function (m) { return m.test(s, el || {}); });
}

// LinkedIn typeaheads (e.g. "City") reject plain typed text — a suggestion from the dropdown
// must be picked or validation fails on Next. After typing, wait for the listbox and click
// the best-matching visible option.
function isTypeaheadInput(el) {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list';
}

async function resolveTypeaheadSelection(desired) {
  await sleep(900);
  var opts = [];
  document.querySelectorAll('[role="listbox"] [role="option"], .basic-typeahead__selectable, .search-basic-typeahead__option').forEach(function (o) {
    if (o.offsetParent !== null) opts.push(o);
  });
  if (!opts.length) return false;
  var want = normTxt(desired);
  var best = opts[0], bs = -1;
  opts.forEach(function (o) {
    var t = normTxt(getText(o));
    var sc = t.indexOf(want) === 0 ? 2 : (t.indexOf(want) >= 0 ? 1 : 0);
    if (sc > bs) { bs = sc; best = o; }
  });
  ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
    best.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
  });
  await sleep(250);
  return true;
}

async function autoFillContactFields(profile) {
  if (!profile || Object.keys(profile).length === 0) return 0;
  var modal = findEasyApplyModal();
  if (!modal) return 0;

  var values = {
    email: profile.email, phone: profile.phone, firstName: profile.firstName, lastName: profile.lastName,
    linkedin: profile.linkedin, website: profile.website, city: profile.city, state: profile.state, zip: profile.zip,
    fullName: [profile.firstName, profile.lastName].filter(Boolean).join(' ')
  };

  var filled = 0;
  var inputs = modal.querySelectorAll('input, textarea');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    var ty = (el.type || '').toLowerCase();
    if (['hidden', 'password', 'file', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'search'].indexOf(ty) >= 0) continue;
    if (el.disabled || el.readOnly) continue;
    if (el.value && el.value.trim()) continue;
    if (el.offsetParent === null) continue;
    var s = normTxt([el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), findLabelText(el)].filter(Boolean).join(' '));
    if (!s) continue;
    for (var f = 0; f < CONTACT_FIELD_MATCHERS.length; f++) {
      var m = CONTACT_FIELD_MATCHERS[f];
      if (values[m.key] && m.test(s, el)) {
        setNativeValue(el, values[m.key]);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (isTypeaheadInput(el)) await resolveTypeaheadSelection(values[m.key]);
        filled++;
        break;
      }
    }
  }
  if (filled) console.log('[Alicia] Auto-filled', filled, 'contact field(s) in Easy Apply');
  return filled;
}

// NOTE: on LinkedIn the resume step is left entirely to the user — LinkedIn stores the user's
// resumes and pre-selects the most recent, and auto-attaching/selecting here caused a second
// document to be chosen and errored the Next step. So there is no resume-attach on LinkedIn;
// external-ATS resume upload lives in autofill.js.

// ========== Custom question answering + learning ==========
// Questions that are neither EEO nor contact fields — "years of experience with X", "why this
// role", availability, etc. First checked against previously-confirmed answers (learned from
// Alicia's own edits on past applications); anything left over goes to one batched AI call.
// AI-answered questions pause auto-advance so Alicia reviews/edits before the click that
// actually saves the (possibly-corrected) answer into the learned bank — see
// tryAutoAdvanceEasyApply and attachAnswerCapture below.

var CUSTOM_QA_MATCH_THRESHOLD = 65;
var CUSTOM_QA_MAX_PER_STEP = 6;
var pendingReviewModal = null;

// Common filler words stripped before comparing questions, so "How many years of experience
// do you have with Python?" and "Years of experience with Python?" are recognized as the same
// question (denominator uses the SHORTER question's token count so a trimmed rephrasing still
// scores high, rather than being penalized for being shorter).
var QUESTION_STOPWORDS = ['a', 'an', 'the', 'is', 'are', 'do', 'you', 'your', 'of', 'with', 'for', 'to', 'in', 'on', 'and', 'have', 'has', 'this', 'that', 'what', 'how', 'many', 'will', 'would', 'can', 'could', 'please', 'describe', 'did', 'does'];

function questionContentTokens(s) {
  return normTxt(s).split(' ').filter(function (w) { return w.length > 2 && QUESTION_STOPWORDS.indexOf(w) === -1; });
}

function questionSimilarity(a, b) {
  var na = normTxt(a), nb = normTxt(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0) return 90; // one fully contains the other
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
  safeStorageGet('customQA', function (data) {
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
    if (bank.length > 300) bank = bank.slice(bank.length - 300); // sane cap
    safeStorageSet({ customQA: bank });
  });
}

function applyAnswerToItem(item, answerText) {
  if (!answerText) return false;
  if (item.type === 'select') return selectBestOption(item.control, answerText);
  if (item.type === 'radio') return clickBestRadio(item.container, answerText);
  return fillTextInput(item.control, answerText);
}

// Resume / cover-letter / document selection steps must be left entirely alone: LinkedIn
// pre-selects the user's most-recent resume, and any auto-selection here risks picking two
// documents (which errors out on Next). Recognize these by label/module and skip them.
function isResumeOrDocControl(label, container) {
  if (/\bresume\b|\bcv\b|curriculum vitae|cover letter|upload (a )?(document|file)|choose (a )?(resume|file)/i.test(label || '')) return true;
  if (container && container.closest && container.closest('[class*="jobs-document-upload"], [class*="document-upload"], [class*="resume"]')) return true;
  return false;
}

// Every custom question on the step (neither EEO nor contact nor resume/doc). With
// includeAnswered=false → only the empty ones (what still needs filling); with
// includeAnswered=true → all of them, including ones already filled, so their final values can
// be banked for future applications ("note and save every question and dropdown").
function findCustomQuestions(modal, includeAnswered) {
  var out = [];
  var containers = Array.prototype.slice.call(modal.querySelectorAll(
    '.fb-dash-form-element, .jobs-easy-apply-form-element, .jobs-easy-apply-form-section__grouping, fieldset'
  ));
  // Class-independent fallback (ATS-powered forms in the /preload iframe don't use LinkedIn's
  // form classes): treat each <label>'s nearest block as a question container.
  if (!containers.length) {
    modal.querySelectorAll('label').forEach(function (l) {
      var c = l.closest('fieldset, li, section, div');
      if (c && containers.indexOf(c) === -1 && !containers.some(function (p) { return p.contains(c) || c.contains(p); })) containers.push(c);
    });
  }
  containers.forEach(function (container) {
    if (out.length >= CUSTOM_QA_MAX_PER_STEP) return;
    if (!container.getClientRects().length) return;    // hidden step / conditional question — not active
    var label = getText(container.querySelector('label, legend, .fb-dash-form-element__label')) || getText(container).slice(0, 220);
    if (!label || label.length < 3) return;
    if (matchEeo(label)) return;                       // demographic/EEO — never AI-answered or banked here
    if (isResumeOrDocControl(label, container)) return; // resume/cover-letter selection — leave to LinkedIn

    var sel = container.querySelector('select');
    var radios = container.querySelectorAll('input[type="radio"]');
    var text = container.querySelector('input[type="text"], input:not([type]), input[type="search"], input[type="number"], textarea');

    if (isKnownContactField(normTxt(label), text)) return; // handled by autoFillContactFields

    if (sel) {
      if (!includeAnswered && sel.value) return;
      var options = [];
      for (var o = 0; o < sel.options.length; o++) { if (sel.options[o].value) options.push(getText(sel.options[o]) || sel.options[o].value); }
      if (options.length) out.push({ container: container, control: sel, type: 'select', label: label, options: options });
    } else if (radios.length) {
      var anyChecked = Array.prototype.some.call(radios, function (r) { return r.checked; });
      if (!includeAnswered && anyChecked) return;
      var ropts = Array.prototype.map.call(radios, radioLabelText);
      out.push({ container: container, control: null, type: 'radio', label: label, options: ropts });
    } else if (text && text.offsetParent !== null) {
      if (!includeAnswered && text.value && text.value.trim()) return;
      out.push({ container: container, control: text, type: (text.tagName === 'TEXTAREA' ? 'textarea' : 'text'), label: label, options: [] });
    }
  });
  return out;
}

// Back-compat alias — the empties are what handleCustomQuestions needs to fill.
function findUnansweredCustomQuestions(modal) {
  return findCustomQuestions(modal, false);
}

// Bank the current value of EVERY custom question/dropdown on the step (not just ones Alicia
// answered) so manually-filled answers and dropdown selections are remembered next time.
function bankAllCustomAnswers(modal) {
  findCustomQuestions(modal, true).forEach(function (item) {
    var v = itemIsAnswered(item)
      ? (item.type === 'select' ? item.control.value
         : item.type === 'radio' ? (item.container.querySelector('input[type="radio"]:checked') ? radioLabelText(item.container.querySelector('input[type="radio"]:checked')) : '')
         : (item.control && item.control.value))
      : '';
    if (v && String(v).trim()) upsertLearnedAnswer(item.label, String(v).trim(), item.type, item.options);
  });
}

function parseCustomAnswersJson(raw) {
  var clean = stripThinkingTags(raw).replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { var v = JSON.parse(clean); if (Array.isArray(v)) return v; } catch (e) {}
  var m = clean.match(/\[[\s\S]*\]/);
  if (m) { try { var v2 = JSON.parse(m[0]); if (Array.isArray(v2)) return v2; } catch (e2) {} }
  return [];
}

async function callCustomAnswerBackend(items, job, resumeText) {
  var sys = 'You are Alicia, helping fill out a real job application truthfully using the candidate\'s resume. You are given the job, the resume, and a numbered list of application questions. Some are multiple choice — you MUST answer with one of the exact option strings given, verbatim. Free-text questions get a short, professional answer (1-2 sentences, or just a number for a numeric question) based only on facts in the resume — never invent employers, dates, skills, or credentials that are not in it. If you cannot reasonably answer from the resume, give the most conservative reasonable answer. Respond ONLY with a strict JSON array, no markdown fences, no prose: [{"i":<question number, 1-based>,"answer":"<answer text>"}]';
  var qLines = items.map(function (it, i) {
    var typeLabel = (it.type === 'select' || it.type === 'radio')
      ? ('[choose one: ' + it.options.join(' | ') + ']')
      : (it.type === 'textarea' ? '[short paragraph]' : '[short answer]');
    return (i + 1) + '. ' + typeLabel + ' ' + it.label;
  }).join('\n');
  var user = 'Job Title: ' + (job && job.title || '') + '\nCompany: ' + (job && job.company || '') +
    '\n\nJob Description:\n' + (job && job.description || '') +
    '\n\nCandidate Resume:\n' + (resumeText || '').slice(0, 6000) +
    '\n\nQuestions:\n' + qLines;
  var text = await fetchBackendText(sys, user);
  return parseCustomAnswersJson(text);
}

function safeStorageGetAsync(keys) {
  return new Promise(function (resolve) {
    if (!extAlive()) { resolve({}); return; }
    try { chrome.storage.local.get(keys, function (data) { resolve(data || {}); }); } catch (e) { resolve({}); }
  });
}

var customQuestionsResolving = false;

async function handleCustomQuestions(modal) {
  if (customQuestionsResolving) return; // a previous call for this cycle is still in flight
  var items = findUnansweredCustomQuestions(modal);
  // Questions already registered for learn-on-Next are being handled by the human right now —
  // don't re-run the AI or re-banner for them on every mutation cycle.
  var alreadyPending = (modal.__aliciaLearnItems || []).map(function (it) { return it.label; });
  items = items.filter(function (it) { return alreadyPending.indexOf(it.label) === -1; });
  if (!items.length) return;

  customQuestionsResolving = true;
  try {
    var data = await safeStorageGetAsync('customQA');
    var bank = Array.isArray(data.customQA) ? data.customQA : [];
    var remaining = [];
    items.forEach(function (item) {
      var learned = findLearnedAnswer(bank, item.label);
      if (learned && applyAnswerToItem(item, learned.answer)) {
        learned.lastUsedAt = Date.now();
      } else {
        remaining.push(item);
      }
    });
    safeStorageSet({ customQA: bank }); // persist lastUsedAt bumps
    if (!remaining.length) return;

    // Try the AI on what the learned bank couldn't cover (needs a saved resume to reason from).
    var answeredAny = false;
    var rdata = await safeStorageGetAsync('resumeText');
    var resumeText = rdata && rdata.resumeText;
    if (resumeText) {
      try {
        var answers = await callCustomAnswerBackend(remaining, lastDetectedJob, resumeText);
        var byIndex = {};
        answers.forEach(function (a) { if (a && typeof a.i === 'number') byIndex[a.i] = a.answer; });
        remaining.forEach(function (item, i) {
          var answer = byIndex[i + 1];
          if (answer && applyAnswerToItem(item, answer)) answeredAny = true;
        });
      } catch (aiErr) {
        console.log('[Alicia] AI answer call failed, falling back to ask-the-human:', aiErr);
      }
    }

    // Anything still empty is a question Alicia has never seen and couldn't answer — the
    // Jobright loop: STOP auto-advance, ask the human to fill it in, and bank whatever they
    // typed the moment they click Next, so next time it fills automatically.
    var needHuman = remaining.filter(function (item) { return !itemIsAnswered(item); });

    if (answeredAny || needHuman.length) {
      pendingReviewModal = modal;
      modal.__aliciaPendingMsg = needHuman.length
        ? ('New question' + (needHuman.length === 1 ? '' : 's') + ' here (' + needHuman.length + ') — fill in and click Next. Alicia will remember your answer' + (needHuman.length === 1 ? '' : 's') + ' for next time.')
        : 'Alicia answered a question here — please review before clicking Next.';
      showEasyApplyBanner(modal.__aliciaPendingMsg, '#e0a800');
    }
  } catch (err) {
    console.log('[Alicia] Custom question answer error:', err);
  } finally {
    customQuestionsResolving = false;
  }
}

function itemIsAnswered(item) {
  if (item.type === 'select') return !!(item.control && item.control.value);
  if (item.type === 'radio') return !!item.container.querySelector('input[type="radio"]:checked');
  return !!(item.control && item.control.value && item.control.value.trim());
}

// Attached once per modal (delegated + capture-phase so it survives LinkedIn re-rendering the
// footer). On any Next/Continue/Review/Submit click — whether Alicia's auto-advance clicked it
// or the human did — bank the final value of EVERY custom question/dropdown on the step. This
// captures answers Alicia generated, ones the human typed/corrected, AND ones LinkedIn or the
// human filled that Alicia never flagged — so future applications recognize them all.
function attachAnswerCapture(modal) {
  if (modal.__aliciaCaptureAttached) return;
  modal.__aliciaCaptureAttached = true;
  modal.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn) return;
    var t = normTxt((btn.getAttribute('aria-label') || '') + ' ' + (btn.innerText || btn.textContent || ''));
    var isAction = EASY_APPLY_ADVANCE_PATTERNS.concat(EASY_APPLY_SUBMIT_PATTERNS).some(function (p) { return p.test(t); });
    if (!isAction) return;
    bankAllCustomAnswers(modal);
    if (pendingReviewModal === modal) pendingReviewModal = null;
  }, true);
}

// ========== Easy Apply auto-advance ==========
// Fills each step, then clicks "Next" / "Continue to next step" / "Review your application"
// to move forward automatically. It STOPS the instant it sees a Submit button and never
// clicks it — a human always makes the final call on submitting a real application. This is
// an allowlist (only recognized advance-button text is clicked), not a denylist that tries to
// exclude "submit" — if LinkedIn shows button text we don't recognize, we do nothing rather
// than risk clicking it.
var EASY_APPLY_ADVANCE_PATTERNS = [/^next$/, /^review$/, /continue to next step/, /review your application/, /save and continue/];
var EASY_APPLY_SUBMIT_PATTERNS = [/submit application/, /submit your application/];
var MAX_AUTO_ADVANCES = 15;
var autoAdvanceModal = null;
var autoAdvanceCount = 0;
var autoAdvanceBusy = false;

// LinkedIn now renders the Easy Apply modal inside a SHADOW DOM attached to a host element
// (observed: <div id="interop-outlet">). Shadow trees are invisible to document.querySelector,
// which is why every field/button lookup used to come up empty. These helpers collect the
// searchable roots (the light document + every shadow root) so the rest of the code can find
// and drive the modal wherever LinkedIn puts it. Fast path first for the known host; otherwise
// a bounded walk discovers any shadow roots (LinkedIn currently has just one).
function collectShadowRoots() {
  var roots = [];
  var known = document.getElementById('interop-outlet');
  if (known && known.shadowRoot) roots.push(known.shadowRoot);
  try {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var sr = all[i].shadowRoot;
      if (sr && roots.indexOf(sr) === -1) {
        roots.push(sr);
        // one level of nesting is plenty for LinkedIn; guard cost on huge pages
        var inner = sr.querySelectorAll('*');
        for (var j = 0; j < inner.length; j++) {
          if (inner[j].shadowRoot && roots.indexOf(inner[j].shadowRoot) === -1) roots.push(inner[j].shadowRoot);
        }
      }
    }
  } catch (e) {}
  return roots;
}

// All roots to search for the Easy Apply UI: the light DOM plus any shadow roots.
function easyApplySearchRoots() {
  return [document].concat(collectShadowRoots());
}

function findEasyApplyForm() {
  var roots = easyApplySearchRoots();
  for (var i = 0; i < roots.length; i++) {
    var form = roots[i].querySelector('.jobs-easy-apply-content, .jobs-apply-form, form.jobs-easy-apply-form, .jobs-easy-apply-modal form, div[data-test-modal-id*="easy-apply"] form');
    if (form) return form;
  }
  return null;
}

// Scope button search to the Easy Apply modal itself — never the whole document — so this
// can't reach into an unrelated LinkedIn modal (e.g. a "Save this job" confirmation) and click
// something unintended. LinkedIn churns class names, so after the known classes fail, fall
// back to any open dialog that announces itself as an apply flow AND contains form controls.
// After Submit, LinkedIn shows a confirmation ("Your application was sent") often followed by a
// "follow this company?" prompt. Alicia must stop touching the screen and wait for a new job +
// Easy Apply. Detect that end state and treat it as "no apply form" so nothing is filled or
// clicked until a fresh application form (with an advance/submit button) appears.
function isPostSubmitConfirmation(modal) {
  var txt = normTxt(getText(modal)).slice(0, 500);
  var sent = /(application sent|your application was sent|application was submitted|application submitted|you applied|applied on|your application is on its way|done applying)/.test(txt);
  var followPrompt = /(follow .* to stay|stay up to date|want to follow|following)/.test(txt) && !/first name|email|phone/.test(txt);
  if (!sent && !followPrompt) return false;
  // Only a confirmation if there is nothing left to fill/advance/submit.
  if (findModalButton(modal, EASY_APPLY_SUBMIT_PATTERNS)) return false;
  if (findModalButton(modal, EASY_APPLY_ADVANCE_PATTERNS)) return false;
  return true;
}

function findEasyApplyModal() {
  var raw = findEasyApplyModalRaw();
  if (raw && isPostSubmitConfirmation(raw)) return null; // submitted — wait for a new application
  return raw;
}

function findEasyApplyModalRaw() {
  var form = findEasyApplyForm();
  if (form) return form.closest('.artdeco-modal, [role="dialog"]') || form;
  var roots = easyApplySearchRoots();
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r];
    var modals = root.querySelectorAll('.artdeco-modal, div[role="dialog"]');
    for (var i = 0; i < modals.length; i++) {
      var m = modals[i];
      if (m.offsetParent === null) continue;
      var head = m.querySelector('h1, h2, h3');
      var label = ((m.getAttribute('aria-label') || '') + ' ' + (head ? getText(head) : '')).toLowerCase();
      if (label.indexOf('apply') >= 0 && m.querySelector('form, input, select, textarea')) return m;
    }
  }
  // Class-independent fallback: find the "Apply to <company>" heading, then walk up to the
  // smallest ancestor that actually holds the form controls + a button, and treat that as the
  // modal. Searched across shadow roots too.
  for (var r2 = 0; r2 < roots.length; r2++) {
    var heads = roots[r2].querySelectorAll('h1, h2, h3, [role="heading"]');
    for (var hI = 0; hI < heads.length; hI++) {
      var h = heads[hI];
      if (h.offsetParent === null) continue;
      var ht = getText(h).toLowerCase();
      if (!/^apply to\b|^application\b|easy apply|complete your application/.test(ht)) continue;
      var node = h.parentElement;
      for (var up = 0; up < 8 && node && node.nodeType === 1; up++) {
        if (node.querySelector('input, select, textarea') && node.querySelector('button, [role="button"]')) {
          return node;
        }
        node = node.parentElement;
      }
    }
  }
  // Subframe fallback: LinkedIn hosts ATS-powered application forms in a same-origin
  // linkedin.com/preload iframe where the "Apply to <company>" heading lives in the PARENT
  // frame and only the fields live here — so no heading match above. If this frame isn't the
  // top frame, its text reads like an application, and it holds fillable fields, treat the whole
  // document as the modal. Text gate keeps this off unrelated same-origin frames (chat, ads).
  if (!IS_TOP && document.body) {
    var docText = (document.body.innerText || '').toLowerCase();
    var looksApply = /application|apply to|submit application|contact info|resume|cover letter|work authoriz|eeo|voluntary self/.test(docText);
    var fields = document.querySelectorAll('input:not([type="hidden"]):not([type="search"]):not([type="submit"]):not([type="button"]), select, textarea');
    if (looksApply && fields.length >= 2) {
      console.log('[Alicia] Treating subframe document as the application form (', fields.length, 'fields )');
      return document.body;
    }
  }
  return null;
}

function findModalButton(modal, patterns) {
  var buttons = modal.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    var btn = buttons[i];
    if (btn.disabled || btn.offsetParent === null) continue;
    var t = normTxt((btn.getAttribute('aria-label') || '') + ' ' + (btn.innerText || btn.textContent || ''));
    for (var p = 0; p < patterns.length; p++) { if (patterns[p].test(t)) return btn; }
  }
  return null;
}

function hasVisibleValidationError(modal) {
  var errs = modal.querySelectorAll('.artdeco-inline-feedback--error, [role="alert"]');
  for (var i = 0; i < errs.length; i++) {
    if (errs[i].offsetParent !== null && getText(errs[i])) return true;
  }
  return false;
}

function showEasyApplyBanner(text, color) {
  var el = document.getElementById('alicia-apply-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'alicia-apply-banner';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:10px 16px;border-radius:8px;color:#fff;font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:320px;cursor:pointer;';
    el.title = 'Click to dismiss';
    el.onclick = function () { el.remove(); };
    document.body.appendChild(el);
  }
  el.style.background = color;
  el.textContent = text;
  clearTimeout(el.hideTimer);
  el.hideTimer = setTimeout(function () { if (el.parentNode) el.remove(); }, 12000);
}

function tryAutoAdvanceEasyApply() {
  if (autoAdvanceBusy) return;
  safeStorageGet('autoAdvanceEasyApply', function (data) {
    if (data.autoAdvanceEasyApply === false) return; // opted out in the side panel

    var modal = findEasyApplyModal();
    if (!modal) { autoAdvanceModal = null; autoAdvanceCount = 0; pendingReviewModal = null; return; }
    if (modal !== autoAdvanceModal) { autoAdvanceModal = modal; autoAdvanceCount = 0; }

    // Alicia answered a custom question on this step — wait for her to review/edit and click
    // Next herself (that click is what confirms the answer and saves it to the learned bank).
    if (pendingReviewModal === modal) {
      showEasyApplyBanner(modal.__aliciaPendingMsg || 'Alicia answered a question here — please review before clicking Next.', '#e0a800');
      return;
    }

    // Never click this — reaching it means the application is ready for a human to submit.
    if (findModalButton(modal, EASY_APPLY_SUBMIT_PATTERNS)) {
      showEasyApplyBanner('Filled and ready — review, then click Submit yourself.', '#4caf50');
      return;
    }

    if (autoAdvanceCount >= MAX_AUTO_ADVANCES) return; // safety cap against an unexpected loop

    if (hasVisibleValidationError(modal)) {
      showEasyApplyBanner('This step needs your input before Alicia can continue.', '#e0a800');
      return;
    }

    var nextBtn = findModalButton(modal, EASY_APPLY_ADVANCE_PATTERNS);
    if (nextBtn) {
      autoAdvanceBusy = true;
      autoAdvanceCount++;
      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      setTimeout(function () { autoAdvanceBusy = false; }, 400);
    }
  });
}

// Auto-fill whenever an application form / modal appears, debounced so step changes re-fill.
var autofillTimer = null;
var autofillPassRunning = false;
function scheduleAutoFill() {
  if (autofillTimer) clearTimeout(autofillTimer);
  autofillTimer = setTimeout(function () {
    if (autofillPassRunning) { scheduleAutoFill(); return; } // don't overlap passes
    autofillPassRunning = true;
    safeStorageGet(['eeoPrefs', 'profile'], function (data) {
      // Strictly sequential: fill everything (including async typeahead picks and any AI
      // custom-question call) BEFORE ever checking whether to auto-advance — otherwise
      // Next could be clicked while a fill on this same step is still resolving.
      (async function () {
        try {
          if (data.eeoPrefs && Object.keys(data.eeoPrefs).length > 0) autoFillEeo(data.eeoPrefs);
          if (data.profile && Object.keys(data.profile).length > 0) await autoFillContactFields(data.profile);
          var modal = findEasyApplyModal();
          if (modal) {
            attachAnswerCapture(modal); // bank every question/dropdown on this step when it advances
            // NOTE: on LinkedIn we intentionally do NOT attach a resume file — the user's saved
            // resumes are managed by LinkedIn (it pre-selects the most recent). Auto-attaching
            // caused a second document to get selected and errored the Next step. External ATS
            // resume upload is handled separately in autofill.js.
            await handleCustomQuestions(modal);
          }
        } catch (e) {
          console.log('[Alicia] Autofill pass error:', e);
        } finally {
          autofillPassRunning = false;
          setTimeout(tryAutoAdvanceEasyApply, 400);
        }
      })();
    });
  }, 700);
}

// Some "Easy Apply" postings actually embed the employer's real ATS page (Lever, Greenhouse,
// etc.) in a cross-origin iframe layered on top of the LinkedIn page, instead of showing
// LinkedIn's own native Easy Apply form. This script can't see or fill inside that iframe at
// all (cross-origin), but it CAN notice the iframe exists and ask background.js to inject the
// autofill engine directly into it. Debounced and de-duplicated by src so one modal doesn't
// spam repeated injection requests while its iframe re-renders.
var seenAtsIframeSrcs = {};
function maybeCheckAtsIframe() {
  // Scan the WHOLE page (not just inside a known modal — LinkedIn's apply flows aren't always
  // an .artdeco-modal) for a visibly-sized cross-origin iframe. That's the embedded employer
  // ATS form (Lever/Greenhouse/etc.); this script can't reach into it across origins, so ask
  // background.js to inject the fill engine directly into that frame. De-duplicated by src so
  // one form isn't injected repeatedly; small tracking/ad iframes are skipped by size.
  var iframes = document.querySelectorAll('iframe[src]');
  for (var i = 0; i < iframes.length; i++) {
    var f = iframes[i];
    var src = f.src || '';
    if (!src || /(^|\.)linkedin\.com|licdn\.com|about:blank|google|doubleclick|ads/i.test(src)) continue;
    if (f.offsetParent === null || f.offsetWidth < 250 || f.offsetHeight < 200) continue;
    if (seenAtsIframeSrcs[src]) continue;
    seenAtsIframeSrcs[src] = true;
    console.log('[Alicia] Cross-origin application iframe detected, asking background to fill it:', src);
    safeSendMessage({ type: 'CHECK_ATS_IFRAME' });
  }
}

var applyObserver = new MutationObserver(function () {
  if (!extAlive()) { applyObserver.disconnect(); return; }
  if (findEasyApplyModal()) scheduleAutoFill();
  if (IS_TOP) maybeCheckAtsIframe(); // only the top frame scans for cross-origin employer iframes
});
applyObserver.observe(document.body, { childList: true, subtree: true });

// The Easy Apply modal lives in a SHADOW ROOT, and mutations inside a shadow tree are NOT seen
// by a MutationObserver on the light DOM — so the observer above never fires when the modal
// opens or changes steps. Poll as the reliable trigger. Cheap: findEasyApplyModal short-circuits
// on the known host, and scheduleAutoFill is debounced + guarded against overlapping passes.
setInterval(function () {
  if (!extAlive()) return;
  if (findEasyApplyModal()) scheduleAutoFill();
  // Re-assert the match badge if LinkedIn re-rendered the top card and wiped it (uses the
  // cached score — no extra backend calls; initial scoring stays driven by detectJob).
  if (IS_TOP && lastDetectedJob && !document.getElementById('alicia-match-overlay')) {
    var cached = matchScoreCache[matchJobKey(lastDetectedJob)];
    if (cached) renderMatchOverlay('done', cached);
  }
}, 1200);

// The form may already be fully present when this script arrives (prebuilt shadow tree / an
// iframe that never mutates) — kick one pass on load.
setTimeout(function () { if (findEasyApplyModal()) scheduleAutoFill(); }, 800);

})();
