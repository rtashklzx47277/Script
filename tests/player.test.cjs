const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const scripts = ['YouTubePlayerTweaks.user.js', 'TwitchPlayerTweaks.user.js']
const assertClose = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} ≈ ${expected}`)

// Run the real userscript and expose its closed-over functions at the end of
// its IIFE. Only browser primitives are mocked; production functions are intact.
function boot(file, mode = 'worker', pathname = '/', { trustedTypes = false, setupWindow } = {}) {
  const isYouTube = file === scripts[0]
  let nextId = 0
  let activeWorker
  const timers = new Map()
  const workerSources = new Map()
  const selectors = new Map()
  const observers = []
  const resizeObservers = []
  const animationFrames = new Map()
  const listeners = new Map()
  const styles = []
  const draws = []
  const frames = []
  const eventListeners = []

  class NodeMock {}
  class ElementMock extends NodeMock {
    constructor(tagName = 'div') {
      super()
      this.tagName = tagName
      this.nodeType = 1
      this.style = {
        setProperty(name, value) { this[name] = value },
        removeProperty(name) { delete this[name] },
      }
      this.attributes = new Map()
      this.dataset = {}
      this.children = []
      this.queries = new Map()
      this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
    get firstChild() {
      return this.children[0] || null
    }
    get isConnected() {
      if ('_connected' in this) return this._connected
      return Boolean(this.parentElement)
    }
    set isConnected(value) {
      this._connected = Boolean(value)
    }
    remove() {
      if (!this.parentElement) return
      const index = this.parentElement.children.indexOf(this)
      if (index !== -1) this.parentElement.children.splice(index, 1)
      this.parentElement = null
    }
    appendChild(element) {
      element.remove?.()
      element.parentElement = this
      this.children.push(element)
      return element
    }
    insertBefore(element, ref) {
      if (element === ref) return element
      element.remove?.()
      element.parentElement = this
      const index = ref ? this.children.indexOf(ref) : -1
      if (index === -1) this.children.push(element)
      else this.children.splice(index, 0, element)
      return element
    }
    append(...nodes) {
      for (const node of nodes) this.appendChild(node)
    }
    cloneNode() {
      const copy = new ElementMock(this.tagName)
      copy.className = this.className
      copy.attributes = new Map(this.attributes)
      return copy
    }
    set innerHTML(value) {
      if (trustedTypes) throw new TypeError('This document requires TrustedHTML assignment')
      this._innerHTML = value
    }
    matchesSimple(part) {
      part = part.trim()
      if (!part || part === '*') return true
      let rest = part
      const tagMatch = rest.match(/^([a-z0-9_-]+)/i)
      if (tagMatch) {
        if (tagMatch[1].toLowerCase() !== (this.tagName || '').toLowerCase()) return false
        rest = rest.slice(tagMatch[0].length)
      }
      while (rest) {
        if (rest.startsWith('#')) {
          const m = rest.match(/^#([a-z0-9_-]+)/i)
          if (!m || this.id !== m[1]) return false
          rest = rest.slice(m[0].length)
        } else if (rest.startsWith('.')) {
          const m = rest.match(/^\.([a-z0-9_-]+)/i)
          if (!m || !(this.className || '').split(/\s+/).includes(m[1])) return false
          rest = rest.slice(m[0].length)
        } else if (rest.startsWith('[')) {
          const m = rest.match(/^\[([a-z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/i)
          if (!m) return false
          const attrName = m[1]
          const expected = m[2] ?? m[3] ?? m[4]
          if (!this.hasAttribute(attrName)) return false
          if (expected !== undefined && this.getAttribute(attrName) !== expected) return false
          rest = rest.slice(m[0].length)
        } else {
          return false
        }
      }
      return true
    }
    matches(selector) {
      return selector.split(',').some(chain => {
        const tokens = chain.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean)
        if (!tokens.length) return false
        const matchAt = (node, idx) => {
          const token = tokens[idx]
          if (token === '>') return false
          if (!node?.matchesSimple?.(token)) return false
          if (idx === 0) return true
          if (tokens[idx - 1] === '>') return matchAt(node.parentElement, idx - 2)
          for (let anc = node.parentElement; anc; anc = anc.parentElement) {
            if (matchAt(anc, idx - 1)) return true
          }
          return false
        }
        return matchAt(this, tokens.length - 1)
      })
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (node.matches(selector)) return node
      }
      return null
    }
    contains(target) {
      for (let node = target; node; node = node.parentElement) {
        if (node === this) return true
      }
      return false
    }
    querySelector(selector) {
      if (this.queries.has(selector)) return this.queries.get(selector)
      if (selector.includes(' > ') && !selector.includes(',')) {
        const [parentSel, childSel] = selector.split(' > ').map(s => s.trim())
        const parent = this.querySelector(parentSel)
        return parent ? parent.children.find(child => child.matches(childSel)) || null : null
      }
      for (const child of this.children) {
        if (child.matches(selector)) return child
        const deep = child.querySelector(selector)
        if (deep) return deep
      }
      return null
    }
    querySelectorAll(selector) {
      if (this.queries.has(selector)) return this.queries.get(selector)
      const results = []
      const collect = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) results.push(child)
          collect(child)
        }
      }
      collect(this)
      return results
    }
    getBoundingClientRect() { return this.rect }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    removeAttribute(name) { this.attributes.delete(name) }
    hasAttribute(name) { return this.attributes.has(name) }
    focus() {
      this.focused = true
      document.activeElement = this
    }
    click() {
      if (this.disabled || this.hasAttribute('disabled')) return
      const target = this
      const event = {
        type: 'click',
        target,
        currentTarget: target,
        defaultPrevented: false,
        propagationStopped: false,
        stopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
        stopImmediatePropagation() { this.propagationStopped = true; this.stopped = true },
        composedPath() {
          const path = []
          for (let node = target; node; node = node.parentElement) path.push(node)
          path.push(document, context.window)
          return path
        },
      }
      for (const entry of [...eventListeners]) {
        if (entry.name === 'click' && entry.options?.capture && !entry.options?.signal?.aborted) {
          entry.callback(event)
          if (event.stopped) return
        }
      }
      for (let node = target; node && !event.propagationStopped; node = node.parentElement) {
        event.currentTarget = node
        node.dispatchEvent(event)
      }
      if (!event.propagationStopped) {
        for (const entry of [...eventListeners]) {
          if (entry.name === 'click' && !entry.options?.capture && !entry.options?.signal?.aborted) {
            event.currentTarget = document
            entry.callback(event)
            if (event.stopped) return
          }
        }
      }
    }
    addEventListener(name, callback, options) {
      if (options?.signal?.aborted) return
      this.events ||= new Map()
      const callbacks = this.events.get(name) || []
      callbacks.push(callback)
      this.events.set(name, callbacks)
      options?.signal?.addEventListener?.('abort', () => {
        const list = this.events?.get(name)
        if (!list) return
        const index = list.indexOf(callback)
        if (index !== -1) list.splice(index, 1)
      }, { once: true })
    }
    dispatchEvent(event) {
      for (const callback of [...(this.events?.get(event.type) || [])]) {
        callback(event)
        if (event.stopped) break
      }
      return !event.defaultPrevented
    }
  }

  class Frame {
    constructor(source) {
      this.source = source
      this.closed = 0
      frames.push(this)
    }
    close() { this.closed++ }
  }

  class BlobMock {
    constructor(parts) { this.parts = parts }
  }

  const document = {
    head: { appendChild: (element) => styles.push(element) },
    documentElement: {},
    body: {},
    addEventListener(name, callback, options) {
      listeners.set(name, callback)
      eventListeners.push({ name, callback, options })
    },
    removeEventListener(name, callback) {
      for (let i = eventListeners.length - 1; i >= 0; i--) {
        if (eventListeners[i].name === name && eventListeners[i].callback === callback) {
          eventListeners.splice(i, 1)
        }
      }
      if (listeners.get(name) === callback) listeners.delete(name)
    },
    querySelector(selector) { return selectors.get(selector) || null },
    querySelectorAll(selector) { return selectors.get(selector) || [] },
    createElementNS(_, tag) { return new ElementMock(tag) },
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          getContext() {
            return {
              drawImage(source) {
                assert.equal(source.closed || 0, 0, 'fallback must draw before closing the captured frame')
                draws.push(source)
              },
            }
          },
          toBlob(callback) { callback({ mainThreadPng: true }) },
        }
      }
      return new ElementMock(tag)
    },
  }

  const context = {
    console,
    document,
    window: { JSON: { parse: JSON.parse }, addEventListener: document.addEventListener },
    location: { pathname, href: `https://${isYouTube ? 'www.youtube.com' : 'www.twitch.tv'}${pathname}`,
      origin: `https://${isYouTube ? 'www.youtube.com' : 'www.twitch.tv'}` },
    HTMLElement: ElementMock,
    Node: NodeMock,
    HTMLInputElement: class {},
    Blob: BlobMock,
    URL: class extends URL {
      static createObjectURL(blob) {
        const url = `blob:${++nextId}`
        workerSources.set(url, blob.parts.join(''))
        return url
      }
      static revokeObjectURL(url) { workerSources.delete(url) }
    },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    VideoFrame: Frame,
    OffscreenCanvas: class {},
    setTimeout(fn, delay) {
      timers.set(++nextId, { fn, delay, type: 'timeout' })
      return nextId
    },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, delay) {
      timers.set(++nextId, { fn, delay, type: 'interval' })
      return nextId
    },
    clearInterval(id) { timers.delete(id) },
    requestAnimationFrame(fn) { animationFrames.set(++nextId, fn); return nextId },
    cancelAnimationFrame(id) { animationFrames.delete(id) },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; resizeObservers.push(this) }
      observe(target) { this.target = target }
      disconnect() { this.target = null }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        this.connected = false
        observers.push(this)
      }
      observe() { this.connected = true }
      disconnect() { this.connected = false }
    },
    AbortController,
  }

  if (mode !== 'unsupported') {
    context.Worker = class {
      constructor(url) {
        if (mode === 'constructor-error') throw new Error('Worker blocked')
        activeWorker = this
        this.handlers = {}
        const workerSelf = {
          postMessage: (data) => queueMicrotask(() => this.handlers.message({ data })),
        }
        class Canvas {
          constructor(width, height) {
            this.width = width
            this.height = height
          }
          getContext() {
            return {
              drawImage(frame) {
                if (mode === 'encode-error') throw new Error('Encode failed')
                assert.equal(frame.closed, 0)
              },
            }
          }
          convertToBlob() { return Promise.resolve({ workerPng: true }) }
        }
        this.context = { self: workerSelf, OffscreenCanvas: Canvas }
        vm.createContext(this.context)
        vm.runInContext(workerSources.get(url), this.context)
      }
      addEventListener(name, callback) { this.handlers[name] = callback }
      terminate() { this.terminated = true }
      postMessage(data) {
        if (mode === 'post-error') throw new Error('Serialization failed')
        if (mode === 'timeout') return
        // postMessage clones the frame, leaving the original available for
        // the main-thread fallback. Execute the actual worker source as well.
        const frame = { ...data.frame, closed: 0, close() { this.closed++ } }
        this.context.self.onmessage({ data: { ...data, frame } })
      }
    }
  }

  const exposure = isYouTube
    ? `globalThis.__test = {
        restorePlaybackRate, getLiveBufferHealth,
        runLiveCatchupStep, toggleLiveCatchup, stopLiveCatchup, waitElements,
        changeVolume, syncVolumeGain, handleWheelCapture,
        setPlayers: (video, player) => {
          videoPlayer = video; moviePlayer = player; floatingBar = { style: {} };
        },
        setButton: (button) => { liveBtn = button; },
        setContainer: (element) => { container = element; },
        cancelWait: () => pendingWaitCancel?.(),
        catching: () => Boolean(liveCatchupTimer),
        collectPlayerElements, ensureVolumeGain, showTooltip, hideTooltip,
        setTooltip: (node) => { tooltip = node; tooltipText = node; tooltipKey = node },
        handleKeydown,
        encode: (video) => { videoPlayer = video; return encodeScreenshot(); },
        jobs: () => screenshotWorkerJobs.size,
      };`
    : `globalThis.__test = {
        encode: encodeScreenshot, jobs: () => screenshotWorkerJobs.size,
        changeVolume, ensurePlayerState, ensureVolumeGain, refresh,
        showTooltip, hideTooltip, ensureScreenshotButtons,
      };`
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  assert.match(source, /\}\)\(\)\s*$/)
  vm.createContext(context)
  setupWindow?.(context.window, context.document)
  vm.runInContext(source.replace(/\}\)\(\)\s*$/, exposure + '})()'), context, { filename: file })

  return {
    api: context.__test, window: context.window, document,
    Element: ElementMock, location: context.location,
    frames, draws, timers, selectors, observers, resizeObservers, animationFrames, listeners, styles,
    render() {
      for (const [id, callback] of [...animationFrames]) {
        animationFrames.delete(id)
        callback()
      }
    },
    emit(name, event) {
      for (const entry of eventListeners) {
        if (entry.name === name && !entry.options?.signal?.aborted) entry.callback(event)
        if (event.stopped) break
      }
    },
    listenerCount(name) {
      return eventListeners.filter(entry => entry.name === name && !entry.options?.signal?.aborted).length
    },
    worker: () => activeWorker,
    flush(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        if (timer.type === 'timeout') timers.delete(id)
        timer.fn()
      }
    },
  }
}

