const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function boot({ saved, blocked = false, trustedTypes = false, withResizeObserver = false, database, now, scheduler, performance } = {}) {
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
  document.body = new Element('body')
  document.hidden = false
  document.appendChild(document.head)
  document.appendChild(document.body)
  document.createElementNS = (_, tag) => new Element(tag)
  document.createElement = tag => new Element(tag)
  const observers = []
  document.createTextNode = text => Object.assign(new Element('#text'), { textContent: text })
  const storage = new Map(saved ? [['twitch-live-chat-tweaks-settings-v1', saved]] : [])
  const listeners = new Map()
  const timers = new Map()
  const frames = new Map()
  let nextTimer = 0
  const context = {
    document, location: { pathname: '/sample_channel', href: 'https://www.twitch.tv/sample_channel' }, console, URL,
    indexedDB: database,
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

test('Twitch archive: isolate channels, merge concurrent writers, restore directly and cap at 1000 in memory and IndexedDB', async () => {
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
  assert.equal(h1.messages.length, 1000)
  assert.equal(h1.ids.has('msg-0'), false)
  assert.equal(h1.ids.has('msg-1'), false)
  assert.equal(h1.ids.has('msg-2'), true)
  await Promise.all([a.api.flushHistory(h1), b.api.flushHistory(h2), a.api.flushHistory(other)])
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'msg-0'])), false)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'msg-1'])), false)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'another-tab'])), true)
  assert.equal(database.records.has(JSON.stringify(['another_channel', 'another-channel'])), true)
  const fresh = boot({ database })
  const restored = fresh.api.getHistory('sample_channel')
  await restored.restorePromise
  assert.equal(restored.messages.length, 1000)
  assert.equal(restored.older, undefined)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'msg-2'])), false)
  const state = { history: restored, list: new fresh.Element(), empty: {}, count: {}, latest: {} }
  fresh.api.renderMessages(state)
  assert.equal(state.count.textContent, '1000 則')
  assert.equal(state.list.children[0].children.at(-1).textContent, 'old 3')
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

test('Twitch chat: cap history at 1000 in memory and IndexedDB without forcing a reader to the bottom', async () => {
  const database = fakeIndexedDB()
  const env = boot({ database })
  const history = env.api.getHistory('sample_channel')
  await history.restorePromise
  for (let i = 0; i < 1005; i++) {
    env.api.captureLine(env.message('mod', String(i), 'Moderator', `id-${i}`).line, history)
    if (i === 1000) await env.api.flushHistory(history)
  }
  await env.api.flushHistory(history)
  assert.equal(history.messages.length, 1000)
  assert.equal(history.messages[0].view.children.at(-1).innerHTML, '5')
  assert.equal(database.records.size, 1000)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'id-0'])), false)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'id-4'])), false)
  assert.equal(database.records.has(JSON.stringify(['sample_channel', 'id-5'])), true)
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  state.list.scrollTop = 123
  state.list.scrollHeight = 9999
  history.follow = false
  env.api.renderMessages(state)
  assert.equal(state.list.scrollTop, 123)
  assert.equal(state.count.textContent, '1000 則')
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
    assert.equal(state.count.textContent, '1 則符合', `search failed for ${query}`)
  }
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

  // Evicting d1-mod1 from 1000-cap while d1-rep1 remains converts d1-rep1's thread into an orphan .ttc-reply-group
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
