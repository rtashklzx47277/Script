const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const scripts = ['YouTubePlayerTweaks.user.js', 'TwitchPlayerTweaks.user.js']

// Run the real userscript and expose its closed-over functions at the end of
// its IIFE. Only browser primitives are mocked; production functions are intact.
function boot(file, mode = 'worker') {
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
    addEventListener(name, callback) { listeners.set(name, callback) },
    querySelector(selector) { return selectors.get(selector) || null },
    querySelectorAll() { return [] },
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
      return { style: {}, dataset: {}, appendChild() {} }
    },
  }

  const context = {
    console,
    document,
    window: { JSON: { parse: JSON.parse } },
    location: { pathname: '/' },
    HTMLElement: class {},
    Node: class {},
    HTMLInputElement: class {},
    Blob: BlobMock,
    URL: {
      createObjectURL(blob) {
        const url = `blob:${++nextId}`
        workerSources.set(url, blob.parts.join(''))
        return url
      },
      revokeObjectURL(url) { workerSources.delete(url) },
    },
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
        restorePlaybackRate, getLiveEdgeDistance, getLiveBufferHealth,
        runLiveCatchupStep, toggleLiveCatchup, stopLiveCatchup, waitElements,
        setPlayers: (video, player) => {
          videoPlayer = video; moviePlayer = player; floatingBar = { style: {} };
        },
        cancelWait: () => pendingWaitCancel?.(),
        catching: () => Boolean(liveCatchupTimer),
        encode: (video) => { videoPlayer = video; return encodeScreenshot(); },
        jobs: () => screenshotWorkerJobs.size,
      };`
    : `globalThis.__test = {
        encode: encodeScreenshot, jobs: () => screenshotWorkerJobs.size,
      };`
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  assert.match(source, /\}\)\(\)\s*$/)
  vm.createContext(context)
  vm.runInContext(source.replace(/\}\)\(\)\s*$/, exposure + '})()'), context, { filename: file })

  return {
    api: context.__test,
    frames, draws, timers, selectors, observers, listeners, styles,
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

test('YouTube: low buffer does not mean live edge; healthy buffer accelerates and reaching edge restores', () => {
  const env = boot(scripts[0])
  const video = setLivePlayer(env)
  video.buffered = range(0, 10.4)
  env.api.toggleLiveCatchup()
  assert.equal(env.api.catching(), true)
  assert.equal(video.playbackRate, 1)
  video.buffered = range(0, 40)
  env.api.runLiveCatchupStep()
  assert.equal(video.playbackRate, 1.5)
  video.currentTime = 99.6
  env.api.runLiveCatchupStep()
  assert.equal(env.api.catching(), false)
  assert.equal(video.playbackRate, 1)
})

test('YouTube: missing live-edge information does not start catchup', () => {
  const env = boot(scripts[0])
  const video = setLivePlayer(env)
  video.seekable = { length: 0 }
  env.api.toggleLiveCatchup()
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
