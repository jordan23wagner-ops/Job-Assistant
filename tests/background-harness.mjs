// Test harness for background.js: loads the REAL, unmodified service-worker source into a Node
// `vm` context (not a reimplementation of its routing logic) with a minimal mock of the chrome.*
// extension APIs it depends on, then lets tests dispatch simulated chrome events straight into
// the REAL listener functions background.js registered on that mock -- the same "load the actual
// production file" philosophy as tests/harness.mjs uses for autofill.js.
//
// Why `vm` instead of jsdom (unlike tests/harness.mjs): background.js is a plain MV3
// service-worker script -- no build step, no exports, `var`/`function` declarations at the top
// level only (confirmed: no `let`/`const` anywhere in the file) -- that references `chrome`,
// `console`, `self`, `fetch`, `URL`, `Date`, `setTimeout` as bare globals and never touches
// `window`/`document`. A `vm.createContext` sandbox with top-level `var`/`function` declarations
// attaching directly to its global object gives tests direct access to background.js's own
// top-level functions (routeAggregatorOrInject, skipAggregatorInterstitial,
// injectAutofillWithTailoredResume, ...) -- both for calling them directly and for identity
// checks (`executeScriptCalls[i].func === context.skipAggregatorInterstitial`) -- with none of
// jsdom's DOM machinery that this file never needs. No new dependency: only `node:vm` and other
// node: builtins are used here, same zero-extra-dependency bar tests/harness.mjs set with jsdom
// (which background.js doesn't need at all).
//
// Fake clock instead of real timers: several listeners deliberately wrap their routing decision
// in a real `setTimeout` (800ms in chrome.tabs.onUpdated, 500ms in onHistoryStateUpdated) to leave
// room for the async storage write that races them -- see the "race-recovery" comment in
// background.js's WEBAPP_APPLY handler. Reproducing that race deterministically means controlling
// exactly when those timers fire relative to the mocked storage writes; real wall-clock sleeps
// can't guarantee that ordering and would make the one test that most needs to be reliable
// (the race-condition regression test) flaky by construction. `setTimeout`/`clearTimeout` are
// therefore replaced with a small synchronous fake clock (see makeFakeClock below) rather than
// pulling in a fake-timers package -- this is the standard technique for testing timer-dependent
// race conditions deterministically.
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKGROUND_SRC = readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')

// A synchronous fake clock for setTimeout/clearTimeout. `tick(ms)` advances the clock and runs
// every timer that becomes due, in scheduled order, including any newly scheduled while running
// due ones (a callback that itself calls setTimeout) -- exactly what background.js's chained
// delays need. Everything here runs synchronously (no real event-loop turn), which is fine
// because every mocked chrome.* callback in this file also fires synchronously.
function makeFakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map() // id -> { at, fn, args }
  return {
    setTimeout(fn, delay, ...args) {
      const id = nextId++
      timers.set(id, { at: now + Math.max(0, delay || 0), fn, args })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    tick(ms) {
      now += ms
      // Cap passes rather than looping forever -- none of the paths under test schedule a
      // runaway setTimeout(fn, 0) chain, but fail loudly rather than hang if one ever did.
      for (let pass = 0; pass < 1000; pass++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)
        if (!due.length) return
        const [id, t] = due[0]
        timers.delete(id)
        t.fn(...t.args)
      }
      throw new Error('fake clock: too many timer passes in one tick() -- possible infinite setTimeout loop')
    },
  }
}

