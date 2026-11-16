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
        const attr = part.match(/^\[([^=]+)="([^"]+)"\]$/)
        if (attr) return this.getAttribute(attr[1]) === attr[2]
        if (part === 'img.chat-badge' || part === '[data-a-target="chat-badge"] img') {
          return this.tagName === 'img' && (this.className === 'chat-badge' ||
            this.parentElement?.getAttribute('data-a-target') === 'chat-badge')
        }
        return part === this.tagName
      })
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
    ...(performance ? { performance } : {}),
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

test('Twitch message search: match user, display name, body, emotes and multi-word NFKC queries, update live, and locate in full history', () => {
  const env = boot()
  const stream = env.document.body.appendChild(new env.Element('div'))
  stream.className = 'stream-chat'
  const header = stream.appendChild(new env.Element('div'))
  header.className = 'stream-chat-header'
  const host = stream.appendChild(new env.Element('div'))
  const scroller = host.appendChild(new env.Element('div'))
  scroller.setAttribute('data-a-target', 'chat-scroller')

  const first = env.message('alice_mod', 'ＨＥＬＬＯ ＷＯＲＬＤ', 'Moderator', 's-1')
  const emote = first.body.appendChild(new env.Element('img'))
  emote.setAttribute('alt', 'Kappa')
  const second = env.message('bob_vip', 'another message', 'VIP', 's-2')
  const third = env.message('carol_mod', 'later talk', 'Moderator', 's-3')
  scroller.appendChild(first.line)
  scroller.appendChild(second.line)
  scroller.appendChild(third.line)

  env.api.refresh()
  const state = env.api.mounted
  env.api.setEnabled(state, true)
  assert.equal(state.count.textContent, '3 則')

  // Expanding target management hides message search; collapsing restores it
  const targetBtn = state.panel.querySelector('.ttc-target-summary')
  targetBtn.listeners.get('click')()
  assert.equal(state.panel.querySelector('.ttc-message-search').hidden, true)
  targetBtn.listeners.get('click')()
  assert.equal(state.panel.querySelector('.ttc-message-search').hidden, false)

  // Search by full-width multi-word + emote alt + login
  state.messageSearch.value = 'alice_mod  hello kappa'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '1 則符合')
  assert.equal(state.list.children.length, 1)
  const locateBtn = state.list.children[0].querySelector('.ttc-locate')
  assert.ok(locateBtn)
  assert.equal(JSON.stringify(env.api.archiveTree(state.list.children[0])).includes('ttc-locate'), false)

  // Live edit clears cached search text and updates active search results
  first.body.innerHTML = 'edited away'
  first.body.textContent = 'edited away'
  env.api.captureMutations([{ target: first.body, addedNodes: [] }], state.history)
  env.api.scheduleMessageRender(state)
  env.flushFrames()
  assert.equal(state.count.textContent, '0 則符合')
  assert.equal(state.empty.hidden, false)
  assert.equal(state.empty.textContent, '找不到符合搜尋的聊天訊息。')

  // Search again for bob_vip and locate in full list
  state.messageSearch.value = 'bob_vip'
  state.messageSearch.listeners.get('input')()
  assert.equal(state.count.textContent, '1 則符合')
  const bobView = state.list.children[0]
  bobView.getBoundingClientRect = () => ({ top: 180, height: 30 })
  state.list.getBoundingClientRect = () => ({ top: 100, height: 200 })
  state.list.clientHeight = 200
  state.list.scrollTop = 0
  bobView.querySelector('.ttc-locate').listeners.get('click')()

  assert.equal(state.history.search, '')
  assert.equal(state.messageSearch.value, '')
  assert.equal(state.history.follow, false)
  assert.equal(state.count.textContent, '3 則')
  assert.equal(state.list.querySelector('.ttc-locate'), null)
  assert.equal(bobView.getAttribute('data-ttc-located'), 'true')
  assert.equal(bobView.getAttribute('tabindex'), '-1')
  assert.equal(state.list.scrollTop, 0)
  for (const [id, timer] of [...env.timers.entries()]) {
    if (timer.delay === 3000) { env.timers.delete(id); timer.fn() }
  }
  assert.equal(bobView.getAttribute('data-ttc-located'), null)
  assert.equal(bobView.getAttribute('tabindex'), null)
  env.api.unmount()
})