test('YouTube: volume wheel quiets low settings and boosts full volume', () => {
  const env = boot(scripts[0])
  let gain
  let sourceCount = 0
  env.window.AudioContext = class {
    constructor() { this.destination = {}; this.state = 'running' }
    createGain() {
      gain = { gain: { value: 1 }, connect() {} }
      return gain
    }
    createMediaElementSource() {
      sourceCount++
      return { connect() {}, disconnect() {} }
    }
  }

  let volume = 20
  const player = {
    getVolume: () => volume,
    setVolume(value) { volume = value },
    unMute() {},
  }
  env.api.setPlayers({}, player)
  env.api.changeVolume({ deltaY: 1, preventDefault() {} })
  assert.equal(volume, 15)
  assertClose(gain.gain.value, 0.45)
  assertClose(volume / 100 * gain.gain.value, 0.0675)

  volume = 75
  env.api.syncVolumeGain() // YouTube's native volume slider changed.
  assertClose(gain.gain.value, 2.25)
  assertClose(volume / 100 * gain.gain.value, 1.6875)

  volume = 95
  env.api.changeVolume({ deltaY: -1, preventDefault() {} })
  assert.equal(volume, 100)
  assert.equal(gain.gain.value, 3)
  assert.equal(sourceCount, 1)
})

function addShortsPlayer(env, shorts, top = 20) {
  const reel = new env.Element('ytd-reel-video-renderer')
  const area = new env.Element()
  area.rect = { left: 100, top, right: 400, bottom: top + 500, width: 300, height: 500 }
  const player = new env.Element()
  const video = new env.Element('video')
  player.volume = 50
  player.muted = true
  player.getVolume = () => player.volume
  player.setVolume = value => { player.volume = value }
  player.unMute = () => { player.muted = false }
  player.queries.set('video', video)
  reel.queries.set('#short-video-container', area)
  shorts.appendChild(reel)
  reel.appendChild(area)
  area.appendChild(player)
  player.appendChild(video)
  const players = shorts.queries.get('.html5-video-player') || []
  shorts.queries.set('.html5-video-player', [...players, player])
  return { player, video, area }
}

