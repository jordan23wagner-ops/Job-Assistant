// Regression test for the bug class that every other test in this suite is structurally BLIND
// to: a React-/framework-controlled input REVERTING a programmatically-set value on its next
// render. Confirmed live on Anthropic's job-boards.greenhouse.io form (see autofill.js's
// forceTypeValue comment, ~line 888): a plain setNativeValue()+dispatchEvent('input') filled the
// contact fields correctly (the fill log proved it), but React silently reverted them to empty.
// jsdom (tests/harness.mjs, tests/autofill.test.mjs) has no real framework runtime, so there is
// no re-render to revert anything — that class of bug is invisible to it no matter how many
// fixtures get added. This file closes that gap with a deterministic SIMULATION of the revert
// mechanism (no real React, no browser, no new dependency) that still exercises the REAL
// forceTypeValue/setNativeValue code paths in autofill.js, unmodified.
//
// The mechanism being simulated (see forceTypeValue's own comment in autofill.js for the real-
// world version): React attaches a per-input `_valueTracker` that records "the value React last
// saw." Setting `.value` through the raw HTMLInputElement.prototype setter (what setNativeValue
// does) never touches that tracker. Only the browser's own native text-editing pipeline — driven
// by `document.execCommand('insertText', ...)`, which forceTypeValue uses specifically for this
// reason — keeps the tracker in sync. On React's next render, a controlled input's DOM value is
// authoritatively re-stamped from React's own state; if the tracker was never updated, React's
// change-detection thinks nothing really happened, never updated its state, and the re-stamp
// reverts the field.
//
// jsdom does not implement `document.execCommand` at all (confirmed: it's `undefined`, not even
// a stub) — which is itself *why* the original bug was invisible here: forceTypeValue's own
// `document.execCommand && ...` check short-circuits and every call silently takes the exact same
// fallback path as the old code (setNativeValue+fire), so no test exercising forceTypeValue as a
// black box could ever have told the two code paths apart. This file installs a minimal
// execCommand('insertText') polyfill that reproduces just enough of the real browser's native
// text-editing pipeline (see below) so that forceTypeValue's actual "took the browser-native path"
// branch runs for real, and the difference between it and the plain setNativeValue+fire path
// becomes observable.
//
// The fixture (tests/fixtures/framework-controlled.html) has two fields that go through two
// genuinely different REAL code paths in autofill.js:
//   - first_name: filled via fillStdFields -> forceTypeValue (the fixed path, ~line 988)
//   - create_password: filled via fillPasswordFields -> setNativeValue+fire directly, with no
//     forceTypeValue fallback at all (~line 1016) — a real, still-current use of the OLD
//     technique elsewhere in the same file, useful here as a live "control group."
// Both fields get the identical revert simulation. If someone reverts forceTypeValue back to a
// plain setNativeValue+fire, this test fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTOFILL_SRC = readFileSync(path.join(__dirname, '..', 'autofill.js'), 'utf8')
const FIXTURE_HTML = readFileSync(path.join(__dirname, 'fixtures', 'framework-controlled.html'), 'utf8')

// Simulates a React-style controlled input on `el`. Returns a `rerender()` you call to simulate
// the framework's next render pass re-stamping the DOM value from its own internal state — the
// moment a real revert would happen. This is a SIMULATION of the framework's behavior (permitted —
// there's no real React here), not a reimplementation of anything autofill.js does; the actual
// value-setting techniques under test (setNativeValue, forceTypeValue's execCommand branch) are
// the real, unmodified functions from autofill.js.
function attachControlledInputSim(win, el) {
  const tracker = { value: el.value }
  el._valueTracker = tracker // the page-world expando forceTypeValue's comment describes
  let frameworkState = el.value // what the framework "believes" the value is
  el.addEventListener('input', () => {
    // Real React's updateValueIfChanged, simplified: only a change that came through the tracked
    // native pipeline (tracker in sync with the DOM value at this instant) is accepted as genuine
    // and committed to framework state. A value set via the raw prototype setter leaves the
    // tracker stale, so this branch is skipped and the state (and thus the next render) never
    // learns about the new value.
    if (tracker.value === el.value) frameworkState = el.value
  })
  return {
    rerender() {
      if (el.value === frameworkState) return // nothing to do -- matches real React (no-op render)
      const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, frameworkState)
    },
    getFrameworkState: () => frameworkState,
  }
}

