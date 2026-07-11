# Job-Assistant ("Alicia AI") — Engineering Handoff

## Update 2026-07-11 (latest) — first automated test suite, against the REAL autofill.js

Closes a gap flagged in the same audit that led to the LinkedIn default-off change below: every
ATS-specific fix this project has ever shipped was found by manually clicking through a real
posting, with zero automated regression coverage on the actual field-filling logic — meaning a
future edit could silently break a platform that used to work. New: `package.json` + `jsdom`
devDependency (first Node/npm infra this repo has had; the extension itself still ships as plain
files, no build step) and `tests/harness.mjs` + `tests/fixtures/*.html` + `tests/autofill.test.mjs`.

The harness `eval()`s the real, unmodified `autofill.js` into a jsdom window (it's a plain
content-script IIFE with no exports, so this is the only way to run it as-is) against a fixture
page, mocking `chrome.storage`/`chrome.runtime` and waiting for the same `UNIVERSAL_FILL_RESULT`
message `background.js` listens for in production. Two fixtures so far (Greenhouse, Lever — real
field structure captured live from Cloudflare's and Palantir's actual application forms, not
synthetic markup), deliberately NOT exhaustive across every supported ATS yet — see README's new
Testing section for how to add more and the three jsdom-specific gotchas that had to be worked
around (`offsetParent` always null with no real layout engine, a `MutationObserver` that turns into
a genuine infinite loop without a browser tab to eventually navigate away, Node's test runner
needing `--test-force-exit` or a clean run still hangs ~30s on exit).

One real, useful finding the tests turned up immediately: "Preferred First Name" fields get filled
with the plain first name too (the firstName regex matches "first name" as a substring, and there's
no separate `profile.preferredName` to fill it from instead) — a defensible default, not a bug, but
now a documented, asserted-on behavior instead of an undiscovered side effect.

4/4 tests passing, ~2s total run time. `npm install && npm test` from the repo root.

## Update 2026-07-11 (later) — v1.13.38: LinkedIn Easy Apply auto-fill now defaults to OFF

A gap audit flagged a real account risk that was previously just accepted implicitly: LinkedIn's
ToS (Section 8.2) explicitly bans automated application tools, with enforcement up to a permanent
ban — a different, higher-stakes risk category than autofilling any other ATS (Greenhouse, Workday,
etc.), which have no such blanket prohibition. Jordon's decision: keep autofill everywhere else,
disable it on LinkedIn by default.

- **`content.js`** (LinkedIn-only — this doesn't touch `autofill.js`, which handles every other ATS
  and is unaffected): the master `autoFillEasyApply` flag now defaults to OFF (`!== true` gates the
  fill/advance pass, was `=== false`) instead of defaulting ON. Applies to both the per-form
  fill/advance engine and the batch "Queue" auto-open-Easy-Apply behavior — running the queue with
  fill disabled would just auto-click through empty, unfilled modals across many postings, which is
  both useless AND the more bot-pattern-looking half of the feature (rapid timed clicks across many
  jobs) even without any field ever being typed into, so it's gated the same way with an explanatory
  banner instead of silently doing nothing.
- **`sidepanel.html`/`sidepanel.js`**: the existing "Auto-fill applications" toggle (already
  LinkedIn-scoped, already user-facing — this was a real explicit opt-in point already built, not a
  new feature) now starts unchecked, and its label spells out the LinkedIn ToS risk so turning it
  back on is an informed choice, not an accidental default.
- Manual "Auto-Fill Open Application" button (one explicit user-triggered click on the currently
  open form) is untouched — it's a deliberate one-off action, not the unattended background
  automation the ToS risk is actually about.
- No changes to job search/discovery on LinkedIn (`scrapeJobList`/`harvestJobs`-style code )— only
  the apply-automation surface is affected.

## Update 2026-07-11 (latest) — v1.13.37: fixes driven by a live 10-job apply test — the custom-domain binding bug is properly fixed this time (root architecture change, not another patch), plus the Databricks iframe stall, the Workday nav-panel tie, and a large Workday company-name data-quality issue

A live 10-job end-to-end test (Claude in Chrome, real résumé, real postings) surfaced concrete
failures that static analysis and logic tests had missed. Root-caused and fixed each with live
verification, not just code review:

1. **Custom-domain binding (Stripe, Databricks) — fixed at the architecture level.** The v1.13.35
   fix (registration-order + tab-adoption) still lost the race live. Real fix: **the extension now
   opens every applied-to tab itself** via `chrome.tabs.create` from its privileged background
   context — not subject to popup-blocking the way page-JS `window.open` is — and binds the
   explicit session to the exact returned `tab.id` synchronously, before the tab even starts
   navigating. This eliminates the race by construction instead of trying to win it.
   `pendingApplyUrls`/`findPendingMatch` stay as a fallback for any tab that reaches a matching URL
   through some other path, but are no longer load-bearing for the common case. Batch cap raised
   5→10 to match. Web app (`aliciaBridge.js`/`Jobs.jsx`) no longer calls `window.open` itself when
   the extension is present — doing so now would open every job twice.
2. **Databricks-class stall — root cause confirmed live**: the real application form is a
   `<iframe id="grnhse_iframe">` embedded in the company's own page, not yet populated with a real
   ATS `src` when the one-time child-frame scan runs at initial injection. The top-frame instance
   can never find a form in its own document and loops the nav-choice panel forever. Fixed with a
   `chrome.webNavigation.onCommitted` listener (scoped to tabs with a live session, known ATS hosts
   only) that catches the iframe's real navigation whenever it happens, plus autofill.js explicitly
   requesting a rescan when it can't find a form in its own frame.
3. **Workday's "Start Your Application" modal — nav-choice tie fixed.** "Apply Manually" and
   "Apply With LinkedIn" scored identically in `navScore`, so the single-strong-candidate auto-click
   never fired and every Workday posting needed a human pick. OAuth-handoff "Apply With X" buttons
   now score as a dead-end (never auto-clicked anyway — a third-party login should be a deliberate
   human choice), which was also the correct safety call independent of the tie.
4. **"✓ applied" badge dishonesty — resolved as a side effect of fix #1.** It used to fire on mere
   message-receipt; now it only fires when the extension confirms it actually opened+bound a tab,
   which is now a guaranteed synchronous fact instead of a race outcome.

See Wagner-GPT's own HANDOFF for the matching web-app-side changes and a large Workday
company-name data-quality fix (~6,000 registry rows) found while investigating the "Ffive"/"Nb"
company-name reports.

## Update 2026-07-11 — v1.13.36: autofill completion audit — submit-stop enforcement mapped, one real auto-submit hole closed (tiny inline forms), one convention-dependent risk documented

A full engine audit (completion + safety) confirmed the multi-step advance design is sound: STOP
patterns are checked BEFORE advance every pass (`autofill.js` wizard loop), so a submit button
coexisting with a Next button always wins; advance is allowlist-only; unrecognized/localized labels
stall safely rather than guess. The whole never-auto-submit guarantee funnels through (a) the
stop-before-advance comparison order in the wizard loop, (b) the contents of `STOP_PATTERNS`, and
(c) `hasRecognizedForm()` keeping `^apply$` on the safe STOP side — treat any change to those three
as a submit-safety regression.

**Closed this round — the minimal-inline-form hole.** `hasRecognizedForm()` requires a password/file
input or ≥3 text-ish controls, so a 1–2 field application (name+email, no résumé upload) fell into
the NO-form path, where an "Apply" button is deliberately auto-clicked to OPEN the application — but
on such a page that button IS the submit of the tiny form. New `looksLikeInlineFormSubmit()` guard:
any nav/apply-start candidate sitting inside a `<form>` with visible text inputs is skipped (applied
in `findApplyStartButton()` and `navCandidates()`, which also covers learned-clicks, the single-
strong-candidate auto-click, and the choice panel's options). A real details-page Apply link lives
outside any input-bearing form, so this costs nothing on legitimate pages. Syntax-checked; NOT yet
live-tested (needs a real tiny-form page).

**Documented, not fixed (convention-dependent, any heuristic risks breaking legitimate advances):**
a site whose FINAL submit is labeled exactly "Continue"/"Proceed"/"Review"/"Next" with no
stop-matching button present would be advance-clicked. No known ATS does this; revisit only with a
live example in hand.

Known stall gaps (safe stalls, still open): Greenhouse SPA-nav, EEO race/ethnicity multi-select
combobox, non-English button labels, LinkedIn bare "Submit", ADP "+1" phone prefill.

## Update 2026-07-11 — v1.13.35: the "Apply opens the posting, then nothing fills" root cause found by a full static trace — the pending-URL registration RACES the tab's own navigation and always loses; fixed with registration-time tab adoption + host/path-prefix matching

The v1.13.34 repro (Stripe posting via the web-app Apply: description page opens, no auto-advance,
manual click to the real `/apply` form also fills nothing, zero banners) is explained end-to-end
without needing the live logs:

1. **The race.** `Jobs.jsx` calls `window.open(job.url)` FIRST (it must — the user gesture) and
   `sendApply()` after. The tab starts navigating immediately, while the registration still has to
   travel postMessage → bridge.js → `runtime.sendMessage` → MV3 service-worker wake → two
   `chrome.storage` round-trips. `onBeforeNavigate` therefore fires with `pendingApplyUrls` still
   empty ("no matching pending entry — session NOT created"), and `onUpdated`'s late-adoption is
   racing the very same write, losing on any fast load or cold service worker.
2. **No second chance on a custom domain.** Aggregator links redirect (each hop is another chance to
   bind), which is why this mostly worked before. Stripe's Greenhouse board returns `absolute_url`
   directly on `stripe.com` — no redirect, so the one-and-only navigation is the one that raced.
3. **The manual click can never recover.** Only the LISTING pathname was registered
   (`…/jobs/listing/x/123`); the real form is a DIFFERENT pathname (`…/123/apply`), and both binding
   predicates used exact normalized-URL equality — so even the user clicking through by hand binds
   nothing. With no session, `onHistoryStateUpdated` skips too, and `stripe.com` isn't in
   `ATS_HOST_RE` so no passive path exists either. autofill.js was simply never injected: exactly
   the observed total silence (this also predicts the live logs would show `WEBAPP_APPLY: registered`
   then nothing — no `run() start` line in the page console).

Fix (all in `background.js` + one ordering change in the web app):

- **Registration-time adoption (the core fix): `adoptOpenTabsForPending()`.** After `WEBAPP_APPLY`
  stores its pending URLs, scan the ALREADY-OPEN tabs and bind/inject any that match — the mirror
  image of the navigation-event binders, so it no longer matters which of the two arrives first.
  Adopted complete tabs get the same treatment `onUpdated` would give them (Adzuna resolve /
  aggregator click-through / `injectAutofillWithTailoredResume`).
- **Host + path-prefix matching: `findPendingMatch()`.** Exact key first, else a same-host entry
  whose path is a '/'-boundary prefix of the tab's (or vice versa) — binds the listing→`/apply`
  pathname change. Strictly narrower than what an explicit session may already follow via
  redirects, so no safety loosening.
- **`normUrl` hardened**: scheme and `www.` dropped from the key (an http→https or www redirect
  used to break equality).
- **Web app (`Jobs.jsx` applyOne)**: `sendApply()` now fires (synchronously, un-awaited) BEFORE
  `window.open`, giving registration a head start; the batch flow keeps its open-first order
  (pop-up counting) and relies on adoption.

Verified: `node --check` clean; the real `normUrl`/`findPendingMatch` (textually extracted so the
test can't drift) pass 9 logic cases incl. the Stripe listing→apply shape, www/scheme drift, the
`/jobs/12`-vs-`/jobs/123` boundary, expired entries, and cross-host rejection. NOT yet live-tested
(needs the user's browser): re-run the same Stripe apply; expect `[Alicia][apply-debug]
WEBAPP_APPLY: adopted already-open tab …` in the service-worker console and `run() start` in the
page console, then auto-advance to the form. The apply-debug logging stays in until that live
confirmation; remove it once closed.

## Update 2026-07-11 — v1.13.34: temporary diagnostic logging for a live repro of "web-app Apply opens the posting, then nothing fills" on a custom (non-ATS-allowlisted) careers site

Live repro from the user: searched via the Wagner-GPT Jobs tab, clicked Apply on a Stripe posting
(`stripe.com/jobs/listing/...`, tagged "greenhouse" as its source — Stripe serves its own custom-
skinned careers site over the Greenhouse API rather than a `boards.greenhouse.io` URL). The chat
confirmed the extension accepted the apply handoff ("Alicia is auto-filling..."), but the opened tab
just showed the plain job description with no visible activity. Manually clicking Stripe's own
"Apply for this role" button (same-origin path change to `.../8036325/apply`) landed on a real form
(First/Last/Email visible) — and that also stayed completely blank; no banner, nothing.

**Root cause not yet confirmed** — code reading (not a live test; this sandbox's egress is blocked
to arbitrary sites like stripe.com, confirmed via the proxy's `recentRelayFailures`) shows several
mechanisms that SHOULD have handled this:
- The explicit web-app apply session (`autofillSessions`, set in `onBeforeNavigate`/`onUpdated` in
  `background.js`) is NOT gated by `ATS_HOST_RE` — a custom, unlisted host like `stripe.com` should
  still get an explicit session and an `autofill.js` injection.
- `autofill.js` already has a details-page-to-form auto-advance step
  (`advanceToApplicationForm()`/`findApplyStartButton()`) specifically for "Apply Now"-style buttons
  on a details page with no form yet — Stripe's actual button text ("Apply for this role") matches
  its `APPLY_START_PATTERNS`, so it should have auto-clicked through without the user needing to.
- The same-origin path change (`/8036325` -> `/8036325/apply`) should be caught by either a full
  navigation (`chrome.tabs.onUpdated`) or, if it's an SPA route push, by
  `chrome.webNavigation.onHistoryStateUpdated`.

Since NEITHER the self-driven advance nor the user's own manual click resulted in a fill, the most
likely explanation is that the explicit session was never actually bound to this tab in the first
place (so nothing ever got injected on the first page, and the SPA-nav/full-nav listeners for the
second page found no session to work from either) — but this needs a live re-test to confirm rather
than more speculation.

Added temporary `[Alicia][apply-debug]` console logging (removable once this is closed) at every
handoff step in `background.js` (`WEBAPP_APPLY` registration, `onBeforeNavigate` binding,
`onUpdated`'s inject-or-skip decision, `onHistoryStateUpdated`'s SPA re-inject) and in
`autofill.js`'s `run()` entry (current URL + `hasRecognizedForm()`, `findApplyStartButton()` hit,
`advanceToApplicationForm()` result). **Next step:** reproduce the same Stripe (or similar
custom-careers-site) apply once more, then paste back both the background service worker's console
(`chrome://extensions` -> Alicia -> "service worker" -> Inspect) and the applied tab's own DevTools
console — the `[Alicia][apply-debug]` lines will show exactly which step the chain breaks at.

## Update 2026-07-09 — v1.13.33: checkbox-group question CONFIRMED fixed after 3 attempts (round 23→30, closed); ADP's value-commit step now includes focus/blur, following a fully isolated live repro of the framework reverting a bare synthetic value-set

Rounds 30-32 finally closed the two longest-running mysteries of the session down to one, with the
other genuinely fixed and verified.

1. **Checkbox-group ("select all that apply") question CONFIRMED WORKING on live re-test** — Shield
   AI now correctly checks 3 of 6 relocate-office options matching the posting's own listed locations,
   with zero panel/human involvement needed (the question is answered directly during the normal
   fill pass, same as any other multi-select). This closes a bug first found in round 23, through two
   failed fix attempts (v1.13.27, v1.13.28) before v1.13.28's corrected label lookup turned out to be
   the actual fix all along — it just took until round 30 to get a clean live re-test confirming it.
2. **ADP: value-commit step confirmed to actively revert a synthetic value-set, isolated completely
   outside Alicia's own code.** A hand-run console script using the EXACT same `setNativeValue()` +
   `fire()` (input/change) technique used successfully on every other tested ATS platform was run
   directly against `#guestFirstName` on the real ADP form — the value reverted to empty within
   500ms. This is the single most decisive result of the ADP investigation: it rules out "Alicia's
   fill pass never reaches these fields" (a hand-run, completely separate script showed the identical
   failure) and confirms ADP's own framework is actively re-syncing/rejecting the field's state absent
   something Alicia wasn't doing. Added `el.focus()` before and `el.blur()` after the value-set+fire
   sequence in `fillStdFields()` specifically — a real user always focuses before typing and blurs
   before moving to the next field, so this is a faithful rather than exotic interaction, and matches
   the working theory that ADP's framework re-syncs its internal state specifically on blur.

**CONFIRMED on live re-test (round 33): ADP is closed.** First Name ("Jordan"), Last Name ("Wagner"),
and Email ("Jordan23wagner@gmail.com") all filled correctly and held their values (re-checked 5s
later, unchanged) — the first time in 6 rounds of testing these fields have held real data on ADP.
The focus/blur fix worked. The banner still reads "Filled what it could — this step needs your
input," but it's now ACCURATE rather than false: Mobile Number is still genuinely blank.

One small, separate, lower-priority follow-up noticed in passing: ADP's phone field
(`#login_view_phone`) apparently ships pre-populated with a literal `"+1"` country-code default,
which is a non-empty, non-blank string — `fillStdFields()`'s early-exit guard
(`if (el.value && el.value.trim()) continue;`) correctly-by-its-own-logic treats that as "already has
a value" and skips it, even though `"+1"` alone isn't a complete phone number. This is a narrow,
single-field gap (not a repeat of the "total miss" class of bug), and the banner already correctly
flags it as something the human needs to complete — not chased further this round since it wasn't
prioritized, but noted here in case it recurs on other platforms with a similar pre-filled
country-code pattern.

**Still open, lower priority, no fresh angle yet:** general Greenhouse SPA-nav gap, and the EEO
race/ethnicity multi-select combobox (Smartsheet/Greenhouse).

## Update 2026-07-09 — v1.13.32: ADP's real root cause found — camelCase field IDs never matched any contact-field regex (norm() doesn't split camelCase); diagnostic marker removed now that its question is answered

Round 29 confirmed detect.js DOES execute on ADP (the temporary marker appeared every time, from the
listing page through the consent modal through the real form) — settling the "never injected" question
definitively. But it also surfaced something new: the auto-fill offer banner appeared for the first
time in 5 rounds of ADP testing, Alicia responded to it, and the response banner said "Filled what it
could — this step needs your input" while First Name, Last Name, and Email were all still confirmed
empty. That specific banner text only fires from the `hasVisibleError()` branch — meaning ADP's own
form was showing a visible validation error that Alicia's correction pass couldn't resolve, not a
"nothing happened" case as previously assumed.

1. **Root cause found: ADP's field IDs (`guestFirstName`, `guestLastName`, `guestEmail`) are camelCase,
   and `norm()` never splits camelCase boundaries** — it only lowercases and strips punctuation, so
   `"guestFirstName"` normalizes to the single unbroken token `"guestfirstname"`. Every contact-field
   matcher in this file keys off `\b` word-boundary regexes (e.g. `\bfirst name\b`/`\bfirstname\b`),
   and there is no word boundary between "guest" and "First" once concatenated — so the match silently
   failed and these fields were never even recognized as contact fields, let alone filled. This
   directly explains both the empty fields AND the (previously assumed unrelated) `hasVisibleError()`
   banner — ADP's own required-field validation was correctly complaining about fields Alicia never
   attempted. Added `splitCamel()`, inserting a space at every lower-to-upper transition
   (`"guestFirstName"` → `"guest First Name"`) before normalizing, applied specifically to the `name`
   and `id` attributes inside `signals()` — the two attributes actually likely to be camelCase code
   identifiers — rather than changing `norm()` itself globally, which also processes human-readable
   label/question text elsewhere in the file where this transformation is unnecessary (though harmless
   as a no-op there too).
2. Removed the temporary ADP-only diagnostic marker from `detect.js` (v1.13.31) now that the question
   it existed to answer — was the script even executing on ADP at all — is conclusively settled (yes).

**Still open:**
- **ADP fix (item 1) is not yet verified against a live re-test** — plausible and well-evidenced, but
  the next round needs to confirm First/Last/Email now actually fill, and that the `hasVisibleError()`
  banner either goes away or accurately reflects a genuinely different remaining problem.
- **Checkbox-group still fully open after 3 fix attempts.** All structural explanations are now ruled
  out: the selector matches, the label is reachable, and every checkbox is confirmed visible, enabled,
  and unchecked via direct live query. The one remaining question needed before touching this a 4th
  time: does Alicia's question panel ever show an entry for the relocate-offices question at all? This
  distinguishes "discovery never adds the item" from "discovery succeeds but the AI answer doesn't
  clear the 55%-match threshold, correctly falling through to the human" from "it gets checked then
  silently reverted." (A `setNativeValue()`-style fix for the `checked` property was considered as a
  parallel to how text inputs handle React-controlled fields, but EEO radio buttons on this exact same
  Lever tenant are confirmed working with a plain `.checked = true` assignment already, which weakens
  that hypothesis enough that it wasn't shipped without the panel diagnostic first.)
- General Greenhouse SPA-nav gap and the EEO race/ethnicity multi-select combobox — both still fully
  open, no new hypotheses since their last updates.

## Update 2026-07-09 — v1.13.31: confirmed the two v1.13.30 fixes hold, ruled out shadow DOM for ADP and "label unreachable" for checkbox-groups via direct live queries, added a temporary ADP-only diagnostic marker to settle "never injected" vs "fails silently"

Round 28 was diagnostics-only by design and delivered exactly that: both of last round's fixes
(date-picker asks the human instead of faking "Negotiable"; the false "didn't start" banner is gone)
confirmed working live, plus two ruled-out hypotheses that narrow — without yet solving — the two
remaining open items.

1. **ADP: shadow DOM ruled out with direct evidence.** 14 shadow roots exist on the page, but all
   belong to ADP's own UI chrome (`SFC-SHELL`, `SDF-BUTTON`, etc.) — the actual form fields
   (`#guestFirstName`, `#guestLastName`, `#guestEmail`, `#login_view_phone`) are confirmed plain
   `<input>` elements in ordinary light DOM, directly reachable via `document.querySelectorAll`. So
   v1.13.29's content-mutation-watch fix not helping isn't explained by "can't see the fields at all"
   — the fields ARE visible to a query, `hasApplicationForm()` should find them, yet detect.js
   produces zero observable effect on ADP, four rounds running. Since I can't tell from page-level
   queries alone whether `detect.js` is even being INJECTED there at all (vs. injected and failing
   silently downstream), added a small, ADP-scoped, TEMPORARY diagnostic marker — a visible pink bar
   detect.js paints onto the page the INSTANT it executes, before any of its own guard logic — to
   settle that ambiguity directly. Should be removed once ADP is understood.
2. **Checkbox-group: both the container selector AND the question label are now confirmed reachable
   via the user's own direct console queries** (`ul[data-qa="checkboxes"]` matches;
   `.closest('.application-question')` finds the right element; its `.application-label` text is
   correct) — ruling out "the label isn't discoverable" as the cause, which was the entire premise of
   both v1.13.27 and v1.13.28's fix attempts. The one remaining unverified link in the discovery chain
   is whether the checkboxes themselves pass `checkboxGroups()`'s visibility filter
   (`visible(b) || visible(b.closest('label'))`) — Lever may hide the raw `<input type="checkbox">`
   via CSS in a way `offsetParent` reports as invisible, relying entirely on a custom-rendered visual
   checkbox. Needs one precise console check next round (see below) before touching this a fourth
   time.

**Still open:**
- ADP total miss (see item 1) — diagnostic marker shipped, needs a live check next round: does the
  pink "Alicia detect.js executed" bar ever appear on the real ADP form?
- Checkbox-group (see item 2) — needs:
  `Array.from(document.querySelectorAll('ul[data-qa="checkboxes"] input[type="checkbox"]')).map(b => ({ visible: b.offsetParent !== null, labelVisible: b.closest('label') && b.closest('label').offsetParent !== null, disabled: b.disabled, checked: b.checked }))`
  run on the live Shield AI page — if every entry comes back `visible:false, labelVisible:false`,
  that's the confirmed bug (the visibility filter drops all 6 boxes, so the group never reaches the
  `boxes.length >= 2` threshold in `checkboxGroups()`).
