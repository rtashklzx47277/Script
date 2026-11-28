const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Execute the complete userscript. DOM mutations and time are driven explicitly
// so navigation and delayed rendering can be reproduced without a live account.
function createBrowser({ now, navigator: customNavigator, sessionStorage: customSessionStorage, location: locationOverrides } = {}) {
  const selectors = new Map()
  const selectorLists = new Map()
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
      const properties = new Map()
      this.style = {
        setProperty(name, value) { properties.set(name, value) },
        removeProperty(name) { properties.delete(name) },
        getPropertyValue(name) { return properties.get(name) || '' },
      }
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
    querySelectorAll(selector) { return selectorLists.get(selector) || [] }
    matches(selector) {
      return selector.split(',').some((part) => {
        const trimmed = part.trim()
        if (!trimmed) return false
        if (trimmed.startsWith('#')) return this.id === trimmed.slice(1)
        return this.tagName?.toLowerCase() === trimmed.toLowerCase()
      })
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parentElement?.closest(selector) || null
    }
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
  let rootClientWidth
  Object.defineProperty(document.documentElement, 'clientWidth', {
    get() { return rootClientWidth ?? window.innerWidth },
    set(value) { rootClientWidth = value },
    configurable: true,
  })
  window.scrollY = 0
  window.scrollTo = () => {}

  const location = {
    href: 'https://www.youtube.com/watch?v=example',
    origin: 'https://www.youtube.com',
    pathname: '/watch',
    search: '',
    reloadCount: 0,
    reload() { this.reloadCount++ },
    ...locationOverrides,
  }
  const context = vm.createContext({
    document, window, location, MutationObserver, HTMLElement: Element,
    Node: { ELEMENT_NODE: 1 }, AbortController, Event, URL,
    screen: { availWidth: 1920 }, console,
    ...(now ? { Date: class extends Date { static now() { return now() } } } : {}),
    ...(customNavigator ? { navigator: customNavigator } : {}),
    ...(customSessionStorage ? { sessionStorage: customSessionStorage } : {}),
    getComputedStyle: (element) => ({ display: 'block', visibility: 'visible', color: 'white', ...element.computedStyle }),
    setTimeout: (callback, delay) => { timeouts.set(++nextId, { callback, delay }); return nextId },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => { intervals.set(++nextId, { callback, delay }); return nextId },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (callback) => { frames.set(++nextId, callback); return nextId },
    cancelAnimationFrame: (id) => frames.delete(id),
  })

  return {
    selectors, selectorLists, timeouts, intervals, frames, observers, Element, document, window, location,
    run(filename) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, { filename })
    },
    runSource(source, filename = 'inline.user.js') {
      vm.runInContext(source, context, { filename })
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

test('chat: hiding flushes a queued scroll and follows new messages without animation frames', () => {
  const browser = createBrowser()
  const { scroller, items, showMore } = addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')
  assert.equal(browser.frames.size, 1)
  scroller.scrollHeight += 100
  browser.document.hidden = true
  browser.document.dispatchEvent(browser.event('visibilitychange'))
  assert.equal(browser.frames.size, 0)
  assert.equal(scroller.scrollTop, scroller.scrollHeight)

  // YouTube's resume control must still work while rAF never executes.
  showMore.attrs.delete('disabled')
  browser.mutate(showMore)
  assert.equal(showMore.clickCount, 1)
  for (let index = 0; index < 3; index++) {
    scroller.scrollHeight += 100
    browser.mutate(items)
    assert.equal(scroller.scrollTop, scroller.scrollHeight)
    assert.equal(browser.frames.size, 0)
  }

  browser.document.hidden = false
  browser.document.dispatchEvent(browser.event('visibilitychange'))
  scroller.scrollHeight += 100
  browser.mutate(items)
  browser.mutate(items)
  assert.equal(browser.frames.size, 1, 'foreground updates still coalesce')
  browser.flushFrames()
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
})

test('chat: an initially hidden tab follows immediately and recovers native pauses without new items', () => {
  const browser = createBrowser()
  const { scroller, items, showMore } = addChat(browser)
  browser.document.hidden = true
  browser.run('YouTubeLiveChatTweaks.user.js')
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
  assert.equal(browser.frames.size, 0)
  scroller.scrollHeight += 100
  browser.mutate(items)
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
  // Native layout/pause changes may not mutate either observed element.
  showMore.attrs.delete('disabled')
  scroller.scrollHeight += 100
  browser.tickIntervals()
  assert.equal(showMore.clickCount, 1)
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
  assert.equal(browser.frames.size, 0)
})

test('chat: background and visibility recovery preserve manual pause until returning to latest', () => {
  const browser = createBrowser()
  const { scroller, items, showMore } = addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')
  scroller.dispatchEvent(browser.event('wheel', { deltaY: -100 }))
  scroller.scrollTop = 600
  browser.document.hidden = true
  browser.document.dispatchEvent(browser.event('visibilitychange'))
  showMore.attrs.delete('disabled')
  scroller.scrollHeight += 100
  browser.mutate(items)
  browser.tickIntervals()
  assert.equal(scroller.scrollTop, 600)
  assert.equal(showMore.clickCount, undefined)
  assert.equal(browser.frames.size, 0)

  browser.document.hidden = false
  browser.document.dispatchEvent(browser.event('visibilitychange'))
  browser.flushFrames()
  assert.equal(scroller.scrollTop, 600)
  showMore.click()
  browser.document.hidden = true
  browser.document.dispatchEvent(browser.event('visibilitychange'))
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
})

test('chat: returning to foreground catches up without another message', () => {
  const browser = createBrowser()
  const { scroller } = addChat(browser)
  browser.document.hidden = true
  browser.run('YouTubeLiveChatTweaks.user.js')
  scroller.scrollHeight += 100
  browser.document.hidden = false
  browser.document.dispatchEvent(browser.event('visibilitychange'))
  browser.flushFrames()
  assert.equal(scroller.scrollTop, scroller.scrollHeight)
})

test('chat: replacing the scroller cancels the old pending scroll', () => {
  const browser = createBrowser()
  const old = addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')
  old.scroller.isConnected = false
  old.items.isConnected = false
  old.showMore.isConnected = false
  const replacement = addChat(browser)
  browser.tickIntervals()
  assert.equal(browser.frames.size, 1)
  browser.flushFrames()
  assert.equal(old.scroller.scrollTop, 900)
  assert.equal(replacement.scroller.scrollTop, replacement.scroller.scrollHeight)
})

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
  const keydownListeners = browser.document.activeListenerCount('keydown')
  assert.ok(keydownListeners > 0)
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
  assert.equal(browser.document.activeListenerCount('keydown'), keydownListeners)
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

test('layout: portrait trailer returns to landscape waiting slate, then restores playback ratio', async () => {
  const browser = createBrowser()
  const { flexy } = addLayoutChrome(browser, true)
  flexy.theater = true
  const player = browser.selectors.get('#movie_player')
  const video = browser.selectors.get('#movie_player video')
  Object.assign(video, { videoWidth: 360, videoHeight: 640 })
  const slate = new browser.Element()
  const background = new browser.Element()
  background.computedStyle = { display: 'none' }
  player.queries = { '.ytp-offline-slate': slate }
  slate.queries = { '.ytp-offline-slate-background': background }
  const height = () => browser.document.documentElement.style
    .getPropertyValue('--yt-live-layout-player-height')

  browser.run('YouTubeLiveLayout.user.js')
  await settle()
  assert.equal(height(), '1080px')

  // Ending does not replace metadata: the 360x640 trailer stays in the video.
  background.computedStyle.display = 'block'
  video.dispatchEvent(browser.event('ended'))
  browser.flushFrames()
  assert.equal(height(), '810px')

  // A narrow split view uses its full width for the landscape waiting image.
  browser.window.innerWidth = 1000
  browser.window.innerHeight = 900
  browser.window.dispatchEvent(browser.event('resize'))
  browser.flushFrames()
  assert.equal(height(), '562.5px')

  // The same player can start the portrait trailer again without new metadata.
  background.computedStyle.display = 'none'
  video.dispatchEvent(browser.event('play'))
  browser.flushFrames()
  assert.equal(height(), '900px')

  background.computedStyle.display = 'block'
  browser.mutate(player)
  browser.flushFrames()
  assert.equal(height(), '562.5px')

  // A background inside a hidden slate must not override a real portrait video.
  slate.computedStyle = { display: 'none' }
  browser.mutate(player)
  browser.flushFrames()
  assert.equal(height(), '900px')

  browser.navigate('/')
  await settle()
  assert.equal(height(), '')
  assert.equal(video.activeListenerCount('play'), 0)
  assert.equal(video.activeListenerCount('ended'), 0)
  assert.equal(browser.selectors.has('#yt-waiting-thumbnail'), false)
  assert.equal(browser.observers.filter(observer => observer.active).length, 0)
})

test('layout: normal landscape playback keeps its ratio when the waiting background is hidden', async () => {
  const browser = createBrowser()
  const { flexy } = addLayoutChrome(browser, true)
  flexy.theater = true
  Object.assign(browser.selectors.get('#movie_player video'), {
    videoWidth: 2560, videoHeight: 1080,
  })
  const slate = new browser.Element()
  const background = new browser.Element()
  background.computedStyle = { visibility: 'hidden' }
  browser.selectors.get('#movie_player').queries = { '.ytp-offline-slate': slate }
  slate.queries = { '.ytp-offline-slate-background': background }
  browser.run('YouTubeLiveLayout.user.js')
  await settle()
  assert.equal(browser.document.documentElement.style
    .getPropertyValue('--yt-live-layout-player-height'), '607.5px')
})

test('chat: scroll keys ignore editable targets inside Shadow DOM via composedPath', () => {
  const browser = createBrowser()
  const { scroller, items } = addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')
  browser.flushFrames()

  const host = new browser.Element('custom-input-host')
  const shadowInput = new browser.Element('input')
  shadowInput.matches = (selector) => selector.includes('input')
  const shadowKey = browser.event('keydown', { key: 'Home', composedPath: () => [shadowInput, host] })
  Object.defineProperty(shadowKey, 'target', { value: host })
  browser.document.dispatchEvent(shadowKey)
  scroller.scrollHeight += 100
  browser.mutate(items)
  browser.flushFrames()
  assert.equal(scroller.scrollTop, scroller.scrollHeight)

  scroller.scrollTop = 500
  const listKey = browser.event('keydown', { key: 'Home', composedPath: () => [scroller] })
  browser.document.dispatchEvent(listKey)
  scroller.scrollHeight += 100
  browser.mutate(items)
  browser.flushFrames()
  assert.equal(scroller.scrollTop, 500)
})

test('clock: clamps negative elapsed seconds and tolerates malformed navigation URLs', async () => {
  const browser = createBrowser()
  addClockChrome(browser, -12)
  addMicroformat(browser)
  browser.run('YouTubeLiveClock.user.js')
  await settle()
  assert.equal(browser.selectors.get('#yt-live-clock-elapsed').textContent, '0:00')
  assert.doesNotThrow(() => {
    browser.document.dispatchEvent(browser.event('yt-navigate-finish', {
      detail: { endpoint: { commandMetadata: { webCommandMetadata: { url: 'http://[' } } } },
    }))
  })
  await settle()
  assert.equal(browser.selectors.has('#yt-live-clock-elapsed'), false)
  browser.navigate('/watch?v=example')
  await settle()
  assert.equal(browser.selectors.get('#yt-live-clock-elapsed').textContent, '0:00')
})

test('clock: archived streams format absolute dates via cached Intl.DateTimeFormat presets', async () => {
  const twoDigit = (n) => String(n).padStart(2, '0')
  const expectedDate = new Date(Date.parse('2026-09-25T00:00:00Z') + 123 * 1000)
  const y = expectedDate.getFullYear()
  const m = twoDigit(expectedDate.getMonth() + 1)
  const d = twoDigit(expectedDate.getDate())
  const t = `${twoDigit(expectedDate.getHours())}:${twoDigit(expectedDate.getMinutes())}:${twoDigit(expectedDate.getSeconds())}`
  const weekdayShort = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(expectedDate)
  const weekdayLong = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(expectedDate)
  const monthLong = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(expectedDate)

  const clockSource = fs.readFileSync(path.join(__dirname, '..', 'YouTubeLiveClock.user.js'), 'utf8')
  const expectedByFormat = [
    [1, `(${y}/${m}/${d} ${t})`],
    [4, `(${weekdayShort} ${d}/${m}/${y} ${t})`],
    [6, `(${weekdayLong} ${d} ${monthLong} ${y} ${t})`],
  ]
  for (const [format, expected] of expectedByFormat) {
    const browser = createBrowser()
    addClockChrome(browser, 123)
    addMicroformat(browser, 'example', true)
    browser.runSource(clockSource.replace('const FORMAT = 1', `const FORMAT = ${format}`), `YouTubeLiveClock-format-${format}.user.js`)
    await settle()
    assert.equal(browser.selectors.get('#yt-live-clock-absolute').textContent, expected)
  }
})

test('layout: stacked mode avoids 100vw, derives viewport width from clientWidth without dummy elements, and skips auto-theater in fullscreen', async () => {
  const browser = createBrowser()
  const { flexy } = addLayoutChrome(browser, true)
  flexy.theater = true
  browser.window.innerWidth = 1000
  browser.document.documentElement.clientWidth = 985
  let resizeCount = 0
  browser.window.addEventListener('resize', () => { resizeCount++ })
  browser.run('YouTubeLiveLayout.user.js')
  await settle()
  browser.flushFrames()
  const stackedStyle = browser.selectors.get('#yt-chat-theater').textContent
  assert.equal(stackedStyle.includes('100vw'), false)
  assert.equal(browser.document.body.children.length, 0)
  assert.equal(
    browser.document.documentElement.style.getPropertyValue('--yt-live-layout-viewport-width'),
    '985px',
  )
  assert.equal(resizeCount, 1)

  browser.document.documentElement.clientWidth = 1000
  browser.window.dispatchEvent(browser.event('resize'))
  browser.flushFrames()
  assert.equal(
    browser.document.documentElement.style.getPropertyValue('--yt-live-layout-viewport-width'),
    '1000px',
  )
  assert.equal(resizeCount, 2)

  const fsBrowser = createBrowser()
  const fs = addLayoutChrome(fsBrowser, true)
  fsBrowser.selectors.get('#movie_player').classList = {
    contains: (name) => name === 'ytp-fullscreen',
  }
  fsBrowser.run('YouTubeLiveLayout.user.js')
  await settle()
  fsBrowser.flushFrames()
  assert.equal(fs.sizeButton.clickCount || 0, 0)
  assert.equal(fsBrowser.selectors.has('#yt-video-only-fullscreen'), true)
})


test('layout: hidden waiting slate skips background style lookup and setStyle skips unchanged CSS writes', async () => {
  const browser = createBrowser()
  const { flexy } = addLayoutChrome(browser, true)
  const chat = browser.selectors.get('#chat')
  chat.isLive = undefined
  flexy.attrs.set('is-two-columns_', '')
  browser.window.innerWidth = 1280
  browser.window.innerHeight = 800

  const video = browser.selectors.get('#movie_player video')
  video.videoWidth = 1280
  video.videoHeight = 720
  const slate = new browser.Element()
  const background = slate.appendChild(new browser.Element())
  slate.computedStyle = { display: 'none' }
  background.computedStyle = { backgroundImage: 'url(https://example.com/slate.jpg)' }
  browser.selectors.set('#movie_player .ytp-offline-slate', slate)
  browser.selectors.set('#movie_player .ytp-offline-slate-background', background)

  const computedCalls = []
  const origGetComputedStyle = browser.window.getComputedStyle
  browser.window.getComputedStyle = target => {
    computedCalls.push(target)
    return origGetComputedStyle(target)
  }

  let cssWrites = 0
  const origCreateElement = browser.document.createElement.bind(browser.document)
  browser.document.createElement = tag => {
    const el = origCreateElement(tag)
    if (tag === 'style') {
      let cssText = ''
      Object.defineProperty(el, 'textContent', {
        get() { return cssText },
        set(value) { cssWrites++; cssText = String(value) },
      })
    }
    return el
  }

  browser.run('YouTubeLiveLayout.user.js')
  await settle()
  assert.equal(computedCalls.includes(background), false)
  const initialWrites = cssWrites
  assert.ok(initialWrites > 0)

  computedCalls.length = 0
  browser.window.dispatchEvent(browser.event('resize'))
  await settle()
  assert.equal(computedCalls.includes(background), false)
  assert.equal(cssWrites, initialWrites, 'unchanged CSS must not reassign style textContent')
})

test('chat: foreground recovery unsticks scoped items, smoothScroll-blocked atBottom, leaked contextMenuOpen, and Alt+Tab blur while preserving manual pause', () => {
  const browser = createBrowser()
  const { scroller, items: realItems } = addChat(browser)
  const decoyItems = new browser.Element()
  browser.selectors.set('#items', decoyItems)
  scroller.queries = { '#items': realItems }

  const itemList = new browser.Element('yt-live-chat-item-list-renderer')
  let flushCount = 0
  let resetSmoothCount = 0
  const ctrl = {
    atBottom: false,
    smoothScrollRafHandle_: 42,
    contextMenuOpen: true,
    moderationModeEnabled: false,
    activeItems_: [{ id: 'm1' }],
    get allowScroll() { return !(this.contextMenuOpen || this.moderationModeEnabled) },
    resetSmoothScroll_() { resetSmoothCount++; this.smoothScrollRafHandle_ = null },
    flushActiveItems_() {
      if (this.atBottom && this.allowScroll && this.activeItems_.length) {
        flushCount++
        this.activeItems_ = []
      }
    },
  }
  itemList.polymerController = ctrl
  itemList.appendChild(scroller)

  const dropdown = new browser.Element('tp-yt-iron-dropdown')
  dropdown.getClientRects = () => (dropdown.hidden ? [] : [{}])
  browser.selectorLists.set('tp-yt-iron-dropdown', [dropdown])

  browser.run('YouTubeLiveChatTweaks.user.js')
  assert.equal(browser.observers.some(o => o.active && o.target === realItems), true)
  assert.equal(browser.observers.some(o => o.active && o.target === decoyItems), false)

  // Real open dropdown keeps contextMenuOpen intact, while atBottom/smoothScroll still unsticks.
  scroller.scrollHeight = 1200
  browser.tickIntervals()
  assert.equal(ctrl.contextMenuOpen, true)
  assert.equal(resetSmoothCount, 1)
  assert.equal(ctrl.atBottom, true)
  assert.equal(flushCount, 0)

  // Once the dropdown is hidden, the leaked flag clears and queued items flush.
  dropdown.hidden = true
  browser.tickIntervals()
  assert.equal(ctrl.contextMenuOpen, false)
  assert.equal(flushCount, 1)
  assert.equal(scroller.scrollTop, scroller.scrollHeight)

  // Alt+Tab blur clears stuck moderationModeEnabled and flushes.
  ctrl.moderationModeEnabled = true
  ctrl.activeItems_ = [{ id: 'm2' }]
  browser.window.dispatchEvent(browser.event('blur'))
  assert.equal(ctrl.moderationModeEnabled, false)
  assert.equal(flushCount, 2)

  // Queued activeItems_ lingering for two foreground ticks flushes on the second tick.
  ctrl.activeItems_ = [{ id: 'm3' }]
  browser.tickIntervals()
  assert.equal(flushCount, 2)
  browser.tickIntervals()
  assert.equal(flushCount, 3)

  // Manual upward scroll pauses auto-follow and does not force-unstick.
  scroller.dispatchEvent(browser.event('wheel', { deltaY: -100 }))
  scroller.scrollTop = 400
  ctrl.atBottom = false
  ctrl.activeItems_ = [{ id: 'm4' }]
  browser.tickIntervals()
  browser.tickIntervals()
  assert.equal(scroller.scrollTop, 400)
  assert.equal(ctrl.atBottom, false)
  assert.equal(flushCount, 3)
})

function setupWatchdogEnv({ nowStart = 1000, pathname = '/live_chat', search = '?v=live123', onLine = true, streaming = false } = {}) {
  let time = nowStart
  const store = new Map()
  const sessionStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  }
  const browser = createBrowser({
    now: () => time,
    navigator: { onLine },
    sessionStorage,
    location: {
      href: `https://www.youtube.com${pathname}${search}`,
      origin: 'https://www.youtube.com',
      pathname,
      search,
    },
  })
  addChat(browser)

  const invCont = new browser.Element('yt-invalidation-continuation')
  invCont.triggered_ = false
  invCont.timeoutAsyncHandle_ = 1
  invCont.forceTriggerCount = 0
  invCont.forceTrigger = () => { invCont.forceTriggerCount++ }

  const reloadCont = { reloadContinuationData: { continuation: 'reload-token-1' } }
  const header = new browser.Element('yt-live-chat-header-renderer')
  header.data = {
    viewSelector: {
      sortFilterSubMenuRenderer: {
        subMenuItems: [{ title: 'Live chat', selected: true, continuation: reloadCont }],
      },
    },
  }
  browser.selectors.set('yt-live-chat-header-renderer', header)

  const chatRenderer = new browser.Element('yt-live-chat-renderer')
  const ctrl = {
    data: {
      isReplay: false,
      continuations: [{ invalidationContinuationData: { timeoutMs: 10000 } }],
    },
    activeRequest: null,
    forceCalls: 0,
    reloadCalls: [],
    teardownCalls: 0,
    maybeUpdateCalls: 0,
    isStreamingActive: () => streaming,
    forceChatPoll(arg) { this.forceCalls++; if (arg?.continuation) this.reloadCalls.push(arg) },
    handleYtReloadLiveChatCommand(arg) { this.reloadCalls.push(arg) },
    teardownStreaming() { this.teardownCalls++ },
    maybeUpdateStreaming() { this.maybeUpdateCalls++ },
  }
  chatRenderer.polymerController = ctrl
  chatRenderer.queries = { 'yt-invalidation-continuation, yt-timed-continuation': invCont }
  browser.selectors.set('yt-live-chat-renderer', chatRenderer)

  return {
    browser, chatRenderer, ctrl, invCont, store, reloadCont,
    advance(ms) { time += ms },
    setTime(ms) { time = ms },
  }
}

