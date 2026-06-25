let currentJob = null;
let resumeText = null;
let groqApiKey = null;
let tailoringState = null;

// Chat: two independent conversations — 'job' (career coach) and 'general' (everyday assistant)
let chatMode = 'job';
let chatStore = { job: [], general: [] };
let pendingImage = null; // { dataUrl, name } attached for the next general-mode message
let chatSessions = []; // archived conversations: {id, title, mode, ts, pinned, records}

const MAX_UNPINNED_SESSIONS = 10;
const THEME_NAMES = ['midnight', 'yellow', 'slate', 'light'];

// TEST MODE: Set this to true to clear stored API key and test onboarding on load
const TEST_FIRST_RUN = false;

// Groq model. Qwen 3.6 27B: multimodal (text + image), fast, current as of 2026.
const GROQ_MODEL = 'qwen/qwen3.6-27b';

const jobInfo = document.getElementById('job-info');
const detectBtn = document.getElementById('detect-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const tailorBtn = document.getElementById('tailor-btn');
const coverBtn = document.getElementById('cover-btn');
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
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const pasteToggle = document.getElementById('paste-toggle');
const pasteBox = document.getElementById('paste-box');
const resumePaste = document.getElementById('resume-paste');
const resumePasteSave = document.getElementById('resume-paste-save');
const onboarding = document.getElementById('onboarding');
const openGroqBtn = document.getElementById('open-groq-btn');
const obKeyInput = document.getElementById('ob-key-input');
const obSaveBtn = document.getElementById('ob-save-btn');
const obError = document.getElementById('ob-error');
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

function showOnboarding(errorMsg) {
  if (!onboarding) return;
  onboarding.classList.remove('hidden');
  if (errorMsg) {
    obError.textContent = errorMsg;
    obError.classList.remove('hidden');
  } else {
    obError.classList.add('hidden');
  }
  if (obKeyInput) obKeyInput.focus();
}

function hideOnboarding() {
  if (onboarding) onboarding.classList.add('hidden');
}

function validateGroqKey(key) {
  if (!key) return { ok: false, msg: 'Please paste your API key in the box above.' };
  if (/\s/.test(key)) return { ok: false, msg: 'The key should not contain spaces or line breaks. Copy just the key itself.' };
  if (key.indexOf('gsk_') !== 0) return { ok: false, msg: 'Groq keys start with "gsk_". Double-check you copied the whole key from the Groq page.' };
  if (key.length < 40) return { ok: false, msg: 'That key looks too short. Copy the entire key — it is about 56 characters long.' };
  return { ok: true };
}

async function verifyGroqKey(key) {
  var resp = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': 'Bearer ' + key }
  });
  return resp.ok;
}

if (openGroqBtn) {
  openGroqBtn.addEventListener('click', function() {
    chrome.tabs.create({ url: 'https://console.groq.com/keys' });
  });
}

async function handleSaveKey() {
  var key = obKeyInput.value.trim();
  var v = validateGroqKey(key);
  if (!v.ok) {
    obError.textContent = v.msg;
    obError.classList.remove('hidden');
    return;
  }
  obError.classList.add('hidden');
  obSaveBtn.disabled = true;
  obSaveBtn.textContent = 'Checking your key...';

  var verified = null;
  try {
    verified = await verifyGroqKey(key);
  } catch (e) {
    verified = null; // network/CORS hiccup — don't block her, store it anyway
  }

  if (verified === false) {
    obError.textContent = 'That key did not work. Make sure you copied the whole key and that your Groq account is active, then try again.';
    obError.classList.remove('hidden');
    obSaveBtn.disabled = false;
    obSaveBtn.textContent = 'Save & Get Started';
    return;
  }

  groqApiKey = key;
  await chrome.storage.local.set({ groqApiKey: key });
  obSaveBtn.disabled = false;
  obSaveBtn.textContent = 'Save & Get Started';
  hideOnboarding();
}

if (obSaveBtn) {
  obSaveBtn.addEventListener('click', handleSaveKey);
}
if (obKeyInput) {
  obKeyInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') handleSaveKey();
  });
}

async function getApiKey() {
  var stored = await chrome.storage.local.get('groqApiKey');
  if (stored.groqApiKey) {
    groqApiKey = stored.groqApiKey;
    return groqApiKey;
  }
  showOnboarding();
  return null;
}

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

async function rawGroqCall(messages, temperature, key, maxTokens) {
  var resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens || 2048
    })
  });

  if (!resp.ok) {
    if (resp.status === 401) {
      groqApiKey = null;
      await chrome.storage.local.remove('groqApiKey');
      showOnboarding('Your saved API key stopped working. Please paste a new one to continue.');
      throw new Error('Invalid API key. Please re-enter your Groq API key in the welcome screen.');
    }
    throw new Error('Groq API error: ' + resp.status);
  }

  var data = await resp.json();
  return sanitizeText(data.choices[0].message.content);
}