test('forceTypeValue survives a simulated framework revert; the old setNativeValue+fire path (still used for passwords) does not', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>${FIXTURE_HTML}</body></html>`, {
    url: 'https://job-boards.greenhouse.io/anthropic/jobs/0000001',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  })
  const window = dom.window
  const document = window.document

  // Same jsdom-has-no-layout workaround as tests/harness.mjs — otherwise every field reads as
  // invisible and nothing gets filled at all.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      for (let el = this; el; el = el.parentElement) {
        if (el.hidden || el.style.display === 'none' || el.getAttribute('type') === 'hidden') return null
      }
      return this.ownerDocument.body
    },
  })
  // Same MutationObserver stub as tests/harness.mjs -- prevents an infinite self-rerun loop that
  // has nothing to do with what this test checks.
  window.MutationObserver = class { observe() {} disconnect() {} }

  const firstName = document.getElementById('first_name')
  const password = document.getElementById('create_password')
  const firstNameSim = attachControlledInputSim(window, firstName)
  const passwordSim = attachControlledInputSim(window, password)

  // Minimal execCommand('insertText') polyfill -- see file header. Reproduces the ONE property of
  // the real browser's native text-editing pipeline this test cares about: unlike a script calling
  // the raw prototype value setter directly, it keeps a framework's value tracker in sync.
  let execCommandInsertTextCalls = 0
  window.document.execCommand = function (cmd, _ui, value) {
    if (cmd !== 'insertText') return false
    const el = window.document.activeElement
    if (!el || !('value' in el)) return false
    execCommandInsertTextCalls++
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    if (el._valueTracker) el._valueTracker.value = value // the real native pipeline keeps this in sync
    el.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    return true
  }

  let resolveResult
  const resultPromise = new Promise((resolve) => { resolveResult = resolve })
  window.chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage(msg) {
        if (msg && msg.type === 'UNIVERSAL_FILL_RESULT') resolveResult(msg.result)
        return Promise.resolve()
      },
    },
    storage: {
      local: {
        get(_keys, cb) { cb({ profile: { firstName: 'Jordan', lastName: 'Wagner', email: 'jordan.test@example.com', phone: '5551234567' } }) },
        set() {},
      },
    },
  }
  window.fetch = () => Promise.reject(new Error('unexpected network call from a fixture test'))

  const timer = setTimeout(() => resolveResult(undefined), 4000)
  window.eval(AUTOFILL_SRC)
  await resultPromise
  clearTimeout(timer)
  window.setTimeout = () => 0 // stop autofill.js's own re-scheduling, same as harness.mjs

  // Sanity check: forceTypeValue actually took the browser-native execCommand branch (i.e. this
  // test is exercising the fixed code path for real, not silently falling back).
  assert.ok(execCommandInsertTextCalls >= 1, 'expected forceTypeValue to call document.execCommand(\'insertText\') at least once')
  assert.equal(firstName.value, 'Jordan', 'sanity check: first_name should be filled before any simulated revert')
  assert.equal(password.value.length > 0, true, 'sanity check: password should be filled before any simulated revert')

  // Now simulate the framework's next render for BOTH fields -- the exact moment the live
  // Greenhouse bug happened.
  firstNameSim.rerender()
  passwordSim.rerender()

  assert.equal(
    firstName.value, 'Jordan',
    'forceTypeValue must survive a framework revert -- if this fails, forceTypeValue has regressed back to a plain setNativeValue+fire (the original Greenhouse bug)'
  )
  assert.equal(
    password.value, '',
    'documents the OTHER side of the same mechanism: the plain setNativeValue+fire path (still used for password fields, autofill.js ~line 1016) is NOT immune to a framework revert -- this is exactly the bug class forceTypeValue exists to fix, proven against the real, unmodified functions'
  )
})
