let currentJob = null;
let resumeText = null;
let tailoringState = null;
// Set when tailoring is launched from the match badge — the badge's "missing" keywords, so the
// tailor prompts can re-emphasize real experience toward them (never fabricate). Cleared each run.
let tailorMissingKeywords = null;

// Chat: two independent conversations — 'job' (career coach) and 'general' (everyday assistant)
let chatMode = 'job';
let chatStore = { job: [], general: [] };
let pendingImage = null; // { dataUrl, name } attached for the next general-mode message
let chatSessions = []; // archived conversations: {id, title, mode, ts, pinned, records}

const THEME_NAMES = ['midnight', 'yellow', 'slate', 'light'];

// ----- Free-tier metering -----
// Free users get the full toolset; only chat is metered per day. Premium lifts all caps.
const FREE_LIMITS = { jobChat: 15, generalChat: 10, image: 3 };
const FREE_HISTORY_CAP = 5;
const PREMIUM_HISTORY_CAP = 25;
let isPremium = false;
let usage = { date: '', jobChat: 0, generalChat: 0, image: 0 };

function todayStr() { return new Date().toISOString().slice(0, 10); }

function ensureUsageFresh() {
  if (usage.date !== todayStr()) {
    usage = { date: todayStr(), jobChat: 0, generalChat: 0, image: 0 };
    persistUsage();
  }
}

function persistUsage() { chrome.storage.local.set({ usage: usage }); }

function historyCap() { return isPremium ? PREMIUM_HISTORY_CAP : FREE_HISTORY_CAP; }

const jobInfo = document.getElementById('job-info');
const detectBtn = document.getElementById('detect-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const tailorBtn = document.getElementById('tailor-btn');
const coverBtn = document.getElementById('cover-btn');
const matchScoreBtn = document.getElementById('match-score-btn');
const resumeUpload = document.getElementById('resume-upload');
const resumeStatus = document.getElementById('resume-status');
const analysisSection = document.getElementById('analysis-section');
const analysisTitle = document.getElementById('analysis-title');
const analysisContent = document.getElementById('analysis-content');
const closeAnalysis = document.getElementById('close-analysis');
const tailoringSection = document.getElementById('tailoring-section');
const tailoringConversation = document.getElementById('tailoring-conversation');
const tailoringOptions = document.getElementById('tailoring-options');
const tailoringInput = document.getElementById('tailoring-input');
const tailoringSend = document.getElementById('tailoring-send');
const closeTailoring = document.getElementById('close-tailoring');
const buildResumeBtn = document.getElementById('build-resume-btn');
const builderSection = document.getElementById('builder-section');
const builderConversation = document.getElementById('builder-conversation');
const builderOptions = document.getElementById('builder-options');
const builderInput = document.getElementById('builder-input');
const builderSend = document.getElementById('builder-send');
const closeBuilder = document.getElementById('close-builder');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const pasteToggle = document.getElementById('paste-toggle');
const pasteBox = document.getElementById('paste-box');
const resumePaste = document.getElementById('resume-paste');
const resumePasteSave = document.getElementById('resume-paste-save');
const modeJobBtn = document.getElementById('mode-job');
const modeGeneralBtn = document.getElementById('mode-general');
const chatModeHint = document.getElementById('chat-mode-hint');
const chatAttachBtn = document.getElementById('chat-attach');
const chatAttachment = document.getElementById('chat-attachment');
const chatImageInput = document.getElementById('chat-image-input');
const chatHistoryBtn = document.getElementById('chat-history-btn');
const chatClearBtn = document.getElementById('chat-clear-btn');
const chatNotice = document.getElementById('chat-notice');
const chatHistoryPanel = document.getElementById('chat-history-panel');
const themeDots = Array.prototype.slice.call(document.querySelectorAll('.theme-dot'));
const saveJobBtn = document.getElementById('save-job-btn');
const trackerToggle = document.getElementById('tracker-toggle');
const trackerStats = document.getElementById('tracker-stats');
const trackerBody = document.getElementById('tracker-body');
const trackerList = document.getElementById('tracker-list');
const trackerEmpty = document.getElementById('tracker-empty');
const interviewBtn = document.getElementById('interview-btn');
const interviewSection = document.getElementById('interview-section');
const closeInterview = document.getElementById('close-interview');

let trackedJobs = []; // {id, title, company, location, url, description, status, notes, savedAt}
let practiceState = null; // mock-interview conversation state

const TRACKER_STAGES = [
  { key: 'saved', label: 'Saved' },
  { key: 'applied', label: 'Applied' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
  { key: 'rejected', label: 'Rejected' }
];

function sanitizeText(text) {
  if (!text) return '';
  var clean = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code === 0xFEFF || code === 0xFFFD) continue;
    if (code >= 0x00 && code <= 0x08) continue;
    if (code === 0x0B || code === 0x0C) continue;
    if (code >= 0x0E && code <= 0x1F) continue;
    if (code === 0x2028 || code === 0x2029) { clean += '\n'; continue; }
    clean += text[i];
  }
  return clean;
}

// Qwen (and other reasoning models) emit their chain-of-thought wrapped in
// <think>...</think> before the real answer. Strip it so the user only sees the result.
function stripThinking(text) {
  if (!text) return text;
  // Remove complete <think>...</think> blocks.
  var cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // If a closing tag remains (opening tag was missing/mid-stream), drop everything up to it.
  if (/<\/think>/i.test(cleaned)) {
    cleaned = cleaned.replace(/[\s\S]*<\/think>/i, '');
  }
  // Strip any stray opening/closing tags.
  cleaned = cleaned.replace(/<\/?think>/gi, '');
  return cleaned.trim();
}

function isLowQualityResumeText(text) {
  if (!text || text.length < 50) return true;

  const sample = text.substring(0, 4000);
  let letters = 0;
  let words = 0;
  let printable = 0;

  const wordRegex = /\b[a-zA-Z]{2,}\b/g;
  const matches = sample.match(wordRegex);
  if (matches) words = matches.length;

  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // Count letters first — must not sit behind the printable `continue` checks
    // below, or ASCII letters (32–126) are never counted and density is always 0.
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
    if (c === 9 || c === 10 || c === 13) { printable++; continue; }
    if (c >= 32 && c <= 126) { printable++; continue; }
    if (c >= 160 && c <= 255) { printable++; continue; }
  }

  const printableRatio = printable / sample.length;
  const hasEnoughWords = words >= 15;
  const letterDensity = letters / Math.max(1, sample.length);

  return (printableRatio < 0.75 && !hasEnoughWords) || letterDensity < 0.08;
}

function isResponseGarbage(text) {
  if (!text || text.length < 5) return false;
  var letters = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
  }
  return (letters / text.length) < 0.2;
}

// Chatwillow's chat backend (Ollama Cloud -> Cerebras -> Groq -> NIM fallback). No API
// key needed: the keys live server-side on Vercel. Signed-in users (Tools -> Account)
// get a higher daily allowance via the Authorization header; anonymous use still works.
var BACKEND_URL = 'https://chatwillow.com/api/chat';

// Call the backend and return a single completion string. The endpoint streams NDJSON
// ({"delta":"..."}\n ... {"done":true}\n), so we read the stream and concatenate the deltas
// into the one-shot string the rest of the UI expects.
async function rawBackendCall(messages, temperature, maxTokens) {
  var msgs = messages || [];
  // The last message is the current user turn; everything before it is history. The backend
  // forwards history messages with their role intact, so the tool's system prompt (always
  // the first message) reaches the model.
  var last = msgs.length ? msgs[msgs.length - 1] : { content: '' };
  var history = msgs.slice(0, -1).map(function (m) { return { role: m.role, content: m.content }; });

  var headers = { 'Content-Type': 'application/json' };
  try {
    var aliciaToken = await AliciaAccount.getAccessToken();
    if (aliciaToken) headers['Authorization'] = 'Bearer ' + aliciaToken;
  } catch (e) { /* anonymous tier */ }

  var resp = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ messages: history, newMessage: last.content || '', model: 'auto' })
  });
  if (!resp.ok) {
    if (resp.status === 429) {
      var quotaMsg = null;
      try { quotaMsg = (await resp.json()).error; } catch (e) {}
      throw new Error(quotaMsg || 'Daily AI limit reached — sign in or upgrade in Tools → Account for more.');
    }
    throw new Error('Backend error: ' + resp.status);
  }

  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var text = '';
  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop(); // keep the trailing partial line for the next chunk
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var evt;
      try { evt = JSON.parse(line); } catch (e) { continue; }
      if (evt.delta) text += evt.delta;
      else if (evt.error) throw new Error(evt.error);
      // {image:...} / {done:...} events carry no text for these callers — ignore.
    }
  }
  if (buffer.trim()) {
    try { var fin = JSON.parse(buffer.trim()); if (fin.delta) text += fin.delta; } catch (e) {}
  }
  return stripThinking(sanitizeText(text));
}

// Kept the name callGroq so the ~12 existing call sites are untouched; it now routes to the
// free Chatwillow backend instead of Groq.
async function callGroq(messages, temperature, maxTokens) {
  if (temperature === undefined) temperature = 0.7;

  var content = await rawBackendCall(messages, temperature, maxTokens);

  if (isResponseGarbage(content)) {
    console.log('[Alicia] Garbage response detected, retrying:', content);
    var retry = await rawBackendCall(messages, 0.3, maxTokens);
    if (!isResponseGarbage(retry)) return retry;
    throw new Error('The AI returned an invalid response. Please try again.');
  }

  return content;
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatAnalysis(text) {
  if (!text) return '';
  text = sanitizeText(text);

  var lines = text.split('\n');
  var html = '';
  var inList = false;

  for (var i = 0; i < lines.length; i++) {
    var line = escapeHtml(lines[i]);

    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    if (/^#{2,3}\s+(.+)/.test(lines[i])) {
      if (inList) { html += '</ul>'; inList = false; }
      var heading = escapeHtml(lines[i].replace(/^#{2,3}\s+/, ''));
      html += '<h3>' + heading + '</h3>';
    } else if (/^[*\-]\s+(.+)/.test(lines[i])) {
      if (!inList) { html += '<ul>'; inList = true; }
      var item = escapeHtml(lines[i].replace(/^[*\-]\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += '<li>' + item + '</li>';
    } else if (/^\d+\.\s+(.+)/.test(lines[i])) {
      if (!inList) { html += '<ul>'; inList = true; }
      var item2 = escapeHtml(lines[i].replace(/^\d+\.\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += '<li>' + item2 + '</li>';
    } else if (lines[i].trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<br>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<p>' + line + '</p>';
    }
  }
  if (inList) html += '</ul>';

  return html;
}

function displayJob(job) {
  currentJob = job;
  jobInfo.innerHTML = '';

  var titleDiv = document.createElement('div');
  titleDiv.className = 'job-title';
  titleDiv.textContent = job.title || 'Unknown Title';
  jobInfo.appendChild(titleDiv);

  if (job.company) {
    var c = document.createElement('div');
    c.className = 'job-company';
    c.textContent = job.company;
    jobInfo.appendChild(c);
  }
  if (job.location) {
    var l = document.createElement('div');
    l.className = 'job-location';
    l.textContent = job.location;
    jobInfo.appendChild(l);
  }
  if (job.description) {
    var desc = document.createElement('div');
    desc.className = 'job-desc collapsed';
    desc.textContent = job.description;
    jobInfo.appendChild(desc);

    var toggle = document.createElement('div');
    toggle.className = 'job-desc-toggle';
    toggle.textContent = 'Show more';
    toggle.addEventListener('click', function() {
      if (desc.classList.contains('collapsed')) {
        desc.classList.remove('collapsed');
        desc.classList.add('expanded');
        toggle.textContent = 'Show less';
      } else {
        desc.classList.add('collapsed');
        desc.classList.remove('expanded');
        toggle.textContent = 'Show more';
      }
    });
    jobInfo.appendChild(toggle);
  }
  updateToolButtons();
}

function updateToolButtons() {
  analyzeBtn.disabled = !currentJob;
  tailorBtn.disabled = !currentJob || !resumeText;
  coverBtn.disabled = !currentJob;
  interviewBtn.disabled = !currentJob;
  matchScoreBtn.disabled = !currentJob || !resumeText;
  if (saveJobBtn) {
    saveJobBtn.classList.toggle('hidden', !currentJob);
    refreshSaveJobBtn();
  }
  var fp = document.getElementById('find-people-btn');
  if (fp) fp.classList.toggle('hidden', !currentJob);
}

chrome.runtime.onMessage.addListener(function(message) {
  if (message.type === 'JOB_DETECTED' && message.job) {
    displayJob(message.job);
  }
  if (message.type === 'TAILOR_FOR_JOB' && message.job) {
    chrome.storage.local.remove('pendingTailorJob'); // handled live — don't re-fire on next open
    beginTailorForJob(message.job, message.missing);
  }
  if (message.type === 'EEO_FILL_RESULT') {
    var status = document.getElementById('eeo-fill-status');
    if (status) {
      if (message.filled > 0) {
        status.textContent = 'Filled ' + message.filled + ' field' + (message.filled === 1 ? '' : 's') + '. Review before submitting.';
        status.style.color = '#4caf50';
      } else {
        status.textContent = 'No matching questions found on the open form.';
        status.style.color = '#ff9955';
      }
      setTimeout(function () { status.textContent = ''; }, 5000);
    }
  }
});

detectBtn.addEventListener('click', function() {
  currentJob = null;
  jobInfo.innerHTML = '<p class="placeholder">Detecting job...</p>';
  chrome.runtime.sendMessage({ type: 'DETECT_JOB' });
  setTimeout(function() {
    if (!currentJob) {
      jobInfo.innerHTML = '<p class="placeholder">No job found. Make sure you are on a LinkedIn job posting page and try again.</p>';
    }
  }, 5000);
});

function setResumeStatus(text, color) {
  resumeStatus.textContent = text;
  resumeStatus.style.color = color;
}

function showGoogleDocsTip() {
  var existing = document.getElementById('gdocs-tip');
  if (existing) existing.remove();

  var tip = document.createElement('div');
  tip.id = 'gdocs-tip';
  tip.style.cssText = 'font-size:11px; color:#ffaa00; margin-top:6px; line-height:1.4; padding:8px; background:rgba(255,170,0,0.08); border-radius:6px; border:1px solid rgba(255,170,0,0.2);';
  tip.innerHTML = '<strong>Can\'t read your PDF?</strong> Resume builders like Canva convert text into images/shapes that no tool can read.'
    + '<br>Quick fix: Open your PDF in <a id="gdocs-link" href="#" style="color:#7c83ff; text-decoration:underline;">Google Docs</a>'
    + ' (Upload > Open with Google Docs), then download as .docx or .pdf. This makes the text readable.'
    + '<br>Or just click <strong>"or paste resume text"</strong> below and paste directly.';
  if (resumeStatus.parentNode) resumeStatus.parentNode.appendChild(tip);

  var gdocsLink = document.getElementById('gdocs-link');
  if (gdocsLink) {
    gdocsLink.addEventListener('click', function(e) {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://docs.google.com' });
    });
  }
}

// ========== Saved Resumes ==========
// Multiple saved resumes (a base + tailored/built variants). Exactly one is "active". To avoid
// touching every reader, we keep the legacy `resumeText` (module var + storage key) and
// `resumeFile` storage key pointed at the ACTIVE resume — so content.js match scoring,
// autofill.js ATS upload, and all the sidepanel AI tools keep working unchanged (the shim).
const MAX_SAVED_RESUMES = 10;
const MAX_RESUME_FILE_BYTES = 2 * 1024 * 1024; // 2 MB — matches LinkedIn's own resume upload cap
let savedResumes = [];

function genResumeId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function activeResume() {
  return savedResumes.filter(function (r) { return r.isActive; })[0] || savedResumes[0] || null;
}

// Point the legacy keys + module var at the active resume, and refresh anything that depends on it.
function syncActiveResume() {
  var a = activeResume();
  resumeText = a ? a.text : null;
  chrome.storage.local.set({ resumeText: resumeText || '' });
  if (a && a.file) chrome.storage.local.set({ resumeFile: a.file });
  else chrome.storage.local.remove('resumeFile');
  updateToolButtons();
}

function persistSavedResumes(cb) {
  chrome.storage.local.set({ savedResumes: savedResumes }, function () {
    syncActiveResume();
    if (cb) cb();
  });
}

function setActiveResume(id) {
  savedResumes.forEach(function (r) { r.isActive = (r.id === id); });
  persistSavedResumes(function () {
    renderSavedResumes();
    var a = activeResume();
    if (a) setResumeStatus('Active resume: ' + a.name, '#4caf50');
  });
}

// Add a new saved resume and make it active. Enforces the 10-resume cap. Returns the entry or null.
function addSavedResume(entry) {
  if (savedResumes.length >= MAX_SAVED_RESUMES) {
    setResumeStatus('You have the max of ' + MAX_SAVED_RESUMES + ' saved resumes. Delete one to add another.', '#ff9955');
    return null;
  }
  var r = {
    id: genResumeId(),
    name: entry.name || 'Resume',
    text: entry.text || '',
    file: entry.file || null,
    createdAt: Date.now(),
    tailoredForJob: entry.tailoredForJob || null,
    isActive: true
  };
  savedResumes.forEach(function (x) { x.isActive = false; });
  savedResumes.push(r);
  persistSavedResumes(renderSavedResumes);
  return r;
}

function deleteSavedResume(id) {
  var wasActive = false;
  savedResumes = savedResumes.filter(function (r) {
    if (r.id === id) { wasActive = r.isActive; return false; }
    return true;
  });
  if (wasActive && savedResumes.length) savedResumes[0].isActive = true;
  persistSavedResumes(function () {
    renderSavedResumes();
    if (!savedResumes.length) setResumeStatus('All resumes deleted — add one to use the AI tools.', '#ff9955');
  });
}

function renameSavedResume(id, name) {
  var r = savedResumes.filter(function (x) { return x.id === id; })[0];
  if (r && name && name.trim()) { r.name = name.trim(); persistSavedResumes(renderSavedResumes); }
}

function resumeSourceLabel(r) {
  if (r.tailoredForJob) return 'Tailored for ' + (r.tailoredForJob.company || r.tailoredForJob.title || 'a job');
  if (r.file) return 'Uploaded · ' + r.file.name;
  return 'Text';
}

function viewSavedResume(r) {
  var html = formatResumeContent(r.text);
  chrome.storage.local.set({ tailoredResumeHtml: html }, function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('resume-preview.html') });
  });
}

function renderSavedResumes() {
  var listEl = document.getElementById('saved-resumes-list');
  var emptyEl = document.getElementById('saved-resumes-empty');
  if (!listEl) return;
  if (emptyEl) emptyEl.style.display = savedResumes.length ? 'none' : '';
  listEl.innerHTML = '';
  savedResumes.forEach(function (r) {
    var row = document.createElement('div');
    row.className = 'saved-resume' + (r.isActive ? ' saved-resume-active' : '');

    var radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'active-resume'; radio.className = 'saved-resume-radio';
    radio.checked = !!r.isActive;
    radio.title = 'Make this the active resume';
    radio.addEventListener('change', function () { setActiveResume(r.id); });
    row.appendChild(radio);

    var info = document.createElement('div'); info.className = 'saved-resume-info';
    var nameEl = document.createElement('div'); nameEl.className = 'saved-resume-name'; nameEl.textContent = r.name;
    var src = document.createElement('div'); src.className = 'saved-resume-src';
    src.textContent = resumeSourceLabel(r) + (r.isActive ? ' · Active' : '');
    info.appendChild(nameEl); info.appendChild(src);
    row.appendChild(info);

    var actions = document.createElement('div'); actions.className = 'saved-resume-actions';
    var viewBtn = document.createElement('button'); viewBtn.className = 'saved-resume-btn'; viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', function () { viewSavedResume(r); });
    var renameBtn = document.createElement('button'); renameBtn.className = 'saved-resume-btn'; renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', function () { startRenameSavedResume(r, nameEl); });
    var delBtn = document.createElement('button'); delBtn.className = 'saved-resume-btn saved-resume-del'; delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', function () {
      if (delBtn.dataset.confirm === '1') { deleteSavedResume(r.id); return; }
      delBtn.dataset.confirm = '1'; delBtn.textContent = 'Sure?';
      setTimeout(function () { if (delBtn.parentNode) { delBtn.dataset.confirm = ''; delBtn.textContent = 'Delete'; } }, 3000);
    });
    actions.appendChild(viewBtn); actions.appendChild(renameBtn); actions.appendChild(delBtn);
    row.appendChild(actions);

    listEl.appendChild(row);
  });
}

// Inline rename: swap the name label for a text input; commit on Enter/blur.
function startRenameSavedResume(r, nameEl) {
  var input = document.createElement('input');
  input.type = 'text'; input.className = 'saved-resume-rename'; input.value = r.name;
  nameEl.replaceWith(input); input.focus(); input.select();
  var done = false;
  function commit() { if (done) return; done = true; renameSavedResume(r.id, input.value); }
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; renderSavedResumes(); } });
  input.addEventListener('blur', commit);
}

