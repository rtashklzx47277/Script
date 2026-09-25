const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Execute the complete userscript. DOM mutations and time are driven explicitly
// so navigation and delayed rendering can be reproduced without a live account.
function createBrowser() {
  const selectors = new Map()
  const timeouts = new Map()
  const intervals = new Map()
  const frames = new Map()
  const observers = []
  let nextId = 0

  class Element extends EventTarget {
    constructor(tag = 'div') {
      super()
      this.tagName = tag
      this.children = []
      this.attrs = new Map()
      this.listeners = []
      this.style = { setProperty() {}, removeProperty() {} }
      this.isConnected = true
      this.scrollHeight = 1000
      this.scrollTop = 900
      this.clientHeight = 100
      this.offsetWidth = 100
      this.clientWidth = 85
      this.classList = { contains: () => false }
    }

    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options)
      this.listeners.push({ type, listener, options })
    }

    removeEventListener(type, listener, options) {
      super.removeEventListener(type, listener, options)
      this.listeners = this.listeners.filter((entry) =>
        entry.type !== type || entry.listener !== listener)
    }

    activeListenerCount(type) {
      return this.listeners.filter((entry) =>
        entry.type === type && !entry.options?.signal?.aborted).length
    }

    appendChild(element) {
      this.children.push(element)
      element.parentElement = this
      if (element.id) selectors.set(`#${element.id}`, element)
      return element
    }

    remove() {
      this.isConnected = false
      if (this.id && selectors.get(`#${this.id}`) === this) {
        selectors.delete(`#${this.id}`)
      }
    }

    setAttribute(name, value) { this.attrs.set(name, String(value)) }
    getAttribute(name) { return this.attrs.get(name) ?? null }
    hasAttribute(name) { return this.attrs.has(name) }
    querySelector(selector) { return this.queries?.[selector] || null }
    querySelectorAll() { return [] }
    matches() { return false }
    insertAdjacentElement(_, element) { this.parentElement.appendChild(element) }
    click() {
      this.clickCount = (this.clickCount || 0) + 1
      this.dispatchEvent(new Event('click'))
    }
  }

  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target, options) { this.target = target; this.options = options; this.active = true }
    disconnect() { this.active = false }
    fire() { if (this.active) this.callback([]) }
  }

  const document = new Element('document')
  document.querySelector = (selector) => selectors.get(selector) || null
  document.createElement = (tag) => new Element(tag)
  document.createElementNS = (_, tag) => new Element(tag)
  document.head = new Element('head')
  document.body = new Element('body')
  document.documentElement = new Element('html')

  const window = new Element('window')
  window.getSelection = () => null
  window.innerWidth = 1920
  window.innerHeight = 1080
  window.scrollY = 0
  window.scrollTo = () => {}

  const location = {
    href: 'https://www.youtube.com/watch?v=example',
    origin: 'https://www.youtube.com',
    pathname: '/watch',
  }
  const context = vm.createContext({
    document, window, location, MutationObserver, HTMLElement: Element,
    Node: { ELEMENT_NODE: 1 }, AbortController, Event, URL,
    screen: { availWidth: 1920 }, console,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', color: 'white' }),
    setTimeout: (callback, delay) => { timeouts.set(++nextId, { callback, delay }); return nextId },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => { intervals.set(++nextId, { callback, delay }); return nextId },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (callback) => { frames.set(++nextId, callback); return nextId },
    cancelAnimationFrame: (id) => frames.delete(id),
  })

  return {
    selectors, timeouts, intervals, frames, observers, Element, document, window,
    run(filename) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, { filename })
    },
    event(type, properties = {}) { return Object.assign(new Event(type), properties) },
    navigate(url) {
      const target = new URL(url, location.origin)
      location.href = target.href
      location.pathname = target.pathname
      document.dispatchEvent(this.event('yt-navigate-finish', {
        detail: { endpoint: { commandMetadata: { webCommandMetadata: { url } } } },
      }))
    },
    flushFrames() {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback())
    },
    tickIntervals() { [...intervals.values()].forEach((timer) => timer.callback()) },
    fireTimeouts(delay) {
      for (const [id, timer] of [...timeouts]) {
        if (timer.delay === delay) { timeouts.delete(id); timer.callback() }
      }
    },
    mutate(target) { observers.filter((observer) => observer.target === target).forEach((observer) => observer.fire()) },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function addChat(browser) {
  const scroller = new browser.Element()
  const items = new browser.Element()
  const showMore = new browser.Element()
  showMore.setAttribute('disabled', '')
  browser.selectors.set('#item-scroller', scroller)
  browser.selectors.set('#items', items)
  browser.selectors.set('#show-more', showMore)
  return { scroller, items, showMore }
}