function addShortsPanelFixture(env, options = {}) {
  const {
    innerWidth = 1440,
    smallScreen = false,
    fullscreen = false,
    visibleScrim = false,
    deferActionBar = false,
    commentsLabel = '3,414 件のコメントを表示',
    commentsPath = 'M1 6a4 4 0 014-4h14a4 4 0 014 4v10a4 4 0',
    commentsDisabled = false,
    omitTitle = false,
    brokenTitle = false,
  } = options

  env.window.innerWidth = innerWidth

  const shorts = new env.Element('ytd-shorts')
  if (smallScreen) shorts.setAttribute('small-screen-persistent-panel', '')
  if (fullscreen) shorts.setAttribute('is-fullscreen', '')

  const shortsContainer = shorts.appendChild(new env.Element())
  shortsContainer.id = 'shorts-container'
  shortsContainer.rect = { left: 0, top: 64, right: innerWidth, bottom: 900, width: innerWidth, height: 836 }
  const innerContainer = shortsContainer.appendChild(new env.Element())
  innerContainer.id = 'shorts-inner-container'

  const panelContainer = shorts.appendChild(new env.Element())
  panelContainer.id = 'shorts-panel-container'
  // Real YouTube Shorts DOM keeps #anchored-panel-scrim mounted even on wide
  // desktop viewports (hidden with a 0x0 bounding rect unless modal mode is active).
  const scrim = panelContainer.appendChild(new env.Element())
  scrim.id = 'anchored-panel-scrim'
  scrim.rect = visibleScrim
    ? { left: 0, top: 0, right: innerWidth, bottom: 900, width: innerWidth, height: 900 }
    : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  const anchoredPanel = panelContainer.appendChild(new env.Element())
  anchoredPanel.id = 'anchored-panel'

  const slot0 = anchoredPanel.appendChild(new env.Element('ytd-engagement-panel-section-list-renderer'))
  slot0.setAttribute('target-id', '')
  slot0.setAttribute('visibility', '')
  const slot0Header = slot0.appendChild(new env.Element())
  slot0Header.id = 'header'
  const titleHeader = slot0Header.appendChild(new env.Element('ytd-engagement-panel-title-header-renderer'))
  const visBtnWrap = titleHeader.appendChild(new env.Element())
  visBtnWrap.id = 'visibility-button'
  const commentsCloseBtn = visBtnWrap.appendChild(new env.Element('button'))
  commentsCloseBtn.setAttribute('aria-label', '關閉')

  const slot1 = anchoredPanel.appendChild(new env.Element('ytd-engagement-panel-section-list-renderer'))
  slot1.setAttribute('target-id', '')
  slot1.setAttribute('visibility', '')
  const slot1Header = slot1.appendChild(new env.Element())
  slot1Header.id = 'header'
  const slot1Content = slot1.appendChild(new env.Element())
  slot1Content.id = 'content'
  const sdp = slot1Content.appendChild(new env.Element('ytd-structured-description-content-renderer'))
  const titleHeaderVm = sdp.appendChild(new env.Element('yt-video-title-header-view-model'))
  const titleBtnWrap = titleHeaderVm.appendChild(new env.Element())
  titleBtnWrap.className = 'ytVideoTitleHeaderViewModelHeaderButton'
  const descCloseBtn = titleBtnWrap.appendChild(new env.Element('button'))
  descCloseBtn.setAttribute('aria-label', '關閉')
  const floatingWrap = sdp.appendChild(new env.Element('yt-floating-button-view-model'))
  const floatingCloseBtn = floatingWrap.appendChild(new env.Element('button'))
  floatingCloseBtn.setAttribute('aria-label', '關閉')

  const slot2 = anchoredPanel.appendChild(new env.Element('ytd-engagement-panel-section-list-renderer'))
  slot2.setAttribute('target-id', '')
  slot2.setAttribute('visibility', '')

  const openCommentsPanel = () => {
    shorts.setAttribute('is-watch-while-mode', '')
    slot1.setAttribute('target-id', '')
    slot1.setAttribute('visibility', '')
    slot0.setAttribute('target-id', 'engagement-panel-comments-section')
    slot0.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')
  }
  const openDescriptionPanel = () => {
    shorts.setAttribute('is-watch-while-mode', '')
    slot0.setAttribute('target-id', '')
    slot0.setAttribute('visibility', '')
    slot1.setAttribute('target-id', 'engagement-panel-structured-description')
    slot1.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')
  }
  const closeAnyPanel = () => {
    shorts.removeAttribute('is-watch-while-mode')
    slot0.setAttribute('target-id', '')
    slot0.setAttribute('visibility', '')
    slot1.setAttribute('target-id', '')
    slot1.setAttribute('visibility', '')
  }

  commentsCloseBtn.addEventListener('click', closeAnyPanel)
  descCloseBtn.addEventListener('click', closeAnyPanel)
  floatingCloseBtn.addEventListener('click', closeAnyPanel)

  const reel = innerContainer.appendChild(new env.Element('ytd-reel-video-renderer'))
  const video = reel.appendChild(new env.Element())
  video.id = 'short-video-container'
  video.rect = { left: 480, top: 64, right: 795, bottom: 640, width: 315, height: 576 }

  const overlay = reel.appendChild(new env.Element())
  overlay.className = 'overlay'
  const metaContainer = overlay.appendChild(new env.Element())
  metaContainer.className = 'ytReelPlayerOverlayViewModelMetadataContainer'
  let titleLink = null
  if (!omitTitle) {
    const titleVm = metaContainer.appendChild(new env.Element('yt-shorts-video-title-view-model'))
    titleLink = titleVm.appendChild(new env.Element('h1'))
    titleLink.className = 'ytShortsVideoTitleViewModelShortsVideoTitle'
    titleLink.setAttribute('role', 'link')
    if (!brokenTitle) titleLink.addEventListener('click', openDescriptionPanel)
  }

  const actionsContainer = overlay.appendChild(new env.Element())
  actionsContainer.className = 'ytReelPlayerOverlayViewModelActionsContainer'

  let commentsBtn = null
  let commentClicks = 0
  const mountActionBar = () => {
    if (commentsBtn) return commentsBtn
    const actionBar = actionsContainer.appendChild(new env.Element('reel-action-bar-view-model'))

    const addAction = (wrapperTag, label, pathD) => {
      const host = actionBar.appendChild(new env.Element(wrapperTag))
      const bvm = wrapperTag === 'button-view-model' ? host : host.appendChild(new env.Element('button-view-model'))
      const btn = bvm.appendChild(new env.Element('button'))
      btn.setAttribute('aria-label', label)
      const svg = btn.appendChild(new env.Element('svg'))
      const p = svg.appendChild(new env.Element('path'))
      p.setAttribute('d', pathD)
      return btn
    }

    addAction('like-button-view-model', '和另外 61萬 人都喜歡這部影片', 'M16.25 2.5A6.56 6.56 0 0012 4.062')
    commentsBtn = addAction('button-view-model', commentsLabel, commentsPath)
    if (commentsDisabled) {
      commentsBtn.disabled = true
      commentsBtn.setAttribute('disabled', 'true')
      commentsBtn.setAttribute('aria-disabled', 'true')
    }
    commentsBtn.addEventListener('click', () => {
      commentClicks++
      openCommentsPanel()
    })
    addAction('button-view-model', '分享', 'M10 3.158V7.51c-5.428.223')
    return commentsBtn
  }

  if (!deferActionBar) mountActionBar()

  const moreBtn = reel.appendChild(new env.Element('button'))
  moreBtn.setAttribute('aria-label', 'その他の操作')
  const dropdown = new env.Element('tp-yt-iron-dropdown')
  dropdown.style.display = 'none'
  const menu = dropdown.appendChild(new env.Element('yt-list-view-model'))
  menu.setAttribute('role', 'menu')
  const descMenuItem = menu.appendChild(new env.Element('yt-list-item-view-model'))
  const descMenuBtn = descMenuItem.appendChild(new env.Element('button'))
  descMenuBtn.setAttribute('role', 'menuitem')
  descMenuBtn.textContent = '說明'
  const descMenuPath = descMenuBtn.appendChild(new env.Element('svg')).appendChild(new env.Element('path'))
  descMenuPath.setAttribute('d', 'M4 5a1 1 0 000 2h16a1 1 0 100-')
  let menuDescClicks = 0
  descMenuBtn.addEventListener('click', () => {
    menuDescClicks++
    dropdown.style.display = 'none'
    openDescriptionPanel()
  })
  moreBtn.addEventListener('click', () => {
    dropdown.style.display = 'block'
  })
  env.selectors.set('tp-yt-iron-dropdown', [dropdown])
  env.selectors.set('ytd-shorts', shorts)

  return {
    shorts, scrim, anchoredPanel, slot0, slot1, reel, metaContainer, titleLink,
    get commentsBtn() { return commentsBtn },
    mountActionBar, moreBtn, dropdown, descMenuBtn, commentsCloseBtn, descCloseBtn,
    openCommentsPanel, openDescriptionPanel, closeAnyPanel,
    getCommentClicks: () => commentClicks,
    getMenuDescClicks: () => menuDescClicks,
    expandedTargetId: () => {
      if (slot0.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') return slot0.getAttribute('target-id')
      if (slot1.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') return slot1.getAttribute('target-id')
      return ''
    },
  }
}

test('YouTube Shorts: hides in-video metadata unconditionally, auto-opens Comments on desktop, and builds accessible Trusted Types tabs', () => {
  const env = boot(scripts[0], 'worker', '/shorts/example', { trustedTypes: true })
  const css = env.styles[0].textContent
  assert.match(css, /html body ytd-shorts #shorts-container #experiment-overlay \.ytReelPlayerOverlayViewModelMetadataContainer,[\s\S]*?html body ytd-shorts #metapanel\s*\{\s*display:\s*none !important;/)
  assert.doesNotMatch(css, /#anchored-panel\[data-yt-shorts-tabs\][^}]*overflow:\s*hidden/)

  const fx = addShortsPanelFixture(env, { commentsLabel: '' })
  env.render()

  assert.equal(fx.getCommentClicks(), 1, 'matches Comments button by SVG path even when aria-label is blank')
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
  assert.equal(fx.shorts.hasAttribute('data-yt-shorts-tabs'), true)
  assert.equal(fx.anchoredPanel.hasAttribute('data-yt-shorts-tabs'), true)

  const tabBar = fx.anchoredPanel.querySelector('#yt-shorts-panel-tabs')
  assert.ok(tabBar)
  assert.equal(tabBar.hidden, false)
  assert.equal(fx.anchoredPanel.firstChild, tabBar)

  const tablist = tabBar.querySelector('[role="tablist"]')
  assert.ok(tablist)
  assert.equal(tablist.getAttribute('focusgroup'), 'tablist nomemory')
  const tabs = tablist.querySelectorAll('[role="tab"]')
  assert.equal(tabs.length, 2)
  assert.deepEqual(tabs.map(t => t.textContent), ['留言', '影片資訊'])
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
  assert.equal(tabs[0].getAttribute('tabindex'), '0')
  assert.equal(tabs[0].hasAttribute('focusgroupstart'), true)
  assert.equal(tabs[0].hasAttribute('aria-controls'), false)
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false')
  assert.equal(tabs[1].getAttribute('tabindex'), '-1')
  assert.equal(tabs[1].hasAttribute('focusgroupstart'), false)
  assert.equal(tabs[1].hasAttribute('aria-controls'), false)

  const closeBtn = tabBar.querySelector('.yt-shorts-panel-close')
  assert.ok(closeBtn)
  assert.equal(tablist.contains(closeBtn), false, 'close button must sit outside tablist')
  assert.equal(env.timers.size, 0)
})

test('YouTube Shorts: switches between Comments and Description tabs with keyboard navigation and More Actions menu fallback', () => {
  const env = boot(scripts[0], 'worker', '/shorts/example')
  const fx = addShortsPanelFixture(env)
  env.render()

  const tabBar = fx.anchoredPanel.querySelector('#yt-shorts-panel-tabs')
  const tablist = tabBar.querySelector('[role="tablist"]')
  const [commentsTab, descTab] = tablist.querySelectorAll('[role="tab"]')

  descTab.click()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-structured-description')
  assert.equal(descTab.getAttribute('aria-selected'), 'true')
  assert.equal(descTab.getAttribute('tabindex'), '0')
  assert.equal(descTab.hasAttribute('focusgroupstart'), true)
  assert.equal(commentsTab.getAttribute('aria-selected'), 'false')
  assert.equal(commentsTab.getAttribute('tabindex'), '-1')

  // Keyboard navigation moves focus & roving tabindex without page/player interference.
  const keyRight = {
    type: 'keydown', key: 'ArrowRight', target: descTab,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
  }
  tablist.dispatchEvent(keyRight)
  assert.equal(keyRight.prevented, true)
  assert.equal(keyRight.stopped, true)
  assert.equal(env.document.activeElement, commentsTab)
  assert.equal(commentsTab.getAttribute('tabindex'), '0')
  assert.equal(descTab.getAttribute('tabindex'), '-1')

  const keyEnd = { key: 'End', target: commentsTab, preventDefault() {}, stopPropagation() {} }
  tablist.dispatchEvent({ type: 'keydown', ...keyEnd })
  assert.equal(env.document.activeElement, descTab)
  const keyHome = { key: 'Home', target: descTab, preventDefault() {}, stopPropagation() {} }
  tablist.dispatchEvent({ type: 'keydown', ...keyHome })
  assert.equal(env.document.activeElement, commentsTab)
  const keyLeft = { key: 'ArrowLeft', target: commentsTab, preventDefault() {}, stopPropagation() {} }
  tablist.dispatchEvent({ type: 'keydown', ...keyLeft })
  assert.equal(env.document.activeElement, descTab)

  commentsTab.click()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
  assert.equal(commentsTab.getAttribute('aria-selected'), 'true')

  // Broken title triggers 180ms fallback to More Actions -> Description menu item.
  const envBroken = boot(scripts[0], 'worker', '/shorts/broken')
  const fxBroken = addShortsPanelFixture(envBroken, { brokenTitle: true })
  envBroken.render()
  const [, descTabBroken] = fxBroken.anchoredPanel.querySelectorAll('[role="tab"]')
  descTabBroken.click()
  assert.equal(fxBroken.getMenuDescClicks(), 0)
  envBroken.flush(180)
  assert.equal(fxBroken.getMenuDescClicks(), 1)
  assert.equal(fxBroken.expandedTargetId(), 'engagement-panel-structured-description')

  // Missing title immediately opens More Actions -> Description menu item.
  const envNoTitle = boot(scripts[0], 'worker', '/shorts/notitle')
  const fxNoTitle = addShortsPanelFixture(envNoTitle, { omitTitle: true })
  envNoTitle.render()
  const [, descTabNoTitle] = fxNoTitle.anchoredPanel.querySelectorAll('[role="tab"]')
  descTabNoTitle.click()
  assert.equal(fxNoTitle.getMenuDescClicks(), 1)
  assert.equal(fxNoTitle.expandedTargetId(), 'engagement-panel-structured-description')
})

test('YouTube Shorts: switching Shorts resets back to Comments via navigation or scroll without stacking listeners', async () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  const fx = addShortsPanelFixture(env)
  env.render()

  const [, descTab] = fx.anchoredPanel.querySelectorAll('[role="tab"]')
  descTab.click()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-structured-description')

  env.location.pathname = '/shorts/second'
  await env.listeners.get('yt-navigate-finish')()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
  assert.equal(env.observers.length, 1)
  assert.equal(env.listenerCount('wheel'), 1)
  assert.equal(env.listenerCount('click'), 1)

  descTab.click()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-structured-description')
  env.location.pathname = '/shorts/third'
  env.emit('scroll', {})
  env.render()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
})

test('YouTube Shorts: narrow viewports and fullscreen never auto-open modal panels, while manual open keeps tabs and widening auto-opens', () => {
  const env = boot(scripts[0], 'worker', '/shorts/narrow')
  const fx = addShortsPanelFixture(env, { innerWidth: 820, smallScreen: true })
  env.render()
  assert.equal(fx.getCommentClicks(), 0)
  assert.equal(fx.expandedTargetId(), '')

  // Manual open in narrow mode still shows tabs.
  fx.commentsBtn.click()
  env.render()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
  assert.equal(fx.anchoredPanel.querySelector('#yt-shorts-panel-tabs').hidden, false)

  // Resizing from narrow (not dismissed) to wide desktop auto-opens Comments.
  const envResize = boot(scripts[0], 'worker', '/shorts/resize')
  const fxResize = addShortsPanelFixture(envResize, { innerWidth: 820, smallScreen: true })
  envResize.render()
  assert.equal(fxResize.getCommentClicks(), 0)
  fxResize.shorts.removeAttribute('small-screen-persistent-panel')
  envResize.window.innerWidth = 1440
  envResize.emit('resize', {})
  envResize.render()
  assert.equal(fxResize.getCommentClicks(), 1)
  assert.equal(fxResize.expandedTargetId(), 'engagement-panel-comments-section')

  // Fullscreen blocks auto-open as well.
  const envFs = boot(scripts[0], 'worker', '/shorts/fs')
  const fxFs = addShortsPanelFixture(envFs, { fullscreen: true })
  envFs.render()
  assert.equal(fxFs.getCommentClicks(), 0)
  assert.equal(fxFs.expandedTargetId(), '')
})

function wheel(target, overrides = {}) {
  return {
    target, deltaY: 1, clientX: 200, clientY: 100,
    preventDefault() { this.prevented = true },
    stopImmediatePropagation() { this.stopped = true },
    stopPropagation() { this.stopped = true },
    ...overrides,
  }
}

test('YouTube Shorts: late player and extracted overlay adjust volume without switching reels', () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  assert.equal(env.listenerCount('wheel'), 1)
  assert.equal(env.observers.length, 1, 'Shorts observes layout without waiting for regular player controls')
  const shorts = new env.Element('ytd-shorts')
  const overlay = new env.Element()
  shorts.appendChild(overlay) // This is outside both the player and the reel.
  const missingPlayerEvent = wheel(overlay)
  env.emit('wheel', missingPlayerEvent)
  assert.equal(missingPlayerEvent.prevented, undefined)

  const { player } = addShortsPlayer(env, shorts)
  const down = wheel(overlay)
  env.emit('wheel', down)
  assert.equal(player.volume, 45)
  assert.equal(player.muted, false)
  assert.equal(down.prevented, true)
  assert.equal(down.stopped, true)
  assert.equal(player.querySelector('#yt-player-tweaks-float-bar').textContent, '45')
  env.emit('wheel', wheel(overlay, { deltaY: -1 }))
  assert.equal(player.volume, 50)
})

test('YouTube Shorts: outside video, zoom, horizontal wheel and editable fields retain native behavior', () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  const shorts = new env.Element('ytd-shorts')
  const overlay = new env.Element()
  const input = new env.Element('input')
  shorts.appendChild(overlay)
  shorts.appendChild(input)
  const { player } = addShortsPlayer(env, shorts)
  for (const event of [
    wheel(overlay, { clientX: 80 }),
    wheel(overlay, { clientX: 400 }),
    wheel(overlay, { clientY: 520 }),
    wheel(overlay, { ctrlKey: true }),
    wheel(overlay, { deltaY: 0 }),
    wheel(input),
    wheel(new env.Element()),
  ]) {
    env.emit('wheel', event)
    assert.equal(event.prevented, undefined)
    assert.equal(event.stopped, undefined)
  }
  assert.equal(player.volume, 50)
  delete player.setVolume
  const unready = wheel(overlay)
  env.emit('wheel', unready)
  assert.equal(unready.prevented, undefined, 'Do not swallow scrolling before the API is ready')
})

test('YouTube Shorts: switching reels without navigation targets the new player and clears old feedback', () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  const shorts = new env.Element('ytd-shorts')
  const overlay = new env.Element()
  shorts.appendChild(overlay)
  const first = addShortsPlayer(env, shorts)
  env.emit('wheel', wheel(overlay))
  const oldFeedback = first.player.querySelector('#yt-player-tweaks-float-bar')
  first.area.rect.top = -600
  first.area.rect.bottom = -100
  const next = addShortsPlayer(env, shorts)
  env.emit('wheel', wheel(overlay, { deltaY: -1 }))
  assert.equal(first.player.volume, 45)
  assert.equal(next.player.volume, 55)
  assert.equal(oldFeedback.style.display, 'none')
  assert.equal(next.player.querySelector('#yt-player-tweaks-float-bar').textContent, '55')
  assert.equal(env.timers.size, 1, 'Only the current feedback timer should remain')
})

