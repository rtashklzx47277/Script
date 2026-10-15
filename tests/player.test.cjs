const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const scripts = ['YouTubePlayerTweaks.user.js', 'TwitchPlayerTweaks.user.js']

// Run the real userscript and expose its closed-over functions at the end of
// its IIFE. Only browser primitives are mocked; production functions are intact.
function boot(file, mode = 'worker', pathname = '/') {
  const isYouTube = file === scripts[0]
  let nextId = 0
  let activeWorker
  const timers = new Map()
  const workerSources = new Map()
  const selectors = new Map()
  const observers = []
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
      this.style = {}
      this.dataset = {}
      this.children = []
      this.queries = new Map()
      this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
    appendChild(element) {
      element.parentElement = this
      this.children.push(element)
    }
    matches(selector) { return selector.split(',').some(part => part.trim() === this.tagName) }
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
      return this.queries.get(selector) || this.children.find(child => `#${child.id}` === selector ||
        selector.startsWith('.') && (child.className || '').split(' ').includes(selector.slice(1))) || null
    }
    querySelectorAll(selector) { return this.queries.get(selector) || [] }
    getBoundingClientRect() { return this.rect }
    addEventListener(name, callback) {
      this.events ||= new Map()
      const callbacks = this.events.get(name) || []
      callbacks.push(callback)
      this.events.set(name, callbacks)
    }
    dispatchEvent(event) {
      for (const callback of this.events?.get(event.type) || []) callback(event)
      return true
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
    querySelector(selector) { return selectors.get(selector) || null },
    querySelectorAll(selector) { return selectors.get(selector) || [] },
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
    window: { JSON: { parse: JSON.parse } },
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
        encode: (video) => { videoPlayer = video; return encodeScreenshot(); },
        jobs: () => screenshotWorkerJobs.size,
      };`
    : `globalThis.__test = {
        encode: encodeScreenshot, jobs: () => screenshotWorkerJobs.size,
        changeVolume, ensurePlayerState, refresh,
      };`
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  assert.match(source, /\}\)\(\)\s*$/)
  vm.createContext(context)
  vm.runInContext(source.replace(/\}\)\(\)\s*$/, exposure + '})()'), context, { filename: file })

  return {
    api: context.__test, window: context.window,
    Element: ElementMock, location: context.location,
    frames, draws, timers, selectors, observers, listeners, styles,
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
  assert.equal(gain.gain.value, 0.3)
  assert.equal(volume / 100 * gain.gain.value, 0.045)

  volume = 75
  env.api.syncVolumeGain() // YouTube's native volume slider changed.
  assert.equal(gain.gain.value, 1.5)
  assert.equal(volume / 100 * gain.gain.value, 1.125)

  volume = 95
  env.api.changeVolume({ deltaY: -1, preventDefault() {} })
  assert.equal(volume, 100)
  assert.equal(gain.gain.value, 2)
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
  assert.equal(env.observers.length, 0, 'Shorts must not wait for regular player controls')
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
  assert.equal(gain.gain.value, 0.9)
  first.player.volume = 75
  env.emit('volumechange', { target: first.video })
  assert.equal(gain.gain.value, 1.5)

  first.area.rect.top = -600
  first.area.rect.bottom = -100
  const next = addShortsPlayer(env, shorts)
  env.emit('wheel', wheel(overlay))
  assert.equal(gain.gain.value, 0.9)
  assert.equal(sources.length, 2)
  assert.ok(sources[0].disconnected > 0)
  env.emit('volumechange', { target: first.video })
  assert.equal(gain.gain.value, 0.9, 'An inactive reel must not change the current gain')

  next.area.rect.top = 600
  next.area.rect.bottom = 1100
  first.area.rect.top = 20
  first.area.rect.bottom = 520
  env.emit('wheel', wheel(overlay))
  assert.equal(first.player.volume, 70)
  assert.equal(sources.length, 2, 'Revisiting a video must reuse its MediaElementSource')
  assert.equal(gain.gain.value, 1.4)
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
  assert.equal(audio.gains[0].gain.value, 0.5)
  assert.equal(video.volume * audio.gains[0].gain.value, 0.125)
  video.volume = 0.5
  video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 1)
  video.volume = 1
  video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 2)
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
  assert.equal(audio.gains[0].gain.value, 1.5)
  const next = new env.Element('video')
  Object.assign(next, { volume: 0.5, currentSrc: 'blob:https://www.twitch.tv/next-video', isConnected: true })
  next.closest = () => player
  video.isConnected = false
  player.queries.set('video', next)
  env.api.refresh()
  assert.equal(audio.sources.length, 2)
  assert.equal(audio.gains[1].gain.value, 1)
  assert.ok(audio.sources[0].disconnected > 0)
  video.volume = 0.2
  video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 1.5, 'Detached videos must not reactivate old audio graphs')
  video.isConnected = true
  next.isConnected = false
  player.queries.set('video', video)
  env.api.refresh()
  assert.equal(audio.sources.length, 2)
  assert.equal(audio.gains[0].gain.value, 0.4)
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
  assert.equal(audio.gains[1].gain.value, 0.5)
  first.video.volume = 1
  first.video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 2)
  assert.equal(audio.gains[1].gain.value, 0.5)
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
  assert.equal(audio.gains[0].gain.value, 1)
  video.volume = 0.7
  video.dispatchEvent({ type: 'volumechange' })
  assert.equal(audio.gains[0].gain.value, 1.4)
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
