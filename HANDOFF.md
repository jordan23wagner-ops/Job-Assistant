# Job-Assistant ("Alicia AI") — Engineering Handoff

## Update 2026-07-08 (latest) — v1.13.0: dynamic fallback tier for arbitrary company career sites

Reported gap: once off a known ATS (Workday/Greenhouse/Lever/...), autofill "struggles with company
sites due to them all being different." Root cause: static label discovery (`labelText`/`signals`)
only finds a field's meaning when the page exposes it via `<label for>`, `aria-label`/
`aria-labelledby`, or a close ancestor `<label>` — conventions major ATS platforms mostly follow but
bespoke career sites routinely don't (caption sits in an unrelated sibling `<div>`, or nowhere
discoverable via accessible-name APIs at all). Those fields were invisible to every existing pass.

Before building anything, ran a deep-research pass on competing autofill tools (Simplify Copilot,
Skyvern, others) to check whether this is a solved problem elsewhere. Verified findings: **Simplify**
(the closest direct competitor) admits only 80% site coverage and its named "100+ supported" list is
the SAME major-ATS set we already adapt for — no distinct custom-site mechanism, same "fill what we
can" degradation. **Skyvern** (YC-backed, dedicated "Jobs Agent" product) markets "vision instead of
DOM," but its own engineering blog/docs/founder statements (independently verified) reveal a HYBRID:
scrape the page into a structured "interactable element list" (id/tag/aria-label/etc.) → feed that as
text + a screenshot to an LLM → execute via Playwright DOM element handles, not blind pixel clicks.
Verdict: known-hard, industry-wide unsolved problem, not something we're behind on — and the validated
next tier (used by the one outfit actually targeting this) is LLM-driven dynamic DOM/accessibility-tree
mapping, not full vision/computer-use.

**Shipped that tier in `autofill.js`** (new functions after `callCustomAnswerBackend`):
- `widerLabelGuess(el)`: free, no-AI widening of label discovery — scrapes preceding sibling/ancestor
  text up to 4 levels up, catching captions `labelText()`'s stricter accessible-name search misses.
- `scrapeOrphanControls(claimedEls)`: finds visible/enabled/empty input|textarea|select controls (and
  unclaimed radio groups) NOT already claimed by the standard passes or `findUnansweredCustomQuestions`.
- `aiInferLabels(items)`: for controls that STILL have no discoverable caption after the free widening,
  ONE bounded backend call infers a short label from technical hints only (type/name/id/class/options)
  — a scoped labeling task, never asked to invent PII/EEO content.
- `classifyDynamicItem(o, profile)`: routes the (real or AI-inferred) label through the SAME trust
  boundary as everywhere else — contact fields fill from the trusted profile value (never AI text),
  EEO fields fill from saved prefs only if backed by a real `<select>`/radio-group (never free-typed),
  everything else becomes an ordinary custom-question item flowing through the EXISTING learned-bank
  → AI-answer → ask-and-remember pipeline. A "wordy" gate stops one-word non-question labels (e.g. a
  stray "Search" box) from being promoted into a spurious question.
- `findDynamicFallbackItems(...)` orchestrates the above; wired into `fillOnePass`'s discovery step,
  gated to `atsName === 'generic'` only (known ATS adapters already have good structural coverage, so
  this only spends effort where the gap actually is).

Verified: `node --check` clean; logic tests for the classifier's full decision tree (contact/EEO/
question/drop routing, the wordy gate, trust-boundary preservation) and `widerLabelGuess`'s ancestor-
text aggregation (1-level, 2-level, and no-signal-found cases) all pass. Live E2E on a real bespoke
career site still needs a human run.

## Update 2026-07-08 — v1.12.4: residential-IP Adzuna resolution (Vercel can't)

The v1.12.3 server-side resolver is IP-blocked by Adzuna/Cloudflare on Vercel's datacenter IP (0 of 50
resolved in live testing). The extension runs on the user's RESIDENTIAL IP + cookies, so it isn't
blocked: `resolveAdzunaViaFetch(url)` follows the Adzuna redirect to completion and returns the final
employer URL if it landed on a real employer/ATS host (not another aggregator, not Adzuna's
login/authenticate wall). Wired into the explicit-apply onUpdated handler: on an adzuna host, resolve
once per tab (`s.adzunaTried` guards against login-wall loops) and `chrome.tabs.update` straight to the
employer; on failure fall through to `skipAggregatorInterstitial` (which bails on the login wall).
`AGGREGATOR_HOST_RE` broadened (jobgether/lensa/whatjobs/…) so a resolved URL that is itself another
aggregator is rejected. Non-gated Adzuna postings now skip straight to the employer; gated ones (user
logged out) still can't be bypassed — those are labeled honestly in the web app.

## Update 2026-07-08 — v1.12.3: don't fight Adzuna's login wall

Extension side of the Adzuna-skip work (main fix is in Wagner-GPT — see its HANDOFF). Adzuna now
login-walls logged-out users (`adzuna.com/details/…?apply=1&after_login` → FB/Google/email modal), so
the apply chain dead-ended there. `skipAggregatorInterstitial` now BAILS on an Adzuna
login/authenticate wall instead of fruitlessly clicking "Apply" (which just reopens the modal). The
real fix is upstream: the backend resolves Adzuna links to the employer URL before they're ever used,
and the web app defaults to "Direct apply only", so this wall is now a rare edge case. Deliberately did
NOT synthesize `/land/ad/<id>` URLs in the extension (a workflow adversary pass showed tokenless
synthesis 403s and can infinite-loop through `/authenticate?redirect_to=`).

## Update 2026-07-08 — v1.12.2: broaden apply-button capture + autonomous single-button click

