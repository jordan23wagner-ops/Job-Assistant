// Regression tests for the REAL background.js against a mocked chrome.* (see
// tests/background-harness.mjs for how/why this doesn't need jsdom the way autofill.test.mjs
// does). These exist to close a real gap: two live bugs were found and fixed in this same
// session --
//
//   1. onHistoryStateUpdated (the SPA-nav re-inject listener) was missing the aggregator-host
//      check that the full-page-load listener (onUpdated) already had, so real name/email/phone
//      got filled into aggregator/lead-gen signup forms (confirmed live on jooble.org and
//      lensa.com) instead of clicking through them. Fixed by routing both listeners through one
//      shared `routeAggregatorOrInject()`.
//   2. A follow-up race: chrome.tabs.create's tab-creation and its async session-record write can
//      land in the wrong order relative to the tab's 'complete' event, so the aggregator
//      click-through could silently never engage. Fixed with a race-recovery check guarded by a
//      new `s.routed` flag so a WON race (onUpdated already handled it normally) never
//      double-routes.
//
// Both fixes were verified live at the time (twice for #1, but a third live re-check of #2 was
// blocked by Cloudflare's bot-detection CAPTCHA on the repro site, which must never be solved/
// bypassed) -- so until these tests, nothing but a live click-through could catch a regression in
// either one. These tests exercise the REAL routeAggregatorOrInject function and the REAL
// listener functions background.js registers, not a reimplementation of the routing rules.
import { test } from 'node:test'
import assert from 'node:assert'
import { loadBackground, flushPromises } from './background-harness.mjs'

// ===== 1. routeAggregatorOrInject: aggregator hosts route to the click-through, never to autofill =====
// The single shared function both listeners (and the race-recovery path) now call -- this is
// exactly the function whose missing call site on onHistoryStateUpdated caused the live data leak.
for (const host of ['www.jooble.org', 'lensa.com']) {
  test(`routeAggregatorOrInject: aggregator host (${host}) routes to skipAggregatorInterstitial, not autofill.js injection`, async () => {
    const { context, api } = loadBackground()
    api.setTab(7, { url: `https://${host}/some-listing`, status: 'complete' })

    context.routeAggregatorOrInject(7, { explicit: true }, host, 'unit-test')
    await flushPromises()

    const aggCalls = api.executeScriptCalls.filter((c) => c.func === context.skipAggregatorInterstitial)
    assert.strictEqual(aggCalls.length, 1, `expected exactly one skipAggregatorInterstitial call, got ${aggCalls.length}`)
    assert.strictEqual(aggCalls[0].target.tabId, 7)
    assert.ok(
      !api.executeScriptCalls.some((c) => Array.isArray(c.files) && c.files.includes('autofill.js')),
      'autofill.js must never be injected for an explicit session on an aggregator host'
    )
  })
}

// ===== 2. routeAggregatorOrInject: non-aggregator hosts inject autofill.js =====
test('routeAggregatorOrInject: non-aggregator host (boards.greenhouse.io) injects autofill.js, not skipAggregatorInterstitial', async () => {
  const { context, api } = loadBackground()
  api.setTab(9, { url: 'https://boards.greenhouse.io/acme/jobs/12345', status: 'complete' })

  context.routeAggregatorOrInject(9, { explicit: true }, 'boards.greenhouse.io', 'unit-test')
  // injectAutofillWithTailoredResume -> clearStopFlag(tabId).then(afterClear, afterClear) -> inject()
  // is a real Promise chain (clearStopFlag itself calls chrome.scripting.executeScript(...).catch(...)),
  // so the files:['autofill.js'] call lands a couple of microtask ticks after this call returns.
  await flushPromises()

  const fillCalls = api.executeScriptCalls.filter((c) => c.target.tabId === 9 && Array.isArray(c.files) && c.files.includes('autofill.js'))
  assert.strictEqual(fillCalls.length, 1, `expected exactly one autofill.js injection, got ${fillCalls.length}`)
  assert.ok(
    !api.executeScriptCalls.some((c) => c.func === context.skipAggregatorInterstitial),
    'a non-aggregator host must never be routed to skipAggregatorInterstitial'
  )
})