test('YouTube Shorts: volume clamps at bounds and SPA navigation releases listeners and feedback', () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  const shorts = new env.Element('ytd-shorts')
  const overlay = new env.Element()
  shorts.appendChild(overlay)
  const { player } = addShortsPlayer(env, shorts)
  player.volume = 2
  env.emit('wheel', wheel(overlay))
  assert.equal(player.volume, 0)
  player.volume = 98
  env.emit('wheel', wheel(overlay, { deltaY: -1 }))
  assert.equal(player.volume, 100)

  env.location.pathname = '/shorts/next'
  env.emit('yt-navigate-finish', {})
  assert.equal(env.listenerCount('wheel'), 1)
  assert.equal(env.listenerCount('volumechange'), 1)
  env.emit('wheel', wheel(overlay))
  assert.equal(player.volume, 95, 'Navigation must not stack wheel handlers')

  env.location.pathname = '/'
  env.emit('yt-navigate-finish', {})
  assert.equal(env.listenerCount('wheel'), 0)
  assert.equal(env.listenerCount('volumechange'), 0)
  assert.equal(env.timers.size, 0)
  assert.equal(player.querySelector('#yt-player-tweaks-float-bar').style.display, 'none')
  env.emit('wheel', wheel(overlay))
  assert.equal(player.volume, 95)
})

