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

function getJobTitle() {
  var title = trySelectors([
    '.job-details-jobs-unified-top-card__job-title h1 a',
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title a',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title a',
    '.jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title',
    'h1.t-24.t-bold',
    'h1.t-24',
    'h1.topcard__title',
    'h2.top-card-layout__title',
    '.t-24.t-bold.inline'
  ], 3, 200);
  if (title) { console.log('[Alicia] Title found via selector:', title); return title; }

  try {
    var detailPanels = document.querySelectorAll('.scaffold-layout__detail, .jobs-search__job-details, [class*="job-details"]');
    for (var p = 0; p < detailPanels.length; p++) {
      var h1 = detailPanels[p].querySelector('h1');
      if (h1) {
        var t = getText(h1);
        if (t.length > 2 && t.length < 200) { console.log('[Alicia] Title found in detail panel h1:', t); return t; }
      }
    }
  } catch (e) {}

  try {
    var h1s = document.querySelectorAll('h1');
    for (var i = 0; i < h1s.length; i++) {
      var t2 = getText(h1s[i]);
      if (t2.length > 3 && t2.length < 200 && t2.indexOf('LinkedIn') === -1 && t2.indexOf('Sign') === -1 && t2.indexOf('Jobs') === -1) {
        var parent = h1s[i].closest('.jobs-search__left-rail, .scaffold-layout__list');
        if (!parent) {
          console.log('[Alicia] Title found via h1 fallback:', t2);
          return t2;
        }
      }
    }
  } catch (e) {}

  try {
    var h1All = document.querySelectorAll('h1');
    for (var j = 0; j < h1All.length; j++) {
      var t3 = getText(h1All[j]);
      if (t3.length > 3 && t3.length < 200 && t3.indexOf('LinkedIn') === -1 && t3.indexOf('Sign') === -1) {
        console.log('[Alicia] Title found via last-resort h1:', t3);
        return t3;
      }
    }
  } catch (e) {}

  console.log('[Alicia] Title NOT found');
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
    var detailPanels = document.querySelectorAll('.scaffold-layout__detail, .jobs-search__job-details, [class*="job-details"]');
    for (var p = 0; p < detailPanels.length; p++) {
      var links = detailPanels[p].querySelectorAll('a[href*="/company/"]');
      for (var i = 0; i < links.length; i++) {
        var t = getText(links[i]);
        if (t.length > 1 && t.length < 100) { console.log('[Alicia] Company found in detail panel:', t); return t; }
      }
    }
  } catch (e) {}

  try {
    var allLinks = document.querySelectorAll('a[href*="/company/"]');
    for (var j = 0; j < allLinks.length; j++) {
      var t2 = getText(allLinks[j]);
      if (t2.length > 1 && t2.length < 100) {
        var parent = allLinks[j].closest('.jobs-search__left-rail, .scaffold-layout__list');
        if (!parent) { console.log('[Alicia] Company found via link fallback:', t2); return t2; }
      }
    }
  } catch (e) {}

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
  if (loc) { console.log('[Alicia] Location found:', loc); return loc; }

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
    var headers = document.querySelectorAll('h2, h3');
    for (var j = 0; j < headers.length; j++) {
      var headerText = getText(headers[j]);
      if (headerText === 'About the job' || headerText === 'Job description' || headerText === 'Description') {
        var section = headers[j].closest('section');
        if (section) {
          var t2 = getText(section);
          if (t2.length > 50) { console.log('[Alicia] Description found via header, length:', t2.length); return t2; }
        }
        var parent = headers[j].parentElement;
        if (parent) {
          var t3 = getText(parent);
          if (t3.length > 50) { console.log('[Alicia] Description found via header parent, length:', t3.length); return t3; }
        }
      }
    }
  } catch (e) {}

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
    chrome.runtime.sendMessage({
      type: 'JOB_DETECTED',
      job: { title: title, company: company, location: location, description: description, url: window.location.href, detectedAt: Date.now() }
    }).catch(function() {});
    return true;
  }
  return false;
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
});
