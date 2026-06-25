function findBySelectors(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text) return text;
    }
  }
  return null;
}

function cleanText(text) {
  return text
    .replace(/[​-‍﻿­]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandJobDescription() {
  const allButtons = document.querySelectorAll('button, [role="button"], [class*="show-more"], [class*="see-more"]');
  allButtons.forEach(btn => {
    const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
    if (text.includes('see more') || text.includes('show more') || text === '...more' || text === 'more') {
      try {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch (e) {
        btn.click();
      }
    }
  });
  const specificBtns = document.querySelectorAll(
    'button.jobs-description__footer-button, button[aria-label*="Show more"], button[aria-label*="See more"], button.show-more-less-html__button, .jobs-description__content button, .jobs-description button'
  );
  specificBtns.forEach(btn => {
    try {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (e) {
      btn.click();
    }
  });
}

function getJobTitle() {
  const selectors = [
    '.job-details-jobs-unified-top-card__job-title h1 a',
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title a',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title a',
    '.jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title',
    'h1.t-24',
    'h1.t-24.t-bold',
    'h1.topcard__title',
    'h2.top-card-layout__title',
    '.t-24.t-bold.inline',
    'h1[class*="job-title"]',
    'h1[class*="jobTitle"]',
    '.jobs-details__main-content h1',
    '.job-view-layout h1',
    '.jobs-details-top-card__job-title',
    'a[data-tracking-control-name="public_jobs_topcard-title"]'
  ];
  let title = findBySelectors(selectors);
  if (title) return cleanText(title);

  const topCard = document.querySelector('[class*="top-card"], [class*="topcard"], [class*="TopCard"]');
  if (topCard) {
    const h1 = topCard.querySelector('h1, h2');
    if (h1) {
      const text = cleanText(h1.innerText || h1.textContent || '');
      if (text.length > 2 && text.length < 200) return text;
    }
    const link = topCard.querySelector('a');
    if (link) {
      const text = cleanText(link.innerText || link.textContent || '');
      if (text.length > 2 && text.length < 200 && !text.includes('LinkedIn')) return text;
    }
  }

  const h1s = document.querySelectorAll('h1');
  for (const h1 of h1s) {
    const text = cleanText(h1.innerText || h1.textContent || '');
    if (text.length > 3 && text.length < 200 && !text.includes('LinkedIn') && !text.includes('Sign in')) {
      return text;
    }
  }

  const ariaTitle = document.querySelector('[aria-label*="job title"], [aria-label*="Job title"]');
  if (ariaTitle) {
    const text = cleanText(ariaTitle.innerText || ariaTitle.textContent || '');
    if (text.length > 2) return text;
  }

  return null;
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
  if (company) return cleanText(company);

  const links = document.querySelectorAll('a[href*="/company/"]');
  for (const link of links) {
    const text = cleanText(link.innerText || link.textContent || '');
    if (text.length > 1 && text.length < 100) return text;
  }
  return null;
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
  if (loc) return cleanText(loc);

  const spans = document.querySelectorAll('span, div');
  for (const span of spans) {
    const text = cleanText(span.innerText || span.textContent || '');
    if (text.match(/\b(Remote|Hybrid|On-site|United States|Canada|UK|India)\b/i) &&
        text.length < 100 && !text.includes('Apply')) {
      return text;
    }
  }
  return null;
}

function getDescription() {
  expandJobDescription();

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
    if (el) {
      const text = cleanText(el.innerText || el.textContent || '');
      if (text.length > 50) return text;
    }
  }

  const headers = document.querySelectorAll('h2, h3, span');
  for (const header of headers) {
    const text = (header.innerText || header.textContent || '').trim();
    if (text === 'About the job' || text === 'Job description' || text === 'Description') {
      let container = header.closest('section') || header.parentElement?.parentElement;
      if (container) {
        const desc = cleanText(container.innerText || container.textContent || '');
        if (desc.length > 50) return desc;
      }
    }
  }
  return null;
}

function detectJob() {
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
  expandJobDescription();
  setTimeout(() => {
    if (!detectJob()) {
      setTimeout(detectJob, 3000);
    }
  }, 500);
}, 2000);

let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(() => {
      expandJobDescription();
      setTimeout(detectJob, 500);
    }, 2000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DETECT_JOB') {
    expandJobDescription();
    setTimeout(() => {
      expandJobDescription();
      setTimeout(detectJob, 500);
    }, 500);
  }
});
