const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function boot({ saved, blocked = false, trustedTypes = false, withResizeObserver = false, database, now, scheduler, performance, fetch, readyState, withBody = true, Response: customResponse, Headers: customHeaders } = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag
      this.nodeType = 1
      this.children = []
      this.attrs = new Map()
      this.listeners = new Map()
      this.listenerCounts = new Map()
      this.style = {}
      this._textContent = ''
      this._innerHTML = ''
      this.hidden = false
      this.value = ''
    }
    get innerHTML() { return this._innerHTML }
    set innerHTML(value) {
      if (trustedTypes) throw new TypeError('This document requires TrustedHTML assignment')
      const html = String(value)
      this._innerHTML = html
      if (!html.includes('<')) return
      this.replaceChildren()
      const stack = [this]
      const voidTags = new Set(['input', 'img', 'br', 'hr', 'source'])
      for (const token of html.match(/<\/?[a-zA-Z0-9-]+(?:\s+[^>]*)?>|[^<]+/g) || []) {
        if (!token.startsWith('<')) {
          stack.at(-1)._textContent += token
          continue
        }
        const close = token.match(/^<\/([a-zA-Z0-9-]+)>/)
        if (close) {
          if (stack.length > 1 && stack.at(-1).tagName === close[1].toLowerCase()) stack.pop()
          continue
        }
        const open = token.match(/^<([a-zA-Z0-9-]+)([\s\S]*?)>$/)
        if (!open) continue
        const child = new Element(open[1].toLowerCase())
        for (const attr of open[2].matchAll(/([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g)) {
          child.setAttribute(attr[1], attr[2] ?? '')
        }
        stack.at(-1).appendChild(child)
        if (!voidTags.has(child.tagName)) stack.push(child)
      }
    }
    get classList() {
      const self = this
      const list = () => new Set((self.className || '').split(/\s+/).filter(Boolean))
      const commit = set => { self.className = [...set].join(' ') }
      return {
        contains(name) { return list().has(name) },
        add(...names) { const set = list(); for (const name of names) set.add(name); commit(set) },
        remove(...names) { const set = list(); for (const name of names) set.delete(name); commit(set) },
        toggle(name, force) {
          const set = list()
          const next = force === undefined ? !set.has(name) : !!force
          if (next) set.add(name); else set.delete(name)
          commit(set)
          return next
        },
      }
    }
    get attributes() {
      const attrs = new Map(this.attrs)
      if (this.className) attrs.set('class', this.className)
      return [...attrs].map(([name, value]) => ({ name, value }))
    }
    get textContent() { return (this._textContent || '') + this.children.map(child => child.textContent).join('') }
    set textContent(value) { this._textContent = String(value); this.replaceChildren() }
    get childNodes() { return [...(this._textContent ? [{ nodeType: 3, textContent: this._textContent }] : []), ...this.children] }
    get firstChild() { return this.children[0] }
    get lastElementChild() { return this.children.at(-1) || null }
    addEventListener(name, fn) {
      this.listenerCounts.set(name, (this.listenerCounts.get(name) || 0) + 1)
      this.listeners.set(name, fn)
    }
    setAttribute(name, value) { this.attrs.set(name, value); if (name === 'class') this.className = value }
    getAttribute(name) { return this.attrs.get(name) || null }
    removeAttribute(name) { this.attrs.delete(name) }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim()
        if (part === '*') return true
        if (part.startsWith('#')) return this.id === part.slice(1) || this.getAttribute('id') === part.slice(1)
        if (part.startsWith('.')) return (this.className || '').split(' ').includes(part.slice(1))
        const attr = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
        if (attr) return attr[2] === undefined ? this.attrs.has(attr[1]) : this.getAttribute(attr[1]) === attr[2]
        const tagAttr = part.match(/^([a-z0-9-]+)\[([^=\]]+)(?:="([^"]*)")?\]$/i)
        if (tagAttr) return this.tagName === tagAttr[1].toLowerCase() && (tagAttr[3] === undefined ? this.attrs.has(tagAttr[2]) : this.getAttribute(tagAttr[2]) === tagAttr[3])
        if (part === 'img.chat-badge' || part === '[data-a-target="chat-badge"] img') {
          return this.tagName === 'img' && (this.className === 'chat-badge' ||
            this.parentElement?.getAttribute('data-a-target') === 'chat-badge')
        }
        const tagClass = part.match(/^([a-z0-9-]+)\.([a-z0-9_-]+)$/i)
        if (tagClass) return this.tagName === tagClass[1].toLowerCase() && (this.className || '').split(' ').includes(tagClass[2])
        return part === this.tagName
      })
    }
    contains(target) {
      return Boolean(target && (target === this || this.children.some(child => child.contains(target))))
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    closest(selector) {
      return this.matches(selector) ? this : this.parentElement?.closest(selector) || null
    }
    appendChild(child) {
      child.remove()
      this.children.push(child)
      child.parentElement = this
      return child
    }
    insertBefore(child, reference) {
      if (!reference) return this.appendChild(child)
      child.remove()
      const index = this.children.indexOf(reference)
      if (index === -1) this.children.push(child)
      else this.children.splice(index, 0, child)
      child.parentElement = this
      return child
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(child => child !== this)
        this.parentElement = null
      }
    }
    replaceWith(other) {
      if (!this.parentElement) return
      const parent = this.parentElement
      parent.children[parent.children.indexOf(this)] = other
      other.parentElement = parent
      this.parentElement = null
    }
    replaceChildren() { for (const child of [...this.children]) child.remove() }
    cloneNode(deep) {
      const copy = new Element(this.tagName)
      copy.attrs = new Map(this.attrs)
      copy.className = this.className
      copy.style = { ...this.style }
      copy._innerHTML = this._innerHTML
      copy.textContent = this._textContent || ''
      if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true))
      return copy
    }
  }
  const document = new Element('document')
  document.head = new Element('head')
  document.body = withBody ? new Element('body') : null
  document.hidden = false
  if (readyState !== undefined) document.readyState = readyState
  document.appendChild(document.head)
  if (document.body) document.appendChild(document.body)
  document.createElementNS = (_, tag) => new Element(tag)
  document.createElement = tag => new Element(tag)
  const observers = []
  document.createTextNode = text => Object.assign(new Element('#text'), { textContent: text })
  const storage = new Map(saved ? [['twitch-live-chat-tweaks-settings-v1', saved]] : [])
  const listeners = new Map()
  const timers = new Map()
  const frames = new Map()
  let nextTimer = 0
  const ResponseCtor = customResponse !== undefined ? customResponse : globalThis.Response
  const HeadersCtor = customHeaders !== undefined ? customHeaders : globalThis.Headers
  const context = {
    document, location: { pathname: '/sample_channel', href: 'https://www.twitch.tv/sample_channel' }, console, URL,
    indexedDB: database,
    ...(fetch ? { fetch } : {}),
    ...(typeof ResponseCtor === 'function' ? { Response: ResponseCtor } : {}),
    ...(typeof HeadersCtor === 'function' ? { Headers: HeadersCtor } : {}),
    ...(scheduler ? { scheduler } : {}),
    ...(performance !== undefined ? { performance } : { performance: { now: () => 0 } }),
    Date: now ? class extends Date { static now() { return now() } } : Date,
    window: { addEventListener(name, fn) { listeners.set(name, fn) } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, setInterval() {},
    requestAnimationFrame(fn) { const id = ++nextTimer; frames.set(id, fn); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    MutationObserver: class { observe() {}; disconnect() {} },
    localStorage: {
      getItem(key) { if (blocked) throw Error('Blocked'); return storage.get(key) || null },
      setItem(key, value) { if (blocked) throw Error('Blocked'); storage.set(key, value) },
    },
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'TwitchLiveChatTweaks.user.js'), 'utf8')
  if (withResizeObserver) context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this) }
    observe(target) { this.targets.add(target) }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    notify() { this.callback([...this.targets].map(target => ({ target }))) }
  }
  vm.createContext(context)
  vm.runInContext(source.replace(/\}\)\(\)\s*$/, `globalThis.api = {
    normalizeUsers, getChannel, getHistory, loadSettings, saveSettings, readMessage,
    matchesFilter, captureLine, captureTree, captureMutations, renderMessages, changeTargetUsers, showTargetStatus,
    scheduleMessageRender, releaseMessageViews, handleMessageVisibility,
    archiveTree, restoreTree, archiveRecord, restoreRecord, flushHistory, pruneHistories, pruneArchive,
    fetchVodStartTime, ensureVodStartTime, syncHistoryTimes,
    fixVodEmoteOffsets, installVodEmoteFetchFix,
    setPanelLayer, positionFilterPanel, createPanel, setEnabled, refresh, unmount, releaseMessageViews,
    get mounted() { return mounted },
    setMounted: state => { mounted = state }
  }; })()`), context)
  const message = (user, text, role = '', id = '') => {
    const line = new Element()
    line.setAttribute('data-a-target', 'chat-line-message')
    if (id) line.setAttribute('data-id', id)
    const authorContainer = line.appendChild(new Element())
    authorContainer.className = 'chat-line__username-container'
    if (role) {
      const badge = authorContainer.appendChild(new Element('img'))
      badge.className = 'chat-badge'
      badge.setAttribute('alt', role)
      if (role === 'localized-mod') badge.setAttribute('src',
        'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1')
      if (role === 'localized-vip') badge.setAttribute('src',
        'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1')
    }
    const author = authorContainer.appendChild(new Element('span'))
    author.setAttribute('data-a-target', 'chat-message-username')
    author.setAttribute('data-a-user', user)
    author.textContent = '顯示名稱'
    author.style.color = 'red'
    const body = line.appendChild(new Element('span'))
    body.setAttribute('data-a-target', 'chat-line-message-body')
    body.innerHTML = text
    body.textContent = text
    return { line, body, authorContainer }
  }
  return { api: context.api, message, Element, storage, timers, frames, observers, document, window: context.window, location: context.location, listeners,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() } }
}

require('./helpers/chat-update-cases.cjs')({ test, assert, boot, site: 'Twitch' })
const fakeIndexedDB = require('./helpers/indexeddb.cjs')

test('Twitch archive: persist emotes, badges, links and colors for seven days and merge live startup messages by ID', async () => {
  const database = fakeIndexedDB()
  let now = Date.now()
  const first = boot({ database, now: () => now })
  const history = first.api.getHistory('sample_channel')
  await history.restorePromise
  const mod = first.message('mod_account', 'hello', 'moderator', 'uuid-1')
  const button = mod.body.appendChild(new first.Element('button'))
  button.className = 'native-emote'
  button.setAttribute('data-react-hook', 'unused')
  const picture = button.appendChild(new first.Element('picture'))
  picture.style.position = 'relative'
  const source = picture.appendChild(new first.Element('source'))
  source.setAttribute('type', 'image/avif')
  source.setAttribute('srcset', 'https://cdn.7tv.app/emote/demo/1x.avif 1x, https://cdn.7tv.app/emote/demo/2x.avif 2x')
  const emote = picture.appendChild(new first.Element('img'))
  emote.className = 'chat-image'
  emote.setAttribute('src', 'https://example.com/emote.webp')
  emote.setAttribute('alt', 'Kappa')
  emote.style.width = '28px'
  const link = mod.body.appendChild(new first.Element('a'))
  link.setAttribute('href', 'https://example.com/page')
  link.textContent = '連結'
  first.api.captureLine(mod.line, history)
  first.api.captureLine(first.message('other_mod', 'retained on reload', 'moderator', 'uuid-2').line, history)
  await first.api.flushHistory(history)
  assert.equal(database.records.size, 2)
  const expiry = [...database.records.values()][0].expiresAt
  now += 1000
  const fresh = boot({ database, now: () => now })
  const restored = fresh.api.getHistory('sample_channel')
  fresh.api.captureLine(fresh.message('other_mod', 'new startup body', 'moderator', 'uuid-2').line, restored)
  await restored.restorePromise
  assert.equal(restored.messages.length, 2)
  assert.equal(restored.ids.get('uuid-2').view.children.at(-1).textContent, 'new startup body')
  const row = restored.ids.get('uuid-1').view
  assert.equal(row.querySelector('button'), null, 'restored presentation must contain no native controls')
  assert.equal(row.querySelector('img.chat-badge').getAttribute('alt'), 'moderator')
  assert.equal(row.querySelector('strong').style.color, 'red')
  assert.equal(row.querySelector('picture').style.position, 'relative')
  assert.equal(row.querySelector('source').getAttribute('srcset'), source.getAttribute('srcset'))
  const image = row.querySelector('.chat-image')
  assert.equal(image.getAttribute('src'), 'https://example.com/emote.webp')
  assert.equal(image.getAttribute('alt'), 'Kappa')
  assert.equal(image.style.width, '28px')
  assert.equal(row.querySelector('a').rel, 'noopener noreferrer')
  assert.equal(JSON.stringify([...database.records.values()]).includes('data-react-hook'), false)
  assert.equal(restored.ids.get('uuid-1').createdAt + 7 * 86400000, expiry)
  await fresh.api.flushHistory(restored)
  const restoredAgain = boot({ database, now: () => now }).api.getHistory('sample_channel')
  await restoredAgain.restorePromise
  assert.equal(restoredAgain.messages.length, 2)
})

test('Twitch archive: edits and DOM rebuilds do not renew expiry, and records expire at seven days', async () => {
  const database = fakeIndexedDB()
  let now = Date.now()
  const start = now
  const env = boot({ database, now: () => now })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  env.api.captureLine(env.message('mod', 'hello', 'moderator', 'uuid-edit').line, history)
  await env.api.flushHistory(history)
  now += 86400000
  assert.equal(env.api.captureLine(env.message('mod', 'hello', 'moderator', 'uuid-edit').line, history), false)
  env.api.captureLine(env.message('mod', 'edited', 'moderator', 'uuid-edit').line, history)
  await env.api.flushHistory(history)
  assert.equal(history.messages.length, 1)
  assert.equal([...database.records.values()][0].expiresAt, start + 7 * 86400000)
  now = start + 7 * 86400000
  env.api.pruneHistories()
  await env.api.pruneArchive()
  assert.equal(history.messages.length, 0)
  assert.equal(history.ids.size, 0)
  assert.equal(database.records.size, 0)
})

test('Twitch archive: isolate channels, merge concurrent writers, and restore all messages directly without a count cap', async () => {
  const database = fakeIndexedDB()
  const a = boot({ database })
  const b = boot({ database })
  const h1 = a.api.getHistory('sample_channel')
  const h2 = b.api.getHistory('sample_channel')
  const other = a.api.getHistory('another_channel')
  await Promise.all([h1.restorePromise, h2.restorePromise, other.restorePromise])
  for (let i = 0; i < 1002; i++) a.api.captureLine(a.message('mod', `old ${i}`, 'moderator', `msg-${i}`).line, h1)
  b.api.captureLine(b.message('mod', 'another tab', 'moderator', 'another-tab').line, h2)
  a.api.captureLine(a.message('mod', 'another channel', 'moderator', 'another-channel').line, other)
  assert.equal(h1.messages.length, 1002)
  assert.equal(h1.ids.has('msg-0'), true)
  assert.equal(h1.ids.has('msg-1'), true)
  assert.equal(h1.ids.has('msg-1001'), true)
  await Promise.all([a.api.flushHistory(h1), b.api.flushHistory(h2), a.api.flushHistory(other)])
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'msg-0'])), true)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'msg-1'])), true)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'another-tab'])), true)
  assert.equal(database.records.has(JSON.stringify(['another_channel', 'another-channel'])), true)
  const fresh = boot({ database })
  const restored = fresh.api.getHistory('sample_channel')
  await restored.restorePromise
  assert.equal(restored.messages.length, 1003)
  assert.equal(restored.older, undefined)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'msg-0'])), true)
  const state = { history: restored, list: new fresh.Element(), empty: {}, count: {}, latest: {} }
  fresh.api.renderMessages(state)
  assert.equal(state.count.textContent, '1003 則')
  assert.equal(state.list.children[0].children.at(-1).textContent, 'old 0')
  assert.equal(restored.ids.has('another-channel'), false)
})

test('Twitch archive: unsafe saved markup stays inert and a disk failure preserves the live page', async () => {
  const database = fakeIndexedDB()
  const env = boot({ database })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  const tree = { tag: 'div', children: [{ tag: 'button', attributes: [['onclick', 'bad()'], ['tabindex', '0']], children: [
    { tag: 'img', attributes: [['src', 'javascript:bad()'], ['onerror', 'bad()']] },
    { tag: 'source', attributes: [['srcset', 'javascript:bad() 1x, https://example.com/safe.avif 2x']] },
  ] }, { tag: 'a', attributes: [['href', 'javascript:bad()']], styles: [['position', 'fixed']] }] }
  const restored = env.api.restoreTree(tree)
  assert.equal(restored.querySelector('button'), null)
  assert.equal(restored.querySelector('img').getAttribute('src'), null)
  assert.equal(restored.querySelector('source').getAttribute('srcset'), 'https://example.com/safe.avif 2x')
  assert.equal(restored.querySelector('a').getAttribute('href'), null)
  assert.equal(restored.querySelector('a').style.position, undefined)
  database.failWrites = true
  env.api.captureLine(env.message('mod', 'keep this in the page', 'moderator', 'write-fails').line, history)
  await env.api.flushHistory(history)
  assert.equal(history.archiveError, true)
  assert.equal(history.messages.length, 1)
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '1 則')
})

test('Twitch target status: replacing a notice restarts its three-second lifetime', () => {
  const { api, Element, timers } = boot()
  const state = { status: new Element('p') }
  api.showTargetStatus(state, '已新增帳號。')
  const first = state.statusTimer
  assert.equal(timers.get(first).delay, 3000)
  api.showTargetStatus(state, '已移除帳號。')
  assert.equal(timers.has(first), false)
  assert.equal(state.status.textContent, '已移除帳號。')
  timers.get(state.statusTimer).fn()
  assert.equal(state.status.textContent, '')
  assert.equal(state.statusTimer, 0)
})

test('Twitch filter layer: stay in the browser top layer through resize and release on disable', () => {
  const { api, Element } = boot()
  const panel = new Element()
  let opened = 0, closed = 0
  panel.showPopover = () => { opened++ }
  panel.hidePopover = () => { closed++ }
  const host = new Element()
  host.getBoundingClientRect = () => ({ left: 600, top: 80, width: 400, height: 500 })
  const state = { panel, host }
  api.setPanelLayer(state, true)
  assert.equal(opened, 1)
  assert.equal(panel.getAttribute('popover'), 'manual')
  assert.equal(panel.style.width, '400px')
  host.getBoundingClientRect = () => ({ left: 650, top: 100, width: 350, height: 450 })
  api.positionFilterPanel(state)
  assert.equal(panel.style.left, '650px')
  assert.equal(panel.style.height, '450px')
  api.setPanelLayer(state, false)
  assert.equal(closed, 1)
  assert.equal(panel.style.position, '')
  assert.equal(panel.getAttribute('popover'), null)
})

test('Twitch chat: normalize login names and tolerate corrupt/unavailable storage', () => {
  const env = boot({ saved: 'broken JSON' })
  assert.equal(Array.from(env.api.normalizeUsers('@Foo, BAR，foo\n中文 invalid-name')).join(','), 'foo,bar')
  assert.equal(env.api.loadSettings('sample_channel').moderators, true)
  const blocked = boot({ blocked: true })
  assert.equal(blocked.api.saveSettings(blocked.api.getHistory('sample_channel')), false)
})

test('Twitch chat: badge identity, broadcaster login and specified login match independently', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  history.settings.users = ['chosen']
  for (const [name, badge] of [['MOD_NAME', 'localized-mod'], ['sample_channel', ''], ['vip_name', 'localized-vip'], ['chosen', '']]) {
    assert.equal(env.api.captureLine(env.message(name, 'hello', badge).line, history), true)
  }
  assert.equal(env.api.captureLine(env.message('ordinary', 'ignored').line, history), false)
  assert.equal(history.messages.length, 4)
  assert.equal(env.api.matchesFilter(history.messages[0], { moderators: false, broadcaster: false, vip: false, users: [] }), false)
  assert.equal(env.api.matchesFilter(history.messages[1], { moderators: false, broadcaster: true, vip: false, users: [] }), true)
  assert.equal(env.api.matchesFilter(history.messages[2], { moderators: false, broadcaster: false, vip: true, users: [] }), true)
  assert.equal(env.api.matchesFilter(history.messages[2], { moderators: true, broadcaster: true, vip: false, users: [] }), false)
  assert.equal(env.api.matchesFilter(history.messages[3], { moderators: false, broadcaster: false, vip: false, users: ['chosen'] }), true)
})

test('Twitch VIP users: recognize badge alt, asset UUID and srcset, skip unchecked/excluded capture, and respect exclusions', async () => {
  const database = fakeIndexedDB()
  const env = boot({ database })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  history.settings.vip = false
  assert.equal(env.api.captureLine(env.message('vip_skipped', 'while off', 'VIP', 'vip-off').line, history), false,
    'unchecked VIP messages are not captured')
  history.settings.vip = true
  const variants = [
    env.message('vip_alt', 'by alt', 'VIP', 'vip-1'),
    env.message('vip_tw', 'by zh-TW alt', 'VIP 徽章', 'vip-2'),
    env.message('vip_src', 'by src', 'localized-vip', 'vip-3'),
    (() => {
      const msg = env.message('vip_srcset', 'by srcset', '', 'vip-4')
      const badge = msg.authorContainer.appendChild(new env.Element('img'))
      badge.className = 'chat-badge'
      badge.setAttribute('alt', 'Custom VIP Label')
      badge.setAttribute('srcset', 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1 1x')
      return msg
    })(),
  ]
  for (const msg of variants) {
    assert.equal(env.api.captureLine(msg.line, history), true)
  }
  assert.equal(env.api.captureLine(env.message('sub_vip_tier', 'ordinary sub', 'VIP Subscriber').line, history), false)
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '4 則')
  history.settings.vip = false
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '0 則')
  history.settings.vip = true
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '4 則')
  history.settings.excludedUsers = ['vip_alt', 'vip_tw']
  assert.equal(env.api.captureLine(env.message('vip_alt', 'excluded new', 'VIP', 'vip-excluded').line, history), false,
    'excluded users are not captured into history')
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '2 則')
  await env.api.flushHistory(history)
  const fresh = boot({ database })
  const restored = fresh.api.getHistory('sample_channel')
  await restored.restorePromise
  assert.equal(restored.messages.length, 4)
  assert.equal(restored.ids.get('vip-3').vip, true)
  const restoredState = { history: restored, list: new fresh.Element(), empty: {}, count: {}, latest: {} }
  restored.settings.vip = false
  fresh.api.renderMessages(restoredState)
  assert.equal(restoredState.count.textContent, '0 則')
  restored.settings.vip = true
  fresh.api.renderMessages(restoredState)
  assert.equal(restoredState.count.textContent, '4 則')
})

test('Twitch VIP users: update retained VIP status when badges appear or disappear', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  const msg = env.message('alice', 'hello', '', 'vip-mutation-1')
  assert.equal(env.api.captureLine(msg.line, history), false)
  const badge = msg.authorContainer.appendChild(new env.Element('img'))
  badge.className = 'chat-badge'
  badge.setAttribute('alt', 'VIP')
  assert.equal(env.api.captureMutations([{ target: msg.authorContainer, addedNodes: [badge] }], history), true)
  const record = history.messages[0]
  const time = record.view.firstChild.textContent
  assert.equal(record.vip, true)
  badge.remove()
  assert.equal(env.api.captureMutations([{ target: msg.authorContainer, addedNodes: [] }], history), true)
  assert.equal(history.messages.length, 1)
  assert.equal(record.vip, false)
  assert.equal(record.view.firstChild.textContent, time)
  assert.equal(env.api.matchesFilter(record, history.settings), false)
  history.settings.users = ['alice']
  assert.equal(env.api.matchesFilter(record, history.settings), true)
})

