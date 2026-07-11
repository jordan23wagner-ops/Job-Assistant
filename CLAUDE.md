# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Alicia AI" — a Manifest V3 Chrome side-panel extension for LinkedIn job search + fit scoring, and
for auto-filling job applications on almost any site (LinkedIn Easy Apply, Workday, Greenhouse,
Lever, iCIMS, Ashby, SmartRecruiters, Taleo, BrassRing, ADP, and generic company career portals). It
never clicks the final Submit/Apply — a human always does that. All AI features are free (routed to
two separate free backends, see "Backend split" below); there is no bundler, no `package.json`, and
no npm dependencies — every file is loaded by Chrome as-is via "Load unpacked".

General job search, the résumé bank, and the application tracker are being migrated into the sister
project **Wagner-GPT** (`github.com/jordan23wagner-ops/Wagner-GPT`, live at wagner-gpt.vercel.app) as
a "Jobs" tab. This extension keeps what a web page fundamentally cannot do: **on-page application
autofill**. `bridge.js` is the handoff between the two — see "Web-app apply handoff" below.

## Commands

There is no build step, package manager, linter, or test runner — this is intentional (a zero-dependency,
directly-loaded MV3 extension). Development loop:

- **Load/reload:** `chrome://extensions` → Developer mode → Load unpacked → this folder. After any
  edit, reload the extension there, then refresh any already-open LinkedIn tabs (an already-injected
  content script does not pick up changes until the page reloads).
- **Syntax check before reloading:** `node --check background.js` (swap in the file you touched —
  `content.js`, `autofill.js`, `detect.js`, `bridge.js`, `sidepanel.js`, `account.js`, etc.). This is
  the fastest way to catch a typo before burning a manual reload-and-click cycle.
- **Verification split** (important — don't claim more than you can actually check):
  - An agent (no browser) CAN verify: syntax (`node --check`), pure logic in isolation (mock
    `chrome.*` and DOM globals, then `node -e` against the extracted function), and AI prompt
    behavior directly against the live backend (`curl` the `/api/chat` endpoint the file targets).
  - An agent CANNOT verify: real LinkedIn scraping/autofill, or autofill on any third-party ATS —
    these require the user's actual logged-in session and DOM, and must be live-tested by the user.
    When a fix touches `content.js`/`autofill.js`/`detect.js`, say plainly that it's untested live
    rather than implying it's confirmed working.
  - Established pattern for a bug that can't be reproduced without the user: add temporary, clearly
    labeled `console.log` diagnostics at each step of the suspect flow (e.g. `[Alicia][apply-debug]`),
    ship a version bump, and have the user paste back the console output from the relevant context —
    the **service worker** console (`chrome://extensions` → this extension → "service worker" →
    Inspect) for anything in `background.js`, and the **page's own DevTools console** for anything
    injected into a tab (`content.js`/`autofill.js`/`detect.js`). Remove the diagnostic once the bug
    is closed.
- **Version bump:** `manifest.json`'s `version` field is bumped on essentially every change (see
  `HANDOFF.md`'s history) — treat it as part of "did I finish this change," not optional.

## Architecture

### File map

| File | Role |
|---|---|
| `manifest.json` | MV3 config: permissions, content-script scope, side panel entry |
| `background.js` | Service worker — the hub. LinkedIn content-script self-healing/force-injection, external-ATS autofill session lifecycle (start/re-inject/expire), auto-detect "offer to autofill" injection on known ATS hosts, aggregator/Adzuna interstitial skip-through, the web-app apply handoff (`WEBAPP_APPLY`/`WEBAPP_SYNC`), Easy Apply Queue orchestration |
| `content.js` | Injected into every `linkedin.com` frame (`all_frames: true`). Job detection, Match Score overlay, Scan & Rank, People/outreach scraping, Easy Apply autofill + auto-advance + custom-question AI answering |
| `autofill.js` | Self-contained fill engine injected by `background.js` into non-LinkedIn ATS pages (and recognized cross-origin/same-tab child frames). Detector→adapter architecture (see below), multi-step advance, account creation, résumé file attach, learned-answer bank, one batched AI call for unanswered custom questions |
| `detect.js` | Tiny script injected only on known-ATS hosts (`ATS_HOST_RE`) with no active session — floats an "⚡ Auto-fill this application?" offer if the page looks like a form |
| `bridge.js` | Content script scoped to the Wagner-GPT origin (+ localhost). Announces the extension to the web app and relays its apply/sync requests into `background.js` — see "Web-app apply handoff" |
| `sidepanel.html` / `sidepanel.js` | The side panel UI/logic: résumé tools, LinkedIn-specific job search + Scan & Rank, tracker, universal autofill button, Learned Answers, Site Passwords, chat, interview prep. The old standalone `jobsearch.html`/`.js` full-page search tab has been removed — general multi-source search now lives in Wagner-GPT's Jobs tab (the panel's "Search Jobs in Wagner-GPT" button just opens `wagner-gpt.vercel.app/?tab=jobs`) |
| `account.js` | Alicia account: Supabase email-OTP auth (plain REST, no SDK) against a shared Supabase project, for a higher daily AI allowance / Alicia Pro. Signed-out users keep working on the anonymous tier |
| `parsers.js` | Self-contained PDF/DOCX text extraction (pure-JS inflate, zero external libraries) |
| `resume-preview.html` / `resume-preview.js` | Print-to-PDF preview for generated/tailored résumés |
| `styles.css` | Side panel theming (4 themes via CSS variables) |

