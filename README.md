# Alicia AI - Job Assistant

An AI-powered Chrome extension (side panel) for job searching on LinkedIn and applying on
almost any site — LinkedIn Easy Apply, Workday, Greenhouse, Lever, iCIMS, Ashby, Workable, and
custom company portals. Free to use: every AI feature runs on a free backend, no API key
required.

## Features

**Job search & fit**
- Detects the job you're viewing on LinkedIn automatically.
- **Scan & Rank These Jobs** — scores every job on a LinkedIn search results page against your
  resume, best fit first.
- **Match Score overlay** — shows a live fit-score badge right on the LinkedIn job page itself
  (score, matched keywords, missing keywords) as soon as a job is detected.
- **Find People to Reach Out To** — surfaces the hiring team on a job posting with a drafted,
  editable outreach note (LinkedIn's 300-character connection-note limit enforced in code).

**Resume tools**
- Upload or paste a resume (PDF/DOCX/plain text, parsed locally — no external service).
- **Build a Resume from Scratch** — guided Q&A that generates a full resume for candidates who
  don't have one yet.
- **Tailor Resume** — interactive Quick Tailor or Deep Dive resume tailoring for a specific job.
- **Match Score** tool — % fit plus matched/missing keywords for the current job.
- **Analyze Job** and **Cover Letter** generation.

**Application auto-fill**
- Save your contact info and EEO/demographic answers once; Alicia reuses them everywhere.
- **LinkedIn Easy Apply**: fills every step automatically and auto-advances through Next/
  Continue/Review — stopping the instant a Submit button appears. A human always clicks Submit.
- **Any other site** (Workday, Greenhouse, Lever, etc.): click **Auto-Fill Open Application** and
  it fills the page, and if the site is a multi-step wizard it keeps advancing through it the
  same way, stopping before the final submit/create-account action.
- **Account creation**: if a site requires creating an account, Alicia generates a unique,
  strong password per site (never reused across sites) and saves it under **Site Passwords** in
  the side panel so you can log back in later.
- **Custom application questions** ("years of experience with X", "why this role",
  availability, etc.) are answered automatically on LinkedIn — first checked against a
  **Learned Answers** bank of questions you've confirmed before, then a single AI call for
  anything new. AI-answered questions pause auto-advance so you can review/edit before the click
  that confirms and saves the answer.

**Interview prep & chat**
- Interview question generation, company research, STAR-method answer building, and a mock
  interview practice mode.
- **Chat with Alicia** — a persistent AI assistant in Job Coach or General mode, with saved chat
  history.

## Safety principles

- **Never auto-submits anything.** Applications, account creations, and connection requests
  always end with a human click — Alicia fills and advances, you decide when it's final.
- **Never guesses EEO/demographic answers.** Those only ever come from what you explicitly
  saved; if you haven't set one, it's left blank rather than answered by AI.
- Custom-question answers are reviewable before they're saved to the Learned Answers bank —
  learning is based on what you confirmed, not the raw AI guess.
- Autofill button/field matching is allowlist-based throughout: an unrecognized label or button
  is left alone rather than acted on.

## Setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the side panel (click the extension icon) and upload or paste a resume.
3. Fill in your contact info and EEO/demographic preferences under **Application Auto-Fill**.
4. Browse LinkedIn jobs, or open any application page and click **Auto-Fill Open Application**.

After pulling changes or reloading the extension, refresh any LinkedIn tabs that were already
open — the content script in an already-open tab doesn't update until the page reloads.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 config — permissions, content script scope, side panel |
| `background.js` | Service worker: relays messages between the side panel and the active tab |
| `content.js` | Runs on linkedin.com: job detection, job/people scraping, Easy Apply auto-fill + auto-advance + custom-question AI answering, Match Score overlay |
| `sidepanel.html` / `sidepanel.js` | The side panel UI and all its logic — resume tools, chat, tracker, universal (non-LinkedIn) auto-fill, Learned Answers, Site Passwords |
| `parsers.js` | Self-contained PDF/DOCX text extraction (no external libraries) |
| `resume-preview.html` / `resume-preview.js` | Print-to-PDF preview for generated/tailored resumes |
| `styles.css` | Theming (4 themes) for the side panel |

All AI features call a shared free backend (Wagner-GPT's `/api/chat`) — no per-user API key.