test('chat: connection watchdog escalates through soft poll nudge, in-place reload continuation, and guarded iframe reload', () => {
  const env = setupWatchdogEnv({ nowStart: 1000 })
  env.browser.run('YouTubeLiveChatTweaks.user.js')

  // Initial healthy poll resets baseline.
  env.chatRenderer.dispatchEvent(env.browser.event('yt-live-chat-continuation-behavior-incremental-success'))
  env.invCont.triggered_ = true
  env.invCont.timeoutAsyncHandle_ = null
  env.browser.tickIntervals()
  assert.equal(env.invCont.forceTriggerCount, 0)

  // Before DEAD_CONTINUATION_MS (6000ms), no recovery runs.
  env.advance(5000)
  env.browser.tickIntervals()
  assert.equal(env.invCont.forceTriggerCount, 0)

  // Stage 1: soft re-trigger at +6000ms.
  env.advance(2000)
  env.browser.tickIntervals()
  assert.equal(env.invCont.forceTriggerCount, 1)
  assert.equal(env.invCont.triggered_, false)
  assert.equal(env.ctrl.reloadCalls.length, 0)
  assert.equal(env.browser.location.reloadCount, 0)

  // Re-break continuation; Stage 2 fires after 12s cooldown (and 6s dead check).
  env.invCont.triggered_ = true
  env.invCont.timeoutAsyncHandle_ = null
  env.browser.tickIntervals()
  env.advance(13000)
  env.browser.tickIntervals()
  assert.equal(env.ctrl.reloadCalls.length, 1)
  assert.equal(env.ctrl.reloadCalls[0]?.continuation?.reloadContinuationData?.continuation, 'reload-token-1')
  assert.equal(env.browser.location.reloadCount, 0)

  // Stage 3: iframe reload after 15s cooldown if still dead.
  env.invCont.triggered_ = true
  env.invCont.timeoutAsyncHandle_ = null
  env.browser.tickIntervals()
  env.advance(16000)
  env.browser.tickIntervals()
  assert.equal(env.browser.location.reloadCount, 1)
  const saved = JSON.parse(env.store.get('youtube-live-chat-tweaks-autoreload-v1'))
  assert.equal(saved.scope, 'v:live123')
  assert.equal(saved.count, 1)

  // A successful poll clears stall stage and auto-reload history.
  env.chatRenderer.dispatchEvent(env.browser.event('yt-live-chat-continuation-behavior-incremental-success'))
  assert.equal(env.store.has('youtube-live-chat-tweaks-autoreload-v1'), false)

  // Hung activeRequest also triggers Stage 1 and cancels the stuck promise.
  let cancelled = false
  env.ctrl.activeRequest = { promise: { cancel() { cancelled = true } } }
  env.browser.tickIntervals()
  env.advance(21000)
  env.browser.tickIntervals()
  assert.equal(cancelled, true)
  assert.equal(env.ctrl.activeRequest, null)
  assert.equal(env.invCont.forceTriggerCount, 2)
})

