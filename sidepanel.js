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

function isValidResponse(text) {
  if (!text || text.length < 10) return false;
  var letterCount = 0;
  var totalCount = text.length;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letterCount++;
  }
  if (letterCount / totalCount < 0.3) return false;
  var repeats = 0;
  for (var j = 1; j < text.length; j++) {
    if (text[j] === text[j - 1]) repeats++;
  }
  if (repeats / totalCount > 0.5) return false;
  return true;
}

async function callGroq(messages, temperature) {
  if (temperature === undefined) temperature = 0.7;
  var key = groqApiKey || await getApiKey();
  if (!key) throw new Error('No API key provided. Click any AI feature to set your Groq API key.');

  var resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      temperature: temperature,
      max_tokens: 2048
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
  var content = sanitizeText(data.choices[0].message.content);

  if (!isValidResponse(content)) {
    var resp2 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.5,
        max_tokens: 2048
      })
    });
    if (resp2.ok) {
      var data2 = await resp2.json();
      var content2 = sanitizeText(data2.choices[0].message.content);
      if (isValidResponse(content2)) return content2;
    }
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
    var line = lines[i];

    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    if (/^#{2,3}\s+(.+)/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      var heading = line.replace(/^#{2,3}\s+/, '');
      html += '<h3>' + heading + '</h3>';
    } else if (/^[*\-]\s+(.+)/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      var item = line.replace(/^[*\-]\s+/, '');
      html += '<li>' + item + '</li>';
    } else if (/^\d+\.\s+(.+)/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      var item2 = line.replace(/^\d+\.\s+/, '');
      html += '<li>' + item2 + '</li>';
    } else if (line.trim() === '') {
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
  var html = '<div class="job-title">' + escapeHtml(job.title || 'Unknown Title') + '</div>';
  if (job.company) html += '<div class="job-company">' + escapeHtml(job.company) + '</div>';
  if (job.location) html += '<div class="job-location">' + escapeHtml(job.location) + '</div>';
  if (job.description) {
    var preview = job.description.substring(0, 300);
    html += '<div class="job-desc">' + escapeHtml(preview) + '...</div>';
  }
  jobInfo.innerHTML = html;
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

resumeUpload.addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    resumeText = ev.target.result;
    resumeStatus.textContent = 'Loaded: ' + file.name;
    chrome.storage.local.set({ resumeText: resumeText });
    updateToolButtons();
  };
  reader.onerror = function() {
    resumeStatus.textContent = 'Error reading file';
  };
  reader.readAsText(file);
});

chrome.storage.local.get(['resumeText', 'groqApiKey'], function(data) {
  if (data.resumeText) {
    resumeText = data.resumeText;
    resumeStatus.textContent = 'Resume loaded from storage';
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

var TAILORING_STEPS = [
  {
    id: 'relevance',
    getPrompt: function(job, resume) {
      return {
        system: 'You are Alicia, an expert resume tailoring assistant. Analyze the job and resume, then ask which experiences are MOST relevant. List 3-5 specific items from their resume as numbered options, noting why each could be relevant. End with: "Which are most relevant? (pick all, or tell me about other experience)"',
        user: 'Job: ' + job.title + ' at ' + job.company + '\n\nDescription: ' + job.description + '\n\nResume:\n' + resume
      };
    }
  },
  {
    id: 'skills_gap',
    getPrompt: function(job, resume, prev) {
      return {
        system: 'You are Alicia, an expert resume tailoring assistant. Identify 2-3 skills from the job posting not clearly shown in the resume. Ask if they have unlisted experience. Present as numbered questions. Be encouraging.',
        user: 'Job: ' + job.title + ' at ' + job.company + '\n\nDescription: ' + job.description + '\n\nResume: ' + resume + '\n\nThey said: ' + prev.relevance
      };
    }
  },
  {
    id: 'achievements',
    getPrompt: function(job, resume, prev) {
      return {
        system: 'You are Alicia, an expert resume tailoring assistant. Ask about quantifiable achievements. For each experience, suggest metrics ("How many users?", "What % improvement?"). Ask 2-3 questions.',
        user: 'Job: ' + job.title + '\n\nRelevant: ' + prev.relevance + '\nSkills: ' + prev.skills_gap + '\n\nResume: ' + resume
      };
    }
  },
  {
    id: 'generate',
    getPrompt: function(job, resume, prev) {
      return {
        system: 'You are Alicia. Generate specific resume tailoring suggestions:\n1. Summary - a tailored professional summary\n2. Experience Bullets - rewritten bullet points for this job\n3. Skills - prioritized skills list\n4. Keywords - ATS-friendly terms to include\n\nProvide actual text the candidate can use, not generic advice.',
        user: 'Job: ' + job.title + ' at ' + job.company + '\n\nDescription: ' + job.description + '\n\nResume: ' + resume + '\n\nRelevant: ' + prev.relevance + '\nSkills: ' + prev.skills_gap + '\nMetrics: ' + prev.achievements
      };
    }
  }
];

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

async function startTailoring() {
  tailoringSection.classList.remove('hidden');
  tailoringConversation.innerHTML = '';
  clearTailoringOptions();
  tailoringInput.value = '';
  tailoringState = { step: 0, answers: {} };
  addTailoringMessage('Let\'s tailor your resume! I\'ll ask questions to highlight the right experience.', 'ai');
  await runTailoringStep();
}

async function runTailoringStep() {
  var step = TAILORING_STEPS[tailoringState.step];
  if (!step) return;

  addTailoringMessage('Thinking...', 'ai');

  try {
    var prompts = step.getPrompt(currentJob, resumeText, tailoringState.answers);
    var msgs = [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ];
    var result = await callGroq(msgs);

    var lastMsg = tailoringConversation.lastElementChild;
    if (lastMsg && lastMsg.textContent === 'Thinking...') lastMsg.remove();

    if (step.id === 'generate') {
      addTailoringMessage(result, 'final');
      addTailoringQuickOptions(['Start over', 'Adjust suggestions']);
    } else {
      addTailoringMessage(result, 'ai');
      addTailoringQuickOptions(['All of them', 'Skip this step']);
    }
  } catch (err) {
    var lastMsg2 = tailoringConversation.lastElementChild;
    if (lastMsg2 && lastMsg2.textContent === 'Thinking...') lastMsg2.remove();
    addTailoringMessage('Error: ' + err.message, 'ai');
  }
}

async function handleTailoringResponse(response) {
  addTailoringMessage(response, 'user');
  clearTailoringOptions();

  if (response === 'Start over') { await startTailoring(); return; }
  if (response === 'Adjust suggestions') {
    tailoringState.step = 2;
    addTailoringMessage('What would you like to adjust?', 'ai');
    return;
  }

  var step = TAILORING_STEPS[tailoringState.step];
  if (step) tailoringState.answers[step.id] = response;
  tailoringState.step++;

  if (tailoringState.step <= TAILORING_STEPS.length - 1) {
    await runTailoringStep();
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
  }
}

function buildChatSystemMessage() {
  var msg = 'You are Alicia, a friendly AI job search assistant. Help with job searching, resume writing, interview prep, and career advice. Be concise and actionable. Respond in plain English paragraphs and bullet points only.';
  if (currentJob) {
    msg += '\n\nCurrent job being viewed: ' + currentJob.title + ' at ' + currentJob.company + ' (' + currentJob.location + ').';
    if (currentJob.description) {
      msg += '\nJob description: ' + currentJob.description.substring(0, 500);
    }
  }
  if (resumeText) {
    msg += '\n\nCandidate resume: ' + resumeText.substring(0, 1000);
  }
  return msg;
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendChat();
});