// Minimal chrome.* mock covering exactly what background.js references (chrome.tabs.*,
// chrome.webNavigation.*, chrome.storage.local, chrome.scripting.executeScript,
// chrome.runtime.onMessage/onInstalled/sendMessage, chrome.sidePanel). Every addListener call
// just records the listener (plus an optional `filter` in the `{url:[{hostSuffix}]}` shape
// background.js actually passes for onCompleted/onHistoryStateUpdated) so tests can dispatch
// simulated events straight into the real registered functions.
function makeChromeMock() {
  const storage = {} // in-memory backing store for chrome.storage.local
  const tabs = new Map() // tabId -> tab record
  let nextTabId = 1
  const executeScriptCalls = []
  const tabsCreateCalls = []
  const listeners = {
    tabsOnUpdated: [], tabsOnCreated: [], tabsOnRemoved: [],
    webNavOnBeforeNavigate: [], webNavOnHistoryStateUpdated: [], webNavOnCommitted: [], webNavOnCompleted: [],
    runtimeOnMessage: [], runtimeOnInstalled: [],
  }
  // One-shot hook fired from inside storage.local.set, right after a write lands and right
  // before that set() call's own callback runs -- lets a test simulate "some other listener
  // reacted to this exact storage write before the code that triggered it got to continue",
  // which is the only way to reproduce the WEBAPP_APPLY race deterministically without real
  // concurrency. See tests for the "won race" case.
  let pendingSetHook = null

  // JSON round-trip on both read and write, matching real chrome.storage.local's structured-clone
  // semantics -- callers must not be able to mutate the backing store via a live reference to
  // whatever they got back from get(), and a set() must not leave the caller holding a live
  // reference into the store either.
  const cloneVal = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

  function hostOf(url) { try { return new URL(url).hostname } catch (e) { return '' } }
  function matchesFilter(filter, url) {
    if (!filter || !Array.isArray(filter.url) || !filter.url.length) return true
    const host = hostOf(url)
    return filter.url.some((cond) => {
      if (cond.hostSuffix) return host === cond.hostSuffix || host.endsWith('.' + cond.hostSuffix)
      if (cond.hostEquals) return host === cond.hostEquals
      if (cond.hostContains) return host.includes(cond.hostContains)
      return true
    })
  }
  const addPlain = (list) => ({ addListener(fn) { list.push(fn) } })
  const addFilterable = (list) => ({ addListener(fn, filter) { list.push({ fn, filter }) } })

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage: addPlain(listeners.runtimeOnMessage),
      onInstalled: addPlain(listeners.runtimeOnInstalled),
      sendMessage() { return Promise.resolve() },
    },
    storage: {
      local: {
        get(keys, cb) {
          const result = {}
          if (keys == null || typeof keys === 'object' && !Array.isArray(keys)) Object.assign(result, storage)
          else if (typeof keys === 'string') result[keys] = storage[keys]
          else if (Array.isArray(keys)) keys.forEach((k) => { result[k] = storage[k] })
          cb(cloneVal(result) || {})
        },
        set(obj, cb) {
          Object.assign(storage, cloneVal(obj))
          const hook = pendingSetHook
          pendingSetHook = null // consume before invoking -- a nested set() triggered by the hook must not re-fire it
          if (hook) hook(obj)
          if (cb) cb()
        },
      },
    },
    tabs: {
      onUpdated: addPlain(listeners.tabsOnUpdated),
      onCreated: addPlain(listeners.tabsOnCreated),
      onRemoved: addPlain(listeners.tabsOnRemoved),
      create(props, cb) {
        const id = nextTabId++
        // Default status 'complete' -- these tests are specifically about tabs that finish
        // loading fast enough to race the session write; a test that needs a still-loading tab
        // can override via api.setTab(id, { status: 'loading' }) after creation.
        const tab = { id, url: props.url, status: 'complete', openerTabId: props.openerTabId }
        tabs.set(id, tab)
        tabsCreateCalls.push({ props, tab })
        if (cb) cb(tab)
        return Promise.resolve(tab)
      },
      get(tabId, cb) {
        const tab = tabs.get(tabId)
        chrome.runtime.lastError = tab ? undefined : { message: 'No tab with id: ' + tabId }
        cb(tab)
        chrome.runtime.lastError = undefined
      },
      update(tabId, props) {
        const tab = tabs.get(tabId)
        if (tab) Object.assign(tab, props)
        return Promise.resolve(tab)
      },
      query(queryInfo, cb) { cb([]) },
      sendMessage(tabId, msg, cb) { if (cb) cb() },
    },
    webNavigation: {
      onBeforeNavigate: addPlain(listeners.webNavOnBeforeNavigate),
      onHistoryStateUpdated: addFilterable(listeners.webNavOnHistoryStateUpdated),
      onCommitted: addPlain(listeners.webNavOnCommitted),
      onCompleted: addFilterable(listeners.webNavOnCompleted),
      getAllFrames(details, cb) { cb([]) },
    },
    scripting: {
      executeScript(opts) {
        executeScriptCalls.push(opts)
        return Promise.resolve([{ result: undefined }])
      },
    },
    sidePanel: {
      setPanelBehavior() { return Promise.resolve() },
      open() { return Promise.resolve() },
    },
  }

  return {
    chrome, storage, executeScriptCalls, tabsCreateCalls,
    setTab(id, tab) { tabs.set(id, { id, ...tab }) },
    getTab(id) { return tabs.get(id) },
    setOnceAfterNextSet(fn) { pendingSetHook = fn },
    dispatchTabsOnUpdated(tabId, info, tab) { listeners.tabsOnUpdated.forEach((fn) => fn(tabId, info, tab)) },
    dispatchTabsOnCreated(tab) { listeners.tabsOnCreated.forEach((fn) => fn(tab)) },
    dispatchTabsOnRemoved(tabId) { listeners.tabsOnRemoved.forEach((fn) => fn(tabId)) },
    dispatchOnBeforeNavigate(details) { listeners.webNavOnBeforeNavigate.forEach((fn) => fn(details)) },
    dispatchOnHistoryStateUpdated(details) {
      listeners.webNavOnHistoryStateUpdated.forEach(({ fn, filter }) => { if (matchesFilter(filter, details.url)) fn(details) })
    },
    dispatchOnCommitted(details) { listeners.webNavOnCommitted.forEach((fn) => fn(details)) },
    dispatchOnCompleted(details) {
      listeners.webNavOnCompleted.forEach(({ fn, filter }) => { if (matchesFilter(filter, details.url)) fn(details) })
    },
    // Dispatches to every registered listener (matching real chrome.runtime.onMessage, which
    // fans a message out to all listeners -- each one here already guards on message.type, same
    // as production). Returns whatever each listener passed to sendResponse, in registration
    // order, for tests that care; most of these tests only need the side effects.
    dispatchRuntimeMessage(message, sender = {}) {
      const responses = []
      listeners.runtimeOnMessage.forEach((fn) => { fn(message, sender, (v) => responses.push(v)) })
      return responses
    },
  }
}