test('Twitch chat: quoted badges do not grant the author moderator or VIP status', () => {
  const env = boot()
  const { line } = env.message('ordinary', 'reply')
  const quoteMod = line.appendChild(new env.Element('img'))
  quoteMod.className = 'chat-badge'
  quoteMod.setAttribute('alt', 'Moderator')
  const quoteVip = line.appendChild(new env.Element('img'))
  quoteVip.className = 'chat-badge'
  quoteVip.setAttribute('alt', 'VIP')
  quoteVip.setAttribute('src', 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1')
  const parsed = env.api.readMessage(line, 'sample_channel')
  assert.equal(parsed.moderator, false)
  assert.equal(parsed.vip, false)
})

test('Twitch chat: preserve pruned native messages, deduplicate mutations, retain repeated sends', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  const root = new env.Element()
  const first = env.message('mod', 'same text', '管理員')
  root.appendChild(first.line)
  assert.equal(env.api.captureTree(root, history), true)
  assert.equal(env.api.captureTree(root, history), false)
  first.line.remove()
  env.api.captureLine(env.message('mod', 'same text', '管理員').line, history)
  assert.equal(history.messages.length, 2)
  assert.equal(history.messages[0].view.children.at(-1).innerHTML, 'same text')
})

test('Twitch chat: reflect native message changes without retaining live source nodes', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  const { line, body } = env.message('mod', 'original', 'Moderator')
  env.api.captureLine(line, history)
  body.innerHTML = '訊息已刪除'
  env.api.captureLine(line, history)
  assert.equal(history.messages.length, 1)
  assert.equal(history.messages[0].view.children.at(-1).innerHTML, '訊息已刪除')
  assert.equal('body' in history.messages[0], false)
  assert.equal('author' in history.messages[0], false)
})

test('Twitch chat: clone emotes, remove inactive hooks and preserve safe link behavior', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  const { line, body } = env.message('mod', 'Kappa', 'Moderator')
  const img = body.appendChild(new env.Element('img'))
  img.setAttribute('src', 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0')
  img.setAttribute('alt', 'Kappa')
  img.setAttribute('onclick', 'doSomething()')
  img.setAttribute('id', 'native-emote')
  const link = body.appendChild(new env.Element('a'))
  link.setAttribute('href', 'https://www.twitch.tv/')
  env.api.captureLine(line, history)
  const copiedBody = history.messages[0].view.children.at(-1)
  assert.equal(copiedBody.children[0].getAttribute('alt'), 'Kappa')
  assert.equal(copiedBody.children[0].getAttribute('onclick'), null)
  assert.equal(copiedBody.children[0].getAttribute('id'), null)
  assert.equal(copiedBody.children[1].rel, 'noopener noreferrer')
  assert.equal(copiedBody.getAttribute('data-a-target'), null)
})

test('Twitch chat: global settings survive reload across channels when archive storage is unavailable', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  history.settings.users = ['chosen']
  env.api.captureLine(env.message('chosen', 'hello').line, history)
  assert.equal(env.api.saveSettings(history), true)
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.getHistory('sample_channel').settings.users[0], 'chosen')
  assert.equal(fresh.api.getHistory('sample_channel').messages.length, 0)
  assert.equal(fresh.api.getHistory('other_channel').settings.users[0], 'chosen')
  env.location.pathname = '/popout/sample_channel/chat'
  assert.equal(env.api.getChannel(), 'sample_channel')
  env.location.pathname = '/videos/2345678901'
  assert.equal(env.api.getChannel(), 'vod:2345678901')
  env.location.pathname = '/videos'
  assert.equal(env.api.getChannel(), '')
  env.location.pathname = '/directory'
  assert.equal(env.api.getChannel(), '')
})

test('Twitch chat: retain >2000 messages without count cap and keep paused reader position', async () => {
  const database = fakeIndexedDB()
  const env = boot({ database })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  for (let i = 0; i < 2005; i++) {
    env.api.captureLine(env.message('mod', String(i), 'Moderator', `id-${i}`).line, history)
    if (i === 1000) await env.api.flushHistory(history)
  }
  await env.api.flushHistory(history)
  assert.equal(history.messages.length, 2005)
  assert.equal(history.messages[0].view.children.at(-1).innerHTML, '0')
  assert.equal(database.records.size, 2005)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'id-0'])), true)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'id-2004'])), true)
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  state.list.scrollTop = 123
  state.list.scrollHeight = 9999
  history.follow = false
  env.api.renderMessages(state)
  assert.equal(state.list.scrollTop, 123)
  assert.equal(state.count.textContent, '2005 則')
  assert.equal(state.latest.hidden, false)
  history.follow = true
  env.api.renderMessages(state)
  assert.equal(state.list.scrollTop, 9999)
})

test('Twitch targets: accept one login, reject multiple logins, remove only the selected account', () => {
  const env = boot()
  const initial = { moderators: false, broadcaster: true, vip: true, users: ['alice'], excludedUsers: [] }
  const duplicate = env.api.changeTargetUsers(initial, ' @ALICE ')
  assert.equal(duplicate.users.join(','), 'alice')
  const withBob = env.api.changeTargetUsers(initial, '@Bob')
  const added = env.api.changeTargetUsers(withBob, 'carol')
  assert.equal(added.users.join(','), 'alice,bob,carol')
  assert.equal(initial.users.join(','), 'alice')
  assert.equal(added.moderators, false)
  assert.equal(env.api.changeTargetUsers(added, 'valid 中文'), null)
  for (const input of ['dave eve', 'dave,eve', 'dave，eve', 'dave\neve']) {
    assert.equal(env.api.changeTargetUsers(added, input), null)
  }
  assert.equal(env.api.changeTargetUsers(added, ''), null)
  const removed = env.api.changeTargetUsers(added, '@BOB', true)
  assert.equal(removed.users.join(','), 'alice,carol')
  env.api.saveSettings({ channel: 'sample_channel', settings: removed })
  assert.equal(env.api.loadSettings('sample_channel').users.join(','), 'alice,carol')
  assert.equal(env.api.loadSettings('other_channel').users.join(','), 'alice,carol')
})

test('Twitch targets: remote edits update mounted filters and start capturing the newly added account', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  history.enabled = true
  const panel = new env.Element()
  for (const name of ['moderators', 'broadcaster', 'vip', 'users']) {
    const input = panel.appendChild(new env.Element('input'))
    input.setAttribute('name', name)
  }
  const search = panel.appendChild(new env.Element('input'))
  search.setAttribute('name', 'search-users')
  for (const className of ['ttc-mode-include', 'ttc-mode-exclude', 'ttc-target-list', 'ttc-target-empty']) {
    panel.appendChild(Object.assign(new env.Element(), { className }))
  }
  const scroller = new env.Element()
  scroller.appendChild(env.message('alice', 'previously visible message').line)
  const state = { history, panel, scroller, list: new env.Element(), empty: {}, count: {}, latest: {} }
  env.api.setMounted(state)
  env.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({
    sample_channel: { moderators: false, broadcaster: false, vip: false, users: ['alice'] },
  }))
  env.listeners.get('storage')({ key: 'unrelated-setting' })
  assert.equal(history.messages.length, 0)
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(history.messages.length, 1)
  assert.equal(panel.querySelector('[name="vip"]').checked, false)
  assert.equal(panel.querySelector('.ttc-target-list').children[0].children[0].textContent, 'alice')
  assert.equal(state.count.textContent, '1 則')
  env.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({
    sample_channel: { moderators: false, broadcaster: false, vip: true, users: [] },
  }))
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(panel.querySelector('[name="vip"]').checked, true)
  assert.equal(history.settings.vip, true)
  assert.equal(state.count.textContent, '0 則')
  assert.equal(env.api.captureLine(env.message('alice', 'no longer tracked').line, history), false)
})

test('Twitch exclusions: override both roles and explicit inclusion, and restore retained history when removed', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  history.settings.users = ['alice']
  for (const [user, badge] of [['mod_bot', 'Moderator'], ['sample_channel', ''], ['alice', '']]) {
    env.api.captureLine(env.message(user, user, badge).line, history)
    history.settings = env.api.changeTargetUsers(history.settings, user, false, true)
  }
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  env.api.renderMessages(state)
  assert.equal(history.messages.length, 3)
  assert.equal(state.count.textContent, '0 則')
  history.settings = env.api.changeTargetUsers(history.settings, 'mod_bot', true, true)
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '1 則')
  assert.equal(history.settings.users.join(','), 'alice')
  assert.equal(history.settings.excludedUsers.join(','), 'sample_channel,alice')
})

test('Twitch exclusions: preserve legacy targets and save normalized exclusions globally', () => {
  const env = boot({ saved: JSON.stringify({ sample_channel: { users: ['alice'] } }) })
  const history = env.api.getHistory('sample_channel')
  assert.equal(history.settings.vip, true)
  assert.equal(history.settings.users.join(','), 'alice')
  assert.equal(history.settings.excludedUsers.length, 0)
  history.settings.vip = false
  history.settings = env.api.changeTargetUsers(history.settings, ' @MOD_BOT ', false, true)
  assert.equal(env.api.changeTargetUsers(history.settings, 'a,b', false, true), null)
  env.api.saveSettings(history)
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.loadSettings('sample_channel').vip, false)
  assert.equal(fresh.api.loadSettings('other_channel').vip, false)
  assert.equal(fresh.api.loadSettings('sample_channel').excludedUsers.join(','), 'mod_bot')
  assert.equal(fresh.api.loadSettings('sample_channel').users.join(','), 'alice')
  assert.equal(fresh.api.loadSettings('other_channel').excludedUsers.join(','), 'mod_bot')
})


test('Twitch scopes: migrate legacy channel and @global lists into single global settings', () => {
  const env = boot({ saved: JSON.stringify({
    '@global': { users: ['g_user'], excludedUsers: ['g_bad'] },
    sample_channel: { users: ['chosen'], moderators: false },
    other_channel: { users: ['chosen', 'extra'], excludedUsers: ['c_bad'] },
  }) })
  const first = env.api.getHistory('sample_channel')
  const second = env.api.getHistory('other_channel')
  assert.equal(first.settings.users.join(','), 'g_user,chosen,extra')
  assert.equal(second.settings.users.join(','), 'g_user,chosen,extra')
  assert.equal(first.settings.excludedUsers.join(','), 'g_bad,c_bad')
  assert.equal(first.settings.moderators, false)
  assert.equal(env.api.saveSettings(first), true)
  const saved = JSON.parse(env.storage.get('twitch-live-chat-tweaks-settings-v1'))
  assert.equal(saved['@global'], undefined)
  assert.equal(saved.sample_channel, undefined)
  assert.equal(saved.users.join(','), 'g_user,chosen,extra')
  assert.equal(saved.excludedUsers.join(','), 'g_bad,c_bad')
  assert.equal(saved.moderators, false)
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.loadSettings('other_channel').users.join(','), 'g_user,chosen,extra')
  assert.equal(fresh.api.loadSettings('other_channel').moderators, false)
})

test('Twitch scopes: capture global targets in every channel and let exclusions override includes and roles', () => {
  const env = boot()
  const first = env.api.getHistory('sample_channel')
  const second = env.api.getHistory('other_channel')
  first.settings = env.api.changeTargetUsers(first.settings, 'chosen', false, false)
  env.api.saveSettings(first)
  const a = env.message('chosen', 'global in first')
  const b = env.message('chosen', 'global in second')
  assert.equal(env.api.captureLine(a.line, first), true)
  assert.equal(env.api.captureLine(b.line, second), true)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), true)
  second.settings = env.api.changeTargetUsers(second.settings, 'chosen', false, true)
  env.api.saveSettings(second)
  assert.equal(env.api.matchesFilter(first.messages[0], first.settings), false)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), false)
  assert.equal(env.api.matchesFilter({ user: 'chosen', moderator: true, broadcaster: true }, first.settings), false)
  assert.equal(first.messages.length, 1)
})

test('Twitch scopes: sync global edits across stored histories and keep settings for the page when storage is blocked', () => {
  const env = boot()
  const first = env.api.getHistory('sample_channel')
  const second = env.api.getHistory('other_channel')
  env.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({ users: ['chosen'], excludedUsers: ['bad'] }))
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(first.settings.users.join(','), 'chosen')
  assert.equal(second.settings.excludedUsers.join(','), 'bad')
  env.storage.delete('twitch-live-chat-tweaks-settings-v1')
  env.listeners.get('storage')({ key: null })
  assert.equal(first.settings.users.length, 0)
  assert.equal(second.settings.excludedUsers.length, 0)
  const blocked = boot({ blocked: true })
  const history = blocked.api.getHistory('sample_channel')
  history.settings = blocked.api.changeTargetUsers(history.settings, 'chosen', false, false)
  assert.equal(blocked.api.saveSettings(history), false)
  assert.equal(blocked.api.getHistory('other_channel').settings.users.join(','), 'chosen')
})

test('Twitch panel: VIP role checkbox defaults to checked, toggles filtering and persists globally without scope or pagination UI', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  const scroller = new env.Element()
  scroller.appendChild(env.message('vip_guest', 'vip hello', 'VIP', 'vip-panel-1').line)
  const state = { history, host: new env.Element(), scroller, button: new env.Element('button') }
  env.api.createPanel(state)
  assert.equal(state.panel.querySelector('[name="target-scope"]'), null)
  assert.equal(state.panel.querySelector('.ttc-older'), null)
  env.api.setMounted(state)
  env.api.captureTree(scroller, history)
  env.api.setEnabled(state, false)
  assert.equal(state.button.getAttribute('title'), null)
  assert.equal(state.button.getAttribute('aria-describedby'), state.tooltip.id)
  assert.equal(state.tooltip.textContent, '聊天室篩選')
  env.api.setEnabled(state, true)
  assert.equal(state.button.getAttribute('title'), null)
  assert.equal(state.button.getAttribute('aria-describedby'), null)
  assert.equal(state.tooltip.getAttribute('data-visible'), 'false')
  const vipCheckbox = state.panel.querySelector('[name="vip"]')
  assert.equal(vipCheckbox.checked, true)
  assert.equal(state.count.textContent, '1 則')
  vipCheckbox.checked = false
  vipCheckbox.listeners.get('change')()
  assert.equal(history.settings.vip, false)
  assert.equal(state.count.textContent, '0 則')
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.loadSettings('sample_channel').vip, false)
  assert.equal(fresh.api.loadSettings('other_channel').vip, false)
  vipCheckbox.checked = true
  vipCheckbox.listeners.get('change')()
  assert.equal(history.settings.vip, true)
  assert.equal(state.count.textContent, '1 則')
})