async function extractResumeText(file) {
  var name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    return await extractPdfText(await file.arrayBuffer());
  }
  if (name.endsWith('.docx')) {
    return await extractDocxText(await file.arrayBuffer());
  }
  if (name.endsWith('.doc')) {
    throw new Error('The old .doc format is not supported. Please save/export as .docx, .pdf, or paste text.');
  }
  return await file.text();
}

resumeUpload.addEventListener('change', async function(e) {
  var file = e.target.files[0];
  if (!file) return;

  setResumeStatus('Reading ' + file.name + '...', '#888');

  try {
    var text = sanitizeText(await extractResumeText(file));
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    if (!text || text.length < 40) {
      setResumeStatus('Could not extract text from this file.', '#ff5555');
      showGoogleDocsTip();
      return;
    }

    const isLowQuality = isLowQualityResumeText(text);

    // Keep the original file bytes (base64) so autofill can attach it to resume/CV file inputs on
    // ATS applications. Capped at 2 MB per file (LinkedIn's own cap); larger files still save their
    // text, just without the attachable file.
    var fileObj = null;
    var tooBig = false;
    try {
      if (file.size <= MAX_RESUME_FILE_BYTES) {
        var buf = await file.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var bi = 0; bi < bytes.length; bi += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(bi, bi + 0x8000));
        }
        fileObj = { name: file.name, type: file.type || 'application/octet-stream', b64: btoa(bin), savedAt: Date.now() };
      } else {
        tooBig = true;
      }
    } catch (fileErr) { console.log('Could not store resume file bytes:', fileErr); }

    var added = addSavedResume({ name: file.name, text: text, file: fileObj });
    if (added) {
      if (isLowQuality) { setResumeStatus('Loaded (partial text — quality may be limited)', '#ffaa00'); showGoogleDocsTip(); }
      else if (tooBig) setResumeStatus('Loaded: ' + file.name + ' (file over 2 MB — text saved, but it won\'t attach on ATS uploads)', '#ffaa00');
      else setResumeStatus('Loaded: ' + file.name, '#4caf50');
    }
    resumeUpload.value = ''; // allow re-selecting the same file later
  } catch (err) {
    setResumeStatus(err.message || 'Could not read file', '#ff5555');
    if (file.name.toLowerCase().endsWith('.pdf') || file.name.toLowerCase().endsWith('.docx')) {
      showGoogleDocsTip();
    }
  }
});

pasteToggle.addEventListener('click', function() {
  pasteBox.classList.toggle('hidden');
  if (!pasteBox.classList.contains('hidden')) resumePaste.focus();
});

resumePasteSave.addEventListener('click', async function() {
  var text = sanitizeText(resumePaste.value).trim();
  if (text.length < 30) {
    setResumeStatus('Please paste a bit more of your resume.', '#ff9955');
    return;
  }
  var added = addSavedResume({ name: 'Pasted resume', text: text, file: null });
  if (added) {
    setResumeStatus('Resume saved from pasted text', '#4caf50');
    pasteBox.classList.add('hidden');
    resumePaste.value = '';
  }
});

chrome.storage.local.get(['savedResumes', 'resumeText', 'resumeFile'], function(data) {
  if (Array.isArray(data.savedResumes) && data.savedResumes.length) {
    savedResumes = data.savedResumes;
  } else if (data.resumeText && !isLowQualityResumeText(data.resumeText)) {
    // Migrate the single legacy resume into the new multi-resume model (one active entry).
    savedResumes = [{
      id: genResumeId(),
      name: (data.resumeFile && data.resumeFile.name) || 'My Resume',
      text: sanitizeText(data.resumeText),
      file: data.resumeFile || null,
      createdAt: Date.now(), tailoredForJob: null, isActive: true
    }];
    chrome.storage.local.set({ savedResumes: savedResumes });
  } else {
    savedResumes = [];
    if (data.resumeText) { // present but low-quality
      chrome.storage.local.remove('resumeText');
      setResumeStatus('Your saved resume was unreadable or low-quality. Please re-upload or paste text.', '#ff9955');
    }
  }

  var a = activeResume();
  resumeText = a ? a.text : null;
  if (a) setResumeStatus(savedResumes.length > 1 ? ('Active resume: ' + a.name) : 'Resume loaded from storage', '#4caf50');
  syncActiveResume();   // keep resumeText/resumeFile keys aligned with the active resume
  renderSavedResumes();
  updateToolButtons();
  // No API key needed — Alicia runs on the Chatwillow backend. Remove any Groq key
  // that pre-1.5 versions left in storage (that onboarding flow is gone).
  chrome.storage.local.remove('groqApiKey');

  // If the user clicked "Tailor my resume for this job" on the in-page match badge while the panel
  // was closed, pick that request up now (resumeText is loaded above, so tailoring can run).
  chrome.storage.local.get('pendingTailorJob', function (pd) {
    var p = pd && pd.pendingTailorJob;
    if (!p) return;
    chrome.storage.local.remove('pendingTailorJob');
    if (p.job && (Date.now() - (p.ts || 0) < 120000)) {
      setTimeout(function () { beginTailorForJob(p.job, p.missing); }, 300);
    }
  });
});

analyzeBtn.addEventListener('click', async function() {
  if (!currentJob) return;
  analysisTitle.textContent = 'Analysis';
  analysisContent.innerHTML = '<p class="loading">Analyzing job...</p>';
  analysisSection.classList.remove('hidden');

  try {
    var msgs = [
      { role: 'system', content: 'You are Alicia, a job search assistant. Analyze the following job posting and provide a structured breakdown with: Key Requirements, Nice-to-Haves, Company Culture Signals, Potential Red Flags, and Salary Insights (if mentioned). Use markdown formatting with ## headers and bullet points.' },
      { role: 'user', content: 'Job Title: ' + currentJob.title + '\nCompany: ' + currentJob.company + '\nLocation: ' + currentJob.location + '\n\nDescription:\n' + currentJob.description }
    ];
    var result = await callGroq(msgs);
    analysisContent.innerHTML = formatAnalysis(result);
  } catch (err) {
    analysisContent.innerHTML = '<p style="color:#ff5555">' + escapeHtml(err.message) + '</p>';
  }
});

closeAnalysis.addEventListener('click', function() {
  analysisSection.classList.add('hidden');
});

function renderMatchScore(data) {
  var color = scoreColor(data.score);
  var html = '';
  html += '<div class="match-score-head">';
  html += '<span class="match-score-badge" style="background:' + color + '">' + data.score + '</span>';
  html += '<div class="match-bar-track"><div class="match-bar-fill" style="width:' + data.score + '%;background:' + color + '"></div></div>';
  html += '</div>';
  if (data.summary) html += '<p>' + escapeHtml(data.summary) + '</p>';
  function chipRow(label, items, cls) {
    if (!items.length) return '';
    var row = '<h3>' + label + '</h3><div class="match-chips">';
    items.forEach(function (kw) { row += '<span class="match-chip ' + cls + '">' + escapeHtml(kw) + '</span>'; });
    return row + '</div>';
  }
  html += chipRow('Matched', data.matched || [], 'matched');
  html += chipRow('Missing', data.missing || [], 'missing');
  analysisContent.innerHTML = html;
}

matchScoreBtn.addEventListener('click', async function () {
  if (!currentJob || !resumeText) return;
  analysisTitle.textContent = 'Match Score';
  analysisContent.innerHTML = '<p class="loading">Scoring your fit for this role...</p>';
  analysisSection.classList.remove('hidden');

  try {
    var sys = 'You are Alicia, a resume-to-job matching engine. Compare the candidate resume to the job posting. Respond ONLY with strict JSON, no markdown fences, no prose: {"score":<0-100 integer, overall fit>,"matched":[<up to 8 short keywords/skills from the job that the resume clearly covers>],"missing":[<up to 8 short keywords/skills the job wants that the resume does not clearly show>],"summary":"<one sentence on the overall fit>"}';
    var user = 'Job Title: ' + currentJob.title + '\nCompany: ' + currentJob.company + '\n\nJob Description:\n' + currentJob.description + '\n\nCandidate Resume:\n' + resumeText.slice(0, 6000);
    var raw = await callGroq([{ role: 'system', content: sys }, { role: 'user', content: user }], 0.2, 1024);
    var clean = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    var data;
    try { data = JSON.parse(clean); }
    catch (e) { var m = clean.match(/\{[\s\S]*\}/); data = m ? JSON.parse(m[0]) : null; }
    if (!data || typeof data.score !== 'number') throw new Error('Could not parse a match score from the response.');
    renderMatchScore(data);
  } catch (err) {
    analysisContent.innerHTML = '<p style="color:#ff5555">' + escapeHtml(err.message) + '</p>';
  }
});

coverBtn.addEventListener('click', async function() {
  if (!currentJob) return;
  analysisTitle.textContent = 'Cover Letter';
  analysisContent.innerHTML = '<p class="loading">Generating cover letter...</p>';
  analysisSection.classList.remove('hidden');

  try {
    var userMsg = 'Write a professional cover letter for:\n\nJob Title: ' + currentJob.title + '\nCompany: ' + currentJob.company + '\nLocation: ' + currentJob.location + '\n\nJob Description:\n' + currentJob.description;
    if (resumeText) {
      userMsg += '\n\nCandidate Resume:\n' + resumeText;
    }
    var msgs = [
      { role: 'system', content: 'You are Alicia, a job search assistant. Write a compelling, professional cover letter. Keep it concise (3-4 paragraphs). Personalize it based on the job description and resume if provided. Use plain text paragraphs only, no markdown or special formatting.' },
      { role: 'user', content: userMsg }
    ];
    var result = await callGroq(msgs);
    analysisContent.innerHTML = formatAnalysis(result);
  } catch (err) {
    analysisContent.innerHTML = '<p style="color:#ff5555">' + escapeHtml(err.message) + '</p>';
  }
});

function addTailoringMessage(text, role) {
  var div = document.createElement('div');
  div.className = 'tailoring-msg ' + role;
  div.innerHTML = (role === 'ai' || role === 'final') ? formatAnalysis(text) : escapeHtml(text);
  tailoringConversation.appendChild(div);
  tailoringConversation.scrollTop = tailoringConversation.scrollHeight;
}

function clearTailoringOptions() {
  tailoringOptions.innerHTML = '';
}

function addTailoringQuickOptions(options) {
  clearTailoringOptions();
  options.forEach(function(opt) {
    var btn = document.createElement('button');
    btn.className = 'tailoring-option-btn';
    btn.textContent = opt;
    btn.addEventListener('click', function() { handleTailoringResponse(opt); });
    tailoringOptions.appendChild(btn);
  });
}

var RESUME_GEN_SYSTEM = 'You are Alicia, an expert resume writer. Write a complete, tailored resume for the candidate targeting the specified role.\n\nRules:\n- Keep all information truthful — reword, reorder, and emphasize but never fabricate\n- Write a targeted professional summary (2-3 sentences)\n- Prioritize and reorder experience bullets to highlight what matters for THIS role\n- Weave in ATS-friendly keywords from the job description naturally\n- Keep the same jobs, titles, dates, and education — do not invent new ones\n- Use strong action verbs and quantified achievements\n- Include ALL roles from the original resume (full detail for recent/relevant, condensed for older ones)\n\nFormat the resume in markdown using these exact patterns:\n# [Candidate Name]\n[Contact info on one line, separated by |]\n\n## Summary\n[2-3 sentence tailored summary]\n\n## Technical Skills\n- **[Category]:** [comma-separated skills]\n- **[Category]:** [comma-separated skills]\n\n## Experience\n### [Job Title] | [Company]\n*[Date range]*\n- [achievement bullet]\n- [achievement bullet]\n\n## Education\n**[School]**\n[Degree/program] | [Dates]';

