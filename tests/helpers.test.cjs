const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function environment(file, pathname = '/watch') {
  let now = 0
  let nextId = 0
  const jobs = new Map()
  const nodes = new Map()
  const observers = []
  const schedule = (callback, delay, repeat) => {
    const id = ++nextId
    jobs.set(id, { callback, at: now + delay, repeat })
    return id
  }
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() { this.active = true }
    disconnect() { this.active = false }
  }
  const document = new EventTarget()
  document.documentElement = {}
  document.querySelector = selector => nodes.get(selector) ?? null
  const location = new URL(`https://www.youtube.com${pathname}`)
  const context = {
    document, location, MutationObserver: Observer,
    setTimeout: (callback, delay) => schedule(callback, delay, 0),
    clearTimeout: id => jobs.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: id => jobs.delete(id),
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context)
  return {
    nodes, jobs, observers,
    async mutate() {
      for (const observer of [...observers]) if (observer.active) observer.callback([])
      await flush()
    },
    async navigate(pathname) {
      location.pathname = pathname
      document.dispatchEvent(new Event('yt-navigate-finish'))
      await flush()
    },
    async advance(milliseconds) {
      await flush()
      const target = now + milliseconds
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, job] = next
        now = job.at
        if (job.repeat) job.at += job.repeat
        else jobs.delete(id)
        job.callback()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

const scripts = [
  {
    file: 'YouTubeAutoDisableSubtitles.user.js', selector: '#movie_player', route: '/watch',
    node() {
      return { on: true, calls: 0, isSubtitlesOn() { return this.on }, toggleSubtitles() { this.on = !this.on; this.calls++ } }
    },
  },
  {
    file: 'YouTubeDefaultMaxQuality.user.js', selector: '#movie_player', route: '/watch',
    node() {
      return { levels: ['hd2160'], calls: 0, getAvailableQualityLevels() { return this.levels }, setPlaybackQualityRange(value) { this.quality = value; this.calls++ } }
    },
  },
  {
    file: 'YouTubeChannelAutoPause.user.js', selector: 'ytd-browse video', route: '/@channel',
    node() {
      const video = new EventTarget()
      Object.assign(video, { paused: false, calls: 0, pause() { this.paused = true; this.calls++ } })
      return video
    },
  },
]

for (const script of scripts) {
  test(`${script.file}: delayed DOM survives fallback, then releases timers`, async () => {
    const env = environment(script.file, script.route)
    await env.advance(12000)
    assert.equal(env.observers.filter(observer => observer.active).length, 0)
    const node = script.node()
    env.nodes.set(script.selector, node)
    await env.advance(1000)
    assert.equal(node.calls, 1)
    await env.advance(6000)
    assert.equal(env.jobs.size, 0)
  })

  for (const beforeNavigation of [0, 12000]) {
    test(`${script.file}: navigation cancels waiting at ${beforeNavigation}ms`, async () => {
      const env = environment(script.file, script.route)
      await env.advance(beforeNavigation)
      await env.navigate('/feed/subscriptions')
      assert.equal(env.jobs.size, 0)
      assert.equal(env.observers.filter(observer => observer.active).length, 0)
      const node = script.node()
      env.nodes.set(script.selector, node)
      await env.mutate()
      await env.advance(20000)
      assert.equal(node.calls, 0)
    })
  }
}

for (const script of scripts.slice(0, 2)) {
  test(`${script.file}: API becoming available after 6 seconds still initializes`, async () => {
    const env = environment(script.file)
    const node = { calls: 0 }
    env.nodes.set(script.selector, node)
    await env.mutate()
    await env.advance(6000)
    Object.assign(node, script.node())
    await env.advance(1000)
    assert.equal(node.calls, 1)
  })
}

test('quality: wait for the initial nonempty list, then apply later higher quality once', async () => {
  const script = scripts[1]
  const env = environment(script.file)
  const player = script.node()
  player.levels = []
  env.nodes.set(script.selector, player)
  await env.mutate()
  await env.advance(6000)
  player.levels = ['hd1080']
  await env.advance(1000)
  assert.equal(player.quality, 'hd1080')
  player.levels = ['hd2160', 'hd1080']
  await env.advance(1000)
  assert.equal(player.quality, 'hd2160')
  assert.equal(player.calls, 2)
  await env.advance(6000)
  assert.equal(player.calls, 2)
  assert.equal(env.jobs.size, 0)
})

test('subtitles: turn off automatic captions once without later fighting manual re-enable', async () => {
  const env = environment(scripts[0].file)
  const player = scripts[0].node()
  player.on = false
  env.nodes.set('#movie_player', player)
  await env.mutate()
  await env.advance(1000)
  player.on = true
  await env.advance(250)
  assert.equal(player.on, false)
  assert.equal(player.calls, 1)
  player.on = true
  await env.advance(6000)
  assert.equal(player.on, true)
  assert.equal(env.jobs.size, 0)
})

test('channel: pause first early play, but allow later manual playback', async () => {
  const env = environment(scripts[2].file, '/@channel')
  const video = scripts[2].node()
  video.paused = true
  env.nodes.set('ytd-browse video', video)
  await env.mutate()
  video.paused = false
  video.dispatchEvent(new Event('play'))
  assert.equal(video.paused, true)
  await env.advance(6000)
  video.paused = false
  video.dispatchEvent(new Event('play'))
  assert.equal(video.paused, false)
  assert.equal(video.calls, 1)
  assert.equal(env.jobs.size, 0)
})