// ===== 3. WEBAPP_APPLY race-recovery: lost race -> recovery routes exactly once =====
// Simulates the exact race this session's second fix addresses: by the time the async session
// write for a newly-created tab lands, chrome.tabs.get already reports the tab as 'complete' --
// meaning the real chrome.tabs.onUpdated 'complete' event already fired and found no session (and
// did nothing), with no further page-load event left to retry on. The race-recovery block inside
// the WEBAPP_APPLY handler must detect this itself and perform the routing decision -- exactly
// once, not zero times (the bug being fixed) and not twice.
test('WEBAPP_APPLY race-recovery: tab already complete when the session write lands -> routes exactly once (lost race)', async () => {
  const { context, api } = loadBackground()

  api.dispatchRuntimeMessage({ type: 'WEBAPP_APPLY', jobs: [{ url: 'https://www.jooble.org/apply/1' }] })
  await flushPromises()

  assert.strictEqual(api.tabsCreateCalls.length, 1, 'expected exactly one tab to be created for one job')
  const tabId = api.tabsCreateCalls[0].tab.id

  const routeCalls = api.executeScriptCalls.filter((c) => c.func === context.skipAggregatorInterstitial && c.target.tabId === tabId)
  assert.strictEqual(routeCalls.length, 1, `expected exactly one race-recovery route call, got ${routeCalls.length}`)
  assert.ok(
    !api.executeScriptCalls.some((c) => c.target.tabId === tabId && Array.isArray(c.files) && c.files.includes('autofill.js')),
    'an aggregator host must route to skipAggregatorInterstitial, never to autofill.js, even via race-recovery'
  )

  const session = api.storage.autofillSessions[String(tabId)]
  assert.strictEqual(session.routed, true, 'race-recovery must mark the session routed so a later real onUpdated event does not re-route it')
})

// ===== 4. WEBAPP_APPLY race-recovery: won race -> the s.routed guard prevents a double-route =====
// The mirror image of #3: chrome.tabs.onUpdated's real 'complete' handling for this tab runs (and
// finishes, including its own 800ms-delayed routing) BEFORE the WEBAPP_APPLY handler's own
// tabs.get + second storage read happen. The race-recovery check must see s.routed already true
// and do nothing -- if it doesn't, the tab gets routed (and, on an ATS host, autofill.js
// re-injected/re-run) twice for one page load.
//
// This is simulated with a one-shot hook on the mock's storage.local.set (see
// setOnceAfterNextSet in background-harness.mjs): the instant the WEBAPP_APPLY handler's session
// write lands, the hook fires the REAL chrome.tabs.onUpdated listener for this tab (as chrome
// would if the 'complete' event happened to arrive right then) and advances the fake clock past
// its internal 800ms delay, so onUpdated's own routing completes -- all synchronously, all before
// control returns to WEBAPP_APPLY's own tabs.get callback.
test('WEBAPP_APPLY race-recovery: onUpdated already routed before the check runs -> does not double-route (won race, s.routed guard)', async () => {
  const { context, api, clock } = loadBackground()

  api.setOnceAfterNextSet((writtenObj) => {
    if (!writtenObj.autofillSessions) return
    Object.keys(writtenObj.autofillSessions).forEach((idStr) => {
      const tabId = Number(idStr)
      const tab = api.getTab(tabId)
      api.dispatchTabsOnUpdated(tabId, { status: 'complete' }, tab) // the tab's real 'complete' event, arriving right as the write lands
      clock.tick(900) // let onUpdated's own 800ms setTimeout fire and route
    })
  })

  api.dispatchRuntimeMessage({ type: 'WEBAPP_APPLY', jobs: [{ url: 'https://www.jooble.org/apply/2' }] })
  await flushPromises()

  assert.strictEqual(api.tabsCreateCalls.length, 1)
  const tabId = api.tabsCreateCalls[0].tab.id

  const routeCalls = api.executeScriptCalls.filter((c) => c.func === context.skipAggregatorInterstitial && c.target.tabId === tabId)
  assert.strictEqual(
    routeCalls.length, 1,
    `expected exactly one route call (onUpdated's own), got ${routeCalls.length} -- more than one means the s.routed guard failed to stop race-recovery from double-routing`
  )

  const session = api.storage.autofillSessions[String(tabId)]
  assert.strictEqual(session.routed, true)
})