// Entry point for "Tailor my resume for this job" clicked on the in-page match badge. Loads the
// job + missing keywords into the tailoring flow, switches to the Tools tab, and starts tailoring.
function beginTailorForJob(job, missing) {
  if (!job) return;
  currentJob = job;
  tailorMissingKeywords = (missing && missing.length) ? missing : null;
  displayJob(job); // keep the Apply tab's Current Job card in sync too
  switchTab('tools');
  if (!resumeText) {
    if (tailoringSection) {
      tailoringSection.classList.remove('hidden');
      tailoringConversation.innerHTML = '';
      clearTailoringOptions();
      addTailoringMessage('Add your resume first (in the Resume section below) so I can tailor it for **' + escapeHtml(job.title || 'this job') + '**.', 'ai');
      tailoringSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  startTailoring();
  if (tailoringSection && tailoringSection.scrollIntoView) {
    setTimeout(function () { tailoringSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
  }
}

// Guardrail-preserving clause appended to the tailor prompts: emphasize real experience toward the
// job's missing keywords, never invent. Empty when tailoring wasn't launched from the badge.
function missingKeywordsClause() {
  if (!tailorMissingKeywords || !tailorMissingKeywords.length) return '';
  return '\n\nThe match analysis flagged these job keywords as missing or under-emphasized in the current resume: '
    + tailorMissingKeywords.join(', ')
    + '. Where the candidate has genuinely relevant experience, surface and emphasize it to cover these keywords; if the resume shows no basis for one, leave it out — never fabricate experience.';
}

async function startTailoring() {
  tailoringSection.classList.remove('hidden');
  tailoringConversation.innerHTML = '';
  clearTailoringOptions();
  tailoringInput.value = '';
  tailoringState = { mode: null, deepDiveAnswers: [], tailoredResume: null, generating: false };
  addTailoringMessage('How would you like to tailor your resume for **' + escapeHtml(currentJob.title) + '** at **' + escapeHtml(currentJob.company) + '**?', 'ai');
  if (tailorMissingKeywords && tailorMissingKeywords.length) {
    addTailoringMessage('From the match score, this job is looking for: **' + tailorMissingKeywords.map(escapeHtml).join('**, **') + '**. I\'ll emphasize these where your background genuinely supports them — I won\'t invent anything.', 'ai');
  }
  addTailoringMessage('**Quick Tailor** — I\'ll reshape your current resume to target this role. Fast, one step.\n\n**Deep Dive** — I\'ll ask about skills and experience from the job description that aren\'t obvious in your resume, then build a stronger tailored version.', 'ai');
  addTailoringQuickOptions(['Quick Tailor', 'Deep Dive']);
}

function removeLoadingMessage(keyword) {
  var msgs = tailoringConversation.querySelectorAll('.tailoring-msg.ai');
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].textContent.indexOf(keyword) >= 0) { msgs[i].remove(); break; }
  }
}

async function runQuickTailor() {
  addTailoringMessage('Tailoring your resume...', 'ai');

  try {
    var msgs = [
      { role: 'system', content: RESUME_GEN_SYSTEM },
      { role: 'user', content: 'Target Role: ' + currentJob.title + ' at ' + currentJob.company + '\n\nJob Description:\n' + currentJob.description + '\n\nCurrent Resume:\n' + resumeText + missingKeywordsClause() }
    ];
    var result = await callGroq(msgs, 0.4, 4096);
    removeLoadingMessage('Tailoring');
    tailoringState.tailoredResume = result;
    addTailoringMessage(result, 'final');
    addTailoringQuickOptions(['Save to my resumes', 'Download Resume', 'Start over']);
  } catch (err) {
    removeLoadingMessage('Tailoring');
    addTailoringMessage('Error: ' + err.message, 'ai');
    addTailoringQuickOptions(['Try again', 'Start over']);
  }
}

async function runDeepDive() {
  addTailoringMessage('Analyzing the job requirements against your resume...', 'ai');

  try {
    var msgs = [
      { role: 'system', content: 'You are Alicia, an expert resume tailoring coach. Compare the job description to the candidate\'s resume carefully. Identify 3-5 specific skills, qualifications, or experiences that the job asks for but are NOT clearly demonstrated in the resume.\n\nFor each gap, ask a specific, friendly question to find out if the candidate has relevant unlisted experience. Number each question.\n\nExamples of good questions:\n- "The role mentions stakeholder management at the executive level. Have you presented to or worked directly with C-suite leaders in any of your roles?"\n- "They want experience with agile methodology. Have you run sprints, standups, or used agile frameworks beyond what\'s listed?"\n\nEnd with: "Answer as many as you can — the more detail, the stronger your tailored resume will be!"' },
      { role: 'user', content: 'Target Role: ' + currentJob.title + ' at ' + currentJob.company + '\n\nJob Description:\n' + currentJob.description + '\n\nCandidate Resume:\n' + resumeText }
    ];
    var result = await callGroq(msgs, 0.5);
    removeLoadingMessage('Analyzing');
    addTailoringMessage(result, 'ai');
    addTailoringQuickOptions(['None of these apply', 'Skip — use what I have']);
  } catch (err) {
    removeLoadingMessage('Analyzing');
    addTailoringMessage('Error: ' + err.message, 'ai');
    addTailoringQuickOptions(['Start over']);
  }
}

async function generateTailoredResume() {
  tailoringState.generating = true;
  addTailoringMessage('Building your tailored resume...', 'ai');

  try {
    var extraContext = '';
    if (tailoringState.deepDiveAnswers.length > 0) {
      extraContext = '\n\nAdditional experience shared by the candidate (incorporate naturally where relevant):\n' + tailoringState.deepDiveAnswers.join('\n\n');
    }

    var msgs = [
      { role: 'system', content: RESUME_GEN_SYSTEM },
      { role: 'user', content: 'Target Role: ' + currentJob.title + ' at ' + currentJob.company + '\n\nJob Description:\n' + currentJob.description + '\n\nCurrent Resume:\n' + resumeText + extraContext + missingKeywordsClause() }
    ];
    var result = await callGroq(msgs, 0.4, 4096);
    removeLoadingMessage('Building');
    tailoringState.tailoredResume = result;
    addTailoringMessage(result, 'final');
    addTailoringQuickOptions(['Save to my resumes', 'Download Resume', 'Start over']);
  } catch (err) {
    removeLoadingMessage('Building');
    addTailoringMessage('Error: ' + err.message, 'ai');
    addTailoringQuickOptions(['Try again', 'Start over']);
  }
}

function formatResumeContent(text) {
  if (!text) return '';
  text = sanitizeText(text);
  var lines = text.split('\n');
  var html = '';
  var inList = false;

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];

    if (/^#\s+(.+)/.test(raw) && !/^##/.test(raw)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h1>' + escapeHtml(raw.replace(/^#\s+/, '')) + '</h1>';
    } else if (/^###\s+(.+)/.test(raw)) {
      if (inList) { html += '</ul>'; inList = false; }
      var h3 = escapeHtml(raw.replace(/^###\s+/, ''));
      h3 = h3.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += '<h3>' + h3 + '</h3>';
    } else if (/^##\s+(.+)/.test(raw)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h2>' + escapeHtml(raw.replace(/^##\s+/, '')) + '</h2>';
    } else if (/^\*([^*]+)\*$/.test(raw)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<p class="date">' + escapeHtml(raw.replace(/^\*|\*$/g, '')) + '</p>';
    } else if (/^[*\-]\s+(.+)/.test(raw)) {
      if (!inList) { html += '<ul>'; inList = true; }
      var item = escapeHtml(raw.replace(/^[*\-]\s+/, ''));
      item = item.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += '<li>' + item + '</li>';
    } else if (raw.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      var p = escapeHtml(raw);
      p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += '<p>' + p + '</p>';
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function downloadTailoredResume() {
  if (!tailoringState || !tailoringState.tailoredResume) return;
  var html = formatResumeContent(tailoringState.tailoredResume);
  chrome.storage.local.set({ tailoredResumeHtml: html }, function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('resume-preview.html') });
  });
  addTailoringMessage('Your tailored resume is open in a new tab. Click **Save as PDF** or press **Ctrl+P** to download it.', 'ai');
}

async function handleTailoringResponse(response) {
  addTailoringMessage(response, 'user');
  clearTailoringOptions();

  if (response === 'Start over') { await startTailoring(); return; }

  if (response === 'Download Resume') {
    downloadTailoredResume();
    return;
  }

  if (response === 'Save to my resumes') {
    if (!tailoringState || !tailoringState.tailoredResume) return;
    var jobForName = currentJob || {};
    var nm = 'Resume — ' + [jobForName.company, jobForName.title].filter(Boolean).join(' ');
    if (nm.trim() === 'Resume —') nm = 'Tailored resume';
    var saved = addSavedResume({
      name: nm,
      text: tailoringState.tailoredResume,
      file: null,
      tailoredForJob: (jobForName.title || jobForName.company) ? { title: jobForName.title || '', company: jobForName.company || '' } : null
    });
    addTailoringMessage(saved
      ? 'Saved as **' + escapeHtml(saved.name) + '** and set active. Manage it under **Saved Resumes** in the Tools tab.'
      : 'Could not save — you may be at the 10-resume limit. Delete one under Saved Resumes and try again.', 'ai');
    addTailoringQuickOptions(['Download Resume', 'Start over']);
    return;
  }

  if (response === 'Try again') {
    if (tailoringState.mode === 'quick') { await runQuickTailor(); }
    else { await generateTailoredResume(); }
    return;
  }

  if (!tailoringState.mode) {
    if (response === 'Quick Tailor' || response.toLowerCase().indexOf('quick') >= 0) {
      tailoringState.mode = 'quick';
      await runQuickTailor();
    } else {
      tailoringState.mode = 'deep';
      await runDeepDive();
    }
    return;
  }

  if (tailoringState.mode === 'deep' && !tailoringState.generating) {
    if (response === 'None of these apply' || response === 'Skip — use what I have' || response === 'Done — Generate Resume') {
      await generateTailoredResume();
      return;
    }

    tailoringState.deepDiveAnswers.push(response);
    addTailoringQuickOptions(['Done — Generate Resume', 'Start over']);
    return;
  }
}

tailorBtn.addEventListener('click', function() {
  if (!currentJob || !resumeText) return;
  startTailoring();
});

tailoringSend.addEventListener('click', function() {
  var val = tailoringInput.value.trim();
  if (val) { tailoringInput.value = ''; handleTailoringResponse(val); }
});

tailoringInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    var val = tailoringInput.value.trim();
    if (val) { tailoringInput.value = ''; handleTailoringResponse(val); }
  }
});

closeTailoring.addEventListener('click', function() {
  tailoringSection.classList.add('hidden');
  tailoringState = null;
});

// ----- AI Resume Builder: guided Q&A that produces a resume from scratch -----
var BUILDER_SYSTEM = 'You are Alicia, an expert resume writer. Build a complete, professional resume from the structured notes the candidate gave you.\n\nRules:\n- Use ONLY the facts provided — never invent jobs, dates, schools, or achievements\n- Write a targeted professional summary (2-3 sentences) based on their target role\n- Turn their rough notes into strong, quantified achievement bullets using action verbs\n- Group skills into sensible categories if possible\n- Include every job and school they gave you\n\nFormat the resume in markdown using these exact patterns:\n# [Candidate Name]\n[Contact info on one line, separated by |]\n\n## Summary\n[2-3 sentence tailored summary]\n\n## Technical Skills\n- **[Category]:** [comma-separated skills]\n\n## Experience\n### [Job Title] | [Company]\n*[Date range]*\n- [achievement bullet]\n- [achievement bullet]\n\n## Education\n**[School]**\n[Degree/program] | [Dates]';

var builderState = null;

function addBuilderMessage(text, role) {
  var div = document.createElement('div');
  div.className = 'tailoring-msg ' + role;
  div.innerHTML = (role === 'ai' || role === 'final') ? formatAnalysis(text) : escapeHtml(text);
  builderConversation.appendChild(div);
  builderConversation.scrollTop = builderConversation.scrollHeight;
}

function clearBuilderOptions() {
  builderOptions.innerHTML = '';
}

function addBuilderQuickOptions(options) {
  clearBuilderOptions();
  options.forEach(function (opt) {
    var btn = document.createElement('button');
    btn.className = 'tailoring-option-btn';
    btn.textContent = opt;
    btn.addEventListener('click', function () { handleBuilderResponse(opt); });
    builderOptions.appendChild(btn);
  });
}

function removeBuilderLoadingMessage(keyword) {
  var msgs = builderConversation.querySelectorAll('.tailoring-msg.ai');
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].textContent.indexOf(keyword) >= 0) { msgs[i].remove(); break; }
  }
}

function startBuilder() {
  builderSection.classList.remove('hidden');
  builderConversation.innerHTML = '';
  clearBuilderOptions();
  builderInput.value = '';
  builderState = {
    step: 'name',
    data: { name: '', email: '', phone: '', location: '', linkedin: '', targetRole: '', jobs: [], education: [], skills: '' },
    jobDraft: null,
    generatedResume: null
  };
  addBuilderMessage('Let\'s build your resume from scratch. What\'s your full name?', 'ai');
}

async function generateBuiltResume() {
  addBuilderMessage('Building your resume...', 'ai');
  try {
    var d = builderState.data;
    var jobsText = d.jobs.length
      ? d.jobs.map(function (j, i) { return (i + 1) + '. ' + j.title + ' at ' + j.company + ' (' + j.dates + ')\n' + j.bullets; }).join('\n\n')
      : '(no work history provided)';
    var eduText = d.education.length ? d.education.join('\n') : '(no education provided)';
    var contact = [d.email, d.phone, d.location, d.linkedin].filter(Boolean).join(' | ');
    var user = 'Name: ' + d.name + '\nContact: ' + contact + '\nTarget Role: ' + d.targetRole +
      '\n\nWork History:\n' + jobsText + '\n\nEducation:\n' + eduText + '\n\nSkills:\n' + (d.skills || '(none provided)');
    var result = await callGroq([{ role: 'system', content: BUILDER_SYSTEM }, { role: 'user', content: user }], 0.4, 4096);
    removeBuilderLoadingMessage('Building');
    builderState.generatedResume = result;
    addBuilderMessage(result, 'final');
    addBuilderQuickOptions(['Download Resume', 'Use as My Resume', 'Start over']);
  } catch (err) {
    removeBuilderLoadingMessage('Building');
    addBuilderMessage('Error: ' + err.message, 'ai');
    addBuilderQuickOptions(['Try again', 'Start over']);
  }
}

function downloadBuiltResume() {
  if (!builderState || !builderState.generatedResume) return;
  var html = formatResumeContent(builderState.generatedResume);
  chrome.storage.local.set({ tailoredResumeHtml: html }, function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('resume-preview.html') });
  });
  addBuilderMessage('Your resume is open in a new tab. Click **Save as PDF** or press **Ctrl+P** to download it.', 'ai');
}

async function useBuiltResumeAsMyResume() {
  if (!builderState || !builderState.generatedResume) return;
  var added = addSavedResume({ name: 'Built resume', text: builderState.generatedResume, file: null });
  if (!added) return;
  setResumeStatus('Resume saved from builder', '#4caf50');
  addBuilderMessage('Saved as your active resume — Tailor Resume, Cover Letter, Interview Prep, and Match Score can all use it now. Manage it under **Saved Resumes**.', 'ai');
}

function handleBuilderResponse(response) {
  addBuilderMessage(response, 'user');
  clearBuilderOptions();
  if (!builderState) return;

  if (response === 'Start over') { startBuilder(); return; }
  if (response === 'Download Resume') { downloadBuiltResume(); return; }
  if (response === 'Use as My Resume') { useBuiltResumeAsMyResume(); return; }
  if (response === 'Try again') { generateBuiltResume(); return; }

  var d = builderState.data;
  switch (builderState.step) {
    case 'name':
      d.name = response; builderState.step = 'email';
      addBuilderMessage('What email address should be on it?', 'ai');
      break;
    case 'email':
      d.email = response; builderState.step = 'phone';
      addBuilderMessage('Phone number?', 'ai');
      break;
    case 'phone':
      d.phone = response; builderState.step = 'location';
      addBuilderMessage('City and state?', 'ai');
      break;
    case 'location':
      d.location = response; builderState.step = 'linkedin';
      addBuilderMessage('LinkedIn URL? (or tap Skip)', 'ai');
      addBuilderQuickOptions(['Skip']);
      break;
    case 'linkedin':
      d.linkedin = (response === 'Skip') ? '' : response;
      builderState.step = 'targetRole';
      addBuilderMessage('What job title or field are you targeting with this resume?', 'ai');
      break;
    case 'targetRole':
      d.targetRole = response; builderState.step = 'job_title'; builderState.jobDraft = {};
      addBuilderMessage('Let\'s add your work history. What was your job title? (or tap Done if you have none to add)', 'ai');
      addBuilderQuickOptions(['Done adding jobs']);
      break;
    case 'job_title':
      if (response === 'Done adding jobs') {
        builderState.step = 'edu_entry';
        addBuilderMessage('Now education — add a school (degree, school, dates), or tap Done.', 'ai');
        addBuilderQuickOptions(['Done adding education']);
      } else {
        builderState.jobDraft.title = response; builderState.step = 'job_company';
        addBuilderMessage('What company?', 'ai');
      }
      break;
    case 'job_company':
      builderState.jobDraft.company = response; builderState.step = 'job_dates';
      addBuilderMessage('What dates did you work there? (e.g. Jan 2022 – Present)', 'ai');
      break;
    case 'job_dates':
      builderState.jobDraft.dates = response; builderState.step = 'job_bullets';
      addBuilderMessage('Give me 2-4 bullet points on what you did or achieved there (separate with new lines or semicolons).', 'ai');
      break;
    case 'job_bullets':
      builderState.jobDraft.bullets = response;
      d.jobs.push(builderState.jobDraft);
      builderState.jobDraft = null;
      builderState.step = 'job_more';
      addBuilderMessage('Add another job?', 'ai');
      addBuilderQuickOptions(['Yes', 'No, that\'s all']);
      break;
    case 'job_more':
      if (response.toLowerCase().indexOf('yes') >= 0) {
        builderState.jobDraft = {}; builderState.step = 'job_title';
        addBuilderMessage('What was your job title?', 'ai');
      } else {
        builderState.step = 'edu_entry';
        addBuilderMessage('Now education — add a school (degree, school, dates), or tap Done.', 'ai');
        addBuilderQuickOptions(['Done adding education']);
      }
      break;
    case 'edu_entry':
      if (response === 'Done adding education') {
        builderState.step = 'skills';
        addBuilderMessage('List your key skills, comma-separated.', 'ai');
      } else {
        d.education.push(response);
        addBuilderMessage('Add another school, or tap Done.', 'ai');
        addBuilderQuickOptions(['Done adding education']);
      }
      break;
    case 'skills':
      d.skills = response; builderState.step = 'generating';
      generateBuiltResume();
      break;
  }
}

buildResumeBtn.addEventListener('click', startBuilder);

builderSend.addEventListener('click', function () {
  var val = builderInput.value.trim();
  if (val) { builderInput.value = ''; handleBuilderResponse(val); }
});

builderInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    var val = builderInput.value.trim();
    if (val) { builderInput.value = ''; handleBuilderResponse(val); }
  }
});

closeBuilder.addEventListener('click', function () {
  builderSection.classList.add('hidden');
  builderState = null;
});

