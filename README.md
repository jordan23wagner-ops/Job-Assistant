# Alicia AI - Job Assistant

An AI-powered Chrome extension (side panel) for job searching on LinkedIn and applying on
almost any site — LinkedIn Easy Apply, Workday, Greenhouse, Lever, iCIMS, Ashby,
SmartRecruiters, Taleo, BrassRing, Workable, and custom company portals. Free to use: every
AI feature runs on a free backend, no API key required.

> **Now also in the Wagner-GPT web app.** Job search, the résumé bank, and the application tracker
> are being folded into [Wagner-GPT](https://wagner-gpt.vercel.app) as a **Jobs** tab so everything
> lives in one place. The web app's search additionally pulls jobs directly from company career
> boards (Greenhouse/Lever/Ashby/Workable) in your chosen industry, ranked by résumé fit. This
> extension remains for what a web page can't do: **on-page application autofill** (LinkedIn Easy
> Apply + external ATS). See the Wagner-GPT repo's "Jobs" section.

---

## Features

### Job Search (full-page tab)

- **Search Jobs by Title & Industry** — opens a full-page search tab backed by the Adzuna
  jobs API. Filter by title, industry, location, salary minimum, country, remote-only, and
  full-time. Results are ranked by résumé fit (AI-scored when a résumé is saved, lexical
  fallback otherwise), best first.
- **8 curated industries** (Software/IT, Cybersecurity, AI/ML, Oil & Gas, Healthcare Tech,
  Manufacturing, Engineering, Any) with smart Adzuna category mapping — never hardcodes tags,
  always resolves against live categories.
- **⚡ auto-fill ready** badge on cards whose posting URL is a known ATS host.
- **Apply** opens the posting in a new tab and automatically starts the autofill session —
  no side-panel button click needed. The job is also saved to the Tracker as "Applied".
- **✏ Tailor résumé** — opens a modal with a multi-turn AI conversation (see _Resume tools_
  below).

### Job search & fit (LinkedIn)

- Detects the job you're viewing on LinkedIn automatically.
- **Scan & Rank These Jobs** — scores every job on a LinkedIn search results page against your
  résumé, best fit first.
- **Match Score overlay** — live fit-score badge on the LinkedIn job page itself (score,
  matched keywords, missing keywords).
- **Find People to Reach Out To** — surfaces the hiring team with a drafted, editable outreach
  note (LinkedIn's 300-character limit enforced in code).

### Resume tools

- Upload or paste a résumé (PDF/DOCX/plain text, parsed locally — no external service).
- **Build a Resume from Scratch** — guided Q&A that generates a full résumé for candidates who
  don't have one yet.
- **Tailor Resume** — two modes available:
  - *From the side panel* — Quick Tailor or Deep Dive for the currently detected LinkedIn job.
  - *From the Job Search tab* — click **✏ Tailor résumé** on any job card. A modal opens where
    Alicia reviews the job description vs. your résumé and asks one targeted question at a time
    about your real experience (gaps, relevant skills not clearly shown). After 3–5 rounds (or
    say "generate"), it outputs the full tailored résumé. **Save as active résumé** stores it
    in your résumé bank and sets it as the active résumé for future autofill — Alicia never
    invents experience; only adds what you explicitly confirm.
- **Match Score** — % fit plus matched/missing keywords.
- **Analyze Job** and **Cover Letter** generation.

### Application auto-fill

- Save contact info and EEO/demographic answers once; Alicia reuses them everywhere.
- **LinkedIn Easy Apply**: fills every step and auto-advances through Next/Continue/Review —
  stopping the instant a Submit button appears. A human always clicks Submit.
- **External ATS auto-detect**: on any known ATS page (Workday, Greenhouse, Lever, etc.) with
  an open application form, Alicia offers to auto-fill via a small floating prompt. Accept it
  and the session starts — same as the manual button.
- **Any other site**: click **Auto-Fill Open Application** in the side panel.
- **Full ATS adapter set** — each adapter handles that platform's specific quirks:

  | ATS | Notes |
  |---|---|
  | **Workday** | Standard fields, EEO dropdowns, searchable fields (Country/State/School), single-select and multi-select prompt questions (Skills, Languages, etc.), account gate (auto-creates account, generates a unique password), email-verification wall detection |
  | **Greenhouse** | Standard fields + location typeahead |
  | **Lever** | Standard fields + location typeahead |
  | **iCIMS** | Standard fields, account gate, verify-email wall |
  | **Ashby** | Standard fields + location typeahead |
  | **SmartRecruiters** | Standard fields + location typeahead |
  | **Taleo** | Standard fields + account gate (legacy multi-step flow) |
  | **BrassRing** | Standard fields + account gate (legacy multi-step flow) |
  | Generic | Everything else — contact fields, EEO selects/radios, custom questions |

- **Account creation**: if a site requires an account, Alicia auto-creates it with a unique
  strong password per site, saved under **Site Passwords** so you can log back in.
- **Custom application questions** are answered from the **Learned Answers** bank first, then
  by a single AI call for anything new. AI answers pause auto-advance for review; confirming
  saves the answer to the bank.
- Multi-step wizards (Workday, iCIMS, Taleo, etc.) auto-advance through each step — stopping
  before any Submit/Apply button. Navigations between steps re-inject the fill engine
  automatically via a 20-minute session tracked in the service worker.

### Apply Queue

- Add jobs to a queue; Alicia walks through them one by one, filling each application and
  waiting for your Submit click before moving to the next.
- Per-session cap of 20 applications and handles LinkedIn's daily limit gracefully (pauses the
  queue, keeps remaining jobs pending for next session).