test('Twitch panel: mount and render without innerHTML when Trusted Types rejects HTML strings', () => {
  const env = boot({ trustedTypes: true })
  const stream = env.document.body.appendChild(env.document.createElement('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(env.document.createElement('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(env.document.createElement('div'))
  const scroller = host.appendChild(env.document.createElement('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  assert.ok(state)
  assert.ok(state.button.querySelector('svg'))
  assert.ok(state.panel.querySelector('.ttc-list'))
  assert.equal(state.panel.querySelector('.ttc-targets').hidden, true)
  env.api.setEnabled(state, true)
  assert.equal(state.panel.hidden, false)
  env.api.unmount()
})

test('Twitch archive: preserve data image srcsets, drop blank/unsafe candidates and flush evicted LRU channels', async () => {
  const database = fakeIndexedDB()
  const env = boot({ database })
  const img = env.api.restoreTree({
    tag: 'img',
    attributes: [
      ['srcset', 'data:image/png;base64,iVBORw0K 1x, data:image/webp;base64,UklGRg== 2x, data:text/html,<script>alert(1)</script> 3x'],
    ],
  })
  assert.equal(img.getAttribute('srcset'), 'data:image/png;base64,iVBORw0K 1x, data:image/webp;base64,UklGRg== 2x')

  const blank = env.api.restoreTree({ tag: 'img', attributes: [['src', '   ']] })
  assert.equal(blank.getAttribute('src'), null)

  const h1 = env.api.getHistory('lru_one')
  await h1.restorePromise
  env.api.captureLine(env.message('mod', 'evicted flush check', 'moderator', 'twitch-lru-1').line, h1)
  for (let i = 2; i <= 6; i++) env.api.getHistory(`lru_${i}`)
  await new Promise(resolve => setTimeout(resolve, 20))

  const reloaded = boot({ database })
  const restored = reloaded.api.getHistory('lru_one')
  await restored.restorePromise
  assert.ok(restored.ids.has('twitch-lru-1'))
})

test('Twitch following: late emote resize, load and visibility keep live bottom without overriding manual pause', () => {
  const env = boot({ withResizeObserver: true })
  const stream = env.document.body.appendChild(env.document.createElement('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(env.document.createElement('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(env.document.createElement('div'))
  const scroller = host.appendChild(env.document.createElement('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')
  env.api.refresh()
  const state = env.api.mounted
  state.list.clientHeight = 300
  state.list.scrollHeight = 500
  env.api.captureLine(env.message('mod', 'emote line', 'moderator', 'twitch-follow-1').line, state.history)
  env.api.setEnabled(state, true)
  assert.equal(state.list.scrollTop, 500)

  state.list.scrollHeight = 640
  env.observers[0].notify()
  env.flushFrames()
  assert.equal(state.list.scrollTop, 640)

  state.list.scrollHeight = 720
  state.list.listeners.get('load')()
  env.flushFrames()
  assert.equal(state.list.scrollTop, 720)

  state.list.listeners.get('wheel')()
  state.list.scrollTop = 120
  state.list.listeners.get('scroll')()
  assert.equal(state.history.follow, false)
  assert.equal(state.latest.hidden, false)

  state.list.scrollHeight = 900
  env.observers[0].notify()
  state.list.listeners.get('load')()
  env.document.listeners.get('visibilitychange')()
  env.flushFrames()
  assert.equal(state.list.scrollTop, 120)

  state.latest.listeners.get('click')()
  assert.equal(state.history.follow, true)
  assert.equal(state.list.scrollTop, 900)
  assert.equal(state.latest.hidden, true)
  env.api.unmount()
})

test('Twitch accessibility, visibilitychange merge, and restoreHistory 50ms scheduler/timer yield', async () => {
  const database = fakeIndexedDB()
  let nowTime = 1_000_000
  const seed = boot({ database, now: () => nowTime })
  const seedHistory = seed.api.getHistory('sample_channel')
  await seedHistory.restorePromise
  for (let i = 0; i < 4; i++) {
    seed.api.captureLine(seed.message('mod_a', `line-${i}`, 'moderator', `t-${i}`).line, seedHistory)
  }
  await seed.api.flushHistory(seedHistory)

  // Scheduler.yield branch + panel markup & single visibilitychange handler
  let nowA = 0
  let yields = 0
  const envA = boot({
    database,
    now: () => nowTime,
    performance: { now: () => (nowA += 30) },
    scheduler: { yield: async () => { yields++ } },
  })
  assert.equal(envA.document.listenerCounts.get('visibilitychange'), 1)

  const stream = envA.document.body.appendChild(new envA.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new envA.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new envA.Element('div'))
  const scroller = host.appendChild(new envA.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')
  envA.api.refresh()
  const state = envA.api.mounted
  const panel = state.panel

  for (const [labelText, inputId] of [
    ['Broadcaster', 'ttc-role-broadcaster'],
    ['Moderator', 'ttc-role-moderators'],
    ['VIP', 'ttc-role-vip'],
    ['回覆篩選目標', 'ttc-role-replies'],
    ['新增帳號', 'ttc-input-users'],
    ['搜尋帳號', 'ttc-input-search-users'],
    ['搜尋聊天紀錄', 'ttc-input-search-messages'],
  ]) {
    const label = panel.querySelectorAll('label').find(node => node.textContent === labelText)
    assert.ok(label, `missing label ${labelText}`)
    assert.equal(label.getAttribute('for'), inputId)
    assert.equal(panel.querySelector(`#${inputId}`)?.tagName, 'input')
  }
  assert.equal(panel.querySelectorAll('search').length, 2)
  for (const name of ['users', 'search-users', 'search-messages']) {
    const input = panel.querySelector(`[name="${name}"]`)
    assert.equal(input.getAttribute('autocorrect'), 'off')
    assert.equal(input.getAttribute('autocapitalize'), 'none')
  }
  assert.equal(panel.querySelector('.ttc-mode-include').getAttribute('aria-label'), null)
  assert.equal(panel.querySelector('.ttc-mode-exclude').getAttribute('aria-label'), null)
  const statusEl = panel.querySelector('.ttc-history-status')
  assert.equal(statusEl.getAttribute('role'), null)

  await state.history.restorePromise
  assert.ok(yields > 0, 'Twitch restoreHistory should yield via scheduler.yield past 50ms')
  assert.equal(state.history.messages.length, 4)

  // Single visibilitychange handler both prunes expired history and updates panel messages
  envA.api.setEnabled(state, true)
  envA.flushFrames()
  nowTime += 7 * 24 * 60 * 60 * 1000 + 1000
  envA.document.hidden = false
  envA.document.listeners.get('visibilitychange')()
  assert.equal(state.history.messages.length, 0)

  // setTimeout(0) fallback branch when scheduler is absent + error-only role="status"
  const envB = boot({
    database,
    now: () => 1_000_000,
    performance: { now: () => (nowA += 30) },
  })
  const stB = envB.document.body.appendChild(new envB.Element('div'))
  stB.className = 'stream-chat'
  const hB = stB.appendChild(new envB.Element('div'))
  hB.className = 'stream-chat-header'
  const hostB = stB.appendChild(new envB.Element('div'))
  const scB = hostB.appendChild(new envB.Element('div'))
  scB.setAttribute('data-a-target', 'chat-scroller')
  // Seed fresh non-expired messages for envB
  const seedB = boot({ database, now: () => 1_000_000 })
  const shB = seedB.api.getHistory('sample_channel')
  await shB.restorePromise
  for (let i = 0; i < 4; i++) {
    seedB.api.captureLine(seedB.message('mod_a', `b-${i}`, 'moderator', `tb-${i}`).line, shB)
  }
  await seedB.api.flushHistory(shB)

  envB.api.refresh()
  let fallbackTimers = 0
  for (let step = 0; step < 20; step++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    const zeroTimers = [...envB.timers.entries()].filter(([, timer]) => timer.delay === 0)
    if (!zeroTimers.length) {
      if (fallbackTimers > 0) break
      continue
    }
    for (const [id, timer] of zeroTimers) {
      envB.timers.delete(id)
      fallbackTimers++
      timer.fn()
    }
  }
  await envB.api.mounted.history.restorePromise
  assert.ok(fallbackTimers > 0, 'Twitch restoreHistory should fall back to setTimeout(0)')
  assert.equal(envB.api.mounted.history.messages.length, 4)

  const envErr = boot({ database: { open() { throw new Error('IDB blocked') } } })
  const stErr = envErr.document.body.appendChild(new envErr.Element('div'))
  stErr.className = 'stream-chat'
  const hErr = stErr.appendChild(new envErr.Element('div'))
  hErr.className = 'stream-chat-header'
  const hostErr = stErr.appendChild(new envErr.Element('div'))
  const scErr = hostErr.appendChild(new envErr.Element('div'))
  scErr.setAttribute('data-a-target', 'chat-scroller')
  envErr.api.refresh()
  await envErr.api.mounted.history.restorePromise
  assert.equal(envErr.api.mounted.panel.querySelector('.ttc-history-status').getAttribute('role'), 'status')
})

test('Twitch toggle button & tooltip: circular style, native-style left tooltip with popover, hover bridge, Escape, and blur', () => {
  const env = boot({ trustedTypes: true })
  env.window.innerWidth = 1280
  env.window.innerHeight = 720
  const styleText = env.document.head.querySelector('style').textContent
  assert.match(styleText, /\.ttc-toggle\s*\{[^}]*border-radius:\s*50%/)
  assert.match(styleText, /\.ttc-toggle:not\(:last-child\)\s*\{[^}]*margin-right:\s*8px/)
  assert.match(styleText, /\.ttc-tooltip\s*\{[^}]*overflow:\s*visible/)

  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  const { button, tooltip } = state
  assert.equal(button.getAttribute('title'), null)
  assert.equal(tooltip.getAttribute('role'), 'tooltip')
  assert.equal(tooltip.getAttribute('popover'), 'hint')
  assert.equal(button.getAttribute('aria-describedby'), tooltip.id)

  let popoverOpens = 0
  let popoverCloses = 0
  tooltip.showPopover = () => { popoverOpens++ }
  tooltip.hidePopover = () => { popoverCloses++ }
  button.getBoundingClientRect = () => ({ left: 1180, top: 60, width: 32, height: 32, right: 1212, bottom: 92 })
  tooltip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 240, height: 28, right: 240, bottom: 28 })

  button.listeners.get('mouseenter')()
  assert.equal(popoverOpens, 1)
  assert.equal(tooltip.getAttribute('data-visible'), 'true')
  env.flushFrames()
  assert.equal(tooltip.getAttribute('data-placement'), 'left')
  assert.equal(tooltip.style.left, '929px')
  assert.equal(tooltip.style.top, '62px')
  assert.equal(tooltip.style.visibility, '')

  button.listeners.get('mouseleave')()
  tooltip.listeners.get('mouseenter')()
  for (const [id, timer] of [...env.timers.entries()]) {
    if (timer.delay === 100) { env.timers.delete(id); timer.fn() }
  }
  assert.equal(tooltip.getAttribute('data-visible'), 'true')

  tooltip.listeners.get('mouseleave')()
  for (const [id, timer] of [...env.timers.entries()]) {
    if (timer.delay === 100) { env.timers.delete(id); timer.fn() }
  }
  assert.equal(tooltip.getAttribute('data-visible'), 'false')
  assert.equal(popoverCloses, 1)

  button.listeners.get('focus')()
  assert.equal(tooltip.getAttribute('data-visible'), 'true')
  env.document.listeners.get('keydown')({ key: 'Escape' })
  assert.equal(tooltip.getAttribute('data-visible'), 'false')
  assert.equal(popoverCloses, 2)

  button.listeners.get('focus')()
  assert.equal(tooltip.getAttribute('data-visible'), 'true')
  button.listeners.get('blur')()
  assert.equal(tooltip.getAttribute('data-visible'), 'false')

  button.getBoundingClientRect = () => ({ left: 80, top: 60, width: 32, height: 32, right: 112, bottom: 92 })
  button.listeners.get('mouseenter')()
  env.flushFrames()
  assert.equal(tooltip.getAttribute('data-placement'), 'bottom')
  assert.equal(tooltip.style.top, '103px')

  env.api.setEnabled(state, true)
  assert.equal(button.getAttribute('aria-describedby'), null)
  assert.equal(tooltip.getAttribute('data-visible'), 'false')

  env.api.setEnabled(state, false)
  assert.equal(button.getAttribute('aria-describedby'), tooltip.id)
  button.listeners.get('mouseenter')()
  env.api.unmount()
  assert.equal(tooltip.parentElement, null)
  assert.equal(popoverCloses, 5)
})

test('Twitch message search: preserve both display name and login ID, match multi-word NFKC and emotes, and update live without locate', async () => {
  const database = fakeIndexedDB()
  const seed = boot({ database })
  const seedHistory = seed.api.getHistory('sample_channel')
  await seedHistory.restorePromise
  const localized = seed.message('tommy181933', 'ＨＥＬＬＯ ＷＯＲＬＤ', 'Moderator', 's-1')
  localized.line.querySelector('[data-a-target="chat-message-username"]').textContent = '偷米'
  const emote = localized.body.appendChild(new seed.Element('img'))
  emote.setAttribute('alt', 'Kappa')
  const alreadyCombined = seed.message('alice_mod', 'combined label', 'Moderator', 's-2')
  alreadyCombined.line.querySelector('[data-a-target="chat-message-username"]').textContent = '愛麗絲 (alice_mod)'
  const sameName = seed.message('bob_vip', 'another message', 'VIP', 's-3')
  sameName.line.querySelector('[data-a-target="chat-message-username"]').textContent = 'Bob_VIP'

  seed.api.captureLine(localized.line, seedHistory)
  seed.api.captureLine(alreadyCombined.line, seedHistory)
  await seed.api.flushHistory(seedHistory)

  // Verify legacy archived tree with display-name-only <strong> also restores both display name and ID
  const legacyKey = JSON.stringify(['sample_channel', 's-1'])
  const archived = database.records.get(legacyKey)
  archived.tree.children[2].children[0].text = '偷米'

  const env = boot({ database })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')
  scroller.appendChild(env.message('bob_vip', 'another message', 'VIP', 's-3').line)
  scroller.querySelector('[data-a-target="chat-message-username"]').textContent = 'Bob_VIP'

  env.api.refresh()
  const state = env.api.mounted
  await state.history.restorePromise
  env.api.setEnabled(state, true)
  assert.equal(state.count.textContent, '3 則')
  assert.equal(state.list.children[0].querySelector('strong').textContent, '偷米 (tommy181933)')
  assert.equal(state.list.children[1].querySelector('strong').textContent, '愛麗絲 (alice_mod)')
  assert.equal(state.list.children[2].querySelector('strong').textContent, 'Bob_VIP')

  // Expanding target management hides message search; collapsing restores it
  const targetBtn = state.panel.querySelector('.ttc-target-summary')
  targetBtn.listeners.get('click')()
  assert.equal(state.panel.querySelector('.ttc-message-search').hidden, true)
  targetBtn.listeners.get('click')()
  assert.equal(state.panel.querySelector('.ttc-message-search').hidden, false)

  // Search by display name + login ID + full-width multi-word + emote alt (no locate button)
  state.messageSearch.value = '偷米 tommy181933 hello kappa'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '1 則符合')
  assert.equal(state.list.children.length, 1)
  assert.equal(state.list.querySelector('.ttc-locate'), null)

  // Live edit clears cached search text and updates active search results
  const liveMsg = env.message('tommy181933', 'before edit', 'Moderator', 's-4')
  liveMsg.line.querySelector('[data-a-target="chat-message-username"]').textContent = '偷米'
  scroller.appendChild(liveMsg.line)
  env.api.captureMutations([{ target: scroller, addedNodes: [liveMsg.line] }], state.history)
  liveMsg.body.innerHTML = 'edited kappa'
  liveMsg.body.textContent = 'edited kappa'
  env.api.captureMutations([{ target: liveMsg.body, addedNodes: [] }], state.history)
  state.messageSearch.value = '偷米 edited'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '1 則符合')
  assert.equal(state.list.children[0].querySelector('strong').textContent, '偷米 (tommy181933)')

  // Clear search restores full filtered list without locate UI
  state.messageSearch.value = ''
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '4 則')
  assert.equal(state.list.querySelector('.ttc-locate'), null)
  env.api.unmount()
})

test('Twitch date dividers: group consecutive days cleanly across restore, incremental updates, search, and deletions', async () => {
  const database = fakeIndexedDB()
  const day1 = new Date(2026, 10, 17, 23, 50, 0).getTime()
  const day2 = new Date(2026, 10, 18, 0, 5, 0).getTime()
  const day2Later = new Date(2026, 10, 18, 12, 0, 0).getTime()
  const day3 = new Date(2026, 10, 19, 1, 0, 0).getTime()
  let now = day1

  const seed = boot({ database, now: () => now })
  const seedHistory = seed.api.getHistory('sample_channel')
  await seedHistory.restorePromise
  seed.api.captureLine(seed.message('mod_a', 'day one msg', 'Moderator', 'd-1').line, seedHistory)
  now = day2
  seed.api.captureLine(seed.message('mod_b', 'day two first', 'Moderator', 'd-2').line, seedHistory)
  now = day2Later
  seed.api.captureLine(seed.message('mod_a', 'day two second', 'Moderator', 'd-3').line, seedHistory)
  await seed.api.flushHistory(seedHistory)

  now = day3
  const env = boot({ database, now: () => now })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  await state.history.restorePromise
  env.api.setEnabled(state, true)

  assert.equal(state.list.children[0].getAttribute('data-date'), '2026/11/17')
  assert.equal(state.list.children[1].getAttribute('data-date'), '2026/11/18')
  assert.equal(state.list.children[2].getAttribute('data-date'), null)

  // Incremental cross-midnight arrival adds divider only on the new date
  const msg3 = env.message('mod_c', 'day three msg', 'Moderator', 'd-4')
  scroller.appendChild(msg3.line)
  env.api.captureMutations([{ target: scroller, addedNodes: [msg3.line] }], state.history)
  env.api.scheduleMessageRender(state)
  env.flushFrames()
  assert.equal(state.list.children.length, 4)
  assert.equal(state.list.children[3].getAttribute('data-date'), '2026/11/19')

  // Search mode also preserves per-day date dividers
  state.messageSearch.value = 'mod_a'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.list.children.length, 2)
  assert.equal(state.list.children[0].getAttribute('data-date'), '2026/11/17')
  assert.equal(state.list.children[1].getAttribute('data-date'), '2026/11/18')

  // Excluding day2 first message promotes day2 second message to carry the 2026/11/18 divider
  state.messageSearch.value = ''
  state.messageSearch.listeners.get('input')()
  state.history.settings = env.api.changeTargetUsers(state.history.settings, 'mod_b', false, true)
  env.api.renderMessages(state, true)
  assert.equal(state.list.children.length, 3)
  assert.equal(state.list.children[0].getAttribute('data-date'), '2026/11/17')
  assert.equal(state.list.children[1].getAttribute('data-date'), '2026/11/18')
  assert.equal(state.list.children[2].getAttribute('data-date'), '2026/11/19')
  env.api.unmount()
})

test('Twitch VOD chat: isolate per-VOD archive scope from live/other VODs, detect owner and replay DOM, and avoid double-capturing nested nodes', async () => {
  const database = fakeIndexedDB()
  const liveEnv = boot({ database })
  const liveHistory = liveEnv.api.getHistory('streamer_one')
  await liveHistory.restorePromise
  liveEnv.api.captureLine(liveEnv.message('mod_live', 'live message', 'Moderator', 'live-1').line, liveHistory)
  await liveEnv.api.flushHistory(liveHistory)

  const vodEnv = boot({ database })
  vodEnv.location.pathname = '/videos/987654321'
  const info = vodEnv.document.body.appendChild(new vodEnv.Element('div'))
  info.className = 'channel-info-content'
  const ownerLink = info.appendChild(new vodEnv.Element('a'))
  ownerLink.setAttribute('href', '/streamer_one')

  const vodChat = vodEnv.document.body.appendChild(new vodEnv.Element('div'))
  vodChat.className = 'video-chat'
  const vodHeader = vodChat.appendChild(new vodEnv.Element('div'))
  vodHeader.className = 'video-chat__header'
  const vodBodyContainer = vodChat.appendChild(new vodEnv.Element('div'))
  const wrapper = vodBodyContainer.appendChild(new vodEnv.Element('div'))
  wrapper.className = 'video-chat__message-list-wrapper'
  const scroller = wrapper.appendChild(new vodEnv.Element('ul'))

  // Nested VOD message structure: li.vod-message > div[data-test-selector="message-layout"]
  const li = scroller.appendChild(new vodEnv.Element('li'))
  li.className = 'vod-message'
  li.setAttribute('data-a-id', 'vod-msg-1')
  const layout = li.appendChild(new vodEnv.Element('div'))
  layout.setAttribute('data-test-selector', 'message-layout')
  const msgHeader = layout.appendChild(new vodEnv.Element('div'))
  msgHeader.className = 'vod-message__header'
  const authorLink = msgHeader.appendChild(new vodEnv.Element('a'))
  authorLink.setAttribute('href', '/streamer_one')
  const displayName = authorLink.appendChild(new vodEnv.Element('span'))
  displayName.className = 'chat-author__display-name'
  displayName.textContent = '實況主'
  const body = layout.appendChild(new vodEnv.Element('span'))
  body.setAttribute('data-test-selector', 'message-text')
  const fragment = body.appendChild(new vodEnv.Element('span'))
  fragment.className = 'text-fragment'
  fragment.textContent = 'vod replay hello'

  // Live Twitch VOD DOM: timestamp in vod-message__header, badges & video-chat__message-author siblings, ':' + content span in video-chat__message
  const modLine = scroller.appendChild(new vodEnv.Element('div'))
  modLine.className = 'vod-message'
  const tsHeader = modLine.appendChild(new vodEnv.Element('div'))
  tsHeader.className = 'vod-message__header'
  tsHeader.textContent = '1:47'
  const modContentRow = modLine.appendChild(new vodEnv.Element('div'))
  const modBadgeHolder = modContentRow.appendChild(new vodEnv.Element('span'))
  const modBadge = modBadgeHolder.appendChild(new vodEnv.Element('img'))
  modBadge.className = 'chat-badge'
  modBadge.setAttribute('alt', '管理員徽章')
  const modAuthorLink = modContentRow.appendChild(new vodEnv.Element('a'))
  modAuthorLink.className = 'video-chat__message-author'
  modAuthorLink.setAttribute('href', '/vod_mod')
  const modName = modAuthorLink.appendChild(new vodEnv.Element('span'))
  modName.setAttribute('data-a-target', 'chat-message-username')
  modName.setAttribute('data-a-user', 'vod_mod')
  modName.textContent = '管理員甲'
  const modMsgBox = modContentRow.appendChild(new vodEnv.Element('div'))
  modMsgBox.className = 'video-chat__message'
  const colon = modMsgBox.appendChild(new vodEnv.Element('span'))
  colon.textContent = ':'
  const modMsgBody = modMsgBox.appendChild(new vodEnv.Element('span'))
  const modFrag = modMsgBody.appendChild(new vodEnv.Element('span'))
  modFrag.className = 'text-fragment'
  modFrag.setAttribute('data-a-target', 'chat-message-text')
  modFrag.textContent = 'vod hi '
  const modEmote = modMsgBody.appendChild(new vodEnv.Element('img'))
  modEmote.className = 'chat-image'
  modEmote.setAttribute('alt', 'cmonBruh')
  modEmote.setAttribute('src', 'https://static-cdn.jtvnw.net/emoticons/v2/84608/default/dark/1.0')

  vodEnv.api.refresh()
  const state = vodEnv.api.mounted
  assert.ok(state)
  assert.equal(state.history.channel, 'vod:987654321')
  assert.equal(state.history.scope, 'vod:987654321')
  assert.equal(vodHeader.classList.contains('ttc-vod-header'), true)
  assert.equal(state.scroller, wrapper)
  assert.equal(state.host, vodBodyContainer)
  assert.notEqual(state.host, vodChat)
  assert.equal(state.host.contains(vodHeader), false)
  await state.history.restorePromise

  // Live stream message must not leak into VOD archive, and nested mutation does not duplicate
  vodEnv.api.captureMutations([
    { target: scroller, addedNodes: [li] },
    { target: layout, addedNodes: [msgHeader] },
    { target: fragment, addedNodes: [] },
  ], state.history)
  vodEnv.api.setEnabled(state, true)
  assert.equal(state.history.messages.length, 2)
  assert.equal(state.history.messages[0].broadcaster, true)
  assert.equal(state.history.messages[1].moderator, true)
  assert.equal(state.count.textContent, '2 則')
  assert.equal(state.list.children[0].querySelector('strong').textContent, '實況主 (streamer_one)')
  assert.equal(state.list.children[1].querySelector('strong').textContent, '管理員甲 (vod_mod)')
  assert.equal(state.list.children[1].querySelector('.ttc-time').textContent, '1:47')
  assert.equal(state.list.children[1].querySelector('.ttc-time').getAttribute('datetime'), 'PT107S')
  assert.equal(state.list.children[1].getAttribute('data-date'), null)
  assert.equal(state.list.children[1].children.at(-1).textContent, 'vod hi ')
  assert.ok(state.list.children[1].querySelector('img.chat-image'))
  vodEnv.api.unmount()
  assert.equal(vodHeader.classList.contains('ttc-vod-header'), false)
})

test('Twitch replies: preserve reply-target quote in DOM/fiber, handle edits, search, archive restore, nested strip, and deleted parent', async () => {
  const database = fakeIndexedDB()
  const seed = boot({ database })
  const history = seed.api.getHistory('sample_channel')
  await history.restorePromise

  const attachReplyUi = (line, parentDisplay, parentText, { container = true } = {}) => {
    const host = container ? Object.assign(new seed.Element(), { className: 'chat-line__message-container' }) : line
    if (container) line.insertBefore(host, line.firstChild)
    const p = host.appendChild(new seed.Element('p'))
    p.setAttribute('title', parentText)
    p.appendChild(seed.document.createTextNode('回覆 '))
    const authorSpan = p.appendChild(new seed.Element('span'))
    authorSpan.setAttribute('dir', 'auto')
    authorSpan.textContent = `@${parentDisplay}`
    p.appendChild(seed.document.createTextNode('：'))
    const textSpan = p.appendChild(new seed.Element('span'))
    textSpan.setAttribute('dir', 'auto')
    textSpan.textContent = parentText
    return p
  }

  // 1. Filtered Moderator replying to an ordinary viewer with React fiber + DOM <p>
  const reply1 = seed.message('mod_a', '完全同意', 'Moderator', 'reply-1')
  attachReplyUi(reply1.line, '來希', '身體要健康唷')
  reply1.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'reply-1',
        user: { userLogin: 'mod_a', userDisplayName: '管理員A' },
        reply: {
          parentMsgId: 'ord-parent-1',
          parentUserLogin: 'raiki_raibao',
          parentDisplayName: '來希',
          parentMessageBody: '身體要健康唷',
          parentDeleted: false,
          threadParentUserLogin: 'raiki_raibao',
        },
      },
    },
  }
  assert.equal(seed.api.captureLine(reply1.line, history), true)

  // 2. Nested reply prefers DOM cleaned text over raw IRC @mention prefix
  const reply2 = seed.message('mod_a', '真的', 'Moderator', 'reply-2')
  attachReplyUi(reply2.line, '小王', '二打五')
  reply2.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'reply-2',
        user: { userLogin: 'mod_a', userDisplayName: '管理員A' },
        reply: {
          parentMsgId: 'nested-1',
          parentUserLogin: 'wang_user',
          parentDisplayName: '小王',
          parentMessageBody: '@thread_root 二打五',
          parentDeleted: false,
        },
      },
    },
  }
  assert.equal(seed.api.captureLine(reply2.line, history), true)

  // 3. Deleted parent message renders deleted notice
  const reply3 = seed.message('mod_a', '剛剛說什麼', 'Moderator', 'reply-3')
  reply3.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'reply-3',
        user: { userLogin: 'mod_a', userDisplayName: '管理員A' },
        reply: {
          parentMsgId: 'del-1',
          parentUserLogin: 'gone_user',
          parentDisplayName: '消失的人',
          parentMessageBody: '',
          parentDeleted: true,
        },
      },
    },
  }
  assert.equal(seed.api.captureLine(reply3.line, history), true)

  // 4. Pure DOM reply without fiber resolves known display name -> login
  const knownSpeaker = seed.message('alice_tw', '你好呀', '', 'ord-alice')
  knownSpeaker.line.querySelector('[data-a-target="chat-message-username"]').textContent = '愛麗絲'
  assert.equal(seed.api.captureLine(knownSpeaker.line, history), false)

  const reply4 = seed.message('mod_a', '安安', 'Moderator', 'reply-4')
  const p4 = new seed.Element('p')
  p4.textContent = 'Replying to @愛麗絲: 你好呀'
  reply4.line.insertBefore(p4, reply4.line.firstChild)
  assert.equal(seed.api.captureLine(reply4.line, history), true)

  // Verify DOM presentation & edit preservation
  const rec1 = history.ids.get('reply-1')
  assert.equal(rec1.view.classList.contains('ttc-has-reply'), true)
  const quote1 = rec1.view.querySelector('.ttc-reply')
  assert.ok(quote1)
  assert.equal(quote1.querySelector('.ttc-reply-author').textContent, '@來希 (raiki_raibao)')
  assert.equal(quote1.querySelector('.ttc-reply-body').textContent, '身體要健康唷')
  assert.equal(rec1.view.children.at(-1).textContent, '完全同意')

  const originalTime = [...rec1.view.children].find(c => c.tagName === 'time').textContent
  reply1.body.innerHTML = '已編輯回覆'
  reply1.body.textContent = '已編輯回覆'
  assert.equal(seed.api.captureLine(reply1.line, history), true)
  const editedRec1 = history.ids.get('reply-1')
  assert.equal([...editedRec1.view.children].find(c => c.tagName === 'time').textContent, originalTime)
  assert.equal(editedRec1.view.children.at(-1).textContent, '已編輯回覆')
  assert.equal(editedRec1.view.querySelector('.ttc-reply-body').textContent, '身體要健康唷')

  assert.equal(history.ids.get('reply-2').view.querySelector('.ttc-reply-body').textContent, '二打五')
  const delBody = history.ids.get('reply-3').view.querySelector('.ttc-reply-body')
  assert.equal(delBody.textContent, '訊息已刪除')
  assert.equal(delBody.classList.contains('ttc-reply-deleted'), true)
  assert.equal(history.ids.get('reply-4').view.querySelector('.ttc-reply-author').textContent, '@愛麗絲 (alice_tw)')

  await seed.api.flushHistory(history)

  // Restore in fresh environment and verify search & rendered UI
  const fresh = boot({ database })
  const stream = fresh.document.body.appendChild(new fresh.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new fresh.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new fresh.Element('div'))
  const scroller = host.appendChild(new fresh.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  fresh.api.refresh()
  const state = fresh.api.mounted
  await state.history.restorePromise
  fresh.api.setEnabled(state, true)
  assert.equal(state.count.textContent, '4 則')

  const restoredRow1 = state.history.ids.get('reply-1').view
  assert.equal(restoredRow1.classList.contains('ttc-has-reply'), true)
  assert.equal(restoredRow1.querySelector('.ttc-reply-author').textContent, '@來希 (raiki_raibao)')
  assert.equal(restoredRow1.querySelector('.ttc-reply-body').textContent, '身體要健康唷')

  for (const query of ['raiki_raibao', '來希', '身體要健康']) {
    state.messageSearch.value = query
    state.messageSearch.listeners.get('input')()
    assert.equal(state.count.textContent, '0 則符合', `reply quote unexpectedly matched search for ${query}`)
  }
  state.messageSearch.value = '已編輯回覆'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '1 則符合')
  assert.ok(state.history.ids.get('reply-1').view.querySelector('.ttc-reply'))
  state.messageSearch.value = 'mod_a'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '4 則符合')
  fresh.api.unmount()
})

test('Twitch replies: keep filtered target replies even when replying to excluded users, while blocking excluded repliers', async () => {
  const database = fakeIndexedDB()
  const env = boot({ database })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  history.settings.excludedUsers = ['bad_user']
  history.settings.replies = false

  // Filtered Mod replies to excluded bad_user -> MUST still be kept even when replies=false
  const modRepliesBad = env.message('mod_a', '請不要洗頻', 'Moderator', 'mod-to-bad')
  modRepliesBad.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'mod-to-bad',
        user: { userLogin: 'mod_a', userDisplayName: '管理員' },
        reply: {
          parentMsgId: 'bad-msg-1',
          parentUserLogin: 'bad_user',
          parentDisplayName: '壞人',
          parentMessageBody: '洗頻內容',
          parentDeleted: false,
        },
      },
    },
  }
  assert.equal(env.api.captureLine(modRepliesBad.line, history), true)

  // Excluded user replies to Mod even when replies=true -> MUST NOT be captured
  history.settings.replies = true
  const badRepliesMod = env.message('bad_user', '我才沒有', '', 'bad-to-mod')
  badRepliesMod.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'bad-to-mod',
        user: { userLogin: 'bad_user', userDisplayName: '壞人' },
        reply: {
          parentMsgId: 'mod-to-bad',
          parentUserLogin: 'mod_a',
          parentDisplayName: '管理員',
          parentMessageBody: '請不要洗頻',
          parentDeleted: false,
        },
      },
    },
  }
  assert.equal(env.api.captureLine(badRepliesMod.line, history), false)

  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  history.settings.replies = false
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '1 則')
  assert.equal(state.list.children[0].querySelector('.ttc-reply-author').textContent, '@壞人 (bad_user)')
  assert.equal(state.list.children[0].querySelector('.ttc-reply-body').textContent, '洗頻內容')

  await env.api.flushHistory(history)
  const fresh = boot({ database })
  const restored = fresh.api.getHistory('sample_channel')
  await restored.restorePromise
  assert.equal(restored.messages.length, 1)
  assert.equal(restored.ids.get('mod-to-bad').reply.parentUser, 'bad_user')
})