function addChatMessage(text, role) {
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.innerHTML = role === 'ai' ? formatAnalysis(text) : escapeHtml(text);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChat() {
  chatMessages.innerHTML = '';
  chatStore[chatMode].forEach(function(r) { addChatMessage(r.text, r.role); });
}

function updateChatHint() {
  var base = chatMode === 'general'
    ? 'General assistant — ask anything, attach a photo, or paste a link to discuss.'
    : 'Ask about this job, your resume, or your search.';
  if (!isPremium) {
    ensureUsageFresh();
    var bucket = chatMode === 'job' ? 'jobChat' : 'generalChat';
    var left = Math.max(0, FREE_LIMITS[bucket] - usage[bucket]);
    base += '  ·  ' + left + ' message' + (left === 1 ? '' : 's') + ' left today';
  }
  chatModeHint.textContent = base;
}

function setChatMode(mode) {
  chatMode = mode;
  modeJobBtn.classList.toggle('active', mode === 'job');
  modeGeneralBtn.classList.toggle('active', mode === 'general');
  if (mode === 'general') {
    chatAttachBtn.classList.remove('hidden');
    chatInput.placeholder = 'Ask anything, or paste a link...';
  } else {
    chatAttachBtn.classList.add('hidden');
    chatInput.placeholder = 'Ask Alicia anything...';
    clearPendingImage();
  }
  updateChatHint();
  renderChat();
}

// ---------- Image attachment ----------

function clearPendingImage() {
  pendingImage = null;
  chatAttachment.classList.add('hidden');
  chatAttachment.innerHTML = '';
  if (chatImageInput) chatImageInput.value = '';
}

function showPendingImage() {
  if (!pendingImage) return;
  chatAttachment.classList.remove('hidden');
  chatAttachment.innerHTML = '';
  var img = document.createElement('img');
  img.src = pendingImage.dataUrl;
  img.className = 'chat-attach-thumb';
  var label = document.createElement('span');
  label.className = 'chat-attach-name';
  label.textContent = pendingImage.name || 'Image attached';
  var remove = document.createElement('button');
  remove.className = 'chat-attach-remove';
  remove.textContent = '✕';
  remove.title = 'Remove image';
  remove.addEventListener('click', clearPendingImage);
  chatAttachment.appendChild(img);
  chatAttachment.appendChild(label);
  chatAttachment.appendChild(remove);
}

// Read an image file/blob, downscale to keep the request light, return { dataUrl, name }.
function loadImageFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() {
      var img = new Image();
      img.onload = function() {
        var maxDim = 1024;
        var w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), name: file.name || 'pasted image' });
      };
      img.onerror = function() { reject(new Error('Could not read that image.')); };
      img.src = reader.result;
    };
    reader.onerror = function() { reject(new Error('Could not read that image.')); };
    reader.readAsDataURL(file);
  });
}

async function attachImage(file) {
  if (!file) return;
  try {
    pendingImage = await loadImageFile(file);
    showPendingImage();
  } catch (e) {
    addChatMessage('Sorry, I could not load that image. Try a JPG or PNG.', 'ai');
  }
}

// ---------- Web browsing ----------