// Loads the REAL background.js into a fresh vm context + fresh chrome mock (never shared across
// tests, same isolation guarantee runAutofill gives each call). Returns `context` (the vm
// sandbox/global -- background.js's own top-level vars/functions live directly on it, e.g.
// `context.routeAggregatorOrInject`, `context.skipAggregatorInterstitial`,
// `context.AGGREGATOR_HOST_RE`), `api` (the mock's dispatch/inspection surface), and `clock`.
export function loadBackground() {
  const clock = makeFakeClock()
  const api = makeChromeMock()
  const sandbox = {
    chrome: api.chrome,
    console,
    self: { addEventListener() {} }, // service-worker global self.addEventListener('unhandledrejection', ...)
    fetch: () => Promise.reject(new Error('unexpected network call from a background.js test')),
    URL, Date, Promise, JSON,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(BACKGROUND_SRC, sandbox, { filename: 'background.js' })
  return { context: sandbox, api, clock }
}

// Drains the native microtask queue a few times over. Needed wherever background.js's own code
// goes through a real Promise .then()/.catch() chain (e.g. injectAutofillWithTailoredResume's
// clearStopFlag(tabId).then(afterClear, afterClear)) before doing the thing under test -- the
// fake clock above only replaces setTimeout, not native Promise scheduling. Cheap and safe to
// call even when nothing is pending.
export function flushPromises(times = 8) {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => {})
  return p
}
