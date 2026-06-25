let currentJob = null;
let resumeText = null;
let groqApiKey = null;
let chatHistory = [];
let tailoringState = null;

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

async function getApiKey() {
  var stored = await chrome.storage.local.get('groqApiKey');
  if (stored.groqApiKey) {
    groqApiKey = stored.groqApiKey;
    return groqApiKey;
  }
  var key = prompt('Enter your Groq API key (get one at console.groq.com):');
  if (key) {
    groqApiKey = key.trim();
    await chrome.storage.local.set({ groqApiKey: groqApiKey });
    return groqApiKey;
  }
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
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens || 2048
    })
  });

  if (!resp.ok) {
    if (resp.status === 401) {
      groqApiKey = null;
      await chrome.storage.local.remove('groqApiKey');
      throw new Error('Invalid API key. Click any AI feature to re-enter your key.');
    }
    throw new Error('Groq API error: ' + resp.status);
  }

  var data = await resp.json();
  return sanitizeText(data.choices[0].message.content);
}

async function callGroq(messages, temperature, maxTokens) {
  if (temperature === undefined) temperature = 0.7;
  var key = groqApiKey || await getApiKey();
  if (!key) throw new Error('No API key provided. Click any AI feature to set your Groq API key.');

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
  if (data.groqApiKey) {
    groqApiKey = data.groqApiKey;
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

async function sendChat() {
  var text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  addChatMessage(text, 'user');
  chatHistory.push({ role: 'user', content: text });

  var systemMsg = buildChatSystemMessage();
  var msgs = [{ role: 'system', content: systemMsg }].concat(chatHistory);

  addChatMessage('Thinking...', 'ai');

  try {
    var result = await callGroq(msgs);
    chatMessages.lastElementChild.remove();
    addChatMessage(result, 'ai');
    chatHistory.push({ role: 'assistant', content: result });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-16);
  } catch (err) {
    chatMessages.lastElementChild.remove();
    addChatMessage('Error: ' + err.message, 'ai');
    if (chatHistory.length && chatHistory[chatHistory.length - 1].role === 'user') {
      chatHistory.pop();
    }
  }
}

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

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendChat();
});