- **General Greenhouse SPA-nav gap still fully broken, and now fails completely silently** (no banner
  of any kind, confirmed after a full unhurried 30s wait) — still unexplained, lowest-confidence item
  of the three currently open; no new hypothesis yet, may need its own dedicated diagnostic round once
  the other two close out.
- EEO race/ethnicity multi-select combobox (Smartsheet/Greenhouse) — no new hypothesis since two
  rounds ago; still unexplained.

## Update 2026-07-09 — v1.13.30: date-picker fix from last round was typing free-text ("Negotiable") into a strict widget — now forced to ask the human; and a self-inflicted false-failure banner from last round's own detect.js change is fixed

Round 27 was a breadth pass (10 new-tenant applications) specifically meant to catch problems before
they compound — and it worked: it caught a real bug in code shipped THIS SESSION (last round),
alongside confirming/refuting three targeted fixes.

1. **v1.13.29's date-picker discovery fix worked (field is no longer blank), but the AI is typing
   "Negotiable" into Ashby's date-picker instead of a real date** — a strict widget that needs an
   actual parseable date, which the AI has no factual basis to invent (résumés don't state a future
   employment start date). Fixed by detecting date-picker-shaped fields
   (`el.closest('[class*="datepicker" i], [class*="DatePicker"]')`) and giving them a no-op
   `apply()` that always returns `false`, reusing the same mechanism combos/checkboxes already use to
   fall through to the human-ask panel on a failed apply — so the question now correctly gets asked
   directly rather than silently answered with unusable text.
2. **Self-inflicted bug: last round's own new "Alicia didn't start" failure message in `detect.js`
   was false-positiving on real, correctly-working fills.** The breadth pass found 3 of 7 Lever
   applications (FiscalNote, Zoox, PMA Consultants) showing "⚠ Alicia didn't start — try reloading
   the page" while several fields had genuinely, correctly filled (email, phone, location) — the
   real fill (multi-step DOM interaction plus an AI-answer network round trip for custom questions)
   routinely takes longer than the single fixed 3-second check I shipped last round to confirm the
   banner had appeared. Replaced the one-shot check with a poll (up to 10 checks × 2s = 20s of real
   running time) before concluding failure, and clear the box's own unrelated 30s auto-dismiss timer
   once the user has actually clicked something (previously could race with the new check).

**Still open:**
- **ADP Workforce Now: v1.13.29's content-mutation watch confirmed NOT to fix it** — no offer banner
  under any condition (full reload, waiting in place, triggering focus/interaction). New leading
  hypothesis, not yet confirmed: ADP's own component framework (`ActionLink2`/`MDFButton2` — a
  proprietary or heavily componentized UI, not plain HTML forms) may render its actual input fields
  inside a Shadow DOM, which regular `document.querySelectorAll` cannot see into regardless of timing
  — this would explain why NEITHER the original fixed-poll NOR the new content-watch ever helped,
  since it was never a timing problem to begin with. Needs a next-round check: whether any element on
  the page has a non-null `.shadowRoot`, or whether the actual form fields use non-standard/custom
  tag names.
- **Checkbox-group question still not fixed after THREE rounds.** Confirmed this round that the
  `ul[data-qa="checkboxes"]` selector correctly matches (`length` → 1 on live Shield AI), ruling out
  "selector doesn't match" as the cause. v1.13.28's label-lookup fix has not yet been confirmed
  working or failing on live re-test — next round needs exactly one more diagnostic:
  `document.querySelectorAll('ul[data-qa="checkboxes"]')[0].closest('.application-question')` (does
  it find a match?) and, if so, that match's `.querySelector('.application-label')` text.
- **General SPA in-page-navigation gap confirmed NOT Smartsheet-specific** — reproduced identically on
  Horizon Industries and Anduril Industries (both Greenhouse, reached via the page's own in-page
  "Apply" button): zero Alicia activity, no banner, all fields blank. This is a general Greenhouse
  SPA-navigation gap, not a one-tenant fluke — still unexplained; v1.13.26's detect.js guard fix and
  v1.13.29's content-watch apparently aren't sufficient for this specific navigation pattern either.
  Given the new false-failure-banner bug (item 2 above) may have been MASKING whether these three
  actually eventually got a real banner given enough time, this needs a clean re-test with the timing
  fix in place before concluding it's still fully broken.
- The EEO race/ethnicity multi-select combobox (Smartsheet/Greenhouse) remains unexplained — two
  hypotheses ruled out (missing preference, broken label association), no new hypothesis yet.

## Update 2026-07-09 — v1.13.29: labelText()'s own foundational fallback had the same closest()-too-early bug (fixes Ashby's date-picker discovery), and detect.js now watches page content directly instead of giving up after a fixed 4-second poll (targets ADP's total miss)

