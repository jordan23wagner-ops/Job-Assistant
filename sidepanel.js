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
  const stored = await chrome.storage.local.get('groqApiKey');
  if (stored.groqApiKey) {
    groqApiKey = stored.groqApiKey;
    return groqApiKey;
  }
  const key = prompt('Enter your Groq API key (get one at console.groq.com):');
  if (key) {
    groqApiKey = key.trim();
    await chrome.storage.local.set({ groqApiKey });
    return groqApiKey;
  }
  return null;
}

async function callGroq(messages, temperature = 0.7) {
  const key = groqApiKey || await getApiKey();
  if (!key) throw new Error('No API key provided. Click any AI feature to set your Groq API key.');

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature,
      max_tokens: 2048
    })
  });

  if (!resp.ok) {
    if (resp.status === 401) {
      groqApiKey = null;
      await chrome.storage.local.remove('groqApiKey');
      throw new Error('Invalid API key. Click any AI feature to re-enter your key.');
    }
    const err = await resp.text();
    throw new Error(`Groq API error: ${resp.status}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatAnalysis(text) {
  return text
    .replace(/###\s*(.+)/g, '<h3>$1</h3>')
    .replace(/##\s*(.+)/g, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\* (.+)$/gm, '<li>$1</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

function displayJob(job) {
  currentJob = job;
  let html = `<div class="job-title">${escapeHtml(job.title || 'Unknown Title')}</div>`;
  if (job.company) html += `<div class="job-company">${escapeHtml(job.company)}</div>`;
  if (job.location) html += `<div class="job-location">${escapeHtml(job.location)}</div>`;
  if (job.description) {
    const preview = job.description.substring(0, 200);
    html += `<div class="job-desc">${escapeHtml(preview)}...</div>`;
  }
  jobInfo.innerHTML = html;
  updateToolButtons();
}

function updateToolButtons() {
  analyzeBtn.disabled = !currentJob;
  tailorBtn.disabled = !currentJob || !resumeText;
  coverBtn.disabled = !currentJob;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'JOB_DETECTED' && message.job) {
    displayJob(message.job);
  }
});

detectBtn.addEventListener('click', () => {
  jobInfo.innerHTML = '<p class="placeholder">Detecting job...</p>';
  chrome.runtime.sendMessage({ type: 'DETECT_JOB' });
  setTimeout(() => {
    if (!currentJob) {
      jobInfo.innerHTML = '<p class="placeholder">No job found. Make sure you\'re on a LinkedIn job posting page and try again.</p>';
    }
  }, 5000);
});

resumeUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    resumeText = ev.target.result;
    resumeStatus.textContent = `Loaded: ${file.name}`;
    chrome.storage.local.set({ resumeText });
    updateToolButtons();
  };
  reader.onerror = () => {
    resumeStatus.textContent = 'Error reading file';
  };
  reader.readAsText(file);
});

chrome.storage.local.get(['resumeText', 'groqApiKey'], (data) => {
  if (data.resumeText) {
    resumeText = data.resumeText;
    resumeStatus.textContent = 'Resume loaded from storage';
    updateToolButtons();
  }
  if (data.groqApiKey) {
    groqApiKey = data.groqApiKey;
  }
});

// --- Analyze Job ---

analyzeBtn.addEventListener('click', async () => {
  if (!currentJob) return;
  analysisTitle.textContent = 'Analysis';
  analysisContent.innerHTML = '<p class="loading">Analyzing job...</p>';
  analysisSection.classList.remove('hidden');

  try {
    const messages = [
      { role: 'system', content: 'You are Alicia, a job search assistant. Analyze the following job posting and provide a structured breakdown with: Key Requirements, Nice-to-Haves, Company Culture Signals, Potential Red Flags, and Salary Insights (if mentioned). Use markdown formatting.' },
      { role: 'user', content: `Job Title: ${currentJob.title}\nCompany: ${currentJob.company}\nLocation: ${currentJob.location}\n\nDescription:\n${currentJob.description}` }
    ];
    const result = await callGroq(messages);
    analysisContent.innerHTML = formatAnalysis(result);
  } catch (err) {
    analysisContent.innerHTML = `<p style="color:#ff5555">${escapeHtml(err.message)}</p>`;
  }
});

closeAnalysis.addEventListener('click', () => {
  analysisSection.classList.add('hidden');
});

// --- Cover Letter ---

coverBtn.addEventListener('click', async () => {
  if (!currentJob) return;
  analysisTitle.textContent = 'Cover Letter';
  analysisContent.innerHTML = '<p class="loading">Generating cover letter...</p>';
  analysisSection.classList.remove('hidden');

  try {
    let userMsg = `Write a professional cover letter for:\n\nJob Title: ${currentJob.title}\nCompany: ${currentJob.company}\nLocation: ${currentJob.location}\n\nJob Description:\n${currentJob.description}`;
    if (resumeText) {
      userMsg += `\n\nCandidate's Resume:\n${resumeText}`;
    }
    const messages = [
      { role: 'system', content: 'You are Alicia, a job search assistant. Write a compelling, professional cover letter. Keep it concise (3-4 paragraphs). Personalize it based on the job description and resume if provided.' },
      { role: 'user', content: userMsg }
    ];
    const result = await callGroq(messages);
    analysisContent.innerHTML = formatAnalysis(result);
  } catch (err) {
    analysisContent.innerHTML = `<p style="color:#ff5555">${escapeHtml(err.message)}</p>`;
  }
});

