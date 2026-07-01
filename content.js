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
    chrome.runtime.sendMessage({ type: 'JOB_DETECTED', job: job }).catch(function() {});
    if (title && description) maybeShowMatchOverlay(job);
    return true;
  }
  return false;
}

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
// JS context and can't call into the side panel, so the NDJSON-stream client is duplicated here.
async function callMatchBackend(job, resumeText) {
  var sys = 'You are Alicia, a resume-to-job matching engine. Compare the candidate resume to the job posting. Respond ONLY with strict JSON, no markdown fences, no prose: {"score":<0-100 integer, overall fit>,"matched":[<up to 8 short keywords/skills from the job that the resume clearly covers>],"missing":[<up to 8 short keywords/skills the job wants that the resume does not clearly show>],"summary":"<one sentence on the overall fit>"}';
  var user = 'Job Title: ' + (job.title || '') + '\nCompany: ' + (job.company || '') + '\n\nJob Description:\n' + (job.description || '') + '\n\nCandidate Resume:\n' + resumeText.slice(0, 6000);
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
  return document.querySelector(
    '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1.t-24.t-bold, h1.t-24, h2.top-card-layout__title'
  );
}

function toggleMatchOverlayDetails(badgeEl, result) {
  var existing = document.getElementById('alicia-match-details');
  if (existing) { existing.remove(); if (existing.__forBadge === badgeEl) return; }

  var panel = document.createElement('div');
  panel.id = 'alicia-match-details';
  panel.__forBadge = badgeEl;
  panel.style.cssText = 'margin:6px 0 10px;padding:10px 12px;border-radius:8px;background:#20203a;color:#e6e6f0;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;';

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
  if (!anchor) return;
  var el = document.getElementById('alicia-match-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'alicia-match-overlay';
    anchor.insertAdjacentElement('afterend', el);
  }
  el.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:8px 0;padding:5px 12px;border-radius:20px;font:600 12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;cursor:default;user-select:none;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);';

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
  chrome.storage.local.get('resumeText', function (data) {
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
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(function() {
      expandJobDescription();
      setTimeout(detectJob, 1000);
    }, 2000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener(function(message) {
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
    chrome.runtime.sendMessage({ type: 'JOBS_SCANNED', jobs: jobs }).catch(function() {});
  }
  if (message.type === 'SCAN_PEOPLE') {
    console.log('[Alicia] Scan people triggered');
    var people = scrapeHiringTeam();
    chrome.runtime.sendMessage({ type: 'PEOPLE_FOUND', people: people }).catch(function() {});
  }
  if (message.type === 'AUTOFILL_EEO') {
    console.log('[Alicia] Auto-fill EEO triggered (manual)');
    var p = message.prefs && Object.keys(message.prefs).length ? message.prefs : null;
    if (p) {
      autoFillEeo(p);
    } else {
      chrome.storage.local.get('eeoPrefs', function (d) { autoFillEeo(d.eeoPrefs || {}); });
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

function findLabelText(el) {
  var label = '';
  if (el.id) {
    var lbl = document.querySelector('label[for="' + el.id + '"]');
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
    var lblEl = document.querySelector('label[for="' + radio.id + '"]');
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
    chrome.runtime.sendMessage({ type: 'EEO_FILL_RESULT', filled: 0 }).catch(function () {});
    return;
  }
  var filled = 0;
  var handled = [];

  // Process each question container so we can pick the right control type per question.
  var containers = document.querySelectorAll(
    '.fb-dash-form-element, .jobs-easy-apply-form-element, .jobs-easy-apply-form-section__grouping, fieldset'
  );
  containers.forEach(function (container) {
    if (handled.indexOf(container) >= 0) return;
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

  // Fallback: any stray <select> not inside a recognized container.
  document.querySelectorAll('select').forEach(function (sel) {
    if (handled.some(function (c) { return c.contains(sel); })) return;
    var matcher = matchEeo(findLabelText(sel));
    if (!matcher) return;
    var value = prefs[matcher.prefKey];
    if (value && selectBestOption(sel, value)) { filled++; console.log('[Alicia] Filled stray select'); }
  });

  console.log('[Alicia] Auto-fill complete, filled', filled, 'field(s)');
  chrome.runtime.sendMessage({ type: 'EEO_FILL_RESULT', filled: filled }).catch(function () {});
}

// ========== Easy Apply auto-advance ==========
// Fills each step, then clicks "Next" / "Continue to next step" / "Review your application"
// to move forward automatically. It STOPS the instant it sees a Submit button and never
// clicks it — a human always makes the final call on submitting a real application. This is
// an allowlist (only recognized advance-button text is clicked), not a denylist that tries to
// exclude "submit" — if LinkedIn shows button text we don't recognize, we do nothing rather
// than risk clicking it.
var EASY_APPLY_ADVANCE_PATTERNS = [/^next$/, /continue to next step/, /review your application/, /save and continue/];
var EASY_APPLY_SUBMIT_PATTERNS = [/submit application/, /submit your application/];
var MAX_AUTO_ADVANCES = 15;
var autoAdvanceModal = null;
var autoAdvanceCount = 0;
var autoAdvanceBusy = false;

function findEasyApplyForm() {
  return document.querySelector('.jobs-easy-apply-content, .jobs-apply-form, form.jobs-easy-apply-form');
}

// Scope button search to the Easy Apply modal itself — never the whole document — so this
// can't reach into an unrelated LinkedIn modal (e.g. a "Save this job" confirmation) and click
// something unintended.
function findEasyApplyModal() {
  var form = findEasyApplyForm();
  if (!form) return null;
  return form.closest('.artdeco-modal') || form;
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
  chrome.storage.local.get('autoAdvanceEasyApply', function (data) {
    if (data.autoAdvanceEasyApply === false) return; // opted out in the side panel

    var modal = findEasyApplyModal();
    if (!modal) { autoAdvanceModal = null; autoAdvanceCount = 0; return; }
    if (modal !== autoAdvanceModal) { autoAdvanceModal = modal; autoAdvanceCount = 0; }

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
function scheduleAutoFill() {
  if (autofillTimer) clearTimeout(autofillTimer);
  autofillTimer = setTimeout(function () {
    chrome.storage.local.get('eeoPrefs', function (data) {
      if (data.eeoPrefs && Object.keys(data.eeoPrefs).length > 0) autoFillEeo(data.eeoPrefs);
      setTimeout(tryAutoAdvanceEasyApply, 400);
    });
  }, 700);
}

var applyObserver = new MutationObserver(function () {
  var form = document.querySelector('.jobs-easy-apply-content, .jobs-apply-form, .artdeco-modal form, form.jobs-easy-apply-form');
  if (form) scheduleAutoFill();
});
applyObserver.observe(document.body, { childList: true, subtree: true });
