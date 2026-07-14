// Focused regression test for skipAggregatorInterstitial (background.js) -- a self-contained
// function (references only document/location/setTimeout, no chrome.* or other module-scope
// vars) that background.js hands to chrome.scripting.executeScript to run INSIDE a live page, not
// in the service worker itself -- so tests/background-harness.mjs's no-DOM vm context can't
// exercise its actual click logic (it only verifies background.js picks the right function
// reference, see tests/background.test.mjs). This extracts the real function source and runs it
// in jsdom, same "test the real code" philosophy as the other harnesses in this project.
//
// Found live, real posting (Jooble "AI Automation Engineer -Remote at Quora"): its own "Apply"
// link is target="_blank". clickByText's old behavior called .click() on it every ~1s for the
// whole 12s poll -- a synthetic click has isTrusted=false, so Chrome's popup blocker correctly
// blocked the new-tab open each time, producing a burst of blocked-popup notifications for zero
// actual progress (the CURRENT tab, which is what the closed-loop host check upstream watches,
// never navigated). Fixed: a target="_blank" match now sets location.href directly instead of
// clicking, and a successful DISMISS click skips PROCEED in that same cycle instead of doing both
// unconditionally every poll.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BG_SRC = readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
// Brace-counting extraction (not a regex) -- the function body has its own nested braces
// (try/catch, an inner IIFE), so a naive "find the next closing brace" regex grabs the wrong one.
const START_MARKER = 'function skipAggregatorInterstitial()'
const startIdx = BG_SRC.indexOf(START_MARKER)
if (startIdx === -1) throw new Error('Could not find skipAggregatorInterstitial in background.js -- did its signature change?')
const braceStart = BG_SRC.indexOf('{', startIdx)
let depth = 0, endIdx = -1
for (let i = braceStart; i < BG_SRC.length; i++) {
  if (BG_SRC[i] === '{') depth++
  else if (BG_SRC[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break } }
}
if (endIdx === -1) throw new Error('Could not find the matching closing brace for skipAggregatorInterstitial')
const FN_SRC = BG_SRC.slice(startIdx, endIdx)

// Loads the REAL extracted function into a fresh jsdom window with a fake, controllable clock (the
// function's own poll uses real setTimeout at 1000ms x 12 -- tests advance a mocked one instead of
// waiting 12 real seconds), and runs it. Returns { window, document, clickCounts } for assertions.
function run(html, { url } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, pretendToBeVisual: true, runScripts: 'dangerously' })
  const window = dom.window
  // jsdom does no real layout, so offsetParent is always null -- clickByText's visibility check
  // (`!el.offsetParent && el.tagName !== 'A'`) would skip every non-anchor control otherwise. Same
  // workaround tests/harness.mjs already uses for autofill.js.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.hidden || this.style.display === 'none' ? null : this.ownerDocument.body },
  })
  // jsdom's `location.href` accessor is non-configurable (can't Object.defineProperty over it),
  // and jsdom doesn't actually perform navigation on assignment anyway (same class of "not
  // implemented" limitation as HTMLFormElement.requestSubmit, seen elsewhere in this project's
  // fixtures) -- reading window.location.href back afterward would just show the ORIGINAL url.
  // Spy on the assignment by LEXICAL shadowing instead: wrap the extracted function source in a
  // closure that declares its own `location` parameter (reads pass through to the real one,
  // writes get recorded) -- the function's bare `location` references resolve to this closure's
  // local binding at call time, same as they'd resolve to window.location in the real page, no
  // property redefinition needed.
  const hrefAssignments = []
  const fakeLocation = {
    get href() { return window.location.href },
    set href(v) { hrefAssignments.push(v) },
    get hostname() { return window.location.hostname },
  }
  const clickCounts = {}
  // Wrap every element's click() to count calls by a data-test-id, so a test can assert something
  // was NOT repeatedly clicked without relying on the real (blocked) window.open side effect.
  window.document.querySelectorAll('a,button').forEach((el) => {
    const real = el.click.bind(el)
    el.click = function () {
      const id = el.getAttribute('data-test-id') || el.textContent.trim()
      clickCounts[id] = (clickCounts[id] || 0) + 1
      return real()
    }
  })
  window.__fakeLocation = fakeLocation
  window.eval('(function (location) {\n' + FN_SRC + '\nwindow.__run = skipAggregatorInterstitial;\n})(window.__fakeLocation)')
  window.__run()
  return { window, document: window.document, clickCounts, hrefAssignments }
}

test('skipAggregatorInterstitial: a target="_blank" PROCEED match navigates the CURRENT tab via location.href, never calls .click() on it', () => {
  const { clickCounts, hrefAssignments } = run(
    '<a id="apply" href="https://real-employer.example/apply" target="_blank">Apply</a>',
    { url: 'https://jooble.org/desc/123' }
  )
  assert.deepStrictEqual(hrefAssignments, ['https://real-employer.example/apply'], 'a target="_blank" match must set location.href to its own destination directly, not open a new one')
  assert.strictEqual(clickCounts.apply, undefined, '.click() must never be called on a target="_blank" match (that\'s exactly what got blocked as a popup live)')
})

test('skipAggregatorInterstitial: DISMISS success skips PROCEED in the same cycle (does not also click a target="_blank" Apply link behind the popup)', () => {
  const { clickCounts, hrefAssignments } = run(
    '<button id="skip">Skip for now</button><a id="apply" href="https://real-employer.example/apply" target="_blank">Apply</a>',
    { url: 'https://jooble.org/desc/456' }
  )
  assert.strictEqual(clickCounts['Skip for now'], 1, 'the dismiss button should be clicked once')
  assert.deepStrictEqual(hrefAssignments, [], 'the current tab must NOT navigate away when a dismiss (not a proceed) is what fired this cycle -- the old unconditional "run both every cycle" behavior would have')
})

test('skipAggregatorInterstitial: a normal same-tab PROCEED link (no target="_blank") still uses a real .click(), unchanged behavior', () => {
  const { clickCounts } = run(
    '<a id="apply" href="https://real-employer.example/apply">Apply Now</a>',
    { url: 'https://jooble.org/desc/789' }
  )
  assert.strictEqual(clickCounts['Apply Now'], 1, 'an ordinary same-tab link must still be clicked normally')
})