function extractUrls(text) {
  if (!text) return [];
  var m = text.match(/https?:\/\/[^\s<>"')]+/g);
  return m || [];
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}

function htmlToReadableText(html) {
  var cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  var bodyMatch = cleaned.match(/<body[\s\S]*?<\/body>/i);
  var src = bodyMatch ? bodyMatch[0] : cleaned;
  var text = src
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  return text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Fetch a page's readable text. Tries a direct fetch first (private, needs host
// permission), then falls back to Jina's reader which renders JS-heavy pages.
async function fetchPageText(url) {
  try {
    var resp = await fetch(url, { redirect: 'follow' });
    if (resp.ok) {
      var html = await resp.text();
      var text = htmlToReadableText(html);
      if (text && text.length > 500) return text;
    }
  } catch (e) { /* fall through to reader service */ }

  try {
    var jResp = await fetch('https://r.jina.ai/' + url);
    if (jResp.ok) {
      var jText = await jResp.text();
      if (jText && jText.trim().length > 50) return jText.trim();
    }
  } catch (e2) { /* give up */ }

  return null;
}

// ---------- Chat send ----------

function buildChatSystemMessage() {
  let msg = 'You are Alicia, an expert, friendly, and honest AI job search coach and career advisor.\n\nCore behaviors:\n- Be concise, actionable, and structured (use short paragraphs + bullets when helpful).\n- When a job is loaded, proactively analyze fit: highlight strong matches from the resume, identify gaps, and suggest how to position experience or address weaknesses.\n- Give practical suggestions for applications, networking, LinkedIn outreach, or interview prep.\n- For salary questions: give realistic ranges based on role + location + experience level (use general market knowledge). Be transparent about sources/uncertainty.\n- For company or market questions: share known signals about culture, recent news, hiring trends, or interview process.\n- Always tie advice back to the candidate\'s actual resume and the specific job when possible.\n- Be encouraging but never sugarcoat -- honesty builds trust.';

  if (currentJob) {
    msg += '\n\nCurrent job context:\nTitle: ' + currentJob.title + '\nCompany: ' + currentJob.company + '\nLocation: ' + (currentJob.location || 'Not specified');
    if (currentJob.description) {
      msg += '\nJob description (first 1200 chars): ' + currentJob.description.substring(0, 1200);
    }
  }

  if (resumeText) {
    msg += '\n\nCandidate resume (first 1800 chars):\n' + resumeText.substring(0, 1800);
  }

  msg += '\n\nRespond helpfully to any job-search related question.';
  return msg;
}

function buildGeneralSystemMessage() {
  return 'You are Alicia, a warm, practical, and knowledgeable personal assistant. You help with everyday life: fixing things around the house, work questions, budgeting and personal finance, hobbies, planning, cooking, writing, and learning new things. '
    + 'Be clear, friendly, and genuinely useful. When solving a problem, give step-by-step help. When you are unsure or something is outside your knowledge, say so honestly rather than guessing. '
    + 'Keep answers concise but complete; use short paragraphs or bullet points when they help. '
    + 'When the user shares an image, describe what is relevant and answer their question about it. '
    + 'When the user shares a link and its page content is provided to you, base your answer on that content; if the page could not be loaded, say so plainly and answer from general knowledge.';
}

function showUpgradeNotice(bucket) {
  var label = bucket === 'jobChat' ? 'Job Coach messages'
    : bucket === 'image' ? 'image analyses' : 'General chat messages';
  var cap = FREE_LIMITS[bucket];
  showChatNotice('You\'ve used all ' + cap + ' free ' + label + ' for today. They reset tomorrow — or go Premium for unlimited chat. (All other tools stay free.)');
}

async function sendChat() {
  var text = chatInput.value.trim();
  if (!text && !pendingImage) return;

  var imageForTurn = (chatMode === 'general') ? pendingImage : null;
  var meterBucket = chatMode === 'job' ? 'jobChat' : 'generalChat';

  // Free-tier metering: full toolset stays free; chat is capped per day.
  if (!isPremium) {
    ensureUsageFresh();
    if (usage[meterBucket] >= FREE_LIMITS[meterBucket]) { showUpgradeNotice(meterBucket); return; }
    if (imageForTurn && usage.image >= FREE_LIMITS.image) { showUpgradeNotice('image'); return; }
  }

  chatInput.value = '';
  var store = chatStore[chatMode];

  var userDisplay = text;
  if (imageForTurn) userDisplay = (text ? text + '\n' : '') + '🖼️ [image attached]';
  addChatMessage(userDisplay, 'user');
  clearPendingImage();

  // Web browsing (general mode only): if the message has a link, fetch it.
  var urlContext = '';
  if (chatMode === 'general' && !imageForTurn) {
    var urls = extractUrls(text);
    if (urls.length) {
      var shortUrl = urls[0].replace(/^https?:\/\//, '').slice(0, 45);
      addChatMessage('Reading ' + shortUrl + '…', 'ai');
      var pageText = await fetchPageText(urls[0]);
      chatMessages.lastElementChild.remove();
      if (pageText) {
        urlContext = '\n\n[Content fetched from ' + urls[0] + ']:\n' + pageText.slice(0, 6000);
      } else {
        urlContext = '\n\n[Note: the page at ' + urls[0] + ' could not be opened. Tell the user you could not load it, then answer from general knowledge if you can.]';
      }
    }
  }

  // Lightweight record kept in history (no base64 image, no full page dump).
  var historyNote = text;
  if (imageForTurn) historyNote = (text || 'What is in this image?') + ' [shared an image]';
  store.push({ role: 'user', text: userDisplay, api: { role: 'user', content: historyNote } });

  // Heavy content used only for THIS request.
  var heavyContent;
  if (imageForTurn) {
    heavyContent = [
      { type: 'text', text: (text || 'What is in this image?') + urlContext },
      { type: 'image_url', image_url: { url: imageForTurn.dataUrl } }
    ];
  } else {
    heavyContent = text + urlContext;
  }

  var systemMsg = chatMode === 'job' ? buildChatSystemMessage() : buildGeneralSystemMessage();
  var apiMessages = [{ role: 'system', content: systemMsg }].concat(store.map(function (r) { return r.api; }));
  apiMessages[apiMessages.length - 1] = { role: 'user', content: heavyContent };

  addChatMessage('Thinking...', 'ai');

  try {
    var result = await callGroq(apiMessages);
    chatMessages.lastElementChild.remove();
    addChatMessage(result, 'ai');
    store.push({ role: 'ai', text: result, api: { role: 'assistant', content: result } });
    if (store.length > 16) store.splice(0, store.length - 16);
    persistLive();
    if (!isPremium) {
      ensureUsageFresh();
      usage[meterBucket]++;
      if (imageForTurn) usage.image++;
      persistUsage();
      updateChatHint();
    }
  } catch (err) {
    chatMessages.lastElementChild.remove();
    addChatMessage('Error: ' + err.message, 'ai');
    if (store.length && store[store.length - 1].role === 'user') store.pop();
    persistLive();
  }
}

modeJobBtn.addEventListener('click', function () { if (chatMode !== 'job') setChatMode('job'); });
modeGeneralBtn.addEventListener('click', function () { if (chatMode !== 'general') setChatMode('general'); });

chatAttachBtn.addEventListener('click', function () { chatImageInput.click(); });
chatImageInput.addEventListener('change', function (e) {
  if (e.target.files && e.target.files[0]) attachImage(e.target.files[0]);
});

// Paste an image straight into the input (e.g. a screenshot) while in General mode.
chatInput.addEventListener('paste', function (e) {
  if (chatMode !== 'general' || !e.clipboardData) return;
  var items = e.clipboardData.items;
  for (var i = 0; i < items.length; i++) {
    if (items[i].type && items[i].type.indexOf('image') === 0) {
      var file = items[i].getAsFile();
      if (file) { e.preventDefault(); attachImage(file); break; }
    }
  }
});

// ---------- Themes ----------

function applyTheme(name) {
  if (THEME_NAMES.indexOf(name) < 0) name = 'midnight';
  for (var i = 0; i < THEME_NAMES.length; i++) {
    document.body.classList.remove('theme-' + THEME_NAMES[i]);
  }
  document.body.classList.add('theme-' + name);
  themeDots.forEach(function (d) {
    d.classList.toggle('active', d.getAttribute('data-theme') === name);
  });
}

themeDots.forEach(function (dot) {
  dot.addEventListener('click', function () {
    var name = dot.getAttribute('data-theme');
    applyTheme(name);
    chrome.storage.local.set({ theme: name });
  });
});

// ---------- Live chat persistence ----------

function persistLive() {
  chrome.storage.local.set({ liveChat: chatStore });
}

// ---------- Saved chat sessions ----------

function persistSessions() {
  chrome.storage.local.set({ chatSessions: chatSessions });
}

function sessionTitle(records) {
  for (var i = 0; i < records.length; i++) {
    if (records[i].role === 'user' && records[i].text) {
      var t = records[i].text.replace(/🖼️ \[image attached\]/g, '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 42 ? t.slice(0, 42) + '…' : t;
    }
  }
  return 'Chat';
}

function formatSessionDate(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Archive the current conversation (if any) into saved sessions, enforcing the cap.
function archiveCurrent() {
  var records = chatStore[chatMode];
  if (!records || records.length === 0) return;

  chatSessions.unshift({
    id: 'cs_' + Date.now(),
    title: sessionTitle(records),
    mode: chatMode,
    ts: Date.now(),
    pinned: false,
    records: records.map(function (r) { return { role: r.role, text: r.text, api: r.api }; })
  });

  // Enforce cap on UNPINNED sessions; collect evicted titles for the notice.
  var cap = historyCap();
  var unpinnedCount = 0;
  var evicted = [];
  var kept = [];
  for (var i = 0; i < chatSessions.length; i++) {
    var s = chatSessions[i];
    if (s.pinned) { kept.push(s); continue; }
    unpinnedCount++;
    if (unpinnedCount <= cap) { kept.push(s); }
    else { evicted.push(s.title); }
  }
  chatSessions = kept;
  persistSessions();

  if (evicted.length) {
    showChatNotice('Removed older chat' + (evicted.length > 1 ? 's' : '') + ' "' +
      evicted.join('", "') + '" to keep your last ' + cap +
      '. Tap ★ on a chat to keep it permanently' +
      (isPremium ? '.' : ', or go Premium to save more.'));
  }
}

function clearChat() {
  archiveCurrent();
  chatStore[chatMode] = [];
  persistLive();
  renderChat();
  if (!chatHistoryPanel.classList.contains('hidden')) renderHistory();
}

function showChatNotice(text) {
  chatNotice.innerHTML = '';
  var span = document.createElement('span');
  span.textContent = text;
  var close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Dismiss';
  close.addEventListener('click', function () { chatNotice.classList.add('hidden'); });
  chatNotice.appendChild(span);
  chatNotice.appendChild(close);
  chatNotice.classList.remove('hidden');
}

function toggleHistoryPanel() {
  if (chatHistoryPanel.classList.contains('hidden')) {
    renderHistory();
    chatHistoryPanel.classList.remove('hidden');
  } else {
    chatHistoryPanel.classList.add('hidden');
  }
}

function renderHistory() {
  chatHistoryPanel.innerHTML = '';
  if (chatSessions.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No saved chats yet. Use Clear to save the current chat here.';
    chatHistoryPanel.appendChild(empty);
    return;
  }

  chatSessions.forEach(function (s) {
    var row = document.createElement('div');
    row.className = 'history-row';

    var main = document.createElement('div');
    main.className = 'history-main';
    var title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = s.title;
    var meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = (s.mode === 'job' ? 'Job Coach' : 'General') + ' · ' + formatSessionDate(s.ts) + (s.pinned ? ' · kept' : '');
    main.appendChild(title);
    main.appendChild(meta);
    main.addEventListener('click', function () { loadSession(s.id); });

    var star = document.createElement('button');
    star.className = 'history-star' + (s.pinned ? ' pinned' : '');
    star.textContent = s.pinned ? '★' : '☆';
    star.title = s.pinned ? 'Saved permanently — click to unpin' : 'Keep permanently';
    star.addEventListener('click', function (e) { e.stopPropagation(); pinSession(s.id); });

    var del = document.createElement('button');
    del.className = 'history-del';
    del.textContent = '🗑';
    del.title = 'Delete this chat';
    del.addEventListener('click', function (e) { e.stopPropagation(); deleteSession(s.id); });

    row.appendChild(main);
    row.appendChild(star);
    row.appendChild(del);
    chatHistoryPanel.appendChild(row);
  });
}

function findSession(id) {
  for (var i = 0; i < chatSessions.length; i++) {
    if (chatSessions[i].id === id) return chatSessions[i];
  }
  return null;
}

function loadSession(id) {
  var s = findSession(id);
  if (!s) return;
  archiveCurrent(); // don't lose the current conversation
  if (s.mode !== chatMode) setChatMode(s.mode);
  chatStore[chatMode] = s.records.map(function (r) { return { role: r.role, text: r.text, api: r.api }; });
  persistLive();
  renderChat();
  chatHistoryPanel.classList.add('hidden');
}

function pinSession(id) {
  var s = findSession(id);
  if (!s) return;
  s.pinned = !s.pinned;
  persistSessions();
  renderHistory();
}

function deleteSession(id) {
  chatSessions = chatSessions.filter(function (s) { return s.id !== id; });
  persistSessions();
  renderHistory();
}

chatClearBtn.addEventListener('click', clearChat);
chatHistoryBtn.addEventListener('click', toggleHistoryPanel);

// ========== Job Application Tracker ==========

function persistTrackedJobs() {
  chrome.storage.local.set({ trackedJobs: trackedJobs });
}

function findTrackedByUrl(url) {
  if (!url) return null;
  for (var i = 0; i < trackedJobs.length; i++) {
    if (trackedJobs[i].url === url) return trackedJobs[i];
  }
  return null;
}

function refreshSaveJobBtn() {
  if (!saveJobBtn || !currentJob) return;
  var existing = findTrackedByUrl(currentJob.url);
  if (existing) {
    saveJobBtn.textContent = '✓ Saved to Tracker';
    saveJobBtn.classList.add('saved');
    saveJobBtn.disabled = true;
  } else {
    saveJobBtn.innerHTML = '&#43; Save to Tracker';
    saveJobBtn.classList.remove('saved');
    saveJobBtn.disabled = false;
  }
}

function saveCurrentJob() {
  if (!currentJob) return;
  if (findTrackedByUrl(currentJob.url)) return;
  trackedJobs.unshift({
    id: 'tj_' + Date.now(),
    title: currentJob.title || 'Untitled role',
    company: currentJob.company || '',
    location: currentJob.location || '',
    url: currentJob.url || '',
    description: (currentJob.description || '').slice(0, 4000),
    status: 'saved',
    notes: '',
    savedAt: Date.now()
  });
  persistTrackedJobs();
  refreshSaveJobBtn();
  renderTracker();
  if (trackerBody.classList.contains('hidden')) toggleTracker(true);
}

function formatTrackerDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTrackerStats() {
  var counts = { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  trackedJobs.forEach(function (j) { if (counts[j.status] !== undefined) counts[j.status]++; });
  trackerStats.innerHTML = '';
  TRACKER_STAGES.forEach(function (stage) {
    var box = document.createElement('div');
    box.className = 'tracker-stat';
    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = counts[stage.key];
    var lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = stage.label;
    box.appendChild(num);
    box.appendChild(lbl);
    trackerStats.appendChild(box);
  });
}

function setJobStatus(id, status) {
  for (var i = 0; i < trackedJobs.length; i++) {
    if (trackedJobs[i].id === id) { trackedJobs[i].status = status; break; }
  }
  persistTrackedJobs();
  renderTracker();
}

function setJobNotes(id, notes) {
  for (var i = 0; i < trackedJobs.length; i++) {
    if (trackedJobs[i].id === id) { trackedJobs[i].notes = notes; break; }
  }
  persistTrackedJobs();
}

function deleteTrackedJob(id) {
  trackedJobs = trackedJobs.filter(function (j) { return j.id !== id; });
  persistTrackedJobs();
  refreshSaveJobBtn();
  renderTracker();
}

function renderTracker() {
  renderTrackerStats();
  trackerList.innerHTML = '';
  if (trackedJobs.length === 0) {
    trackerEmpty.classList.remove('hidden');
    return;
  }
  trackerEmpty.classList.add('hidden');

  trackedJobs.forEach(function (job) {
    var row = document.createElement('div');
    row.className = 'tracker-row';

    var top = document.createElement('div');
    top.className = 'tracker-row-top';
    var main = document.createElement('div');
    main.className = 'tracker-row-main';

    var title = document.createElement('div');
    title.className = 'tracker-row-title';
    title.textContent = job.title;
    if (job.url) {
      title.style.cursor = 'pointer';
      title.title = 'Open job posting';
      title.addEventListener('click', function () { chrome.tabs.create({ url: job.url }); });
    }
    main.appendChild(title);

    if (job.company) {
      var comp = document.createElement('div');
      comp.className = 'tracker-row-company';
      comp.textContent = job.company + (job.location ? ' · ' + job.location : '');
      main.appendChild(comp);
    }
    var date = document.createElement('div');
    date.className = 'tracker-row-date';
    date.textContent = 'Saved ' + formatTrackerDate(job.savedAt);
    main.appendChild(date);

    var del = document.createElement('button');
    del.className = 'tracker-del';
    del.textContent = '🗑';
    del.title = 'Remove from tracker';
    del.addEventListener('click', function () { deleteTrackedJob(job.id); });

    top.appendChild(main);
    top.appendChild(del);
    row.appendChild(top);

    var stages = document.createElement('div');
    stages.className = 'tracker-stages';
    TRACKER_STAGES.forEach(function (stage) {
      var btn = document.createElement('button');
      btn.className = 'tracker-stage s-' + stage.key + (job.status === stage.key ? ' active' : '');
      btn.textContent = stage.label;
      btn.addEventListener('click', function () { setJobStatus(job.id, stage.key); });
      stages.appendChild(btn);
    });
    row.appendChild(stages);

    var notes = document.createElement('textarea');
    notes.className = 'tracker-notes';
    notes.placeholder = 'Notes (contacts, follow-up dates, salary...)';
    notes.value = job.notes || '';
    notes.addEventListener('change', function () { setJobNotes(job.id, notes.value); });
    notes.addEventListener('blur', function () { setJobNotes(job.id, notes.value); });
    row.appendChild(notes);

    trackerList.appendChild(row);
  });
}

function toggleTracker(forceOpen) {
  var open = forceOpen === true || trackerBody.classList.contains('hidden');
  trackerBody.classList.toggle('hidden', !open);
  trackerToggle.innerHTML = open ? '&#128202; Hide' : '&#128202; Show';
  if (open) renderTracker();
}

if (saveJobBtn) saveJobBtn.addEventListener('click', saveCurrentJob);
if (trackerToggle) trackerToggle.addEventListener('click', function () { toggleTracker(); });

// ========== Interview Prep ==========

const interviewTabs = Array.prototype.slice.call(document.querySelectorAll('.interview-tab'));
const ivGenQuestions = document.getElementById('iv-gen-questions');
const ivQuestionsContent = document.getElementById('iv-questions-content');
const ivGenCompany = document.getElementById('iv-gen-company');
const ivCompanyContent = document.getElementById('iv-company-content');
const ivStarQuestion = document.getElementById('iv-star-question');
const ivStarNotes = document.getElementById('iv-star-notes');
const ivGenStar = document.getElementById('iv-gen-star');
const ivStarContent = document.getElementById('iv-star-content');
const ivPracticeConversation = document.getElementById('iv-practice-conversation');
const ivPracticeStart = document.getElementById('iv-practice-start');
const ivPracticeInputArea = document.getElementById('iv-practice-input-area');
const ivPracticeInput = document.getElementById('iv-practice-input');
const ivPracticeSend = document.getElementById('iv-practice-send');

function jobContextBlock() {
  if (!currentJob) return '';
  var block = 'Job Title: ' + currentJob.title + '\nCompany: ' + (currentJob.company || 'N/A') +
    '\nLocation: ' + (currentJob.location || 'N/A');
  if (currentJob.description) block += '\n\nJob Description:\n' + currentJob.description.slice(0, 3000);
  return block;
}

function switchInterviewTab(tab) {
  interviewTabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === tab); });
  ['questions', 'company', 'star', 'practice'].forEach(function (name) {
    document.getElementById('iv-tab-' + name).classList.toggle('hidden', name !== tab);
  });
}

interviewTabs.forEach(function (t) {
  t.addEventListener('click', function () { switchInterviewTab(t.getAttribute('data-tab')); });
});

interviewBtn.addEventListener('click', function () {
  if (!currentJob) return;
  interviewSection.classList.remove('hidden');
  switchInterviewTab('questions');
  interviewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

closeInterview.addEventListener('click', function () {
  interviewSection.classList.add('hidden');
});

async function ivGenerate(button, target, systemMsg, userMsg, temp, maxTokens) {
  button.disabled = true;
  var originalLabel = button.textContent;
  button.textContent = 'Working...';
  target.innerHTML = '<p class="loading">Thinking...</p>';
  try {
    var result = await callGroq([
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg }
    ], temp || 0.6, maxTokens || 2048);
    target.innerHTML = formatAnalysis(result);
  } catch (err) {
    target.innerHTML = '<p style="color:#ff5555">' + escapeHtml(err.message) + '</p>';
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

ivGenQuestions.addEventListener('click', function () {
  if (!currentJob) return;
  var sys = 'You are Alicia, an expert interview coach. Generate a focused set of likely interview questions for this specific role. Organize with ## headers into: Behavioral, Role-Specific / Technical, and Questions to Ask Them. Under each, list 4-6 questions as bullets. If a resume is provided, tailor a couple of questions to probe the candidate\'s background and likely gaps. Keep it practical and specific to this job — no generic filler.';
  var user = jobContextBlock();
  if (resumeText) user += '\n\nCandidate Resume:\n' + resumeText.slice(0, 2500);
  ivGenerate(ivGenQuestions, ivQuestionsContent, sys, user, 0.6, 2048);
});

ivGenCompany.addEventListener('click', async function () {
  if (!currentJob) return;
  ivGenCompany.disabled = true;
  ivGenCompany.textContent = 'Researching...';
  ivCompanyContent.innerHTML = '<p class="loading">Researching ' + escapeHtml(currentJob.company || 'the company') + '...</p>';

  var webContext = '';
  if (currentJob.company) {
    try {
      var pageText = await fetchPageText('https://www.google.com/search?q=' +
        encodeURIComponent(currentJob.company + ' company about news'));
      if (pageText) webContext = '\n\n[Web search results — use cautiously, may be noisy]:\n' + pageText.slice(0, 3500);
    } catch (e) { /* fall back to model knowledge */ }
  }

  var sys = 'You are Alicia, an interview prep researcher. Produce a concise company research brief to help a candidate prepare. Use ## headers: What They Do, Culture & Values, Recent News / Signals, Likely Interview Focus, and Smart Questions to Ask. Base it on the job description, any provided web content, and general knowledge. Be honest about uncertainty — if you are not sure about a fact, say so rather than inventing it.';
  var user = jobContextBlock() + webContext;
  try {
    var result = await callGroq([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], 0.6, 2048);
    ivCompanyContent.innerHTML = formatAnalysis(result);
  } catch (err) {
    ivCompanyContent.innerHTML = '<p style="color:#ff5555">' + escapeHtml(err.message) + '</p>';
  } finally {
    ivGenCompany.disabled = false;
    ivGenCompany.textContent = 'Research Company';
  }
});

ivGenStar.addEventListener('click', function () {
  var q = ivStarQuestion.value.trim();
  var notes = ivStarNotes.value.trim();
  if (!notes) {
    ivStarContent.innerHTML = '<p style="color:#ff9955">Add a few rough notes about your story first.</p>';
    return;
  }
  var sys = 'You are Alicia, an interview coach specializing in the STAR method. Take the candidate\'s rough notes and shape them into a polished, confident answer. Output with ## headers for Situation, Task, Action, and Result — each 1-3 tight sentences. Then add a ## Delivery Tip with one short note on how to say it well. Keep it truthful to their notes; do not invent achievements. If their notes are missing a clear result, gently prompt them to quantify it.';
  var user = 'Behavioral question: ' + (q || '(not specified — infer a likely one)') + '\n\nCandidate rough notes:\n' + notes;
  if (currentJob) user += '\n\nTarget role context:\n' + jobContextBlock();
  ivGenerate(ivGenStar, ivStarContent, sys, user, 0.6, 1500);
});

// ----- Mock interview practice -----

function ivAddPracticeMsg(text, role) {
  var div = document.createElement('div');
  div.className = 'tailoring-msg ' + (role === 'ai' ? 'ai' : 'user');
  div.innerHTML = role === 'ai' ? formatAnalysis(text) : escapeHtml(text);
  ivPracticeConversation.appendChild(div);
  ivPracticeConversation.scrollTop = ivPracticeConversation.scrollHeight;
}

function ivPracticeSystem() {
  var sys = 'You are Alicia, conducting a realistic but supportive mock interview for the role below. ' +
    'Behavior:\n- Ask ONE question at a time and wait for the answer.\n' +
    '- After each candidate answer, give brief, specific feedback (1-2 sentences: what worked + one concrete improvement), then ask the next question.\n' +
    '- Mix behavioral and role-specific questions relevant to this job.\n' +
    '- Keep your turns short. Do not dump multiple questions at once.\n' +
    '- After about 5 questions, wrap up with a short overall assessment and top 2 things to work on.\n' +
    'Start by introducing yourself in one line and asking the first question.\n\n' + jobContextBlock();
  if (resumeText) sys += '\n\nCandidate Resume (for tailoring questions):\n' + resumeText.slice(0, 2000);
  return sys;
}

async function ivStartPractice() {
  practiceState = { messages: [{ role: 'system', content: ivPracticeSystem() }] };
  ivPracticeConversation.innerHTML = '';
  ivPracticeStart.textContent = 'Restart';
  ivPracticeInputArea.classList.remove('hidden');
  ivAddPracticeMsg('Setting up your mock interview...', 'ai');
  try {
    var first = await callGroq(practiceState.messages, 0.7, 800);
    ivPracticeConversation.lastElementChild.remove();
    ivAddPracticeMsg(first, 'ai');
    practiceState.messages.push({ role: 'assistant', content: first });
    ivPracticeInput.focus();
  } catch (err) {
    ivPracticeConversation.lastElementChild.remove();
    ivAddPracticeMsg('Error: ' + err.message, 'ai');
  }
}

async function ivSendPractice() {
  if (!practiceState) return;
  var answer = ivPracticeInput.value.trim();
  if (!answer) return;
  ivPracticeInput.value = '';
  ivAddPracticeMsg(answer, 'user');
  practiceState.messages.push({ role: 'user', content: answer });
  ivAddPracticeMsg('Thinking...', 'ai');
  try {
    var reply = await callGroq(practiceState.messages, 0.7, 800);
    ivPracticeConversation.lastElementChild.remove();
    ivAddPracticeMsg(reply, 'ai');
    practiceState.messages.push({ role: 'assistant', content: reply });
  } catch (err) {
    ivPracticeConversation.lastElementChild.remove();
    ivAddPracticeMsg('Error: ' + err.message, 'ai');
    practiceState.messages.pop();
  }
}

ivPracticeStart.addEventListener('click', ivStartPractice);
ivPracticeSend.addEventListener('click', ivSendPractice);
ivPracticeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') ivSendPractice(); });

// ========== Job Search ==========

const searchPrefsToggle = document.getElementById('search-prefs-toggle');
const searchPrefs = document.getElementById('search-prefs');

// Job search lives in the Wagner-GPT web app's Jobs tab now (multi-source scraping search,
// tailoring, tracker — one place for everything). The old extension page (jobsearch.html) was a
// full duplicate calling the same backend and has been removed.
const openJobSearchBtn = document.getElementById('open-job-search');
if (openJobSearchBtn) {
  openJobSearchBtn.addEventListener('click', function () {
    chrome.tabs.create({ url: 'https://wagner-gpt.vercel.app/?tab=jobs' });
  });
}
const searchRun = document.getElementById('search-run');
const searchResultsInfo = document.getElementById('search-results-info');
const searchSavePrefs = document.getElementById('search-save-prefs');
const searchEasyApply = document.getElementById('search-easy-apply');
const searchSalary = document.getElementById('search-salary');

function getSearchPrefs() {
  var roles = [];
  document.querySelectorAll('#search-roles input:checked').forEach(function (cb) { roles.push(cb.value); });
  var workTypes = [];
  document.querySelectorAll('#search-worktype input:checked').forEach(function (cb) { workTypes.push(cb.value); });
  var contracts = [];
  document.querySelectorAll('#search-contract input:checked').forEach(function (cb) { contracts.push(cb.value); });
  return {
    roles: roles,
    workTypes: workTypes,
    easyApply: searchEasyApply.checked,
    contracts: contracts,
    minSalary: searchSalary.value
  };
}

function applySearchPrefs(prefs) {
  if (!prefs) return;
  if (prefs.roles) {
    document.querySelectorAll('#search-roles input').forEach(function (cb) {
      cb.checked = prefs.roles.indexOf(cb.value) >= 0;
    });
  }
  if (prefs.workTypes) {
    document.querySelectorAll('#search-worktype input').forEach(function (cb) {
      cb.checked = prefs.workTypes.indexOf(cb.value) >= 0;
    });
  }
  if (prefs.contracts) {
    document.querySelectorAll('#search-contract input').forEach(function (cb) {
      cb.checked = prefs.contracts.indexOf(cb.value) >= 0;
    });
  }
  if (prefs.easyApply !== undefined) searchEasyApply.checked = prefs.easyApply;
  if (prefs.minSalary !== undefined) searchSalary.value = prefs.minSalary;
}

function saveSearchPrefs() {
  var prefs = getSearchPrefs();
  chrome.storage.local.set({ searchPrefs: prefs });
  searchResultsInfo.textContent = 'Preferences saved.';
  setTimeout(function () { searchResultsInfo.textContent = ''; }, 2000);
}

function buildLinkedInSearchUrl(role, prefs) {
  var params = ['keywords=' + encodeURIComponent(role)];
  if (prefs.easyApply) params.push('f_AL=true');
  if (prefs.workTypes && prefs.workTypes.length > 0 && prefs.workTypes.length < 3) {
    params.push('f_WT=' + prefs.workTypes.join('%2C'));
  }
  if (prefs.minSalary) {
    params.push('f_SB2=' + encodeURIComponent(prefs.minSalary));
  }
  if (prefs.contracts && prefs.contracts.length > 0) {
    params.push('f_JT=' + prefs.contracts.map(function (c) { return encodeURIComponent(c); }).join('%2C'));
  }
  return 'https://www.linkedin.com/jobs/search/?' + params.join('&');
}

function runJobSearch() {
  var prefs = getSearchPrefs();
  if (prefs.roles.length === 0) {
    searchResultsInfo.textContent = 'Select at least one role to search for.';
    return;
  }
  var keyword = prefs.roles.join(' OR ');
  var url = buildLinkedInSearchUrl(keyword, prefs);
  chrome.tabs.create({ url: url });
  searchResultsInfo.textContent = 'Opened LinkedIn search for ' + prefs.roles.length + ' role(s) with your filters.';
}

if (searchPrefsToggle) {
  searchPrefsToggle.addEventListener('click', function () {
    searchPrefs.classList.toggle('hidden');
    searchPrefsToggle.innerHTML = searchPrefs.classList.contains('hidden') ? '&#9881; Filters' : '&#9881; Hide';
  });
}
if (searchSavePrefs) searchSavePrefs.addEventListener('click', saveSearchPrefs);
if (searchRun) searchRun.addEventListener('click', runJobSearch);

// ----- Auto-pull + AI fit-filter: scan the job cards on a LinkedIn search page, then rank
// every job by how well it fits the saved resume (free Ollama backend). Best matches first. -----
const scanRankBtn = document.getElementById('scan-rank-btn');
const scanResults = document.getElementById('scan-results');
let scanning = false;
let scanTimeout = null;

function setScanInfo(msg) { if (searchResultsInfo) searchResultsInfo.textContent = msg || ''; }

function startScan() {
  if (scanning) return;
  if (!resumeText) { setScanInfo('Add your resume first so Alicia can rank jobs by fit.'); return; }
  scanning = true;
  if (scanResults) scanResults.innerHTML = '';
  if (scanRankBtn) scanRankBtn.disabled = true;
  setScanInfo('Scanning jobs on this page…');
  // Bail out if we're not on a results page (no content script answers).
  scanTimeout = setTimeout(function () {
    if (scanning) { scanning = false; if (scanRankBtn) scanRankBtn.disabled = false;
      setScanInfo('No jobs found. Open a LinkedIn Jobs search page, then scan.'); }
  }, 8000);
  chrome.runtime.sendMessage({ type: 'SCAN_JOBS' }).catch(function () {});
}

async function handleScannedJobs(jobs) {
  if (!scanning) return;
  clearTimeout(scanTimeout);
  if (!jobs || !jobs.length) {
    scanning = false; if (scanRankBtn) scanRankBtn.disabled = false;
    setScanInfo('No job cards found here. Make sure you are on a LinkedIn Jobs search results page.');
    return;
  }
  setScanInfo('Found ' + jobs.length + ' jobs. Ranking by fit to your resume…');
  try {
    var ranked = await rankScannedJobs(jobs);
    renderRankedJobs(ranked);
    setScanInfo('Ranked ' + ranked.length + ' jobs by fit — best matches first.');
  } catch (e) {
    console.log('[Alicia] rank error', e);
    setScanInfo('Could not rank these jobs. Please try again.');
  } finally {
    scanning = false; if (scanRankBtn) scanRankBtn.disabled = false;
  }
}

async function rankScannedJobs(jobs) {
  var list = jobs.map(function (j, i) {
    return i + '. ' + j.title + ' — ' + (j.company || '?') + ' — ' + (j.location || '?');
  }).join('\n');
  var sys = 'You are a job-fit screener. Given the candidate resume and a numbered list of job postings (title — company — location only), rate how well each fits the candidate\'s field, seniority, and location. Respond ONLY with a JSON array, one object per job, same order and indices: [{"i":<index>,"score":<0-100>,"reason":"<max 12 words>"}]. No prose, no markdown fences.';
  var user = 'RESUME:\n' + resumeText.slice(0, 4000) + '\n\nJOBS:\n' + list;
  var raw = await callGroq([{ role: 'system', content: sys }, { role: 'user', content: user }], 0.2, 2048);
  var clean = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  var scores;
  try { scores = JSON.parse(clean); }
  catch (e) { var m = clean.match(/\[[\s\S]*\]/); scores = m ? JSON.parse(m[0]) : []; }
  var byIndex = {};
  scores.forEach(function (s) { if (s && typeof s.i === 'number') byIndex[s.i] = s; });
  var merged = jobs.map(function (j, i) {
    var s = byIndex[i] || {};
    return { title: j.title, company: j.company, location: j.location, url: j.url,
             score: typeof s.score === 'number' ? s.score : 0, reason: s.reason || '' };
  });
  merged.sort(function (a, b) { return b.score - a.score; });
  return merged;
}

function scoreColor(score) {
  if (score >= 75) return '#4caf50';
  if (score >= 50) return '#e0a800';
  return '#c0564b';
}

function renderRankedJobs(ranked) {
  if (!scanResults) return;
  scanResults.innerHTML = '';
  ranked.forEach(function (j) {
    var row = document.createElement('div');
    row.className = 'scan-job';
    var head = document.createElement('div');
    head.className = 'scan-job-head';
    var badge = document.createElement('span');
    badge.className = 'scan-score';
    badge.textContent = j.score;
    badge.style.background = scoreColor(j.score);
    head.appendChild(badge);
    var titleWrap = document.createElement('div');
    titleWrap.className = 'scan-job-title-wrap';
    var a = document.createElement('a');
    a.className = 'scan-job-title';
    a.textContent = j.title;
    if (j.url) { a.href = j.url; a.target = '_blank'; a.rel = 'noopener'; }
    titleWrap.appendChild(a);
    var meta = document.createElement('div');
    meta.className = 'scan-job-meta';
    meta.textContent = [j.company, j.location].filter(Boolean).join(' · ');
    titleWrap.appendChild(meta);
    head.appendChild(titleWrap);
    row.appendChild(head);
    if (j.reason) {
      var reason = document.createElement('div');
      reason.className = 'scan-job-reason';
      reason.textContent = j.reason;
      row.appendChild(reason);
    }
    scanResults.appendChild(row);
  });
}

if (scanRankBtn) scanRankBtn.addEventListener('click', startScan);
chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === 'JOBS_SCANNED') handleScannedJobs(message.jobs);
});

// ----- People to reach out to: scrape the job's "Meet the hiring team", draft a tailored note -----
const findPeopleBtn = document.getElementById('find-people-btn');
const peopleResults = document.getElementById('people-results');
let findingPeople = false;
let peopleTimeout = null;

// LinkedIn connection-note limit. The model can't reliably count characters, so we enforce
// this in code (clean trim + textarea maxlength), not by trusting the prompt.
const OUTREACH_LIMIT = 300;

// Trim a message to <= limit without cutting mid-word: prefer a sentence boundary, else the
// last whole word.
function enforceLimit(msg, limit) {
  msg = (msg || '').trim();
  if (msg.length <= limit) return msg;
  var cut = msg.slice(0, limit);
  var lastPunct = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastPunct > limit * 0.6) return cut.slice(0, lastPunct + 1).trim();
  var lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

function startFindPeople() {
  if (findingPeople) return;
  findingPeople = true;
  if (peopleResults) peopleResults.innerHTML = '<p class="placeholder">Looking for the hiring team on this job…</p>';
  if (findPeopleBtn) findPeopleBtn.disabled = true;
  peopleTimeout = setTimeout(function () {
    if (findingPeople) {
      findingPeople = false;
      if (findPeopleBtn) findPeopleBtn.disabled = false;
      if (peopleResults) peopleResults.innerHTML = '<p class="placeholder">No hiring-team contacts shown for this job.</p>';
    }
  }, 8000);
  chrome.runtime.sendMessage({ type: 'SCAN_PEOPLE' }).catch(function () {});
}

function handlePeopleFound(people) {
  if (!findingPeople) return;
  clearTimeout(peopleTimeout);
  findingPeople = false;
  if (findPeopleBtn) findPeopleBtn.disabled = false;
  renderPeople(people || []);
}

function renderPeople(people) {
  if (!peopleResults) return;
  peopleResults.innerHTML = '';
  if (!people.length) {
    peopleResults.innerHTML = '<p class="placeholder">No hiring-team contacts found. Open the job posting and scroll to "Meet the hiring team", then try again.</p>';
    return;
  }
  people.forEach(function (p) {
    var card = document.createElement('div');
    card.className = 'person-card';
    var top = document.createElement('div');
    top.className = 'person-top';
    var info = document.createElement('div');
    info.className = 'person-info';
    var nameEl = document.createElement('a');
    nameEl.className = 'person-name';
    nameEl.textContent = p.name;
    if (p.url) { nameEl.href = p.url; nameEl.target = '_blank'; nameEl.rel = 'noopener'; }
    info.appendChild(nameEl);
    if (p.title) {
      var t = document.createElement('div'); t.className = 'person-title'; t.textContent = p.title; info.appendChild(t);
    }
    top.appendChild(info);
    var draftBtn = document.createElement('button');
    draftBtn.className = 'btn-small';
    draftBtn.textContent = 'Draft message';
    top.appendChild(draftBtn);
    card.appendChild(top);

    var msgWrap = document.createElement('div');
    msgWrap.className = 'person-msg hidden';
    card.appendChild(msgWrap);

    draftBtn.addEventListener('click', function () { draftOutreach(p, draftBtn, msgWrap); });
    peopleResults.appendChild(card);
  });
}

async function draftOutreach(person, btn, msgWrap) {
  if (!resumeText) {
    msgWrap.classList.remove('hidden');
    msgWrap.innerHTML = '<p class="placeholder">Add your resume first so the message can mention your background.</p>';
    return;
  }
  btn.disabled = true; btn.textContent = 'Writing…';
  msgWrap.classList.remove('hidden');
  msgWrap.innerHTML = '<p class="placeholder">Drafting a personalized note…</p>';
  try {
    var company = (currentJob && currentJob.company) || '';
    var role = (currentJob && currentJob.title) || 'the role';
    var sys = 'You write short, warm, professional LinkedIn outreach messages for a job seeker contacting someone on a company hiring team. Write only 1-2 SHORT sentences. Aim for about 250 characters and NEVER exceed 300 — brevity is essential. Be specific and genuine: name the role and ONE relevant strength from the candidate background. No cliches like "I hope this finds you well", no hashtags, no emojis. Output ONLY the message text, nothing else.';
    var user = 'CANDIDATE BACKGROUND:\n' + resumeText.slice(0, 2500) +
      '\n\nREACHING OUT TO: ' + person.name + (person.title ? ', ' + person.title : '') + (company ? ' at ' + company : '') +
      '\nROLE THEY ARE HIRING FOR: ' + role + '\n\nWrite the message.';
    var msg = await callGroq([{ role: 'system', content: sys }, { role: 'user', content: user }], 0.6, 512);
    msg = enforceLimit(msg.trim().replace(/^["']|["']$/g, ''), OUTREACH_LIMIT);
    renderOutreach(msgWrap, msg);
  } catch (e) {
    console.log('[Alicia] outreach error', e);
    msgWrap.innerHTML = '<p class="placeholder">Could not draft a message. Please try again.</p>';
  } finally {
    btn.disabled = false; btn.textContent = 'Redraft';
  }
}

function renderOutreach(msgWrap, msg) {
  msgWrap.innerHTML = '';
  // Editable so the user can tweak before copying; maxlength hard-caps it at the limit.
  var ta = document.createElement('textarea');
  ta.className = 'person-msg-text';
  ta.maxLength = OUTREACH_LIMIT;
  ta.rows = 3;
  ta.value = msg;
  msgWrap.appendChild(ta);

  var actions = document.createElement('div'); actions.className = 'person-msg-actions';
  var len = document.createElement('span'); len.className = 'person-msg-len';
  function updateLen() {
    var n = ta.value.length;
    len.textContent = n + ' / ' + OUTREACH_LIMIT;
    len.style.color = n >= OUTREACH_LIMIT ? '#c0564b' : '';
  }
  ta.addEventListener('input', updateLen);
  updateLen();

  var copy = document.createElement('button'); copy.className = 'btn-small'; copy.textContent = 'Copy';
  copy.addEventListener('click', function () {
    navigator.clipboard.writeText(ta.value).then(function () {
      copy.textContent = 'Copied!'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
    }).catch(function () {});
  });
  actions.appendChild(len); actions.appendChild(copy);
  msgWrap.appendChild(actions);
}

if (findPeopleBtn) findPeopleBtn.addEventListener('click', startFindPeople);
chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === 'PEOPLE_FOUND') handlePeopleFound(message.people);
});

// ========== Easy Apply Queue (batch apply) ==========
// Collect Easy Apply jobs from the current LinkedIn search page into a persistent queue, then
// let background.js step through them (open → fill → the human clicks Submit → next). This panel
// owns the queue UI and controls; the queue state lives in chrome.storage.local so it survives
// navigations and the side panel closing. Nothing here ever submits an application.
const queueToggle = document.getElementById('queue-toggle');
const queueBody = document.getElementById('queue-body');
const queueBuildBtn = document.getElementById('queue-build-btn');
const queueAutoOpenToggle = document.getElementById('queue-autoopen-toggle');
const queueStatusEl = document.getElementById('queue-status');
const queueControls = document.getElementById('queue-controls');
const queueStartBtn = document.getElementById('queue-start-btn');
const queuePauseBtn = document.getElementById('queue-pause-btn');
const queueStopBtn = document.getElementById('queue-stop-btn');
const queueClearBtn = document.getElementById('queue-clear-btn');
const queueListEl = document.getElementById('queue-list');
const queueEmptyEl = document.getElementById('queue-empty');
let queueBuilding = false;
let queueBuildTimeout = null;

function setQueueStatus(msg) { if (queueStatusEl) queueStatusEl.textContent = msg || ''; }

if (queueToggle && queueBody) {
  queueToggle.addEventListener('click', function () {
    queueBody.classList.toggle('hidden');
    queueToggle.innerHTML = queueBody.classList.contains('hidden') ? '&#128203; Show' : '&#128203; Hide';
    if (!queueBody.classList.contains('hidden')) renderQueue();
  });
}

if (queueAutoOpenToggle) {
  chrome.storage.local.get('queueAutoOpen', function (d) { queueAutoOpenToggle.checked = d.queueAutoOpen !== false; });
  queueAutoOpenToggle.addEventListener('change', function () {
    chrome.storage.local.set({ queueAutoOpen: queueAutoOpenToggle.checked });
  });
}

function startBuildQueue() {
  if (queueBuilding) return;
  queueBuilding = true;
  if (queueBuildBtn) queueBuildBtn.disabled = true;
  setQueueStatus('Scanning this search for Easy Apply jobs… (scrolling to load them all)');
  queueBuildTimeout = setTimeout(function () {
    if (queueBuilding) {
      queueBuilding = false;
      if (queueBuildBtn) queueBuildBtn.disabled = false;
      setQueueStatus('No jobs found. Open a LinkedIn Jobs search results page, then build the queue.');
    }
  }, 25000);
  chrome.runtime.sendMessage({ type: 'COLLECT_QUEUE' }).catch(function () {});
}

function handleQueueCollected(jobs) {
  if (!queueBuilding) return;
  clearTimeout(queueBuildTimeout);
  queueBuilding = false;
  if (queueBuildBtn) queueBuildBtn.disabled = false;
  chrome.storage.local.get('applyQueue', function (d) {
    var existing = d.applyQueue || [];
    var seen = {};
    existing.forEach(function (j) { if (j.jobId) seen[j.jobId] = true; });
    var added = 0;
    (jobs || []).forEach(function (j) {
      if (!j.jobId || seen[j.jobId]) return;
      seen[j.jobId] = true;
      existing.push({ jobId: j.jobId, title: j.title, company: j.company, location: j.location, url: j.url, status: 'pending' });
      added++;
    });
    chrome.storage.local.set({ applyQueue: existing }, function () {
      renderQueue();
      setQueueStatus(added
        ? ('Added ' + added + ' Easy Apply job' + (added === 1 ? '' : 's') + ' to the queue.')
        : 'No new Easy Apply jobs found on this page. (External-apply and already-applied jobs are skipped.)');
    });
  });
}

function queueStatusLabel(s) { return s === 'done' ? '✓ Sent' : s === 'skipped' ? 'Skipped' : 'Pending'; }

function renderQueue() {
  if (!queueListEl) return;
  chrome.storage.local.get(['applyQueue', 'queueActive', 'queuePaused', 'queueIndex', 'queueStatusMsg', 'queueSessionCount'], function (d) {
    var q = d.applyQueue || [];
    if (d.queueStatusMsg) setQueueStatus(d.queueStatusMsg);
    var done = q.filter(function (j) { return j.status === 'done'; }).length;
    var skipped = q.filter(function (j) { return j.status === 'skipped'; }).length;

    if (queueEmptyEl) queueEmptyEl.style.display = q.length ? 'none' : '';
    if (queueControls) queueControls.classList.toggle('hidden', !q.length);

    if (queueStartBtn && queuePauseBtn) {
      var running = d.queueActive && !d.queuePaused;
      queueStartBtn.innerHTML = (d.queueActive && d.queuePaused) ? '&#9654; Resume' : '&#9654; Start';
      queueStartBtn.classList.toggle('hidden', running);
      queuePauseBtn.classList.toggle('hidden', !running);
    }

    queueListEl.innerHTML = '';
    if (q.length) {
      var count = document.createElement('div');
      count.className = 'queue-count';
      count.textContent = done + ' of ' + q.length + ' done'
        + (skipped ? ' · ' + skipped + ' skipped' : '')
        + (d.queueActive ? ' · ' + (d.queueSessionCount || 0) + '/20 this run' : '');
      queueListEl.appendChild(count);
    }
    q.forEach(function (j, i) {
      var row = document.createElement('div');
      row.className = 'queue-item queue-' + j.status;
      if (d.queueActive && !d.queuePaused && i === d.queueIndex && j.status === 'pending') row.className += ' queue-current';
      var info = document.createElement('div'); info.className = 'queue-item-info';
      var t = document.createElement('div'); t.className = 'queue-item-title'; t.textContent = j.title; info.appendChild(t);
      var m = document.createElement('div'); m.className = 'queue-item-meta';
      m.textContent = [j.company, j.location].filter(Boolean).join(' · '); info.appendChild(m);
      row.appendChild(info);
      var badge = document.createElement('span'); badge.className = 'queue-badge'; badge.textContent = queueStatusLabel(j.status);
      row.appendChild(badge);
      if (j.status === 'pending') {
        var skip = document.createElement('button'); skip.className = 'queue-skip'; skip.textContent = 'Skip'; skip.title = 'Remove this job from the queue';
        skip.addEventListener('click', function () { skipQueueItem(j.jobId); });
        row.appendChild(skip);
      }
      queueListEl.appendChild(row);
    });
  });
}

function skipQueueItem(jobId) {
  chrome.storage.local.get(['applyQueue', 'queueActive', 'queueIndex'], function (d) {
    var q = d.applyQueue || [];
    var wasCurrent = false;
    for (var i = 0; i < q.length; i++) {
      if (q[i].jobId === jobId && q[i].status === 'pending') { q[i].status = 'skipped'; if (i === d.queueIndex) wasCurrent = true; break; }
    }
    chrome.storage.local.set({ applyQueue: q }, function () {
      renderQueue();
      // If we skipped the job the queue is actively on, tell background to advance now.
      if (d.queueActive && wasCurrent) chrome.runtime.sendMessage({ type: 'QUEUE_ITEM_SKIP', jobId: jobId }).catch(function () {});
    });
  });
}

if (queueBuildBtn) queueBuildBtn.addEventListener('click', startBuildQueue);
if (queueStartBtn) queueStartBtn.addEventListener('click', function () {
  chrome.storage.local.get(['queueActive', 'queuePaused', 'applyQueue'], function (d) {
    if (d.queueActive && d.queuePaused) {           // Resume — don't reset the session count
      chrome.storage.local.set({ queuePaused: false }, function () { setQueueStatus('Resumed.'); renderQueue(); });
      return;
    }
    var q = d.applyQueue || [];
    if (!q.some(function (j) { return j.status === 'pending'; })) { setQueueStatus('No pending jobs. Build a queue first.'); return; }
    setQueueStatus('Starting… opening the first job. Keep this tab on LinkedIn while the queue runs.');
    chrome.runtime.sendMessage({ type: 'QUEUE_START' }).catch(function () {});
  });
});
if (queuePauseBtn) queuePauseBtn.addEventListener('click', function () {
  chrome.storage.local.set({ queuePaused: true }, function () { setQueueStatus('Paused. Press Resume to continue.'); renderQueue(); });
});
if (queueStopBtn) queueStopBtn.addEventListener('click', function () {
  chrome.storage.local.set({ queueActive: false, queuePaused: false }, function () { setQueueStatus('Stopped. The queue is kept — press Start to run it again.'); renderQueue(); });
});
if (queueClearBtn) queueClearBtn.addEventListener('click', function () {
  chrome.storage.local.set({ applyQueue: [], queueActive: false, queuePaused: false, queueIndex: 0, queueStatusMsg: '' }, function () {
    setQueueStatus('Queue cleared.'); renderQueue();
  });
});

chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === 'QUEUE_COLLECTED') handleQueueCollected(message.jobs);
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.applyQueue || changes.queueActive || changes.queuePaused || changes.queueIndex || changes.queueStatusMsg || changes.queueSessionCount) {
    if (queueBody && !queueBody.classList.contains('hidden')) renderQueue();
  }
});
renderQueue();

