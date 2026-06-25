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

function getJobTitle() {
  var fromPage = getTitleFromPageTitle();
  if (fromPage) {
    console.log('[Alicia] Title found from page title:', fromPage);
    return fromPage;
  }

  var title = trySelectors([
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
  if (title) {
    console.log('[Alicia] Title found via selector:', title);
    return title;
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