// ===== 5. onHistoryStateUpdated: aggregator host during an active explicit session =====
// Direct regression test for the ORIGINAL data-leak bug this session found and fixed: an SPA
// route change (history.pushState, no full page load) on an aggregator host, while an explicit
// apply session is live, must click through via skipAggregatorInterstitial -- NOT re-inject
// autofill.js, which is exactly what filled real name/email/phone into Jooble's and Lensa's own
// lead-gen forms before this fix. This is the single most valuable regression test in this file.
test('onHistoryStateUpdated (SPA nav): aggregator host during an active explicit session routes to skipAggregatorInterstitial, not autofill.js re-injection', async () => {
  const { context, api, clock } = loadBackground()
  const tabId = 42

  context.chrome.storage.local.set({
    autofillSessions: { [String(tabId)]: { hostname: 'www.jooble.org', startedAt: Date.now(), explicit: true, navs: 0 } },
  })

  api.dispatchOnHistoryStateUpdated({ frameId: 0, tabId, url: 'https://www.jooble.org/leave-your-email-step' })
  clock.tick(600) // the listener defers its check by 500ms to let the SPA render the new view first
  await flushPromises()

  const aggCalls = api.executeScriptCalls.filter((c) => c.func === context.skipAggregatorInterstitial && c.target.tabId === tabId)
  assert.strictEqual(aggCalls.length, 1, `expected exactly one skipAggregatorInterstitial call, got ${aggCalls.length}`)
  assert.ok(
    !api.executeScriptCalls.some((c) => c.target.tabId === tabId && Array.isArray(c.files) && c.files.includes('autofill.js')),
    'REGRESSION: autofill.js must never be re-injected into an aggregator/lead-gen page during an SPA nav -- this is the exact bug that filled real personal data into jooble.org/lensa.com signup forms'
  )

  const session = api.storage.autofillSessions[String(tabId)]
  assert.strictEqual(session.routed, true)
})

// ---- v1.13.49: closed-loop confirmation for the aggregator click-through ----
// Before this, skipAggregatorInterstitial was fire-and-forget: if its 12s click-through poll never
// found a button that worked, the tab just sat on the aggregator page with no signal to the user.
// routeAggregatorOrInject now checks ONCE, after the poll window, whether the tab actually left the
// aggregator host -- still there means a stuck banner + an 'aggregator_stuck' side-panel status.
test('aggregator click-through: tab still on the aggregator host after the poll window -> stuck banner + aggregator_stuck reported (exactly once, no retry loop)', async () => {
  const { context, api, clock } = loadBackground()
  api.setTab(5, { url: 'https://www.jooble.org/jdp/999', status: 'complete' })

  context.routeAggregatorOrInject(5, { explicit: true }, 'www.jooble.org', 'unit-test')
  await flushPromises()
  clock.tick(16000) // past AGGREGATOR_CLICKTHROUGH_CHECK_MS; tab URL unchanged = click-through failed
  await flushPromises()

  const bannerCalls = api.executeScriptCalls.filter((c) => c.func === context.showAggregatorStuckBanner)
  assert.strictEqual(bannerCalls.length, 1, `expected exactly one stuck-banner injection, got ${bannerCalls.length}`)
  clock.tick(60000) // no second check ever fires -- one-shot by design
  await flushPromises()
  assert.strictEqual(api.executeScriptCalls.filter((c) => c.func === context.showAggregatorStuckBanner).length, 1)
})