// ========== EEO Auto-Fill ==========

const eeoToggle = document.getElementById('eeo-toggle');
const eeoForm = document.getElementById('eeo-form');
const eeoSave = document.getElementById('eeo-save');
const eeoStatus = document.getElementById('eeo-status');
const eeoFillNow = document.getElementById('eeo-fill-now');
const eeoFillStatus = document.getElementById('eeo-fill-status');
const autoAdvanceToggle = document.getElementById('auto-advance-toggle');

if (autoAdvanceToggle) {
  autoAdvanceToggle.addEventListener('change', function () {
    chrome.storage.local.set({ autoAdvanceEasyApply: autoAdvanceToggle.checked });
  });
}

// Master auto-fill switch: when off, content.js does no auto-fill/auto-advance at all on LinkedIn
// (this is LinkedIn-only -- content.js only runs on linkedin.com; every other ATS's autofill lives
// in autofill.js and is unaffected). Default OFF: LinkedIn's ToS explicitly bans automated
// application tools, so this requires an explicit opt-in rather than opting everyone in by default.
const autofillToggle = document.getElementById('autofill-toggle');
if (autofillToggle) {
  chrome.storage.local.get('autoFillEasyApply', function (d) { autofillToggle.checked = d.autoFillEasyApply === true; });
  autofillToggle.addEventListener('change', function () {
    chrome.storage.local.set({ autoFillEasyApply: autofillToggle.checked });
  });
}