test('Twitch replies: capture viewer replies to active targets, toggle globally, respect roles/exclusions, and ignore mentions or icons', () => {
  const env = boot()
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  const history = state.history
  history.settings.users = ['target_user']
  history.settings.excludedUsers = ['excluded_mod']
  env.api.saveSettings(history)
  env.api.setEnabled(state, true)

  const repliesCheckbox = state.panel.querySelector('[name="replies"]')
  assert.equal(repliesCheckbox.checked, true)

  // Seed Mod and VIP so knownRoles records them; excluded_mod is ignored for replies
  const modLine = env.message('mod_a', '公告', 'Moderator', 'p-mod')
  const vipLine = env.message('vip_a', '安安', 'VIP', 'p-vip')
  const exModLine = env.message('excluded_mod', '略過', 'Moderator', 'p-exmod')
  const ordLine = env.message('ordinary_parent', '一般發言', '', 'p-ord')
  for (const m of [modLine, vipLine, exModLine, ordLine]) {
    scroller.appendChild(m.line)
    env.api.captureLine(m.line, history)
  }

  const withReplyFiber = (user, text, id, parent) => {
    const msg = env.message(user, text, '', id)
    msg.line.__reactFiber$1 = {
      memoizedProps: {
        message: {
          id,
          user: { userLogin: user, userDisplayName: user },
          reply: parent,
        },
      },
    }
    scroller.appendChild(msg.line)
    return msg
  }

  // Ordinary viewers replying to Broadcaster, Moderator, VIP, and included target_user -> captured
  withReplyFiber('viewer_1', '給實況主', 'r-broadcaster', {
    parentMsgId: 'p-broadcaster', parentUserLogin: 'sample_channel', parentDisplayName: '實況主', parentMessageBody: '開台', parentDeleted: false,
  })
  withReplyFiber('viewer_2', '給管理員', 'r-mod', {
    parentMsgId: 'p-mod', parentUserLogin: 'mod_a', parentDisplayName: 'ModA', parentMessageBody: '公告', parentDeleted: false,
  })
  withReplyFiber('viewer_3', '給VIP', 'r-vip', {
    parentMsgId: 'p-vip', parentUserLogin: 'vip_a', parentDisplayName: 'VIPA', parentMessageBody: '安安', parentDeleted: false,
  })
  withReplyFiber('viewer_4', '給指定用戶', 'r-target', {
    parentMsgId: 'p-target', parentUserLogin: 'target_user', parentDisplayName: 'Target', parentMessageBody: '嗨', parentDeleted: false,
  })

  // Ordinary viewer replying to excluded_mod -> NOT captured
  withReplyFiber('viewer_5', '給排除Mod', 'r-exmod', {
    parentMsgId: 'p-exmod', parentUserLogin: 'excluded_mod', parentDisplayName: 'ExMod', parentMessageBody: '略過', parentDeleted: false,
  })
  // Ordinary viewer replying to ordinary viewer even if thread root is mod_a -> NOT captured
  withReplyFiber('viewer_6', '同串不同目標', 'r-ord', {
    parentMsgId: 'p-ord', parentUserLogin: 'ordinary_parent', parentDisplayName: 'Ord', parentMessageBody: '一般發言', parentDeleted: false,
    threadParentMsgId: 'p-mod', threadParentUserLogin: 'mod_a', threadParentDisplayName: 'ModA',
  })

  // Plain @mention inside body and hover reply button inside .chat-line__icons -> NOT captured
  const mentionOnly = env.message('viewer_7', '@mod_a 你好', '', 'm-mention')
  const icons = mentionOnly.line.appendChild(new env.Element('div'))
  icons.className = 'chat-line__icons'
  const iconWrap = icons.appendChild(new env.Element('div'))
  iconWrap.className = 'chat-line__reply-icon'
  const iconBtn = iconWrap.appendChild(new env.Element('button'))
  iconBtn.setAttribute('aria-label', '按此回覆 @mod_a')
  scroller.appendChild(mentionOnly.line)

  env.api.captureTree(scroller, history)
  env.api.renderMessages(state, true)

  // 2 direct target lines (mod_a, vip_a) + 4 viewer replies = 6
  assert.equal(state.count.textContent, '6 則')
  assert.equal(history.ids.has('r-exmod'), false)
  assert.equal(history.ids.has('r-ord'), false)
  assert.equal(history.ids.has('m-mention'), false)

  // Viewer replies to visible targets wrap the parent view and inline toggle inside .ttc-thread-head,
  // with a collapsed hidden="until-found" .ttc-replies panel beneath; unseen targets use .ttc-reply-group.
  const modView = history.ids.get('p-mod').view
  const modThread = modView.closest('.ttc-thread')
  assert.ok(modThread)
  const modHead = modThread.querySelector('.ttc-thread-head')
  assert.equal(modView.parentElement, modHead)
  const modToggle = modHead.children[modHead.children.indexOf(modView) + 1]
  assert.equal(modToggle.tagName, 'button')
  assert.equal(modToggle.className, 'ttc-replies-toggle')
  assert.equal(modToggle.getAttribute('aria-expanded'), 'false')
  assert.equal(modToggle.textContent, '1 則回覆')
  const modPanel = modThread.querySelector('.ttc-replies')
  assert.equal(modToggle.getAttribute('aria-controls'), modPanel.getAttribute('id'))
  assert.equal(modPanel.getAttribute('hidden'), 'until-found')
  assert.equal(modPanel.hidden, 'until-found')
  assert.equal(modView.classList.contains('ttc-has-replies'), true)
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 2)
  assert.equal(state.list.querySelectorAll('.ttc-replies').length, 4)

  // Ensure injected CSS preserves hidden="until-found" instead of forcing display: none !important
  const cssText = env.document.head.querySelector('style').textContent
  assert.match(cssText, /\.ttc-panel \[hidden\]:not\(\[hidden="until-found" i\]\)/)

  // Toggling VIP off hides both vip_a and viewer_3's reply to vip_a
  const vipCheckbox = state.panel.querySelector('[name="vip"]')
  vipCheckbox.checked = false
  vipCheckbox.listeners.get('change')()
  assert.equal(state.count.textContent, '4 則')
  assert.equal(state.list.querySelectorAll('.ttc-replies').length, 3)
  vipCheckbox.checked = true
  vipCheckbox.listeners.get('change')()
  assert.equal(state.count.textContent, '6 則')

  // Unchecking replies checkbox unwraps parents, removes drawers, stops capturing new ones, persists globally
  repliesCheckbox.checked = false
  repliesCheckbox.listeners.get('change')()
  assert.equal(history.settings.replies, false)
  assert.equal(state.count.textContent, '2 則')
  assert.equal(state.list.querySelectorAll('.ttc-replies').length, 0)
  assert.equal(state.list.querySelectorAll('.ttc-thread').length, 0)
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 0)
  assert.equal(history.ids.get('p-mod').view.parentElement, state.list)
  assert.equal(history.ids.get('p-mod').view.classList.contains('ttc-has-replies'), false)

  const whileOff = withReplyFiber('viewer_8', '關閉後回覆', 'r-while-off', {
    parentMsgId: 'p-mod', parentUserLogin: 'mod_a', parentDisplayName: 'ModA', parentMessageBody: '公告', parentDeleted: false,
  })
  assert.equal(env.api.captureLine(whileOff.line, history), false)
  assert.equal(history.ids.has('r-while-off'), false)
  whileOff.line.remove()

  // Reloading persists replies=false across channels; legacy settings without replies default to true
  const reloaded = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(reloaded.api.loadSettings('other_channel').replies, false)
  const legacyEnv = boot({ saved: JSON.stringify({ sample_channel: { users: ['alice'] } }) })
  assert.equal(legacyEnv.api.loadSettings('sample_channel').replies, true)

  // Re-checking replies restores retained viewer replies and syncs via storage event
  repliesCheckbox.checked = true
  repliesCheckbox.listeners.get('change')()
  assert.equal(state.count.textContent, '6 則')

  env.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({
    moderators: true, broadcaster: true, vip: true, replies: false, users: ['target_user'], excludedUsers: ['excluded_mod'],
  }))
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(repliesCheckbox.checked, false)
  assert.equal(state.count.textContent, '2 則')
  env.api.unmount()
})

test('Twitch replies: backfill parent roles after restore, fallback to fiber ID safely, and stay inert under Trusted Types', async () => {
  const database = fakeIndexedDB()
  const seed = boot({ database })
  const seedHistory = seed.api.getHistory('sample_channel')
  await seedHistory.restorePromise
  const vipParent = seed.message('vip_later', '舊 VIP 發言', 'VIP', 'vip-old-1')
  vipParent.line.querySelector('[data-a-target="chat-message-username"]').textContent = '尊爵VIP'
  seed.api.captureLine(vipParent.line, seedHistory)
  await seed.api.flushHistory(seedHistory)

  const env = boot({ database, trustedTypes: true })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  const makeTtMessage = (user, text) => {
    const line = new env.Element()
    line.setAttribute('data-a-target', 'chat-line-message')
    const authorContainer = line.appendChild(new env.Element())
    authorContainer.className = 'chat-line__username-container'
    const author = authorContainer.appendChild(new env.Element('span'))
    author.setAttribute('data-a-target', 'chat-message-username')
    author.setAttribute('data-a-user', user)
    author.textContent = user
    const body = line.appendChild(new env.Element('span'))
    body.setAttribute('data-a-target', 'chat-line-message-body')
    body.textContent = text
    return { line, body, authorContainer }
  }

  // Live viewer reply sitting in DOM before IndexedDB finishes restoring VIP parent, with no DOM data-id
  const viewerReply = makeTtMessage('viewer_start', '早安VIP')
  viewerReply.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'fiber-only-id',
        user: { userLogin: 'viewer_start', userDisplayName: '觀眾' },
        reply: {
          parentMsgId: 'vip-old-1',
          parentUserLogin: 'vip_later',
          parentDisplayName: '<img src=x onerror=alert(1)>',
          parentMessageBody: '<script>evil()</script> 舊 VIP 發言',
          parentDeleted: false,
        },
      },
    },
  }
  scroller.appendChild(viewerReply.line)

  // Line whose fiber belongs to a different user must NOT steal that fiber's id/reply
  const mismatch = makeTtMessage('viewer_mismatch', '一般訊息')
  mismatch.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'wrong-user-id',
        user: { userLogin: 'someone_else' },
        reply: {
          parentMsgId: 'vip-old-1',
          parentUserLogin: 'sample_channel',
          parentDisplayName: '實況主',
          parentMessageBody: 'hijack',
        },
      },
    },
  }
  scroller.appendChild(mismatch.line)

  env.api.refresh()
  const state = env.api.mounted
  assert.equal(state.history.ids.has('fiber-only-id'), false, 'cannot match VIP before archive restore')
  assert.equal(env.api.readMessage(mismatch.line, 'sample_channel', state.history).id, '')
  assert.equal(env.api.readMessage(mismatch.line, 'sample_channel', state.history).reply, null)

  await state.history.restorePromise
  env.api.setEnabled(state, true)

  assert.equal(state.count.textContent, '2 則')
  const restoredReply = state.history.ids.get('fiber-only-id')
  assert.ok(restoredReply)
  const parentView = state.history.ids.get('vip-old-1').view
  const attachedThread = parentView.closest('.ttc-thread')
  assert.ok(attachedThread)
  assert.equal(attachedThread.querySelector('.ttc-replies-toggle').textContent, '1 則回覆')
  assert.equal(restoredReply.view.parentElement, attachedThread.querySelector('.ttc-replies-list'))
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 0)
  const quote = restoredReply.view.querySelector('.ttc-reply')
  assert.equal(quote.querySelector('img'), null)
  assert.equal(quote.querySelector('script'), null)
  assert.equal(quote.querySelector('.ttc-reply-author').textContent, '@<img src=x onerror=alert(1)> (vip_later)')
  assert.equal(quote.querySelector('.ttc-reply-body').textContent, '<script>evil()</script> 舊 VIP 發言')
  env.api.unmount()
})

test('Twitch reply drawers: keep target-to-target top-level, persist open state on edits/appends without full scan, support beforematch, and flatten in search', async () => {
  const database = fakeIndexedDB()
  const seed = boot({ database })
  const seedHistory = seed.api.getHistory('sample_channel')
  await seedHistory.restorePromise
  const lateParent = seed.message('mod_old', '舊管理員公告', 'Moderator', 'old-mod-msg')
  seed.api.captureLine(lateParent.line, seedHistory)
  await seed.api.flushHistory(seedHistory)

  const env = boot({ database })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  const history = state.history
  env.api.setEnabled(state, true)

  const makeReply = (user, role, text, id, parent) => {
    const msg = env.message(user, text, role, id)
    msg.line.__reactFiber$1 = {
      memoizedProps: {
        message: {
          id,
          user: { userLogin: user, userDisplayName: user },
          reply: parent,
        },
      },
    }
    scroller.appendChild(msg.line)
    return msg
  }

  // Live parent mod_live + direct target-to-target reply (VIP -> mod_live) stay top-level
  const modLive = env.message('mod_live', '現場公告', 'Moderator', 'p-live')
  scroller.appendChild(modLive.line)
  const vipReply = makeReply('vip_replier', 'VIP', 'VIP 回覆管理員', 't-vip-reply', {
    parentMsgId: 'p-live', parentUserLogin: 'mod_live', parentDisplayName: 'ModLive', parentMessageBody: '現場公告', parentDeleted: false,
  })
  const viewerReply1 = makeReply('viewer_a', '', '觀眾回覆一', 'v-reply-1', {
    parentMsgId: 'p-live', parentUserLogin: 'mod_live', parentDisplayName: 'ModLive', parentMessageBody: '現場公告', parentDeleted: false,
  })
  // Multiple orphan replies to the same unseen parentId (broadcaster) merge into one .ttc-reply-group
  const orphan1 = makeReply('viewer_b', '', '開台安安1', 'o-1', {
    parentMsgId: 'unseen-bc-1', parentUserLogin: 'sample_channel', parentDisplayName: '實況主', parentMessageBody: '開台啦', parentDeleted: false,
  })
  const orphan2 = makeReply('viewer_c', '', '開台安安2', 'o-2', {
    parentMsgId: 'unseen-bc-1', parentUserLogin: 'sample_channel', parentDisplayName: '實況主', parentMessageBody: '開台啦', parentDeleted: false,
  })
  // Viewer reply to old-mod-msg that will re-parent once restorePromise finishes
  const orphanOld1 = makeReply('viewer_d', '', '看到舊公告1', 'oo-1', {
    parentMsgId: 'old-mod-msg', parentUserLogin: 'mod_old', parentDisplayName: 'OldMod', parentMessageBody: '舊管理員公告', parentDeleted: false,
  })
  const orphanOld2 = makeReply('viewer_e', '', '看到舊公告2', 'oo-2', {
    parentMsgId: 'old-mod-msg', parentUserLogin: 'mod_old', parentDisplayName: 'OldMod', parentMessageBody: '舊管理員公告', parentDeleted: false,
  })

  env.api.captureTree(scroller, history)
  env.api.renderMessages(state, true)

  assert.equal(vipReply.line.parentElement, scroller)
  assert.equal(history.ids.get('t-vip-reply').view.parentElement, state.list, 'target-to-target reply stays top-level')
  const liveView = history.ids.get('p-live').view
  const liveThread = liveView.closest('.ttc-thread')
  assert.ok(liveThread)
  const liveHead = liveThread.querySelector('.ttc-thread-head')
  const liveToggle = liveHead.children[liveHead.children.indexOf(liveView) + 1]
  const livePanel = liveThread.querySelector('.ttc-replies')
  assert.equal(liveToggle.tagName, 'button')
  assert.equal(liveToggle.getAttribute('aria-expanded'), 'false')
  assert.equal(liveToggle.textContent, '1 則回覆')
  assert.equal(livePanel.getAttribute('hidden'), 'until-found')

  // Orphan replies merged into a single .ttc-reply-group as a reconstructed parent row with inline toggle
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 1)
  const orphanGroup = state.list.querySelector('.ttc-reply-group')
  const orphanHead = orphanGroup.querySelector('.ttc-thread-head')
  assert.equal(orphanHead.classList.contains('ttc-orphan-head'), true)
  const orphanRow = orphanHead.children[0]
  assert.equal(orphanRow.classList.contains('ttc-message'), true)
  assert.equal(orphanRow.classList.contains('ttc-orphan-message'), true)
  assert.equal(orphanRow.classList.contains('ttc-has-replies'), true)
  assert.equal(orphanHead.querySelector('.ttc-reply'), null, 'orphan header must not render a reply quote bar')
  assert.equal(orphanRow.querySelector('.ttc-orphan-tag').textContent, '原留言')
  assert.equal(orphanRow.querySelector('.ttc-orphan-author').textContent, '實況主 (sample_channel)')
  assert.equal(orphanRow.querySelector('.ttc-orphan-body').textContent, '開台啦')
  assert.equal(orphanHead.children[1].className, 'ttc-replies-toggle')
  assert.equal(orphanHead.children[1].textContent, '2 則回覆')

  // Click toggle to open live drawer and verify open state persists across incremental updates, edits, and NO full history scan
  liveToggle.listeners.get('click')()
  assert.equal(liveToggle.getAttribute('aria-expanded'), 'true')
  assert.equal(livePanel.getAttribute('hidden'), null)
  assert.equal(livePanel.hidden, false)
  assert.equal(state.openReplyThreads.has('id:p-live'), true)

  history.messages[Symbol.iterator] = () => { throw Error('unexpected full history scan') }
  const viewerReply2 = makeReply('viewer_f', '', '觀眾回覆二', 'v-reply-2', {
    parentMsgId: 'p-live', parentUserLogin: 'mod_live', parentDisplayName: 'ModLive', parentMessageBody: '現場公告', parentDeleted: false,
  })
  env.api.captureLine(viewerReply2.line, history)
  modLive.body.innerHTML = '現場公告(已更新)'
  modLive.body.textContent = '現場公告(已更新)'
  env.api.captureLine(modLive.line, history)
  viewerReply1.body.innerHTML = '觀眾回覆一(已編輯)'
  viewerReply1.body.textContent = '觀眾回覆一(已編輯)'
  env.api.captureLine(viewerReply1.line, history)
  env.api.renderMessages(state)
  delete history.messages[Symbol.iterator]

  const threadAfterInc = history.ids.get('p-live').view.closest('.ttc-thread')
  assert.equal(threadAfterInc, liveThread, 'incremental update reuses the same thread wrapper')
  assert.equal(threadAfterInc.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'true')
  assert.equal(threadAfterInc.querySelector('.ttc-replies').getAttribute('hidden'), null)
  assert.equal(threadAfterInc.querySelector('.ttc-replies-toggle').textContent, '2 則回覆')
  assert.equal(history.ids.get('p-live').view.children.at(-1).textContent, '現場公告(已更新)')
  assert.equal(history.ids.get('v-reply-1').view.children.at(-1).textContent, '觀眾回覆一(已編輯)')

  // Find-in-page beforematch on hidden="until-found" orphan panel opens it and syncs aria-expanded
  const orphanPanel = orphanGroup.querySelector('.ttc-replies')
  orphanPanel.listeners.get('beforematch')()
  assert.equal(orphanHead.children[1].getAttribute('aria-expanded'), 'true')
  assert.equal(orphanPanel.getAttribute('hidden'), null)
  assert.equal(orphanPanel.hidden, false)
  assert.equal(state.openReplyThreads.has('id:unseen-bc-1'), true)

  // Search mode flattens matching replies in state.list with .ttc-reply visible; clearing restores drawers & open state
  state.messageSearch.value = '觀眾回覆'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '2 則符合')
  assert.equal(state.list.querySelectorAll('.ttc-replies').length, 0)
  assert.equal(history.ids.get('v-reply-1').view.parentElement, state.list)
  assert.ok(history.ids.get('v-reply-1').view.querySelector('.ttc-reply'))

  state.messageSearch.value = ''
  state.messageSearch.listeners.get('input')()
  const restoredLiveThread = history.ids.get('p-live').view.closest('.ttc-thread')
  assert.equal(restoredLiveThread.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'true', 'open state restored after exiting search')
  assert.equal(restoredLiveThread.querySelector('.ttc-replies').getAttribute('hidden'), null)
  assert.equal(restoredLiveThread.querySelector('.ttc-replies-toggle').textContent, '2 則回覆')

  // Restoring old-mod-msg from IndexedDB attaches orphanOld1 and orphanOld2 inline after old-mod-msg
  await history.restorePromise
  const oldParentView = history.ids.get('old-mod-msg').view
  const oldThread = oldParentView.closest('.ttc-thread')
  assert.ok(oldThread)
  assert.equal(oldThread.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(oldThread.querySelector('.ttc-replies-toggle').textContent, '2 則回覆')
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 1, 'only unseen-bc-1 remains an orphan group')

  // Closing filter panel collapses all expanded reply threads and clears open state
  const currentLiveThread = history.ids.get('p-live').view.closest('.ttc-thread')
  const unseenGroup = state.list.querySelector('.ttc-reply-group')
  assert.equal(state.openReplyThreads.size, 2)
  assert.equal(currentLiveThread.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'true')
  assert.equal(unseenGroup.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'true')

  env.api.setEnabled(state, false)
  assert.equal(state.openReplyThreads.size, 0)
  assert.equal(currentLiveThread.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(currentLiveThread.querySelector('.ttc-replies').getAttribute('hidden'), 'until-found')
  assert.equal(unseenGroup.querySelector('.ttc-replies-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(unseenGroup.querySelector('.ttc-replies').getAttribute('hidden'), 'until-found')

  env.api.setEnabled(state, true)
  assert.equal(state.openReplyThreads.size, 0)
  for (const toggle of state.list.querySelectorAll('.ttc-replies-toggle')) {
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  }
  for (const panel of state.list.querySelectorAll('.ttc-replies')) {
    assert.equal(panel.getAttribute('hidden'), 'until-found')
  }
  env.api.unmount()
})

test('Twitch reply drawers: preserve cross-day date dividers across threads, handle parent eviction, and unwrap on empty drawer cleanup', async () => {
  const database = fakeIndexedDB()
  const day1 = new Date(2026, 10, 17, 23, 50, 0).getTime()
  const day2 = new Date(2026, 10, 18, 0, 10, 0).getTime()
  let now = day1
  const env = boot({ database, now: () => now })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  history.enabled = true
  env.api.setMounted(state)

  const makeReply = (user, text, id, parent) => {
    const msg = env.message(user, text, '', id)
    msg.line.__reactFiber$1 = {
      memoizedProps: {
        message: { id, user: { userLogin: user, userDisplayName: user }, reply: parent },
      },
    }
    return msg
  }

  // Day 1: Mod parent + viewer reply + same-day Mod message -> thread wrapper carries 2026/11/17; second Mod must NOT repeat divider
  const mod1 = env.message('mod_a', 'day1 first', 'Moderator', 'd1-mod1')
  env.api.captureLine(mod1.line, history)
  const rep1 = makeReply('viewer_1', 'day1 reply', 'd1-rep1', {
    parentMsgId: 'd1-mod1', parentUserLogin: 'mod_a', parentDisplayName: 'ModA', parentMessageBody: 'day1 first', parentDeleted: false,
  })
  env.api.captureLine(rep1.line, history)
  const mod2 = env.message('mod_a', 'day1 second', 'Moderator', 'd1-mod2')
  env.api.captureLine(mod2.line, history)

  // Day 2: Orphan viewer reply to broadcaster -> group carries 2026/11/18 date divider; then same-day Mod -> no duplicate divider
  now = day2
  const orphanDay2 = makeReply('viewer_2', 'day2 orphan', 'd2-rep1', {
    parentMsgId: 'd2-unseen', parentUserLogin: 'sample_channel', parentDisplayName: '實況主', parentMessageBody: '開台', parentDeleted: false,
  })
  env.api.captureLine(orphanDay2.line, history)
  const mod3 = env.message('mod_a', 'day2 mod', 'Moderator', 'd2-mod3')
  env.api.captureLine(mod3.line, history)

  env.api.renderMessages(state, true)
  const mod1View = history.ids.get('d1-mod1').view
  const mod1Thread = mod1View.closest('.ttc-thread')
  assert.equal(mod1Thread.getAttribute('data-date'), '2026/11/17')
  assert.equal(mod1View.getAttribute('data-date'), null)
  assert.equal(history.ids.get('d1-mod2').view.getAttribute('data-date'), null, 'same-day row after thread must not repeat divider')
  const day2Group = state.list.querySelector('.ttc-reply-group')
  assert.equal(day2Group.getAttribute('data-date'), '2026/11/18')
  assert.equal(history.ids.get('d2-mod3').view.getAttribute('data-date'), null, 'same-day row after orphan group must not repeat divider')

  // Removing the last reply unwraps d1-mod1 back into state.list, keeps its 2026/11/17 divider, and clears .ttc-has-replies
  history.settings.excludedUsers = ['viewer_1']
  env.api.renderMessages(state)
  assert.equal(mod1View.parentElement, state.list)
  assert.equal(mod1View.getAttribute('data-date'), '2026/11/17')
  assert.equal(mod1View.classList.contains('ttc-has-replies'), false)
  assert.equal(state.list.querySelectorAll('.ttc-replies').length, 1, 'only day2 orphan group drawer remains')
  history.settings.excludedUsers = []
  env.api.renderMessages(state, true)
  assert.equal(mod1View.classList.contains('ttc-has-replies'), true)

  // Removing expired d1-mod1 while d1-rep1 remains converts d1-rep1's thread into an orphan .ttc-reply-group
  const rep1Record = history.ids.get('d1-rep1')
  const mod1Record = history.ids.get('d1-mod1')
  history.messages = history.messages.filter(r => r !== mod1Record)
  history.removed.add(mod1Record)
  mod1Record.retained = false
  history.ids.delete('d1-mod1')
  env.api.renderMessages(state)
  assert.equal(rep1Record.view.closest('.ttc-reply-group').getAttribute('data-date'), '2026/11/17')
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 2)
  assert.equal(state.count.textContent, '4 則')
})