async function callGroq(messages, temperature, maxTokens) {
  if (temperature === undefined) temperature = 0.7;
  var key = groqApiKey || await getApiKey();
  if (!key) throw new Error('Please add your free Groq API key in the welcome screen to use this feature.');

  var content = await rawGroqCall(messages, temperature, key, maxTokens);

  if (isResponseGarbage(content)) {
    console.log('[Alicia] Garbage response detected, retrying:', content);
    var retry = await rawGroqCall(messages, 0.3, key, maxTokens);
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
}

chrome.runtime.onMessage.addListener(function(message) {
  if (message.type === 'JOB_DETECTED' && message.job) {
    displayJob(message.job);
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

    resumeText = text;
    await chrome.storage.local.set({ resumeText: resumeText });

    if (isLowQuality) {
      setResumeStatus('Loaded (partial text — quality may be limited)', '#ffaa00');
      showGoogleDocsTip();
    } else {
      setResumeStatus('Loaded: ' + file.name, '#4caf50');
    }

    updateToolButtons();
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
  resumeText = text;
  await chrome.storage.local.set({ resumeText: resumeText });
  setResumeStatus('Resume saved from pasted text', '#4caf50');
  pasteBox.classList.add('hidden');
  updateToolButtons();
});

chrome.storage.local.get(['resumeText', 'groqApiKey'], function(data) {
  if (data.resumeText) {
    if (isLowQualityResumeText(data.resumeText)) {
      chrome.storage.local.remove('resumeText');
      resumeText = null;
      setResumeStatus('Your saved resume was unreadable or low-quality. Please re-upload or paste text.', '#ff9955');
    } else {
      resumeText = sanitizeText(data.resumeText);
      setResumeStatus('Resume loaded from storage', '#4caf50');
    }
    updateToolButtons();
  }
  if (TEST_FIRST_RUN) {
    chrome.storage.local.remove('groqApiKey');
    groqApiKey = null;
    showOnboarding();
  } else if (data.groqApiKey) {
    groqApiKey = data.groqApiKey;
  } else {
    showOnboarding();
  }
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

async function startTailoring() {
  tailoringSection.classList.remove('hidden');
  tailoringConversation.innerHTML = '';
  clearTailoringOptions();
  tailoringInput.value = '';
  tailoringState = { mode: null, deepDiveAnswers: [], tailoredResume: null, generating: false };
  addTailoringMessage('How would you like to tailor your resume for **' + escapeHtml(currentJob.title) + '** at **' + escapeHtml(currentJob.company) + '**?', 'ai');
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
      { role: 'user', content: 'Target Role: ' + currentJob.title + ' at ' + currentJob.company + '\n\nJob Description:\n' + currentJob.description + '\n\nCurrent Resume:\n' + resumeText }
    ];
    var result = await callGroq(msgs, 0.4, 4096);
    removeLoadingMessage('Tailoring');
    tailoringState.tailoredResume = result;
    addTailoringMessage(result, 'final');
    addTailoringQuickOptions(['Download Resume', 'Start over']);
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
      { role: 'user', content: 'Target Role: ' + currentJob.title + ' at ' + currentJob.company + '\n\nJob Description:\n' + currentJob.description + '\n\nCurrent Resume:\n' + resumeText + extraContext }
    ];
    var result = await callGroq(msgs, 0.4, 4096);
    removeLoadingMessage('Building');
    tailoringState.tailoredResume = result;
    addTailoringMessage(result, 'final');
    addTailoringQuickOptions(['Download Resume', 'Start over']);
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

function setChatMode(mode) {
  chatMode = mode;
  modeJobBtn.classList.toggle('active', mode === 'job');
  modeGeneralBtn.classList.toggle('active', mode === 'general');
  if (mode === 'general') {
    chatModeHint.textContent = 'General assistant — ask anything, attach a photo, or paste a link to discuss.';
    chatAttachBtn.classList.remove('hidden');
    chatInput.placeholder = 'Ask anything, or paste a link...';
  } else {
    chatModeHint.textContent = 'Ask about this job, your resume, or your search.';
    chatAttachBtn.classList.add('hidden');
    chatInput.placeholder = 'Ask Alicia anything...';
    clearPendingImage();
  }
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

async function sendChat() {
  var text = chatInput.value.trim();
  if (!text && !pendingImage) return;
  chatInput.value = '';

  var store = chatStore[chatMode];
  var imageForTurn = (chatMode === 'general') ? pendingImage : null;

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
  var unpinnedCount = 0;
  var evicted = [];
  var kept = [];
  for (var i = 0; i < chatSessions.length; i++) {
    var s = chatSessions[i];
    if (s.pinned) { kept.push(s); continue; }
    unpinnedCount++;
    if (unpinnedCount <= MAX_UNPINNED_SESSIONS) { kept.push(s); }
    else { evicted.push(s.title); }
  }
  chatSessions = kept;
  persistSessions();

  if (evicted.length) {
    showChatNotice('Removed older chat' + (evicted.length > 1 ? 's' : '') + ' "' +
      evicted.join('", "') + '" to keep your last ' + MAX_UNPINNED_SESSIONS +
      '. Tap ★ on a chat to keep it permanently.');
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

// Restore theme, saved sessions, and the live conversation on startup.
chrome.storage.local.get(['theme', 'chatSessions', 'liveChat'], function (data) {
  applyTheme(data.theme || 'midnight');
  if (Array.isArray(data.chatSessions)) chatSessions = data.chatSessions;
  if (data.liveChat && data.liveChat.job && data.liveChat.general) {
    chatStore = data.liveChat;
    renderChat();
  }
});

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendChat();
});
