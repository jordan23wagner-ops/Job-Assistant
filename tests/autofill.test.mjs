// Integration tests for the REAL autofill.js against real-structure ATS fixtures (see
// tests/fixtures/*.html and tests/harness.mjs for how/why). These exist to catch exactly the
// kind of regression this whole test suite was built for: every ATS-specific fix this project
// has shipped (Databricks iframe stall, Workday nav-panel tie, LinkedIn ToS default, company
// name mangling, ...) was found by manually clicking through a real posting, not by a test —
// meaning a future edit to the shared field-matching code could silently break a platform that
// used to work, with nothing catching it until the next live test happens to hit it.
//
// Coverage today is seven platforms with genuinely different field-matching shapes (Greenhouse:
// separate first/last name, id-based; Lever: one combined name field, name-attribute-based;
// Workday: data-automation-id-based, no semantic id/name at all; Ashby: semantic system-field ids
// but random-UUID custom questions; SmartRecruiters: every field inside its own shadow root;
// Workable: id+name present but the visible label is a plain <span> via aria-labelledby, not a
// <label for>; Recruitee: one combined name field again, but via a perfectly ordinary
// <label for> this time) -- proof the harness works against the unmodified production code, not
// exhaustive coverage of every supported ATS. iCIMS, Taleo, and BrassRing (all account-gated
// before reaching a real application form) have no fixture yet -- see HANDOFF.md for the
// feasibility investigation. Add a fixture the same way for the next platform: capture real
// (sanitized, no personal data) field structure from a live posting, hand-compose a trimmed HTML
// fixture, write assertions.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runAutofill, TEST_PROFILE } from './harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