test('Twitch orphan reply groups: render independent target threads with remembered color, deleted placeholder, and separate adjacent targets', async () => {
  const database = fakeIndexedDB()
  const seed = boot({ database })
  const seedScroller = seed.document.createElement('div')
  seedScroller.setAttribute('data-a-target', 'chat-scroller')
  const seedHistory = seed.api.getHistory('sample_channel')
  seedHistory.settings.users = ['never_loses']
  seed.api.saveSettings(seedHistory)
  await seedHistory.restorePromise
  const prevTargetA = seed.message('never_loses', '早安', '', 'prev-a')
  const prevAuthor = prevTargetA.authorContainer.querySelector('[data-a-target="chat-message-username"]')
  prevAuthor.textContent = 'NeVeR_LosEs'
  prevAuthor.style.color = 'rgb(255, 117, 181)'
  seedScroller.appendChild(prevTargetA.line)
  seed.api.captureLine(prevTargetA.line, seedHistory)
  await seed.api.flushHistory(seedHistory)

  const env = boot({ database })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')
  env.api.refresh()
  const state = env.api.mounted
  const history = state.history
  history.settings.users = ['never_loses']
  env.api.saveSettings(history)
  env.api.setEnabled(state, true)
  await history.restorePromise

  const makeReply = (user, text, id, parent, { role = '', displayName = user, color = 'red' } = {}) => {
    const msg = env.message(user, text, role, id)
    const author = msg.authorContainer.querySelector('[data-a-target="chat-message-username"]')
    author.textContent = displayName
    author.style.color = color
    msg.line.__reactFiber$1 = {
      memoizedProps: {
        message: { id, user: { userLogin: user, userDisplayName: displayName }, reply: parent },
      },
    }
    scroller.appendChild(msg.line)
    return msg
  }

  // Case 1: Orphan Target A (NeVeR_LosEs, color restored from IndexedDB) right above captured Target B (raiki_raibao)
  makeReply('viewer_a1', '笑死', 'oa-1', {
    parentMsgId: 'p-unseen-a', parentUserLogin: 'never_loses', parentDisplayName: 'NeVeR_LosEs', parentMessageBody: 'shaxy101', parentDeleted: false,
  })
  makeReply('viewer_a2', '+1', 'oa-2', {
    parentMsgId: 'p-unseen-a', parentUserLogin: 'never_loses', parentDisplayName: 'NeVeR_LosEs', parentMessageBody: 'shaxy101', parentDeleted: false,
  })
  const targetB = env.message('raiki_raibao', '喜歡都可以說的唷', 'Moderator', 'p-live-b')
  const targetBAuthor = targetB.authorContainer.querySelector('[data-a-target="chat-message-username"]')
  targetBAuthor.textContent = '來希'
  targetBAuthor.style.color = 'rgb(255, 128, 200)'
  scroller.appendChild(targetB.line)
  makeReply('viewer_b1', '真的', 'ob-1', {
    parentMsgId: 'p-live-b', parentUserLogin: 'raiki_raibao', parentDisplayName: '來希', parentMessageBody: '喜歡都可以說的唷', parentDeleted: false,
  })

  // Case 2: Live remembered VIP color -> Target C (vip_target) unseen parent AND Target D (mod_d) replying to Target C
  const liveVip = env.message('vip_target', '先行離席', 'VIP', 'p-vip-seen')
  liveVip.authorContainer.querySelector('[data-a-target="chat-message-username"]').style.color = 'rgb(100, 200, 255)'
  scroller.appendChild(liveVip.line)
  makeReply('viewer_c1', '掰掰', 'oc-1', {
    parentMsgId: 'p-unseen-vip', parentUserLogin: 'vip_target', parentDisplayName: 'VIPTarget', parentMessageBody: '大家晚安', parentDeleted: false,
  })
  makeReply('mod_d', '晚安路上小心', 'p-mod-d', {
    parentMsgId: 'p-unseen-vip', parentUserLogin: 'vip_target', parentDisplayName: 'VIPTarget', parentMessageBody: '大家晚安', parentDeleted: false,
  }, { role: 'Moderator', displayName: 'ModD' })
  makeReply('viewer_d1', '管理員也晚安', 'od-1', {
    parentMsgId: 'p-mod-d', parentUserLogin: 'mod_d', parentDisplayName: 'ModD', parentMessageBody: '晚安路上小心', parentDeleted: false,
  })

  // Case 3: Deleted orphan parent renders 訊息已刪除 placeholder with .ttc-reply-deleted
  makeReply('viewer_del', '刪了什麼', 'odel-1', {
    parentMsgId: 'p-unseen-del', parentUserLogin: 'mod_d', parentDisplayName: 'ModD', parentMessageBody: '', parentDeleted: true,
  })

  env.api.captureTree(scroller, history)
  env.api.renderMessages(state, true)

  const orphanGroups = state.list.querySelectorAll('.ttc-reply-group')
  assert.equal(orphanGroups.length, 3)

  // Verify orphan Target A (never_loses) sits cleanly before captured Target B's .ttc-thread
  const [groupA, groupVip, groupDel] = orphanGroups
  const targetBThread = history.ids.get('p-live-b').view.closest('.ttc-thread')
  assert.ok(targetBThread)
  const listChildren = state.list.children
  assert.equal(listChildren.indexOf(targetBThread), listChildren.indexOf(groupA) + 1)

  const rowA = groupA.querySelector('.ttc-orphan-message')
  assert.ok(rowA)
  assert.equal(groupA.querySelector('.ttc-orphan-head').querySelector('.ttc-reply'), null)
  assert.equal(rowA.querySelector('.ttc-orphan-tag').textContent, '原留言')
  assert.equal(rowA.querySelector('.ttc-orphan-author').textContent, 'NeVeR_LosEs')
  assert.equal(rowA.querySelector('.ttc-orphan-author').style.color, 'rgb(255, 117, 181)')
  assert.equal(rowA.querySelector('.ttc-orphan-body').textContent, 'shaxy101')
  assert.equal(groupA.querySelector('.ttc-replies-toggle').textContent, '2 則回覆')
  assert.equal(targetBThread.querySelector('.ttc-replies-toggle').textContent, '1 則回覆')

  // Verify Target D (mod_d) replying to orphan Target C (vip_target) retains its own separate .ttc-thread
  const rowVip = groupVip.querySelector('.ttc-orphan-message')
  assert.equal(rowVip.querySelector('.ttc-orphan-author').textContent, 'VIPTarget (vip_target)')
  assert.equal(rowVip.querySelector('.ttc-orphan-author').style.color, 'rgb(100, 200, 255)')
  assert.equal(groupVip.querySelector('.ttc-replies-toggle').textContent, '1 則回覆')
  const modDView = history.ids.get('p-mod-d').view
  const modDThread = modDView.closest('.ttc-thread')
  assert.ok(modDThread)
  assert.notEqual(modDThread, groupVip)
  assert.ok(modDView.querySelector('.ttc-reply'), 'target reply retains its own reply quote bar')
  assert.equal(modDThread.querySelector('.ttc-replies-toggle').textContent, '1 則回覆')

  // Verify deleted orphan parent placeholder
  const delBody = groupDel.querySelector('.ttc-orphan-body')
  assert.equal(delBody.classList.contains('ttc-reply-deleted'), true)
  assert.equal(delBody.textContent, '訊息已刪除')

  // Verify CSS styles for orphan groups and tags without quote-bar overrides
  const cssText = env.document.head.querySelector('style').textContent
  assert.match(cssText, /\.ttc-reply-group:hover/)
  assert.match(cssText, /\.ttc-orphan-tag/)
  assert.equal(/\.ttc-orphan-head > \.ttc-reply/.test(cssText), false)
  env.api.unmount()
})

test('Twitch target-to-missing-target replies: reconstruct standalone orphan parent rows even with 0 viewer replies and sync incremental upgrades/removals', async () => {
  const database = fakeIndexedDB()
  const seed = boot({ database })
  const seedScroller = seed.document.createElement('div')
  seedScroller.setAttribute('data-a-target', 'chat-scroller')
  const seedHistory = seed.api.getHistory('sample_channel')
  seedHistory.settings.users = ['never_loses']
  seed.api.saveSettings(seedHistory)
  await seedHistory.restorePromise

  const prevTargetA = seed.message('never_loses', '早安', '', 'prev-a')
  const prevAuthor = prevTargetA.authorContainer.querySelector('[data-a-target="chat-message-username"]')
  prevAuthor.textContent = 'NeVeR_LosEs'
  prevAuthor.style.color = 'rgb(255, 117, 181)'
  seedScroller.appendChild(prevTargetA.line)
  seed.api.captureLine(prevTargetA.line, seedHistory)

  const lateBcA = seed.message('sample_channel', '舊實況主公告', '', 'late-bc-a')
  seedScroller.appendChild(lateBcA.line)
  seed.api.captureLine(lateBcA.line, seedHistory)
  await seed.api.flushHistory(seedHistory)

  const env = boot({ database })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')
  env.api.refresh()
  const state = env.api.mounted
  const history = state.history
  history.settings.users = ['never_loses']
  history.settings.excludedUsers = ['bad_target']
  env.api.saveSettings(history)
  env.api.setEnabled(state, true)

  const makeReply = (user, text, id, parent, { role = '', displayName = user, color = 'red' } = {}) => {
    const msg = env.message(user, text, role, id)
    const author = msg.authorContainer.querySelector('[data-a-target="chat-message-username"]')
    author.textContent = displayName
    author.style.color = color
    msg.line.__reactFiber$1 = {
      memoizedProps: {
        message: { id, user: { userLogin: user, userDisplayName: displayName }, reply: parent },
      },
    }
    scroller.appendChild(msg.line)
    return msg
  }

  // Target B (raiki_raibao, Mod) replies to missing Target A (never_loses) with 0 viewer replies
  makeReply('raiki_raibao', '喜歡都可以說的唷', 'p-target-b', {
    parentMsgId: 'p-unseen-a', parentUserLogin: 'never_loses', parentDisplayName: 'NeVeR_LosEs', parentMessageBody: 'shaxy101', parentDeleted: false,
  }, { role: 'Moderator', displayName: '來希', color: 'rgb(255, 169, 202)' })

  // Target B2 (vip_b, VIP) replies to missing Broadcaster late-bc-a (0 viewer replies) whose real message arrives on restorePromise
  makeReply('vip_b', '收到實況主', 'p-vip-b2', {
    parentMsgId: 'late-bc-a', parentUserLogin: 'sample_channel', parentDisplayName: '實況主', parentMessageBody: '舊實況主公告', parentDeleted: false,
  }, { role: 'VIP', displayName: 'VIP_B' })

  // Negative cases: Mod replies to ordinary non-target viewer or excluded user -> must NEVER create orphan groups
  makeReply('raiki_raibao', '回一般觀眾', 'p-target-ord', {
    parentMsgId: 'ord-1', parentUserLogin: 'ordinary_user', parentDisplayName: '一般人', parentMessageBody: '嗨', parentDeleted: false,
  }, { role: 'Moderator', displayName: '來希' })
  makeReply('raiki_raibao', '回排除帳號', 'p-target-ex', {
    parentMsgId: 'ex-1', parentUserLogin: 'bad_target', parentDisplayName: '排除人', parentMessageBody: '廣告', parentDeleted: false,
  }, { role: 'Moderator', displayName: '來希' })

  env.api.captureTree(scroller, history)
  env.api.renderMessages(state, true)

  // Before restorePromise: never_loses and late-bc-a each produce a standalone .ttc-reply-group directly above their Target B
  const initialGroups = state.list.querySelectorAll('.ttc-reply-group')
  assert.equal(initialGroups.length, 2)
  const [groupA, groupBc] = initialGroups
  const targetBView = history.ids.get('p-target-b').view
  const vipB2View = history.ids.get('p-vip-b2').view
  assert.equal(state.list.children.indexOf(targetBView), state.list.children.indexOf(groupA) + 1)
  assert.equal(state.list.children.indexOf(vipB2View), state.list.children.indexOf(groupBc) + 1)

  const rowA = groupA.querySelector('.ttc-orphan-message')
  assert.ok(rowA)
  assert.equal(rowA.classList.contains('ttc-has-replies'), false)
  assert.equal(groupA.querySelector('.ttc-orphan-head').querySelector('.ttc-reply'), null)
  assert.equal(rowA.querySelector('.ttc-orphan-tag').textContent, '原留言')
  assert.equal(rowA.querySelector('.ttc-orphan-author').textContent, 'NeVeR_LosEs')
  assert.equal(rowA.querySelector('.ttc-orphan-body').textContent, 'shaxy101')
  const toggleA = groupA.querySelector('.ttc-replies-toggle')
  const panelA = groupA.querySelector('.ttc-replies')
  assert.equal(toggleA.hidden, true)
  assert.equal(toggleA.matches('[hidden]'), true)
  assert.equal(panelA.hidden, true)
  assert.equal(panelA.matches('[hidden]'), true)
  assert.ok(targetBView.querySelector('.ttc-reply'), 'Target B retains its own reply quote')
  assert.equal(state.count.textContent, '4 則', 'synthetic orphan rows do not inflate retained count')

  // Completing restorePromise restores prev-a (author color) and real late-bc-a (replacing late-bc-a orphan group cleanly)
  await history.restorePromise
  const restoredGroups = state.list.querySelectorAll('.ttc-reply-group')
  assert.equal(restoredGroups.length, 1, 'late-bc-a orphan group replaced cleanly once real message restores')
  const restoredGroupA = restoredGroups[0]
  assert.equal(restoredGroupA.querySelector('.ttc-orphan-author').style.color, 'rgb(255, 117, 181)')
  assert.equal(state.list.children.indexOf(history.ids.get('p-target-b').view), state.list.children.indexOf(restoredGroupA) + 1)
  assert.equal(history.ids.get('late-bc-a').view.parentElement, state.list)
  assert.equal(state.count.textContent, '6 則')

  // Unchecking "回覆篩選目標" still preserves Target A's standalone orphan row above Target B
  const repliesCheckbox = state.panel.querySelector('[name="replies"]')
  repliesCheckbox.checked = false
  repliesCheckbox.listeners.get('change')()
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 1)
  assert.equal(state.count.textContent, '6 則')

  // Re-enabling replies and adding a viewer reply incrementally WITHOUT full scan reuses the exact same .ttc-reply-group and shows toggle
  repliesCheckbox.checked = true
  repliesCheckbox.listeners.get('change')()
  const groupBeforeUpgrade = state.list.querySelector('.ttc-reply-group')

  history.messages[Symbol.iterator] = () => { throw Error('unexpected full history scan') }
  makeReply('viewer_1', '笑死', 'v-to-a', {
    parentMsgId: 'p-unseen-a', parentUserLogin: 'never_loses', parentDisplayName: 'NeVeR_LosEs', parentMessageBody: 'shaxy101', parentDeleted: false,
  })
  env.api.captureLine(scroller.lastElementChild, history)
  env.api.renderMessages(state)
  delete history.messages[Symbol.iterator]

  const groupAfterUpgrade = state.list.querySelector('.ttc-reply-group')
  assert.equal(groupAfterUpgrade, groupBeforeUpgrade, 'viewer reply reuses existing anchored orphan group')
  assert.equal(groupAfterUpgrade.querySelector('.ttc-orphan-message').classList.contains('ttc-has-replies'), true)
  const upgradedToggle = groupAfterUpgrade.querySelector('.ttc-replies-toggle')
  const upgradedPanel = groupAfterUpgrade.querySelector('.ttc-replies')
  assert.equal(upgradedToggle.hidden, false)
  assert.equal(upgradedToggle.getAttribute('hidden'), null)
  assert.equal(upgradedToggle.textContent, '1 則回覆')
  assert.equal(upgradedPanel.getAttribute('hidden'), 'until-found')
  upgradedToggle.listeners.get('click')()
  assert.equal(upgradedPanel.getAttribute('hidden'), null)
  assert.equal(state.count.textContent, '7 則')

  // Removing viewer_1 incrementally keeps Target A's group (anchored by Target B) and re-hides toggle & collapses panel
  const viewerRecord = history.ids.get('v-to-a')
  history.messages = history.messages.filter(r => r !== viewerRecord)
  history.removed.add(viewerRecord)
  viewerRecord.retained = false
  history.ids.delete('v-to-a')
  env.api.renderMessages(state)
  const groupAfterViewerRemoved = state.list.querySelector('.ttc-reply-group')
  assert.equal(groupAfterViewerRemoved, groupBeforeUpgrade)
  assert.equal(groupAfterViewerRemoved.querySelector('.ttc-replies-toggle').hidden, true)
  assert.equal(groupAfterViewerRemoved.querySelector('.ttc-replies-toggle').matches('[hidden]'), true)
  assert.equal(groupAfterViewerRemoved.querySelector('.ttc-replies').hidden, true)
  assert.equal(groupAfterViewerRemoved.querySelector('.ttc-replies').matches('[hidden]'), true)
  assert.equal(groupAfterViewerRemoved.querySelector('.ttc-orphan-message').classList.contains('ttc-has-replies'), false)

  // Adding a second target anchor referencing the same missing Target A does not duplicate the orphan group
  makeReply('vip_b', '我也看到', 'p-vip-b3', {
    parentMsgId: 'p-unseen-a', parentUserLogin: 'never_loses', parentDisplayName: 'NeVeR_LosEs', parentMessageBody: 'shaxy101', parentDeleted: false,
  }, { role: 'VIP', displayName: 'VIP_B' })
  env.api.captureLine(scroller.lastElementChild, history)
  env.api.renderMessages(state)
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 1)

  // Deactivating Target A (removing never_loses) drops its orphan group while Target B keeps its reply quote
  history.settings.users = []
  env.api.renderMessages(state, true)
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 0)
  assert.ok(history.ids.get('p-target-b').view.querySelector('.ttc-reply'))

  // Re-activating never_loses restores Target A's single orphan group
  history.settings.users = ['never_loses']
  env.api.renderMessages(state, true)
  assert.equal(state.list.querySelectorAll('.ttc-reply-group').length, 1)

  // Evicting real late-bc-a (0 viewer replies, referenced only by p-vip-b2) converts late-bc-a into a standalone orphan group above p-vip-b2
  const lateBcRecord = history.ids.get('late-bc-a')
  history.messages = history.messages.filter(r => r !== lateBcRecord)
  history.removed.add(lateBcRecord)
  lateBcRecord.retained = false
  history.ids.delete('late-bc-a')
  env.api.renderMessages(state)
  const finalGroups = state.list.querySelectorAll('.ttc-reply-group')
  assert.equal(finalGroups.length, 2)
  const evictedBcGroup = finalGroups.find(group => group.querySelector('.ttc-orphan-body').textContent === '舊實況主公告')
  assert.ok(evictedBcGroup)
  assert.equal(evictedBcGroup.querySelector('.ttc-replies-toggle').hidden, true)
  assert.equal(state.list.children.indexOf(history.ids.get('p-vip-b2').view), state.list.children.indexOf(evictedBcGroup) + 1)

  // Closing filter panel keeps 0-reply orphan groups hidden (not until-found)
  env.api.setEnabled(state, false)
  for (const group of finalGroups) {
    const panel = group.querySelector('.ttc-replies')
    assert.equal(panel.hidden, true)
    assert.equal(panel.matches('[hidden]'), true)
    assert.equal(panel.getAttribute('hidden'), null)
  }

  env.api.unmount()
})

test('Twitch filter layer: cover full chat bounds between header and input despite native banners and column collapse', () => {
  const env = boot({ withResizeObserver: true })
  const rightCol = env.document.body.appendChild(new env.Element('div'))
  rightCol.className = 'right-column'
  const stream = rightCol.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const input = stream.appendChild(new env.Element('div'))
  input.className = 'chat-input'
  const panel = env.document.createElement('div')
  panel.showPopover = () => {}
  panel.hidePopover = () => {}

  let streamBox = { left: 1205, top: 0, width: 340, height: 765, bottom: 765 }
  let headerBox = { top: 0, bottom: 40, height: 40 }
  let hostBox = { left: 1205, top: 111, width: 340, height: 565, bottom: 676 }
  let inputBox = { top: 676, bottom: 765, height: 89 }
  stream.getBoundingClientRect = () => streamBox
  header.getBoundingClientRect = () => headerBox
  host.getBoundingClientRect = () => hostBox
  input.getBoundingClientRect = () => inputBox

  const state = { panel, stream, header, host }
  env.api.setMounted(state)
  env.api.setPanelLayer(state, true)
  assert.equal(panel.style.left, '1205px')
  assert.equal(panel.style.top, '40px')
  assert.equal(panel.style.width, '340px')
  assert.equal(panel.style.height, '636px', 'ignores 71px native banner shrinking host')
  assert.equal(panel.style.visibility, '')
  assert.equal(panel.style.pointerEvents, '')

  // Banner growth/collapse updates host without shifting .ttc-panel
  hostBox = { left: 1205, top: 190, width: 340, height: 486, bottom: 676 }
  env.observers[0].notify()
  env.flushFrames()
  assert.equal(panel.style.top, '40px')
  assert.equal(panel.style.height, '636px')

  // Chat input height change updates bottom cleanly
  inputBox = { top: 640, bottom: 765, height: 125 }
  env.api.positionFilterPanel(state)
  assert.equal(panel.style.height, '600px')

  // Theater / sidebar transitionend repositions after column shifts
  streamBox = { left: 1100, top: 0, width: 340, height: 765, bottom: 765 }
  rightCol.listeners.get('transitionend')({ target: rightCol })
  env.flushFrames()
  assert.equal(panel.style.left, '1100px')

  // Collapsing chat column hides popover instead of stranding an empty box over video
  streamBox = { left: 1440, top: 0, width: 0, height: 0, bottom: 0 }
  hostBox = { left: 1440, top: 0, width: 0, height: 0, bottom: 0 }
  env.document.listeners.get('fullscreenchange')()
  env.flushFrames()
  assert.equal(panel.style.visibility, 'hidden')
  assert.equal(panel.style.pointerEvents, 'none')
  assert.equal(panel.style.width, '0px')
  assert.equal(panel.style.height, '0px')

  // Re-expanding column restores visible overlay
  streamBox = { left: 1205, top: 0, width: 340, height: 765, bottom: 765 }
  hostBox = { left: 1205, top: 40, width: 340, height: 636, bottom: 676 }
  env.api.positionFilterPanel(state)
  assert.equal(panel.style.visibility, '')
  assert.equal(panel.style.pointerEvents, '')
  assert.equal(panel.style.height, '600px')

  // Fallback without .chat-input (VOD / fixture layout) uses host bottom
  input.remove()
  hostBox = { left: 1205, top: 60, width: 340, height: 500, bottom: 560 }
  headerBox = { top: 0, bottom: 60, height: 60 }
  env.api.positionFilterPanel(state)
  assert.equal(panel.style.top, '60px')
  assert.equal(panel.style.height, '500px')

  env.api.setPanelLayer(state, false)
  assert.equal(panel.style.visibility, '')
  assert.equal(panel.style.pointerEvents, '')
  assert.equal(panel.style.position, '')
  env.api.setMounted(null)
})