// --- Interactive Resume Tailoring ---

const TAILORING_STEPS = [
  {
    id: 'relevance',
    getPrompt: (job, resume) => ({
      system: 'You are Alicia, an expert resume tailoring assistant. Analyze the job and resume, then ask which experiences are MOST relevant. List 3-5 specific items from their resume as numbered options, noting why each could be relevant. End with: "Which are most relevant? (pick all, or tell me about other experience)"',
      user: `Job: ${job.title} at ${job.company}\n\nDescription: ${job.description}\n\nResume:\n${resume}`
    })
  },
  {
    id: 'skills_gap',
    getPrompt: (job, resume, prev) => ({
      system: 'You are Alicia, an expert resume tailoring assistant. Identify 2-3 skills from the job posting not clearly shown in the resume. Ask if they have unlisted experience. Present as numbered questions. Be encouraging.',
      user: `Job: ${job.title} at ${job.company}\n\nDescription: ${job.description}\n\nResume: ${resume}\n\nThey said: ${prev.relevance}`
    })
  },
  {
    id: 'achievements',
    getPrompt: (job, resume, prev) => ({
      system: 'You are Alicia, an expert resume tailoring assistant. Ask about quantifiable achievements. For each experience, suggest metrics ("How many users?", "What % improvement?"). Ask 2-3 questions.',
      user: `Job: ${job.title}\n\nRelevant: ${prev.relevance}\nSkills: ${prev.skills_gap}\n\nResume: ${resume}`
    })
  },
  {
    id: 'generate',
    getPrompt: (job, resume, prev) => ({
      system: 'You are Alicia. Generate specific resume tailoring suggestions:\n1. **Summary** - tailored statement\n2. **Experience Bullets** - rewritten for this job\n3. **Skills** - prioritized list\n4. **Keywords** - ATS-friendly terms\n\nGive actual text, not generic advice.',
      user: `Job: ${job.title} at ${job.company}\n\nDescription: ${job.description}\n\nResume: ${resume}\n\nRelevant: ${prev.relevance}\nSkills: ${prev.skills_gap}\nMetrics: ${prev.achievements}`
    })
  }
];

function addTailoringMessage(text, role) {
  const div = document.createElement('div');
  div.className = `tailoring-msg ${role}`;
  div.innerHTML = (role === 'ai' || role === 'final') ? formatAnalysis(text) : escapeHtml(text);
  tailoringConversation.appendChild(div);
  tailoringConversation.scrollTop = tailoringConversation.scrollHeight;
}

function clearTailoringOptions() {
  tailoringOptions.innerHTML = '';
}