test('chat: connection watchdog skips replays, ended streams, offline state, hidden-paused chat, typing, and enforces reload cap', () => {
  // Replay URL skips watchdog.
  const replay = setupWatchdogEnv({ pathname: '/live_chat_replay', nowStart: 1000 })
  replay.browser.run('YouTubeLiveChatTweaks.user.js')
  replay.invCont.triggered_ = true
  replay.invCont.timeoutAsyncHandle_ = null
  replay.advance(40000)
  replay.browser.tickIntervals()
  assert.equal(replay.invCont.forceTriggerCount, 0)

  // Ended parent stream skips watchdog.
  const ended = setupWatchdogEnv({ nowStart: 1000 })
  ended.browser.window.parent = {
    document: { querySelector: () => ({ ended: true }) },
  }
  ended.browser.run('YouTubeLiveChatTweaks.user.js')
  ended.invCont.triggered_ = true
  ended.invCont.timeoutAsyncHandle_ = null
  ended.advance(40000)
  ended.browser.tickIntervals()
  assert.equal(ended.invCont.forceTriggerCount, 0)

  // Offline and pauseWhenHidden+isChatHidden skip watchdog.
  const offline = setupWatchdogEnv({ nowStart: 1000, onLine: false })
  offline.browser.run('YouTubeLiveChatTweaks.user.js')
  offline.invCont.triggered_ = true
  offline.invCont.timeoutAsyncHandle_ = null
  offline.advance(40000)
  offline.browser.tickIntervals()
  assert.equal(offline.invCont.forceTriggerCount, 0)

  const hiddenPaused = setupWatchdogEnv({ nowStart: 1000 })
  hiddenPaused.ctrl.pauseWhenHidden = true
  hiddenPaused.ctrl.isChatHidden = true
  hiddenPaused.browser.run('YouTubeLiveChatTweaks.user.js')
  hiddenPaused.invCont.triggered_ = true
  hiddenPaused.invCont.timeoutAsyncHandle_ = null
  hiddenPaused.advance(40000)
  hiddenPaused.browser.tickIntervals()
  assert.equal(hiddenPaused.invCont.forceTriggerCount, 0)

  // Active typing blocks Stage 2 & Stage 3, and reload cap stops after 3 reloads.
  const guarded = setupWatchdogEnv({ nowStart: 1000 })
  const input = new guarded.browser.Element('div')
  input.textContent = 'draft message'
  guarded.browser.selectors.set('#input[contenteditable], yt-live-chat-text-input-field-renderer #input', input)
  guarded.browser.run('YouTubeLiveChatTweaks.user.js')
  guarded.invCont.triggered_ = true
  guarded.invCont.timeoutAsyncHandle_ = null
  guarded.browser.tickIntervals()
  guarded.advance(7000)
  guarded.browser.tickIntervals()
  assert.equal(guarded.invCont.forceTriggerCount, 1)
  guarded.invCont.triggered_ = true
  guarded.invCont.timeoutAsyncHandle_ = null
  guarded.browser.tickIntervals()
  guarded.advance(15000)
  guarded.browser.tickIntervals()
  assert.equal(guarded.ctrl.reloadCalls.length, 0, 'typing defers Stage 2')
  input.textContent = ''
  guarded.browser.tickIntervals()
  assert.equal(guarded.ctrl.reloadCalls.length, 1)

  guarded.store.set('youtube-live-chat-tweaks-autoreload-v1', JSON.stringify({
    scope: 'v:live123', count: 3, lastAt: 1000,
  }))
  guarded.invCont.triggered_ = true
  guarded.invCont.timeoutAsyncHandle_ = null
  guarded.browser.tickIntervals()
  guarded.advance(80000)
  guarded.browser.tickIntervals()
  assert.equal(guarded.browser.location.reloadCount, 0, 'caps auto-reload at 3 attempts per stream')
})