test('aggregator click-through: tab left the aggregator host (click-through worked) -> no stuck banner', async () => {
  const { context, api, clock } = loadBackground()
  api.setTab(6, { url: 'https://www.jooble.org/jdp/1000', status: 'complete' })

  context.routeAggregatorOrInject(6, { explicit: true }, 'www.jooble.org', 'unit-test')
  await flushPromises()
  api.setTab(6, { url: 'https://boards.greenhouse.io/acme/jobs/1', status: 'complete' }) // the click-through navigated
  clock.tick(16000)
  await flushPromises()

  assert.strictEqual(api.executeScriptCalls.filter((c) => c.func === context.showAggregatorStuckBanner).length, 0, 'a successful click-through must not show the stuck banner')
})

// ---- v1.13.51: debounce duplicate chrome.tabs.onUpdated 'complete' events on the same URL ----
// Chrome firing status:'complete' more than once for a SINGLE real page load is a documented
// extension API quirk -- confirmed live: a real Stripe careers page produced 200+ back-to-back
// 'complete' events for the identical URL, each one re-triggering the full injection pipeline. For
// a SAME-SITE explicit session this had no cap at all (the nav-cap check only applies off-site).
test('onUpdated: a second complete event for the SAME url within the debounce window is skipped, does not re-inject', async () => {
  const { context, api, clock } = loadBackground()
  const tabId = 77
  context.chrome.storage.local.set({
    autofillSessions: { [String(tabId)]: { hostname: 'stripe.com', startedAt: Date.now(), explicit: true, navs: 0 } },
  })
  const tab = { id: tabId, url: 'https://stripe.com/jobs' }

  api.dispatchTabsOnUpdated(tabId, { status: 'complete' }, tab)
  clock.tick(900) // let the real injection's 800ms delay fire
  await flushPromises()
  api.dispatchTabsOnUpdated(tabId, { status: 'complete' }, tab) // Chrome re-firing 'complete' for the identical load, well within the 3s debounce window
  clock.tick(900)
  await flushPromises()
  api.dispatchTabsOnUpdated(tabId, { status: 'complete' }, tab)
  clock.tick(900)
  await flushPromises()

  const fillCalls = api.executeScriptCalls.filter((c) => c.target.tabId === tabId && Array.isArray(c.files) && c.files.includes('autofill.js'))
  assert.strictEqual(fillCalls.length, 1, `expected exactly one injection despite 3 identical 'complete' events, got ${fillCalls.length}`)
})

test('onUpdated: a genuinely NEW url (real navigation) still re-injects normally, even inside the debounce window', async () => {
  const { context, api, clock } = loadBackground()
  const tabId = 78
  context.chrome.storage.local.set({
    autofillSessions: { [String(tabId)]: { hostname: 'stripe.com', startedAt: Date.now(), explicit: true, navs: 0 } },
  })

  api.dispatchTabsOnUpdated(tabId, { status: 'complete' }, { id: tabId, url: 'https://stripe.com/jobs' })
  clock.tick(900)
  await flushPromises()
  api.dispatchTabsOnUpdated(tabId, { status: 'complete' }, { id: tabId, url: 'https://stripe.com/jobs/listing/technical-program-manager-risk/7685855/apply' })
  clock.tick(900)
  await flushPromises()

  const fillCalls = api.executeScriptCalls.filter((c) => c.target.tabId === tabId && Array.isArray(c.files) && c.files.includes('autofill.js'))
  assert.strictEqual(fillCalls.length, 2, `a real subsequent navigation to a DIFFERENT url must still inject normally (debounce keys on url, not just time), got ${fillCalls.length}`)
})