test('Twitch scroll stability: avoid overflow-anchor: none, keep toggles anchored, and preserve paused position across evictions and reopen', () => {
  const env = boot({ withResizeObserver: true })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  const history = state.history

  const cssText = env.document.head.querySelector('style').textContent
  assert.equal(/\.ttc-list[^}]*overflow-anchor\s*:\s*none/i.test(cssText), false)

  // Provide deterministic vertical geometry for list and its children
  const rowHeight = child => {
    if (child.classList?.contains('ttc-thread') || child.classList?.contains('ttc-reply-group')) {
      const replyPanel = child.querySelector('.ttc-replies')
      const openReplies = replyPanel && !replyPanel.hidden ? replyPanel.querySelectorAll('.ttc-message').length * 30 : 0
      return 30 + openReplies
    }
    return 30
  }
  const LIST_TOP = 100
  state.list.clientHeight = 120
  state.list.scrollTop = 0
  Object.defineProperty(state.list, 'scrollHeight', {
    get() { return state.list.children.reduce((sum, child) => sum + rowHeight(child), 0) },
  })
  state.list.getBoundingClientRect = () => ({ top: LIST_TOP, bottom: LIST_TOP + state.list.clientHeight, height: state.list.clientHeight })
  const origAppend = state.list.appendChild.bind(state.list)
  const attachRowRect = node => {
    node.getBoundingClientRect = () => {
      let y = 0
      for (const child of state.list.children) {
        if (child === node) break
        y += rowHeight(child)
      }
      const h = rowHeight(node)
      const top = LIST_TOP + y - state.list.scrollTop
      return { top, bottom: top + h, height: h }
    }
    const origReplaceWith = node.replaceWith.bind(node)
    node.replaceWith = other => {
      attachRowRect(other)
      origReplaceWith(other)
    }
  }
  state.list.appendChild = child => {
    attachRowRect(child)
    return origAppend(child)
  }

  const makeReply = (user, text, id, parent) => {
    const msg = env.message(user, text, '', id)
    msg.line.__reactFiber$1 = {
      memoizedProps: {
        message: { id, user: { userLogin: user, userDisplayName: user }, reply: parent },
      },
    }
    return msg
  }

  // Fill 10 messages (m-0..m-9) + 3 viewer replies on m-9
  for (let i = 0; i < 10; i++) {
    env.api.captureLine(env.message('mod_a', `msg ${i}`, 'Moderator', `m-${i}`).line, history)
  }
  for (let r = 0; r < 3; r++) {
    env.api.captureLine(makeReply(`v_${r}`, `reply ${r}`, `r-${r}`, {
      parentMsgId: 'm-9', parentUserLogin: 'mod_a', parentDisplayName: 'ModA', parentMessageBody: 'msg 9', parentDeleted: false,
    }).line, history)
  }
  env.api.setEnabled(state, true)
  const thread9 = history.ids.get('m-9').view.closest('.ttc-thread')
  const head9 = thread9.querySelector('.ttc-thread-head')
  head9.getBoundingClientRect = () => {
    const t = thread9.getBoundingClientRect().top
    return { top: t, bottom: t + 30, height: 30 }
  }
  const toggle9 = thread9.querySelector('.ttc-replies-toggle')
  const panel9 = thread9.querySelector('.ttc-replies')

  // Simulate normal browser clamped scrollTop at bottom (scrollHeight - clientHeight = 300 - 120 = 180)
  state.list.scrollTop = 180
  const headBeforeExpand = head9.getBoundingClientRect().top - state.list.getBoundingClientRect().top
  toggle9.listeners.get('click')()
  env.flushFrames()
  const headAfterExpand = head9.getBoundingClientRect().top - state.list.getBoundingClientRect().top
  assert.equal(headAfterExpand, headBeforeExpand, 'expanding replies must keep thread header anchored')
  assert.equal(state.list.scrollTop, 180, 'expanding replies must not jump to new bottom')
  assert.equal(history.follow, false)
  assert.equal(state.latest.hidden, false)

  // Return to latest and trigger beforematch -> opens drawer without scheduling bottom jump
  toggle9.listeners.get('click')()
  state.latest.listeners.get('click')()
  assert.equal(history.follow, true)
  panel9.listeners.get('beforematch')()
  env.flushFrames()
  assert.equal(history.follow, false)
  assert.equal(state.latest.hidden, false)
  assert.equal(panel9.getAttribute('hidden'), null)

  // pointerdown on reply toggle / links and non-scroll keys must not mark readerScrollIntent
  state.readerScrollIntent = false
  state.list.listeners.get('pointerdown')({ target: toggle9 })
  assert.equal(state.readerScrollIntent, false)
  const fakeLink = new env.Element('a')
  toggle9.appendChild(fakeLink)
  state.list.listeners.get('pointerdown')({ target: fakeLink })
  assert.equal(state.readerScrollIntent, false)
  state.list.listeners.get('keydown')({ key: 'Control' })
  assert.equal(state.readerScrollIntent, false)

  // Pause reading at m-500 after growing to 1000 messages (m-9 has a 90px open drawer)
  for (let i = 10; i < 1000; i++) {
    env.api.captureLine(env.message('mod_a', `msg ${i}`, 'Moderator', `m-${i}`).line, history)
  }
  state.latest.listeners.get('click')()
  state.list.listeners.get('wheel')({})
  state.list.scrollTop = 500 * 30 + 90
  state.list.listeners.get('scroll')()
  assert.equal(history.follow, false)
  const row500 = history.ids.get('m-500').view
  assert.equal(row500.getBoundingClientRect().top, LIST_TOP)

  // Remove 5 oldest retained records (150px) with no full scan -> m-500 stays pinned at LIST_TOP
  for (const rec of history.messages.splice(0, 5)) {
    rec.retained = false
    history.ids.delete(rec.id)
    history.removed.add(rec)
  }
  history.messages[Symbol.iterator] = () => { throw Error('unexpected full history scan') }
  for (let i = 1000; i < 1005; i++) {
    env.api.captureLine(env.message('mod_a', `msg ${i}`, 'Moderator', `m-${i}`).line, history)
  }
  env.api.renderMessages(state)
  delete history.messages[Symbol.iterator]
  assert.equal(state.list.scrollTop, 495 * 30 + 90)
  assert.equal(row500.getBoundingClientRect().top, LIST_TOP)
  assert.equal(state.locationPinned, true)

  // Deferred scroll event after programmatic restore must not clobber paused follow state
  state.readerScrollIntent = false
  state.list.listeners.get('scroll')()
  assert.equal(history.follow, false)

  // Closing (display:none resets scrollTop to 0 and collapses m-9's 90px open drawer) and reopening keeps m-500 anchored at LIST_TOP
  env.api.setEnabled(state, false)
  state.list.scrollTop = 0
  env.api.setEnabled(state, true)
  assert.equal(history.follow, false)
  assert.equal(state.list.scrollTop, 495 * 30)
  assert.equal(row500.getBoundingClientRect().top, LIST_TOP)

  env.api.unmount()
})

test('Twitch split-screen compact UI: keep header visible, hide banners and input buttons, dismiss tooltip when button hidden, expand filter panel', () => {
  const env = boot({ withResizeObserver: true })
  env.window.innerWidth = 669
  env.window.innerHeight = 636
  const styleText = env.document.head.querySelector('style').textContent

  assert.doesNotMatch(styleText, /\.right-column--below[^}]*\.right-column__toggle-visibility/)
  assert.doesNotMatch(styleText, /\.right-column--below[^}]*\.stream-chat-header/)
  assert.doesNotMatch(styleText, /\.right-column--below[^}]*\.video-chat__header/)
  assert.match(styleText, /\.right-column--below\s+\.chat-room__content\s*>\s*:has\(~\s*\[class\*="chat-list--"\]\)/)
  assert.match(styleText, /\.right-column--below\s+\.chat-room__notifications/)
  assert.match(styleText, /\.right-column--below\s+\.chat-room__overlay/)
  assert.match(styleText, /\.right-column--below\s+:is\(\.chat-input__buttons-container,\s*\[data-test-selector="chat-input-buttons-container"\]\)/)
  assert.match(styleText, /\.right-column--below\s+\.chat-scrollable-area__message-container\s*\{\s*padding-top:\s*0\s*!important;\s*\}/)

  const rightCol = env.document.body.appendChild(new env.Element('div'))
  rightCol.className = 'right-column right-column--theatre right-column--below'
  const stream = rightCol.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')
  const input = stream.appendChild(new env.Element('div'))
  input.className = 'chat-input'

  env.api.refresh()
  const state = env.api.mounted
  assert.ok(state)
  const { button, panel } = state

  // Verify background message capture works while mounted inside .right-column--below
  const modLine = env.message('mod_split', 'split screen msg', 'moderator', 'split-1').line
  scroller.appendChild(modLine)
  assert.equal(env.api.captureLine(modLine, state.history), true)
  assert.equal(state.history.messages.length, 1)

  // Tooltip closes cleanly when button collapses to 0x0 (e.g. collapsed chat column)
  let tooltipCloses = 0
  const { tooltip } = state
  tooltip.showPopover = () => {}
  tooltip.hidePopover = () => { tooltipCloses++ }
  tooltip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 28, right: 120, bottom: 28 })
  button.getBoundingClientRect = () => ({ left: 581, top: 380, width: 32, height: 32, right: 613, bottom: 412 })
  button.listeners.get('mouseenter')()
  env.flushFrames()
  assert.equal(tooltip.getAttribute('data-visible'), 'true')

  button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 })
  env.listeners.get('resize')()
  env.flushFrames()
  assert.equal(tooltip.getAttribute('data-visible'), 'false')
  assert.equal(tooltipCloses, 1)

  // Opening tooltip while button already has 0x0 rect dismisses immediately instead of positioning at (8, 11)
  button.listeners.get('mouseenter')()
  env.flushFrames()
  assert.equal(tooltip.getAttribute('data-visible'), 'false')
  assert.equal(tooltipCloses, 2)

  // Active filter panel keeps the 40px header boundary and expands into reclaimed input-button space, restoring when full input returns
  panel.showPopover = () => {}
  panel.hidePopover = () => {}
  let streamBox = { left: 0, top: 376, width: 669, height: 260, bottom: 636 }
  let headerBox = { top: 376, bottom: 416, height: 40 }
  let hostBox = { left: 0, top: 416, width: 669, height: 171, bottom: 587 }
  let inputBox = { top: 587, bottom: 636, height: 49 }
  stream.getBoundingClientRect = () => streamBox
  header.getBoundingClientRect = () => headerBox
  host.getBoundingClientRect = () => hostBox
  input.getBoundingClientRect = () => inputBox

  env.api.setEnabled(state, true)
  assert.equal(panel.style.top, '416px')
  assert.equal(panel.style.height, '171px')

  inputBox = { top: 547, bottom: 636, height: 89 }
  env.api.positionFilterPanel(state)
  assert.equal(panel.style.top, '416px')
  assert.equal(panel.style.height, '131px')

  env.api.unmount()
})

test('Twitch VOD timeline: display and sort by video offset from fiber/DOM, deduplicate via fiber comment id, skip capture date dividers, and persist across reload', async () => {
  const database = fakeIndexedDB()
  const day1 = new Date(2026, 10, 20, 14, 0, 0).getTime()
  const day2 = new Date(2026, 10, 21, 9, 30, 0).getTime()
  let now = day1

  const setupVodPage = env => {
    env.location.pathname = '/videos/2937944840'
    const info = env.document.body.appendChild(new env.Element('div'))
    info.className = 'channel-info-content'
    const ownerLink = info.appendChild(new env.Element('a'))
    ownerLink.setAttribute('href', '/vod_owner')
    const vodChat = env.document.body.appendChild(new env.Element('div'))
    vodChat.className = 'video-chat'
    const vodHeader = vodChat.appendChild(new env.Element('div'))
    vodHeader.className = 'video-chat__header'
    const vodBody = vodChat.appendChild(new env.Element('div'))
    const wrapper = vodBody.appendChild(new env.Element('div'))
    wrapper.className = 'video-chat__message-list-wrapper'
    const scroller = wrapper.appendChild(new env.Element('ul'))
    return scroller
  }

  const makeVodLine = (env, scroller, user, text, { headerTimestamp = '', nestedButtonTs = false, fiber = null } = {}) => {
    const line = scroller.appendChild(new env.Element('div'))
    line.className = 'vod-message'
    if (headerTimestamp) {
      const hdr = line.appendChild(new env.Element('div'))
      hdr.className = 'vod-message__header'
      if (nestedButtonTs) {
        const btn = hdr.appendChild(new env.Element('button'))
        const p = btn.appendChild(new env.Element('p'))
        p.textContent = headerTimestamp
      } else {
        hdr.textContent = headerTimestamp
      }
    }
    const content = line.appendChild(new env.Element('div'))
    const authorLink = content.appendChild(new env.Element('a'))
    authorLink.className = 'video-chat__message-author'
    authorLink.setAttribute('href', `/${user}`)
    const author = authorLink.appendChild(new env.Element('span'))
    author.setAttribute('data-a-target', 'chat-message-username')
    author.setAttribute('data-a-user', user)
    author.textContent = user
    const msgBox = content.appendChild(new env.Element('div'))
    msgBox.className = 'video-chat__message'
    const body = msgBox.appendChild(new env.Element('span'))
    const frag = body.appendChild(new env.Element('span'))
    frag.className = 'text-fragment'
    frag.setAttribute('data-a-target', 'chat-message-text')
    frag.textContent = text
    if (fiber) line.__reactFiber$1 = fiber
    return line
  }

  const env1 = boot({ database, now: () => now })
  const scroller1 = setupVodPage(env1)
  env1.api.refresh()
  const state1 = env1.api.mounted
  await state1.history.restorePromise
  env1.api.setEnabled(state1, true)

  // Capture 4:55:31 via React fiber timeStampOffset + messageContext.comment.id on Day 1
  makeVodLine(env1, scroller1, 'vod_owner', 'vod late', {
    fiber: {
      return: {
        memoizedProps: {
          timeStampOffset: 17731,
          messageContext: {
            author: { login: 'vod_owner' },
            comment: { id: 'uuid-4h55m31s', contentOffset: 17731, commenter: { login: 'vod_owner' } },
          },
        },
      },
    },
  })
  env1.api.captureTree(scroller1, state1.history)
  env1.api.renderMessages(state1)
  assert.equal(state1.list.children.length, 1)
  const lateTime = state1.list.children[0].querySelector('.ttc-time')
  assert.equal(lateTime.textContent, '4:55:31')
  assert.equal(lateTime.getAttribute('datetime'), 'PT17731S')
  assert.equal(lateTime.getAttribute('title'), '影片時間 4:55:31')
  assert.equal(state1.list.children[0].getAttribute('data-date'), null)

  // Seek backward on Day 2 to 1:47 (nested DOM button>p timestamp) and 0:05 -> incrementally reorders to 0:05, 1:47, 4:55:31 with no date dividers
  now = day2
  makeVodLine(env1, scroller1, 'vod_owner', 'vod middle', {
    headerTimestamp: '1:47',
    nestedButtonTs: true,
    fiber: {
      memoizedProps: {
        messageContext: { comment: { id: 'uuid-1m47s', commenter: { login: 'vod_owner' } } },
      },
    },
  })
  makeVodLine(env1, scroller1, 'vod_owner', 'vod early', {
    headerTimestamp: '0:05',
    fiber: {
      memoizedProps: {
        messageContext: { comment: { id: 'uuid-5s', commenter: { login: 'vod_owner' } } },
      },
    },
  })
  env1.api.captureTree(scroller1, state1.history)
  env1.api.renderMessages(state1)
  assert.deepEqual(
    state1.list.children.map(row => row.querySelector('.ttc-time').textContent),
    ['0:05', '1:47', '4:55:31'],
  )
  for (const row of state1.list.children) assert.equal(row.getAttribute('data-date'), null)

  // Rewinding and re-capturing a fresh DOM node with the same fiber comment UUID deduplicates cleanly
  const replayClone = makeVodLine(env1, scroller1, 'vod_owner', 'vod late', {
    fiber: {
      memoizedProps: {
        timeStampOffset: 17731,
        messageContext: { comment: { id: 'uuid-4h55m31s', contentOffset: 17731, commenter: { login: 'vod_owner' } } },
      },
    },
  })
  assert.equal(env1.api.captureLine(replayClone, state1.history), false)
  assert.equal(state1.history.messages.length, 3)

  // Search mode preserves VOD timeline order and omits capture-date dividers
  state1.messageSearch.value = 'vod'
  state1.messageSearch.listeners.get('input')()
  assert.equal(state1.count.textContent, '3 則符合')
  assert.deepEqual(
    state1.list.children.map(row => row.querySelector('.ttc-time').textContent),
    ['0:05', '1:47', '4:55:31'],
  )
  for (const row of state1.list.children) assert.equal(row.getAttribute('data-date'), null)

  // Mismatched fiber commenter login must not leak another user's offset onto an unrelated message
  const mismatched = makeVodLine(env1, scroller1, 'vod_owner', 'vod mismatched fiber', {
    headerTimestamp: 'invalid:ts',
    fiber: {
      memoizedProps: {
        timeStampOffset: 999,
        messageContext: { comment: { id: 'wrong-user-id', contentOffset: 999, commenter: { login: 'someone_else' } } },
      },
    },
  })
  const parsedMismatch = env1.api.readMessage(mismatched, 'vod_owner', state1.history, true)
  assert.equal(parsedMismatch.id, '')
  assert.equal(parsedMismatch.vodOffset, null)

  await env1.api.flushHistory(state1.history)
  env1.api.unmount()

  // Reload in fresh VM -> IndexedDB restore preserves vodOffset, timestamps, timeline sort, and no date dividers
  const env2 = boot({ database, now: () => now })
  setupVodPage(env2)
  env2.api.refresh()
  const state2 = env2.api.mounted
  await state2.history.restorePromise
  env2.api.setEnabled(state2, true)
  assert.equal(state2.count.textContent, '3 則')
  assert.deepEqual(
    state2.list.children.map(row => row.querySelector('.ttc-time').textContent),
    ['0:05', '1:47', '4:55:31'],
  )
  assert.equal(state2.list.children[2].querySelector('.ttc-time').getAttribute('datetime'), 'PT17731S')
  for (const row of state2.list.children) assert.equal(row.getAttribute('data-date'), null)
  env2.api.unmount()
})