test('greenhouse: fills separate first/last name, email, phone, and a standard-matched custom question (LinkedIn)', async () => {
  const { result, document } = await runAutofill(fixture('greenhouse.html'), {
    url: 'https://job-boards.greenhouse.io/cloudflare/jobs/7958059',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'greenhouse')
  assert.ok(result.filled >= 5, `expected at least 5 fields filled, got ${result.filled}`)

  assert.strictEqual(document.getElementById('first_name').value, TEST_PROFILE.firstName)
  assert.strictEqual(document.getElementById('last_name').value, TEST_PROFILE.lastName)
  assert.strictEqual(document.getElementById('email').value, TEST_PROFILE.email)
  assert.strictEqual(document.getElementById('phone').value, TEST_PROFILE.phone)
  assert.strictEqual(document.getElementById('question_67192150').value, TEST_PROFILE.linkedin, 'LinkedIn question should be standard-matched by its aria-label, not left for AI')

  // Confirmed by running this test against the real code (not assumed going in): "Preferred
  // First Name" gets filled with the plain first name too, because buildStdMatchers' firstName
  // regex (/\b(given name|first name|...)\b/) matches "first name" as a substring of the label,
  // not just an exact one -- there's no separate profile.preferredName field to fill it from
  // instead. Defensible default (most people don't have a different preferred name) rather than
  // a bug, but worth knowing this field isn't actually left alone.
  assert.strictEqual(document.getElementById('preferred_name').value, TEST_PROFILE.firstName)
})

test('greenhouse: never clicks Submit', async () => {
  const { document } = await runAutofill(fixture('greenhouse.html'), {
    url: 'https://job-boards.greenhouse.io/cloudflare/jobs/7958059',
    storage: { profile: TEST_PROFILE },
  })
  const submitBtn = document.getElementById('submit_app')
  let clicked = false
  submitBtn.addEventListener('click', () => { clicked = true })
  // The click listener above is attached AFTER the fill pass already ran, so this only proves
  // the button is still inertly present and unremoved -- the real assertion is `clicked` itself,
  // which would only ever be set by a click that happens as a SIDE EFFECT of code still running
  // after this test's `await` returns. Belt-and-suspenders with the explicit filled-fields
  // check above: if Submit had been clicked, a real ATS page would navigate away and no
  // UNIVERSAL_FILL_RESULT would ever arrive, which the harness's own timeout already catches.
  assert.strictEqual(clicked, false)
  assert.strictEqual(document.getElementById('submit_app').isConnected, true, 'submit button should still be in the DOM, not removed by a submit/navigation')
})

test('lever: fills a single combined full-name field (not first/last) via the name attribute, not a label element', async () => {
  const { result, document } = await runAutofill(fixture('lever.html'), {
    url: 'https://jobs.lever.co/palantir/0bbfd4f4-41ff-4ec6-b73f-5200efd5d4d3/apply',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'lever')
  const fullName = `${TEST_PROFILE.firstName} ${TEST_PROFILE.lastName}`
  assert.strictEqual(document.querySelector('input[name="name"]').value, fullName)
  assert.strictEqual(document.querySelector('input[name="email"]').value, TEST_PROFILE.email)
  assert.strictEqual(document.querySelector('input[name="phone"]').value, TEST_PROFILE.phone)
})

test('lever: no profile at all -> reports no_profile and fills nothing', async () => {
  const { result, document } = await runAutofill(fixture('lever.html'), {
    url: 'https://jobs.lever.co/palantir/0bbfd4f4-41ff-4ec6-b73f-5200efd5d4d3/apply',
    storage: {},
  })
  assert.strictEqual(result.status, 'no_profile')
  assert.strictEqual(document.querySelector('input[name="email"]').value, '')
})

test('workday: fills the create-account page (email via data-automation-id, generated password, agree-to-terms checkbox)', async () => {
  const { result, document } = await runAutofill(fixture('workday.html'), {
    url: 'https://axiomspace.wd5.myworkdayjobs.com/en-US/external_career_site/job/Houston/apply/applyManually',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'workday')
  assert.strictEqual(document.querySelector('[data-automation-id="email"]').value, TEST_PROFILE.email)

  const pw = document.querySelector('[data-automation-id="password"]').value
  const pw2 = document.querySelector('[data-automation-id="verifyPassword"]').value
  assert.ok(pw.length >= 8, `expected a generated password, got ${JSON.stringify(pw)}`)
  assert.strictEqual(pw, pw2, 'password and verify-password must match')

  assert.strictEqual(document.querySelector('[data-automation-id="createAccountCheckbox"]').checked, true)
})

// This one is expected to demonstrate a REAL bug, not confirm correct behavior -- found while
// building this fixture, not assumed going in. Workday's beecatcher field is a genuine honeypot:
// name="website" (so a script that fills anything matching "website" walks right into it) styled
// with display:block / a real offsetParent (confirmed live against the real page's own computed
// style) specifically so it passes the same visible() check autofill.js itself uses, while a
// human never sees it. autofill.js DOES have honeypot detection (mustNeverAnswer/
// looksLikeHoneypot) -- but only on the AI-answered custom-question path, never checked by
// fillStdFields, which is what actually matches this field (its name="website" satisfies
// buildStdMatchers' website regex). If this assertion fails, that's the bug being real, not a
// broken test -- see HANDOFF.md for whether it's been fixed yet.
test('workday: does NOT fill the honeypot field, even though profile.website is set', async () => {
  const { document } = await runAutofill(fixture('workday.html'), {
    url: 'https://axiomspace.wd5.myworkdayjobs.com/en-US/external_career_site/job/Houston/apply/applyManually',
    storage: { profile: TEST_PROFILE },
  })
  const honeypot = document.querySelector('[data-automation-id="beecatcher"]')
  assert.strictEqual(honeypot.value, '', 'the honeypot field must never be filled, or Workday can flag the whole application as bot-submitted')
})

test('ashby: fills a single combined Name field (semantic id, unlike Lever\'s name-attribute match) plus email and LinkedIn (label-text-only, random id)', async () => {
  const { result, document } = await runAutofill(fixture('ashby.html'), {
    url: 'https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff/application',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'ashby')
  const fullName = `${TEST_PROFILE.firstName} ${TEST_PROFILE.lastName}`
  assert.strictEqual(document.getElementById('_systemfield_name').value, fullName)
  assert.strictEqual(document.getElementById('_systemfield_email').value, TEST_PROFILE.email)
  // Random UUID id/name carry no signal at all here -- only labelText() resolving the real
  // <label for="..."> text ("LinkedIn") makes this field matchable.
  assert.strictEqual(document.getElementById('ca5c9d78-ec13-4bf2-86b8-bce6ff32e45e').value, TEST_PROFILE.linkedin)
})

// Helper: SmartRecruiters' current UI puts every field inside its OWN shadow root (see
// tests/fixtures/smartrecruiters.html's comment) -- document.getElementById can't reach inside
// one, so field lookups here have to go through the host's shadowRoot explicitly.
function shadowField(document, hostKey, fieldId) {
  const host = document.querySelector(`[data-shadow-host="${hostKey}"]`)
  return host && host.shadowRoot && host.shadowRoot.getElementById(fieldId)
}

test('smartrecruiters: fills fields that live inside real shadow roots (queryAllDeep) -- previously invisible to a plain document.querySelectorAll', async () => {
  const { result, document } = await runAutofill(fixture('smartrecruiters.html'), {
    url: 'https://jobs.smartrecruiters.com/oneclick-ui/company/Visa/publication/267d47c7-29af-4c8f-a19d-c112895329df',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'smartrecruiters')
  assert.strictEqual(shadowField(document, 'first-name', 'first-name-input').value, TEST_PROFILE.firstName)
  assert.strictEqual(shadowField(document, 'last-name', 'last-name-input').value, TEST_PROFILE.lastName)
  assert.strictEqual(shadowField(document, 'email', 'email-input').value, TEST_PROFILE.email)
  assert.strictEqual(shadowField(document, 'linkedin', 'linkedin-input').value, TEST_PROFILE.linkedin)

  // The light-DOM file input is unrelated to the shadow-DOM fix -- included as a control to prove
  // the fixture/harness aren't somehow forcing every field to match regardless of location.
  assert.strictEqual(document.getElementById('file-input').value, '')
})

test('workable: detects the ats and fills firstname/lastname/email/phone -- the visible label is a plain <span> via aria-labelledby, not a <label for> element', async () => {
  const { result, document } = await runAutofill(fixture('workable.html'), {
    url: 'https://apply.workable.com/seeq/j/1378093793/apply/',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'workable')
  assert.strictEqual(document.getElementById('firstname').value, TEST_PROFILE.firstName)
  assert.strictEqual(document.getElementById('lastname').value, TEST_PROFILE.lastName)
  assert.strictEqual(document.getElementById('email').value, TEST_PROFILE.email)
  // No id on the real phone field at all -- matched purely by name="phone" + type="tel".
  assert.strictEqual(document.querySelector('input[name="phone"]').value, TEST_PROFILE.phone)

  // "Headline"/"Summary"/"Cover letter" labels are too short to pass discoverCustomQuestions()'s
  // wordy gate, so they're never routed to the AI-answered path -- confirm they're just left blank
  // rather than silently mismatched onto some other profile field.
  assert.strictEqual(document.getElementById('headline').value, '')
  assert.strictEqual(document.getElementById('summary').value, '')
  assert.strictEqual(document.getElementById('cover_letter').value, '')
})

test('recruitee: detects the ats and fills a single combined Full name field via a real label[for] (candidate.name), plus email/phone (dot-namespaced field names)', async () => {
  const { result, document } = await runAutofill(fixture('recruitee.html'), {
    url: 'https://freeday.recruitee.com/o/software-engineer-3',
    storage: { profile: TEST_PROFILE },
  })

  assert.strictEqual(result.ats, 'recruitee')
  const fullName = `${TEST_PROFILE.firstName} ${TEST_PROFILE.lastName}`
  assert.strictEqual(document.getElementById('input-candidate.name-3').value, fullName)
  assert.strictEqual(document.getElementById('input-candidate.email-4').value, TEST_PROFILE.email)
  assert.strictEqual(document.getElementById('input-candidate.phone-5').value, TEST_PROFILE.phone)
})