test('chat: native touch cancellation followed by upward scroll suspends following', () => {
  const browser = createBrowser()
  const { scroller, items } = addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')
  browser.flushFrames()
  scroller.scrollTop = 900
  scroller.dispatchEvent(browser.event('pointerdown', { pointerType: 'touch' }))
  browser.window.dispatchEvent(browser.event('pointercancel', { pointerType: 'touch' }))
  scroller.scrollTop = 600
  scroller.dispatchEvent(browser.event('scroll'))
  scroller.scrollHeight += 100
  browser.mutate(items)
  browser.flushFrames()
  assert.equal(scroller.scrollTop, 600)
  assert.equal(browser.timeouts.size, 0)

  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
  scroller.dispatchEvent(browser.event('scroll'))
  scroller.scrollHeight += 100
  browser.mutate(items)
  browser.flushFrames()
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
})

test('chat: repeated list replacements and temporarily missing controls do not stack listeners', () => {
  const browser = createBrowser()
  const { scroller, showMore } = addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')
  for (let index = 0; index < 3; index++) {
    const oldItems = browser.selectors.get('#items')
    oldItems.isConnected = false
    browser.selectors.set('#items', new browser.Element())
    browser.tickIntervals()
    assert.equal(browser.observers.filter((observer) => observer.active && observer.target === oldItems).length, 0)
    assert.equal(scroller.activeListenerCount('scroll'), 1)
    assert.equal(scroller.activeListenerCount('wheel'), 1)
    assert.equal(scroller.activeListenerCount('pointerdown'), 1)
  }

  showMore.isConnected = false
  browser.selectors.delete('#show-more')
  browser.tickIntervals()
  const replacement = new browser.Element()
  replacement.setAttribute('disabled', '')
  browser.selectors.set('#show-more', replacement)
  browser.tickIntervals()
  assert.equal(showMore.activeListenerCount('click'), 0)
  assert.equal(replacement.activeListenerCount('click'), 1)
  assert.equal(scroller.activeListenerCount('scroll'), 1)
  assert.equal(browser.window.activeListenerCount('pointercancel'), 1)
  assert.equal(browser.document.activeListenerCount('keydown'), 1)
})

test('chat: a late header receives exactly one reload button', () => {
  const browser = createBrowser()
  browser.run('YouTubeLiveChatTweaks.user.js')
  const menu = new browser.Element()
  const close = new browser.Element()
  const parent = new browser.Element()
  parent.appendChild(menu)
  close.queries = { button: new browser.Element() }
  browser.selectors.set('#live-chat-header-context-menu', menu)
  browser.selectors.set('#close-button', close)
  browser.tickIntervals()
  browser.tickIntervals()
  assert.equal(parent.children.filter((element) => element.id === 'yt-chat-tweaks-reload-button').length, 1)
})

function addClockChrome(browser, time = 123) {
  for (const name of ['contents', 'wrapper']) {
    browser.selectors.set(`.ytp-chrome-bottom .ytp-time-${name}`, new browser.Element())
  }
  const progress = new browser.Element()
  progress.setAttribute('aria-valuenow', time)
  browser.selectors.set('.ytp-chrome-bottom .ytp-progress-bar', progress)
  return progress
}

function addMicroformat(browser, id = 'example', archived = false) {
  const metadata = new browser.Element('script')
  metadata.textContent = JSON.stringify({
    embedUrl: `https://www.youtube.com/embed/${id}`,
    publication: {
      startDate: '2026-09-25T00:00:00Z',
      ...(archived ? { endDate: '2026-09-25T02:00:00Z' } : {}),
    },
  })
  browser.selectors.set('#microformat', new browser.Element())
  browser.selectors.set('#microformat script', metadata)
  return metadata
}

