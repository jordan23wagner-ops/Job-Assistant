const titleSelectors = [
  '.job-details-jobs-unified-top-card__job-title h1',
  '.jobs-unified-top-card__job-title',
  '.t-24.t-bold.inline',
  'h1.topcard__title',
  'h2.top-card-layout__title'
];

const companySelectors = [
  '.job-details-jobs-unified-top-card__company-name',
  '.jobs-unified-top-card__company-name',
  '.topcard__org-name-link',
  'a.top-card-layout__company-url'
];

const locationSelectors = [
  '.job-details-jobs-unified-top-card__bullet',
  '.jobs-unified-top-card__bullet',
  '.topcard__flavor--bullet',
  'span.top-card-layout__bullet'
];

const descSelectors = [
  '.jobs-description__content',
  '.jobs-description-content__text',
  '.jobs-box__html-content',
  '.description__text',
  '#job-details'
];

function findElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

function expandJobDescription() {
  const seeMoreButtons = document.querySelectorAll(
    'button.jobs-description__footer-button, button[aria-label="Show more"], button.show-more-less-html__button'
  );
  seeMoreButtons.forEach(btn => {
    if (btn.textContent.toLowerCase().includes('see more') || btn.textContent.toLowerCase().includes('show more')) {
      btn.click();
    }
  });
}

function detectJob() {
  expandJobDescription();

  const title = findElement(titleSelectors);
  const company = findElement(companySelectors);
  const location = findElement(locationSelectors);

  let description = null;
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) {
      description = el.textContent.trim();
      break;
    }
  }

  if (title || company) {
    const jobData = {
      type: 'JOB_DETECTED',
      job: { title, company, location, description, url: window.location.href, detectedAt: Date.now() }
    };
    chrome.runtime.sendMessage(jobData).catch(() => {});
  }
}

setTimeout(detectJob, 1500);

const observer = new MutationObserver(() => {
  clearTimeout(observer._timeout);
  observer._timeout = setTimeout(detectJob, 2000);
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DETECT_JOB') {
    detectJob();
  }
});