test('YouTube Shorts: gain follows the current video and reuses audio sources when reels change', () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  const sources = []
  const gain = { gain: { value: 1 }, connect() {} }
  env.window.AudioContext = class {
    constructor() { this.destination = {}; this.state = 'running' }
    createGain() { return gain }
    createMediaElementSource(video) {
      const source = { video, disconnected: 0, connect() {}, disconnect() { this.disconnected++ } }
      sources.push(source)
      return source
    }
  }
  const shorts = new env.Element('ytd-shorts')
  const overlay = new env.Element()
  shorts.appendChild(overlay)
  const first = addShortsPlayer(env, shorts)
  env.emit('wheel', wheel(overlay))
  assertClose(gain.gain.value, 1.35)
  first.player.volume = 75
  env.emit('volumechange', { target: first.video })
  assertClose(gain.gain.value, 2.25)

  first.area.rect.top = -600
  first.area.rect.bottom = -100
  const next = addShortsPlayer(env, shorts)
  env.emit('wheel', wheel(overlay))
  assertClose(gain.gain.value, 1.35)
  assert.equal(sources.length, 2)
  assert.ok(sources[0].disconnected > 0)
  env.emit('volumechange', { target: first.video })
  assertClose(gain.gain.value, 1.35)

  next.area.rect.top = 600
  next.area.rect.bottom = 1100
  first.area.rect.top = 20
  first.area.rect.bottom = 520
  env.emit('wheel', wheel(overlay))
  assert.equal(first.player.volume, 70)
  assert.equal(sources.length, 2, 'Revisiting a video must reuse its MediaElementSource')
  assertClose(gain.gain.value, 2.1)
})

test('YouTube: regular video wheel still changes volume only inside its video container', () => {
  const env = boot(scripts[0])
  const container = new env.Element()
  const video = new env.Element('video')
  container.appendChild(video)
  let volume = 50
  env.api.setPlayers(video, { getVolume: () => volume, setVolume: value => { volume = value }, unMute() {} })
  env.api.setContainer(container)
  const inside = wheel(video)
  env.api.handleWheelCapture(inside)
  assert.equal(volume, 45)
  assert.equal(inside.prevented, true)
  const outside = wheel(new env.Element())
  env.api.handleWheelCapture(outside)
  assert.equal(volume, 45)
  assert.equal(outside.prevented, undefined)
})

function range(start, end) {
  return { length: 1, start: () => start, end: () => end }
}

function setLivePlayer(env) {
  const video = {
    currentTime: 10,
    playbackRate: 1,
    seekable: range(0, 100),
    buffered: range(0, 40),
    paused: false,
    ended: false,
  }
  const player = {
    getVideoData: () => ({ isLive: true }),
    getPlaybackRate: () => video.playbackRate,
    setPlaybackRate(rate) { video.playbackRate = rate },
  }
  env.api.setPlayers(video, player)
  return video
}

for (const file of scripts) {
  test(`${file}: initializes browser hooks without a player`, () => {
    const env = boot(file)
    assert.equal(env.styles.length, 1)
    if (file === scripts[0]) assert.equal(typeof env.listeners.get('yt-navigate-finish'), 'function')
    else assert.equal(env.observers[0].connected, true)
  })

  for (const mode of ['worker', 'unsupported', 'constructor-error', 'post-error', 'encode-error', 'timeout']) {
    test(`${file}: screenshot ${mode} releases jobs and captured frames`, async () => {
      const env = boot(file, mode)
      const result = env.api.encode({ videoWidth: 1920, videoHeight: 1080 })
      if (mode === 'timeout') env.flush(15000)
      const blob = await result
      assert.ok(mode === 'worker' ? blob.workerPng : blob.mainThreadPng)
      assert.equal(env.api.jobs(), 0)
      assert.equal(env.timers.size, 0)
      for (const frame of env.frames) assert.equal(frame.closed, 1)
      if (['post-error', 'encode-error', 'timeout'].includes(mode)) {
        assert.equal(env.draws[0], env.frames[0], 'fallback must preserve the clicked frame')
      }
      if (mode === 'timeout') assert.equal(env.worker().terminated, true)
    })
  }
}

for (const selectedRate of [1.5, 2]) {
  test(`YouTube: native ${selectedRate}x selection after stopping catchup wins over retries`, () => {
    const env = boot(scripts[0])
    const video = setLivePlayer(env)
    env.api.toggleLiveCatchup()
    assert.equal(video.playbackRate, 1.5)
    env.api.toggleLiveCatchup()
    assert.equal(video.playbackRate, 1)
    video.playbackRate = selectedRate
    for (const delay of [100, 500, 1000]) env.flush(delay)
    assert.equal(video.playbackRate, selectedRate)
  })
}

test('YouTube: 0.2.4 buffer threshold stops catch-up and clears its button', () => {
  const env = boot(scripts[0])
  const video = setLivePlayer(env)
  const attributes = {}
  env.api.setButton({ setAttribute(name, value) { attributes[name] = value } })
  env.api.toggleLiveCatchup()
  assert.equal(env.api.catching(), true)
  assert.equal(video.playbackRate, 1.5)
  assert.equal(attributes['aria-pressed'], 'true')
  video.currentTime = 30
  video.seekable = range(0, 35.93)
  video.buffered = range(0, 32)
  env.api.runLiveCatchupStep()
  assert.equal(env.api.catching(), true)
  assert.equal(video.playbackRate, 1.5)
  video.currentTime = 30.2
  video.seekable = range(0, 36.13)
  video.buffered = range(0, 30.86)
  env.api.runLiveCatchupStep()
  assert.equal(env.api.catching(), true)
  assert.equal(video.playbackRate, 1.5)
  video.currentTime = 30.4
  video.seekable = range(0, 36.33)
  video.buffered = range(0, 30.8)
  env.api.runLiveCatchupStep()
  assert.equal(env.api.catching(), false)
  assert.equal(video.playbackRate, 1)
  assert.equal(attributes['aria-pressed'], 'false')
})

test('YouTube: seekable edge does not stop catch-up while buffer is healthy', () => {
  const env = boot(scripts[0])
  const video = setLivePlayer(env)
  env.api.toggleLiveCatchup()
  video.currentTime = 99.6
  video.buffered = range(0, 102)
  env.api.runLiveCatchupStep()
  assert.equal(env.api.catching(), true)
  assert.equal(video.playbackRate, 1.5)
})

test('YouTube: low buffer at activation does not start catch-up', () => {
  const env = boot(scripts[0])
  const video = setLivePlayer(env)
  video.buffered = range(0, 10.4)
  env.api.toggleLiveCatchup()
  assert.equal(env.api.catching(), false)
  assert.equal(video.playbackRate, 1)
})

test('YouTube: no seekable edge can still catch up using the playable buffer', () => {
  const env = boot(scripts[0])
  const video = setLivePlayer(env)
  video.seekable = { length: 0 }
  env.api.toggleLiveCatchup()
  assert.equal(env.api.catching(), true)
  assert.equal(video.playbackRate, 1.5)
  video.currentTime = 39.7
  env.api.runLiveCatchupStep()
  assert.equal(env.api.catching(), false)
  assert.equal(video.playbackRate, 1)
})

test('YouTube: successful element wait removes its timer and observer', async () => {
  const env = boot(scripts[0])
  const ready = env.api.waitElements()
  for (const selector of ['.html5-video-container', 'button.ytp-size-button', '#movie_player', '.ytp-progress-bar', '#movie_player video']) {
    env.selectors.set(selector, {})
  }
  env.observers[0].callback()
  assert.equal(await ready, true)
  assert.equal(env.timers.size, 0)
  assert.equal(env.observers[0].connected, false)
})

test('YouTube: navigation cancels the late element poll', async () => {
  const env = boot(scripts[0])
  const ready = env.api.waitElements()
  env.flush(10000)
  assert.equal(env.observers[0].connected, false)
  assert.equal([...env.timers.values()][0].type, 'interval')
  env.api.cancelWait()
  assert.equal(await ready, false)
  assert.equal(env.timers.size, 0)
})


function addTwitchPlayer(env, volume = 0.5, currentSrc = 'blob:https://www.twitch.tv/stream') {
  const player = new env.Element()
  const video = new env.Element('video')
  Object.assign(video, { volume, currentSrc, muted: false, isConnected: true })
  video.closest = () => player
  player.appendChild(video)
  player.queries.set('video', video)
  const players = env.selectors.get('[data-a-target="video-player"]') || []
  env.selectors.set('[data-a-target="video-player"]', [...players, player])
  env.api.ensurePlayerState(player)
  return { player, video }
}

function mockTwitchAudio(env, failConnect = false) {
  const contexts = [], sources = [], gains = []
  env.window.AudioContext = class {
    constructor() { this.destination = {}; this.state = 'suspended'; this.resumes = 0; contexts.push(this) }
    resume() { this.state = 'running'; this.resumes++; return Promise.resolve() }
    createGain() {
      const gain = { gain: { value: 1 }, disconnected: 0, connect() {}, disconnect() { this.disconnected++ } }
      gains.push(gain)
      return gain
    }
    createMediaElementSource(video) {
      assert.ok(!sources.some(source => source.video === video), 'Never create a second source for the same video')
      const source = { video, disconnected: 0, targets: [],
        connect(target) {
          if (failConnect && target.gain) throw Error('fixture gain connection failure')
          this.targets.push(target)
        }, disconnect() { this.disconnected++ } }
      sources.push(source)
      return source
    }
  }
  return { contexts, sources, gains }
}