test('clock: rebuilding player chrome reconnects the clock and progress observer', async () => {
  const browser = createBrowser()
  const originalProgress = addClockChrome(browser)
  addMicroformat(browser)
  browser.run('YouTubeLiveClock.user.js')
  await settle()
  const originalClock = browser.selectors.get('#yt-live-clock-elapsed')
  assert.equal(originalClock.textContent, '2:03')
  originalProgress.isConnected = false
  originalClock.isConnected = false
  const replacementProgress = addClockChrome(browser, 456)
  browser.tickIntervals()
  await settle()
  assert.equal(browser.selectors.get('#yt-live-clock-elapsed').textContent, '7:36')
  assert.equal(browser.observers.filter((observer) => observer.active && observer.target === originalProgress).length, 0)
  assert.equal(browser.observers.filter((observer) => observer.active && observer.target === replacementProgress).length, 1)
})

test('clock: metadata appearing after the initial observation window still initializes', async () => {
  const browser = createBrowser()
  addClockChrome(browser)
  browser.run('YouTubeLiveClock.user.js')
  await settle()
  browser.fireTimeouts(10000)
  addMicroformat(browser)
  browser.tickIntervals()
  await settle()
  assert.equal(browser.selectors.get('#yt-live-clock-elapsed').textContent, '2:03')
  assert.equal(browser.timeouts.size, 0)
  browser.navigate('/watch?v=next')
  browser.navigate('/')
  await settle()
  assert.equal(browser.timeouts.size, 0)
  assert.equal(browser.intervals.size, 0)
  assert.equal(browser.observers.filter((observer) => observer.active).length, 0)
  assert.equal(browser.selectors.has('#yt-live-clock-elapsed'), false)
})

function addLayoutChrome(browser, withChat = false) {
  const flexy = new browser.Element()
  flexy.theater = false
  const sizeButton = new browser.Element('button')
  browser.selectors.set('ytd-watch-flexy', flexy)
  browser.selectors.set('#movie_player', new browser.Element())
  browser.selectors.set('#movie_player video', new browser.Element())
  browser.selectors.set('.ytp-size-button', sizeButton)
  if (withChat) browser.selectors.set('#chat', new browser.Element())
  return { flexy, sizeButton }
}

test('layout: delayed player initialization recovers, and navigation cancels waiting and monitoring', async () => {
  const browser = createBrowser()
  browser.run('YouTubeLiveLayout.user.js')
  await settle()
  browser.fireTimeouts(10000)
  assert.equal(browser.intervals.size, 1)
  addLayoutChrome(browser)
  browser.tickIntervals()
  await settle()
  assert.equal(browser.selectors.has('#yt-theater-fill'), false)
  assert.equal(browser.selectors.has('#yt-chat-theater'), false)
  assert.equal(browser.document.activeListenerCount('fullscreenchange'), 1)
  browser.navigate('/')
  await settle()
  browser.flushFrames()
  assert.equal(browser.intervals.size, 0)
  assert.equal(browser.timeouts.size, 0)
  assert.equal(browser.document.activeListenerCount('fullscreenchange'), 0)
  browser.selectors.clear()
  browser.navigate('/watch?v=missing')
  await settle()
  assert.equal(browser.timeouts.size, 1)
  browser.navigate('/')
  await settle()
  assert.equal(browser.timeouts.size, 0)
  assert.equal(browser.observers.filter((observer) => observer.active).length, 0)
})

test('layout: navigation invalidates an already queued automatic theater click', async () => {
  const browser = createBrowser()
  const { sizeButton } = addLayoutChrome(browser, true)
  browser.run('YouTubeLiveLayout.user.js')
  await settle()
  assert(browser.frames.size > 0)
  browser.navigate('/')
  await settle()
  browser.flushFrames()
  assert.equal(sizeButton.clickCount || 0, 0)
  assert.equal(browser.selectors.has('#yt-chat-theater'), false)
  assert.equal(browser.intervals.size, 0)
  assert.equal(browser.timeouts.size, 0)
})
