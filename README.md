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

### Job Search

- **General multi-source search** now lives in [Wagner-GPT](https://wagner-gpt.vercel.app)'s
  **Jobs** tab — pulls postings directly from company career boards (Greenhouse/Lever/Ashby/
  Workable/etc.) across your chosen industry, ranked by résumé fit, with its own résumé bank
  and application tracker. The side panel's **Search Jobs in Wagner-GPT** button just opens it
  (`wagner-gpt.vercel.app/?tab=jobs`). The old standalone full-page search tab in this extension
  (`jobsearch.html`) has been removed — it was a duplicate of the same backend.
- **Apply**, wherever it's clicked from (the web app's Jobs tab, the Easy Apply Queue, or the
  side panel), opens the posting and automatically starts the autofill session — no separate
  autofill button click needed. The Wagner-GPT case is handled by `bridge.js` (see Architecture
  below).
- **Search LinkedIn Jobs** and **Scan & Rank These Jobs** remain in the side panel as
  LinkedIn-specific tools (see _Job search & fit (LinkedIn)_ below).

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
- **Tailor Resume** — *Interactive Resume Tailoring* in the side panel: Quick Tailor or Deep
  Dive for the currently detected LinkedIn job. Alicia reviews the job description vs. your
  résumé and asks one targeted question at a time about your real experience (gaps, relevant
  skills not clearly shown). After 3–5 rounds (or say "generate"), it outputs the full tailored
  résumé. **Save as active résumé** stores it in your résumé bank and sets it as the active
  résumé for future autofill — Alicia never invents experience; only adds what you explicitly
  confirm. (Tailoring for a job found via Wagner-GPT's Jobs tab — Quick tailor & apply / Deep
  rewrite & apply — happens there instead; Wagner-GPT is the source of truth for that résumé.)
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

## Testing

`npm install && npm test` runs an integration test suite against the REAL, unmodified
`autofill.js` — not a reimplementation of its logic. Every ATS-specific fix this project has
shipped (Databricks iframe stall, Workday nav-panel tie, LinkedIn ToS default, company-name
mangling, ...) was found by manually clicking through a real posting, not by a test, meaning a
future edit to the shared field-matching code could silently break a platform that used to work
with nothing catching it until the next live test happens to hit it. This closes that gap for the
platforms it covers.

**How it works** (`tests/harness.mjs`): loads a fixture HTML page into a `jsdom` window, mocks
`chrome.storage`/`chrome.runtime` in memory, `eval()`s the real `autofill.js` source into that
window (it's a plain content-script IIFE with no build step or exports — `window.eval` is the
only way to run it unmodified), and waits for the `UNIVERSAL_FILL_RESULT` message the real code
sends via `chrome.runtime.sendMessage` — the same message `background.js` listens for in
production — rather than reaching into internal functions.

**Fixtures** (`tests/fixtures/*.html`) are hand-composed but modeled on REAL field structure
captured live from real postings (Cloudflare on Greenhouse, Palantir on Lever, Axiom Space + NVIDIA
on Workday, Linear on Ashby, Visa on SmartRecruiters, Seeq on Workable, Freeday on Recruitee) — real
`id`/`name`/`autocomplete`/`aria-label`/`data-automation-id`/`data-ui`/class attributes and label
associations, not synthetic markup that might not match real-world quirks. Coverage today is seven
platforms with genuinely different field-matching shapes (Greenhouse: separate first/last name
fields, id-based `<label for>`; Lever: one combined name field matched by its `name` attribute, no
real `<label>` tag at all; Workday: everything keyed off `data-automation-id`, since its own
`id`/`label[for]` are randomly generated per session and carry no semantic meaning; Ashby: system
fields use a semantic id, but custom questions get a random UUID id/name with only a real `<label>`
carrying any signal; SmartRecruiters: every field lives inside its own Web Component shadow root,
none of it reachable via a plain `document.querySelectorAll`; Workable: id/name present, but the
visible label is a plain `<span>` resolved via `aria-labelledby`, never a real `<label for>`;
Recruitee: one combined "Full name" field like Lever/Ashby, but via an ordinary real `<label for>`,
with dot-namespaced field names like `candidate.email`) — proof the harness works against
unmodified production code, not exhaustive coverage of every supported ATS. iCIMS, Taleo, and
BrassRing have no fixture and are not expected to get one soon: confirmed live (see HANDOFF.md,
2026-07-13) that reaching their real application form requires an account-creation-adjacent flow,
which this project deliberately never automates past without explicit human sign-off. To add a new
fixture for an uncovered platform: open a real posting, capture field structure via the browser's
console (`document.querySelectorAll('input, select, textarea')` → id/name/label/autocomplete — never
capture real filled-in values), hand-write a trimmed fixture from that, then assertions.