### Interview prep & chat

- Interview question generation, company research, STAR-method answer building, and mock
  interview practice mode.
- **Chat with Alicia** — persistent AI assistant in Job Coach or General mode, with saved
  chat history.

---

## Safety principles

- **Never auto-submits anything.** Applications, account creations, and connection requests
  always end with a human click.
- **Never guesses EEO/demographic answers.** Only uses what you explicitly saved; missing
  answers are left blank.
- **Never invents résumé content.** Tailoring only incorporates experience you confirm.
- Custom-question answers are reviewable before being saved to the Learned Answers bank.
- Autofill matching is allowlist-based: unrecognized labels or buttons are left alone.
- Auto-detect offer is scoped to known ATS hostnames only — never fires on arbitrary sites.

---

## Setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the side panel (click the extension icon) and upload or paste a résumé.
3. Fill in contact info and EEO preferences under **Application Auto-Fill**.
4. Browse LinkedIn jobs, search via **🔎 Search Jobs by Title & Industry**, or open any
   application page and click **Auto-Fill Open Application**.

After pulling changes or reloading the extension, refresh any LinkedIn tabs that were already
open — the content script in an already-open tab doesn't update until the page reloads.

---

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 config — permissions, content script scope, side panel |
| `background.js` | Service worker: tab message relay, ATS autofill session management, auto-detect offer injection, LinkedIn content script self-healing, Easy Apply queue orchestration |
| `content.js` | Runs on linkedin.com: job detection, Scan & Rank, People scraping, Easy Apply auto-fill + auto-advance + custom-question AI answering, Match Score overlay, Apply Queue |
| `autofill.js` | Self-contained external-ATS fill engine: injected by background.js into any non-LinkedIn ATS page. Handles all adapters, multi-step advance, account creation, resume file attach, learned-answer bank, AI custom questions |
| `detect.js` | Tiny offer script injected on known ATS pages — checks for an application form and floats "⚡ Auto-fill this application?" |
| `bridge.js` | Content script on the Wagner-GPT web app origin. Announces the extension to the web app's **Jobs** tab and relays its "apply to these jobs" request to `background.js`, which opens each posting (paced) and starts the normal autofill session — stopping before Submit. |
| `jobsearch.html` / `jobsearch.js` | Full-page job search tab: Adzuna-backed search, industry/filter UI, résumé-fit ranking, Apply (auto-starts autofill + saves to Tracker), Tailor résumé modal |
| `sidepanel.html` / `sidepanel.js` | Side panel UI and logic — résumé tools, chat, tracker, universal auto-fill button, Learned Answers, Site Passwords |
| `parsers.js` | Self-contained PDF/DOCX text extraction (no external libraries) |
| `resume-preview.html` / `resume-preview.js` | Print-to-PDF preview for generated/tailored résumés |
| `styles.css` | Theming (4 themes) for the side panel |

### Backend split

| Endpoint | Backend | Purpose |
|---|---|---|
| `/api/chat` | [Wagner-GPT](https://wagner-gpt.vercel.app) | All AI calls from Job Search tab (fit ranking, résumé tailoring) |
| `/api/jobs` | [Wagner-GPT](https://wagner-gpt.vercel.app) | Adzuna jobs proxy — keeps API key server-side |
| `/api/chat` | [Chatwillow](https://chatwillow.com) | AI calls from the side panel (match score, tailor, cover letter, chat) |

Both backends are free-tier only — $0/month, no persistent server.
