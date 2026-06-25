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

function isLikelyTitle(text) {
  if (!text || text.length < 3 || text.length > 200) return false;
  var lower = text.toLowerCase();
  var skip = [
    'linkedin', 'sign in', 'sign up', 'messaging', 'notifications',
    'my network', 'jobs based on', 'about the job', 'job description',
    'people also viewed', 'similar jobs', 'you might like',
    'premium', 'try premium', 'reactivate', 'home', 'search',
    'show more', 'see more', 'apply', 'save', 'share',
    'report', 'hide', 'dismiss', 'follow', 'connect',
    'date posted', 'easy apply', 'applicants', 'in my network',
    'jobs', 'ai-powered', 'description', 'how promoted'
  ];
  for (var i = 0; i < skip.length; i++) {
    if (lower === skip[i] || lower.indexOf(skip[i]) === 0) return false;
  }
  if (/^\d+\s*(notification|message|connection|result|job)/i.test(text)) return false;
  if (/^\d+$/.test(text.trim())) return false;
  return true;
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
    '.job-details-jobs-unified-top-card__job-title h2',
    '.job-details-jobs-unified-top-card__job-title a',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title a',
    '.jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title h2',
    '.jobs-unified-top-card__job-title',
    'h1.t-24.t-bold',
    'h1.t-24',
    'h2.t-24.t-bold',
    'h2.t-24',
    'h1.topcard__title',
    'h2.topcard__title',
    'h2.top-card-layout__title',
    '.t-24.t-bold.inline'
  ], 3, 200);
  if (title && isLikelyTitle(title)) {
    console.log('[Alicia] Title found via selector:', title);
    return title;
  }

  try {
    var companyLink = document.querySelector('a[href*="/company/"]');
    if (companyLink) {
      var companyText = getText(companyLink);
      var parent = companyLink.parentElement;
      for (var up = 0; up < 8 && parent; up++) {
        var headings = parent.querySelectorAll('h1, h2, h3, a[class*="title"], [class*="job-title"], [class*="job_title"]');
        for (var h = 0; h < headings.length; h++) {
          var ht = getText(headings[h]);
          if (isLikelyTitle(ht) && ht !== companyText) {
            console.log('[Alicia] Title found near company (up ' + up + '):', ht);
            return ht;
          }
        }
        parent = parent.parentElement;
      }
    }
  } catch (e) { console.log('[Alicia] Company-anchor title search error:', e); }

  var headingTags = ['h1', 'h2', 'h3'];
  for (var ti = 0; ti < headingTags.length; ti++) {
    try {
      var els = document.querySelectorAll(headingTags[ti]);
      for (var i = 0; i < els.length; i++) {
        var t = getText(els[i]);
        if (isLikelyTitle(t)) {
          var inSidebar = els[i].closest('.jobs-search__left-rail, .scaffold-layout__list, nav, header[class*="global"]');
          if (!inSidebar) {
            console.log('[Alicia] Title found via ' + headingTags[ti] + ' scan:', t);
            return t;
          }
        }
      }
    } catch (e) {}
  }

  for (var ti2 = 0; ti2 < headingTags.length; ti2++) {
    try {
      var els2 = document.querySelectorAll(headingTags[ti2]);
      for (var i2 = 0; i2 < els2.length; i2++) {
        var t2 = getText(els2[i2]);
        if (isLikelyTitle(t2)) {
          console.log('[Alicia] Title found via last-resort ' + headingTags[ti2] + ':', t2);
          return t2;
        }
      }
    } catch (e) {}
  }

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

  try {
    var divs = document.querySelectorAll('div, section, article');
    for (var k = 0; k < divs.length; k++) {
      var dt = getText(divs[k]);
      if (dt.length > 200 && dt.length < 10000) {
        if (dt.indexOf('experience') !== -1 || dt.indexOf('requirements') !== -1 || dt.indexOf('qualifications') !== -1 || dt.indexOf('responsibilities') !== -1) {
          var inSidebar = divs[k].closest('.jobs-search__left-rail, .scaffold-layout__list');
          if (!inSidebar) {
            console.log('[Alicia] Description found via keyword scan, length:', dt.length);
            return dt;
          }
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