function addTailoringQuickOptions(options) {
  clearTailoringOptions();
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'tailoring-option-btn';
    btn.textContent = opt;
    btn.addEventListener('click', () => handleTailoringResponse(opt));
    tailoringOptions.appendChild(btn);
  });
}

async function startTailoring() {
  tailoringSection.classList.remove('hidden');
  tailoringConversation.innerHTML = '';
  clearTailoringOptions();
  tailoringInput.value = '';
  tailoringState = { step: 0, answers: {} };
  addTailoringMessage("Let's tailor your resume! I'll ask questions to highlight the right experience.", 'ai');
  await runTailoringStep();
}

async function runTailoringStep() {
  const step = TAILORING_STEPS[tailoringState.step];
  if (!step) return;

  addTailoringMessage('Thinking...', 'ai');

  try {
    const prompts = step.getPrompt(currentJob, resumeText, tailoringState.answers);
    const messages = [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ];
    const result = await callGroq(messages);

    const lastMsg = tailoringConversation.lastElementChild;
    if (lastMsg && lastMsg.textContent === 'Thinking...') lastMsg.remove();

    if (step.id === 'generate') {
      addTailoringMessage(result, 'final');
      addTailoringQuickOptions(['Start over', 'Adjust suggestions']);
    } else {
      addTailoringMessage(result, 'ai');
      addTailoringQuickOptions(['All of them', 'Skip this step']);
    }
  } catch (err) {
    const lastMsg = tailoringConversation.lastElementChild;
    if (lastMsg && lastMsg.textContent === 'Thinking...') lastMsg.remove();
    addTailoringMessage(`Error: ${err.message}`, 'ai');
  }
}

async function handleTailoringResponse(response) {
  addTailoringMessage(response, 'user');
  clearTailoringOptions();

  if (response === 'Start over') { await startTailoring(); return; }
  if (response === 'Adjust suggestions') {
    tailoringState.step = 2;
    addTailoringMessage("What would you like to adjust?", 'ai');
    return;
  }

  const step = TAILORING_STEPS[tailoringState.step];
  if (step) tailoringState.answers[step.id] = response;
  tailoringState.step++;

  if (tailoringState.step <= TAILORING_STEPS.length - 1) {
    await runTailoringStep();
  }
}

tailorBtn.addEventListener('click', () => {
  if (!currentJob || !resumeText) return;
  startTailoring();
});

tailoringSend.addEventListener('click', () => {
  const val = tailoringInput.value.trim();
  if (val) { tailoringInput.value = ''; handleTailoringResponse(val); }
});

tailoringInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = tailoringInput.value.trim();
    if (val) { tailoringInput.value = ''; handleTailoringResponse(val); }
  }
});

closeTailoring.addEventListener('click', () => {
  tailoringSection.classList.add('hidden');
  tailoringState = null;
});

// --- Chat ---

function addChatMessage(text, role) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = role === 'ai' ? formatAnalysis(text) : escapeHtml(text);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  addChatMessage(text, 'user');
  chatHistory.push({ role: 'user', content: text });

  const systemMsg = buildChatSystemMessage();
  const messages = [{ role: 'system', content: systemMsg }, ...chatHistory];

  addChatMessage('Thinking...', 'ai');

  try {
    const result = await callGroq(messages);
    chatMessages.lastElementChild.remove();
    addChatMessage(result, 'ai');
    chatHistory.push({ role: 'assistant', content: result });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-16);
  } catch (err) {
    chatMessages.lastElementChild.remove();
    addChatMessage(`Error: ${err.message}`, 'ai');
  }
}

function buildChatSystemMessage() {
  let msg = 'You are Alicia, a friendly AI job search assistant. Help with job searching, resume writing, interview prep, and career advice. Be concise and actionable.';
  if (currentJob) {
    msg += `\n\nCurrent job: ${currentJob.title} at ${currentJob.company} (${currentJob.location}).\nDescription: ${currentJob.description?.substring(0, 500)}`;
  }
  if (resumeText) {
    msg += `\n\nResume: ${resumeText.substring(0, 1000)}`;
  }
  return msg;
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});