test('Twitch volume: activate on adjustment and match YouTube gain at 25, 50 and 100', () => {
  const env = boot(scripts[1])
  const audio = mockTwitchAudio(env)
  const { player, video } = addTwitchPlayer(env, 0.3)
  assert.equal(audio.contexts.length, 0)
  video.muted = true
  env.api.changeVolume(wheel(video), player)
  assert.equal(video.volume, 0.25)
  assert.equal(video.muted, false)
  assertClose(audio.gains[0].gain.value, 0.75)
  assertClose(video.volume * audio.gains[0].gain.value, 0.1875)
  video.volume = 0.5
  video.dispatchEvent({ type: 'volumechange' })
  assertClose(audio.gains[0].gain.value, 1.5)
  video.volume = 1
  video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 3)
  env.api.ensurePlayerState(player)
  assert.equal(audio.sources.length, 1)
  assert.equal(audio.contexts[0].resumes, 1)
  assert.equal(video.events.get('volumechange').length, 1)
})

test('Twitch volume: channel/video replacement stays enabled and revisiting reuses the existing source', () => {
  const env = boot(scripts[1])
  const audio = mockTwitchAudio(env)
  const { player, video } = addTwitchPlayer(env)
  env.api.changeVolume(wheel(video), player)
  video.currentSrc = 'blob:https://www.twitch.tv/next-channel'
  video.volume = 0.75
  video.dispatchEvent({ type: 'loadedmetadata' })
  assert.equal(audio.sources.length, 1)
  assertClose(audio.gains[0].gain.value, 2.25)
  const next = new env.Element('video')
  Object.assign(next, { volume: 0.5, currentSrc: 'blob:https://www.twitch.tv/next-video', isConnected: true })
  next.closest = () => player
  video.isConnected = false
  player.queries.set('video', next)
  env.api.refresh()
  assert.equal(audio.sources.length, 2)
  assertClose(audio.gains[1].gain.value, 1.5)
  assert.ok(audio.sources[0].disconnected > 0)
  video.volume = 0.2
  video.dispatchEvent({ type: 'volumechange' })
  assertClose(audio.gains[0].gain.value, 2.25)
  video.isConnected = true
  next.isConnected = false
  player.queries.set('video', video)
  env.api.refresh()
  assert.equal(audio.sources.length, 2)
  assertClose(audio.gains[0].gain.value, 0.6)
  assert.ok(audio.sources[1].disconnected > 0)
})

test('Twitch volume: multiple players share one context while keeping independent gains', () => {
  const env = boot(scripts[1])
  const audio = mockTwitchAudio(env)
  const first = addTwitchPlayer(env)
  env.api.changeVolume(wheel(first.video), first.player)
  const second = addTwitchPlayer(env, 0.25)
  assert.equal(audio.contexts.length, 1)
  assert.equal(audio.sources.length, 2)
  assertClose(audio.gains[1].gain.value, 0.75)
  first.video.volume = 1
  first.video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 3)
  assertClose(audio.gains[1].gain.value, 0.75)
  env.selectors.set('[data-a-target="video-player"]', [])
  env.api.refresh()
  assert.ok(audio.sources.every(source => source.disconnected > 0))
})

test('Twitch volume: native controls enable gain and media readiness finishes deferred setup', () => {
  const env = boot(scripts[1])
  const audio = mockTwitchAudio(env)
  const { player, video } = addTwitchPlayer(env, 0.5, '')
  const slider = { closest: () => ({}) }
  player.dispatchEvent({ type: 'pointerdown', target: slider })
  assert.equal(audio.sources.length, 0)
  video.currentSrc = 'blob:https://www.twitch.tv/ready'
  video.dispatchEvent({ type: 'loadedmetadata' })
  assert.equal(audio.sources.length, 1)
  assertClose(audio.gains[0].gain.value, 1.5)
  video.volume = 0.7
  video.dispatchEvent({ type: 'volumechange' })
  assertClose(audio.gains[0].gain.value, 2.1)
})

test('Twitch volume: unsupported, remote and protected media retain native volume controls', () => {
  for (const kind of ['unsupported', 'remote', 'protected']) {
    const env = boot(scripts[1])
    const audio = kind === 'unsupported' ? null : mockTwitchAudio(env)
    const { player, video } = addTwitchPlayer(env, 0.3,
      kind === 'remote' ? 'https://cdn.example/video.mp4' : 'blob:https://www.twitch.tv/safe')
    if (kind === 'protected') video.mediaKeys = {}
    env.api.changeVolume(wheel(video, { ctrlKey: true }), player)
    assert.equal(video.volume, 0.3)
    env.api.changeVolume(wheel(video), player)
    assert.equal(video.volume, 0.25)
    if (audio) assert.equal(audio.sources.length, 0)
  }
})

test('Twitch volume: failed gain connections fall back to native output without wrapping the video twice', () => {
  const env = boot(scripts[1])
  const audio = mockTwitchAudio(env, true)
  const { player, video } = addTwitchPlayer(env, 0.3)
  env.api.changeVolume(wheel(video), player)
  assert.equal(video.volume, 0.25)
  assert.equal(audio.sources[0].targets[0], audio.contexts[0].destination)
  env.api.changeVolume(wheel(video), player)
  assert.equal(video.volume, 0.2)
  assert.equal(audio.sources.length, 1)
  env.selectors.set('[data-a-target="video-player"]', [])
  env.api.refresh()
  assert.ok(audio.sources[0].disconnected > 0)
})

test('Twitch volume: wheel without user activation keeps native playback unmuted until activation, and permanent setup errors stop retries', async () => {
  const env = boot(scripts[1])
  let allowResume = false
  let badAttempts = 0
  const sources = []
  const gains = []
  const badVideo = new env.Element('video')
  Object.assign(badVideo, { volume: 0.5, currentSrc: 'blob:https://www.twitch.tv/bad', isConnected: true })

  env.window.AudioContext = class {
    constructor() { this.destination = {}; this.state = 'suspended' }
    resume() {
      if (allowResume) this.state = 'running'
      return Promise.resolve()
    }
    createGain() {
      const gain = { gain: { value: 1 }, connect() {}, disconnect() {} }
      gains.push(gain)
      return gain
    }
    createMediaElementSource(video) {
      if (video === badVideo) {
        badAttempts++
        throw new Error('already connected')
      }
      const source = { video, connect() {}, disconnect() {} }
      sources.push(source)
      return source
    }
  }

  const { player, video } = addTwitchPlayer(env, 0.5)
  env.api.changeVolume(wheel(video), player)
  await Promise.resolve()
  assert.equal(sources.length, 0, 'Must not wrap video while AudioContext stays suspended')

  allowResume = true
  env.emit('pointerdown', {})
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(sources.length, 1, 'User activation resumes AudioContext and attaches gain')
  assertClose(gains[0].gain.value, 1.35)

  env.api.ensureVolumeGain(badVideo)
  env.api.ensureVolumeGain(badVideo)
  assert.equal(badAttempts, 1, 'Permanent source creation failures are not retried repeatedly')
})

test('Twitch screenshot & tooltips: Trusted Types SVG icon builds cleanly, hideTooltip cancels frame and left clamps to player', () => {
  const env = boot(scripts[1], 'worker', '/', { trustedTypes: true })
  const player = new env.Element()
  player.rect = { left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }
  const controls = new env.Element()
  const slot = controls.appendChild(new env.Element())
  const wrapper = slot.appendChild(new env.Element())
  const theater = wrapper.appendChild(new env.Element('button'))
  player.queries.set(
    'button[data-a-target="player-theatre-mode-button"], button[aria-label^="劇院模式"], button[aria-label^="Theater Mode"]',
    [theater]
  )
  // No pre-existing screenshot slot.
  player.queries.set('[data-a-target="video-player"]', [player])

  env.api.ensurePlayerState(player)
  env.api.ensureScreenshotButtons(player)
  const screenshotBtn = controls.children[0].children[0].children[0]
  assert.ok(screenshotBtn.children[0].tagName === 'svg')

  const tooltipNode = player.queries.get('.twitch-player-tweaks-tooltip') ||
    player.children.find(child => child.className === 'twitch-player-tweaks-tooltip')
  tooltipNode.rect = { left: 0, top: 0, right: 60, bottom: 28, width: 60, height: 28 }
  screenshotBtn.rect = { left: 380, top: 260, right: 400, bottom: 290, width: 20, height: 30 }

  env.api.showTooltip(player, screenshotBtn, '截圖')
  assert.equal(env.animationFrames.size, 1)
  env.api.hideTooltip(player)
  assert.equal(env.animationFrames.size, 0, 'hideTooltip must cancel pending animation frame')

  env.api.showTooltip(player, screenshotBtn, '截圖')
  env.render()
  assert.equal(tooltipNode.style.left, '362px')
})

