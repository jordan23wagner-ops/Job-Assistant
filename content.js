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

function getTextFromEl(el) {
  if (!el) return '';
  return cleanText(el.innerText || el.textContent || '');
}

function expandJobDescription() {
  var detailPanel = document.querySelector('.jobs-search__job-details, .job-details-jobs-unified-top-card, .jobs-details, [class*="job-details"]');
  var scope = detailPanel || document;
  var allButtons = scope.querySelectorAll('button, [role="button"], [class*="show-more"], [class*="see-more"]');
  allButtons.forEach(function(btn) {
    var text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
    if (text.includes('see more') || text.includes('show more') || text === '...more' || text === 'more') {
      try {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch (e) {
        btn.click();
      }
    }
  });
  var specificBtns = scope.querySelectorAll(
    'button[aria-label*="Show more"], button[aria-label*="See more"], button.show-more-less-html__button, .jobs-description__content button, .jobs-description button'
  );
  specificBtns.forEach(function(btn) {
    try {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (e) {
      btn.click();
    }
  });
}

function getJobTitle() {
  var topCard = document.querySelector('.job-details-jobs-unified-top-card__job-title');
  if (topCard) {
    var link = topCard.querySelector('a');
    if (link) {
      var t = getTextFromEl(link);
      if (t.length > 2 && t.length < 200) return t;
    }
    var h1 = topCard.querySelector('h1');
    if (h1) {
      var t2 = getTextFromEl(h1);
      if (t2.length > 2 && t2.length < 200) return t2;
    }
    var t3 = getTextFromEl(topCard);
    if (t3.length > 2 && t3.length < 200) return t3;
  }

  var topCardContainer = document.querySelector('.job-details-jobs-unified-top-card__container--two-pane, .job-details-jobs-unified-top-card, [class*="jobs-unified-top-card"]');
  if (topCardContainer) {
    var titleEl = topCardContainer.querySelector('h1, h2, [class*="job-title"], [class*="job_title"]');
    if (titleEl) {
      var t4 = getTextFromEl(titleEl);
      if (t4.length > 2 && t4.length < 200) return t4;
    }
    var firstLink = topCardContainer.querySelector('a');
    if (firstLink) {
      var t5 = getTextFromEl(firstLink);
      if (t5.length > 2 && t5.length < 200 && !t5.includes('LinkedIn') && !t5.includes('company')) return t5;
    }
  }

  var detailPane = document.querySelector('.jobs-search__job-details, .scaffold-layout__detail, [class*="job-details"]');
  if (detailPane) {
    var h1InDetail = detailPane.querySelector('h1');
    if (h1InDetail) {
      var t6 = getTextFromEl(h1InDetail);
      if (t6.length > 2 && t6.length < 200) return t6;
    }
    var h2InDetail = detailPane.querySelector('h2');
    if (h2InDetail) {
      var t7 = getTextFromEl(h2InDetail);
      if (t7.length > 2 && t7.length < 200 && !t7.includes('About the job')) return t7;
    }
  }

  var selectors = [
    'h1.t-24',
    'h1.t-24.t-bold',
    'h1.topcard__title',
    'h2.top-card-layout__title',
    '.t-24.t-bold.inline'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) {
      var t8 = getTextFromEl(el);
      if (t8.length > 2 && t8.length < 200) return t8;
    }
  }

  return null;
}

function getCompany() {
  var topCardContainer = document.querySelector('.job-details-jobs-unified-top-card__container--two-pane, .job-details-jobs-unified-top-card, [class*="jobs-unified-top-card"]');
  if (topCardContainer) {
    var companyEl = topCardContainer.querySelector('[class*="company-name"] a, [class*="company-name"]');
    if (companyEl) {
      var t = getTextFromEl(companyEl);
      if (t.length > 0 && t.length < 100) return t;
    }
    var companyLink = topCardContainer.querySelector('a[href*="/company/"]');
    if (companyLink) {
      var t2 = getTextFromEl(companyLink);
      if (t2.length > 0 && t2.length < 100) return t2;
    }
  }

  var selectors = [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    'a.top-card-layout__company-url'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) {
      var t3 = getTextFromEl(el);
      if (t3.length > 0 && t3.length < 100) return t3;
    }
  }

  var detailPane = document.querySelector('.jobs-search__job-details, .scaffold-layout__detail, [class*="job-details"]');
  if (detailPane) {
    var links = detailPane.querySelectorAll('a[href*="/company/"]');
    for (var j = 0; j < links.length; j++) {
      var t4 = getTextFromEl(links[j]);
      if (t4.length > 1 && t4.length < 100) return t4;
    }
  }
  return null;
}

function getLocation() {
  var topCardContainer = document.querySelector('.job-details-jobs-unified-top-card__container--two-pane, .job-details-jobs-unified-top-card, [class*="jobs-unified-top-card"]');
  if (topCardContainer) {
    var bullet = topCardContainer.querySelector('[class*="bullet"], [class*="workplace-type"]');
    if (bullet) {
      var t = getTextFromEl(bullet);
      if (t.length > 0 && t.length < 100) return t;
    }
  }

  var selectors = [
    '.job-details-jobs-unified-top-card__bullet',
    '.job-details-jobs-unified-top-card__workplace-type',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    'span.top-card-layout__bullet'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) {
      var t2 = getTextFromEl(el);
      if (t2.length > 0 && t2.length < 100) return t2;
    }
  }
  return null;
}

function getDescription() {
  expandJobDescription();

  var jobDetailsEl = document.getElementById('job-details');
  if (jobDetailsEl) {
    var t = getTextFromEl(jobDetailsEl);
    if (t.length > 50) return t;
  }

  var detailPane = document.querySelector('.jobs-search__job-details, .scaffold-layout__detail, [class*="job-details"]');
  var scope = detailPane || document;

  var selectors = [
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    '.description__text',
    '.jobs-description'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = scope.querySelector(selectors[i]);
    if (el) {
      var t2 = getTextFromEl(el);
      if (t2.length > 50) return t2;
    }
  }

  var headers = scope.querySelectorAll('h2, h3');
  for (var j = 0; j < headers.length; j++) {
    var headerText = (headers[j].innerText || headers[j].textContent || '').trim();
    if (headerText === 'About the job' || headerText === 'Job description' || headerText === 'Description') {
      var container = headers[j].closest('section') || headers[j].parentElement;
      if (container) {
        var t3 = getTextFromEl(container);
        if (t3.length > 50) return t3;
      }
    }
  }
  return null;
}

function detectJob() {
  var title = getJobTitle();
  var company = getCompany();
  var location = getLocation();
  var description = getDescription();

  if (title || company) {
    var jobData = {
      type: 'JOB_DETECTED',
      job: { title: title, company: company, location: location, description: description, url: window.location.href, detectedAt: Date.now() }
    };
    chrome.runtime.sendMessage(jobData).catch(function() {});
    return true;
  }
  return false;
}

setTimeout(function() {
  expandJobDescription();
  setTimeout(function() {
    if (!detectJob()) {
      setTimeout(detectJob, 3000);
    }
  }, 800);
}, 2000);

var lastUrl = location.href;
var observer = new MutationObserver(function() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(function() {
      expandJobDescription();
      setTimeout(detectJob, 800);
    }, 2000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener(function(message) {
  if (message.type === 'DETECT_JOB') {
    expandJobDescription();
    setTimeout(function() {
      expandJobDescription();
      setTimeout(detectJob, 800);
    }, 500);
  }
});