test('chat: emoji picker uses responsive 8-column grid with fixed spacing and scaling stickers', () => {
  const browser = createBrowser()
  addChat(browser)
  browser.run('YouTubeLiveChatTweaks.user.js')

  const styles = browser.document.head.children
    .filter((child) => child.tagName === 'style')
    .map((child) => child.textContent)
  const layoutCss = styles[0] || ''

  assert.match(layoutCss, /--chat-emoji-picker-columns:\s*8;/)
  assert.match(layoutCss, /--chat-emoji-picker-gap:\s*8px;/)
  assert.match(layoutCss, /--chat-emoji-picker-edge-margin:\s*12px;/)
  assert.match(layoutCss, /--chat-emoji-picker-grid-inline-padding:\s*4px;/)

  assert.match(
    layoutCss,
    /#pickers\s*>\s*#emoji\s*\{[^}]*container-type:\s*inline-size;[^}]*height:\s*auto\s*!important;/
  )
  assert.doesNotMatch(layoutCss, /#pickers\s*>\s*#emoji\s*\{[^}]*\bdisplay\s*:/)
  assert.match(
    layoutCss,
    /#pickers\s*>\s*#emoji\s*>\s*#categories-wrapper\s*\{[^}]*flex:\s*0\s+1\s+auto\s*!important;/
  )
  assert.match(
    layoutCss,
    /yt-emoji-picker-renderer\s+#categories\s*\{[^}]*scrollbar-gutter:\s*stable\s+both-edges;[^}]*overscroll-behavior:\s*contain;/
  )
  assert.match(
    layoutCss,
    /#pickers\s*>\s*#emoji\s+#categories\s*\{[^}]*max-height:\s*var\(--chat-emoji-picker-height\)\s*!important;[^}]*max-height:\s*clamp\(var\(--chat-emoji-picker-height\),\s*calc\(32px \+ 26cqi\),\s*min\(280px,\s*40dvh\)\)\s*!important;/
  )
  assert.match(
    layoutCss,
    /#categories\s*>\s*yt-emoji-picker-category-renderer\s*\{[^}]*margin-inline:\s*var\(--chat-emoji-picker-edge-margin\)\s*!important;/
  )
  assert.doesNotMatch(
    layoutCss,
    /#categories\s*>\s*yt-emoji-picker-category-renderer\s*\{[^}]*\bdisplay\s*:/
  )
  assert.match(
    layoutCss,
    /#categories\s*>\s*yt-emoji-picker-category-renderer\s*>\s*#emoji\s*\{[^}]*display:\s*grid\s*!important;[^}]*grid-template-columns:\s*repeat\(var\(--chat-emoji-picker-columns\),\s*minmax\(0,\s*1fr\)\)\s*!important;[^}]*gap:\s*var\(--chat-emoji-picker-gap\)\s*!important;[^}]*padding:\s*var\(--chat-emoji-picker-gap\)\s+var\(--chat-emoji-picker-grid-inline-padding\)\s*!important;/
  )
  assert.match(
    layoutCss,
    /#categories\s*>\s*yt-emoji-picker-category-renderer\s*>\s*#emoji\s*>\s*:not\(img\)\s*\{\s*display:\s*none\s*!important;/
  )
  assert.match(
    layoutCss,
    /#categories\s*>\s*yt-emoji-picker-category-renderer\s*>\s*#emoji\s*>\s*img:not\(\[is-active-emoji-with-variants\]\)\s*\{[^}]*width:\s*100%\s*!important;[^}]*min-width:\s*0\s*!important;[^}]*height:\s*auto\s*!important;[^}]*aspect-ratio:\s*1\s*\/\s*1\s*!important;[^}]*object-fit:\s*contain\s*!important;[^}]*padding:\s*0\s*!important;/
  )
})