test('YouTube volume, Shorts transitions & tooltips: defer suspended capture, follow active reel playing, check composedPath and cancel tooltip frame', async () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  let allowResume = false
  const sources = []
  let sourceCount = 0
  const gain = { gain: { value: 1 }, connect() {} }
  env.window.AudioContext = class {
    constructor() { this.destination = {}; this.state = 'suspended' }
    resume() {
      if (allowResume) this.state = 'running'
      return Promise.resolve()
    }
    createGain() { return gain }
    createMediaElementSource(video) {
      sourceCount++
      const source = { video, disconnected: 0, connect() {}, disconnect() { this.disconnected++ } }
      sources.push(source)
      return source
    }
  }

  const shorts = new env.Element('ytd-shorts')
  const overlay = new env.Element()
  shorts.appendChild(overlay)
  const first = addShortsPlayer(env, shorts)
  env.selectors.set('ytd-shorts', shorts)

  env.emit('wheel', wheel(overlay))
  await Promise.resolve()
  assert.equal(sourceCount, 0, 'Suspended AudioContext on wheel must not hijack native playback')

  allowResume = true
  env.emit('pointerdown', {})
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(sourceCount, 1)
  assertClose(gain.gain.value, 1.35)

  // Switch reels without wheeling the second reel.
  first.area.rect.top = -600
  first.area.rect.bottom = -100
  const next = addShortsPlayer(env, shorts)
  next.player.className = 'html5-video-player'
  shorts.className = 'ytd-shorts'
  next.player.volume = 80
  next.video.closest = (selector) => {
    if (selector === 'ytd-shorts') return shorts
    if (selector === '.html5-video-player') return next.player
    return null
  }
  env.emit('playing', { target: next.video })
  assert.equal(sourceCount, 2)
  assert.ok(sources[0].disconnected > 0)
  assertClose(gain.gain.value, 2.4)

  // Editable target inside shadow DOM (exposed via composedPath) blocks screenshot key.
  const shadowHost = new env.Element('custom-host')
  const shadowInput = new env.Element('input')
  let prevented = false
  env.api.handleKeydown({
    key: 's',
    target: shadowHost,
    composedPath: () => [shadowInput, shadowHost],
    preventDefault() { prevented = true },
  })
  assert.equal(prevented, false)

  // hideTooltip cancels pending tooltip frame.
  const ytTooltip = new env.Element()
  ytTooltip.dataset = { visible: 'false' }
  env.api.setTooltip(ytTooltip)
  env.api.setPlayers(first.video, Object.assign(new env.Element(), { getBoundingClientRect: () => ({ left: 0, width: 500 }) }))
  const beforeFrames = env.animationFrames.size
  env.api.showTooltip(new env.Element(), '截圖')
  assert.equal(env.animationFrames.size, beforeFrames + 1)
  env.api.hideTooltip()
  assert.equal(env.animationFrames.size, beforeFrames)
})

test('YouTube player lookup & initial response: scope player queries to #movie_player and chain upstream ytInitialPlayerResponse descriptors', () => {
  let stored = undefined
  let upstreamSets = 0
  let upstreamGets = 0
  const env = boot(scripts[0], 'worker', '/watch', {
    setupWindow(win) {
      Object.defineProperty(win, 'ytInitialPlayerResponse', {
        configurable: true,
        enumerable: true,
        get() { upstreamGets++; return stored },
        set(value) { upstreamSets++; stored = value },
      })
    },
  })

  env.window.ytInitialPlayerResponse = { videoDetails: { isLive: false } }
  const firstLive = { videoDetails: { isLive: true } }
  env.window.ytInitialPlayerResponse = firstLive
  const secondLive = { videoDetails: { isLive: true } }
  env.window.ytInitialPlayerResponse = secondLive
  assert.equal(upstreamSets, 3)
  assert.ok(upstreamGets >= 2)
  assert.equal(firstLive.videoDetails.isLiveDvrEnabled, true)
  assert.equal(secondLive.videoDetails.isLiveDvrEnabled, true)
  assert.equal(env.window.ytInitialPlayerResponse, secondLive)

  const previewPlayer = new env.Element()
  previewPlayer.className = 'html5-video-player'
  const previewContainer = previewPlayer.appendChild(new env.Element())
  const moviePlayer = new env.Element()
  moviePlayer.className = 'html5-video-player'

  env.selectors.set('#movie_player', moviePlayer)
  env.selectors.set('.html5-video-container', previewContainer)
  env.selectors.set('button.ytp-size-button', new env.Element('button'))
  env.selectors.set('.ytp-progress-bar', new env.Element())
  env.selectors.set('#movie_player video', new env.Element('video'))
  assert.equal(env.api.collectPlayerElements(), false, 'Must ignore containers owned by inline preview players')

  const ownContainer = moviePlayer.appendChild(new env.Element())
  moviePlayer.queries.set('.html5-video-container', ownContainer)
  moviePlayer.queries.set('button.ytp-size-button', new env.Element('button'))
  moviePlayer.queries.set('.ytp-progress-bar', new env.Element())
  moviePlayer.queries.set('video', new env.Element('video'))
  assert.equal(env.api.collectPlayerElements(), true)
})


test('YouTube Shorts: close dismissal persists across Shorts, disabled comments do not retry, self/unrelated mutations are filtered, and leaving Shorts cleans up', async () => {
  const env = boot(scripts[0], 'worker', '/shorts/first')
  const fx = addShortsPanelFixture(env)
  env.render()

  const tabBar = fx.anchoredPanel.querySelector('#yt-shorts-panel-tabs')
  const closeBtn = tabBar.querySelector('.yt-shorts-panel-close')
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')

  // Dismiss via unified close button.
  closeBtn.click()
  assert.equal(fx.expandedTargetId(), '')
  assert.equal(tabBar.hidden, true)
  assert.equal(fx.shorts.hasAttribute('data-yt-shorts-tabs'), false)
  assert.equal(fx.anchoredPanel.hasAttribute('data-yt-shorts-tabs'), false)

  // Next Short stays closed while dismissed.
  env.location.pathname = '/shorts/second'
  await env.listeners.get('yt-navigate-finish')()
  assert.equal(fx.expandedTargetId(), '')
  assert.equal(fx.getCommentClicks(), 1)

  // Manual native Comments click clears dismissal and restores tabs.
  fx.commentsBtn.click()
  env.render()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
  assert.equal(tabBar.hidden, false)

  // Dismiss again, leave Shorts, verify cleanup, then return to Shorts -> auto-opens again.
  closeBtn.click()
  assert.equal(fx.expandedTargetId(), '')
  env.location.pathname = '/'
  await env.listeners.get('yt-navigate-finish')()
  assert.equal(env.observers[0].connected, false)
  assert.equal(env.timers.size, 0)
  assert.equal(env.animationFrames.size, 0)
  assert.equal(env.listenerCount('click'), 0)
  assert.equal(env.listenerCount('scroll'), 0)
  assert.equal(tabBar.isConnected, false)

  env.location.pathname = '/shorts/third'
  await env.listeners.get('yt-navigate-finish')()
  env.render()
  assert.equal(fx.expandedTargetId(), 'engagement-panel-comments-section')
  assert.equal(fx.getCommentClicks(), 3)

  // Unrelated DOM churn and tab-bar self-mutations must not schedule frames.
  const activeTabBar = fx.anchoredPanel.querySelector('#yt-shorts-panel-tabs')
  const unrelated = new env.Element('div')
  const span = new env.Element('span')
  env.observers[1].callback([
    { type: 'childList', target: unrelated, addedNodes: [span], removedNodes: [] },
    { type: 'attributes', attributeName: 'data-yt-shorts-tabs', target: fx.shorts },
    { type: 'childList', target: fx.anchoredPanel, addedNodes: [activeTabBar], removedNodes: [] },
  ])
  assert.equal(env.animationFrames.size, 0)

  env.observers[1].callback([{ type: 'attributes', attributeName: 'is-fullscreen', target: fx.shorts }])
  assert.equal(env.animationFrames.size, 1)

  // Disabled Comments button does not schedule infinite retry timers.
  const envDisabled = boot(scripts[0], 'worker', '/shorts/ad')
  const fxDisabled = addShortsPanelFixture(envDisabled, { commentsDisabled: true })
  envDisabled.render()
  assert.equal(fxDisabled.getCommentClicks(), 0)
  assert.equal(fxDisabled.expandedTargetId(), '')
  assert.equal(envDisabled.timers.size, 0)
})

test('YouTube Shorts: hidden #anchored-panel-scrim on desktop allows auto-open while visible scrim blocks it', () => {
  const envHidden = boot(scripts[0], 'worker', '/shorts/desktop')
  const fxHidden = addShortsPanelFixture(envHidden, { visibleScrim: false })
  assert.ok(fxHidden.shorts.querySelector('#anchored-panel-scrim'))
  envHidden.render()
  assert.equal(fxHidden.getCommentClicks(), 1)
  assert.equal(fxHidden.expandedTargetId(), 'engagement-panel-comments-section')

  const envVisible = boot(scripts[0], 'worker', '/shorts/modal')
  const fxVisible = addShortsPanelFixture(envVisible, { visibleScrim: true })
  envVisible.render()
  assert.equal(fxVisible.getCommentClicks(), 0)
  assert.equal(fxVisible.expandedTargetId(), '')
})

