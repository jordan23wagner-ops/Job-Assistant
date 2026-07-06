# Job-Assistant ("Alicia AI") — Handoff for the next session

Read this top-to-bottom before writing code. It captures where the extension is **now** (so you
don't re-derive it or repeat solved mistakes) and specs the **next three features** Jordon wants.

- **Repo:** https://github.com/jordan23wagner-ops/Job-Assistant
- **Canonical local folder (LOAD THIS ONE):** `C:\Users\Jordon\Job-Assistant`
- **Current version:** v1.8.2 (in `manifest.json` and the side-panel header)
- Also read `HANDOFF.md` in this repo for the full version-by-version history.

---

## What this is

A Manifest V3 Chrome extension (side panel) that helps Jordon's wife Alicia run a LinkedIn-centered
job search and **auto-fill job applications** the way Jobright does: it fills every field it can,
advances through multi-step forms, learns answers it hasn't seen, and **stops at the final Submit —
a human always clicks Submit.** All AI is free (no API key): it routes to the Wagner-GPT backend.

Focus is **LinkedIn Easy Apply** right now; external ATS (Workday/Greenhouse/Lever/etc.) is also
supported via a separate injected engine.

---

## File map

```
manifest.json   MV3. content_scripts matches *://*.linkedin.com/* with "all_frames": true.
                perms: sidePanel, activeTab, storage, tabs, scripting, webNavigation; host <all_urls>.
background.js   Service worker. FORCE-injects content.js into LinkedIn frames on navigation +
                on extension (re)load (manifest injection alone misses pre-existing/orphaned frames).
                Also manages external-ATS sessions: injects autofill.js, re-injects across page
                navigations for 20 min per tab, and injects it into cross-origin ATS iframes.
content.js      Runs in EVERY linkedin.com frame. Job detection, the match-score badge, job-list &
                hiring-team scraping, and the Easy Apply autofill/auto-advance/learning engine.
autofill.js     Standalone engine injected into NON-LinkedIn ATS pages (and cross-origin iframes).
                Contact/EEO/custom-question fill, resume file attach, per-site account passwords,
                multi-step advance. Never clicks the final Submit/Apply. Since v1.8.0 it's a
                detector->adapter architecture: detectATS() -> ADAPTERS[workday|greenhouse|lever|
                generic]; empty adapter == old generic behavior. Adapter hooks (all optional):
                fillDropdowns, fillTypeaheads, findDropdownQuestions, blockingWall, advancePatterns,
                stopPatterns. Workday adapter = prompt-option dropdowns via one wdPickOption
                primitive (enumerated + searchable type-to-search; EEO/State/Country + non-EEO
                questions through the AI answer flow) + account-gate auto-create + email-verify wall;
                Greenhouse/Lever adapter = location typeahead pick.
detect.js       (v1.8.0) Tiny offer script. background.js injects it on known-ATS hosts (ATS_HOST_RE)
                with no active session; floats "Auto-fill this application?". Accept -> background
                starts the same autofillSessions flow as the manual button. Never fills/submits itself.
sidepanel.html  The whole UI. 5 tabs: Apply / Search / Tracker / Tools / Chat.
sidepanel.js    All side-panel logic: backend seam (rawBackendCall), Scan&Rank, People+outreach,
                resume parse/store, tailor/build resume, interview prep, tracker, learned-answer &
                site-password editors, profile/EEO storage, chat.
parsers.js      Self-contained PDF + DOCX text extraction (pure JS, no libs).
styles.css      Themed (4 themes via CSS vars) + tab bar.
```

---

## Architecture facts you MUST know (these were each hard-won — don't relearn them)

1. **The Easy Apply modal lives in a SHADOW DOM**, host `<div id="interop-outlet">`. Shadow trees
   are invisible to `document.querySelector`, which is why early versions "did nothing." All modal
   lookups go through `easyApplySearchRoots()` = `[document].concat(collectShadowRoots())`, then
   query the modal element (works within the shadow tree). `ownerRoot(el)` resolves `label[for]`
   inside the element's shadow root. **If Easy Apply ever breaks again, the first move is a
   shadow+iframe-piercing console DOM dump — the form is NOT in the light DOM.**

2. **Shadow-DOM mutations are invisible to a light-DOM MutationObserver**, so there's a **1.2s poll**
   (`setInterval`) that drives detection/fill; the MutationObserver is a secondary trigger.

3. **content.js runs in ALL frames** (`all_frames:true`) and is wrapped in a run-once-per-frame IIFE
   guard (`window.__aliciaContentLoaded`). `IS_TOP` gates page-level features (job detection, match
   badge, scraping, DETECT_JOB/SCAN_* messages) to the top frame so subframes don't clobber results.
   background.js force-injects content.js because manifest registration never reaches frames created
   before an extension reload nor replaces orphaned copies (that caused endless "reload didn't work").

4. **The `linkedin.com/preload/?_bprMode=vanilla` iframe is a red herring** — it's a hidden full copy
   of the page chrome, NOT the apply form. Don't chase it.

5. **Never auto-click Submit/Apply/Create Account.** Advance is an allowlist
   (`EASY_APPLY_ADVANCE_PATTERNS`); stop patterns (`EASY_APPLY_SUBMIT_PATTERNS`) are never clicked.
   On the final step the tool scrolls the Submit button into view (via `revealWithinContainer`,
   which scrolls ONLY the modal's internal container, never the page).

6. **Learn-from-human loop:** on each step the tool fills what it can (learned bank → then one
   batched AI call). Anything it still can't answer PAUSES auto-advance
   (`pendingReviewModal`) with a banner; the human fills it and the answer is banked on the advance
   click (`attachAnswerCapture` → `bankAllCustomAnswers`, which banks the final value of EVERY custom
   question/dropdown, not just AI-answered ones). If learned+AI covered everything, it does NOT
   pause — it keeps auto-advancing. Resume/cover-letter selection is deliberately left to the user
   (`isResumeOrDocControl`); hidden/conditional questions are skipped (no client rects).

7. **Post-submit:** `isPostSubmitConfirmation()` detects the "application sent" / follow-company end
   screen and makes `findEasyApplyModal` return null, so the tool goes quiet until a new application.

8. **Match badge:** scored via the backend against the saved resume; shows inline on its own line
   right below the job title (`titleBlockContainer` normalizes the anchor to the block-level title
   element) or, if no anchor, floats in the shared bottom-right stack (`aliciaStack()`). Details are
   a **hover tooltip** (`showMatchDetails`/`hideMatchDetails`). All floating UI (review banner,
   floating badge, details) live in `#alicia-stack` (a flex column) so they never overlap.

9. **Backend seam:** `https://wagner-gpt.vercel.app/api/chat`, NDJSON delta stream
   (`{"delta":"..."}\n … {"done":true}\n`). Client is `fetchBackendText()` in content.js/autofill.js
   and `rawBackendCall()` in sidepanel.js. Post `{messages:[{role:'system',content}], newMessage, model:'auto'}`.

10. **External ATS = detector→adapter (v1.8.0), generic is the fallback.** `autofill.js` resolves
    `adapter = ADAPTERS[detectATS()]` once per run. **An empty adapter is byte-for-byte the old
    generic engine** — so adding/editing an adapter can't regress unknown sites. To support a new
    ATS: add a `detectATS()` signature + an adapter object with only the hooks that differ
    (`fillDropdowns`/`fillTypeaheads`/`blockingWall`/`advancePatterns`/`stopPatterns`). Workday's
    dropdowns are portaled `[data-automation-id="promptOption"]` lists (NOT `<select>`/`role=option`);
    its Create Account is auto-clicked (advance) but the final Submit never is; its verify-email screen
    is a `blockingWall`. The **auto-detect offer** (`detect.js`, injected by background on `ATS_HOST_RE`
    hosts) is the new hands-off entry point; the side-panel "Auto-Fill Open Application" button still
    works and both converge on the same `autofillSessions` flow. Selectors for live ATS DOM are
    best-effort — when a dropdown/typeahead doesn't fill, dump candidate selectors in the ATS tab
    console and tighten (same upkeep pattern as the LinkedIn scrapers).

### chrome.storage.local keys in use
`resumeText`, `resumeFile` ({name,type,b64}), `profile`, `eeoPrefs`, `customQA` (learned answers),
`siteCredentials`, `trackedJobs`, `searchPrefs`, `autoAdvanceEasyApply`, `activeTab`, `usage`,
`isPremium`, `chatSessions`, `liveChat`, `autofillSessions`.

---

## How to develop / verify

1. **Load:** `chrome://extensions` → Developer mode → Load unpacked → `C:\Users\Jordon\Job-Assistant`.
   After a manifest change, reload the extension (content.js is force-injected, so no tab refresh
   needed — but a manifest permission change may prompt the user to accept).
2. **Syntax:** `node --check content.js` (and background/autofill/sidepanel) before every commit.
3. **Browser harness (how this project has been verified):** build a small static HTML page that
   mirrors the real DOM structure — e.g. the Easy Apply modal inside a `#interop-outlet` shadow root
   with the LinkedIn form classes — plus a `chrome.*` shim (storage/runtime stub) and a stubbed
   `fetch` for the backend. Serve it (http-server) and drive it with the preview tools. This is how
   shadow-DOM fill, learn-from-human, resume-step-skip, post-submit-stop, the notification stack, and
   the match tooltip were all verified without a live LinkedIn session.
4. **What only Jordon can verify:** live LinkedIn / Workday behavior against his logged-in session.
   Agent browser tools are read-only on LinkedIn and can't use his session. Ship, then he load-tests.
5. **Commit flow:** the harness blocks committing on `main`, so: `git checkout -b <branch>` → commit →
   `git checkout main` → `git merge --ff-only <branch>` → `git push origin main`. End commit messages
   with the `Co-Authored-By: Claude <noreply@anthropic.com>` line. Bump the version in `manifest.json`
   AND the `sidepanel.html` header on each user-visible change.

---

## NEXT — three features Jordon wants (in priority order)

### 1. Easy Apply queue (batch apply)

**Goal:** On a LinkedIn jobs **search results** page with filters set, collect ALL Easy Apply jobs
into a queue. The tool opens job #1, fills it, **stops at Submit → user clicks Submit**, then the
tool automatically pulls up the next job in the queue and repeats until the queue is done.

**Design notes / how to build it:**
- **Collect:** `content.js` already has `scrapeJobList()` (reads visible search-result cards with
  robust fallbacks). Extend it to (a) filter to Easy Apply cards only, and (b) collect across the
  list by auto-scrolling the results pane / paging (LinkedIn lazy-loads ~25 at a time). Respect the
  filters already in the URL — don't re-filter; just harvest what LinkedIn shows for the current
  search. Store as `applyQueue: [{jobId, title, company, url, status:'pending'|'done'|'skipped'}]`.
- **Queue UI:** a new section (Apply tab, or a small "Queue" area) listing the jobs with counts
  (e.g. "3 of 18 done"), a Start/Pause button, and per-item status. Persist `applyQueue` +
  `queueActive` + `queueIndex` in `chrome.storage.local` so it survives navigations.
- **Drive it (background.js orchestrates, since navigation kills content.js):** on Start, set
  `queueActive`, `chrome.tabs.update(tabId,{url: job.url})` to open job #1. When content.js loads on
  that job page and the queue is active, it clicks the **"Easy Apply" button** to open the modal
  (this is the one new auto-click — see ToS note), then the existing autofill/auto-advance runs and
  stops at Submit as today. When the human clicks Submit, `isPostSubmitConfirmation()` fires — treat
  that as the signal to mark the item `done` and advance: message background → it opens the next
  `pending` job. If a step needs human input (pause banner) or the job turns out to be a non-Easy
  Apply / external ATS, mark it `skipped` (or leave paused) and let the user decide.
- **⚠️ ToS / account-safety (get Jordon's call, and build conservatively):** auto-clicking the
  "Easy Apply" button and auto-navigating between jobs in a loop is more aggressive than everything
  built so far. To protect Alicia's real account: **pace it** (randomized human-like delays, e.g.
  4–10s between actions), **cap per session** (e.g. 15–25 apps then stop with a "take a break"
  message), keep the **never-auto-submit** rule, and make the queue **pausable/stoppable at any
  time**. Still no aggressive scraping. Consider making auto-click-Easy-Apply a setting that's on by
  default but visible. Present the pacing/cap numbers to Jordon before finalizing.
- **Edge cases to handle:** job already applied (LinkedIn shows "Applied" — skip), Easy Apply button
  missing (external apply → skip or hand off to autofill.js), modal fails to open (retry once then
  skip), user navigates away mid-queue (pause), duplicate jobIds.

### 2. "Tailor / update resume for this job" from the match badge

**Goal:** From the match badge's hover panel, let Alicia tailor or update her resume to the specific
job (uses the matched/missing keywords the badge already computes).

**Design notes:**
- The badge + tooltip live in `content.js` (page context); the resume tailoring logic lives in
  `sidepanel.js` (`startTailoring`, `runQuickTailor`, `runDeepDive`, `generateTailoredResume`,
  and `startBuilder`). Add a button in the tooltip panel — e.g. "✨ Tailor my resume for this job".
- Clicking it should hand the current job (title/company/description, already in `lastDetectedJob`)
  and the badge's `missing` keywords to the side panel's tailor flow. Simplest wiring: content.js
  sends a `runtime.sendMessage({type:'TAILOR_FOR_JOB', job, missing})`; sidepanel.js listens, opens
  the Tools tab / tailoring section, pre-loads the job, and runs the tailor. (The side panel must be
  open; if you can't guarantee it, store a `pendingTailorJob` in storage and pick it up on open.)
- Output should feed feature #3: the tailored resume becomes a new **Saved Resume** (named e.g.
  "Resume — <Company> <Title>") that the user can review, edit, set active, and download.
- Keep it truthful: the existing tailor prompts must not invent experience — only re-emphasize what's
  in the base resume toward the missing keywords. Preserve that guardrail.

### 3. Saved Resumes section

**Goal:** Support multiple saved resumes (base + tailored variants) instead of the single
`resumeText`/`resumeFile`. Pick which one is "active" (used for match scoring, autofill, and ATS
file upload).

**Design notes:**
- **Data model:** `savedResumes: [{ id, name, text, file:{name,type,b64}|null, createdAt,
  tailoredForJob?:{title,company}, isActive }]`. Keep `resumeText`/`resumeFile` working as a
  computed "active resume" shim during migration so nothing else breaks, or migrate all readers.
  Readers to update: match scoring (`callMatchBackend` reads `resumeText`), external ATS file attach
  (`autofill.js` reads `resumeFile`), all the AI tools in sidepanel.js.
- **UI:** a "Saved Resumes" section (Tools tab is the natural home). List each with name, source
  (uploaded / tailored-for-X), active toggle (radio — exactly one active), View, Rename, Delete, and
  an "Upload new" / "Build new" entry. On upload, reuse the existing parse (`extractResumeText`) +
  base64 store.
- **Recommended limits:** **max 10 saved resumes, each file ≤ 2 MB** (2 MB matches LinkedIn's own
  resume upload cap). Rationale: `chrome.storage.local` default quota is ~10 MB; 10 × 2 MB of base64
  (base64 is ~1.33× the raw bytes) is at the edge, so **add the `"unlimitedStorage"` permission** in
  manifest.json to be safe, and still cap the count at 10 to keep the UI sane and storage bounded.
  Enforce both limits in code with a clear message when exceeded. (If Jordon wants more, unlimited
  storage makes 15–20 feasible — but 10 is the sensible default.)
- **Interaction with the queue (feature 1):** the active resume is what gets used across the queue.
  A future nice-to-have (mention, don't build yet): auto-select the best-matching saved resume per
  job, or auto-tailor per job before applying — but that's aggressive; start with a single active
  resume for the whole queue.

---

## Guardrails to preserve across all three features
- Never auto-submit / auto-apply / auto-create-account. Human clicks the final button.
- Keep everything truthful (no invented experience in tailored resumes or AI answers).
- Protect Alicia's real LinkedIn account: human-in-the-loop, paced actions, session caps, no
  aggressive scraping.
- $0/month: all AI stays on the free Wagner-GPT backend.
- Verify with a DOM-mirroring browser harness before shipping; Jordon load-tests live LinkedIn.