Follow-up to v1.12.1's nav panel: on an Oracle Recruiting Cloud details page the panel appeared but
MISSED the "APPLY NOW" button (it's a styled non-`<a href>`/non-`<button>` element) and instead listed
account/nav noise (Manage profile, Sign Out, View More Jobs, PRIVACY STATEMENT…). Fixes in `autofill.js`:

- `navCandidates` broadened: primary selector now includes bare `<a>`, `[role=link]`, `[onclick]`,
  `[class*=btn|button|apply|cta]`, `[data-automation-id]`; plus a backstop text-sweep over leaf
  elements whose own short text reads like a forward action, resolved to the nearest clickable
  ancestor (`isClickableEl`/`nearestClickable`) — catches Apply buttons that are plain divs/custom
  components. `NAV_NOISE_RE` filters account/legal/nav chrome as whole-label matches.
- **Autonomous when unambiguous:** if exactly ONE candidate scores as a clear Apply (score ≥ 6), the
  engine clicks it automatically (and remembers it) instead of asking — Apply only opens the form,
  never submits, so it's safe/recoverable. The panel is now reserved for genuinely ambiguous pages
  (multiple forward buttons, or none dominant). Verified by a logic test against the real Oracle and
  jobgether button sets (both collapse to a single autonomous APPLY/APPLY NOW).

## Update 2026-07-08 — v1.12.1: aggregator new-tab sessions + navigation ask-and-remember

Real-world failure (jobgether.com): the web app opened an AGGREGATOR page that opened the real
employer application (jobs.prometeotalent.com) in a SEPARATE tab. That new tab had no autofill
session and the employer host isn't a known ATS, so nothing ran on the page that actually had the
form; jobgether's "Did you submit?" modal blocked progress. Two fixes:

1. **Child tabs inherit the apply session (`background.js` `chrome.tabs.onCreated`):** a new tab
   opened FROM an explicit apply-session tab (via `openerTabId`) inherits the session (tailored
   résumé + status reporting included). Aggregator→employer new-tab hops now autofill.

2. **Navigation ask-and-remember (`autofill.js`):** on a page with no recognized form, instead of
   just "click Apply yourself", the engine tries a learned "click this button to proceed" choice for
   the host; if none, it surfaces the prominent clickable options (ranked — real Apply/Continue
   first, aggregator "I applied / engage later" dead-ends last) in a panel and asks which one moves
   forward. The pick is clicked AND remembered (`navChoices` storage, keyed by hostname + normalized
   button text), so the next visit to that aggregator auto-clicks. `window.__aliciaNavHandled` guards
   against re-asking on re-injection. New tracker status `advancing`. navScore ordering verified by a
   logic test against the actual jobgether button set (APPLY ranks alone at top; "I didn't actually
   apply" no longer ties it despite containing "apply").

## Update 2026-07-08 — v1.12.0: LinkedIn dropdown parity, handoff v2, extension slimming

Deep-dive review follow-up. Three thrusts:

**1. LinkedIn Easy Apply gets the same dropdown fixes as autofill.js (content.js):**
- `selectHasRealAnswer`/`isPlaceholderValue`: "Select an option" no longer counts as answered — those
  dropdowns were skipped by learned/AI answering AND banked as the learned answer, poisoning the
  shared `customQA` bank autofill.js reads. Both engines now purge placeholder records on load.
- `modal.__aliciaLearnItems` is finally SET (it was only ever read), so an unanswered question no
  longer re-triggers the batched AI backend call every ~1.2s poll tick while the human answers.
- `applyAnswerToItem` is async and resolves typeahead/combobox picks (`resolveTypeaheadSelection`)
  for custom questions — typed-but-never-picked answers failed validation on Next.
- The ask-and-remember panel (`showEasyApplyQuestionPanel`) ported from autofill.js: dropdown
  questions get a real option list, answers are banked FIRST, auto-advance resumes on save.
- autofill.js: learned-but-unappliable answers now flow to the AI/ask panel instead of being
  silently dropped (a stale bank entry could make a dropdown permanently unfillable).

**2. Apply handoff v2 (web app ⇄ extension):**
- The web app's per-job TAILORED résumé is now actually used: background injects it as
  `window.__aliciaTailoredResume` before autofill.js (previously written to `session.tailoredResume`
  and never read — the generic résumé was filled instead). Résumé file uploads attach the tailored
  text as .txt when the input accepts it, else the stored original file.
- Redirect-proof adoption: `webNavigation.onBeforeNavigate` binds a registered apply URL to its tab
  on the FIRST navigation (aggregator/short links 302'd before `complete` and were never adopted).
- Fill-status feedback: background forwards `UNIVERSAL_FILL_RESULT` to open Wagner-GPT tabs → bridge
  → `FILL_STATUS` postMessage → Jobs tracker shows live state (filled / needs input / ready to
  submit). Explicit sessions END on `ready_to_submit` and cap at 10 navigations (they used to shadow
  the tab anywhere for 20 minutes).
- Web→ext sync channel: `ALICIA_SYNC` pushes the web app's active résumé (text + file) and profile
  into extension storage — Wagner-GPT is the résumé source of truth now. `APPLY_ACK` carries
  accepted/requested counts (the silent 5-job cap is surfaceable).

**3. Slimming + hardening:**
- Deleted `jobsearch.html`/`jobsearch.js` (full duplicate of the web app's Jobs tab calling the same
  backend); the side panel button now opens `wagner-gpt.vercel.app/?tab=jobs`. Tracker panel links to
  the web app tracker. Deleted `resume.txt` (real PII shipping in the repo/unpacked extension —
  consider scrubbing git history).
- `injectAtsFrames` now requires a known ATS host (any-direct-child injection could fill contact
  info and even generate+save a password inside e.g. a survey iframe on LinkedIn).
- Removed the duplicate `JOB_DETECTED` re-broadcast (displayJob ran twice); guarded null messages.
- Queue Start now targets a LinkedIn tab instead of hijacking whatever tab was focused.

Verified: `node --check` clean on all extension JS; manifest parses; wagner-gpt builds. Live E2E
(reload extension → web-app search → tailor → apply → watch tracker status) needs a human run.

## Update 2026-07-07 — v1.11.8: dropdown vs free-text classification + ask-and-remember panel

Fixes the reported failure where autofill treated dropdown questions as free text (typed value never
commits → "required"/validation error on advance) or skipped fields outright. Four root causes fixed
in `autofill.js`:

1. **`isComboControl` false positive on Bootstrap's `form-control`** — the old `[class*="-control"]`
   ancestor match classified plain text inputs as comboboxes, so real free-text questions were
   *skipped entirely*. Now only strong signals count: ARIA combobox semantics (`role=combobox`,
   `aria-haspopup=listbox`, `aria-autocomplete=list|both`), readonly menu-trigger inputs inside a
   dropdown/`aria-expanded` container, react-select BEM (`select__control`/`Select-control`), or a
   react-select emotion class (`css-…-control`) **with** a dropdown indicator inside.
2. **`comboValueText` placeholder detection** — "Select an option" (non-exact placeholder) was read
   as a real value, so those dropdowns were treated as already-answered and skipped. New
   `isComboPlaceholder` treats any select/choose/please/pick/search-prefixed text (or dashes) as
   empty; "None" stays a real answer.
3. **`fillStdFields` typed into combo inputs** — the std contact pass now skips `isComboControl`
   elements; a new **`fillStdCombos`** pass (the combobox twin of `fillStdSelects`) SELECTS
   State/Country/City options instead. Also runs inside `correctErrors`.
4. **Searchable combos never matched** — `selectFromCombobox` gained a type-to-filter fallback
   (type the desired value into the combo's input, wait, pick the best filtered option) and ALWAYS
   clears stray typed text on failure before closing, so a failed attempt can no longer leave
   uncommitted free text that fails validation.

Shared discovery: new `visibleComboTriggers()` (one item per widget, container-deduped) feeds
`fillStdCombos`, `fillEeoComboboxes` (which previously skipped INPUT triggers — react-select EEO
dropdowns like Greenhouse demographics were never selected), and the custom-question combobox pass
(selector widened to `aria-autocomplete` inputs + react-select control divs).

**Ask-and-remember:** questions with no learned answer that the AI also can't answer now raise an
interactive on-page panel (`showQuestionPanel`) — dropdown questions render a real `<select>` of the
harvested options, free text gets a textarea. "Save answers & continue" banks each answer in the
learned `customQA` store FIRST (the human's answer is truth even if applying to the widget fails),
applies it to the form, and resumes the fill loop. Dismissing the panel falls back to the old
behavior (fill on the page; the Continue-click confirm-capture still learns).

Verified: `node --check` clean; logic tests for `isComboControl` (Bootstrap false positive, BEM /
emotion react-select, ARIA, readonly trigger) and `isComboPlaceholder` all pass. Live E2E on a real
Greenhouse/Workday application still needs a human run after the extension reload.

## Update 2026-07-06 — v1.9.0: Job Search (new-tab, Adzuna-backed) — Phase 1

New feature: search for jobs by **title and/or industry**, ranked by résumé fit, in a **full-page
browser tab** (roomy, uncluttered). Built in phases; this is Phase 1 (search + filters + ranked
results). Phase 2 = tighter apply hand-off; Phase 3 = résumé tailoring with follow-up questions.

**Cross-repo — backends (IMPORTANT, two of them):**
- Most of the extension (chat, match scoring, autofill answers, résumé tailoring) uses the
  **Chatwillow** backend (`https://chatwillow.com`, repo github.com/jordan23wagner-ops/Chatwillow) —
  the public app with accounts/Pro. That's unchanged.
- **Job Search runs on the WAGNER-GPT backend instead** (`https://wagner-gpt.vercel.app`, repo
  github.com/jordan23wagner-ops/Wagner-GPT, local `C:\Users\Jordon\Wagner-GPT\wife-gpt`) — Jordon &
  Alicia's personal tool. `jobsearch.js` sets `BACKEND = 'https://wagner-gpt.vercel.app/api'`, so BOTH
  the Adzuna `/api/jobs` proxy AND the fit-ranking `/api/chat` call for the job-search page go to
  wagner-gpt. (Chatwillow intentionally does NOT have the jobs endpoint — it was removed.)
- Job data comes from the **Adzuna** free jobs API, proxied through **`wife-gpt/api/jobs.js`** so **no
  key ships in the extension** — `POST {action:'search'|'categories', …}`. It reads
  **`ADZUNA_APP_ID` / `ADZUNA_APP_KEY`** from the backend env; without them it returns a clear "not
  configured" 500 (with a presence-only diagnostic). **The keys live on the wagner-gpt Vercel project**
  (verified working — 30 categories + live search returned). Same reflect-origin CORS as `chat.js`;
  Vercel auto-detects it (no `vercel.json` change). Adzuna has no clean remote flag, so remote:true
  appends "remote" to the query.

**Extension (files):**
- **`jobsearch.html` + `jobsearch.js` (NEW):** the full-page UI. Self-contained styles (no theme
  coupling). Inputs: titles (comma-sep), **industry** (curated list — Software/IT, Cybersecurity, AI/ML,
  Oil & Gas/Energy, Healthcare Tech, Manufacturing, Engineering, Any), location, salary min, remote,
  full-time, country. Industry resolves to an Adzuna category by **matching the live category label**
  (fetched via `action:'categories'`) — never a hardcoded tag — plus keyword augmentation for
  sub-fields Adzuna doesn't categorize (Cybersecurity/AI live inside "IT Jobs"). Results are ranked by
  résumé fit (batched AI call, same NDJSON `/api/chat` seam as autofill.js; falls back to a lexical
  overlap score if the AI call fails or no résumé is saved). Cards show fit badge, salary, category, an
  **"⚡ auto-fill ready"** pill when the posting URL is a known ATS host, and **Apply** (opens the
  posting → the existing detect.js offer fires there) + **View posting**.
- **Opened via** a new **"🔎 Search Jobs by Title & Industry"** button in the side panel's **Search**
  tab → `chrome.tabs.create({url: chrome.runtime.getURL('jobsearch.html')})`. Own extension page, so
  no `web_accessible_resources` / manifest change needed.

**Verified:** `node --check` clean on `api/jobs.js`, `jobsearch.js`, and the extension JS; unit tests
pass for industry→category resolution (by label match), title+keyword merge, salary formatting, and the
Adzuna search-URL assembly. **Live E2E still needs** (a) the Adzuna key set in the backend env + a
redeploy, and (b) an extension reload — then a real search from the new tab.

**Next (this feature):** Phase 2 — make "Apply" auto-start the fill on landing (don't just rely on the
offer) + save to Tracker. Phase 3 — "Tailor my résumé for this role": follow-up questions about your
experience, saved as a new active résumé (never invents — only adds what you confirm).

## Update 2026-07-06 — v1.8.5: Ashby, SmartRecruiters, Taleo, BrassRing adapters

Added the last four ATS adapters, completing the planned set. Split by nature:

**Ashby + SmartRecruiters (modern, clean, guest-apply — no account):** their standard fields, EEO,
and custom questions are already handled by the generic engine; the only shared gap is the location
autocomplete, so both reuse `atsFillLocationTypeahead` (same as Greenhouse/Lever). Detection:
hostname `*.ashbyhq.com` / `*.smartrecruiters.com`, plus a loose DOM signature fallback (harmless —
these adapters only add a location typeahead).

**Taleo + BrassRing (legacy, ACCOUNT-GATED, multi-step):** the important part. Generic treats
"Create Account" as a stop, so on these it **halts at the account gate and never reaches the form**.
The adapter unblocks the whole flow. iCIMS/Taleo/BrassRing now share one **`accountGateAdapter(name)`
factory** (iCIMS was refactored onto it — behavior unchanged): auto-clicks Create Account / Register /
Sign Up / **New User** (advance) via `ACCOUNT_GATE_ADVANCE`, ticks the agreement checkbox on the
account page (`isAccountCreationPage` = a password field + a create/register/new-user button present),
stops on the email-verification wall (`isVerifyEmailWall`) and the final Submit (`WD_STOP`). Login/
Sign In are never auto-clicked. Detection is **hostname-only** for Taleo (`*.taleo.net`) and BrassRing
(`*.brassring.com`) — no weak DOM signature, because account auto-create is riskier than a location
typeahead and must not misfire on an unrelated page.

**`background.js`:** added `brassring` to `ATS_HOST_RE` (the other three were already present), so the
auto-detect offer + ATS-iframe injection fire on BrassRing. Taleo/BrassRing/iCIMS forms are often
embedded via an iframe whose src is the ATS host; `background.js` injects `autofill.js` into it and the
adapter runs inside.

**Verified:** `node --check` clean; unit tests pass for detection of all four hosts, the `ATS_HOST_RE`
membership (incl. `sjobs.brassring.com`), and the account-gate routing (Create Account/Register/Sign
Up/New User → advance; Submit/Apply → stop; Login/Sign In → neither). **Live load test still needed** —
Taleo/BrassRing DOM is notoriously clunky and iframe-heavy; these are first-pass adapters (standard-
field fill + account gate + multi-step advance). If they use custom non-native dropdowns, add a
`fillDropdowns`/`findDropdownQuestions` hook like Workday's.

**ATS coverage COMPLETE:** Workday (full: fields, EEO, account gate, single-select enumerated +
searchable, multi-select), Greenhouse, Lever, iCIMS, Ashby, SmartRecruiters, Taleo, BrassRing all have
adapters; generic handles everything else. Shared building blocks for future ATSs: `wdPickOption`
(prompt dropdowns), `atsFillLocationTypeahead` (location), `accountGateAdapter` (account gates),
`tickAccountAgreement` / `isVerifyEmailWall` (gate helpers).

## Update 2026-07-06 — v1.8.4: iCIMS adapter

Added an `icims` adapter. iCIMS is largely standard HTML (native `<select>`/radio/text + a resume
file input), so the generic engine already fills its contact fields, EEO selects, and custom
questions — its `firstname`/`lastname`/`homePhone`/`postalCode` ids match the generic matchers. The
adapter adds only what's iCIMS-specific:

- **Detection** (`detectATS`): hostname `*.icims.com`, or the `iCIMS_` wrapper markup
  (`.iCIMS_MainWrapper`, `#icims_content`, `form#quickForm`, `[id^="icims_"]`) when the form is
  embedded in an iframe. Note iCIMS forms are usually embedded on the company careers page via an
  iframe whose src is `*.icims.com`; `background.js` already injects `autofill.js` into ATS iframes
  (`ATS_HOST_RE` includes icims), so the adapter runs INSIDE that iframe.
- **Account gate** (per the Workday/iCIMS product decision — auto-create): Create Account / Register /
  Sign Up is auto-clicked (`ICIMS_ADVANCE`; removed from `ICIMS_STOP` = `WD_STOP`). `icimsFillDropdowns`
  ticks the agreement checkbox when the page has a password field AND a register/create button
  (`icimsAccountPage`). Generic `fillPasswordFields` fills password + confirm with the same generated
  value. The final **Submit/Apply is never auto-clicked.** "Login"/"Sign In" are NOT auto-clicked.
- **Email-verification wall** (`icimsBlockingWall`): same detector as Workday.

**Refactor:** the account-agreement checkbox logic and the verify-email-wall detector were extracted
into shared `tickAccountAgreement()` and `isVerifyEmailWall()` (used by both Workday and iCIMS).
Workday behavior is unchanged (same logic, now shared).

**Verified:** `node --check` clean; unit tests pass for iCIMS host detection, account-gate routing
(Create Account/Register/Sign Up → advance; Submit/Apply → stop; Login/Sign In → neither), and the
agreement-checkbox selection (tick only agree/terms box; single-box fallback; tick nothing when only
marketing boxes). **Live load test still needed** — iCIMS DOM varies (classic iForm vs. the newer
Talent Cloud); if custom (non-native) dropdowns appear in the newer UI, they'd need an iCIMS
`fillDropdowns`/`findDropdownQuestions` like Workday's (not built — classic iCIMS uses native selects
the generic engine handles).

**ATS coverage now:** Workday (full), Greenhouse, Lever, iCIMS have adapters; generic handles the
rest. Ashby / SmartRecruiters / Taleo / BrassRing are still generic-only.

## Update 2026-07-06 — v1.8.3: Workday multi-select prompt fields (Phase 2d)

Workday multi-select fields (Skills, Languages, multi-pick "how did you hear") are a typed input
inside `[data-automation-id="multiSelectContainer"]` whose picks render as chips
(`[data-automation-id="selectedItem"]`) — NOT a `button[aria-haspopup="listbox"]`, so neither the
single-select fill nor the single-select discovery saw them. Phase 2d wires them into the same
custom-question pipeline, answering multiple values.

**`autofill.js`:**
- `wdFindMultiselectQuestions(eeo)` discovers each visible, empty (no chips), non-EEO multiselect
  container with a labelled input and emits a custom-question item with **`multi: true`**,
  `type:'text'`, `options:[]`.
- `callCustomAnswerBackend` formats `multi` items as **"[list one or more values from the resume,
  comma-separated]"** (the truthful/resume-only system prompt is unchanged — no invented skills).
- `wdAddMultiValues(container, answerText)` (the item's `apply`) splits the answer on `,`/`;`/newline
  and, for each value, types it into the multiselect input, waits for the promptOption list, and
  clicks the best match (≥45) to add a chip; unmatched values are cleared so no stray text lingers.
- `getValue` reads the chip texts joined by ", " — so the human's reviewed/edited set is what gets
  learned on the confirm click.
- `wdFindDropdownQuestions` now appends the multiselect results to the single-select results (one
  hook, shared `CUSTOM_QA_MAX_PER_STEP` cap). Disjoint from the single-select scan (that scans
  `button[aria-haspopup="listbox"]`; multiselects use an input), and `wdFillDropdowns` skips inputs,
  so no double-handling.

**Safety:** multiselect answers are AI-generated from resume facts and, like all AI answers, **pause
for human review** before Submit (the human can remove chips) — consistent with the never-auto-submit,
never-invent guardrails. EEO/demographic multiselects are excluded.

**Verified:** `node --check` clean; unit tests pass for value splitting (`,`/`;`/newline), the
multi prompt label, apply match/no-match, and the chip `getValue` join. **Live load test still
needed** for the real type→list→click-chip cycle and multi-value adds on a Workday Skills/Languages
field.

**Remaining Workday gaps:** none tracked beyond tuning (search wait time under heavy latency). The
Workday adapter now covers standard fields, EEO, account gate + verify wall, single-select
(enumerated + searchable) and multi-select prompt questions.

## Update 2026-07-06 — v1.8.2: Workday searchable dropdowns / type-to-search (Phase 2c)

Workday has two dropdown kinds: small enumerated lists (render options immediately) and SEARCHABLE
lists — Country, School, State/Province — that render NOTHING until you type. Phases 2/2b handled
only the first kind; searchable ones came back empty and were skipped. Phase 2c adds type-to-search
and folds all the dropdown open/pick logic into one primitive.

**`wdPickOption(trigger, desired)` (`autofill.js`) — the single open→pick primitive now:**
- Opens the dropdown; if no `promptOption` items render, it finds the popup's search box
  (`wdSearchBox`: `input[data-automation-id="searchBox"]` + fallbacks), types `desired`, waits for
  the list to filter, then picks the best-scoring option (≥45). Escapes closed on no match.
- Both `wdFillDropdowns` (EEO/State/Country) and the custom-question `apply` closures call it, so
  enumerated AND searchable dropdowns go through the exact same path. `wdSelectAnswer` was removed
  (folded in).

**Standard-field dropdowns from the profile:** `wdFillDropdowns(eeo, profile)` now also fills
**State/Province** and **Country** from `profile` (previously EEO-only). Gotcha baked in: Workday's
State field is usually `formField-countryRegion`, so the state check (`/state|province|region/`) runs
BEFORE the country check and matches "region" — routing `countryRegion` to `profile.state`, not
country. (`profile` has no `country` field today, so Country only fills if one is added later.)

**Searchable custom questions:** `wdReadOptions` now returns `{ options, searchable }`.
`wdFindDropdownQuestions` emits enumerated dropdowns as `type:'select'` (AI must return an exact
option) and searchable ones as `type:'text'` with `options:[]` (AI returns the value; `apply` types
it into the search box and picks). Empty-non-searchable and absurdly-long (>30) lists are still left
for the human.

**Signature change:** the `fillDropdowns` adapter hook is now `fillDropdowns(eeo, profile)` (was
`(eeo)`); the call site passes `profile`. Generic adapter doesn't implement it, so no impact there.

**Verified:** `node --check` clean; unit tests pass for the desired-value routing (gender→pref,
`countryRegion`→state, pure country→country, address/phone-type→skip) and the searchable
classification (enumerated→select, empty+searchbox→text, empty→skip, >30→skip). **Live load test
still needed** for the real type-into-search-box→filter→pick cycle on Workday Country/School/State.

**Remaining Workday gaps:** multi-select prompt fields (skills/languages that accept several picks)
aren't handled — only single-select. Network-latency-heavy searches may need a longer wait than the
750ms in `wdPickOption`.

## Update 2026-07-06 (later) — v1.8.1: Workday prompt-option questions → AI answer flow (Phase 2b)

Workday's NON-EEO question dropdowns now flow through the same learned-bank → batched-AI →
learn-from-human pipeline as native `<select>`/radio/text questions. Before this, only real
`<select>`, radio groups, and text inputs were discovered by `findUnansweredCustomQuestions`, so
Workday's button+portaled-listbox dropdowns ("How did you hear about us?", "Highest level of
education", yes/no eligibility questions, etc.) were silently skipped.

**How it works (`autofill.js`):**
- New adapter hook **`findDropdownQuestions(eeo)`** (async), wired into `fillOnePass` right after the
  generic `findUnansweredCustomQuestions` and concatenated into the same `items` list (capped at
  `CUSTOM_QA_MAX_PER_STEP`). Only Workday implements it (`wdFindDropdownQuestions`).
- Custom-question **items can now carry their own `apply(answerText)` (async) + `getValue()`**.
  `applyAnswerToItem` is now `async` and short-circuits to `item.apply` when present; `itemFinalValue`
  short-circuits to `item.getValue`. Both `applyAnswerToItem` call sites (learned loop + AI loop)
  were converted from `forEach` to `await`-ing `for` loops. Generic select/radio/text items are
  unchanged (no `apply`/`getValue` → same code path as before).
- `wdFindDropdownQuestions`: for each `button[aria-haspopup="listbox"]` that is empty, non-EEO, and
  has a question-like label (≥2 words or `?`; single-word selects like Country/State are left for the
  human), it OPENS the dropdown to read the `[data-automation-id="promptOption"]` labels (Workday only
  renders them while open), closes it, and — if 2–30 options — emits a `type:'select'` item whose
  `apply` re-opens and picks the best-scoring option and whose `getValue` reads the trigger text.
  **EEO/demographic dropdowns are excluded** (they're filled from saved prefs by `wdFillDropdowns`;
  we never AI-guess demographics). Searchable dropdowns render no options until you type, so they come
  back empty (>30 or 0) and are left for the human — a known Phase-2c follow-up.

**Verified:** `node --check` clean; unit tests pass for the discovery gating (include "how did you
hear"/"education"; skip EEO, already-answered, single-word, and empty/searchable) and for the async
`apply`/`getValue` routing (routed + awaited). **Live load test still needed** for the real
open→read→close→reopen→pick cycle on a Workday questions page.

## Update 2026-07-06 — v1.8.0: external-ATS adapter framework + auto-detect offer

Expanded external-ATS autofill from one generic pass into a **detector → adapter** architecture,
plus an auto-detect entry point so an application can be filled on a company/ATS site without
opening the side panel. Shipped in three phases; all on the same free backend, still never
auto-submits the final Apply.

**Phase 1 — adapter seam + auto-detect/offer (`autofill.js`, new `detect.js`, `background.js`):**
- `detectATS()` returns `workday | greenhouse | lever | generic` (hostname + DOM signature);
  `ADAPTERS` is the registry. An **empty adapter `{}` is byte-for-byte the old generic engine** —
  the refactor is a pure seam, no behavior change on unknown sites. The main run resolves
  `adapter = ADAPTERS[detectATS()]`, routes dropdown fill + advance/stop lookups through it, and
  sets `result.ats`. Hook interface (all optional, generic fallback if omitted):
  `fillDropdowns(eeo)`, `fillTypeaheads(profile)`, `blockingWall()`, `advancePatterns`,
  `stopPatterns` — documented in a comment block above the registry.
- **`detect.js` (NEW):** a tiny offer script. `background.js` injects it on a completed load of a
  known-ATS host (scoped to `ATS_HOST_RE`, so it NEVER runs on arbitrary sites the user browses)
  when there's no active session for the tab and the host wasn't dismissed in the last 6h. It
  checks for a real application form (same signal as `hasRecognizedForm`) and floats
  "⚡ Auto-fill this application?". **Accept** messages `ATS_OFFER_ACCEPT` → background starts the
  exact same `autofillSessions` flow the manual button uses (so re-injection + `UNIVERSAL_FILL_RESULT`
  reporting already work). **Not now** → `ATS_OFFER_DISMISS` records the host (in-memory; a worker
  restart may re-offer — harmless). No manifest change: `scripting` + `<all_urls>` already allow
  programmatic injection, so no re-accept prompt on reload.

**Phase 2 — Workday adapter (`wdFillDropdowns`, `wdBlockingWall`, `WD_ADVANCE`/`WD_STOP`):**
- **Prompt-option dropdowns:** Workday dropdowns are a `button[aria-haspopup="listbox"]` opening a
  PORTALED list of `[data-automation-id="promptOption"]` (`data-automation-label` = option text) at
  the end of `<body>` — not `<select>` and not `role=option`. `wdFillDropdowns` opens EEO/known ones
  (matched via the `formField-*` container id + label → `eeoKey`), scores options, picks or Escapes.
  Runs before the generic combobox pass; unknown dropdowns are left for the human (Phase 2 scope).
- **Account gate (auto-submit, per Jordon's call):** on the create-account page it ticks ONLY the
  agreement checkbox (by `data-automation-id`/agree-terms label, or the sole checkbox — avoids
  marketing opt-ins); generic `fillPasswordFields` fills both password + verifyPassword with the same
  generated value so they match; **"Create Account" is auto-clicked** (it's in `WD_ADVANCE`, removed
  from `WD_STOP`). The final application **Submit is still never auto-clicked.**
- **Email-verification wall:** `wdBlockingWall()` detects the post-create-account verify screen
  (verify phrases + essentially no form) and stops with a clear banner. Checked at run start AND at
  the top of each wizard step, because Create Account triggers a real page nav that re-injects and
  re-runs `autofill.js`.

**Phase 3 — Greenhouse + Lever adapters (`atsFillLocationTypeahead`):**
- Both are single-page forms already handled by the generic engine (standard fields, EEO selects,
  custom questions; generic stop patterns catch "Submit Application"). No pattern override, no gate.
- Their one shared generic gap is the **location autocomplete** — generic types the city but never
  picks the suggestion, which can fail validation. `atsFillLocationTypeahead` types "City, State" and
  picks the first suggestion (`.pac-item`, listbox options, Greenhouse's dropdown). **On pick-failure
  it leaves the typed value = identical to generic, so it can only help, never regress.**

**Verification (this session):** `node --check` clean on all JS + valid `manifest.json`; unit tests
pass for host detection, Workday advance/stop routing + `eeoKey` on `formField-*` ids + wall phrases,
and Greenhouse/Lever field matching + the location signal. **Still needs Jordon's live load test** for
the interactive DOM (Workday dropdown pick, GH/Lever location pick, offer→fill handoff) — the
`promptOption`/suggestion-container selectors are best-effort against current ATS DOM. Console
diagnostics for tightening selectors are in the session notes (dropdown dump for Workday; suggestion
dump for GH/Lever).

**Next tuning candidates:** Workday **custom (non-EEO) question dropdowns** don't yet route through the
learned/AI batched flow (only native `<select>` + radios do); wiring `promptOption` questions into
`findUnansweredCustomQuestions` is the natural Phase 2b. iCIMS/Taleo/Ashby/SmartRecruiters remain
generic-only (adapters not built).

## Update 2026-07-01 — v1.3.0: Easy Apply refinements (banking, resume, post-submit)

Three fixes after v1.2.0 confirmed Easy Apply works:
- **Bank every question + dropdown, not just AI-answered ones.** `findUnansweredCustomQuestions`
  generalized to `findCustomQuestions(modal, includeAnswered)`; `attachAnswerCapture(modal)` is
  now attached on every step and, on any advance/submit click (Alicia's or the human's), banks
  the final value of ALL custom questions via `bankAllCustomAnswers` — so manually-typed answers
  and dropdown selections are remembered too, not only the ones Alicia generated.
- **Hidden/conditional questions ignored.** Question containers with no client rects (hidden
  steps, conditional fields) are skipped in both `findCustomQuestions` and `autoFillEeo`.
- **Resume step left to the user.** `isResumeOrDocControl()` excludes resume/CV/cover-letter
  selection from the custom-question + fill logic, and the LinkedIn resume-file auto-attach was
  removed entirely (it caused a second document to be selected → Next errored). LinkedIn
  pre-selects the most-recent resume; Alicia no longer touches it. External-ATS resume upload
  still lives in autofill.js.
- **Stop after Submit.** `isPostSubmitConfirmation()` detects the "application sent" / follow-
  company end screen (no advance/submit button present) and makes `findEasyApplyModal` return
  null, so Alicia goes quiet and waits for a new job + Easy Apply instead of poking the
  confirmation screen (which produced console errors and could touch the Follow prompt).
- Harness-verified: resume step auto-advanced without selecting a 2nd resume; a manually-chosen
  dropdown + typed answer were both banked; post-submit confirmation left untouched (Follow not
  clicked, no advance).

## Update 2026-07-01 (latest) — v1.2.0: THE fix — pierce LinkedIn's Shadow DOM

The true root cause of Easy Apply "nothing happens", confirmed by a shadow+iframe-piercing
console diagnostic on the live Serverfarm modal: **the entire Easy Apply modal (fields AND its
Next button) is rendered inside a Shadow DOM** attached to `<div id="interop-outlet">`. Shadow
trees are sealed from `document.querySelector`, so every prior content.js — which queried the
light DOM — was searching a tree that does not contain the form. (The `linkedin.com/preload`
iframe was a red herring: it's a hidden full copy of the page chrome, not the modal.)

Diagnostic proof: `firstName.path = " >> shadow(div#interop-outlet)"`, and the modal's real
"Next" also at that shadow path (the light-DOM "Next" is just job-list pagination).

Fix (content.js):
- `collectShadowRoots()` / `easyApplySearchRoots()` — gather the light document + every shadow
  root (fast path for the known `#interop-outlet` host). `findEasyApplyForm`,
  `findEasyApplyModal`, and `autoFillEeo` now search across all roots; once the modal element
  (inside the shadow root) is found, `.querySelectorAll` on it works normally within that tree.
- `ownerRoot(el)` — label[for=…] lookups resolve within the element's own shadow root instead
  of failing against the light document.
- **Polling trigger** (1.2s) added: MutationObservers on the light DOM never see shadow-tree
  mutations, so the observer alone never fired when the modal opened/changed steps. Poll +
  debounced scheduleAutoFill is the reliable driver; plus a load-time kick.
- Verified end-to-end in a browser harness that mirrors the real structure (modal inside a
  `#interop-outlet` shadow root, decoy light-DOM "Next"): auto-advanced the pre-filled contact
  step, filled an EEO select + AI-answered a question inside the shadow root, paused on an
  unknown question, banked BOTH the AI answer and the human's typed answer on the Continue
  click, advanced to the review step, never clicked Submit, never clicked the decoy Next.

## Update 2026-07-01 (late) — v1.1.0: self-healing injection + learn-from-human

Root cause of "Easy Apply does nothing" on ATS-powered postings (e.g. Lever "Apply to
Serverfarm"): the form lives in a **same-origin `linkedin.com/preload` iframe**; content
scripts don't run in subframes by default, and manifest registration never reaches frames
created before an extension reload (orphaned copies spam `chrome-extension://invalid`).
Fixes:
- `background.js` now **force-injects content.js programmatically** — per-frame on
  `webNavigation.onCompleted`/`onHistoryStateUpdated` (linkedin.com filter) and into all open
  LinkedIn tabs on `runtime.onInstalled` — so a reload needs no manual tab refresh ever again.
  content.js is wrapped in a run-once-per-frame guard, making repeat injection a no-op.
- content.js subframe support: `IS_TOP` gates page-level features to the top frame; in a
  subframe whose text reads like an application, the whole document is treated as the modal;
  question containers fall back to generic label-block detection when LinkedIn's form classes
  are absent; a load-time fill pass runs since a prebuilt iframe never mutates.
- **Learn-from-human (the Jobright loop), both content.js and autofill.js:** any question that
  learned answers + AI can't fill now PAUSES auto-advance with a "fill in and click Next —
  Alicia will remember" banner; the human's Next click banks their typed answer for future
  applications, then advancing resumes.
- Verified in a browser harness replicating the exact parent-heading/iframe-form layout:
  detection, fill, AI-partial answer, human-teach pause, banking of both answers, resume to
  Submit (never clicked).

## Update 2026-07-01 — v1.0.0: reliable auto-apply + tabbed UI

This session hardened the auto-apply pipeline end to end and reorganized the side panel.

**LinkedIn Easy Apply (`content.js`):**
- Modal detection now has fallbacks (known classes → any open `[role="dialog"]` that says
  "apply" and contains form controls), so LinkedIn class churn degrades gracefully.
- Typeahead fields (City etc.) are resolved properly: type → wait for the listbox → click the
  best suggestion. Typed-only values fail LinkedIn validation; this was a top flakiness cause.
- The fill pass is strictly sequential (contact → resume attach → custom questions → THEN
  auto-advance), so Next is never clicked while a fill/AI answer is still resolving.
- Learned-answer capture is a delegated capture-phase listener on the modal — it survives
  LinkedIn re-rendering the footer buttons. Still: AI-answered steps pause for human review;
  the human's Next click (with any edits) is what gets learned.
- If the resume upload step is empty, the stored resume file (see below) is attached.
  Submit is NEVER clicked — allowlist advance patterns only.

**External ATS (`autofill.js` — NEW FILE, replaces the inline `runUniversalAutofill`):**
- Standalone injected engine for Workday/Greenhouse/Lever/iCIMS/Ashby/etc. Reads everything
  from `chrome.storage` itself and reports back via `UNIVERSAL_FILL_RESULT` messages.
- Adds over the old version: Workday-style ARIA-combobox dropdowns, learned-answer reuse,
  batched AI answers for custom questions (pauses for review, learns from the human's
  confirming click, then resumes), resume file attach via DataTransfer, account-creation
  passwords (per-site, saved to Site Passwords), and DOM-settle waits between wizard steps.
- **Survives page navigations:** clicking "Auto-Fill Open Application" on a non-LinkedIn page
  starts a 20-minute session for that tab (`autofillSessions` in storage); `background.js`
  re-injects autofill.js on each page load in that tab while the page is the same site or a
  known ATS domain. Submit/Apply/Create-Account buttons are never clicked.
- The resume file itself (base64, ≤5 MB) is now stored as `resumeFile` when a resume is
  uploaded in the panel, so ATS file inputs can be filled.

**UI (`sidepanel.html` + tab code at the end of `sidepanel.js`):**
- Five tabs — Apply / Search / Tracker / Tools / Chat. Every feature kept, just grouped.
  Last-used tab persists (`activeTab` in storage).

**Verified:** all four JS files pass `node --check`; the autofill engine was run end-to-end
against a synthetic 4-step ATS wizard (contact + account creation + EEO select/radio/ARIA
combobox + resume file + learned/AI custom questions) in a real browser — all fields filled
correctly, AI answers paused for review, the human's edit was what got learned, filling
resumed after the confirming click, and the Submit button was never clicked. Live LinkedIn /
Workday behavior still needs Jordon's load test (agent browser tools can't use his session).

---

# Previous handoff (2026-06-30)

A complete handoff for continuing the **Career-mode / Job Coach** work. This session turned
the existing Chrome extension into a free, AI-powered job-search assistant for Alicia by
wiring it to the **Wagner-GPT** free backend and adding four headline capabilities.

- **Repo:** https://github.com/jordan23wagner-ops/Job-Assistant
- **Canonical local folder (LOAD THIS ONE):** `C:\Users\Jordon\Job-Assistant`
- **Sister project / backend:** Wagner-GPT PWA — `C:\Users\Jordon\Wagner-GPT\wife-gpt`
  (repo https://github.com/jordan23wagner-ops/Wagner-GPT, live https://wagner-gpt.vercel.app)

---

## ⚠️ Folder gotcha (read first)

There are **three copies** of this extension on disk. Only one is current:

| Folder | State |
|---|---|
| `Downloads/alicia_job_assistant_extension/...` | STALE (6/24) — ignore |
| `Downloads/Job-Assistant/` | STALE (6/26, git @ 676bb27) — ignore |
| **`C:\Users\Jordon\Job-Assistant`** | **CANONICAL** — all session work + GitHub origin |

Chrome must **Load unpacked** from `C:\Users\Jordon\Job-Assistant`. Earlier this session a
stale Downloads copy was loaded, so new buttons "didn't appear" — it was the wrong folder.
The Downloads copies hold nothing not in the canonical folder + GitHub (only a few old
screenshots). Safe to delete them once confirmed.

**Side-panel reload gotcha:** reloading the extension while the side panel is *open* does NOT
refresh the panel HTML. To pick up changes: close the panel → reload on `chrome://extensions`
→ reopen the panel.

---

## What this is

A Manifest V3 Chrome extension (side panel) that helps with a LinkedIn-centered job search.
Pre-existing strengths (kept): self-contained PDF/DOCX resume parsing (`parsers.js`, pure-JS
inflate, no libs), LinkedIn job scraping (`content.js`), an application tracker, themes, and a
suite of AI tools (analyze job, tailor resume, cover letter, interview prep, mock interview,
company research) — all funneled through **one function, `callGroq()`** in `sidepanel.js`.

**Why an extension, not a PWA feature:** auto-pulling LinkedIn jobs, finding people, and
auto-filling application forms require code running in the user's logged-in browser tab —
only an extension can do that. A hosted PWA cannot read linkedin.com's DOM or fill forms on
other sites. (See `flagcheck` note below.)

---

## Backend: 100% free, no API key (the "combine" with Wagner-GPT)

The extension previously required the user's own **Groq** API key. It now routes every AI call
to **Wagner-GPT's free `/api/chat`** (Ollama Cloud → NVIDIA NIM fallback), so it's **$0 for the
user** and shares the "Alicia" persona/backend.

- **The seam:** `callGroq(messages, temperature, maxTokens)` → `rawBackendCall()` POSTs
  `{ messages, newMessage, model:'auto' }` to `https://wagner-gpt.vercel.app/api/chat` and reads
  the **NDJSON delta stream** (`{"delta":"..."}\n … {"done":true}\n`), concatenating deltas into
  the one-shot string the UI expects. The last message = current user turn; everything before it
  (incl. the tool's **system prompt**) is sent as `messages` history, which Wagner-GPT forwards to
  the model with roles intact.
- The Groq key requirement and onboarding key screen are **gone** (dead onboarding code remains
  but never shows).
- Wagner-GPT added **CORS** on `/api/chat` (commit `28b5217`) — though the extension's
  `<all_urls>` host permission bypasses CORS anyway; it's there for future web callers.
- **Verified live:** the backend honors the request shape, respects system prompts, and streams
  correctly.

---

## Features built this session

### 1. Auto-pull + AI fit-filter — "⚡ Scan & Rank These Jobs"
On a LinkedIn **Jobs search results** page, scrapes the visible job cards and ranks every one by
fit to the saved resume (free Ollama), best first, with a colored score badge + one-line reason.
- `content.js` `scrapeJobList()` reads search-result cards (robust selector fallbacks) →
  `SCAN_JOBS` msg → `JOBS_SCANNED` reply.
- `background.js` relays `SCAN_JOBS` to the active tab (injects `content.js` if needed).
- `sidepanel.js` `rankScannedJobs()` sends resume + job list, gets strict JSON
  `[{i,score,reason}]`, sorts desc, renders. Gated on a saved resume.
- Button lives in the JOB SEARCH section under "Search LinkedIn Jobs".

### 2. People to reach out to + prepped outreach — "🤝 Find People to Reach Out To"
On a job posting, scrapes the **"Meet the hiring team"** contacts and drafts a tailored LinkedIn
outreach note per person.
- `content.js` `scrapeHiringTeam()` reads hirer cards / "who can help" module (header-text +
  class fallbacks) → `SCAN_PEOPLE` → `PEOPLE_FOUND`.
- `sidepanel.js`: button shown when a job is detected; per-person **Draft/Redraft** + **Copy**.
- **Outreach messages are editable** (a `<textarea>`) and **hard-capped at 300 chars**
  (LinkedIn connection-note limit) two ways: `enforceLimit()` cleanly trims the AI draft at a
  sentence/word boundary (never mid-word), and the textarea `maxlength` blocks editing past 300.
  Live `N / 300` counter (red at cap). The model overshoots char counts, so the limit is enforced
  in **code**, not the prompt.

### 3. Expanded autofill — contact fields + non-LinkedIn ATS
"⚡ Auto-Fill Open Application" now fills **contact fields** (first/last name, email, phone, city,
state, zip, LinkedIn, website) in addition to EEO, and works on **any site** — Greenhouse, Lever,
Workday, etc. — not just LinkedIn.
- **How it works cross-site:** the button injects a **self-contained `runAutofill(profile, eeo)`**
  into the active tab via `chrome.scripting.executeScript` (extension has `scripting` +
  `<all_urls>`). The content script only runs on linkedin.com, so injection is what enables
  external ATS.
- Matches each field by **label + name/id/autocomplete/placeholder**; fills text inputs
  (React-aware native value setter) and answers EEO selects/radios by fuzzy-matching saved
  options. **Skips already-filled and hidden fields; never submits.** Reports "Filled N fields."
- Contact info is entered in the **Application Auto-Fill** section (✎ Edit) and saved with the
  EEO answers under `profile` / `eeoPrefs` in `chrome.storage.local`.
- The original `content.js` EEO observer still **auto-fills EEO as the LinkedIn Easy Apply modal
  appears** (unchanged); the manual button does contact+EEO on any site.

---

## File map (extension)

```
manifest.json     # MV3; content script matches linkedin.com only; perms: scripting, tabs,
                  #   storage, sidePanel, activeTab; host_permissions <all_urls>
background.js     # service worker: relays DETECT_JOB / SCAN_JOBS / SCAN_PEOPLE / AUTOFILL_EEO
                  #   to the active tab (injects content.js if not present)
content.js        # runs on linkedin.com: job detection (detectJob), scrapeJobList (Scan&Rank),
                  #   scrapeHiringTeam (People), EEO observer autofill on Easy Apply
parsers.js        # self-contained PDF + DOCX text extraction (pure-JS inflate, no libs)
sidepanel.html    # the whole UI (sections: Current Job, tracker, Job Search, App Auto-Fill, Tools)
sidepanel.js      # all UI logic + callGroq/rawBackendCall (backend seam), Scan&Rank, People+
                  #   outreach, runAutofill (injected), profile/EEO storage, chat, tools
styles.css        # themed (4 themes via CSS vars); scan/person/pf-input styles added this session
resume.txt        # Alicia's resume (sample/default)
```

---

## How to develop / verify

1. **Load:** `chrome://extensions` → Developer mode → Load unpacked → `C:\Users\Jordon\Job-Assistant`.
   After edits: close panel → reload → reopen panel.
2. **Syntax check:** `node --check sidepanel.js` (and content/background) catches JS errors.
3. **Verification split (IMPORTANT):** an agent CAN verify the **AI prompts** (curl the live
   `/api/chat`), **pure logic** (`node -e` unit tests — done for `enforceLimit` and field
   matching), and **syntax**. **Live LinkedIn scraping + form autofill must be load-tested by the
   user** — browser MCP tools are read-only on LinkedIn and can't use the user's session.
4. **When a scraper finds nothing:** LinkedIn churns class names. The pattern this session: paste a
   one-liner into the **LinkedIn tab** console that prints candidate selectors + a sample card's
   outerHTML, then tighten the selectors. (`scrapeJobList` / `scrapeHiringTeam`.)
5. **Commits:** the harness blocks committing on `main`, so branch → commit → `git checkout main`
   → `git merge --ff-only` → `git push origin main`. End messages with the Claude co-author line.

---

## Known limitations / next tweaks

- **Workday autofill:** text fields fill, but Workday's custom (non-`<select>`) dropdowns likely
  won't — they're not real form controls. Greenhouse/Lever should fill cleanly.
- **Scan & Rank** ranks on card-level data (title/company/location) only — a fast relevance pass.
  Deeper per-job fit uses the existing "Analyze Job" tool. Could fetch each job's description for
  richer scoring (more requests = more LinkedIn rate-limit risk).
- **People** only surfaces the job page's "Meet the hiring team" (low risk). Broader people-search
  (company employees) would need navigating company pages — more account risk; not built.
- **Scraper selectors** are best-effort against current LinkedIn DOM and will need occasional
  upkeep as classes change.
- **Account safety:** kept human-in-the-loop (drafts + autofill, never auto-submit, no aggressive
  scraping) to protect Alicia's real LinkedIn account.

---

## Commits this session

**Job-Assistant** (newest first):
- `b1c21a8` feat: expanded autofill — contact fields + non-LinkedIn ATS
- `94e8946` fix: hard char limit + editable outreach messages
- `55bab76` feat: people to reach out to + prepped outreach messages
- `03d02bd` feat: auto-pull + AI fit-filter (Scan & Rank These Jobs)
- `99653b3` feat: route AI through Wagner-GPT free backend instead of Groq key

**Wagner-GPT** (the backend, same session — see that repo's HANDOFF.md):
- `28b5217` feat: CORS on /api/chat (for this extension)
- `ccadb09` docs: preview-deploy workflow + status
- `e10f58d` feat: Phase 7 — manage/revoke shared links
- `d6795ca` feat: Phase 4 — Artifacts / Canvas (sandboxed iframe)
- `24afbc1` feat: Phase 3 — Pyodide in-browser code interpreter

---

## The `flagcheck` repo (reference, not used directly)

`jordan23wagner-ops/flagcheck` is a **paid** MCP server (Anthropic API + x402 $0.01/req crypto)
that returns structured job analysis (A–F grade, ATS score, red flags, salary, match). We do
**not** call its endpoint ($0/month rule). Its analysis **prompts** (`api/scan-job.js`,
`api/analyze.js`) are good source material if you want to add a structured "grade this job" card
to the extension — port the prompt, run it on the free Wagner-GPT backend.

---

## What's next (options)

1. **Tune autofill** for whatever ATS fields don't catch (need the field label + site).
2. **Structured job-grade card** in the extension (port `flagcheck` prompts → free backend).
3. **Richer Scan & Rank** (fetch descriptions for deeper fit) — mind rate limits.
4. **Back to Wagner-GPT PWA:** held phases **5 (Deep Research)** and **6 (Voice loop)**, now
   unblockable via the Vercel preview-deploy workflow (push a feature branch → preview URL with
   real `/api` → verify → merge).