const EEO_FIELDS = ['eeo-gender', 'eeo-race', 'eeo-veteran', 'eeo-disability', 'eeo-authorization', 'eeo-sponsorship'];
const PROFILE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'city', 'state', 'zip', 'linkedin', 'website'];

function getEeoPrefs() {
  var prefs = {};
  EEO_FIELDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.value) prefs[id] = el.value;
  });
  return prefs;
}

function applyEeoPrefs(prefs) {
  if (!prefs) return;
  EEO_FIELDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && prefs[id]) el.value = prefs[id];
  });
}

function getProfile() {
  var p = {};
  PROFILE_FIELDS.forEach(function (k) {
    var el = document.getElementById('pf-' + k);
    if (el && el.value.trim()) p[k] = el.value.trim();
  });
  return p;
}

function applyProfile(p) {
  if (!p) return;
  PROFILE_FIELDS.forEach(function (k) {
    var el = document.getElementById('pf-' + k);
    if (el && p[k]) el.value = p[k];
  });
}

function saveEeoPrefs() {
  chrome.storage.local.set({ eeoPrefs: getEeoPrefs(), profile: getProfile() });
  if (eeoStatus) {
    eeoStatus.textContent = 'Saved! Alicia will auto-fill these when you apply.';
    eeoStatus.style.color = '#4caf50';
    setTimeout(function () { eeoStatus.textContent = ''; }, 3000);
  }
}

if (eeoToggle) {
  eeoToggle.addEventListener('click', function () {
    eeoForm.classList.toggle('hidden');
    eeoToggle.innerHTML = eeoForm.classList.contains('hidden') ? '&#9998; Edit' : '&#9998; Hide';
  });
}
if (eeoSave) eeoSave.addEventListener('click', saveEeoPrefs);

// ========== Learned Answers (custom Easy Apply questions content.js has answered) ==========

const learnedQaToggle = document.getElementById('learned-qa-toggle');
const learnedQaBody = document.getElementById('learned-qa-body');
const learnedQaList = document.getElementById('learned-qa-list');
const learnedQaEmpty = document.getElementById('learned-qa-empty');
let learnedQaBank = [];

function saveLearnedQaBank() {
  chrome.storage.local.set({ customQA: learnedQaBank });
}

function renderLearnedAnswers() {
  if (!learnedQaList) return;
  learnedQaList.innerHTML = '';
  if (learnedQaEmpty) learnedQaEmpty.classList.toggle('hidden', learnedQaBank.length > 0);

  learnedQaBank.slice().reverse().forEach(function (rec) {
    var row = document.createElement('div');
    row.className = 'tracker-row';

    var top = document.createElement('div');
    top.className = 'tracker-row-top';

    var main = document.createElement('div');
    main.className = 'tracker-row-main';
    var q = document.createElement('div');
    q.className = 'tracker-row-title';
    q.title = rec.question;
    q.textContent = rec.question;
    main.appendChild(q);
    top.appendChild(main);

    var del = document.createElement('button');
    del.className = 'tracker-del';
    del.title = 'Delete this learned answer';
    del.textContent = '✕';
    del.addEventListener('click', function () {
      learnedQaBank = learnedQaBank.filter(function (r) { return r.id !== rec.id; });
      saveLearnedQaBank();
      renderLearnedAnswers();
    });
    top.appendChild(del);
    row.appendChild(top);

    var answer = document.createElement('textarea');
    answer.className = 'tracker-notes';
    answer.value = rec.answer || '';
    answer.placeholder = 'Answer Alicia will reuse for this question';
    function persistAnswer() {
      rec.answer = answer.value;
      saveLearnedQaBank();
    }
    answer.addEventListener('change', persistAnswer);
    answer.addEventListener('blur', persistAnswer);
    row.appendChild(answer);

    learnedQaList.appendChild(row);
  });
}

function toggleLearnedQa(forceOpen) {
  var open = forceOpen === true || learnedQaBody.classList.contains('hidden');
  learnedQaBody.classList.toggle('hidden', !open);
  learnedQaToggle.innerHTML = open ? '&#128218; Hide' : '&#128218; Show';
  if (open) renderLearnedAnswers();
}

if (learnedQaToggle) learnedQaToggle.addEventListener('click', function () { toggleLearnedQa(); });

// content.js writes new learned answers straight to storage while browsing LinkedIn — keep the
// panel in sync if it's open at the same time.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.customQA) return;
  learnedQaBank = Array.isArray(changes.customQA.newValue) ? changes.customQA.newValue : [];
  if (learnedQaEmpty) learnedQaEmpty.classList.toggle('hidden', learnedQaBank.length > 0);
  if (learnedQaBody && !learnedQaBody.classList.contains('hidden')) renderLearnedAnswers();
});

// ========== Site Passwords (accounts autofill.js created on external ATS sites) ==========

const sitePasswordsToggle = document.getElementById('site-passwords-toggle');
const sitePasswordsBody = document.getElementById('site-passwords-body');
const sitePasswordsList = document.getElementById('site-passwords-list');
const sitePasswordsEmpty = document.getElementById('site-passwords-empty');
let siteCredentialsBank = {};

function renderSitePasswords() {
  if (!sitePasswordsList) return;
  sitePasswordsList.innerHTML = '';
  var hosts = Object.keys(siteCredentialsBank).sort(function (a, b) {
    return (siteCredentialsBank[b].createdAt || 0) - (siteCredentialsBank[a].createdAt || 0);
  });
  if (sitePasswordsEmpty) sitePasswordsEmpty.classList.toggle('hidden', hosts.length > 0);

  hosts.forEach(function (host) {
    var cred = siteCredentialsBank[host];
    var row = document.createElement('div');
    row.className = 'tracker-row';

    var top = document.createElement('div');
    top.className = 'tracker-row-top';

    var main = document.createElement('div');
    main.className = 'tracker-row-main';
    var h = document.createElement('div');
    h.className = 'tracker-row-title';
    h.textContent = host;
    main.appendChild(h);
    var e = document.createElement('div');
    e.className = 'tracker-row-company';
    e.textContent = cred.email || '';
    main.appendChild(e);
    top.appendChild(main);

    var del = document.createElement('button');
    del.className = 'tracker-del';
    del.title = 'Delete this saved password';
    del.textContent = '✕';
    del.addEventListener('click', function () {
      delete siteCredentialsBank[host];
      chrome.storage.local.set({ siteCredentials: siteCredentialsBank });
      renderSitePasswords();
    });
    top.appendChild(del);
    row.appendChild(top);

    var pwRow = document.createElement('div');
    pwRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;';
    var pwField = document.createElement('input');
    pwField.type = 'password';
    pwField.readOnly = true;
    pwField.value = cred.password || '';
    pwField.className = 'pf-input';
    pwField.style.flex = '1';
    pwRow.appendChild(pwField);

    var reveal = document.createElement('button');
    reveal.className = 'btn-small';
    reveal.textContent = 'Show';
    reveal.addEventListener('click', function () {
      var showing = pwField.type === 'text';
      pwField.type = showing ? 'password' : 'text';
      reveal.textContent = showing ? 'Show' : 'Hide';
    });
    pwRow.appendChild(reveal);

    var copy = document.createElement('button');
    copy.className = 'btn-small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(cred.password || '').then(function () {
        copy.textContent = 'Copied!'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
      }).catch(function () {});
    });
    pwRow.appendChild(copy);

    row.appendChild(pwRow);
    sitePasswordsList.appendChild(row);
  });
}

function toggleSitePasswords(forceOpen) {
  var open = forceOpen === true || sitePasswordsBody.classList.contains('hidden');
  sitePasswordsBody.classList.toggle('hidden', !open);
  sitePasswordsToggle.innerHTML = open ? '&#128273; Hide' : '&#128273; Show';
  if (open) renderSitePasswords();
}

if (sitePasswordsToggle) sitePasswordsToggle.addEventListener('click', function () { toggleSitePasswords(); });

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.siteCredentials) return;
  siteCredentialsBank = changes.siteCredentials.newValue || {};
  if (sitePasswordsEmpty) sitePasswordsEmpty.classList.toggle('hidden', Object.keys(siteCredentialsBank).length > 0);
  if (sitePasswordsBody && !sitePasswordsBody.classList.contains('hidden')) renderSitePasswords();
});

function setFillStatus(text, color) {
  if (!eeoFillStatus) return;
  eeoFillStatus.textContent = text;
  eeoFillStatus.style.color = color;
  setTimeout(function () { if (eeoFillStatus.textContent === text) eeoFillStatus.textContent = ''; }, 5000);
}

// Self-contained autofill, INJECTED into the active tab (works on any site — LinkedIn Easy
// Apply and external ATS like Workday/Greenhouse/Lever). Matches each field by its label +
// name/id/autocomplete/placeholder, fills contact fields, and answers EEO selects/radios by
// fuzzy-matching the saved options. Returns the number of fields filled. No outer references.
async function runAutofill(profile, eeo) {
  profile = profile || {}; eeo = eeo || {};
  function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function fire(el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
  }
  function labelText(el) {
    var t = '';
    try { if (el.id) { var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (l) t = l.innerText || l.textContent || ''; } } catch (e) {}
    if (!t) {
      var lbAttr = el.getAttribute('aria-labelledby');
      if (lbAttr) { var lb = document.getElementById(lbAttr.split(' ')[0]); if (lb) t = lb.innerText || lb.textContent || ''; }
    }
    if (!t) { var p = el.closest('label'); if (p) t = p.innerText || p.textContent || ''; }
    if (!t) { var c = el.closest('.form-group,fieldset,div,section'); if (c) { var li = c.querySelector('label,legend'); if (li) t = li.innerText || li.textContent || ''; } }
    return t;
  }
  function signals(el) {
    return norm([el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelText(el)].filter(Boolean).join(' '));
  }

  var fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  var STD = [
    { v: profile.email,     t: function (s, el) { return el.type === 'email' || /\bemail\b/.test(s); } },
    { v: profile.phone,     t: function (s, el) { return el.type === 'tel' || /\b(phone|mobile|cell|telephone)\b/.test(s); } },
    { v: profile.firstName, t: function (s) { return /\b(given name|first name|firstname|fname)\b/.test(s); } },
    { v: profile.lastName,  t: function (s) { return /\b(family name|last name|lastname|surname|lname)\b/.test(s); } },
    { v: profile.linkedin,  t: function (s) { return /linkedin/.test(s); } },
    { v: profile.website,   t: function (s) { return /\b(website|portfolio|personal site)\b/.test(s); } },
    { v: profile.city,      t: function (s) { return /\b(address level2|city|town)\b/.test(s); } },
    { v: profile.state,     t: function (s) { return /\b(address level1|state|province|region)\b/.test(s); } },
    { v: profile.zip,       t: function (s) { return /\b(postal code|postcode|zip)\b/.test(s); } },
    { v: fullName,          t: function (s) { return /\bfull name\b/.test(s) || (/\bname\b/.test(s) && !/first|last|given|family|user|company|file|nick|middle|legal/.test(s)); } }
  ];

  var filled = 0;
  var inputs = document.querySelectorAll('input, textarea');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    var ty = (el.type || '').toLowerCase();
    if (['hidden', 'password', 'file', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'search'].indexOf(ty) >= 0) continue;
    if (el.disabled || el.readOnly) continue;
    if (el.value && el.value.trim()) continue;
    if (el.offsetParent === null) continue; // not visible
    var s = signals(el);
    if (!s) continue;
    for (var f = 0; f < STD.length; f++) {
      if (STD[f].v && STD[f].t(s, el)) { setNativeValue(el, STD[f].v); fire(el); filled++; break; }
    }
  }

  // ----- EEO answers (selects + radios) -----
  var EEO = [
    { key: 'eeo-sponsorship',  pats: [/sponsor/, /visa status/] },
    { key: 'eeo-authorization', pats: [/authoriz/, /legally (authorized|eligible|entitled)/, /right to work/, /eligible to work/] },
    { key: 'eeo-gender',       pats: [/\bgender\b/, /\bsex\b/] },
    { key: 'eeo-race',         pats: [/\brace\b/, /ethnic/] },
    { key: 'eeo-veteran',      pats: [/veteran/] },
    { key: 'eeo-disability',   pats: [/disabilit/, /\bdisabled\b/] }
  ];
  function eeoKey(s) { for (var i = 0; i < EEO.length; i++) { for (var p = 0; p < EEO[i].pats.length; p++) { if (EEO[i].pats[p].test(s)) return EEO[i].key; } } return null; }
  function canon(s) { var n = norm(s); if (/(decline|prefer not|do not wish|dont wish|not to answer|wish not|not to disclose)/.test(n)) return 'declined'; return n; }
  function score(a, b) {
    a = canon(a); b = canon(b); if (!a || !b) return 0;
    if (a === b) return 100; if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 80;
    var at = a.split(' '), bt = b.split(' '), c = 0;
    for (var i = 0; i < bt.length; i++) { if (bt[i].length > 2 && at.indexOf(bt[i]) >= 0) c++; }
    return bt.length ? (c / bt.length) * 60 : 0;
  }
  var selects = document.querySelectorAll('select');
  for (var si = 0; si < selects.length; si++) {
    var sel = selects[si];
    var cur = (sel.value || '').toLowerCase();
    if (cur && !/select|choose|--|^$/.test(cur)) continue;
    var key = eeoKey(signals(sel)); if (!key || !eeo[key]) continue;
    var best = null, bs = 0;
    for (var o = 0; o < sel.options.length; o++) {
      var op = sel.options[o]; if (!op.value) continue;
      var sc = Math.max(score(op.textContent, eeo[key]), score(op.value, eeo[key]));
      if (sc > bs) { bs = sc; best = op; }
    }
    if (best && bs >= 45) { sel.value = best.value; fire(sel); filled++; }
  }
  function radioLabel(r) { var w = r.closest('label'); if (w) return w.innerText || w.textContent || ''; if (r.id) { var l = document.querySelector('label[for="' + r.id + '"]'); if (l) return l.innerText || l.textContent || ''; } return r.value || ''; }
  var radios = document.querySelectorAll('input[type="radio"]');
  var groups = {};
  for (var ri = 0; ri < radios.length; ri++) { var r = radios[ri]; var nm = r.name || ('__' + ri); (groups[nm] = groups[nm] || []).push(r); }
  Object.keys(groups).forEach(function (nm) {
    var rs = groups[nm];
    if (rs.some(function (x) { return x.checked; })) return;
    var cont = rs[0].closest('fieldset, .form-group, div');
    var qlabel = '';
    if (cont) { var lg = cont.querySelector('legend, label'); qlabel = norm((lg ? (lg.innerText || lg.textContent) : '') || cont.textContent.slice(0, 200)); }
    var key = eeoKey(qlabel); if (!key || !eeo[key]) return;
    var best = null, bs = 0;
    rs.forEach(function (x) { var sc = score(radioLabel(x), eeo[key]); if (sc > bs) { bs = sc; best = x; } });
    if (best && bs >= 45) { if (!best.checked) { best.checked = true; best.dispatchEvent(new Event('click', { bubbles: true })); best.dispatchEvent(new Event('change', { bubbles: true })); } filled++; }
  });

  // ----- EEO answers (custom ARIA comboboxes — Workday-style dropdowns with no native <select>) -----
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fireClick(el) {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
  }
  var triggers = document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]');
  for (var ti = 0; ti < triggers.length; ti++) {
    var trig = triggers[ti];
    try {
      if (trig.tagName === 'SELECT' || trig.disabled || trig.offsetParent === null) continue;
      var curText = norm(trig.innerText || trig.textContent || trig.value || '');
      if (curText && !/select|choose|--|^$/.test(curText)) continue; // already shows a real value
      var tKey = eeoKey(signals(trig));
      if (!tKey || !eeo[tKey]) continue;

      fireClick(trig);
      await sleep(150); // Workday-style listboxes render async, often portaled to <body>

      var opts = document.querySelectorAll('[role="option"]:not([aria-disabled="true"])');
      var tBest = null, tbs = 0;
      for (var oi = 0; oi < opts.length; oi++) {
        var opt = opts[oi];
        if (opt.offsetParent === null) continue;
        var sc = score(opt.innerText || opt.textContent || '', eeo[tKey]);
        if (sc > tbs) { tbs = sc; tBest = opt; }
      }
      if (tBest && tbs >= 45) {
        fireClick(tBest);
        await sleep(80);
        filled++;
      } else {
        trig.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
    } catch (e) { /* one odd widget shouldn't abort the rest of the autofill */ }
  }

  return filled;
}

