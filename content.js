function findBySelectors(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

function findByText(tag, patterns) {
  const els = document.querySelectorAll(tag);
  for (const el of els) {
    const text = el.textContent.trim();
    for (const p of patterns) {
      if (typeof p === 'string' && text.includes(p)) return el;
      if (p instanceof RegExp && p.test(text)) return el;
    }
  }
  return null;
}

function expandJobDescription() {
  const buttons = document.querySelectorAll('button, [role="button"]');
  buttons.forEach(btn => {
    const text = btn.textContent.toLowerCase().trim();
    if (text.includes('see more') || text.includes('show more') || text === '...more') {
      btn.click();
    }
  });
  const footerBtns = document.querySelectorAll(
    'button.jobs-description__footer-button, button[aria-label="Show more"], button.show-more-less-html__button, .jobs-description__content button'
  );
  footerBtns.forEach(btn => btn.click());
}

function getJobTitle() {
  const selectors = [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title a',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title a',
    '.jobs-unified-top-card__job-title',
    'h1.t-24',
    'h1.topcard__title',
    'h2.top-card-layout__title',
    '.t-24.t-bold.inline',
    'h1[class*="job"]',
    'h1[class*="title"]',
    '.jobs-details__main-content h1',
    '.job-view-layout h1'
  ];
  let title = findBySelectors(selectors);
  if (!title) {
    const h1s = document.querySelectorAll('h1');
    for (const h1 of h1s) {
      const text = h1.textContent.trim();
      if (text.length > 3 && text.length < 200 && !text.includes('LinkedIn')) {
        title = text;
        break;
      }
    }
  }
  return title;
}

function getCompany() {
  const selectors = [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.job-details-jobs-unified-top-card__primary-description-container a',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    'a.top-card-layout__company-url',
    'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
    '.jobs-details__main-content a[href*="/company/"]'
  ];
  let company = findBySelectors(selectors);
  if (!company) {
    const links = document.querySelectorAll('a[href*="/company/"]');
    for (const link of links) {
      const text = link.textContent.trim();
      if (text.length > 1 && text.length < 100) {
        company = text;
        break;
      }
    }
  }
  return company;
}

function getLocation() {
  const selectors = [
    '.job-details-jobs-unified-top-card__bullet',
    '.job-details-jobs-unified-top-card__workplace-type',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    'span.top-card-layout__bullet',
    '.jobs-unified-top-card__subtitle span'
  ];
  let loc = findBySelectors(selectors);
  if (!loc) {
    const spans = document.querySelectorAll('span, div');
    for (const span of spans) {
      const text = span.textContent.trim();
      if (text.match(/\b(Remote|Hybrid|On-site|United States|Canada|UK|India)\b/i) &&
          text.length < 100 && !text.includes('Apply')) {
        loc = text;
        break;
      }
    }
  }
  return loc;
}

function getDescription() {
  const selectors = [
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    '.description__text',
    '#job-details',
    '.jobs-description',
    '[class*="description"][class*="content"]',
    '.job-view-layout .jobs-description'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 50) {
      return el.textContent.trim();
    }
  }
  const aboutHeader = findByText('h2, h3, span', ['About the job', 'Job description', 'Description']);
  if (aboutHeader) {
    let container = aboutHeader.closest('section') || aboutHeader.parentElement?.parentElement;
    if (container && container.textContent.trim().length > 50) {
      return container.textContent.trim();
    }
  }
  return null;
}

function detectJob() {
  expandJobDescription();

  const title = getJobTitle();
  const company = getCompany();
  const location = getLocation();
  const description = getDescription();

  if (title || company) {
    const jobData = {
      type: 'JOB_DETECTED',
      job: { title, company, location, description, url: window.location.href, detectedAt: Date.now() }
    };
    chrome.runtime.sendMessage(jobData).catch(() => {});
    return true;
  }
  return false;
}

setTimeout(() => {
  if (!detectJob()) {
    setTimeout(detectJob, 3000);
  }
}, 2000);

let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(detectJob, 2000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DETECT_JOB') {
    setTimeout(() => {
      expandJobDescription();
      setTimeout(detectJob, 500);
    }, 300);
  }
});