test('Twitch VOD flat filtering: do not create VOD reply threads, reject mismatched fiber author, and clean up legacy inferred VOD replies on reload', async () => {
  const database = fakeIndexedDB()
  let now = new Date(2026, 10, 23, 6, 15, 0).getTime()

  const setupVodPage = env => {
    env.location.pathname = '/videos/2937944840'
    const info = env.document.body.appendChild(new env.Element('div'))
    info.className = 'channel-info-content'
    const ownerLink = info.appendChild(new env.Element('a'))
    ownerLink.setAttribute('href', '/vod_owner')
    const vodChat = env.document.body.appendChild(new env.Element('div'))
    vodChat.className = 'video-chat'
    const vodHeader = vodChat.appendChild(new env.Element('div'))
    vodHeader.className = 'video-chat__header'
    const vodBody = vodChat.appendChild(new env.Element('div'))
    const wrapper = vodBody.appendChild(new env.Element('div'))
    wrapper.className = 'video-chat__message-list-wrapper'
    const scroller = wrapper.appendChild(new env.Element('ul'))
    return scroller
  }

  const formatTs = offset => {
    const h = Math.floor(offset / 3600)
    const m = Math.floor((offset % 3600) / 60)
    const s = offset % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  }

  const makeVodMsg = (env, scroller, {
    user, displayName = user, color = '', id = '', offset,
    tokens = null, mentionPrefix = '', bodyText = '', emoteAlt = '', midMention = '',
    withFiber = true, fiberAuthorName = user,
  }) => {
    const line = scroller.appendChild(new env.Element('div'))
    line.className = 'vod-message'
    const hdr = line.appendChild(new env.Element('div'))
    hdr.className = 'vod-message__header'
    const btn = hdr.appendChild(new env.Element('button'))
    const p = btn.appendChild(new env.Element('p'))
    p.textContent = formatTs(offset)

    const content = line.appendChild(new env.Element('div'))
    const authorLink = content.appendChild(new env.Element('a'))
    authorLink.className = 'video-chat__message-author'
    authorLink.setAttribute('href', `/${user}`)
    const author = authorLink.appendChild(new env.Element('span'))
    author.setAttribute('data-a-target', 'chat-message-username')
    author.setAttribute('data-a-user', user)
    author.textContent = displayName
    if (color) author.style.color = color

    const msgBox = content.appendChild(new env.Element('div'))
    msgBox.className = 'video-chat__message'
    const colon = msgBox.appendChild(new env.Element('span'))
    colon.textContent = ':'
    const body = msgBox.appendChild(new env.Element('span'))

    if (mentionPrefix) {
      const m = body.appendChild(new env.Element('span'))
      m.className = 'mention-fragment'
      m.setAttribute('data-a-target', 'chat-message-mention')
      m.textContent = `@${mentionPrefix}`
    }
    if (bodyText) {
      const frag = body.appendChild(new env.Element('span'))
      frag.className = 'text-fragment'
      frag.setAttribute('data-a-target', 'chat-message-text')
      frag.textContent = bodyText
    }
    if (midMention) {
      const m = body.appendChild(new env.Element('span'))
      m.className = 'mention-fragment'
      m.setAttribute('data-a-target', 'chat-message-mention')
      m.textContent = `@${midMention}`
      const tail = body.appendChild(new env.Element('span'))
      tail.className = 'text-fragment'
      tail.setAttribute('data-a-target', 'chat-message-text')
      tail.textContent = ' 好強'
    }
    if (emoteAlt) {
      const emoteWrap = body.appendChild(new env.Element('div'))
      const img = emoteWrap.appendChild(new env.Element('img'))
      img.className = 'chat-image'
      img.setAttribute('alt', emoteAlt)
      img.setAttribute('src', 'https://static-cdn.jtvnw.net/emoticons/v2/41/default/dark/1.0')
    }

    if (withFiber) {
      const msgTokens = tokens || [
        ...(bodyText ? [{ type: 0, content: bodyText }] : []),
      ]
      line.__reactFiber$1 = {
        return: {
          memoizedProps: {
            timeStampOffset: offset,
            messageContext: {
              author: { id: `${user}-uid`, name: fiberAuthorName, displayName },
              comment: {
                id,
                contentOffset: offset,
                commenter: '123456',
                message: { tokens: msgTokens },
              },
            },
          },
        },
      }
    }
    return line
  }

  const saved = JSON.stringify({
    broadcaster: true, moderators: true, vip: true, replies: true,
    users: ['mea_07311', 'never_loses'], excludedUsers: [],
  })
  const env1 = boot({ saved, database, now: () => now })
  const scroller1 = setupVodPage(env1)
  env1.api.refresh()
  const state1 = env1.api.mounted
  await state1.history.restorePromise
  env1.api.setEnabled(state1, true)

  // 1. Target messages render flat; viewer @mentions (both leading and mid-message) are NOT captured into panel or folded
  makeVodMsg(env1, scroller1, {
    user: 'mea_07311', displayName: '小碗泡咪', color: '#C9E1FF',
    id: 'vod-p1', offset: 18377, bodyText: '外套好看',
  })
  makeVodMsg(env1, scroller1, {
    user: 'sss316070', displayName: '阿任',
    id: 'vod-r1', offset: 18383, mentionPrefix: '小碗泡咪', emoteAlt: 'gunoSiu',
    tokens: [{ type: 4, content: { recipient: '小碗泡咪', currentUserMentionRelation: 0 } }, { type: 6, content: { alt: 'gunoSiu' } }],
  })
  makeVodMsg(env1, scroller1, {
    user: 'hayger123', displayName: '西歐榔',
    id: 'vod-r2', offset: 18423, mentionPrefix: '小碗泡咪', bodyText: ' 7',
    withFiber: false,
  })
  makeVodMsg(env1, scroller1, {
    user: 'never_loses', displayName: 'NeVeR_LosEs',
    id: 'vod-tb', offset: 18428, mentionPrefix: '小碗泡咪', bodyText: ' 好害羞',
    tokens: [{ type: 4, content: { recipient: '小碗泡咪', currentUserMentionRelation: 0 } }, { type: 0, content: ' 好害羞' }],
  })
  makeVodMsg(env1, scroller1, {
    user: 'mid_user', id: 'vod-mid', offset: 18430, bodyText: '哈哈 ', midMention: '小碗泡咪',
    tokens: [{ type: 0, content: '哈哈 ' }, { type: 4, content: { recipient: '小碗泡咪' } }, { type: 0, content: ' 好強' }],
  })
  makeVodMsg(env1, scroller1, {
    user: 'mea_07311', displayName: '小碗泡咪', id: 'vod-self', offset: 18432,
    mentionPrefix: '小碗泡咪', bodyText: ' 自回測試',
    tokens: [{ type: 4, content: { recipient: '小碗泡咪' } }, { type: 0, content: ' 自回測試' }],
  })
  makeVodMsg(env1, scroller1, {
    user: 'v_non', id: 'vod-vnon', offset: 18434, mentionPrefix: 'other_user', bodyText: ' hi',
    tokens: [{ type: 4, content: { recipient: 'other_user' } }, { type: 0, content: ' hi' }],
  })
  makeVodMsg(env1, scroller1, {
    user: 'never_loses', displayName: 'NeVeR_LosEs', id: 'vod-tnon', offset: 18436,
    mentionPrefix: 'other_user', bodyText: ' Yo',
    tokens: [{ type: 4, content: { recipient: 'other_user' } }, { type: 0, content: ' Yo' }],
  })

  env1.api.captureTree(scroller1, state1.history)
  env1.api.renderMessages(state1)

  assert.equal(state1.history.messages.length, 4)
  assert.equal(state1.count.textContent, '4 則')
  assert.equal(state1.history.ids.has('vod-r1'), false)
  assert.equal(state1.history.messages.some(m => m.user === 'hayger123'), false)
  assert.equal(state1.history.ids.has('vod-mid'), false)
  assert.equal(state1.history.ids.has('vod-vnon'), false)
  assert.equal(state1.history.ids.get('vod-tb').reply, null)
  assert.equal(state1.history.ids.get('vod-self').reply, null)
  assert.equal(state1.history.ids.get('vod-tnon').reply, null)
  assert.equal(state1.list.querySelectorAll('.ttc-thread').length, 0)
  assert.equal(state1.list.querySelectorAll('.ttc-reply-group').length, 0)
  assert.equal(state1.list.querySelectorAll('.ttc-reply').length, 0)
  assert.equal(state1.history.ids.get('vod-tb').view.parentElement, state1.list)

  // 2. Rejects mismatched mc.author.name in VOD React fiber
  const badFiberLine = makeVodMsg(env1, scroller1, {
    user: 'vod_owner', id: 'vod-bad', offset: 18800, bodyText: 'mismatch',
    fiberAuthorName: 'someone_else',
  })
  badFiberLine.querySelector('.vod-message__header').querySelector('p').textContent = 'bad:ts'
  const parsedBad = env1.api.readMessage(badFiberLine, 'vod_owner', state1.history, true)
  assert.equal(parsedBad.id, '')
  assert.equal(parsedBad.vodOffset, null)
  badFiberLine.remove()

  await env1.api.flushHistory(state1.history)
  env1.api.unmount()

  // 3. Legacy saved VOD inferred reply records in IndexedDB are cleaned up on reload
  const scope = 'vod:2937944840'
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000
  database.records.set(JSON.stringify([scope, 'vod-legacy-viewer']), {
    scope,
    storageId: 'vod-legacy-viewer',
    id: 'vod-legacy-viewer',
    user: 'sss316070',
    createdAt: now,
    order: 99,
    expiresAt,
    vodOffset: 18385,
    broadcastAt: null,
    moderator: false,
    broadcaster: false,
    vip: false,
    reply: {
      parentId: 'vod-p1',
      parentUser: 'mea_07311',
      parentDisplayName: '小碗泡咪',
      parentText: '外套好看',
      parentDeleted: false,
      parentModerator: false,
      parentBroadcaster: false,
      parentVip: false,
      inferred: true,
    },
    fingerprint: 'legacy-viewer',
    tree: {
      tag: 'div',
      attributes: [['class', 'ttc-message ttc-has-reply']],
      styles: [],
      children: [
        { tag: 'div', attributes: [['class', 'ttc-reply']], styles: [], children: [{ text: '回覆 @小碗泡咪 (mea_07311): 外套好看' }] },
        { tag: 'time', attributes: [['class', 'ttc-time']], styles: [], children: [{ text: '5:06:25' }] },
        { tag: 'strong', attributes: [], styles: [], children: [{ text: '阿任 (sss316070)' }] },
        { text: ': ' },
        { tag: 'span', attributes: [], styles: [], children: [{ text: '@小碗泡咪 真的' }] },
      ],
    },
  })
  database.records.set(JSON.stringify([scope, 'vod-legacy-tb']), {
    scope,
    storageId: 'vod-legacy-tb',
    id: 'vod-legacy-tb',
    user: 'never_loses',
    createdAt: now,
    order: 100,
    expiresAt,
    vodOffset: 18440,
    broadcastAt: null,
    moderator: false,
    broadcaster: false,
    vip: false,
    reply: {
      parentId: 'vod-p1',
      parentUser: 'mea_07311',
      parentDisplayName: '小碗泡咪',
      parentText: '外套好看',
      parentDeleted: false,
      parentModerator: false,
      parentBroadcaster: false,
      parentVip: false,
      inferred: true,
    },
    fingerprint: 'legacy-tb',
    tree: {
      tag: 'div',
      attributes: [['class', 'ttc-message ttc-has-reply']],
      styles: [],
      children: [
        { tag: 'div', attributes: [['class', 'ttc-reply']], styles: [], children: [{ text: '回覆 @小碗泡咪 (mea_07311): 外套好看' }] },
        { tag: 'time', attributes: [['class', 'ttc-time']], styles: [], children: [{ text: '5:07:20' }] },
        { tag: 'strong', attributes: [], styles: [], children: [{ text: 'NeVeR_LosEs (never_loses)' }] },
        { text: ': ' },
        { tag: 'span', attributes: [], styles: [], children: [{ text: '@小碗泡咪 對啊' }] },
      ],
    },
  })

  const env2 = boot({ saved, database, now: () => now })
  setupVodPage(env2)
  env2.api.refresh()
  const state2 = env2.api.mounted
  await state2.history.restorePromise
  env2.api.setEnabled(state2, true)

  assert.equal(state2.count.textContent, '5 則')
  assert.equal(state2.history.ids.has('vod-legacy-viewer'), false)
  assert.equal(database.records.has(JSON.stringify([scope, 'vod-legacy-viewer'])), false)
  const cleanedTarget = state2.history.ids.get('vod-legacy-tb')
  assert.ok(cleanedTarget)
  assert.equal(cleanedTarget.reply, null)
  assert.equal(cleanedTarget.view.className, 'ttc-message')
  assert.equal(cleanedTarget.view.querySelector('.ttc-reply'), null)
  const persistedTarget = database.records.get(JSON.stringify([scope, 'vod-legacy-tb']))
  assert.equal(persistedTarget.reply, null)
  assert.equal(persistedTarget.tree.children.some(c => c.attributes?.some(([k, v]) => k === 'class' && v.includes('ttc-reply'))), false)
  assert.equal(state2.list.querySelectorAll('.ttc-thread').length, 0)
  assert.equal(state2.list.querySelectorAll('.ttc-reply-group').length, 0)
  assert.equal(state2.list.querySelectorAll('.ttc-reply').length, 0)
  for (const row of state2.list.children) assert.equal(row.getAttribute('data-date'), null)
  env2.api.unmount()
})

test('Twitch VOD time mode: toggle relative offset vs broadcast clock across live capture, reply drawers, search, midnight dividers, cross-tab sync, and reload', async () => {
  const database = fakeIndexedDB()
  const localMidnight = new Date(2026, 10, 20, 23, 59, 50)
  const vodStartIso = localMidnight.toISOString()
  const vodStartMs = localMidnight.getTime()
  const twoDigit = n => String(n).padStart(2, '0')
  const dateKey = ms => {
    const d = new Date(ms)
    return `${d.getFullYear()}/${twoDigit(d.getMonth() + 1)}/${twoDigit(d.getDate())}`
  }
  const clockLabel = ms => {
    const d = new Date(ms)
    return `${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}:${twoDigit(d.getSeconds())}`
  }

  const setupPage = (env, pathname = '/vod_owner/video/31415926') => {
    env.location.pathname = pathname
    const vodChat = env.document.body.appendChild(new env.Element('div'))
    vodChat.className = 'video-chat'
    const vodHeader = vodChat.appendChild(new env.Element('div'))
    vodHeader.className = 'video-chat__header'
    const vodBody = vodChat.appendChild(new env.Element('div'))
    const wrapper = vodBody.appendChild(new env.Element('div'))
    wrapper.className = 'video-chat__message-list-wrapper'
    const scroller = wrapper.appendChild(new env.Element('ul'))
    return scroller
  }

  const addVodMsg = (env, scroller, { user, id, offset, text, createdAtIso = '', mention = '' }) => {
    const line = scroller.appendChild(new env.Element('div'))
    line.className = 'vod-message'
    const hdr = line.appendChild(new env.Element('div'))
    hdr.className = 'vod-message__header'
    const h = Math.floor(offset / 3600)
    const m = Math.floor((offset % 3600) / 60)
    const s = offset % 60
    hdr.textContent = h > 0 ? `${h}:${twoDigit(m)}:${twoDigit(s)}` : `${m}:${twoDigit(s)}`
    const content = line.appendChild(new env.Element('div'))
    const authorLink = content.appendChild(new env.Element('a'))
    authorLink.className = 'video-chat__message-author'
    authorLink.setAttribute('href', `/${user}`)
    const author = authorLink.appendChild(new env.Element('span'))
    author.setAttribute('data-a-target', 'chat-message-username')
    author.setAttribute('data-a-user', user)
    author.textContent = user
    const msgBox = content.appendChild(new env.Element('div'))
    msgBox.className = 'video-chat__message'
    const body = msgBox.appendChild(new env.Element('span'))
    if (mention) {
      const mEl = body.appendChild(new env.Element('span'))
      mEl.className = 'mention-fragment'
      mEl.setAttribute('data-a-target', 'chat-message-mention')
      mEl.textContent = `@${mention}`
    }
    const frag = body.appendChild(new env.Element('span'))
    frag.className = 'text-fragment'
    frag.setAttribute('data-a-target', 'chat-message-text')
    frag.textContent = text
    line.__reactFiber$1 = {
      memoizedProps: {
        timeStampOffset: offset,
        messageContext: {
          author: { login: user },
          comment: {
            id,
            contentOffset: offset,
            ...(createdAtIso ? { createdAt: createdAtIso } : {}),
            commenter: { login: user },
            message: { tokens: mention ? [{ type: 4, content: { recipient: mention } }, { type: 0, content: text }] : [{ type: 0, content: text }] },
          },
        },
      },
    }
    return line
  }

  // Live channel hides .ttc-vod-time-modes
  const liveEnv = boot()
  const liveHeader = liveEnv.document.body.appendChild(new liveEnv.Element('div'))
  liveHeader.className = 'stream-chat'
  const hEl = liveHeader.appendChild(new liveEnv.Element('div'))
  hEl.className = 'stream-chat-header'
  const liveScroller = liveHeader.appendChild(new liveEnv.Element('div'))
  liveScroller.setAttribute('data-a-target', 'chat-scroller')
  liveEnv.api.refresh()
  assert.equal(liveEnv.api.mounted.panel.querySelector('.ttc-vod-time-modes').hidden, true)
  liveEnv.api.unmount()

  // VOD page via /<channel>/video/<id> shows .ttc-vod-time-modes and defaults to offset
  const gqlFetch = async () => ({
    ok: true,
    async json() {
      return { data: { video: { id: '31415926', createdAt: vodStartIso, broadcastType: 'ARCHIVE' } } }
    },
  })
  const env1 = boot({ database, fetch: gqlFetch })
  const scroller1 = setupPage(env1)
  env1.api.refresh()
  const state1 = env1.api.mounted
  assert.equal(state1.history.channel, 'vod:31415926')
  await Promise.all([state1.history.restorePromise, state1.history.vodStartPromise])
  env1.api.setEnabled(state1, true)

  const modeGroup = state1.panel.querySelector('.ttc-vod-time-modes')
  const offsetBtn = state1.panel.querySelector('.ttc-vod-time-offset')
  const broadcastBtn = state1.panel.querySelector('.ttc-vod-time-broadcast')
  assert.equal(modeGroup.hidden, false)
  assert.equal(offsetBtn.getAttribute('aria-pressed'), 'true')
  assert.equal(broadcastBtn.getAttribute('aria-pressed'), 'false')

  // Capture message before midnight (offset 5s -> 23:59:55), message after midnight (offset 15s -> 00:00:05), and message with fiber createdAt
  addVodMsg(env1, scroller1, { user: 'vod_owner', id: 'm-day1', offset: 5, text: 'before midnight' })
  addVodMsg(env1, scroller1, { user: 'vod_owner', id: 'm-mid', offset: 15, text: 'after midnight one' })
  const day2AtMs = vodStartMs + 25 * 1000
  addVodMsg(env1, scroller1, { user: 'vod_owner', id: 'm-day2', offset: 25, text: 'after midnight', createdAtIso: new Date(day2AtMs).toISOString() })

  env1.api.captureTree(scroller1, state1.history)
  env1.api.renderMessages(state1)
  assert.equal(state1.history.ids.get('m-day1').view.querySelector('.ttc-time').textContent, '0:05')
  assert.equal(state1.list.children[0].getAttribute('data-date'), null)

  // Switch to broadcast clock -> shows HH:MM:SS, date dividers across midnight, and rich title
  broadcastBtn.listeners.get('click')()
  assert.equal(broadcastBtn.getAttribute('aria-pressed'), 'true')
  assert.equal(offsetBtn.getAttribute('aria-pressed'), 'false')
  assert.equal(JSON.parse(env1.storage.get('twitch-live-chat-tweaks-settings-v1')).vodTimeMode, 'broadcast')

  const day1Time = state1.history.ids.get('m-day1').view.querySelector('.ttc-time')
  const midTime = state1.history.ids.get('m-mid').view.querySelector('.ttc-time')
  const day2Time = state1.history.ids.get('m-day2').view.querySelector('.ttc-time')
  assert.equal(day1Time.textContent, clockLabel(vodStartMs + 5000))
  assert.equal(day1Time.getAttribute('title'), `${dateKey(vodStartMs + 5000)} ${clockLabel(vodStartMs + 5000)}（影片時間 0:05）`)
  assert.equal(midTime.textContent, clockLabel(vodStartMs + 15000))
  assert.equal(day2Time.textContent, clockLabel(day2AtMs))
  assert.equal(state1.list.children[0].getAttribute('data-date'), dateKey(vodStartMs + 5000))
  assert.equal(state1.list.children[1].getAttribute('data-date'), dateKey(day2AtMs))

  // Search mode preserves broadcast timestamps and date dividers
  state1.messageSearch.value = 'midnight'
  state1.messageSearch.listeners.get('input')()
  assert.equal(state1.list.children[0].querySelector('.ttc-time').textContent, clockLabel(vodStartMs + 5000))
  assert.equal(state1.list.children[0].getAttribute('data-date'), dateKey(vodStartMs + 5000))
  assert.equal(state1.list.children[1].getAttribute('data-date'), dateKey(day2AtMs))
  state1.messageSearch.value = ''
  state1.messageSearch.listeners.get('input')()

  // Switch back to offset mode -> restores relative time and clears date dividers
  offsetBtn.listeners.get('click')()
  assert.equal(day1Time.textContent, '0:05')
  assert.equal(midTime.textContent, '0:15')
  assert.equal(day2Time.textContent, '0:25')
  assert.equal(state1.list.children[0].getAttribute('data-date'), null)
  assert.equal(state1.list.children[1].getAttribute('data-date'), null)

  // Cross-tab storage sync switches back to broadcast mode
  env1.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({
    broadcaster: true, moderators: true, vip: true, replies: true, vodTimeMode: 'broadcast', users: [], excludedUsers: [],
  }))
  env1.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(broadcastBtn.getAttribute('aria-pressed'), 'true')
  assert.equal(day2Time.textContent, clockLabel(day2AtMs))

  await env1.api.flushHistory(state1.history)
  env1.api.unmount()

  // Reload when GQL fails: per-message broadcastAt survives IndexedDB reload, while messages without broadcastAt or vodStartTime gracefully fall back to relative offset
  const env2 = boot({
    database,
    saved: env1.storage.get('twitch-live-chat-tweaks-settings-v1'),
    fetch: async () => { throw new Error('offline') },
  })
  setupPage(env2, '/videos/31415926')
  env2.api.refresh()
  const state2 = env2.api.mounted
  await Promise.all([state2.history.restorePromise, state2.history.vodStartPromise])
  env2.api.setEnabled(state2, true)
  assert.equal(state2.history.ids.get('m-day1').view.querySelector('.ttc-time').textContent, '0:05')
  assert.equal(state2.history.ids.get('m-day2').view.querySelector('.ttc-time').textContent, clockLabel(day2AtMs))
  assert.equal(state2.history.ids.get('m-day2').view.getAttribute('data-date'), dateKey(day2AtMs))
  env2.api.unmount()
})

test('Twitch VOD emotes: fix UTF-8 byte offsets to Unicode code-point indices in GQL fetch responses and defer DOM init at document-start', async () => {
  const makeComment = fragments => ({
    node: {
      id: 'c-1',
      commenter: { id: '1', login: 'u1', displayName: 'U1' },
      contentOffsetSeconds: 100,
      createdAt: '2026-11-25T13:18:31.135Z',
      message: { fragments, userBadges: [], userColor: null },
    },
  })

  // 1. Direct fixVodEmoteOffsets checks (CJK, multi-emote with UTF-8 mention, 4-byte emoji surrogate pairs, and clean ASCII)
  const batchPayload = [
    { data: { sendSpadeEvents: { statusCode: 204 } } },
    {
      data: {
        video: {
          id: '2940219955',
          comments: {
            edges: [
              // 25 CJK + 1 space = 26 code points (76 UTF-8 bytes)
              makeComment([
                { emote: null, text: '試乘為啥要開直播阿這不是白白要被薛哥吞噬掉進化了嗎 ' },
                { emote: { id: 'emotesv2_893;76;86', emoteID: 'emotesv2_893', from: 76, __typename: 'EmbeddedEmote' }, text: 'roger989898' },
              ]),
              // '@機器人183號 shaxy11 shaxy11 shaxy11': 9 chars before first emote, spacing 1 each
              makeComment([
                { emote: null, text: '@機器人183號 ' },
                { emote: { id: '305147277;17;23', emoteID: '305147277', from: 17, __typename: 'EmbeddedEmote' }, text: 'shaxy11' },
                { emote: null, text: ' ' },
                { emote: { id: '305147277;25;31', emoteID: '305147277', from: 25, __typename: 'EmbeddedEmote' }, text: 'shaxy11' },
                { emote: null, text: ' ' },
                { emote: { id: '305147277;33;39', emoteID: '305147277', from: 33, __typename: 'EmbeddedEmote' }, text: 'shaxy11' },
              ]),
              // Two 4-byte emoji (UTF-16 len 4, UTF-8 len 8, code points 2) + two CJK + space = 5 code points
              makeComment([
                { emote: null, text: '🔥😂中文 ' },
                { emote: { id: '25;15;19', emoteID: '25', from: 15, __typename: 'EmbeddedEmote' }, text: 'Kappa' },
              ]),
            ],
          },
        },
      },
    },
  ]

  const env0 = boot()
  assert.equal(env0.api.fixVodEmoteOffsets(batchPayload), true)
  const edges = batchPayload[1].data.video.comments.edges
  assert.equal(edges[0].node.message.fragments[1].emote.from, 26)
  assert.equal(edges[0].node.message.fragments[1].emote.id, 'emotesv2_893;26;36')
  assert.deepEqual(
    [1, 3, 5].map(i => edges[1].node.message.fragments[i].emote.from),
    [9, 17, 25],
  )
  assert.deepEqual(
    [1, 3, 5].map(i => edges[1].node.message.fragments[i].emote.id),
    ['305147277;9;15', '305147277;17;23', '305147277;25;31'],
  )
  assert.equal(edges[2].node.message.fragments[1].emote.from, 5)
  assert.equal(edges[2].node.message.fragments[1].emote.id, '25;5;9')
  // Already aligned -> returns false
  assert.equal(env0.api.fixVodEmoteOffsets(batchPayload), false)

  const asciiSingle = {
    data: {
      video: {
        id: '2940219955',
        comments: {
          edges: [
            makeComment([
              { emote: null, text: 'hi ' },
              { emote: { id: '25;3;7', emoteID: '25', from: 3, __typename: 'EmbeddedEmote' }, text: 'Kappa' },
            ]),
          ],
        },
      },
    },
  }
  assert.equal(env0.api.fixVodEmoteOffsets(asciiSingle), false)
  env0.api.unmount()

  // 2. End-to-end document-start deferral + fetch interception behavior
  const rawGql = [{
    data: {
      video: {
        id: '2940219955',
        comments: {
          edges: [
            makeComment([
              { emote: null, text: '中文前綴 ' },
              { emote: { id: '99;13;18', emoteID: '99', from: 13, __typename: 'EmbeddedEmote' }, text: 'shaxy1' },
            ]),
          ],
        },
      },
    },
  }]
  const asciiGql = [{
    data: {
      video: {
        id: '2940219955',
        comments: {
          edges: [
            makeComment([
              { emote: null, text: 'ok ' },
              { emote: { id: '99;3;8', emoteID: '99', from: 3, __typename: 'EmbeddedEmote' }, text: 'shaxy1' },
            ]),
          ],
        },
      },
    },
  }]

  const passthroughResponses = new Map()
  const makeResp = (bodyText, { status = 200, headers = { 'content-type': 'application/json', 'content-length': '999', 'content-encoding': 'zstd' }, url = 'https://gql.twitch.tv/gql#origin=twilight' } = {}) => {
    const res = new Response(bodyText, { status, headers })
    Object.defineProperty(res, 'url', { value: url, configurable: true })
    return res
  }

  let fetchCalls = 0
  const baseFetch = async (url, init) => {
    fetchCalls++
    if (String(url).startsWith('https://other.example/')) {
      const r = makeResp(JSON.stringify(rawGql), { url })
      passthroughResponses.set('other', r)
      return r
    }
    if (init?.body?.includes('SendEvents')) {
      const r = makeResp(JSON.stringify({ data: { sendSpadeEvents: { statusCode: 204 } } }))
      passthroughResponses.set('sendEvents', r)
      return r
    }
    if (init?.body?.includes('FailStatus')) {
      const r = makeResp('{"error":true}', { status: 500 })
      passthroughResponses.set('failStatus', r)
      return r
    }
    if (init?.body?.includes('NoEmote')) {
      const r = makeResp(JSON.stringify([{ data: { video: { comments: { edges: [] } } } }]))
      passthroughResponses.set('noEmote', r)
      return r
    }
    if (init?.body?.includes('AlignedAscii')) {
      const r = makeResp(JSON.stringify(asciiGql))
      passthroughResponses.set('ascii', r)
      return r
    }
    if (init?.body?.includes('BadJson')) {
      const r = makeResp('{EmbeddedEmote broken json')
      passthroughResponses.set('badJson', r)
      return r
    }
    return makeResp(JSON.stringify(rawGql))
  }

  // Boot with readyState: 'loading' and no document.body yet
  const envStart = boot({ fetch: baseFetch, readyState: 'loading', withBody: false })
  // DOM initialization must wait until DOMContentLoaded & document.body exists
  assert.equal(envStart.document.head.querySelector('style'), null)
  assert.equal(envStart.api.mounted, null)
  envStart.api.installVodEmoteFetchFix()

  // Finish document-start lifecycle on envStart -> initializes style & refresh
  envStart.document.body = envStart.document.appendChild(new envStart.Element('body'))
  envStart.document.readyState = 'interactive'
  envStart.document.listeners.get('DOMContentLoaded')()
  assert.ok(envStart.document.head.querySelector('style'))
  envStart.api.unmount()

  // Full fetch wrapper verification via exposed globalThis.fetch on a clean VM
  const fetchEnvSource = fs.readFileSync(path.join(__dirname, '..', 'TwitchLiveChatTweaks.user.js'), 'utf8')
  const fetchVm = {
    document: {
      readyState: 'loading',
      body: null,
      head: null,
      documentElement: null,
      addEventListener() {},
      createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} } },
    },
    location: { pathname: '/videos/2940219955', href: 'https://www.twitch.tv/videos/2940219955' },
    console, URL, Response, Headers, fetch: baseFetch,
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    requestAnimationFrame() {}, cancelAnimationFrame() {},
    MutationObserver: class { observe() {}; disconnect() {} },
    localStorage: { getItem: () => null, setItem() {} },
  }
  fetchVm.window = fetchVm
  vm.createContext(fetchVm)
  vm.runInContext(fetchEnvSource.replace(/\}\)\(\)\s*$/, 'globalThis.__testFix = installVodEmoteFetchFix; })()'), fetchVm)
  const firstWrapper = fetchVm.fetch
  assert.notEqual(firstWrapper, baseFetch)
  fetchVm.__testFix()
  assert.equal(fetchVm.fetch, firstWrapper)

  // Patched GQL VideoCommentsByOffsetOrCursor response
  const fixedResp = await fetchVm.fetch('https://gql.twitch.tv/gql#origin=twilight', {
    method: 'POST',
    body: JSON.stringify([{ operationName: 'VideoCommentsByOffsetOrCursor', variables: { videoID: '2940219955' } }]),
  })
  assert.equal(fixedResp.status, 200)
  assert.equal(fixedResp.url, 'https://gql.twitch.tv/gql#origin=twilight')
  assert.equal(fixedResp.headers.get('content-length'), null)
  assert.equal(fixedResp.headers.get('content-encoding'), null)
  assert.equal(fixedResp.headers.get('content-type'), 'application/json')
  const fixedJson = await fixedResp.json()
  assert.equal(fixedJson[0].data.video.comments.edges[0].node.message.fragments[1].emote.from, 5)
  assert.equal(fixedJson[0].data.video.comments.edges[0].node.message.fragments[1].emote.id, '99;5;10')

  // Bypass / no-op paths return exact original Response object untouched
  assert.equal(await fetchVm.fetch('https://other.example/api', { method: 'POST', body: 'VideoCommentsByOffsetOrCursor' }), passthroughResponses.get('other'))
  assert.equal(await fetchVm.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: JSON.stringify([{ operationName: 'SendEvents' }]) }), passthroughResponses.get('sendEvents'))
  assert.equal(await fetchVm.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: 'VideoCommentsByOffsetOrCursor FailStatus' }), passthroughResponses.get('failStatus'))
  assert.equal(await fetchVm.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: 'VideoCommentsByOffsetOrCursor NoEmote' }), passthroughResponses.get('noEmote'))
  assert.equal(await fetchVm.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: 'VideoCommentsByOffsetOrCursor AlignedAscii' }), passthroughResponses.get('ascii'))
  assert.equal(await fetchVm.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: 'VideoCommentsByOffsetOrCursor BadJson' }), passthroughResponses.get('badJson'))
  assert.ok(fetchCalls >= 7)
})