**Every fill pass reports a field-by-field summary** (v1.13.49): the side panel shows what was
filled with what value and from which source (profile / learned / AI — AI answers badged
distinctly for review), plus what was skipped and why. The same data powers the **"Preview Fill"**
button: identical matching, zero writes — safe to try on any page. `npm test` covers both (fill-log
and preview tests run the real engine). A daily scheduled canary task also reruns the suite and
flags failures — see HANDOFF.md for its honest scope limits.

**Aggregator/lead-gen pages are refuse-to-fill by design**, at two independent layers:
background.js's injection routing (AGGREGATOR_HOST_RE → click through via
skipAggregatorInterstitial, never fill) and, since v1.13.48, autofill.js's own top-of-file
AGGREGATOR_SELF_RE guard (refuses to run at all on an aggregator host — covers the side panel's
manual fill button and DOM-mutation-only popups that never fire a navigation event). The two
regexes are deliberate duplicates with KEEP-IN-SYNC comments — change one, change both.
`tests/fixtures/aggregator-leadgen.html` regression-tests the refusal.

**`background.js` also has its own test harness** (`tests/background-harness.mjs` +
`tests/background.test.mjs`, added 2026-07-13) — a Node `vm`-based harness, not jsdom, since
background.js (the extension's service worker) never touches the DOM. It loads the real,
unmodified `background.js` with a mocked `chrome.*` API surface and a synchronous fake clock, and
regression-tests the aggregator-routing/race logic (`routeAggregatorOrInject`, the `WEBAPP_APPLY`
race-recovery path, the `onHistoryStateUpdated` SPA-nav aggregator check) that a live browser
click-through used to be the only way to verify.

**Watch for this exact mistake** (made once, caught by the test itself): `detectATS()` matches ATS
platforms by checking DOM markers in a fixed order (Workday → Greenhouse → Lever → iCIMS → Ashby →
...), first match wins. The Ashby fixture's form wrapper was first written with
`class="application-form"` for CSS-plausibility — not realizing that's Lever's own detection marker
(`document.querySelector('.application-form', ...)`), checked earlier in the chain, so the fixture
silently misdetected as Lever instead of Ashby. When composing a new fixture, only use class/id
names you actually captured from the real page, never an invented "looks about right" one — a
plausible-sounding class from a different platform's convention can accidentally collide.

The Workday fixture (the "Create Account" page) caught a real, live bug on the first try: a
`name="website"` anti-bot honeypot field, styled to pass `autofill.js`'s own `visible()` check
exactly like a real field would, was getting filled from `profile.website` — the file already had
honeypot detection (`looksLikeHoneypot`), it just wasn't wired into the standard-field-fill path.
Fixed (see HANDOFF.md) — worth keeping in mind when adding the next fixture: check for this class
of thing, not just "does the intended field get the intended value."

Beyond the fixture suite, all five covered platforms (Greenhouse, Lever, Workday, Ashby,
SmartRecruiters) were live-verified end to end on 2026-07-12 against real, current postings via
the WEBAPP_APPLY/bridge.js path — real fields filled, no stuck retry loops, Submit never clicked
(Workday verified up to its account sign-in wall; the create-account fill itself is covered by the
fixture, since going further live would create a real account). See HANDOFF.md for the full
evidence and the two real click-through bugs that testing found.

**If autofill.js ever gets stuck in a loop** (e.g. a repeating "Opening the application…" banner):
reloading the tab does NOT stop it — `background.js` tracks a 20-minute-TTL session per tab and
re-injects on every page load while it's fresh. Since v1.13.43 the side panel's **"⏹ Stop Autofill
Now" button** is the intended kill switch: it halts an in-progress run mid-fill (~1s), ends every
autofill session so nothing re-injects, and stops the queue — closing the tab still works but is
no longer the only way out. `window.__aliciaAutofillRun`'s click-and-retry
loop (for pages with no recognized form yet) is capped at 5 attempts (see HANDOFF.md), and the
mutation-observer rerun is capped at 25 per document, specifically
so this can't happen indefinitely, but any other retry loop added in the future should get the same
kind of bound — an unbounded `setTimeout(..., window.__aliciaAutofillRun)` reschedule is exactly how
this bug happened.

**Three jsdom-specific gotchas the harness works around** (all documented inline in
`harness.mjs`), worth knowing before extending this:
- jsdom does no real layout, so `offsetParent` is always `null` — `autofill.js`'s `visible()`
  check would otherwise skip every field in every fixture. The harness patches `offsetParent` to
  return truthy for anything not explicitly hidden.
- `autofill.js` watches `document.body` with a `MutationObserver` and re-runs itself on every
  childList mutation, by design — exactly right in a real tab, but a genuine infinite loop in a
  test with nothing to stop it. The harness stubs `MutationObserver` out entirely; a test only
  needs one clean fill pass.
- Node's test runner needs `--test-force-exit` (already in `npm test`) — without it a run that
  passes cleanly still hangs for ~30s before exiting, from lingering jsdom timer handles.

`node --test tests/` (a bare directory) doesn't reliably discover files on this Node version — use
an explicit glob (`tests/*.test.mjs`, already how `npm test` is wired) or list files by name.

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
| `bridge.js` | Content script on the Wagner-GPT web app origin. Announces the extension to the web app's **Jobs** tab and relays its "apply to these jobs" request (plus a résumé/profile sync push) to `background.js`, which opens each posting (paced) and starts the normal autofill session — stopping before Submit — and forwards fill-status back to the web app's tracker. |
| `sidepanel.html` / `sidepanel.js` | Side panel UI and logic — résumé tools, LinkedIn-specific job search + Scan & Rank, chat, tracker, universal auto-fill button, Learned Answers, Site Passwords. The old standalone full-page job search tab (`jobsearch.html`/`.js`) has been removed — general search now lives in Wagner-GPT's Jobs tab. |
| `account.js` | Alicia account: Supabase email-OTP sign-in (shared Supabase project, plain REST) for a higher daily AI allowance and Alicia Pro upgrades. Signed-out users keep working on the anonymous tier. |
| `parsers.js` | Self-contained PDF/DOCX text extraction (no external libraries) |
| `resume-preview.html` / `resume-preview.js` | Print-to-PDF preview for generated/tailored résumés |
| `styles.css` | Theming (4 themes) for the side panel |

### Backend split

| Endpoint | Backend | Purpose |
|---|---|---|
| `/api/chat` | [Wagner-GPT](https://wagner-gpt.vercel.app) | AI calls behind the web-app apply handoff (résumé tailoring/ranking in the Jobs tab) |
| `/api/jobs` | [Wagner-GPT](https://wagner-gpt.vercel.app) | Multi-source job search — now lives entirely in the Jobs tab, not in this repo |
| `/api/chat` | [Chatwillow](https://chatwillow.com) | AI calls from the side panel (match score, tailor, cover letter, chat, interview prep) |

Both backends are free-tier only — $0/month, no persistent server.