### Backend split — two separate free backends, don't conflate them

| Endpoint | Backend | Used by |
|---|---|---|
| `/api/chat` | `chatwillow.com` | Side panel: match score, tailor, cover letter, chat, interview prep |
| `/api/chat` | `wagner-gpt.vercel.app` | The web-app apply handoff (résumé tailoring/ranking done in the Jobs tab) |
| `/api/jobs` | `wagner-gpt.vercel.app` | Multi-source job search (now entirely in the Jobs tab, not in this repo) |

Both are $0/month, no persistent server of their own. If a change to AI behavior isn't showing up,
check which backend the specific code path actually calls before assuming the prompt is wrong.

### External-ATS autofill session lifecycle (the trickiest part of this codebase)

`background.js` tracks one autofill session per tab in `chrome.storage.local.autofillSessions`,
keyed by `tabId`, because a real page navigation kills whatever was injected into it:

- **Auto-detect sessions** (user manually visits a known ATS host): scoped to `ATS_HOST_RE` (a fixed
  allowlist — Workday, Greenhouse, Lever, iCIMS, Ashby, SmartRecruiters, Taleo, BrassRing, ADP, etc.)
  or same-site navigation only. `detect.js` offers first; accepting starts the session.
- **Explicit sessions** (user clicked "Auto-Fill Open Application" in the panel, the Easy Apply
  Queue, or an apply came from the web-app handoff): NOT gated by `ATS_HOST_RE` — they follow the tab
  through redirect chains and aggregator interstitials to wherever the real application form is,
  bounded by `EXPLICIT_SESSION_MAX_NAVS` (10 navigations) and `ATS_SESSION_TTL_MS` (20 minutes).
- Re-injection on a **full page navigation** happens via `chrome.tabs.onUpdated` ('complete'); on a
  **client-side SPA route change** (`history.pushState`/`replaceState`, no full reload — common on
  Workday, Zoho Recruit, and modern custom career sites) it instead requires
  `chrome.webNavigation.onHistoryStateUpdated`, since `onUpdated` never fires for those.
- `autofill.js` itself has a run-once guard (`window.__aliciaAutofillRun`) so re-injection into a
  still-alive SPA document is a safe no-op that just re-invokes the existing run function — it resets
  its own per-page state (nav-handled flag, shown panels) by comparing `location.href` on every call,
  not by relying on a fresh script load.
- A details/listing page with no form yet but an "Apply"-style button is handled inside `autofill.js`
  itself (`advanceToApplicationForm()`/`findApplyStartButton()`, allowlisted patterns) — it tries to
  click through to the real form before giving up, rather than silently doing nothing.

### `autofill.js`'s detector→adapter architecture

`detectATS()` identifies the platform from the page; `ADAPTERS[name]` supplies optional hooks
(`fillDropdowns`, `findDropdownQuestions`, `blockingWall`, `advancePatterns`, `stopPatterns`,
`fillTypeaheads`, an account-gate handler, ...) layered on top of the generic engine — an unset hook
just falls back to the generic behavior. Add a new ATS by adding a new adapter entry, not by
branching deep inside the generic fill logic.

### Web-app apply handoff (`bridge.js` ↔ `background.js` ↔ Wagner-GPT)

The **web app** opens each posting's tab itself (a real user gesture, so it isn't popup-blocked);
this extension only **registers** those URLs (`WEBAPP_APPLY` → `pendingApplyUrls`, matched to the
tab's first navigation in `onBeforeNavigate`) and then treats that tab as an explicit session. A
separate `WEBAPP_SYNC` message pushes the web app's active/tailored résumé and contact profile into
extension storage — Wagner-GPT is the source of truth for those, not the extension's own résumé bank,
when the two overlap. Fill-status results are forwarded back to any open Wagner-GPT tab
(`UNIVERSAL_FILL_RESULT` → `ALICIA_STATUS`/`FILL_STATUS`) so its tracker reflects live state.

### Safety principles (enforced in code, not just documentation)

- Never auto-submits — every fill engine stops the instant a Submit/Apply/Create-Account button is
  the next action; a human always clicks it.
- Never guesses EEO/demographic or custom-question answers — only fills what the user explicitly
  saved or confirmed; anything unknown is left blank or routed to the learned-answer bank / a single
  AI call, with AI answers paused for human review before being banked.
- Advance/stop button matching is allowlist-only (`ADVANCE_PATTERNS`/`STOP_PATTERNS`) — an
  unrecognized label is left alone rather than guessed at.
- The auto-detect offer (`detect.js`) only ever fires on `ATS_HOST_RE` hosts — never on an arbitrary
  site the user happens to be browsing.

## Other docs in this repo

- `HANDOFF.md` — the rolling, version-by-version engineering log. Read the top (most recent) entries
  before starting work; it captures live-repro findings, root causes, and what's still open far more
  precisely than this file does. Prepend new entries here rather than only relying on commit messages.
- `NEXT-STEPS.md` — an early-session planning doc (references v1.8.5); superseded by `HANDOFF.md` for
  current state. Treat it as historical context, not a current source of truth.
- `PRIVACY.md` — the extension's privacy policy.