test('Twitch native VOD mention highlight: highlight leading and mid-message @mentions for active filtered targets, backfill late roles/names, respect exclusions/replies, keep panel unchanged, and clean up on unmount', async () => {
  const database = fakeIndexedDB()
  const setupVodPage = (env, pathname = '/vod_owner/video/2940219955') => {
    env.location.pathname = pathname
    const vodChat = env.document.body.appendChild(new env.Element('div'))
    vodChat.className = 'video-chat'
    const vodHeader = vodChat.appendChild(new env.Element('div'))
    vodHeader.className = 'video-chat__header'
    const wrapper = vodChat.appendChild(new env.Element('div'))
    wrapper.className = 'video-chat__message-list-wrapper'
    return wrapper.appendChild(new env.Element('ul'))
  }

  const makeVodLine = (env, scroller, {
    user, displayName = user, id, offset,
    badgeAlt = '',
    prefixText = '', mentionText = '', suffixText = '',
    tokens = null, withFiber = true,
  }) => {
    const line = scroller.appendChild(new env.Element('div'))
    line.className = 'vod-message'
    const hdr = line.appendChild(new env.Element('div'))
    hdr.className = 'vod-message__header'
    const p = hdr.appendChild(new env.Element('p'))
    p.textContent = `${Math.floor(offset / 60)}:${String(offset % 60).padStart(2, '0')}`

    const content = line.appendChild(new env.Element('div'))
    if (badgeAlt) {
      const badge = content.appendChild(new env.Element('img'))
      badge.className = 'chat-badge'
      badge.setAttribute('alt', badgeAlt)
    }
    const authorLink = content.appendChild(new env.Element('a'))
    authorLink.className = 'video-chat__message-author'
    authorLink.setAttribute('href', `/${user}`)
    const author = authorLink.appendChild(new env.Element('span'))
    author.setAttribute('data-a-target', 'chat-message-username')
    author.setAttribute('data-a-user', user)
    author.textContent = displayName

    const msgBox = content.appendChild(new env.Element('div'))
    msgBox.className = 'video-chat__message'
    const colon = msgBox.appendChild(new env.Element('span'))
    colon.textContent = ':'
    const body = msgBox.appendChild(new env.Element('span'))
    if (prefixText) {
      const frag = body.appendChild(new env.Element('span'))
      frag.className = 'text-fragment'
      frag.setAttribute('data-a-target', 'chat-message-text')
      frag.textContent = prefixText
    }
    if (mentionText) {
      const mention = body.appendChild(new env.Element('span'))
      mention.className = 'mention-fragment'
      mention.setAttribute('data-a-target', 'chat-message-mention')
      mention.textContent = mentionText.startsWith('@') ? mentionText : `@${mentionText}`
    }
    if (suffixText) {
      const frag = body.appendChild(new env.Element('span'))
      frag.className = 'text-fragment'
      frag.setAttribute('data-a-target', 'chat-message-text')
      frag.textContent = suffixText
    }

    if (withFiber) {
      line.__reactFiber$1 = {
        return: {
          memoizedProps: {
            timeStampOffset: offset,
            messageContext: {
              author: { id: `${user}-uid`, name: user, displayName },
              comment: {
                id,
                contentOffset: offset,
                commenter: '123456',
                message: {
                  tokens: tokens || [
                    ...(prefixText ? [{ type: 0, content: prefixText }] : []),
                    ...(mentionText ? [{ type: 4, content: { recipient: mentionText.replace(/^@/, '') } }] : []),
                    ...(suffixText ? [{ type: 0, content: suffixText }] : []),
                  ],
                },
              },
            },
          },
        },
      }
    }
    return { line, body }
  }

  const saved = JSON.stringify({
    broadcaster: true, moderators: true, vip: true, replies: true,
    users: ['star_user'], excludedUsers: ['excluded_sender', 'excluded_mod'],
  })
  const env = boot({ saved, database })
  const scroller = setupVodPage(env)
  env.api.refresh()
  const state = env.api.mounted
  await state.history.restorePromise
  env.api.setEnabled(state, true)

  // Known VIP, Broadcaster, and Mod
  const { line: vipSelf } = makeVodLine(env, scroller, {
    user: 'vip_alice', displayName: 'AliceVIP', id: 'm-vip', offset: 10,
    badgeAlt: 'VIP', prefixText: '大家好',
  })
  const { line: ownerSelf } = makeVodLine(env, scroller, {
    user: 'vod_owner', displayName: 'vod_owner', id: 'm-owner', offset: 10,
    prefixText: '開台啦',
  })
  const { line: exModSelf } = makeVodLine(env, scroller, {
    user: 'excluded_mod', displayName: 'ExcludedMod', id: 'm-exmod', offset: 11,
    badgeAlt: 'Moderator', prefixText: '安安',
  })
  // Self-mention by star_user -> target highlight only (NOT mention highlight)
  const { line: selfMention } = makeVodLine(env, scroller, {
    user: 'star_user', displayName: 'star_user', id: 'm-self', offset: 12,
    mentionText: 'star_user', suffixText: ' 自己提自己',
  })
  // Target star_user mentioning another target vod_owner -> target highlight takes precedence over mention highlight
  const { line: targetMentionTarget } = makeVodLine(env, scroller, {
    user: 'star_user', displayName: 'star_user', id: 'm-target-to-target', offset: 12,
    prefixText: '哈囉 ', mentionText: 'vod_owner',
  })
  // Viewer leading @mention -> Broadcaster (vod_owner), fiber + DOM
  const { line: leadBroadcaster, body: leadBroadcasterBody } = makeVodLine(env, scroller, {
    user: 'viewer1', id: 'm-lead-owner', offset: 13,
    mentionText: 'vod_owner', suffixText: ' 早安',
  })
  const bodyChildrenBefore = leadBroadcasterBody.childNodes.length
  // Viewer mid-message @mention -> star_user via DOM-only fallback (withFiber: false)
  const { line: midStar } = makeVodLine(env, scroller, {
    user: 'viewer2', id: 'm-mid-star', offset: 14,
    prefixText: '笑死 ', mentionText: 'star_user', suffixText: ' 好強',
    withFiber: false,
  })
  // Viewer mid-message @mention -> VIP displayName
  const { line: midVip } = makeVodLine(env, scroller, {
    user: 'viewer3', id: 'm-mid-vip', offset: 15,
    prefixText: '樓上 ', mentionText: 'AliceVIP', suffixText: ' 說得對',
  })
  // Excluded sender mentioning Broadcaster -> NOT highlighted
  const { line: excludedSenderLine } = makeVodLine(env, scroller, {
    user: 'excluded_sender', id: 'm-ex-sender', offset: 16,
    prefixText: 'hi ', mentionText: 'vod_owner',
  })
  // Viewer mentioning excluded Moderator -> NOT highlighted
  const { line: mentionExcludedMod } = makeVodLine(env, scroller, {
    user: 'viewer4', id: 'm-to-exmod', offset: 17,
    prefixText: '問一下 ', mentionText: 'ExcludedMod',
  })
  // Viewer mentioning non-target viewer -> NOT highlighted
  const { line: mentionPlainViewer } = makeVodLine(env, scroller, {
    user: 'viewer5', id: 'm-to-viewer', offset: 18,
    prefixText: '欸 ', mentionText: 'viewer1',
  })
  // Early viewer mid-message mentioning a localized Mod whose identity isn't seen yet
  const { line: earlyToMysteryMod } = makeVodLine(env, scroller, {
    user: 'viewer6', id: 'm-early-mod', offset: 19,
    prefixText: '等等 ', mentionText: '神秘管理員', suffixText: ' 會來',
  })

  env.api.captureTree(scroller, state.history)

  // Body DOM nodes are untouched; filtered targets get ttc-vod-target-line and @mentions get ttc-vod-mention-line exclusively
  assert.equal(leadBroadcasterBody.childNodes.length, bodyChildrenBefore)
  assert.equal(vipSelf.classList.contains('ttc-vod-target-line'), true)
  assert.equal(vipSelf.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(ownerSelf.classList.contains('ttc-vod-target-line'), true)
  assert.equal(ownerSelf.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(selfMention.classList.contains('ttc-vod-target-line'), true)
  assert.equal(selfMention.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(targetMentionTarget.classList.contains('ttc-vod-target-line'), true)
  assert.equal(targetMentionTarget.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(leadBroadcaster.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(leadBroadcaster.classList.contains('ttc-vod-target-line'), false)
  assert.equal(midStar.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(midStar.classList.contains('ttc-vod-target-line'), false)
  assert.equal(midVip.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(midVip.classList.contains('ttc-vod-target-line'), false)
  assert.equal(exModSelf.classList.contains('ttc-vod-target-line'), false)
  assert.equal(exModSelf.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(excludedSenderLine.classList.contains('ttc-vod-target-line'), false)
  assert.equal(excludedSenderLine.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(mentionExcludedMod.classList.contains('ttc-vod-target-line'), false)
  assert.equal(mentionExcludedMod.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(mentionPlainViewer.classList.contains('ttc-vod-target-line'), false)
  assert.equal(mentionPlainViewer.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-target-line'), false)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-mention-line'), false)

  // Neither leading nor mid-message viewer @mentions are pulled into the VOD filtered panel (no VOD reply threads)
  assert.equal(state.history.ids.has('m-mid-star'), false)
  assert.equal(state.history.ids.has('m-lead-owner'), false)
  assert.equal(state.list.querySelectorAll('.ttc-thread').length, 0)

  // Late Moderator appears via MutationObserver batch -> highlights mod line as target & backfills earlier viewer mention
  const { line: mysteryModLine } = makeVodLine(env, scroller, {
    user: 'mystery_mod', displayName: '神秘管理員', id: 'm-mystery-mod', offset: 25,
    badgeAlt: 'Moderator', prefixText: '來了',
  })
  env.api.captureMutations([{ target: scroller, addedNodes: [mysteryModLine] }], state.history)
  assert.equal(mysteryModLine.classList.contains('ttc-vod-target-line'), true)
  assert.equal(mysteryModLine.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-target-line'), false)

  // Toggling replies=false preserves both native VOD target & mention highlights
  const repliesCheckbox = state.panel.querySelector('[name="replies"]')
  repliesCheckbox.checked = false
  repliesCheckbox.listeners.get('change')()
  assert.equal(vipSelf.classList.contains('ttc-vod-target-line'), true)
  assert.equal(leadBroadcaster.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(midStar.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-mention-line'), true)

  // Disabling VIP removes VIP target & mention highlights; excluding star_user clears target & mention highlights cleanly
  const vipCheckbox = state.panel.querySelector('[name="vip"]')
  vipCheckbox.checked = false
  vipCheckbox.listeners.get('change')()
  assert.equal(vipSelf.classList.contains('ttc-vod-target-line'), false)
  assert.equal(midVip.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(midStar.classList.contains('ttc-vod-mention-line'), true)

  state.updateSettings({
    ...state.history.settings,
    excludedUsers: [...state.history.settings.excludedUsers, 'star_user'],
  })
  assert.equal(selfMention.classList.contains('ttc-vod-target-line'), false)
  assert.equal(selfMention.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(targetMentionTarget.classList.contains('ttc-vod-target-line'), false)
  assert.equal(targetMentionTarget.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(midStar.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(leadBroadcaster.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-mention-line'), true)
  assert.equal(ownerSelf.classList.contains('ttc-vod-target-line'), true)

  // Unmount cleans up all highlight classes on native VOD chat lines
  env.api.unmount()
  assert.equal(ownerSelf.classList.contains('ttc-vod-target-line'), false)
  assert.equal(mysteryModLine.classList.contains('ttc-vod-target-line'), false)
  assert.equal(leadBroadcaster.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(earlyToMysteryMod.classList.contains('ttc-vod-mention-line'), false)

  // Live stream chat control: .chat-line__message (both target self and viewer mention) is never highlighted
  const liveEnv = boot({
    saved: JSON.stringify({ broadcaster: true, moderators: true, vip: true, replies: true, users: ['star_user'], excludedUsers: [] }),
  })
  liveEnv.location.pathname = '/vod_owner'
  const liveStream = liveEnv.document.body.appendChild(new liveEnv.Element('div'))
  liveStream.className = 'stream-chat'
  const liveHeader = liveStream.appendChild(new liveEnv.Element('div'))
  liveHeader.className = 'stream-chat-header'
  const liveScroller = liveStream.appendChild(new liveEnv.Element('div'))
  liveScroller.setAttribute('data-a-target', 'chat-scroller')
  liveEnv.api.refresh()
  const liveState = liveEnv.api.mounted
  await liveState.history.restorePromise
  const liveLine = liveScroller.appendChild(new liveEnv.Element('div'))
  liveLine.className = 'chat-line__message'
  const liveAuthor = liveLine.appendChild(new liveEnv.Element('span'))
  liveAuthor.setAttribute('data-a-target', 'chat-message-username')
  liveAuthor.setAttribute('data-a-user', 'viewer_live')
  liveAuthor.textContent = 'viewer_live'
  const liveBody = liveLine.appendChild(new liveEnv.Element('span'))
  liveBody.setAttribute('data-a-target', 'chat-message-text')
  const liveMention = liveBody.appendChild(new liveEnv.Element('span'))
  liveMention.className = 'mention-fragment'
  liveMention.setAttribute('data-a-target', 'chat-message-mention')
  liveMention.textContent = '@star_user'
  const liveTargetLine = liveScroller.appendChild(new liveEnv.Element('div'))
  liveTargetLine.className = 'chat-line__message'
  const liveTargetAuthor = liveTargetLine.appendChild(new liveEnv.Element('span'))
  liveTargetAuthor.setAttribute('data-a-target', 'chat-message-username')
  liveTargetAuthor.setAttribute('data-a-user', 'star_user')
  liveTargetAuthor.textContent = 'star_user'
  const liveTargetBody = liveTargetLine.appendChild(new liveEnv.Element('span'))
  liveTargetBody.setAttribute('data-a-target', 'chat-message-text')
  liveTargetBody.textContent = 'hello'
  liveEnv.api.captureTree(liveScroller, liveState.history)
  assert.equal(liveLine.classList.contains('ttc-vod-mention-line'), false)
  assert.equal(liveLine.classList.contains('ttc-vod-target-line'), false)
  assert.equal(liveTargetLine.classList.contains('ttc-vod-target-line'), false)
  assert.equal(liveTargetLine.classList.contains('ttc-vod-mention-line'), false)
  liveEnv.api.unmount()
})

test('Twitch message search: exclude reply quotes and @mentions while matching speaker messages and replies', () => {
  const saved = JSON.stringify({
    broadcaster: true, moderators: true, vip: true, replies: true,
    users: ['mea_07311'], excludedUsers: [],
  })
  const env = boot({ saved })
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const scroller = stream.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  env.api.refresh()
  const state = env.api.mounted
  const { history } = state

  // 1. Target user's normal message
  const targetMsg = env.message('mea_07311', '加油 薛哥 請回昨天的自己', 'VIP', 'search-target-1')
  targetMsg.line.querySelector('[data-a-target="chat-message-username"]').textContent = '小碗泡咪'

  // 2. Target user replying to someone else
  const targetReply = env.message('mea_07311', '哈哈哈', 'VIP', 'search-target-2')
  targetReply.line.querySelector('[data-a-target="chat-message-username"]').textContent = '小碗泡咪'
  targetReply.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'search-target-2',
        user: { userLogin: 'mea_07311', userDisplayName: '小碗泡咪' },
        reply: {
          parentMsgId: 'other-1',
          parentUserLogin: 'other_viewer',
          parentDisplayName: '其他觀眾',
          parentMessageBody: '早安',
          parentDeleted: false,
        },
      },
    },
  }

  // 3. Another viewer replying to mea_07311 (contains @小碗泡咪 (mea_07311) quote)
  const viewerReply = env.message('erwin5989', '推推', '', 'search-reply-to-target')
  viewerReply.line.querySelector('[data-a-target="chat-message-username"]').textContent = '熊問安的電吉他'
  viewerReply.line.__reactFiber$1 = {
    memoizedProps: {
      message: {
        id: 'search-reply-to-target',
        user: { userLogin: 'erwin5989', userDisplayName: '熊問安的電吉他' },
        reply: {
          parentMsgId: 'search-target-1',
          parentUserLogin: 'mea_07311',
          parentDisplayName: '小碗泡咪',
          parentMessageBody: '加油 薛哥 請回昨天的自己',
          parentDeleted: false,
        },
      },
    },
  }

  // 4. Another Moderator sending DOM .mention-fragment @mea_07311
  const domMentionMsg = env.message('mod_b', '', 'Moderator', 'search-mention-dom')
  domMentionMsg.line.querySelector('[data-a-target="chat-message-username"]').textContent = '管理員B'
  const mentionFrag = domMentionMsg.body.appendChild(new env.Element('span'))
  mentionFrag.className = 'mention-fragment'
  mentionFrag.setAttribute('data-a-target', 'chat-message-mention')
  mentionFrag.textContent = '@mea_07311'
  const afterMention = domMentionMsg.body.appendChild(new env.Element('span'))
  afterMention.textContent = ' 打招呼'

  // 5. Another Moderator sending plain-text @小碗泡咪 mention
  const textMentionMsg = env.message('mod_b', '@小碗泡咪 晚安', 'Moderator', 'search-mention-text')
  textMentionMsg.line.querySelector('[data-a-target="chat-message-username"]').textContent = '管理員B'

  for (const row of [targetMsg, targetReply, viewerReply, domMentionMsg, textMentionMsg]) {
    scroller.appendChild(row.line)
    assert.equal(env.api.captureLine(row.line, history), true)
  }
  env.api.setEnabled(state, true)

  // Searching target login or display name matches ONLY messages sent by mea_07311 (including her own reply)
  for (const query of ['mea_07311', '小碗泡咪']) {
    state.messageSearch.value = query
    state.messageSearch.listeners.get('input')()
    assert.equal(state.count.textContent, '2 則符合', `unexpected hits for ${query}`)
    assert.deepEqual(
      state.list.children.map(node => node.querySelector('strong').textContent),
      ['小碗泡咪 (mea_07311)', '小碗泡咪 (mea_07311)'],
    )
    assert.equal(state.list.children[0].querySelector('.ttc-reply'), null)
    assert.ok(state.list.children[1].querySelector('.ttc-reply'))
  }

  // Searching text that only existed in the quoted parent message does NOT match the reply
  state.messageSearch.value = '加油'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '1 則符合')
  assert.equal(state.list.children[0], history.ids.get('search-target-1').view)

  // Searching the replier or their own message body still works cleanly
  for (const query of ['erwin5989', '推推']) {
    state.messageSearch.value = query
    state.messageSearch.listeners.get('input')()
    assert.equal(state.count.textContent, '1 則符合')
    assert.equal(state.list.children[0], history.ids.get('search-reply-to-target').view)
    assert.ok(state.list.children[0].querySelector('.ttc-reply'))
  }

  // Searching non-mention body text on mention messages still works
  for (const query of ['打招呼', '晚安']) {
    state.messageSearch.value = query
    state.messageSearch.listeners.get('input')()
    assert.equal(state.count.textContent, '1 則符合')
  }

  env.api.unmount()
})