test('YouTube Shorts: bare /shorts route and yt-page-data-updated activate and clean up without yt-navigate-finish', () => {
  const envBare = boot(scripts[0], 'worker', '/shorts')
  const fxBare = addShortsPanelFixture(envBare)
  envBare.render()
  assert.equal(fxBare.getCommentClicks(), 1)
  assert.equal(fxBare.expandedTargetId(), 'engagement-panel-comments-section')

  const envSpa = boot(scripts[0], 'worker', '/')
  const fxSpa = addShortsPanelFixture(envSpa)
  envSpa.location.pathname = '/shorts'
  envSpa.emit('yt-page-data-updated', {})
  envSpa.render()
  assert.equal(fxSpa.getCommentClicks(), 1)
  assert.equal(fxSpa.expandedTargetId(), 'engagement-panel-comments-section')

  envSpa.location.pathname = '/'
  envSpa.emit('popstate', {})
  assert.equal(envSpa.observers[0].connected, false)
  assert.equal(envSpa.timers.size, 0)
})

test('YouTube Shorts: background tabs defer auto-open until visible and missing-button polls do not exhaust late hydration', () => {
  const envBg = boot(scripts[0], 'worker', '/shorts/bg', {
    setupWindow: (_win, doc) => { doc.visibilityState = 'hidden' },
  })
  const fxBg = addShortsPanelFixture(envBg)
  envBg.render()
  assert.equal(fxBg.getCommentClicks(), 0)

  envBg.document.visibilityState = 'visible'
  envBg.emit('visibilitychange', {})
  envBg.render()
  assert.equal(fxBg.getCommentClicks(), 1)
  assert.equal(fxBg.expandedTargetId(), 'engagement-panel-comments-section')

  const envLate = boot(scripts[0], 'worker', '/shorts/late')
  const fxLate = addShortsPanelFixture(envLate, { deferActionBar: true })
  envLate.render()
  for (let i = 0; i < 26; i++) envLate.flush(250)
  assert.equal(fxLate.getCommentClicks(), 0)
  assert.equal(envLate.timers.size, 0, 'missing-button polling stops after SHORTS_MISSING_POLL_MAX')

  fxLate.mountActionBar()
  envLate.observers[0].callback([{ type: 'childList', target: fxLate.reel, addedNodes: [fxLate.reel], removedNodes: [] }])
  envLate.render()
  assert.equal(fxLate.getCommentClicks(), 1, 'late action bar still auto-opens without permanent exhaustion')
  assert.equal(fxLate.expandedTargetId(), 'engagement-panel-comments-section')
})

test('YouTube: addStyle re-appends stylesheet after head resources on DOMContentLoaded when document is loading', () => {
  const env = boot(scripts[0], 'worker', '/', {
    setupWindow: (_win, doc) => { doc.readyState = 'loading' },
  })
  assert.equal(env.styles.length, 1)
  env.emit('DOMContentLoaded', {})
  assert.equal(env.styles.length, 2)
  assert.equal(env.styles[1], env.styles[0])
})

test('Twitch: body MutationObserver ignores chat subtree churn without querying players', () => {
  const env = boot(scripts[1])
  env.timers.clear()
  let playerQueries = 0
  const origGet = env.selectors.get.bind(env.selectors)
  env.selectors.get = selector => {
    if (selector === '[data-a-target="video-player"]') playerQueries++
    return origGet(selector)
  }

  const chat = Object.assign(new env.Element('div'), { className: 'stream-chat', nodeType: 1 })
  const line = chat.appendChild(Object.assign(new env.Element('div'), { nodeType: 1 }))
  const span = Object.assign(new env.Element('span'), { nodeType: 1 })
  env.observers[0].callback([{ type: 'childList', target: line, addedNodes: [span], removedNodes: [] }])
  assert.equal(env.timers.size, 0)
  assert.equal(playerQueries, 0)

  const stage = Object.assign(new env.Element('div'), { className: 'video-player', nodeType: 1 })
  const inner = Object.assign(new env.Element('div'), { nodeType: 1 })
  env.observers[0].callback([{ type: 'childList', target: stage, addedNodes: [inner], removedNodes: [] }])
  assert.equal(env.timers.size, 1)
  for (const timer of [...env.timers.values()]) timer.fn()
  assert.ok(playerQueries >= 1)
})

test('Tooltips WCAG 1.4.13 (Twitch & YouTube): role=tooltip, aria-describedby, hover grace bridge, Escape and blur dismissal', async () => {
  // 1. Twitch tooltip semantics, hover bridge, Escape, and blur
  const tw = boot(scripts[1], 'worker', '/example')
  const player = new tw.Element()
  player.rect = { left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }
  const controls = new tw.Element()
  const slot = controls.appendChild(new tw.Element())
  const wrapper = slot.appendChild(new tw.Element())
  const theater = wrapper.appendChild(new tw.Element('button'))
  player.queries.set(
    'button[data-a-target="player-theatre-mode-button"], button[aria-label^="劇院模式"], button[aria-label^="Theater Mode"]',
    [theater],
  )
  tw.api.ensurePlayerState(player)
  tw.api.ensureScreenshotButtons(player)
  const twBtn = controls.children[0].children[0].children[0]
  const twTooltip = player.children.find(child => child.className === 'twitch-player-tweaks-tooltip')
  assert.equal(twTooltip.getAttribute('role'), 'tooltip')
  assert.ok(twTooltip.id)

  twBtn.dispatchEvent({ type: 'mouseenter' })
  assert.equal(twTooltip.dataset.visible, 'true')
  assert.equal(twBtn.getAttribute('aria-describedby'), twTooltip.id)

  // Moving pointer from button onto tooltip cancels hide grace period; leaving tooltip hides after 100ms
  twBtn.dispatchEvent({ type: 'mouseleave' })
  twTooltip.dispatchEvent({ type: 'mouseenter' })
  tw.flush(100)
  assert.equal(twTooltip.dataset.visible, 'true')
  assert.equal(twBtn.getAttribute('aria-describedby'), twTooltip.id)

  twTooltip.dispatchEvent({ type: 'mouseleave' })
  tw.flush(100)
  assert.equal(twTooltip.dataset.visible, 'false')
  assert.equal(twBtn.getAttribute('aria-describedby'), null)

  // Escape dismisses visible tooltip immediately
  twBtn.dispatchEvent({ type: 'focus' })
  assert.equal(twTooltip.dataset.visible, 'true')
  tw.emit('keydown', { key: 'Escape' })
  assert.equal(twTooltip.dataset.visible, 'false')
  assert.equal(twBtn.getAttribute('aria-describedby'), null)

  // Blur dismisses immediately without waiting for hover grace
  twBtn.dispatchEvent({ type: 'focus' })
  assert.equal(twTooltip.dataset.visible, 'true')
  twBtn.dispatchEvent({ type: 'blur' })
  assert.equal(twTooltip.dataset.visible, 'false')
  assert.equal(twBtn.getAttribute('aria-describedby'), null)

  // 2. YouTube tooltip semantics, no aria-hidden wrapper, hover bridge, Escape, and blur
  const yt = boot(scripts[0], 'worker', '/watch')
  const moviePlayer = new yt.Element()
  moviePlayer.className = 'html5-video-player'
  moviePlayer.rect = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 }
  moviePlayer.appendChild(new yt.Element()).className = 'html5-video-container'
  moviePlayer.appendChild(new yt.Element('video'))
  moviePlayer.appendChild(new yt.Element()).className = 'ytp-progress-bar'
  const buttonGroup = moviePlayer.appendChild(new yt.Element())
  const sizeBtn = buttonGroup.appendChild(new yt.Element('button'))
  sizeBtn.className = 'ytp-size-button'
  yt.selectors.set('#movie_player', moviePlayer)
  yt.emit('yt-navigate-finish', {})
  for (let i = 0; i < 5; i++) await Promise.resolve()

  const photoBtn = buttonGroup.children.find(child => (child.className || '').includes('ytp-photo-button'))
  const ytTooltip = moviePlayer.querySelector('#yt-player-tweaks-tooltip')
  assert.ok(photoBtn && ytTooltip)
  assert.equal(ytTooltip.getAttribute('role'), 'tooltip')
  assert.equal(ytTooltip.querySelector('.ytp-tooltip-text-wrapper').getAttribute('aria-hidden'), null)

  photoBtn.dispatchEvent({ type: 'mouseenter', currentTarget: photoBtn })
  assert.equal(ytTooltip.dataset.visible, 'true')
  assert.equal(photoBtn.getAttribute('aria-describedby'), ytTooltip.id)

  photoBtn.dispatchEvent({ type: 'mouseleave' })
  ytTooltip.dispatchEvent({ type: 'mouseenter' })
  yt.flush(100)
  assert.equal(ytTooltip.dataset.visible, 'true')

  ytTooltip.dispatchEvent({ type: 'mouseleave' })
  yt.flush(100)
  assert.equal(ytTooltip.dataset.visible, 'false')
  assert.equal(photoBtn.getAttribute('aria-describedby'), null)

  photoBtn.dispatchEvent({ type: 'focus', currentTarget: photoBtn })
  assert.equal(ytTooltip.dataset.visible, 'true')
  yt.emit('keydown', { key: 'Escape', target: photoBtn })
  assert.equal(ytTooltip.dataset.visible, 'false')
  assert.equal(photoBtn.getAttribute('aria-describedby'), null)

  photoBtn.dispatchEvent({ type: 'focus', currentTarget: photoBtn })
  assert.equal(ytTooltip.dataset.visible, 'true')
  photoBtn.dispatchEvent({ type: 'blur' })
  assert.equal(ytTooltip.dataset.visible, 'false')
  assert.equal(photoBtn.getAttribute('aria-describedby'), null)
})