// External ATS filling now lives in autofill.js — a standalone content script injected
// below, and RE-injected by background.js on every page load in that tab while an
// application session (started here) is active, so real page navigations (careers page ->
// account creation -> application wizard) don't kill the flow. The engine reports progress
// back via UNIVERSAL_FILL_RESULT messages, handled here; generated site passwords and
// learned answers are written to storage by the engine itself (the storage.onChanged
// listeners above keep this panel in sync).
var UNIVERSAL_STATUS_MESSAGES = {
  no_profile: { text: 'Add your info first (tap Edit), then Save.', color: '#ff9955' },
  no_fields_found: { text: 'No application fields found on this page.', color: '#ff9955' },
  stopped_needs_input: { text: 'Filled what it could — this step needs your input before Alicia can continue.', color: '#e0a800' },
  stopped_step_cap: { text: 'Filled and advanced several steps — check the page, there may be more to do.', color: '#e0a800' },
  done_no_more_fields: { text: 'Filled the application. Review before submitting.', color: '#4caf50' },
  answered_review: { text: 'Alicia answered custom questions — review them on the page, then click Continue there.', color: '#e0a800' },
  ready_to_submit: { text: 'Filled and advanced — ready for you to submit.', color: '#4caf50' },
  error: { text: 'Something went wrong while filling — check the page.', color: '#ff9955' },
  stopped_by_user: { text: 'Autofill stopped. Nothing more will be filled until you start a new fill.', color: '#e0a800' },
  // autofill.js's aggregator self-check (see its top-of-file guard): a job-board/lead-gen page was
  // deliberately NOT filled — its only fields belong to the site's own email-capture forms.
  aggregator_page: { text: 'That\'s a job-board page, not the employer\'s application — open the job\'s actual Apply page and try again.', color: '#e0a800' },
  preview: { text: 'Preview only — nothing was written. Below is what a real fill would do on this page.', color: '#e0a800' },
  // background.js's closed-loop check: the aggregator click-through verifiably failed (the tab is
  // still on the job-board host after the whole poll window) — the human has to click through.
  aggregator_stuck: { text: 'Couldn\'t get past the job-board page automatically — click through to the employer\'s application yourself and Alicia will take it from there.', color: '#e0a800' }
};

// Field-by-field summary of what a pass actually did (or, in preview, would do) — built from
// result.fillLog (see autofill.js's logFill/logSkip). AI-sourced answers get a distinct badge:
// those are the ones a human most needs to double-check before submitting.
var FS_BADGES = { ai: 'AI', profile: 'profile', learned: 'learned', 'eeo-pref': 'EEO', password: 'pw', resume: 'resume' };
function renderFillSummary(r) {
  var box = document.getElementById('fill-summary');
  if (!box) return;
  var log = Array.isArray(r.fillLog) ? r.fillLog : [];
  if (!log.length) { box.classList.add('hidden'); box.textContent = ''; return; }
  box.textContent = '';
  var h = document.createElement('h3');
  h.textContent = (r.status === 'preview' ? 'Would fill on this page' : 'What Alicia did on this pass') + ' (' + log.length + ')';
  box.appendChild(h);
  log.forEach(function (e) {
    var row = document.createElement('div');
    row.className = 'fill-summary-row';
    var badge = document.createElement('span');
    if (e.skipped) { badge.className = 'fs-badge skip'; badge.textContent = 'skipped'; }
    else if (e.applied === false) { badge.className = 'fs-badge preview'; badge.textContent = 'would fill'; }
    else { badge.className = 'fs-badge ' + (e.source || 'profile'); badge.textContent = FS_BADGES[e.source] || e.source || ''; }
    var lbl = document.createElement('span');
    lbl.className = 'fs-label';
    lbl.textContent = e.label || '(unlabeled field)';
    lbl.title = e.label || '';
    var val = document.createElement('span');
    val.className = 'fs-value';
    val.textContent = e.skipped ? (e.reason || '') : (e.value || '');
    val.title = e.skipped ? (e.reason || '') : (e.value || '');
    row.appendChild(badge); row.appendChild(lbl); row.appendChild(val);
    box.appendChild(row);
  });
  box.classList.remove('hidden');
}

chrome.runtime.onMessage.addListener(function (message) {
  if (!message || message.type !== 'UNIVERSAL_FILL_RESULT' || !message.result) return;
  var r = message.result;
  var m = UNIVERSAL_STATUS_MESSAGES[r.status] || UNIVERSAL_STATUS_MESSAGES.done_no_more_fields;
  var text = m.text;
  if (r.status === 'ready_to_submit') {
    text = 'Filled and advanced — ready for you to click "' + (r.readyButtonText || 'Submit') + '" yourself.';
  }
  if (r.filled) text = 'Filled ' + r.filled + ' field' + (r.filled === 1 ? '' : 's') + '. ' + text;
  // Specific diagnostics over canned strings: name the platform, and when the run stopped for
  // human input, say WHICH questions are waiting instead of a generic "needs your input".
  if (r.ats && r.ats !== 'generic') text += ' (' + r.ats + ')';
  if (r.status === 'stopped_needs_input' && Array.isArray(r.unansweredLabels) && r.unansweredLabels.length) {
    text += ' Waiting on you: ' + r.unansweredLabels.slice(0, 4).join(' • ') +
      (r.unansweredLabels.length > 4 ? ' (+' + (r.unansweredLabels.length - 4) + ' more)' : '');
  }
  if (r.generatedPassword) {
    text += ' Created a password for ' + r.generatedPassword.hostname + ' — saved to Site Passwords.';
  }
  setFillStatus(text, m.color);
  renderFillSummary(r);
});

function startAtsSession(tab) {
  var hostname = '';
  try { hostname = new URL(tab.url).hostname; } catch (e) {}
  chrome.storage.local.get('autofillSessions', function (data) {
    var sessions = data.autofillSessions || {};
    sessions[String(tab.id)] = { hostname: hostname, startedAt: Date.now() };
    chrome.storage.local.set({ autofillSessions: sessions });
    // Explicit new fill — clear any previous Stop AND any leftover preview flag before injecting,
    // in every frame (window persists on the page across injections; a stale preview flag would
    // silently turn this real fill into a no-write preview).
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: function () { window.__aliciaStopRequested = false; window.__aliciaPreviewMode = false; },
    }).catch(function () {}).then(function () {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['autofill.js'] }, function () {
        if (chrome.runtime.lastError) {
          setFillStatus('Could not fill this page. Open the application form and try again.', '#ff9955');
        }
      });
    });
  });
}

// "Preview Fill": inject the SAME engine with window.__aliciaPreviewMode set — autofill.js runs
// its real matching but skips every mutation (see its previewMode() gates) and reports a
// field-by-field "what WOULD be filled" summary. Deliberately does NOT create an autofill session:
// a preview must not arm the 20-minute re-inject-on-navigation machinery.
function startPreviewRun(tab) {
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: function () { window.__aliciaStopRequested = false; window.__aliciaPreviewMode = true; },
  }).catch(function () {}).then(function () {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['autofill.js'] }, function () {
      if (chrome.runtime.lastError) {
        setFillStatus('Could not preview this page. Open the application form and try again.', '#ff9955');
      }
    });
  });
}

if (eeoFillNow) {
  eeoFillNow.addEventListener('click', function () {
    chrome.storage.local.get(['eeoPrefs', 'profile'], function (data) {
      var prefs = data.eeoPrefs || {};
      var profile = data.profile || {};
      if (Object.keys(prefs).length === 0 && Object.keys(profile).length === 0) {
        setFillStatus('Add your info first (tap Edit), then Save.', '#ff9955');
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs[0]) { setFillStatus('No active tab to fill.', '#ff9955'); return; }
        var isLinkedIn = /linkedin\.com/i.test(tabs[0].url || '');
        setFillStatus('Filling the open application…', '#4caf50');

        if (isLinkedIn) {
          chrome.scripting.executeScript(
            { target: { tabId: tabs[0].id }, func: runAutofill, args: [profile, prefs] },
            function (results) {
              if (chrome.runtime.lastError) {
                setFillStatus('Could not fill this page. Open the application form and try again.', '#ff9955');
                return;
              }
              var n = results && results[0] ? results[0].result : 0;
              setFillStatus(
                n > 0 ? ('Filled ' + n + ' field' + (n === 1 ? '' : 's') + '. Review before submitting.') : 'No matching fields found on this page.',
                n > 0 ? '#4caf50' : '#ff9955'
              );
            }
          );
          return;
        }

        startAtsSession(tabs[0]);
      });
    });
  });
}

// "Filling as: ..." — the extension holds exactly ONE active profile (whoever the web app last
// synced, or whoever last saved the form here). With two people sharing this browser (the web
// app's person switcher is scoped per person, but its sync to the extension is skipped when the
// newly-selected person has no active resume — see HANDOFF.md), the single most effective guard
// against filling a real application as the WRONG person is making the active identity visible
// right where the fill buttons are.
function renderFillingAs() {
  var el = document.getElementById('filling-as');
  if (!el) return;
  chrome.storage.local.get('profile', function (data) {
    var p = data.profile || {};
    var who = [p.firstName, p.lastName].filter(Boolean).join(' ');
    el.textContent = who ? ('Filling as: ' + who + (p.email ? ' (' + p.email + ')' : '')) : '';
  });
}
renderFillingAs();
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.profile) renderFillingAs();
});

const eeoPreviewNow = document.getElementById('eeo-preview-now');
if (eeoPreviewNow) {
  eeoPreviewNow.addEventListener('click', function () {
    chrome.storage.local.get(['eeoPrefs', 'profile'], function (data) {
      if (Object.keys(data.eeoPrefs || {}).length === 0 && Object.keys(data.profile || {}).length === 0) {
        setFillStatus('Add your info first (tap Edit), then Save.', '#ff9955');
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs[0]) { setFillStatus('No active tab to preview.', '#ff9955'); return; }
        if (/linkedin\.com/i.test(tabs[0].url || '')) { setFillStatus('Preview isn\'t available on LinkedIn — use it on an application page.', '#ff9955'); return; }
        setFillStatus('Previewing (nothing will be written)…', '#e0a800');
        startPreviewRun(tabs[0]);
      });
    });
  });
}

// Mid-run interrupt: unlike the queue's Pause/Stop (which only take effect BETWEEN jobs), this
// halts an in-progress autofill run on the spot — background sets a cooperative stop flag in
// every frame of every session tab, autofill.js's checkpoints/sleep() bail within ~a second, all
// sessions are ended (so nothing re-injects on the next navigation), and the queue is stopped.
const autofillStopBtn = document.getElementById('autofill-stop');
if (autofillStopBtn) {
  autofillStopBtn.addEventListener('click', function () {
    setFillStatus('Stopping autofill…', '#e0a800');
    chrome.runtime.sendMessage({ type: 'STOP_AUTOFILL' }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        setFillStatus('Could not reach the extension to stop — try again or reload the extension.', '#ff9955');
        return;
      }
      setFillStatus('Autofill stopped. Nothing more will be filled until you start a new fill.', '#4caf50');
    });
  });
}

// Console helper to unlock Premium on a specific install (e.g. yours/your wife's).
// Open the side panel's DevTools and run: aliciaPremium.enable()
window.aliciaPremium = {
  enable: function () { isPremium = true; chrome.storage.local.set({ isPremium: true }); updateChatHint(); return 'Premium enabled — unlimited chat.'; },
  disable: function () { isPremium = false; chrome.storage.local.set({ isPremium: false }); updateChatHint(); return 'Premium disabled — back to free limits.'; },
  status: function () { return isPremium ? 'Premium' : 'Free (' + JSON.stringify(usage) + ')'; }
};

// Restore theme, saved sessions, tracked jobs, usage, and the live conversation on startup.
chrome.storage.local.get(['theme', 'chatSessions', 'liveChat', 'trackedJobs', 'usage', 'isPremium', 'searchPrefs', 'eeoPrefs', 'profile', 'autoAdvanceEasyApply', 'customQA', 'siteCredentials'], function (data) {
  applyTheme(data.theme || 'midnight');
  if (Array.isArray(data.chatSessions)) chatSessions = data.chatSessions;
  if (Array.isArray(data.trackedJobs)) trackedJobs = data.trackedJobs;
  isPremium = data.isPremium === true;
  usage = (data.usage && data.usage.date === todayStr())
    ? data.usage
    : { date: todayStr(), jobChat: 0, generalChat: 0, image: 0 };
  renderTrackerStats();
  updateChatHint();
  if (data.liveChat && data.liveChat.job && data.liveChat.general) {
    chatStore = data.liveChat;
    renderChat();
  }
  if (data.searchPrefs) applySearchPrefs(data.searchPrefs);
  if (data.eeoPrefs) applyEeoPrefs(data.eeoPrefs);
  if (data.profile) applyProfile(data.profile);
  if (autoAdvanceToggle) autoAdvanceToggle.checked = data.autoAdvanceEasyApply !== false;
  learnedQaBank = Array.isArray(data.customQA) ? data.customQA : [];
  if (learnedQaEmpty) learnedQaEmpty.classList.toggle('hidden', learnedQaBank.length > 0);
  siteCredentialsBank = data.siteCredentials || {};
  if (sitePasswordsEmpty) sitePasswordsEmpty.classList.toggle('hidden', Object.keys(siteCredentialsBank).length > 0);
});

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendChat();
});

// ========== Side-panel tabs ==========
// Every feature stays; they're just grouped behind Apply / Search / Tracker / Tools / Chat
// so one screen isn't a wall of buttons. Last-used tab is remembered across opens.
var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));

function switchTab(name, persist) {
  tabButtons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
  document.querySelectorAll('.tab-panel').forEach(function (p) {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
  // A tab whose whole point is its list shouldn't open onto a collapsed "Show" toggle.
  if (name === 'tracker' && trackerBody && trackerBody.classList.contains('hidden')) toggleTracker(true);
  if (persist !== false) chrome.storage.local.set({ activeTab: name });
}

tabButtons.forEach(function (b) {
  b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
});

chrome.storage.local.get('activeTab', function (d) {
  if (d.activeTab && document.getElementById('tab-' + d.activeTab)) switchTab(d.activeTab, false);
});
