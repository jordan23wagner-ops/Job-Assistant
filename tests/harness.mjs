// Test harness for autofill.js: loads the REAL, unmodified production file into a jsdom
// window (not a reimplementation or a mock of the fill logic) with a fixture ATS page and a
// mocked chrome extension API, then runs the actual entry point and reports what happened.
//
// Why this shape: autofill.js is a plain content-script IIFE (no build step, no exports) that
// assigns its entry point to `window.__aliciaAutofillRun` and self-invokes once at load. This
// harness sets up `chrome.storage`/`chrome.runtime` as an in-memory mock BEFORE loading the
// script, evals the real file's source into the jsdom window, and waits for the
// UNIVERSAL_FILL_RESULT message the real code sends via chrome.runtime.sendMessage (the same
// message background.js listens for in production) rather than trying to intercept an internal
// function — that keeps the harness honest to the real message-passing contract instead of
// reaching into implementation details.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTOFILL_SRC = readFileSync(path.join(__dirname, '..', 'autofill.js'), 'utf8')

// Runs autofill.js against `html` at `url`, seeded with `storage` (profile/eeoPrefs/etc, the
// same shape chrome.storage.local holds in production). Resolves once the script reports a
// result, with { result, document, window, sentMessages } for assertions. Rejects if no result
// arrives within `timeoutMs` (e.g. a fixture that needs an AI-answered custom question and
// would otherwise hang on the network call this harness deliberately doesn't allow through).
export async function runAutofill(html, { url, storage = {}, timeoutMs = 4000 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url, pretendToBeVisual: true, runScripts: 'dangerously',
  })
  const window = dom.window

  const sentMessages = []
  let resolveResult, rejectResult
  const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })

  // jsdom does no real layout, so offsetParent is always null -- autofill.js's visible() check
  // (`el.offsetParent !== null`) would otherwise skip every field in every fixture, not because
  // of anything the fixture or the field-matching logic got wrong. This is the standard jsdom
  // workaround: report anything not explicitly hidden as visible.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      if (this.hidden || this.style.display === 'none' || this.getAttribute('type') === 'hidden') return null
      return this.ownerDocument.body
    },
  })

  // autofill.js watches document.body with a MutationObserver and re-runs itself on every
  // childList mutation (by design -- a real page's own SPA re-render should trigger a re-fill).
  // In this harness that becomes a genuine infinite loop: confirmed live, hundreds of re-entrant
  // "run() start" log lines, because nothing here ever stops mutating and nothing ever navigates
  // away the way a real tab eventually would. A test only needs one clean fill pass, not
  // "watch forever" -- stub MutationObserver out entirely rather than trying to time a cutoff.
  window.MutationObserver = class { observe() {} disconnect() {} };

  window.chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage(msg) {
        sentMessages.push(msg)
        if (msg && msg.type === 'UNIVERSAL_FILL_RESULT') resolveResult(msg.result)
        return Promise.resolve()
      },
    },
    storage: {
      local: {
        get(keys, cb) { cb({ ...storage }) },
        set(obj) { Object.assign(storage, obj) },
      },
    },
  }
  // No network calls should happen in these fixture tests (all fields are standard-matched) --
  // fail loudly rather than hang or silently hit a real endpoint if that assumption breaks.
  window.fetch = () => Promise.reject(new Error('unexpected network call from a fixture test'))
  // Workday's "Create Account" button IS meant to be auto-clicked (WD_ADVANCE explicitly includes
  // it -- it's a real wizard step, not the final application submit, which is a separate,
  // never-clicked STOP pattern). That click reaches jsdom's own internal, unimplemented
  // HTMLFormElementImpl.requestSubmit and logs a harmless "not implemented" line on every run --
  // patching window.HTMLFormElement.prototype.requestSubmit does NOT suppress it (jsdom's button
  // activation behavior calls its own internal impl directly, bypassing the exposed prototype
  // method), so this is expected console noise on Workday fixture runs, not a real error and not
  // worth fighting jsdom internals over. All assertions still pass regardless.

  const timer = setTimeout(() => rejectResult(new Error(`timed out after ${timeoutMs}ms waiting for UNIVERSAL_FILL_RESULT — did the fixture trigger an unmocked code path (e.g. an AI-answered custom question)?`)), timeoutMs)

  window.eval(AUTOFILL_SRC)
  let result
  try {
    result = await resultPromise
  } finally {
    clearTimeout(timer)
  }
  // autofill.js deliberately re-schedules itself (setTimeout) to re-fill if the page changes --
  // exactly right in a real browser tab that eventually navigates away or gets torn down, but
  // with nothing to stop it here those timers keep firing in this jsdom window forever, well
  // after this function has already returned (confirmed live: hundreds of "run() start" log
  // lines interleaved across unrelated tests before this fix). Neutering setTimeout AFTER we
  // have our result -- rather than window.close(), which also detaches window.document and
  // breaks every assertion the caller wants to make -- stops all future reschedules while
  // leaving the DOM fully readable.
  window.setTimeout = () => 0

  return { result, document: window.document, window, sentMessages }
}

export const TEST_PROFILE = {
  firstName: 'Jordan', lastName: 'Wagner', email: 'jordan.test@example.com', phone: '5551234567',
  linkedin: 'https://linkedin.com/in/jordan-test', website: 'https://jordan-test.example',
  city: 'Katy', state: 'Texas', zip: '77494',
}