Round 26 delivered three genuinely new, page-console-only diagnostics (no chrome://extensions access
available in Claude Extension's environment — noted for future rounds) that finally pinned down two
long-open mysteries with concrete evidence, plus ruled out one hypothesis cleanly.

1. **Ashby's date-picker was never discovered as a question at all — root cause confirmed via full
   ancestor-chain markup: its `<label>` sits several DOM levels above the `<input>` as a sibling, not
   a wrapping ancestor**, e.g. `<div class="_fieldEntry_..."><label>When can you start a new
   role?</label><div class="react-datepicker-wrapper">...<input placeholder="Pick date..."></div></div>`.
   `labelText()`'s own final fallback — `el.closest('.form-group,fieldset,li,div,section')` — has the
   IDENTICAL closest()-stops-at-nearest-div bug already fixed twice this week for combos and checkbox
   groups, just never applied to this most-foundational, most-widely-used label-lookup function
   itself. With the label lookup failing, the field fell through to its placeholder text ("Pick
   date...", 2 words) instead of the real question ("...start a new role?", which contains "?" and
   would pass the wordy gate outright) and was silently never discovered. Separately confirmed live
   that the INTERACTION mechanism itself isn't the problem — both typing a date directly and clicking
   a calendar day commit cleanly on the page's own terms — so this really was purely a discovery gap.
   Added a shared `climbForLabel()`/`wideLabelText()` helper (refactoring `comboLabelText` to use the
   same primitive) and wired it in as a fallback — after `labelText()` and `aria-label`, before
   placeholder — in the text-input and `<select>` discovery passes. Purely additive: only consulted
   when the existing lookups already found nothing, so it cannot regress any field whose label was
   already resolving correctly.
2. **ADP Workforce Now's total miss, still unexplained after 3 rounds, now has a concrete root cause:
   confirmed `window.__aliciaAutofillRun` stayed `undefined` even after clicking Alicia's own
   "Auto-fill" offer on a DIFFERENT SPA-nav case (Smartsheet)** — meaning `autofill.js` never actually
   executed at all, not that it ran and found nothing. Re-reading `detect.js` against the
   already-documented gap (its own comment block: "some SPA route changes never call pushState at
   all... no navigation event fires for them at all") shows `detect.js`'s OWN detection poll — a fixed
   8-try/4s loop that gives up permanently — has exactly this same blind spot, and unlike
   `autofill.js`'s own rerun logic, it had no MutationObserver fallback to catch a later-appearing
   form when no navigation event ever fires (ADP's real form is reached via `jobId` query-param
   changes on the identical URL path — very plausibly a pure in-memory view swap with no
   `history.pushState` at all, matching the exact case that comment already called out). Replaced the
   fixed poll with an open-ended (2-minute-bounded, debounced) MutationObserver watch, mirroring
   `autofill.js`'s own approach. Also made `detect.js`'s messaging failures visible in the PAGE console
   (`chrome.runtime.lastError` was previously silently swallowed) and gave the offer box itself
   visible "Starting…"/timeout feedback, since a silent failure there was indistinguishable from the
   box just closing normally — this should make the NEXT diagnostic round more informative even if
   this fix doesn't fully close the gap.

**Still open:**
- **Checkbox-group question still not fixed after TWO shipped attempts** (v1.13.27 and its v1.13.28
  correction) — still all-unchecked on live re-test, with no new markup evidence this round to explain
  why. Rather than guess a third time, next round needs exactly one diagnostic:
  `document.querySelectorAll('ul[data-qa="checkboxes"]').length` on the live Shield AI page, to
  confirm whether the selector even matches at all before investigating further.
- **EEO race/ethnicity multi-select combobox (Smartsheet/Greenhouse)** — ruled out both "missing
  saved preference" (confirmed configured and working on Lever's native equivalent) and "broken label
  association" (confirmed live: real semantic `label[for] → input[id]` markup, not a styled div).
  Whatever's blocking this is neither of the two most obvious causes — needs fresh hypotheses, not
  yet identified.
- The date-picker fix (item 1) still depends on `setNativeValue()` + `fire()`'s synthetic
  'input'/'change' events actually committing the value the same way genuine typing does for
  react-datepicker specifically — this is plausible (the same mechanism already works broadly across
  this codebase for other React-controlled fields) but NOT the exact interaction that was tested live
  (real keystrokes + Tab/blur were tested, not a synthetic bulk value-set). If it's still blank next
  round, the next hypothesis is a missing blur/focusout event specifically for date-picker-shaped
  fields.
- The ADP fix (item 2) is a strong, well-reasoned hypothesis but not yet confirmed against a live
  re-test — genuinely possible ADP's total miss has additional causes beyond what this fixes.

## Update 2026-07-09 — v1.13.28: self-inflicted bug fix — v1.13.27's checkbox-group question label lookup was defeated by the exact closest()-stops-too-early anti-pattern that had already been fixed elsewhere in this file

Round 25 verification caught that the checkbox-group fix shipped last round did nothing at all on
live re-test. Re-reading it against the EXACT markup already captured in round 23 found the bug
immediately, with no live access needed: `checkboxGroupQuestionLabel()`'s
`ul.closest('.application-question, fieldset, li, div')` returns the NEAREST ancestor matching ANY
clause in a comma-separated selector — and on Lever's real markup, the checkbox `<ul>`'s immediate
parent is itself a plain `<div class="application-field...">`, which matches the bare `div` clause
instantly, before ever reaching the outer `<li class="application-question...">` that actually
contains the sibling `.application-label`. This is the identical anti-pattern already fixed twice
before in this file (`comboLabelText`'s wide-wrapper climb, and `comboContainer`'s wide-vs-narrow
selector ordering) — reintroduced here by not applying the same lesson. Fixed by trying the specific
`.application-question` class first, falling back to `fieldset, li`, and only then to a bare `div`,
in both `checkboxGroupQuestionLabel()` and the discovery loop's `cgCont` computation.

**Still open, pending a live diagnostic before any fix is attempted (see round 25's report for
detail):**
- EEO race/ethnicity multi-select combobox (Smartsheet/Greenhouse) — confirmed the user's EEO profile
  IS fully configured (verified working on Lever's native equivalent fields for the same categories),
  so this is a genuine Greenhouse-specific widget-recognition gap, not a missing-preference
  situation. v1.13.27's `comboLabelText` fold-in did not fix it — need the full upward ancestor chain
  and the actual tag/class of the visible question text (may not be a real `<label>` element, same
  as Lever's `.application-label` div-not-label pattern).
- SPA in-page navigation (Smartsheet) — the passive offer banner now appears correctly (v1.13.26/27
  progress confirmed), but clicking "Auto-fill" after the SPA-routed form loads does nothing at all —
  every field stays blank. Need to check, right after clicking Auto-fill: does
  `typeof window.__aliciaAutofillRun` come back `'function'` in the page console (confirms autofill.js
  actually executed), and does `document.getElementById('alicia-apply-banner')` exist anywhere in the
  DOM? This distinguishes "never ran" from "ran but found nothing."
- ADP Workforce Now — still a total miss past the consent gate, unchanged from round 24. Need to
  check for iframes specifically on the real (post-consent) form page — `document.querySelectorAll('iframe').length` and each one's `src`/`title` — since a DOM query on the top document alone
  can't see into an iframe's own document.
- Ashby date-picker — interaction mechanism now confirmed (both typing-then-Tab and clicking a day
  cell commit cleanly on the page's own terms), but it's still unclear whether Alicia ever ATTEMPTS
  either — `isComboControl()`/the wordy-gate text-question pass don't appear to exclude this field on
  paper, so if it's still blank the field was likely typed into and then reverted by react-datepicker's
  own validation, OR never reached at all. Need: does `data-alicia-answered="1"` appear on the date
  input after a run, and does the question ever show up in Alicia's question panel?
- Ashby toggle-button pairs — class names confirmed stable across 2 postings, but same-tenant only
  (both were OpenAI). Still need a DIFFERENT company's Ashby posting to know if the hash is
  platform-stable or per-tenant-build.

## Update 2026-07-09 — v1.13.27: EEO multi-select comboboxes were never classified as EEO at all (same label-discovery gap, different call site), and a new checkbox-group ("select all that apply") question type is now discovered and answered

Round 24 confirmed v1.13.26's sponsorship fix and banner-durability fix both hold cleanly on live
re-test, with no reversion. It also confirmed the SPA-navigation gap is still NOT fully fixed (a
second, different route into it — Greenhouse's own in-page "Apply" — still shows zero Alicia
activity) and that ADP Workforce Now's real form is a total miss even past its consent gate — both
still open, see below. Two of the four widget shapes found in round 23's deliberate hunt got clean,
well-evidenced fixes; the other two (date-picker, toggle-button pairs) are deferred pending a live
interaction diagnostic rather than shipping a guessed fix for something as fiddly as a calendar click.

1. **EEO multi-select comboboxes (e.g. "race/ethnicity — select all that apply") were never even
   classified as EEO, confirmed via full markup: a react-select multi (`aria-multiselectable="true"`
   menu, `role="option"` items) whose trigger carries no name/aria-label/placeholder mentioning race
   at all.** Root cause: `fillEeoComboboxes` classified fields using `eeoKey(signals(trig))`, and
   `signals()` calls the OLD narrow `labelText()` — the exact same wide-wrapper gap fixed for custom
   questions via `comboLabelText()` two rounds ago (v1.13.25), just never applied to this second call
   site. Folded `comboLabelText(trig, container)` in as an additional classification signal. Also
   added an explicit `closeComboMenu()` after a successful multi-select pick, since multi-select
   react-selects don't auto-close the menu on selection the way single-selects do.
2. **New question type: checkbox-group ("select all that apply" rendered as a plain checkbox list,
   not radios).** Confirmed live on Lever (Shield AI): "What office(s) would you be willing to
   relocate to?" used Lever's own semantic native markup (`ul[data-qa="checkboxes"]`,
   `.application-label` — a Lever test-id attribute and BEM-ish class, not hashed CSS modules, so
   reasonably stable across Lever tenants), previously entirely undiscovered since only
   `radioGroups()` (mutually-exclusive) existed. Added `checkboxGroups()`/`checkboxLabel()`/
   `checkboxGroupQuestionLabel()` (mirroring the radio-group helpers) and
   `applyCheckboxGroupAnswer()`, which matches a comma-separated multi-answer against every option
   independently (reusing the same `multi:true`/comma-separated-answer convention already established
   for adapter-provided multi-select items) rather than all-or-nothing. Wired into
   `findUnansweredCustomQuestions` and `markAnswered()`.

**Still open:**
- **SPA in-page navigation gap not fully fixed** — reaching a Greenhouse application via the site's
  OWN client-side "Apply" routing (not a fresh URL load) still produces zero Alicia DOM elements and
  no banner, re-confirmed live on Smartsheet even after v1.13.26's detect.js guard fix. The
  `maybeOfferAutofill`/`onHistoryStateUpdated` wiring may not be firing for this specific navigation
  pattern, or something else is blocking it — needs a background/service-worker console check next
  round (the page console alone can't distinguish "never injected" from "injected, found nothing").
- **ADP Workforce Now: total miss even past the consent gate.** With the scoped consent-modal
  authorization, the real application form loads fine, but Alicia never appears at all — zero
  `alicia`-prefixed DOM elements, no console activity, checked immediately and 10+ seconds later. The
  privacy modal was A blocker, not THE blocker; something else about ADP's real form (framework:
  "ActionLink2"/"MDFButton2", likely a heavily componentized Angular/proprietary UI) needs its own
  fresh diagnostic — not yet understood.
- **Ashby date-picker widget** (react-datepicker library, portal-rendered popper with
  `role="option"` day cells) — deferred. Needs a live check of whether typing a date directly into
  the input commits a value, or whether a specific calendar day must be clicked, before shipping any
  fix — guessing at calendar-click mechanics without verification risks a worse-than-nothing "looks
  like it worked but didn't" result.
- **Ashby toggle-button pairs** (segmented Yes/No buttons, not native radios) — deferred. The
  classnames captured (`_container_pjyt6_1`, `_option_1svni_32`) look like build-hashed CSS modules,
  not stable semantic classes — need to confirm whether the SAME hash appears across multiple Ashby
  postings (stable enough to key off) or varies per-deployment, before designing a selector.
- The multi-select EEO combobox fix (item 1 above) still depends on the user's `eeo-race` preference
  actually being configured in Alicia's saved settings — if it was never set, the field correctly
  stays blank by design (never guess a protected demographic answer), which would look identical to
  the bug from the outside. Worth checking directly next round.

## Update 2026-07-09 — v1.13.26: required sponsorship/authorization questions were misfiled as voluntary EEO and silently skipped forever, detect.js's permanent run-once guard defeated its own re-injection fix, and the "Alicia answered N questions" banner is now durable across reruns

Round 23 (targeted verification + a deliberate hunt for other "whole class" gaps) confirmed v1.13.25's
combobox-label fix works for most fields, then root-caused why ONE specific field-shape still failed,
plus a follow-up bug that undermined the ADP fix shipped last round, plus a full explanation (not just
a workaround) for the banner-reverting behavior first reported two rounds ago.

1. **GitLab's required "Will you now or in the future require sponsorship for a visa" question was
   still silently and PERMANENTLY skipped, even with v1.13.25's label-discovery fix in place — root
   cause found: `eeoKey()` classifies "sponsor"/"authoriz"/"eligible to work"-style labels as EEO
   categories, and `findUnansweredCustomQuestions` excludes ANYTHING `eeoKey()` recognizes from ever
   being asked or AI-answered, with no configured saved preference to fall back on.** That blanket
   exclusion is correct for genuinely voluntary, legally-protected self-ID categories (race, gender,
   veteran status, disability, sexual orientation, gender identity) — it is NOT correct for
   sponsorship/work-authorization, which are ordinary REQUIRED eligibility screening questions, not
   protected-characteristic self-ID. Added `isVoluntaryEeoKey()` and use it (instead of a blanket
   `eeoKey()` truthy check) for the three discovery-exclusion sites in
   `findUnansweredCustomQuestions` and for `countFilledEeoFields()`'s "please double-check" disclosure
   scan — sponsorship/authorization now flow through the normal learned-bank → AI-answer →
   ask-human pipeline when no saved preference is configured, exactly like any other required custom
   question, while an already-configured saved answer still auto-fills silently exactly as before.

2. **detect.js's own permanent run-once guard (`if (window.__aliciaDetectRan) return`) defeated last
   round's background.js fix for the ADP total stall, and explains an identical case found fresh on
   Smartsheet.** Content scripts survive same-page SPA route changes (no fresh `window`), so once the
   FIRST load (an ATS listing page, no application form yet) finished its poll and found nothing, that
   boolean stayed `true` forever — every LATER re-injection (background.js correctly re-offering once
   the real form's URL/route lands, per v1.13.25) was a complete no-op. Confirmed live: zero Alicia
   UI/activity at all after clicking Greenhouse's own in-page "Apply" button. Replaced the permanent
   guard with an in-flight-poll / already-showing-offer guard only, so a genuinely fresh re-injection
   can always re-scan the page's current (possibly now-different) content.

3. **The "Alicia answered N questions — review and continue" banner reverting to generic phrasing,
   first reported in round 21, is now understood completely: it's not interaction-triggered, it's
   ANY qualifying DOM mutation anywhere on the page** (the engine's own MutationObserver watches
   `document.body` with `{childList:true, subtree:true}`, debounced to at most once per 4s) —
   including ambient third-party page activity completely unrelated to the user (chat widgets, ad
   refreshes, live viewer counters). Confirmed live: the banner reverted after 30 seconds of
   deliberately zero interaction. Since `answeredItems.length` is local to each pass, any rerun that
   finds nothing NEWLY unanswered falls into a different one of the three terminal branches, whose
   banner text carries no memory that anything was ever answered. Fixed the same way the identical
   EEO-disclosure bug was fixed in v1.13.24: `applyAnswerToItem` now marks every control it fills
   (`data-alicia-answered="1"`) via a new `markAnswered()` helper, and a new `aiAnsweredNote()` (a live
   DOM-marker scan, mirroring `eeoNote()`) replaces the pass-local phrasing and is now appended to
   ALL FOUR terminal banners consistently (previously only the answered_review one mentioned answered
   questions at all).

**Still open:** GitLab's sponsorship fix needs live re-verification (untested against a real page
yet); the newly-confirmed sibling "whole class" gaps from round 23's deliberate hunt — multi-select
EEO chip comboboxes (e.g. "race/ethnicity — select all that apply"), custom date-picker widgets
(Ashby's start-date calendar popup), and checkbox-group questions (Shield AI's relocate-offices list)
— are real, confirmed, structurally novel widget shapes that need their own discovery logic, not yet
attempted; ADP's own privacy-policy consent gate blocks reaching its real form at all without explicit
consent authorization, separate from and prior to any Alicia-side issue.

## Update 2026-07-09 — v1.13.25: react-select combobox questions were being silently skipped entirely (GitLab, Smartsheet), a late third-party field-clobber watcher for the two banner paths that never had one, and a background.js fix for ADP's total stall

Round 22 (verification pass + 4 targeted deep dives) closed the loop on two long-standing "why does
this never get filled" mysteries and produced a strong, evidence-backed hypothesis for the ADP
Workforce Now total stall.

1. **Root cause found for GitLab's required eligibility questions AND Smartsheet's Education
   School/Degree/Discipline fields both going universally unfilled: `findUnansweredCustomQuestions`'s
   combobox branch computed the question's label from `labelText(trig)`, which stops at the
   trigger's own NEAREST `div` ancestor — for a react-select-shaped combobox that's the narrow inner
   control div (e.g. `select__control`/`select-shell`), never the wider wrapper where the field's
   real `<label>` actually sits as a sibling** (`<div class="select"><label>...</label>
   <div class="select-shell">...trigger...</div></div>`). An empty label fails the
   `if (!klabel || klabel.length < 8) continue;` gate, so the field was never even offered as a
   question — not asked, not AI-answered, not flagged, just silently blank. Added `comboLabelText()`,
   which reuses the wide wrapper `comboContainer()` already computes for value-reading and climbs up
   to 4 more ancestor levels looking for a `label`/`legend` before giving up.

2. **New watcher: `watchForLateRegression()`, for the "ready to submit" and "answered, review" banner
   paths, which had NO late-fix/late-regression watcher at all** — only the blocked/stop-button path
   got one (`watchForLateRequiredFieldFix`, v1.13.20). Confirmed live on Match Group (Lever): a
   "Current location" field Alicia had already filled correctly, on an already-"ready" page, went
   silently blank again ~8s later — the same plain-`.value`-set/no-DOM-mutation blind spot as the
   original bug, just discovered on the healthy side instead of the blocked side, where nothing was
   watching. The new watcher runs a bounded poll (max 6 checks × 3s) after those two banners; on a
   detected regression it runs a deliberately narrow corrective step (`lateRegressionRefill` —
   `clearSuspiciousSchoolInCompanyFields()` + the ATS adapter's `fillTypeaheads`, NOT a full
   `fillOnePass()`, since a background poll must never re-trigger the AI-answer pipeline or re-ask a
   question the human may be mid-answering), then reports whether it self-healed.

3. **background.js: ADP Workforce Now never showed Alicia's autofill offer at all — confirmed live,
   zero console errors, offer banner never appeared even after waiting.** Hypothesis, not yet
   re-verified live: ADP's listing and application views are the SAME URL path
   (`workforcenow.adp.com/mascsr/.../recruitment.html`), differentiated only by a `jobId` query param
   the app updates via `history.pushState` — so `chrome.tabs.onUpdated`'s single `'complete'` event
   (the ONLY place the passive "auto-fill available" offer was wired up) fires on the pre-form
   listing view and never fires again once the real form loads. The existing SPA-reinjection listener
   (`chrome.webNavigation.onHistoryStateUpdated`, added for exactly this class of problem in an
   earlier round) only re-arms an EXISTING session — it never gave the passive OFFER a second chance
   for tabs with no session yet. Refactored the offer logic into `maybeOfferAutofill(tabId, url)` and
   wired it to both events. **Needs live re-verification on ADP next round** — this is the most
   confident explanation given the evidence, but the total stall wasn't directly reproduced against
   the fix yet.

**Still open, insufficient information to fix yet:** (a) the `answered_review` banner's "other
required fields" note isn't durable across reruns that land in a different one of the three terminal
branches (reported live on GitLab: reverted to the generic message after opening one dropdown) — same
class of bug as the EEO-note fix in v1.13.24, but the note itself, not just the eeoNote() count, would
need to become a shared/durable computation rather than three independently-derived per-branch
strings; (b) Match Group showing NO banner at all on one application (not wrong text — no banner
rendered) — single occurrence, needs a repro with console/DOM access to diagnose; (c) Zoho Recruit's
own native image CAPTCHA blocking after an otherwise-excellent full autofill — expected/correct
behavior (Alicia surfaces it via its own panel and stops, never solves it), not a bug; (d) the
Wagner-GPT Tracker "saved → applied" transition (fixed this round in the Wagner-GPT repo, see its own
commit) needs a slower-motion re-check to confirm the transition is real and not instant.

## Update 2026-07-08 — v1.13.24: real data-loss bug found and fixed (location field clobbered by Lever's own async parser), banner gaps closed on a third code path, EEO disclosure no longer vanishes on rerun

Round 21 (breadth, 15 applications) surfaced the most serious finding of this whole "Current Company"
saga so far: not just a field staying wrong, but a previously-CORRECT field getting silently cleared.

1. **Real data loss, now fixed: Lever's own async résumé-parse feature (the same one responsible for
   the "Current Company" saga) can clear an already-correctly-filled "Current location" field as a
   side effect of its own batch update** — observed live landing at the exact same moment the company
   field self-corrected. Root cause: `atsFillLocationTypeahead`'s one-shot "already handled this field"
   marker was checked BEFORE any value check, so once a field was successfully filled once, it was
   never touched again — even after a third party cleared it back to empty. Fixed by only honoring the
   marker while the field still has a value; if something clears it afterward, Alicia now retries.
   Confirmed via the same round that this clobbering isn't universal (didn't happen on Zoox in the same
   round), consistent with tenant-configurable third-party behavior rather than something deterministic
   in Alicia's own code.

2. **The "Alicia answered N questions — review and continue" banner had the exact same
   undercounting gap fixed for the panel and stop-button paths two rounds ago, just never closed on
   this THIRD terminal banner.** Reproduced on 6+ GitLab/Ashby/Lever applications in one round — the
   banner said "just review and continue" while 3-5 required Select-style eligibility questions sat
   blank the whole time, never mentioned. Added the same `hasUnfilledRequiredField()` +
   `detectResumeUploadSiteError()` checks used on the other two paths.

3. **The EEO "please double-check these answers" disclosure was disappearing from the banner within
   seconds, confirmed on 3 separate applications, with the underlying answers unchanged.** Root cause:
   `result.eeoFilled` was a per-invocation counter on a fresh `result` object created on every run
   (including frequent mutation-observer-triggered reruns) — a rerun that did no NEW EEO filling (because
   the fields were already correctly filled by an earlier run) reported 0, silently dropping the
   disclosure even though the auto-filled EEO answers were still sitting right there. Replaced with
   `countFilledEeoFields()`, a live DOM scan for currently-answered EEO-classified controls, so the note
   reflects actual page state regardless of which run (or how long ago) did the filling.

Verified: `test-round21-fixes.js` — the location-typeahead fix is confirmed to retry a cleared-but-
previously-marked field while still skipping a field that genuinely still has its value; the
"answered N questions" banner now surfaces both required-field gaps and résumé site errors, matching
the other two terminal banners; the EEO note is confirmed to survive a rerun that does no new filling
(reproducing the old counter-based bug for contrast, then confirming the live-scan version doesn't
regress). `node --check` clean; all prior round test suites (5 through 20) still pass unchanged.

## Update 2026-07-08 — v1.13.23: Greenhouse résumé-upload site error surfaced (not fixable — Greenhouse's own bug), stale-banner root cause found (MutationObserver blind spot) and mitigated

Round 20 was a depth round targeting the two highest-value items Round 19's breadth sweep couldn't
resolve. Both got clean, complete diagnoses.

**Résumé-upload exception: root-caused, but it's Greenhouse's own bug, not Alicia's.** The three
previously-failing tenants all succeeded on a fresh navigation — the error only reproduced after
several Greenhouse forms had been processed in the same browser tab (found via a deliberate same-tab
reuse test). Full diagnostic confirmed: the error never reaches the browser console — it's raw
`error.message` text painted directly into Greenhouse's own native field-error slot
(`<p id="resume-error" class="helper-text--error">`), meaning Greenhouse's own upload-handling code
threw internally and displayed its own exception text, unrelated to whether the actor is human or
automated. The underlying `<input id="resume">` markup was byte-identical between a failing and a
working tenant — same `accept` list, same `id`, no difference Alicia's own attach logic could
possibly be causing. This looks like a Greenhouse-side component/session lifecycle bug (something not
re-initializing correctly across repeated form navigations within one tab), which cannot be fixed from
this repo. What CAN be done: added `detectResumeUploadSiteError()`, which looks for exactly this error
slot and surfaces its message directly in Alicia's own banner/panel notes ("The site itself reported
an error attaching the résumé... this looks like a bug on the employer's own site... try reloading the
page and reapplying") — so a human hitting this sees a clear explanation and an actionable next step
instead of an unexplained empty required field.

**Stale "still needs work" banner: root cause found — a real gap in the MutationObserver rerun
mechanism, not the "Current Company" fix.** A deliberate before/after timing check confirmed the org
field self-corrected to a real employer about 8 seconds after the banner first rendered (Lever's own
async résumé-parse feature completing later than the initial scan), but the banner text never updated
— it stayed on the stale "still looks empty" warning indefinitely. Root cause: a plain `.value`
property assignment (how frameworks commonly update a controlled input) creates no `childList` or
`attributes` DOM mutation for a MutationObserver configured with only `{childList: true, subtree:
true}` to see — the observer is structurally blind to exactly this kind of change, so the existing
rerun mechanism never had a chance to fire and re-evaluate the banner. Rather than restructure the
observer (attribute observation still wouldn't catch a live DOM property with no attribute reflection,
and broadening it further risks far more rerun churn for marginal benefit), added a narrowly-scoped,
bounded polling fallback: `watchForLateRequiredFieldFix()` starts a lightweight check (not a full
pipeline rerun — can't interfere with anything in-flight) every 3 seconds for up to 30 seconds after
the "still needs work" banner fires from `hasUnfilledRequiredField()` specifically, and flips the
banner to the real "ready" state the moment the blocker clears. Bails out immediately if a question
panel appears (a different, unrelated blocker) rather than ever falsely declaring readiness.

Verified: `test-round20-fixes.js` — `detectResumeUploadSiteError` surfaces the exact diagnosed error
text and returns null when no error is present (no fabricated notes); the polling logic is confirmed
to detect a field resolving a few checks after the initial snapshot, to bail out without a false
"ready" claim if a panel appears mid-poll, and to never falsely declare readiness within its bounded
check window when genuinely still blocked. `node --check` clean; all prior round test suites (5
through 19) still pass unchanged.

## Update 2026-07-08 — v1.13.22: first high-volume test round (17 applications, 17 tenants) — panel-undercounting fixed, two new issues flagged for diagnostic

First round using the new "Tier 1" high-density testing format: 17 applications across 17 distinct
tenants (10 Lever, 5 Greenhouse, 2 Ashby) in a single round, reported in a compact structured format
instead of prose per application. This immediately surfaced patterns that single-application testing
hadn't made visible before.

**Confirmed holding, no action needed:** the Lever "org"-field fix (10/10 Lever apps got a real
employer, several with `org` itself marked required — none got a school), the Ashby button-pair
required-field detection, and the résumé-upload fix on at least one Greenhouse tenant (Atoms/cssmerge).

**Fixed this round: the "Alicia needs N answers" panel was consistently undercounting how much was
actually left to do.** Reproduced 4 times across 2 platforms (Humata Health, FiscalNote, Anduril,
Success Academy) — e.g. FiscalNote's panel said "needs 1 answer" (an *optional* GitHub URL field)
while 5 actual required fields sat blank; Anduril's panel said "needs 1 answer" while 3 required
`<select>` fields were empty. Root cause: the panel only ever lists items the discovery pipeline
recognized as an unanswerable custom *question* — it was never a comprehensive "everything still
blank" checklist, and a plain required text/select field the discovery logic doesn't recognize as a
"question" at all (most of what's actually driving these gaps) never had a chance to appear there. The
comprehensive scan for exactly this (`hasUnfilledRequiredField()`) already existed, but only ever ran
right before the "ready to submit" banner — a shown panel always broke out of the loop before reaching
that check. Now also runs whenever the panel is shown, surfacing a combined note ("Also worth checking:
other required fields on this page are still empty beyond what's listed in this panel") alongside the
existing EEO-fill note, so the human isn't misled into thinking the panel is the whole story.

**Flagged, not fixed — need dedicated diagnostics next round:**
- **New, high-value: a thrown JS exception during résumé upload** — `Cannot read properties of
  undefined (reading 'uploadFile')`, rendered visibly on the page, reproduced identically across THREE
  different Greenhouse tenants (Elevations Credit Union, Success Academy, Judi Health/Capital Rx), while
  a fourth Greenhouse tenant (Atoms) attached cleanly in the same round. This looks like a real,
  reproducible bug (not random site flakiness) tied to a specific newer Greenhouse upload-widget variant
  some tenants have and others don't — needs the widget's markup and, ideally, a full stack trace before
  attempting a fix, since guessing at a mechanism this specific has repeatedly gone wrong this session.
- **Humata Health (Ashby): autofill appears to have done almost nothing** (no standard fields filled at
  all — not even name/email) yet still produced a 2-item question panel, meaning the run did execute
  and reach the panel-showing code, just without filling anything conventional along the way. Possibly a
  non-standard/white-labeled Ashby integration with different markup throughout; needs the actual field
  markup to diagnose rather than a guess.
- **3Pillar Global (Lever): banner claimed required fields were still empty when the tester visually
  confirmed everything was filled.** Likely a timing artifact rather than a real bug — the SAME round
  independently observed and self-corrected an identical false-negative-on-first-check pattern on a
  different tenant (Zoox), consistent with the banner being a snapshot that can trail a slightly-later
  successful re-fill from the mutation-observer rerun. Noted, not treated as confirmed until it
  reproduces without an immediate-recheck explanation.

Verified: `test-round19-fixes.js` confirms the required-field note now surfaces alongside the panel
(and combines correctly with the EEO note rather than one overwriting the other), while a genuinely
clean form produces no spurious extra note. `node --check` clean; all prior round test suites (5
through 18) still pass unchanged.

## Update 2026-07-08 — v1.13.21: stale react-select panel root-caused and fixed, résumé-upload `acceptsTxt` wildcard bug found and fixed

Round 18 confirmed the v1.13.20 Lever fix (correct employer filled, no intermediate wrong value
observed) and the Ashby button-pair banner fix (correct yellow warning, no false "ready" claim) both
hold. It also delivered clean, complete diagnostic markup for the two remaining flagged items — both
now root-caused and fixed.

**Stale "needs N answers" panel — root cause confirmed and fixed.** The full uncut markup showed the
already-answered field is a react-select combobox where the trigger's own `<input>` always has
`value=""` (react-select only uses it for typing/searching); the actual selected value lives in a
sibling `.select__single-value` div several DOM levels away. `comboContainer()`'s fallback selector
included a bare `div` alternative, and since `.closest()` returns the NEAREST ancestor matching ANY
part of a combined selector, it stopped at the trigger's own immediate parent div — never reaching the
wider wrapper that actually contains the sibling value display. `comboValueText()` therefore searched a
container that structurally could not contain the answer, read nothing, and the field got treated as
unanswered despite visibly showing "No." Fixed by trying a wider, react-select-shaped wrapper
(`select__container`/`select-shell`/`Select-container`/`select-container` class patterns, all confirmed
in the live markup) first, falling back to the original narrow search only when none of those exist —
strictly additive, no regression risk for comboboxes that don't use this naming convention.

**Ashby résumé-upload gap — a real bug found one level deeper than expected.** The diagnostic showed
the required field's accept list (`application/pdf,...,image/*,video/*,audio/*`) has no `.txt` or
`text/plain` entry — but `acceptsTxt()`'s check (`accept.indexOf('*') >= 0`) treated the mere presence
of ANY asterisk as "accepts everything," including the partial wildcards `image/*`/`video/*`/`audio/*`,
which only mean "any image/video/audio subtype." That false positive meant Alicia confidently attached
a `Resume.txt` the site's own validation would reject — and once `el.__aliciaResumeAttached` gets set
(right after the attempt, regardless of whether the site accepts it), nothing ever retries with the
correct file. Fixed `acceptsTxt()` to require an exact match on one of the comma-separated accept-list
entries (`*`, `*/*`, `.txt`, or `text/plain`) instead of a loose substring search. Also added a
last-resort fallback in `attachResume`: if there's tailored text but the input doesn't declare `.txt`
support AND there's no stored original file either, attempt the tailored text anyway rather than
guaranteeing a blank required field — the `accept` attribute is only an OS file-picker hint, not an
enforced restriction on a programmatically-assigned file, so this can still succeed even when
`acceptsTxt()` correctly says the input "shouldn't" take it.

Verified: `test-round18-fixes.js` — `comboContainer()` is confirmed (via a constructed DOM matching the
live-diagnosed structure) to find the wider wrapper containing the sibling value display, while the old
logic demonstrably does not; `acceptsTxt()` is confirmed to correctly reject Ashby's real accept list
(previously a false positive) while still accepting genuine wildcard/text-plain lists; the résumé
fallback decision logic now correctly prefers a stored original over a wrongly-accepted `.txt` attempt,
and only reaches the last-resort tailored-text attempt when no stored original exists at all. `node
--check` clean; all prior round test suites (5 through 17) still pass unchanged.

## Update 2026-07-08 — v1.13.20: the actual explanation for "Truckee Meadows Community College" — it was never Alicia's own pipeline; Ashby button-pair Yes/No questions

Round 17 re-tested the Lever fix on option 2 (a fresh posting on an already-tested tenant, since the
fixed 60-posting Search pool contains no new Lever tenants) — still broken. Also re-tested the Ashby
résumé fix on a brand-new posting — still broken there too. Given the required-field banner (a
DIFFERENT fix from the exact same v1.13.19 commit) is confirmed correctly showing the yellow warning
instead of a false green "ready," this ruled out a stale extension for the third time and forced a much
closer look at the actual code, this time asking a different question: **is this field even reaching
the code I keep patching, at all?**

**Answer: no — not on the failing tenants.** `findUnansweredCustomQuestions`'s text-field discovery
gates every candidate behind a "wordy" check (`label.split(' ').length >= 4` or a question mark or a
handful of keywords) specifically so a bare one-word caption never gets misread as an open question. A
label reading "Current company" (2 words, no "?", no keyword match) fails that gate — meaning on any
tenant that words the field this tersely, Alicia never treats it as a discoverable question **at all**,
and every fix from the last five rounds — all of which operated entirely inside that discovery →
learned-bank → AI-answer pipeline — could only ever have zero effect there, no matter how correct the
logic inside was. The value was coming from somewhere else entirely: **Lever's own client-side
"parse résumé to prefill" feature**, which some tenants have enabled and which independently makes the
exact same education-vs-employment mistake Alicia's own (long since fixed) AI used to make. By the time
Alicia's discovery scan runs, the field already has this wrong value, and the existing "already has a
value, leave it" logic — completely correct from Alicia's own perspective — just leaves a
third-party-injected wrong value sitting there untouched.

No amount of further work on Alicia's own question-discovery/AI-answer/bank logic could ever have
caught this, because the bug was never in that pipeline. Fixed with a deliberately blunt, independent
sweep — `clearSuspiciousSchoolInCompanyFields()` — that checks Lever's `input[name="org"]` field
directly (a DOM-level signal fixed across every tenant, unlike the visible label) for a school-shaped
value and clears it, regardless of who wrote it or whether Alicia ever "discovered" it as a question.
Runs at the start of every fill pass, so it also catches Lever's parse feature firing asynchronously
after Alicia's first pass (the existing mutation-observer rerun mechanism gives it another chance).

**New, cleanly diagnosed with live markup: Ashby's Yes/No questions are custom `<button>` pairs, not
native radio inputs, and "required" is marked via a CSS class rather than the `required`/
`aria-required` attribute.** This made them invisible to both the question-discovery pipeline (buttons
aren't a recognized control type anywhere) and the `hasUnfilledRequiredField()` safety net (no real
`required`/`aria-required` attribute exists anywhere in the widget) — so the "Filled and ready" banner
could fire with a required Yes/No question still completely blank. Extended
`hasUnfilledRequiredField()` with an Ashby-specific check: find each `ashby-application-form-field-entry`
container, check for a label whose class contains `_required_`, and treat it as unanswered if its
paired hidden tracking checkbox (present in every such widget, confirmed live) is unchecked. Scoped to
detecting "still needs an answer" only — teaching Alicia to actively answer this custom widget shape is
a larger undertaking left for a future round if it turns out to be worth it.

**Still flagged, not fixed — need one more diagnostic each:**
- Ashby's résumé upload is still failing on a brand-new posting even after the required-file-input
  preference fix — this specific posting may not mark its résumé input `required` at all (postings can
  configure this individually), which would explain the earlier fix not applying here; needs the same
  DOM snippet as before, for this specific posting.
- The stale "needs N answers" Greenhouse panel — this round's diagnostic revealed the underlying
  control is a newer "Remix"-styled react-select combobox (`select__container` / `select-shell`
  classes), different from previously-seen Greenhouse forms. Whether `visibleComboTriggers()` even
  discovers this trigger, or discovers it but `comboValueText()` fails to read its already-selected
  value, is still unconfirmed — the diagnostic markup was cut off by a content filter partway through.
  Needs the full, uncut trigger markup before attempting a fix.

Verified: `test-round17-fixes.js` — the Lever sweep clears exactly the contaminated field (school-named
value) while leaving genuine employer values, already-empty fields, and hidden fields untouched; the
Ashby button-pair detection correctly flags an unanswered required question via the live-diagnosed
label-class + hidden-checkbox pattern, while an answered, non-required, or hidden question is correctly
left alone. `node --check` clean; all prior round test suites (5 through 16) still pass unchanged.

## Update 2026-07-08 — v1.13.19: Lever's "org" field gets an ATS-level override (stop guessing label wording for good), hidden-required-file-input gap in the "ready to submit" safety net

Round 16 went back to general coverage after the dedicated Zoho/ADP hunt came up empty (19 searches,
no hits — that thread stays open, revisit only if one surfaces naturally rather than spending more
rounds hunting). Two real, concrete findings came out of general testing, one very familiar and one new.

**"Truckee Meadows Community College" — ninth and tenth Lever tenants (Match Group, Lumafield),
identical value both times.** The v1.13.18 answer-driven check ("does the answer name a school, unless
the question is clearly about education") was itself still guessing at label wording for the exemption
half — and apparently some Lever tenants word this field in a way that reads as ALSO covering
education (plausibly something like "Current Company/School," to accommodate candidates who are
current students), which trips the "isEducationQuestion" exemption and lets the answer through exactly
like every prior narrower attempt. Rather than add yet another label pattern, stopped trying to read
the label at all for this specific, extremely well-known case: Lever's own internal schema names this
field `org` on every single tenant, regardless of how any given tenant chooses to word the visible
question. `isSchoolAnsweringCompanyQuestion` now accepts the live control element and, when
`control.name === 'org'`, treats it as a real company field unconditionally — no label-reading
involved at all for this checkpoint. Wired through both live-DOM checkpoints (learned-answer
application, fresh AI answer); the bank-load filter has no live element to check and keeps its
label-only fallback.

**New: the green "Filled and ready" banner fired on an Ashby form while the required résumé upload
was still empty.** This directly contradicts the v1.13.13 required-field safety net, whose entire job
is to prevent exactly this. Root cause: `hasUnfilledRequiredField()` required every candidate to be
`visible()` before checking it — but required file inputs are routinely styled invisible and driven by
a separate "Upload"/drag-and-drop button (the same fact `attachResume` already accounts for), so a
still-empty, hidden-but-required résumé field was silently skipped by the safety check meant to catch
exactly that. Fixed by exempting file inputs specifically from the visibility requirement; every other
control type still requires visibility, since a genuinely conditionally-hidden field shouldn't be
flagged.

**Flagged, not fixed — need live DOM before attempting a fix:**
- A stale "Alicia needs N answers" panel listed several questions as unanswered on two separate
  Greenhouse forms even though those exact questions were already visibly answered on the page (2/2 and
  5/5 mismatches). Plausible mechanism: these are likely custom button-pair Yes/No widgets rather than
  native `<input type="radio">` elements, and whatever discovers/tracks their answered state may be
  reading stale info — but this needs the actual markup of one such widget to diagnose safely rather
  than guess.
- Three required Yes/No "button-pair" questions on an Ashby form (explicitly noted as not native radio
  buttons) weren't caught by the required-field safety net either — likely the same underlying gap as
  the panel issue above (a widget shape the discovery/required-check logic doesn't recognize), also
  needs real markup before a targeted fix.

Verified: `test-round16-fixes.js` — the Lever `org`-field override catches the exact reproduced
"Company/School"-style label regardless of wording, while leaving a genuine education field (no `org`
control) unaffected; the file-input visibility exemption is confirmed to detect a hidden required
résumé field while a genuinely conditionally-hidden required TEXT field remains correctly exempt.
`node --check` clean; all prior round test suites (5 through 15) still pass unchanged.

## Update 2026-07-08 — v1.13.18: the (hopefully actually final) fix for "Truckee Meadows Community College" — stopped guessing question phrasings entirely

Round 15's stated priority (deliberately hunting for a Zoho Recruit or ADP Workforce Now posting to
settle the Tracker-vs-Search theory) came back empty after a genuinely exhaustive effort — 19 distinct
searches across job titles, industries, and countries in Wagner-GPT's Search tab, zero hits for
`zoho`/`adp`/`workforcenow` in any result, only Lever/Greenhouse tags ever appearing. That specific
question stays open, not because it wasn't tested, but because the current job aggregator index
genuinely doesn't seem to surface these platforms right now — revisit if one turns up naturally rather
than continuing to spend rounds hunting for it.

The round's real news was a side-finding: "Truckee Meadows Community College" reappeared in "Current
Company" on an EIGHTH distinct Lever tenant (FiscalNote), despite being verified clean on the seventh
(3Pillar Global) just one round earlier.

**Root cause: the narrow "is this a company/employer-worded question" detector was still guessing at
phrasing, and guessing eventually loses.** Lever's application form has one underlying schema field
for this ("org" in its own internal JSON), but the VISIBLE label text for that field is not fixed
across tenants — some say "Current company," others may say "Organization," "Where do you currently
work," etc. `isSchoolAnsweringCompanyQuestion` only matched literal "company"/"employer" wording, so it
worked on every tenant that happened to phrase it that way and silently did nothing on any tenant that
didn't — which is exactly why it kept appearing to "come back" on new tenants rather than actually
being unfixed on the ones already tested.

Rather than add yet another phrasing to the regex (a losing, ever-growing game after four rounds of
exactly that), flipped the check around entirely: it now starts from the ANSWER, not the question — if
the proposed answer names a school/college/university, it's rejected UNLESS the current question is
clearly and specifically ABOUT education (contains "school," "degree," "GPA," "alma mater," etc.). This
requires no knowledge of how any given tenant phrases their "current employer" field at all. The
trade-off is intentionally asymmetric: a false positive here just means some legitimately
school-related answer to an unrelated question gets left for the human instead of auto-filled (safe,
mildly inconvenient); a false negative is the actual, eight-times-repeated harm this whole saga has
been about. Applied at the same three checkpoints as before (bank-load filter, learned-answer
application, fresh AI answer) with no other changes needed.

Verified: `test-round15-fixes.js` reproduces the FiscalNote failure mode directly (differently-worded
questions — "Organization," "Where do you currently work?" — that the old regex would have missed) and
confirms the new check catches all of them, while genuine education questions and genuine non-school
answers remain completely unaffected regardless of wording. `node --check` clean; all prior round test
suites (5 through 14) still pass unchanged.

## Update 2026-07-08 — v1.13.17: Ashby résumé-upload root cause (required-input preference), essay answers were capped too short, silent-exception banner

Round 14 confirmed the v1.13.16 "Current Company" fix held on a SEVENTH distinct Lever tenant
(3Pillar Global correctly got "Modernizing Medicine," not a school) — and supplied a clean live DOM
diagnostic that pinned down the Ashby résumé-upload bug exactly, plus surfaced two more real issues.

1. **Ashby résumé upload — root cause confirmed via live DOM inspection.** The page has TWO
   `input[type="file"]` elements: one belonging to Ashby's own "autofill this form from your resume"
   convenience widget (not required, decorative), and the actual required submission field
   (`id="_systemfield_resume"`, `required=""`). Both can independently look like a résumé upload by
   label text, so `attachResume` could attach to either — and attaching to the decorative one leaves
   the real required field empty with no visible error, exactly matching what was reported. Fixed by
   preferring any `required` file input over non-required candidates when both exist; falls back to
   considering all candidates when none are marked required, so single-file-input sites are unaffected.

2. **Essay-style answers were capped at 1-2 sentences even when the question explicitly asked for
   200-400 words.** The "Why Anthropic?" essay got answered this round (an improvement over last
   round's blank), but at 38 words against a requested 200-400. Root cause: the per-item prompt hint
   for every textarea was the blanket `[short paragraph]`, and the system prompt's "short, professional
   answer (1-2 sentences)" instruction had no exception for a question that states its own target
   length. Added a `WANTS_LENGTH_RE` detector (matches "200-400 words," "at least N words," "in
   detail," etc.) that swaps in a "[substantive answer matching the requested length]" hint for
   textareas whose own label asks for one, plus a matching exception in the system prompt.

3. **New, general safety fix: a run can throw and stop with ZERO visible sign anything happened at
   all.** On an Anduril Greenhouse posting, the passive "Auto-fill?" banner was explicitly accepted,
   yet nothing filled — no banner, no ask-panel, nothing. Traced to the outer `catch (err)` block:
   it sets `result.status = 'error'` and reports internally, but never calls `showBanner()` — so a
   thrown exception looks EXACTLY like "Alicia never ran," making it impossible to tell an injection
   gap apart from a real code bug from the outside. Added a banner showing the actual exception
   message in that catch block. This doesn't explain what specifically went wrong on Anduril (still
   unknown — Wagner-GPT's Tracker also showed a false "✓ applied" status on that same job, a
   Wagner-GPT-side issue out of scope here), but the next time this happens, the exact error will be
   visible instead of indistinguishable from silence.

Verified: `test-round14-fixes.js` — the required-file-input preference selects the real Ashby field
over the decorative helper (and falls back correctly when nothing is marked required); the essay-length
detector fires on the exact reproduced label and leaves ordinary textareas unaffected; confirms the
catch-all error handler now calls `showBanner`. `node --check` clean; all prior round test suites
(5 through 13) still pass unchanged.

## Update 2026-07-08 — v1.13.16: the actual fix for "Truckee Meadows Community College" — the deterministic check never covered the real application site

Round 13 confirmed the "Legal Name" fix works (a different fix from the exact same v1.13.15 commit),
which rules out a stale/unreloaded extension — so when the "Current Company" bug still showed up
unchanged on a SIXTH distinct Lever tenant (Aledade) despite last round's supposedly airtight
deterministic check, that meant the check itself had a real gap, not that it wasn't running.

**Root cause, finally: `findLearnedAnswer()` matches by FUZZY similarity, and my check was never
applied at the one place that actually mattered.** v1.13.15 added `isSchoolAnsweringCompanyQuestion()`
at two points: filtering the bank at load time (checking each record's OWN stored question wording)
and rejecting a *fresh* AI answer. But there's a THIRD point — the one actually responsible — where a
learned answer gets applied to the current page's field: `findLearnedAnswer(bank, qItem.label)` uses
fuzzy question-similarity matching, not exact text. A poisoned record originally banked under
different wording (e.g. "Where are you currently employed?" — which doesn't literally contain
"company" or "employer" as a whole word) sailed straight through the bank-load filter untouched
(since that filter only ever looks at the record's own stored wording), then fuzzy-matched THIS PAGE's
"Current company" label closely enough to apply directly — never reaching either of the two checks
added last round at all. That's why the "deterministic" fix appeared to have zero effect: it covered
two real spots, just not the one doing the actual damage.

Fixed by re-checking the learned answer against the CURRENT page's actual label at the moment it
would be applied (not the banked record's original wording) — `if (learned &&
isSchoolAnsweringCompanyQuestion(qItem.label, learned.answer)) learned = null;` right before
`applyAnswerToItem`. This closes the gap regardless of how the original poisoned record was phrased,
since it now checks what's actually on the page, not history.

**Two other Round 13 findings, not yet fixed — need more data, not another guess:**
- The résumé-upload fix from last round works on Greenhouse but is confirmed still broken specifically
  on Ashby, across three separate postings. Since the widened `widerLabelGuess()` check should have
  caught a merely-hard-to-find label, and it's failing consistently across every Ashby form tried, the
  more likely explanation now is Ashby's upload widget may not expose a native `<input type="file">`
  that can be filled via DataTransfer at all (a fully custom drag-and-drop implementation) — needs a
  live check of `document.querySelectorAll('input[type="file"]').length` on an Ashby page before
  attempting a fix, rather than guessing at a mechanism that might not even apply.
- A required 200–400 word "Why Anthropic?" essay was left blank on an otherwise well-filled Greenhouse
  application, with no clear code-level explanation found (the label passes the wordy-question gate
  fine, and the answer-length involved is far too long to trip the refusal-detection gate). Flagged
  for a future round with more diagnostic detail rather than a blind fix.

Verified: `test-round13-fixes.js` reproduces the fuzzy-match gap directly (a poisoned record banked
under different wording than the current page's label) and confirms the new re-check catches it while
leaving a genuine, correct learned answer unaffected. `node --check` clean; all prior round test suites
(5 through 12) still pass unchanged.

## Update 2026-07-08 — v1.13.15: deterministic (not prompt-based) rejection for the company/education bug, bare "Legal Name" gap, widened résumé-upload detection

Round 12 confirmed the v1.13.13 required-field safety net works well (correct banner text on two
sites, no false alarms), but found the v1.13.14 prompt fix STILL didn't stop "Truckee Meadows
Community College" from appearing — now on a FIFTH distinct Lever tenant (Zoox) — plus two new,
separate gaps.

1. **Gave up on prompt-only fixes for the company/education bug — added a deterministic code-level
   rejection instead.** Two rounds of prompt engineering (an explicit "never a school" instruction,
   then closing the fallback loophole that let the model reach for a school anyway) both failed to
   stop the same wrong answer from recurring. Rather than attempt a third prompt tweak, added
   `isSchoolAnsweringCompanyQuestion(question, answer)`: a plain, deterministic check — a
   "current/present/most-recent company or employer" question whose answer contains an education-
   institution keyword is rejected outright, the same way a refusal answer is. Applied at BOTH points
   the wrong answer could reach the field: dropping a poisoned bank record (as before) AND now also
   rejecting a *fresh* AI answer before it's ever typed in, so even if the model produces the same
   wrong answer again after the bank is clean, it still never reaches the field — it's left blank and
   routed to the human, same treatment as CAPTCHA/honeypot/refusal answers.

2. **New: bare "Legal Name*" (Ashby) was left blank — last round's fix was too narrow.** v1.13.13 only
   added support for "full legal name"; Ashby's actual field is just "Legal Name" with no "full" at
   all, which still fell through both matcher branches (the contiguous-phrase branch needs "full", and
   the generic name branch's blanket "legal" exclusion — originally added only to avoid misfiring on
   "Legal First Name"/"Legal Last Name" — also excluded plain "Legal Name"). Fixed by explicitly
   matching bare "legal name" and removing "legal" from the generic branch's exclusion list, since
   "first"/"last" (still excluded) already covered the only cases that exclusion was meant for.

3. **New: a required "Resume*" upload was left completely empty on Ashby.** `attachResume`'s
   `signals()`-based label check (label[for]/aria-*/narrow ancestor search) couldn't reach the
   "Resume*" heading sitting above the drag-and-drop widget, and the "exactly one file input" fallback
   didn't apply either since the form also had a separate Cover Letter upload. Widened the check to
   also try `widerLabelGuess()` (the dynamic-fallback tier's broader ancestor/sibling text scrape),
   checked per-input so it correctly distinguishes the résumé upload from a sibling cover-letter one
   on the same form.

Verified: `test-round12-fixes.js` — the deterministic school-rejection check is confirmed applied at
both the bank-filter site and the fresh-answer-application site (a wrong answer never reaches the
field even immediately after the bank is cleaned); the fullName matcher now recognizes bare "Legal
Name" without regressing the legal-first/last-name exclusion; the widened résumé-upload check
recognizes an Ashby-style "Resume*" heading while still correctly NOT misidentifying a sibling Cover
Letter upload. `node --check` clean; all prior round test suites (5 through 11) still pass unchanged.

## Update 2026-07-08 — v1.13.14: close the school-fallback loophole in the AI-answer prompt (the actual fix for "Truckee Meadows Community College")

Confirmed directly with the user: Truckee Meadows Community College is genuinely education-only
(attended, did not graduate) — never an employer. So the recurring "Current Company" bug (reproduced
on FOUR distinct Lever tenants across several rounds, surviving the v1.13.12 poisoned-bank-record fix)
was a real, still-unfixed bug, not a misread fact as the prior entry left open as a possibility.

**Root cause: the Round 9 prompt fix had a self-defeating loophole.** The system prompt told the model
"a company/employer question must be answered ONLY from a work-experience entry, never a school" —
but the SAME prompt also said, at the end, "if you cannot reasonably answer from the resume, give the
most conservative reasonable answer." When the resume has no clean current employer to point to (this
candidate did not graduate from a degree program and doesn't have a tidy "current job" line), the model
resolved that conflict by treating the fallback instruction as license to reach for a school anyway —
something is better than nothing, from the model's perspective, even after being told "never a school."
The v1.13.12 poisoned-bank fix was doing its job correctly (forcing a fresh AI call each round instead
of replaying a stale answer) — it just kept getting the same wrong fresh answer back each time, which
is why the symptom looked unchanged despite that fix actually working as designed.

Fixed by closing the loophole explicitly: the prompt now says the "never a school" rule for
company/employer questions has NO exception, and if no work-experience entry answers it, the model
must respond exactly "N/A" instead of substituting a school. This connects directly to EXISTING
infrastructure: `looksLikeRefusalAnswer()` (shipped for the CAPTCHA "No image provided."/"N/A" bug)
already intercepts a bare "N/A" and refuses to type it into the field, letting it fall through to the
human-ask path instead — which is exactly the right outcome here, matching how the candidate says they
handle this exact situation on real applications (give an honest, defensible answer, or skip the
question/application rather than guess). No new gate was needed; the fix is entirely in what the model
is now told to say when it genuinely doesn't know.

Verified: confirms the prompt string now contains the explicit no-exception language and the N/A
fallback instruction, and re-confirms the existing `looksLikeRefusalAnswer()` gate correctly catches a
bare "N/A" (while correctly noting that gate alone could never have caught a *wrong but confident*
answer like the school name itself — the fix had to happen at the prompt level, not the gate level).
`node --check` clean; all prior round test suites (5 through 11) still pass unchanged.

## Update 2026-07-08 — v1.13.13: "full legal name" matcher gap, general "ready to submit" required-field safety net

Round 11 (Search-path only, per the decisive-test plan) found no Zoho/ADP posting available to redo
that specific comparison, but produced two new, concrete findings on Lever and Greenhouse — both
fixed — plus an open question on the recurring "Current Company" bug that needs the user's input
before going further.

1. **Root cause found: "Please state your full legal name" was left blank despite the profile having
   a name.** The `fullName` std matcher's two branches BOTH failed on this exact phrasing: the
   contiguous `\bfull name\b` pattern doesn't match because "legal" sits in between ("full legal
   name"), and the generic `\bname\b` branch explicitly excludes any label containing "legal" (so it
   doesn't misfire on "legal first name"/"legal last name", which the firstName/lastName matchers
   already own). That left "full legal name" — a common, real phrasing — matched by nothing at all.
   Fixed by allowing an optional "legal" between "full" and "name" specifically, without touching the
   legal-first/last-name exclusion that was working correctly.

2. **New, more general safety fix: the "Filled and ready — review everything, then click Submit"
   banner fired on Shield AI's Lever form while THREE required fields were still visibly empty**
   ("How did you hear about us?", the full-legal-name field above, and "Are you a transitioning
   service member?"). Rather than chase down every individual reason a specific field might be missed
   by the discovery passes, added a general safety net: `hasUnfilledRequiredField()` scans for any
   visible `[required]`/`[aria-required="true"]` control (text, select, checkbox, radio group) that's
   still empty, checked right before the "ready to submit" banner would fire. If anything required is
   still blank, the banner now says so explicitly ("Filled what it could, but some required fields
   still look empty — please check the whole form...") instead of confidently claiming the form is
   ready. This doesn't fix why a field was missed — it stops Alicia from ever *claiming* readiness
   while something required is provably blank, regardless of the reason.

3. **Still open, needs the user's input before another fix attempt: "Truckee Meadows Community
   College" in "Current Company" survived the v1.13.12 poisoned-bank-record fix, reproduced on a
   FOURTH distinct Lever tenant (Shield AI).** Two possibilities, and they call for opposite next
   steps: (a) the fix has some remaining gap (e.g. the originally-banked question text didn't
   literally contain "company"/"employer" and slipped past the filter's regex), meaning this is still
   a bug — or (b) this was never actually wrong at all: nothing in this session has ever confirmed
   whether Truckee Meadows Community College is genuinely the candidate's own EDUCATION background
   (the original assumption, based on circumstantial reasoning — a matching area code — never
   verified against the actual resume text) or an actual past EMPLOYER (e.g. staff/instructor role),
   in which case "fixing" this further would mean suppressing a true fact. Asked the user directly
   rather than guess further, since guessing wrong in either direction is worse than asking.

Verified: this round's tests confirm the "full legal name" phrasing now matches (without regressing
the legal-first/last-name exclusion it was carved out of), and `hasUnfilledRequiredField()` correctly
flags blank required text/radio-group/select fields while ignoring filled or hidden ones. `node
--check` clean; all prior round test suites (5 through 10) still pass unchanged.

## Update 2026-07-08 — v1.13.12: poisoned learned-bank record (the REAL fix for the education/employment bug), yes/no answer tightening

Round 10 confirmed two of the three v1.13.11 fixes work (the location-typeahead fix stopped the
wrong-type "Cypress, Texas" guess; the passive-offer race condition is fixed, confirmed on two
separate sites) — but the "Truckee Meadows Community College in Current Company" bug was reported as
STILL happening on a third, brand-new Lever tenant despite last round's system-prompt fix.

**Root cause of why the prompt fix had zero effect: the learned-answer bank short-circuits the AI
entirely.** `findUnansweredCustomQuestions`'s results are checked against the GLOBAL, cross-site
`customQA` learned-answer bank BEFORE the AI backend is ever called — by design, so a question the
human has already answered once doesn't need re-asking. The wrong "Truckee Meadows Community College"
answer, generated once by the (at the time, unfixed) AI on the very first Lever tenant, got banked as
the "learned" answer for anything matching "Current Company"-shaped questions — and every subsequent
site with a similarly-worded field just replayed that exact stale, wrong value straight from the bank,
never touching the AI (or the new prompt instruction) again at all. This is precisely why the identical
wrong value kept reappearing verbatim across three different Lever tenants.

Fixed by extending the existing "poisoned record" filter (originally added for a stale "Select an
option" placeholder bug) with one more targeted rule: a banked record whose QUESTION is about
"current/present/most recent company or employer" and whose ANSWER contains an education-institution
keyword (college, university, institute, academy, polytechnic, school) is dropped from the bank before
use. This forces a fresh AI call for that question on the next run — which now benefits from the Round
9 prompt fix — and the corrected answer re-banks itself normally afterward, permanently repairing this
specific stale record going forward. Scoped narrowly (only company/employer-labeled questions), so a
genuine education question ("What school did you attend?") with an education-institution answer is
untouched.

**Also tightened: yes/no questions were getting a full paragraph instead of a short answer.** Round 10
showed the location-typeahead fix correctly routed a Yes/No travel-accommodation question to the
AI-answer path instead of guessing a location value — but the AI answered with "YES – My experience
includes managing global programs for Arrow Electronics and coordinating multi-site implementations
for Modernizing Medicine, showing I can meet location and travel demands," a full justification where
the page explicitly asked for just "YES or NO." Not wrong, just verbose — added an explicit system-
prompt instruction: when a question is clearly yes/no (even if phrased as free text), answer with just
"Yes."/"No." plus at most one short supporting clause.

**Clarified, not a new bug:** the Zoho posting's stall now has stronger evidence it's the SAME
Tracker-session gap identified in Rounds 8-9, not a separate mystery. Round 10's corrected diagnostic
(scanning the whole DOM for any fixed-position/high-z-index element, i.e. Alicia's own banner styling)
found zero such elements — autofill.js left no trace at all, consistent with "never ran," not "ran and
failed silently." Zoho's "I'm interested" transition is a same-document, no-URL-change SPA swap (per
the v1.13.4 MutationObserver work), so if no explicit session was ever established when this specific
job's LISTING page first loaded, the passive click-gated offer (also easy to lose if the SPA transition
replaces the DOM before it's clicked) would be the only path to activation — and per the tester's own
practice of never clicking Alicia's own UI, that would never be accepted. Recommend re-testing this
exact job via Wagner-GPT's Search tab (not Tracker) to confirm; still out of scope to fix from this repo
without Wagner-GPT in session.

Verified: `test-round10-fixes.js` — the extended poisoned-record filter drops the exact reproduced
bad record (company/employer question + education-institution answer) while preserving genuine
company/employer records AND genuine education-question records; confirms the yes/no tightening
instruction is present in the shipped prompt string. `node --check` clean; all prior round test suites
(5 through 9) still pass unchanged.

## Update 2026-07-08 — v1.13.11: location-typeahead over-match, education/employment prompt separation, passive-offer race condition

Round 9 confirmed the v1.13.10 EEO fixes work as intended (sexual-orientation/transgender questions
now silently skip instead of prompting; the EEO transparency note shows up verbatim on the terminal
banner) and supplied concrete evidence for three NEW, previously-unreported bugs — all three root-caused
and fixed this round, plus one important correction to how prior rounds' diagnostics should be read.

1. **Root cause found for "Cypress, Texas" landing in a Yes/No travel-accommodation question.**
   `atsFillLocationTypeahead` (Greenhouse/Lever/Ashby/SmartRecruiters' location-autocomplete filler)
   matches ANY text input whose signals contain the bare word "location" — and the question "Are you
   able to accommodate the location and travel requirements... Please answer YES or NO" contains that
   word as part of a full sentence, not as a field caption. Fixed by rejecting any candidate whose
   label reads like an actual question (contains "?", or is longer than 5 words) — a real location
   field's label is a short caption ("Location", "Current Location"), never a full sentence.

2. **Root cause found for "Truckee Meadows Community College" repeatedly appearing in "Current
   Company" fields (Test 1 and Test 4, two different Lever tenants).** Not a code bug — a genuine
   résumé entry (the candidate's own community college, consistent with their area code) getting
   pulled by the AI-answer backend as if it were a current employer, because the system prompt never
   told the model to keep the résumé's EDUCATION and WORK EXPERIENCE sections separate when a question
   is specifically about employment. Added an explicit instruction to `callCustomAnswerBackend`'s
   system prompt: a "current company"/"current employer" question must be answered ONLY from a
   work-experience entry, never a school, and vice versa for education-specific questions.

3. **Root cause found for the passive "Auto-fill?" banner appearing even when a real explicit session
   was already active and correctly filling fields (Test 4, PMA Consultants).** Two independent
   `chrome.tabs.onUpdated` listeners both fire on the same page-load-complete event and each do their
   OWN unsynchronized `chrome.storage.local.get` read — a genuine time-of-check-to-time-of-use race:
   the passive-offer listener's early read can see "no session yet" moments before the real
   apply-session listener's own (slightly slower) session write lands. Fixed by moving the passive
   listener's session check to happen right before it actually injects `detect.js` (after its own
   1200ms delay), instead of once up front — by then the real session listener's write has reliably
   already landed.

4. **Important correction to prior rounds' diagnostics: `typeof window.__aliciaAutofillRun` is NOT a
   reliable "did autofill.js run here" check.** Round 9 caught it directly: on the Search-path Lever
   test, fields visibly filled (proving the script ran), yet the check still came back `"undefined"`.
   Likely explanation: content scripts execute in an isolated JS world, so a `window.X = ...`
   assignment made inside autofill.js isn't necessarily visible to `window.X` as evaluated in the
   page's own console context. This means the Round 8 conclusion that leaned on this check for the
   Zoho total-fill stall ("proves the script never ran") should be treated as unconfirmed, not proven
   — it may have run and failed for an unrelated reason. Retiring this diagnostic; future rounds
   should rely on whether an Alicia banner/console line ever appeared instead (real DOM/console
   artifacts, not an isolated-world JS global).

**Also clarified, not a bug:** the Tracker-vs-Search finding from last round holds up — Tracker's
"View posting" link lands on the job LISTING page (no `/apply` in the URL) requiring an extra manual
click to reach the real form, and even after reaching an identical `/apply` URL to the working
Search-path tab, only the passive click-gated offer appeared. This is very likely because Tracker's
flow never sends the `ALICIA_APPLY` message that creates an explicit session — out of scope for this
repo (Wagner-GPT's Tracker code isn't in this session), but now narrowed down as far as it can be from
this side.

Verified: `test-round9-fixes.js` — the location-typeahead gate rejects the exact reported question
while still matching real short location captions; the system prompt is confirmed (by reading the
actual shipped string) to contain the education/employment separation instruction; the race-condition
fix is reproduced with a mocked async-storage race that shows the OLD code firing the offer despite an
active session and the NEW code correctly suppressing it. `node --check` clean on both files; all
prior round test suites still pass unchanged.

## Update 2026-07-08 — v1.13.10: EEO categories for sexual orientation/gender identity + visible EEO-fill transparency note

Round 8 supplied the exact DOM/console diagnostics requested in v1.13.9, plus a new, more serious
finding from a third test site. Net result: the two "needs live data" bugs turned out to point at
something outside this codebase entirely (see below), while the new finding was a real, fixable gap.

**Test 1/2 diagnostics reframe both open items — likely NOT an autofill.js bug at all.** The ADP
field (`guestFirstName`) has completely ordinary markup — a plain `<input>` with `aria-label="First
Name"` right on it, no shadow root, no iframe — exactly the shape `signals()` already reads directly
with no special-casing needed, so the earlier aria-labelledby hypothesis doesn't apply here. And on
Zoho, `typeof window.__aliciaAutofillRun` came back `"undefined"` — proving autofill.js never ran in
that tab at all, not that it ran and silently failed. Both failing tests were reached via Wagner-GPT's
**Tracker** tab; the one Test 3 site that filled correctly (Greenhouse) was reached via **Search**'s
direct-apply flow. Checking `bridge.js`, there is exactly ONE entry point that creates an explicit
autofill session (`ALICIA_APPLY` → `WEBAPP_APPLY`) — if Tracker's own "open"/"apply" action doesn't
fire that same message the way Search's Apply button does, the extension would correctly do nothing
beyond its passive ATS-detect banner (which requires a human click to actually engage), matching every
symptom observed: zero console output, `window.__aliciaAutofillRun` undefined, no banner. This can't be
confirmed further from this repo (Wagner-GPT's Tracker code isn't in scope here) — flagged for the user
to check, and to add the Wagner-GPT repo to this session if they want it fixed from this side.

**New finding, fixed: sexual orientation / transgender status weren't recognized as EEO categories at
all.** On Onenergy's Greenhouse posting, Gender/Hispanic-or-Latino/Race were correctly auto-filled
silently from the user's own saved EEO preferences (existing, intended design — same trust model as
any other profile field, never AI-guessed) — but "How would you describe your sexual orientation?" and
"Do you identify as transgender?" surfaced in the ask-panel as ordinary custom questions needing an
"answer," because `eeoKey()`'s category list had no entry for either. That's a real gap: these are
voluntary, legally-protected self-identification questions that deserve the exact same "fill from a
real saved preference, or silently leave blank — never ask, never AI-guess" treatment every other EEO
category already gets, not the generic job-content-question treatment. Fixed by adding
`eeo-gender-identity` (transgender/gender identity) and `eeo-sexual-orientation` categories to the
`EEO` array — checked BEFORE the plain `eeo-gender` entry, since "gender identity" would otherwise
match `\bgender\b` first and get misclassified (caught by the test suite before shipping). An
unconfigured category is now silently skipped exactly like an unconfigured race/veteran/disability
preference already is — no ask, no guess.

**Also added: a visible transparency note whenever EEO/demographic fields get auto-filled.** The
report separately raised that Gender/Race/Hispanic-or-Latino were filled with zero visible callout —
correct per the existing trust model (it's the user's own configured data, filled the same way contact
fields are), but worth surfacing rather than blending silently into the generic fill count, given how
sensitive the category is. Added `result.eeoFilled` tracking and an `eeoNote()` helper appended to the
terminal banners ("Filled and ready…", "Alicia answered N questions…", "Filled what it could…", and a
dedicated note before the ask-panel opens) — e.g. "(includes 3 EEO/demographic answers auto-filled from
your saved preferences — please double-check before submitting)". Doesn't change what gets filled or
add a new blocking step, just makes it visible instead of silent.

**Not yet addressed:** Test 3 also reported one Yes/No accommodation question answered with "Cypress,
Texas" instead of Yes/No — a single occurrence, not enough detail yet (was it a radio group or a text
field?) to safely root-cause; flagged for a future round rather than guessed at.

Verified: `test-round8b-fixes.js` — `eeoKey` now classifies both new categories correctly (including the
ordering fix, which the test suite caught before shipping: "gender identity" was initially
misclassified as plain "gender" until the category order was corrected), confirms an unconfigured new
category is silently skipped (never asked, never guessed), and confirms `eeoNote()` only appears when
something was actually EEO-filled. `node --check` clean; all prior round test suites still pass.

## Update 2026-07-08 — v1.13.9: aria-labelledby multi-id fix (from a deeper investigation pass on the two open ADP/Zoho items)

Ran a higher-effort, multi-agent investigation (two independent deep-dive passes on the ADP
field-recognition gap and the Zoho total-fill regression, each followed by an adversarial verification
pass that re-read the actual current code rather than trusting the investigation's claims) to see
whether more compute could unblock the two items v1.13.8 left as "needs a live diagnostic." Result:
mostly confirms the earlier conclusion rather than overturning it, plus one small, genuinely new fix.

- **Zoho total-fill regression: still NEEDS-LIVE-DATA, and now with stronger evidence.** The
  investigation traced the exact execution order in `fillOnePass` and confirmed `fillStdFields`/
  `fillStdSelects` (name, email, phone, etc.) run, synchronously, *before* any of the CAPTCHA/honeypot/
  dedupe logic added in v1.13.7 — so even a hypothetical bug in that new code could only ever explain a
  *partial* failure (custom questions), never the reported *total* blank result (not even name/email).
  That rules out the v1.13.6→v1.13.7 diff as the cause with fairly high confidence. The adversarial
  pass independently re-verified every line/commit reference and agreed. Conclusion stands: the most
  likely explanation is a Zoho-side rendering/timing hiccup, or an injection failure silently swallowed
  by the pre-existing `.catch(function(){})` pattern on every `chrome.scripting.executeScript` call in
  background.js — not a code bug this repo can fix blind. The two diagnostics requested in v1.13.8
  (`document.querySelectorAll('input,select,textarea').length` and `typeof window.__aliciaAutofillRun`
  on the stuck page) are still the right next step.

- **ADP field-recognition gap: one real, generic bug found and fixed; two more targeted fixes proposed
  but NOT shipped after adversarial review found real problems with them.** The investigation
  correctly noted the tester's confirmed `document.querySelectorAll('iframe').length === 0` means this
  is a *different* cause than the v1.13.7 iframe fix (which only ever applied to a same-tab-iframe
  scenario) — call it ADP gap #2. Three candidate root causes were proposed (Angular/Kendo-style
  components not mirroring field names onto DOM attributes, a custom-element label wrapper that
  `labelText()`'s hardcoded tag whitelist can't traverse, and — flagged as a structural gap regardless
  of ADP — zero shadow-DOM traversal anywhere in this codebase), all correctly hedged as "plausible for
  ADP's known technology history, not confirmed for this specific page." Of the three proposed code
  changes:
  - **Shipped:** `labelText()`'s `aria-labelledby` handling only ever read the FIRST id in a
    space-separated list, but the ARIA accessible-name algorithm concatenates the text of every
    referenced id — a real, generic bug (not an ADP guess) since component libraries commonly split a
    label across a separate label node and a hint/required-marker node referenced together. Fixed to
    join text from every listed id. Verified independently safe (purely additive — only fires when
    `aria-labelledby` is present, only overrides the label when it finds a non-empty result).
  - **Not shipped:** a proposed rewrite of the last-resort ancestor-walk fallback was caught by the
    adversarial pass containing inert dead code (a condition computed and then discarded — a sign it
    was never actually run) AND a real regression path: it stops walking as soon as it hits a container
    with more than one form control, *before* checking that container for a label — which breaks the
    common compound-field pattern (e.g. a country-code select + phone input sharing one labeled
    wrapper) that the current code already handles correctly. Reworking this safely needs either a live
    DOM sample or much more careful edge-case handling than the first pass produced — left for a future
    round rather than shipped on a guess.
  - **Not shipped, correctly gated:** a shadow-DOM traversal helper, since this codebase has zero
    shadow-DOM awareness anywhere (confirmed by grep) — a real structural gap in general, but shipping
    a deep-query rewrite of every field-discovery call site without confirming ADP's page actually uses
    shadow DOM would be exactly the kind of speculative fix this project has been trying to avoid.

Bottom line on the meta-question that prompted this pass: extra reasoning depth and independent
verification caught one real bug and, just as usefully, stopped an unsafe-looking fix from shipping —
but it did not unblock either open item, because both are blocked on missing live-DOM data, not on
insufficient analysis. The next actionable step for both is still a human pasting console output from
the actual stuck page, not more code archaeology.

Verified: `test-round8-fixes.js` reproduces the old first-id-only behavior and confirms the new code
recovers a label from a later id when the first one doesn't resolve, without changing the single-id
case. `node --check` clean; all prior round test suites (`test-round5/6/7-fixes.js`) still pass
unchanged.

## Update 2026-07-08 — v1.13.8: generated-password class coverage, honeypot exclusion

Round 7 re-tested v1.13.7 across the Zoho posting again, a fresh Workday tenant (Owens & Minor), the
same ADP/MEI site, and a brand-new BambooHR site (Solid Light). Confirmed working: the CAPTCHA
stop-and-ask behavior generalized to a second site (a real Google reCAPTCHA on the BambooHR posting was
correctly left untouched), and the Workday oscillation brake fired correctly rather than thrashing.
Two real, root-caused issues surfaced, plus two items that need more data before they can be fixed here.

1. **Root cause found for the Round 6/7 Workday Create-Account failures: the generated password can
   fail the site's own complexity policy.** Owens & Minor's Workday tenant kept rejecting the
   generated password with "Password must include: - A special character," so Create Account never
   succeeded — that's exactly what tripped the (correctly-firing) oscillation brake, asking the human
   to take over. `generatePassword()` sampled 16 characters uniformly at random from a mixed 62-char
   pool (5 of which were special characters) — with no guarantee every required class actually shows
   up, that's roughly a 1-in-4 chance of generating zero special characters at all. Rewritten to draw
   one guaranteed character from each class (upper/lower/digit/special) first, fill the rest of the
   16 characters from the full pool, then shuffle — every generated password now satisfies upper +
   lower + digit + special, which covers Workday's policy and the vast majority of real-world
   corporate password rules.

2. **New: a BambooHR anti-spam honeypot field ("Please leave this field blank.") was surfaced as a
   real question** ("Alicia needs 1 answer") instead of being recognized and left untouched. Honeypot
   fields exist specifically to catch bots that dutifully fill in every labeled field — even routing
   it through the ask-panel (let alone answering it with real text) defeats the point and risks
   flagging a genuine human application as spam. Added `looksLikeHoneypot()` (matches "leave this
   field blank," "do not fill," anti-spam-purpose phrasing) and a combined `mustNeverAnswer()` gate
   (CAPTCHA OR honeypot) now used at all 5 places `looksLikeCaptcha` used to be called directly —
   honeypots are excluded exactly like CAPTCHAs: never discovered as a question, so they're simply
   left exactly as found.

3. **Not fixed — needs one more diagnostic, not a guess:** the Zoho posting that filled correctly in
   Round 6 filled NOTHING at all in Round 7 (not even name/email), with the only console line being
   an unhandled-rejection "Model not defined." Confirmed by searching this repo that no `Model`
   reference exists anywhere in `autofill.js` — that error is Zoho's own page code (matches the
   recurring "ERR19: Model not defined: skillsets" / `getSuggestedSkills` exceptions reported in
   earlier rounds), not this extension. Whether the total non-fill was a one-off Zoho rendering
   hiccup or an extension-side injection failure on that specific run can't be told apart from the
   report alone — the next test round should check `document.querySelectorAll('input,select,textarea').length`
   and `typeof window.__aliciaAutofillRun` directly in the console on that page to tell which it was.

4. **Not fixed — MEI/ADP still has zero autofill, and the iframe fix from v1.13.7 does not apply
   here.** Round 7 explicitly confirmed `document.querySelectorAll('iframe').length === 0` on that
   page — there's no embedded frame, so last round's iframe-injection fix (still valid for whatever
   case originally motivated it) isn't the relevant mechanism for MEI specifically. The real cause is
   most likely that ADP's field markup doesn't match anything the label/signal-based field matchers
   recognize, but fixing that responsibly needs an actual DOM snippet (e.g. the First Name input's
   outerHTML) from that page rather than a guess. Also still open: Wagner-GPT's status line claims
   "Filled what it could" on this page even though nothing filled — that's a Wagner-GPT-side
   optimistic-status issue, out of scope for this repo (Wagner-GPT isn't in this session's repo scope).

Verified: `test-round7-fixes.js` — `generatePassword` produces all 4 required character classes
across 20 trials seeded with byte streams engineered to reproduce the OLD bug (a stream that would
have produced zero special characters under the old uniform-sampling scheme); `looksLikeHoneypot`/
`mustNeverAnswer` catch the exact BambooHR label plus several phrasing variants without false-
positiving on ordinary fields, while still catching CAPTCHA through the same combined gate.
`node --check` clean.

## Update 2026-07-08 — v1.13.7: CAPTCHA safety net hardened, duplicate-question de-dupe, iframe-embedded ATS forms

Round 6 re-tested v1.13.6 across a fresh Workday tenant (Qnity/DuPont), a repeat Zoho run, and a
brand-new custom-ATS site (MEI Industrial via ADP Workforce Now). The good news first: résumé
duplicate-attach, Facebook/LinkedIn field mis-fill, and the first/last-name swap are all confirmed
fixed — the grounded-label rewrite held. Three issues remained or were newly found:

1. **CAPTCHA safety regression persisted — same class of bug, new literal text ("N/A" this round,
   "No image provided." last round).** v1.13.6's `looksLikeCaptcha` is a keyword/DOM-signature
   check, and this particular Zoho form's challenge apparently doesn't say "captcha" anywhere in its
   label or DOM (most likely a math-style challenge, e.g. "3 + 5 = ?", which has zero CAPTCHA
   vocabulary) — so it slipped past discovery and reached the AI-answer step, whose honest
   "I can't do this" reply got typed in as if it were real. Fixed two ways: (a) broadened
   `looksLikeCaptcha`'s keyword list (security/verification code, "are you human", bot/anti-spam
   check, etc.) and added a shape-based check for a short arithmetic expression ending in `=`/`?`,
   which no real job-application question looks like; (b) added `looksLikeRefusalAnswer()` as a
   content-based safety net independent of *why* a field wasn't recognized — if the AI's answer
   itself reads like a non-answer ("N/A", "no image provided", "I can't see/view/access…", short and
   nothing else), it is never typed in; the field is left empty and falls through to the existing
   ask-the-human path instead. (b) is deliberately the backstop for whatever (a) still doesn't catch,
   rather than betting everything on ever-more label patterns.

2. **New: Workday's "How Did You Hear About Us?" dropdown got asked twice, both as free-text boxes,
   on a fresh tenant (Qnity/DuPont).** Root cause: the field was independently discovered by BOTH the
   generic ARIA-combobox scan (`findUnansweredCustomQuestions`) and the Workday adapter's own
   `wdFindDropdownQuestions` scan, and the two lists were simply concatenated with no de-duplication —
   each rendered as its own free-text-shaped item since the generic scan's version had no options.
   Fixed with a de-dupe pass in `fillOnePass` keyed on normalized label text, keeping whichever
   discovery carries real dropdown options over one that fell back to free text (this is a general
   fix, not Workday-specific, since any adapter + generic scan overlap can now hit the same field
   twice). It correctly still stopped and asked rather than guessing either time, so this was a
   duplication/UX bug, not a safety one.

3. **New: a custom ADP Workforce Now career site (MEI Industrial) got zero autofill at all** —
   First/Last/Email/Mobile stayed blank after 13+ seconds, while Wagner-GPT's own status line still
   claimed "auto-filling." Root cause: ADP's actual application form is rendered inside a same-tab
   iframe, and every injection path in `background.js` only targeted the tab's TOP frame
   (`chrome.scripting.executeScript({ target: { tabId } })`, `allFrames` unset) — autofill.js ran in
   the parent document, saw no recognized form, and did nothing. There was already a safe pattern for
   exactly this shape (`injectAtsFrames`, built for ATS forms embedded in a LinkedIn iframe), just
   never applied to the general apply-session case. Added `injectIntoRecognizedChildFrames()`,
   wired into every autofill.js injection point (`injectAutofillWithTailoredResume` — covering both
   the initial inject and the SPA re-injection path — and the passive ATS-offer-accept path): it
   injects into a child frame only when that frame's hostname matches the top frame's own hostname
   (same-site embed, the ADP case) or a recognized ATS host — never an arbitrary third-party ad/chat/
   tracking iframe, since autofill.js's own self-guard (≥3 visible inputs) isn't a strong enough
   filter to make that safe on its own. The false "auto-filling" status line is a Wagner-GPT-side
   optimistic-UI issue (reports the action as started rather than confirmed) — flagged for that repo,
   not fixed here.

Verified: `test-round6-fixes.js` covers all three — broadened CAPTCHA detection (arithmetic-shape
challenge, security/verification-code phrasing) without false-positiving on ordinary fields with
numbers or dashes; `looksLikeRefusalAnswer` correctly flags both literal regressions ("N/A", "No image
provided.") plus other disclaimer phrasings while passing real, longer answers through unmodified; the
duplicate-question de-dupe collapses two same-label items to one, keeping the options-bearing version;
the child-frame injection selector picks only a same-host or known-ATS child frame, never a 3rd-party
tracking iframe (tested against both the new ADP case and the pre-existing LinkedIn+Lever-iframe case).
`node --check` clean on both `autofill.js` and `background.js`.

## Update 2026-07-08 — v1.13.6: CAPTCHA safety fix, grounded-label trust boundary, Workday oscillation brake

Round 5 (still on v1.13.5) surfaced a new Workday tenant (Motorola Solutions) and a repeat run on the
same Zoho job, and reported four issues — one safety-critical, one confirming the v1.13.5 fix was too
narrow, one new, and one stability bug. All four are addressed here except the résumé-attach fix,
which Round 5 confirmed already works.

1. **Safety-critical regression: Alicia typed "No image provided." into a CAPTCHA field instead of
   asking the human.** Root cause: the CAPTCHA's label was AI-inferred (the dynamic-fallback tier's
   last-resort `aiInferLabels`), passed the generic "wordy" gate, and got treated as an ordinary
   custom question. The text-only, résumé-grounded answer backend (`callCustomAnswerBackend`, no
   image data) honestly disclosed it had no image to look at — and that disclosure got typed into the
   field as if it were a real answer, since nothing in the pipeline recognized "I can't see an image"
   as "couldn't answer." Fixed with a new `looksLikeCaptcha(label, container)` check (text patterns —
   "captcha", "verify you're human", "type the characters shown" — plus a DOM check for
   captcha/recaptcha/hcaptcha-branded images, iframes, and classes), wired into all 4 discovery
   branches of `findUnansweredCustomQuestions` (combobox/select/radio/text) AND into
   `classifyDynamicItem` (the dynamic-fallback tier). A CAPTCHA can now only ever reach the human via
   the existing ask-and-remember panel — it is never offered to any AI-answer path.

2. **The v1.13.5 Facebook/phone fix was too narrow — Round 5 showed the bug just relocated.** The
   phone number moved from Facebook to Street Address; Facebook then got a zip-code fragment,
   LinkedIn got "Texas", and (new) First/Last name came back swapped. All four are the same underlying
   defect: `classifyDynamicItem` trusted contact/EEO classification from a label the AI had *guessed*
   from bare technical hints (`aiLabel`), with no real page text behind it — v1.13.5's fix only patched
   the one social-keyword symptom it saw, not the mechanism. Rewritten so contact/EEO classification
   now requires a **grounded** label (`o.wideLabel` — actual text scraped from the page, e.g. a nearby
   `<label>` or ancestor text) and is refused whenever the label is a blind AI guess. The shared
   phone/email matchers are also now called with `{}` instead of the real element, so their
   `el.type==='tel'|'email'` fallback can never override a label-based decision inside this tier — a
   wrong guess can now only ever become a reviewable custom *question* (grounded in the résumé,
   editable before submit), never a silent contact/EEO auto-fill. Applies uniformly, so it also covers
   the first/last-name swap without a name-specific patch.

3. **Motorola Solutions (Workday) thrashed between Sign-In and Create-Account views for 20+ seconds
   without settling**, described by the reporter as "the engine lost context and reverted to an
   earlier stage of its own flow." Root cause: `findButton()` picks the first visible, enabled match
   for a text pattern in DOM order — and Workday's Sign-In/Create-Account toggle link is *also*
   labeled "Create Account" (matching `WD_ADVANCE`), automation-id `...Link`-suffixed, distinct from
   the real submit button (`...SubmitButton`). If the toggle happens to sit earlier in the DOM than the
   real submit button, the engine clicks the toggle every step instead — which swaps the visible form
   (looking identical to "advancing") and can reset fields already filled, without ever reaching the
   real Create Account submit. Fixed two ways: (a) `findButton()` now excludes any candidate whose
   `data-automation-id` ends in "Link" — Workday's own convention for navigational toggles
   (`createAccountLink`, `signInLink`, `forgotPasswordLink`, vs. `...SubmitButton` for real submits) —
   from every advance/stop search; (b) a general oscillation brake: if the exact same button (same URL
   + same visible label) would be clicked more than twice, Alicia stops and asks the human to continue
   manually instead of thrashing indefinitely. (b) is defense-in-depth for any other ATS with a similar
   quirk we haven't seen yet, not just Workday.

4. **Flagged, not a code fix from this repo: Zoho's skills/experience/education data looked like it
   came from "an entirely different, irrelevant profile"** (healthcare/retail-sector skills and
   unfamiliar companies, vs. the consistent project-management background used in every earlier
   round). This repo only relays whatever résumé Wagner-GPT's Jobs tab currently marks "active" — the
   most likely explanation is that a different résumé was active in Wagner-GPT during that specific
   test run, not a bug in this extension. A less likely alternative — cross-user response caching on
   the separate, multi-user Chatwillow backend (`chatwillow.com/api/chat`) that this extension calls
   for custom-question answering — can't be ruled out from this repo, since that backend's source
   isn't in scope here. Recommend checking which résumé is marked active under Wagner-GPT's Jobs >
   Résumés tab before the next test round.

Verified: new logic tests (`test-round5-fixes.js`) reproduce all three Round-5 bugs explicitly against
the OLD logic shape and confirm the new code prevents them — CAPTCHA text/DOM patterns correctly
identified without false-positiving on ordinary fields; an ungrounded "Facebook"/"LinkedIn" AI-guess on
a `type=tel`/text field no longer classifies as contact (while a genuinely page-grounded "First Name"/
"Last Name" label still resolves to the correct value, unswapped); `findButton` now skips a
`...Link`-suffixed toggle in favor of the real `...SubmitButton`; the oscillation brake halts on the
3rd identical click on the same URL. `node --check` clean.

## Update 2026-07-08 — v1.13.5: duplicate résumé attach + Facebook/phone field mismatch

Round 4 (v1.13.4) was the strongest result yet: Capital One's Sign In page got real Email/Password
values filled in and correctly stopped rather than auto-signing-in (Sign In isn't in WD_ADVANCE, by
design — a human should trigger their own account login). Novalink's Zoho form got a NEAR-COMPLETE
fill — last/first name, email, skill set + level, department, education duration, and all 7
experience entries with the "currently work here" checkbox correctly ticked — and it correctly
recognized the CAPTCHA at the end and asked the human instead of attempting anything risky, stopping
without submitting. Two real, narrow bugs surfaced in that otherwise-strong Zoho run:

1. **Résumé attached 3 duplicate times.** `attachResume`'s only "already done" guard was the file
   input's own `.files.length` — but Zoho's upload widget apparently CLEARS that after "parsing" the
   résumé for its own preview UI, which looks identical to "never attached" to that check. The new
   v1.13.4 mutation-driven re-scan now calls `fillOnePass` (and therefore `attachResume`) repeatedly
   on content changes — and the parse itself IS a content change — so each re-run re-attached. Fixed
   with `el.__aliciaResumeAttached`, a marker WE control that the page's own JS has no reason to
   touch, checked before `.files.length` and set right after a successful attach — survives the page
   resetting `.files` regardless of the reason.
2. **A "Facebook" field got typed with the phone number.** The shared phone matcher (used everywhere,
   including the original std-fields pass) trusts `el.type === 'tel'` alone with no label check —
   safe historically, since no prior pass reached a field with no discoverable label at all. The new
   dynamic-fallback tier (v1.13.0) is the first to reach such fields, and Zoho's Social Links section
   apparently renders its Facebook input as `type="tel"`. Fixed in `classifyDynamicItem`: a label
   unambiguously naming a social handle/URL (facebook/twitter/instagram/github/social) now overrides
   the type-based phone guess, leaving the field unfilled (routes to nothing rather than a wrong
   guess) instead of typing the phone number into it.

Verified: logic tests reproduce the OLD duplicate-attach bug explicitly (confirming the `.files.length`-
only guard fails once `.files` is externally reset) and confirm the NEW marker guard blocks it; the
social-field guard is tested against Facebook/Twitter/Instagram/GitHub/generic-"social" labels (all
now correctly skip contact-matching) while a genuinely unlabeled `type=tel` field still gets the real
phone value. `node --check` clean.

On Capital One specifically: this round landed on Sign In rather than Create Account because the test
identity now already exists in Workday's system from earlier rounds — a site-side state artifact, not
something this round could isolate. A clean Create Account re-test needs a fresh email/identity or
clearing whatever session Workday is keying off.

## Update 2026-07-08 — v1.13.4: self-triggering re-scan on DOM content changes

Fourth re-test round confirmed v1.13.3's fix works exactly as designed — AND surfaced two remaining,
genuinely different root causes for the same "stuck" symptom, both requiring one more fix:

1. **Capital One (Workday)**: the nav panel now correctly refreshes per real navigation (step 1 → 2
   showed a fresh, context-aware option list — the v1.13.3 fix working as intended). But the panel
   still fired on the Create Account page even though real password fields were present there
   (confirmed by the tester: "this is also the real fillable form"). Diagnosis: Workday's account-
   creation form renders ASYNCHRONOUSLY after the route change — slower than the fixed ~500ms
   re-injection delay — so `hasRecognizedForm()` correctly returned false AT THAT INSTANT, and
   nothing ever re-checked once the real fields mounted a moment later (no new URL, so the v1.13.3
   URL-change reset never fires again).
2. **Novalink (Zoho Recruit)**: the panel stayed byte-for-byte stale across "Job Details" → "Job
   application" — a DIFFERENT root cause: Zoho's transition likely never calls `history.pushState`
   at all (a plain in-memory view swap), so `onHistoryStateUpdated` never fires and autofill.js is
   simply never re-injected/re-run for that step at all.

Both are the same underlying gap: autofill.js only re-scans when **background.js** tells it to via a
navigation event; it has no way to notice "the page's content just changed" on its own. This is
exactly the class of problem `content.js` already solves for LinkedIn with a MutationObserver-driven
polling loop — autofill.js had no equivalent.

**Fix:** added a `MutationObserver` (watching `document.body`, `childList`+`subtree`) that debounces
(700ms) and re-invokes `window.__aliciaAutofillRun()` whenever the page's own content changes,
independent of any navigation event. Guards to keep this safe and cheap:
- **Ignores mutations from Alicia's own UI** (banner/question-panel/nav-panel insertions) so its own
  DOM writes can't create a re-trigger feedback loop.
- **Hard 4-second rate floor** regardless of mutation frequency, bounding worst-case backend-call cost
  on pages with ambient DOM churn (chat widgets, animations, carousels).
- **Never reruns while the custom-question ask panel is up** — that one specifically means "we need a
  human ANSWER"; re-running would just re-ask the same unanswerable question via a wasted AI call.
- **Does NOT skip while the nav panel is up** — that one only means "no form found yet," which is
  exactly what a genuine content change should re-evaluate; the rerun also resets
  `window.__aliciaNavHandled` and clears the stale nav panel first, so a real form appearing (Capital
  One) or a route change with no pushState (Zoho) both get a fresh, correct evaluation.

Verified: mocked-clock logic tests for the gating rules (first-fire runs, floor suppresses a
too-soon refire, floor-elapsed allows a refire, question-panel presence fully blocks reruns, reruns
resume once the panel clears) — 5/5 pass. `node --check` clean. Live re-test needed to confirm
Workday's Create Account step now actually completes (password fill + agreement tick + auto-click)
once its fields render, and that Zoho's Basic Info form gets discovered at all.

On the recurring Zoho console exception (`{"code":"ERR19","message":"Model not defined",
"data":"skillsets"}`): the tester's own read — that this matches Zoho's own internal "Lyte"
framework's model-registration warnings seen elsewhere on the same page, and reproduces purely from
clicking Zoho's own "I'm interested" button — is the more likely explanation; nothing in Alicia's own
code path was implicated by the evidence gathered. Flagged as a probable pre-existing Zoho-side issue,
not an Alicia regression, though this can't be fully confirmed without Zoho's own source.

## Update 2026-07-08 — v1.13.3: nav panel goes stale across SPA steps + candidate hardening

Third re-test round (fresh Apply clicks this time) confirmed v1.13.1's SPA re-injection DOES work —
the nav panel now fires immediately after a fresh Apply click and survives at least one SPA
transition. But it then goes STALE: on Capital One the panel stayed present with the SAME
page-specific options two steps deep instead of refreshing; on RTX and Novalink the options froze
("Follow Us / Facebook / X", "I'm interested") through the Sign-In/Basic-Info transition instead of
updating for the new page.

Root cause: `window.__aliciaNavHandled` latches `true` the first time the nav panel is shown, and
since `window` persists across SPA route changes (no full reload resets it), every LATER
re-injection on that same tab silently no-ops (`result.status = 'no_fields_found'`) without ever
re-evaluating the page — leaving the ORIGINAL panel DOM node (appended straight to `document.body`,
which itself survives SPA route changes) sitting there displaying stale options from the page it was
built for.

**Fix:** `window.__aliciaAutofillRun` now tracks `window.__aliciaLastUrl` and, whenever the current
`location.href` differs from the last-evaluated one, resets `__aliciaNavHandled = false` and clears
any stale panel before proceeding — so each distinct page/step (real navigation or SPA route change)
gets a fresh, independent evaluation instead of being silently swallowed by a guard meant only to
stop repeat re-asking on the SAME unchanged page.

**Also hardened while re-reading this code:** the nav panel's candidate list had no exclusion for
final-submission or account-creation button text — a `NAV_NEVER_RE` now blocks "Submit Application",
"Finish/Complete Application", "Create Account", "Sign Up", "Register" from ever appearing as a
nav-panel option (whether for a human choice OR the autonomous single-candidate auto-click path).
Those require either the app's own "never auto-submit" rule, or the dedicated password-generation +
agreement-tick groundwork only the Workday/account-gate adapters do first — the generic panel has no
business clicking them blind. "Apply"/"Apply Now" are deliberately still eligible — recognizing and
clicking those to OPEN an application (never submit one) is the panel's entire purpose.

Verified: logic tests confirm (1) `NAV_NEVER_RE` blocks all 9 submission/account-creation phrasings
while leaving Apply/Apply Now/Continue untouched, extracted and eval'd directly from the shipped
regex; (2) the URL-change guard-reset only fires on an actual URL change, not on a same-page
re-evaluation. `node --check` clean. Live re-test still needed to confirm the panel now refreshes
per-step and that a human clicking its "My Information"/step-forward option actually advances past
Workday's Create Account gate (last round's testers were told not to click any panel option at all —
next round should explicitly test clicking a genuine navigation option, since that's the one thing
never yet exercised).

## Update 2026-07-08 — v1.13.2: add zohorecruit.com to ATS_HOST_RE (all 3 copies)

Second re-test round (post-v1.13.1) showed Zoho Recruit (novalink-solutions.zohorecruit.com) with
ZERO signal — no banner, no fills, in either the before or after diagnostic. Root cause: `zohorecruit`
was missing from `ATS_HOST_RE` in all three places it's duplicated (`background.js`, Wagner-GPT's
`api/jobs.js`, and `src/Jobs.jsx`) — so Zoho pages were invisible to background.js's auto-detect/offer
mechanism (`detect.js` injection requires `ATS_HOST_RE.test(host)`), the iframe-injection gate, and
the web app's "✓ direct apply" / "⚡ auto-fill ready" badges. Added `zohorecruit` to all three. Also
clarified in the diagnosis (see below) that the same re-test showed a DIFFERENT, unrelated mechanism
firing on the Capital One Workday tenant — the passive ATS auto-detect banner ("Let Alicia auto-fill
it? Auto-fill / Not now", from `detect.js`), not the explicit apply-session engine (autofill.js) — and
by design that banner does nothing until clicked, so "no fields filled without a click" there was
CORRECT behavior, not a failure of the v1.13.1 fix. The re-test methodology (navigating to
already-open tabs/history instead of a fresh Apply click from Wagner-GPT) likely never established an
explicit `autofillSessions` entry at all, meaning the SPA re-injection fix was never actually exercised
in that round — a proper re-test needs a FRESH Apply click per job so `pendingApplyUrls`/
`autofillSessions` actually populate. See conversation for the next diagnostic prompt sent to verify
this directly (inspects `chrome.storage.local` via the extension's own service-worker console for
ground truth, rather than inferring purely from banner text).

## Update 2026-07-08 — v1.13.1: generalize SPA re-injection (the REAL "goes dark" bug)

User ran a 5-job diagnostic (Claude in Chrome, full console + redirect-chain trace) hoping to justify
filtering out 3rd-party aggregators. The data said the opposite: Adzuna and Jobgether were NOT the
blockers (clean pass-through both times); the real friction was Workday requiring account creation
and Oracle Cloud requiring an email step — i.e. the EMPLOYER'S OWN official ATS, exactly the
"direct company link" destination filtering would supposedly get you to. Filtering 3rd-party sites
would not have fixed anything here.

Root cause, found by re-reading `autofill.js`'s own header comment ("Real page navigations end this
script's life; background.js re-injects it on the next page load") against `background.js`'s actual
listeners: the ONLY re-injection for client-side ("SPA") route changes — `onHistoryStateUpdated`, no
full page load, just history.pushState — was scoped EXCLUSIVELY to `linkedin.com`. Workday, Zoho
Recruit, and Oracle Cloud Recruiting are all SPAs; "Apply Manually" / "I'm interested" / the
email-capture step are client-side route changes, not full navigations. Alicia ran once on the FIRST
load of each site (exactly where the diagnostic saw the nav panel), then went permanently dark for
every subsequent in-app step — no console output, no fill attempt, nothing. This single gap explains
all 5 "blocked" outcomes in the diagnostic, including the mystery pre-filled Oracle Cloud email
(almost certainly Chrome's own native autofill, unrelated to Alicia, since Alicia's script wasn't
even running on that screen).

**Fix (`background.js`):** generalized the LinkedIn-only `onHistoryStateUpdated` re-injection to any
tab with a live `autofillSessions` entry — on a client-side route change, if the tab has a
non-expired session, re-inject `autofill.js` (pre-seeding the tailored résumé first, same as the
full-navigation path). Re-injection is a safe no-op / re-invoke if the script is already alive in
that frame (the existing `if (window.__aliciaAutofillRun) { window.__aliciaAutofillRun(); return; }`
guard at the top of autofill.js already handles this correctly — it re-runs the full scan against
the NEW SPA-rendered DOM, it doesn't just no-op). Factored the "pre-seed tailored résumé, then
inject" logic into a shared `injectAutofillWithTailoredResume()` used by both the full-navigation and
SPA-navigation listeners, so the two paths can't drift.

Verified: loaded the REAL `background.js` into a `vm.runInContext` sandbox with mocked `chrome.*` APIs
(including a filter-respecting `onHistoryStateUpdated` mock, since Chrome's own `hostSuffix` URL
filter had to be faithfully emulated to test the LinkedIn-exclusion case correctly) and exercised 6
scenarios: re-injects on a live session, pre-seeds the tailored résumé, excludes LinkedIn (owned by
the pre-existing listener), no-ops with no session / an expired session / a non-top-frame update. All
pass. Live re-test on an actual Workday account-creation page still needs a human run to confirm the
password-fill/Create-Account auto-click now fires.

**On "filter out 3rd-party sites"**: not recommended based on this data. 3 of 5 jobs in the diagnostic
reached a real application form through paths that included Adzuna/Jobgether; blanket-filtering them
would shrink the results pool for no measurable benefit, since the actual friction lives on employer
ATS platforms themselves (no aggregator-avoidance dodges a Workday account-creation requirement).

## Update 2026-07-08 — v1.13.0: dynamic fallback tier for arbitrary company career sites

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
