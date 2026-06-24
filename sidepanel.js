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
  const key = prompt('Enter your Groq API key:');
  if (key) {
    groqApiKey = key.trim();
    await chrome.storage.local.set({ groqApiKey });
    return groqApiKey;
  }
  return null;
}

async function callGroq(messages, temperature = 0.7) {
  const key = groqApiKey || await getApiKey();
  if (!key) throw new Error('No API key');

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
    const err = await resp.text();
    throw new Error(`Groq API error: ${resp.status} - ${err}`);
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
  analyzeBtn.disabled = false;
  tailorBtn.disabled = !resumeText;
  coverBtn.disabled = false;
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
  chrome.runtime.sendMessage({ type: 'DETECT_JOB' });
});

resumeUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    resumeText = ev.target.result;
    resumeStatus.textContent = `✓ ${file.name}`;
    chrome.storage.local.set({ resumeText });
    updateToolButtons();
  };
  reader.readAsText(file);
});

chrome.storage.local.get(['resumeText', 'groqApiKey'], (data) => {
  if (data.resumeText) {
    resumeText = data.resumeText;
    resumeStatus.textContent = '✓ Resume loaded';
    updateToolButtons();
  }
  if (data.groqApiKey) {
    groqApiKey = data.groqApiKey;
  }
});

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

coverBtn.addEventListener('click', async () => {
  if (!currentJob) return;
  analysisTitle.textContent = 'Cover Letter';
  analysisContent.innerHTML = '<p class="loading">Generating cover letter...</p>';
  analysisSection.classList.remove('hidden');

  try {
    let prompt = `Write a professional cover letter for the following job:\n\nJob Title: ${currentJob.title}\nCompany: ${currentJob.company}\nLocation: ${currentJob.location}\n\nJob Description:\n${currentJob.description}`;
    if (resumeText) {
      prompt += `\n\nCandidate's Resume:\n${resumeText}`;
    }

    const messages = [
      { role: 'system', content: 'You are Alicia, a job search assistant. Write a compelling, professional cover letter. Keep it concise (3-4 paragraphs). Personalize it based on the job description and resume if provided.' },
      { role: 'user', content: prompt }
    ];
    const result = await callGroq(messages);
    analysisContent.innerHTML = formatAnalysis(result);
  } catch (err) {
    analysisContent.innerHTML = `<p style="color:#ff5555">${escapeHtml(err.message)}</p>`;
  }
});

const TAILORING_STEPS = [
  {
    id: 'relevance',
    getPrompt: (job, resume) => ({
      system: `You are Alicia, an expert resume tailoring assistant. Analyze the job and resume, then ask which experiences are MOST relevant. List 3-5 specific items from their resume as options, noting why each could be relevant. End with: "Which are most relevant? (pick all, or tell me about other experience)"`,
      user: `Job: ${job.title} at ${job.company}\n\nDescription: ${job.description}\n\nResume:\n${resume}`
    })
  },
  {
    id: 'skills_gap',
    getPrompt: (job, resume, prevAnswers) => ({
      system: `You are Alicia, an expert resume tailoring assistant. Based on job requirements and their selected experiences, identify 2-3 skills from the job posting not clearly shown. Ask if they have unlisted experience or something similar. Present as numbered questions. Be encouraging.`,
      user: `Job: ${job.title} at ${job.company}\n\nDescription: ${job.description}\n\nResume: ${resume}\n\nThey said: ${prevAnswers.relevance}`
    })
  },
  {
    id: 'achievements',
    getPrompt: (job, resume, prevAnswers) => ({
      system: `You are Alicia, an expert resume tailoring assistant. Ask about quantifiable achievements for their relevant experiences. For each, suggest metrics ("How many users?", "What % improvement?"). Ask 2-3 questions. If no metrics, suggest impact alternatives.`,
      user: `Job: ${job.title}\n\nRelevant: ${prevAnswers.relevance}\nSkills: ${prevAnswers.skills_gap}\n\nResume: ${resume}`
    })
  },
  {
    id: 'generate',
    getPrompt: (job, resume, prevAnswers) => ({
      system: `You are Alicia. Generate specific, actionable resume tailoring. Format as:\n1. **Summary** - tailored statement\n2. **Experience Bullets** - rewritten for this job\n3. **Skills** - prioritized list\n4. **Keywords** - ATS-friendly terms\n\nGive actual text, not generic advice.`,
      user: `Job: ${job.title} at ${job.company}\n\nDescription: ${job.description}\n\nResume: ${resume}\n\nRelevant: ${prevAnswers.relevance}\nSkills: ${prevAnswers.skills_gap}\nMetrics: ${prevAnswers.achievements}`
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
      clearTailoringOptions();
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

  const step = TAILORING_STEPS[tailoringState.step];

  if (response === 'Start over') {
    await startTailoring();
    return;
  }

  if (response === 'Adjust suggestions') {
    tailoringState.step = 2;
    addTailoringMessage("What would you like to adjust? Tell me what to change.", 'ai');
    return;
  }

  if (step) tailoringState.answers[step.id] = response;
  tailoringState.step++;

  if (tailoringState.step < TAILORING_STEPS.length) {
    await runTailoringStep();
  } else {
    await runTailoringStep();
  }
}

tailorBtn.addEventListener('click', () => {
  if (!currentJob || !resumeText) return;
  startTailoring();
});

tailoringSend.addEventListener('click', () => {
  const val = tailoringInput.value.trim();
  if (val) {
    tailoringInput.value = '';
    handleTailoringResponse(val);
  }
});

tailoringInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = tailoringInput.value.trim();
    if (val) {
      tailoringInput.value = '';
      handleTailoringResponse(val);
    }
  }
});

closeTailoring.addEventListener('click', () => {
  tailoringSection.classList.add('hidden');
  tailoringState = null;
});

function addChatMessage(text, role) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  if (role === 'ai') {
    div.innerHTML = formatAnalysis(text);
  } else {
    div.textContent = text;
  }
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
    if (chatHistory.length > 20) {
      chatHistory = chatHistory.slice(-16);
    }
  } catch (err) {
    chatMessages.lastElementChild.remove();
    addChatMessage(`Error: ${err.message}`, 'ai');
  }
}

function buildChatSystemMessage() {
  let msg = 'You are Alicia, a friendly AI job search assistant. Help with job searching, resume writing, interview prep, and career advice. Be concise and actionable.';
  if (currentJob) {
    msg += `\n\nCurrent job: ${currentJob.title} at ${currentJob.company} (${currentJob.location}). Description: ${currentJob.description?.substring(0, 300)}`;
  }
  if (resumeText) {
    msg += `\n\nResume: ${resumeText.substring(0, 800)}`;
  }
  return msg;
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});