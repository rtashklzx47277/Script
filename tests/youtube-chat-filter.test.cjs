const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function boot({ saved, blocked = false, trustedTypes = false, parentWindow, fetchProfile, nativeMenu } = {}) {
  const profileCalls = []
  const menuCalls = []
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag
      this.nodeType = 1
      this.children = []
      this.parentElement = null
      this.attrs = new Map()
      this.style = {}
      this.textContent = ''
      this._innerHTML = ''
      this.hidden = false
      this.value = ''
    }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })) }
    get textContent() { return (this._textContent || '') + this.children.map(child => child.textContent).join('') }
    set textContent(value) { this._textContent = String(value); this.replaceChildren() }
    get firstChild() { return this.children[0] }
    get innerHTML() { return this._innerHTML }
    set innerHTML(value) {
      if (trustedTypes) throw new TypeError('This document requires TrustedHTML assignment')
      this._innerHTML = value
    }
    get isConnected() { return this === document || !!this.parentElement?.isConnected }
    getClientRects() { return this.isConnected && !this.hidden ? [{}] : [] }
    getBoundingClientRect() { return { top: 120, bottom: 144, left: 20, right: 80, width: 60, height: 24 } }
    focus() { document.activeElement = this }
    dispatchEvent(event) {
      event.target ||= this
      if (event.detail?.actionName === 'yt-service-request') {
        menuCalls.push(event.detail.args[1])
        event.detail.returnValue.push({ ajaxPromise: nativeMenu
          ? nativeMenu(event.detail.args[1]) : Promise.resolve({ data: { liveChatItemContextMenuSupportedRenderers: { menuRenderer: {} } } }) })
      }
      return true
    }
    get classList() {
      const apply = (name, enabled) => {
        const classes = new Set((this.className || '').split(' ').filter(Boolean))
        if (enabled) classes.add(name)
        else classes.delete(name)
        this.className = [...classes].join(' ')
      }
      return { add: (...names) => names.forEach(name => apply(name, true)),
        remove: (...names) => names.forEach(name => apply(name, false)), toggle: apply }
    }
    addEventListener(name, handler) {
      this.listeners ||= new Map()
      const previous = this.listeners.get(name)
      this.listeners.set(name, previous ? event => { previous(event); handler(event) } : handler)
    }
    setAttribute(name, value) {
      this.attrs.set(name, value)
      if (name === 'class') this.className = value
    }
    getAttribute(name) { return this.attrs.get(name) || null }
    removeAttribute(name) { this.attrs.delete(name) }
    hasAttribute(name) { return this.attrs.has(name) }
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
    contains(other) { return other === this || this.children.some(child => child.contains(other)) }
    appendChild(child) {
      child.remove()
      this.children.push(child)
      child.parentElement = this
      return child
    }
    insertAdjacentElement(position, child) {
      assert.ok(['beforebegin', 'afterend'].includes(position))
      child.remove()
      const parent = this.parentElement
      parent.children.splice(parent.children.indexOf(this) + (position === 'afterend' ? 1 : 0), 0, child)
      child.parentElement = parent
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
      copy._innerHTML = this.innerHTML
      copy.textContent = this.textContent
      if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true))
      return copy
    }
  }
  const document = new Element('document')
  document.head = new Element('head')
  document.body = new Element('body')
  document.appendChild(document.head)
  document.appendChild(document.body)
  document.referrer = ''
  document.createElementNS = (_, tag) => new Element(tag)
  document.createElement = tag => new Element(tag)
  document.createTextNode = text => Object.assign(new Element('#text'), { textContent: text })
  const storage = new Map(saved ? [['youtube-live-chat-tweaks-settings-v1', saved]] : [])
  const listeners = new Map()
  const timers = new Map()
  const frames = new Map()
  let nextTimer = 0
  const context = {
    document, location: { pathname: '/live_chat', href: 'https://www.youtube.com/live_chat?v=sample_video', origin: 'https://www.youtube.com' }, console, URL,
    window: { parent: parentWindow, addEventListener(name, fn) {
      const previous = listeners.get(name)
      listeners.set(name, previous ? event => { previous(event); fn(event) } : fn)
    } },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    fetch(url, options) {
      profileCalls.push({ url, options })
      return fetchProfile ? fetchProfile(url, options) : Promise.resolve({ ok: false })
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, setInterval() {},
    requestAnimationFrame(fn) { const id = ++nextTimer; frames.set(id, fn); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    Node: { ELEMENT_NODE: 1 }, HTMLElement: Element, AbortController,
    getComputedStyle: element => ({ color: element.style.color || 'white', display: 'block', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: {
      getItem(key) { if (blocked) throw Error('Blocked'); return storage.get(key) || null },
      setItem(key, value) { if (blocked) throw Error('Blocked'); storage.set(key, value) },
    },
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'YouTubeLiveChatTweaks.user.js'), 'utf8')
  vm.createContext(context)
  vm.runInContext(source.replace('    // End YouTube chat filtering.', `
    globalThis.api = { normalizeAccount, getChannel, getHistory, loadSettings, saveSettings,
      readMessage, matchesFilter, captureLine, captureTree, captureMutations, renderMessages, changeTargetUsers,
      scheduleMessageRender, releaseMessageViews, handleMessageVisibility,
      refresh, refreshHeader, setEnabled, showTargetStatus, guardMessageMenu, guardMenuDismissal,
      getProfile, showAuthorCard, authorSnapshot, dismissCard, getAuthorCard, setPanelLayer, positionFilterPanel, fitCardText,
      setMounted: state => { mounted = state },
      get mounted() { return mounted } };
    // End YouTube chat filtering.`), context)
  const message = (user, text, role = '', id = '') => {
    const line = new Element('yt-live-chat-text-message-renderer')
    line.id = id
    line.setAttribute('author-type', role)
    const chip = line.appendChild(new Element('yt-live-chat-author-chip'))
    const author = chip.appendChild(new Element('span'))
    author.id = 'author-name'
    author.textContent = user
    const body = line.appendChild(new Element('span'))
    body.id = 'message'
    body._innerHTML = text
    body.textContent = text
    return { line, body, author, chip }
  }
  return { api: context.api, message, Element, storage, timers, frames, listeners, profileCalls, menuCalls,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() },
    location: context.location, document, window: context.window }
}

test('YouTube filters: mount, toggle and remount when Trusted Types rejects HTML strings', () => {
  const env = boot({ trustedTypes: true })
  const { document, Element, api } = env
  const header = document.body.appendChild(new Element('yt-live-chat-header-renderer'))
  const menu = header.appendChild(new Element('yt-live-chat-button'))
  menu.id = 'live-chat-header-context-menu'
  const close = header.appendChild(new Element('div'))
  close.id = 'close-button'
  const host = document.body.appendChild(new Element('div'))
  const scroller = host.appendChild(new Element('div'))
  scroller.id = 'item-scroller'
  const offset = scroller.appendChild(new Element('div'))
  offset.id = 'item-offset'
  const items = offset.appendChild(new Element('div'))
  items.id = 'items'
  items.appendChild(env.message('@host', 'hello', 'owner', 'owner-1').line)
  assert.throws(() => { menu.innerHTML = '<span>blocked</span>' }, /TrustedHTML/)
  api.refresh()
  let state = api.mounted
  assert.ok(state.button.isConnected)
  assert.ok(state.button.querySelector('svg').querySelector('path'))
  api.refreshHeader()
  assert.equal(header.children.map(node => node.id).join(','),
    'live-chat-header-context-menu,yt-chat-tweaks-filter-button,yt-chat-tweaks-reload-button,close-button')
  assert.equal(state.button.title, undefined)
  assert.equal(header.querySelector('#yt-chat-tweaks-reload-button').title, undefined)
  assert.ok(state.panel.isConnected)
  assert.ok(state.panel.querySelector('.ytcf-targets').querySelector('[name="broadcaster"]'))
  assert.equal(state.panel.querySelector('.ytcf-options').querySelector('[name="moderators"]'), null)
  assert.equal(state.panel.querySelector('.ytcf-target-summary').getAttribute('aria-expanded'), 'false')
  assert.equal(state.panel.className.includes('ytcf-managing'), false)
  state.panel.querySelector('.ytcf-target-summary').listeners.get('click')()
  assert.equal(state.panel.querySelector('.ytcf-target-summary').getAttribute('aria-expanded'), 'true')
  state.panel.querySelector('.ytcf-target-summary').listeners.get('click')()
  assert.equal(state.panel.querySelector('.ytcf-target-summary').getAttribute('aria-expanded'), 'false')
  assert.equal(state.panel.className.includes('ytcf-managing'), false)
  assert.equal(state.panel.hidden, true)
  api.setEnabled(state, true)
  assert.equal(state.button.getAttribute('aria-pressed'), 'true')
  assert.equal(state.panel.hidden, false)
  assert.equal(state.count.textContent, '1 則')
  assert.equal(scroller.getAttribute('aria-hidden'), 'true')
  state.button.remove()
  state.updateSettings(state.history.settings, '已移除帳號。')
  const oldTimer = state.statusTimer
  api.refresh()
  assert.equal(env.timers.has(oldTimer), false)
  state = api.mounted
  assert.equal(header.querySelectorAll('#yt-chat-tweaks-filter-button').length, 1)
  assert.equal(host.querySelectorAll('.ytcf-panel').length, 1)
  assert.equal(state.count.textContent, '1 則')
  api.setEnabled(state, false)
  assert.equal(state.button.getAttribute('aria-pressed'), 'false')
  assert.equal(scroller.getAttribute('aria-hidden'), null)
})

require('./helpers/chat-update-cases.cjs')({ test, assert, boot, site: 'YouTube' })

test('YouTube message actions: author clicks are handled while message links keep default navigation', () => {
  const { api, Element, message, document } = boot()
  const { line, body, author } = message('@alice', 'hello')
  const menu = line.appendChild(new Element('div'))
  menu.id = 'menu'
  const button = menu.appendChild(new Element('button'))
  const icon = button.appendChild(new Element('svg'))
  const link = body.appendChild(new Element('a'))
  const unrelated = new Element('button')
  assert.equal(document.listeners.get('click'), api.guardMessageMenu)
  for (const [target, expected] of [[body, true], [author, true], [link, true], [icon, false], [button, false], [unrelated, false]]) {
    let stopped = false
    let prevented = false
    api.guardMessageMenu({ target, stopPropagation() { stopped = true }, preventDefault() { prevented = true } })
    assert.equal(stopped, expected)
    assert.equal(prevented, target === author)
  }
})

test('YouTube menus: an outside gesture only closes the popup; inside clicks and the next click work', () => {
  const { api, Element, document } = boot()
  const app = document.body.appendChild(new Element('yt-live-chat-app'))
  const popup = app.appendChild(new Element('tp-yt-iron-dropdown'))
  let closes = 0
  popup.close = () => { closes++; popup.hidden = true }
  const item = popup.appendChild(new Element('button'))
  const outside = app.appendChild(new Element('button'))
  const fire = (type, target) => {
    let stopped = false
    let prevented = false
    api.guardMenuDismissal({ type, target, stopImmediatePropagation() { stopped = true }, preventDefault() { prevented = true } })
    return [stopped, prevented]
  }
  assert.deepEqual(fire('click', item), [false, false])
  for (const type of ['pointerdown', 'mousedown']) {
    assert.deepEqual(fire(type, outside), [true, true])
    assert.equal(closes, 0)
  }
  assert.deepEqual(fire('click', outside), [true, true])
  assert.equal(closes, 1)
  assert.deepEqual(fire('click', outside), [false, false])
  popup.hidden = false
  popup.setAttribute('aria-hidden', 'true')
  assert.deepEqual(fire('click', outside), [false, false])
})

test('YouTube menus: parent-page guards are released on pagehide and restored on pageshow', () => {
  const parentHandlers = new Map()
  const parentWindow = {
    document: { querySelector: () => null }, location: { href: 'https://www.youtube.com/watch?v=sample_video' },
    addEventListener(name, fn) { parentHandlers.set(name, fn) },
    removeEventListener(name, fn) { if (parentHandlers.get(name) === fn) parentHandlers.delete(name) },
  }
  const { api, listeners } = boot({ parentWindow })
  assert.equal(parentHandlers.get('click'), api.guardMenuDismissal)
  assert.equal(parentHandlers.size, 3)
  listeners.get('pagehide')()
  assert.equal(parentHandlers.size, 0)
  listeners.get('pageshow')()
  assert.equal(parentHandlers.get('pointerdown'), api.guardMenuDismissal)
  assert.equal(parentHandlers.size, 3)
})

test('YouTube target status: clear after three seconds and cancel the previous notice timer', () => {
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
  api.showTargetStatus(state, '新的提示')
  const pending = state.statusTimer
  api.showTargetStatus(state)
  assert.equal(timers.has(pending), false)
  assert.equal(state.status.textContent, '')
})

test('YouTube filters: normalize Unicode handles and accept one account at a time', () => {
  const env = boot()
  assert.equal(env.api.normalizeAccount(' @直線番長-t1r '), '@直線番長-t1r')
  assert.equal(env.api.normalizeAccount('Alice'), '@alice')
  const settings = env.api.loadSettings('channel:@host')
  assert.equal(env.api.changeTargetUsers(settings, '@alice @bob'), null)
  const next = env.api.changeTargetUsers(settings, '@Alice')
  assert.equal(next.users.join(','), '@alice')
  const excluded = env.api.changeTargetUsers(next, '@Alice', false, true)
  assert.equal(excluded.excludedUsers.join(','), '@alice')
  assert.equal(excluded.users.join(','), '@alice')
})

test('YouTube filters: stable channel IDs and channel URLs survive handle changes and enforce exclusions', () => {
  const env = boot()
  const id = 'UCAbCdEfGhIjKlMnOpQrStUv'
  assert.equal(env.api.normalizeAccount(id), id)
  assert.equal(env.api.normalizeAccount(`https://www.youtube.com/channel/${id}?view=1`), id)
  assert.equal(env.api.normalizeAccount(`https://example.com/channel/${id}`), '')
  const history = env.api.getHistory('channel:@host')
  history.settings = env.api.changeTargetUsers(history.settings, id)
  env.api.saveSettings(history)
  assert.equal(env.api.loadSettings(history.channel).users[0], id)
  const first = env.message('@old_handle', 'first', '', 'id-1').line
  first.data = { authorExternalChannelId: id }
  assert.equal(env.api.readMessage(first).channelId, id)
  assert.equal(env.api.captureLine(first, history), true)
  const renamed = env.message('@new_handle', 'second', 'moderator', 'id-2').line
  renamed.data = { authorExternalChannelId: id }
  assert.equal(env.api.captureLine(renamed, history), true)
  const unrelated = env.message('@old_handle', 'different channel', '', 'id-3').line
  unrelated.data = { authorExternalChannelId: 'UCZYXWVUTSRQPONMLKJIHGFE' }
  assert.equal(env.api.captureLine(unrelated, history), false)
  history.settings = env.api.changeTargetUsers(history.settings, `https://youtube.com/channel/${id}`, false, true)
  assert.ok(history.messages.every(record => !env.api.matchesFilter(record, history.settings)))
  history.settings = env.api.changeTargetUsers(history.settings, id, true, true)
  assert.ok(history.messages.every(record => env.api.matchesFilter(record, history.settings)))
  const fallback = env.message('@no_data', 'DOM fallback').line
  fallback.setAttribute('author-external-channel-id', id)
  assert.equal(env.api.captureLine(fallback, history), true)
})

test('YouTube filters: roles, paid messages and exclusions use the actual author', () => {
  const env = boot()
  const history = env.api.getHistory('channel:@host')
  history.settings.users = ['@alice']
  for (const [user, role] of [['@host', 'owner'], ['@mod', 'moderator'], ['@alice', '']]) {
    const { line } = env.message(user, 'hello', role, user)
    if (user === '@mod') line.tagName = 'yt-live-chat-paid-message-renderer'
    assert.equal(env.api.captureLine(line, history), true)
    history.settings = env.api.changeTargetUsers(history.settings, user, false, true)
  }
  assert.equal(env.api.captureLine(env.message('@ordinary', 'ignored').line, history), false)
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '0 則')
  history.settings = env.api.changeTargetUsers(history.settings, '@mod', true, true)
  env.api.renderMessages(state)
  assert.equal(state.count.textContent, '1 則')
})

test('YouTube filters: replayed message IDs are deduplicated across DOM rebuilds', () => {
  const env = boot()
  const history = env.api.getHistory('channel:@host')
  const first = env.message('@mod', 'same text', 'moderator', 'message-1')
  env.api.captureLine(first.line, history)
  first.line.remove()
  assert.equal(env.api.captureLine(env.message('@mod', 'same text', 'moderator', 'message-1').line, history), false)
  assert.equal(env.api.captureLine(env.message('@mod', 'same text', 'moderator', 'message-2').line, history), true)
  assert.equal(history.messages.length, 2)
  assert.equal(history.ids.size, 2)
})

test('YouTube filters: native deletion hides the old body and clones remain independent', () => {
  const env = boot()
  const history = env.api.getHistory('channel:@host')
  const { line, body } = env.message('@mod', 'original', 'moderator', 'message-1')
  const img = body.appendChild(new env.Element('img'))
  img.setAttribute('alt', 'Kappa')
  img.setAttribute('id', 'native-emoji')
  env.api.captureLine(line, history)
  const copied = history.messages[0].view.children.at(-1)
  assert.equal(copied.children[0].getAttribute('id'), null)
  line.setAttribute('is-deleted', '')
  env.api.captureLine(line, history)
  assert.equal(history.messages.length, 1)
  assert.equal(history.messages[0].view.children.at(-1).textContent, '訊息已刪除')
  assert.equal('body' in history.messages[0], false)
})

test('YouTube filters: cap IDs and retained messages without forcing a paused reader to the bottom', () => {
  const env = boot()
  const history = env.api.getHistory('channel:@host')
  for (let i = 0; i < 2002; i++) env.api.captureLine(env.message('@mod', String(i), 'moderator', String(i)).line, history)
  assert.equal(history.messages.length, 2000)
  assert.equal(history.ids.size, 2000)
  assert.equal(history.ids.has('0'), false)
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  state.list.scrollTop = 123
  history.follow = false
  env.api.renderMessages(state)
  assert.equal(state.list.scrollTop, 123)
})

test('YouTube filters: embedded streams and popouts share channel settings through the video alias', () => {
  const env = boot()
  const owner = new env.Element('a')
  owner.setAttribute('href', '/@Host')
  env.window.parent = {
    document: { querySelector: () => owner },
    location: { href: 'https://www.youtube.com/watch?v=sample_video' },
  }
  assert.equal(env.api.getChannel(), 'channel:@host')
  const history = env.api.getHistory(env.api.getChannel())
  history.settings.excludedUsers = ['@bot']
  env.api.saveSettings(history)
  env.window.parent = env.window
  assert.equal(env.api.getChannel(), 'channel:@host')
  assert.equal(env.api.loadSettings(env.api.getChannel()).excludedUsers.join(','), '@bot')
  assert.equal(env.api.loadSettings('channel:@other').excludedUsers.length, 0)
  env.location.href = 'https://www.youtube.com/live_chat?v=other_video'
  assert.equal(env.api.getChannel(), 'video:other_video')
})

test('YouTube filters: late channel identity keeps early records and user edits', () => {
  const env = boot()
  const early = env.api.getHistory(env.api.getChannel())
  early.enabled = true
  early.settings = env.api.changeTargetUsers(early.settings, '@alice')
  env.api.saveSettings(early)
  env.api.captureLine(env.message('@alice', 'early message', '', 'message-1').line, early)
  const owner = new env.Element('a')
  owner.setAttribute('href', '/@Host')
  env.window.parent = { document: { querySelector: () => owner }, location: { href: 'https://www.youtube.com/watch?v=sample_video' } }
  const resolved = env.api.getHistory(env.api.getChannel())
  assert.equal(resolved.channel, 'channel:@host')
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.messages.length, 1)
  assert.equal(env.api.loadSettings('channel:@host').users.join(','), '@alice')
})

const settle = () => new Promise(resolve => setImmediate(resolve))
const channelA = 'UCAbCdEfGhIjKlMnOpQrStUv'
const channelB = 'UCZYXWVUTSRQPONMLKJIHGFE'
const menuResult = params => ({ data: { liveChatItemContextMenuSupportedRenderers: { menuRenderer: {
  items: [{ menuServiceItemRenderer: { text: { simpleText: '報告' }, serviceEndpoint: { fixtureReport: { params } } } }],
} } } })

test('YouTube author identity: renderer controller preserves handles despite third-party display-name changes', () => {
  const env = boot()
  const { line } = env.message('頻道名稱', 'hello')
  line.data = { authorExternalChannelId: channelB }
  line.polymerController = { data: { authorExternalChannelId: channelA,
    authorName: { simpleText: '@OriginalHandle' }, contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'message-A' } } } }
  const read = env.api.readMessage(line)
  assert.equal(read.user, '@originalhandle')
  assert.equal(read.channelId, channelA)
  assert.equal(read.contextMenuEndpoint.liveChatItemContextMenuEndpoint.params, 'message-A')
})

test('YouTube profile requests: deduplicate in-flight lookups, cache names and failures, and reject mismatched IDs', async () => {
  let resolveProfile
  const env = boot({ fetchProfile: () => new Promise(resolve => { resolveProfile = resolve }) })
  assert.equal(await env.api.getProfile('bad-id'), null)
  assert.equal(env.profileCalls.length, 0)
  const first = env.api.getProfile(channelA)
  const second = env.api.getProfile(channelA)
  assert.equal(first, second)
  assert.equal(env.profileCalls.length, 1)
  assert.equal(env.profileCalls[0].options.credentials, 'omit')
  assert.equal(JSON.parse(env.profileCalls[0].options.body).browseId, channelA)
  resolveProfile({ ok: true, json: async () => ({ metadata: { channelMetadataRenderer: {
    externalId: channelA, title: '真正的頻道名稱', vanityChannelUrl: 'https://www.youtube.com/@OriginalHandle',
  } } }) })
  assert.equal((await first).title, '真正的頻道名稱')
  assert.equal((await env.api.getProfile(channelA)).handle, '@OriginalHandle')
  assert.equal(env.profileCalls.length, 1)
  const failed = env.api.getProfile(channelB)
  resolveProfile({ ok: true, json: async () => ({ metadata: { channelMetadataRenderer: { externalId: channelA, title: '錯誤用戶' } } }) })
  assert.equal(await failed, null)
  assert.equal(await env.api.getProfile(channelB), null)
  assert.equal(env.profileCalls.length, 2)
})

test('YouTube user cards: open immediately under Trusted Types; late results cannot replace another user', async () => {
  const profileResolvers = []
  const menuResolvers = []
  const env = boot({ trustedTypes: true,
    fetchProfile: () => new Promise(resolve => profileResolvers.push(resolve)),
    nativeMenu: () => new Promise(resolve => menuResolvers.push(resolve)),
  })
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const first = env.message('@first', 'first message')
  app.appendChild(first.line)
  first.line.data = { authorExternalChannelId: channelA,
    contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'first-message' } } }
  env.api.guardMessageMenu({ target: first.author, preventDefault() {}, stopPropagation() {} })
  const cardA = env.api.getAuthorCard()
  assert.ok(cardA.isConnected)
  assert.equal(cardA.querySelector('.ytuc-id').textContent, channelA)
  assert.equal(cardA.querySelector('.ytuc-name').textContent, '@first')
  const second = env.message('@second', 'second message')
  app.appendChild(second.line)
  second.line.data = { authorExternalChannelId: channelB,
    contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'second-message' } } }
  const snapshot = env.api.authorSnapshot(env.api.readMessage(second.line))
  const stateB = env.api.showAuthorCard(snapshot, second.author)
  profileResolvers[0]({ ok: true, json: async () => ({ metadata: { channelMetadataRenderer: { externalId: channelA, title: '第一位' } } }) })
  menuResolvers[0](menuResult('first-message'))
  await settle()
  assert.equal(cardA.isConnected, false)
  assert.equal(stateB.title.textContent, '@second')
  assert.equal(stateB.menuHost.querySelector('ytd-menu-popup-renderer'), null)
  profileResolvers[1]({ ok: true, json: async () => ({ metadata: { channelMetadataRenderer: { externalId: channelB, title: '第二位' } } }) })
  menuResolvers[1](menuResult('second-message'))
  await settle()
  assert.equal(stateB.title.textContent, '第二位')
  assert.equal(stateB.menuHost.querySelector('ytd-menu-popup-renderer').data.items[0].menuServiceItemRenderer.serviceEndpoint.fixtureReport.params, 'second-message')
})

test('YouTube author snapshots: preserve the clicked message and badge visuals without retaining live DOM', async () => {
  const env = boot({ nativeMenu: endpoint => Promise.resolve(menuResult(endpoint.liveChatItemContextMenuEndpoint.params)) })
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const history = env.api.getHistory('channel:@host')
  const message = env.message('@moderator', 'retained', 'moderator', 'first-message')
  message.line.data = { authorExternalChannelId: channelA,
    contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'first-message' } } }
  app.appendChild(message.line)
  const badge = message.chip.appendChild(new env.Element('yt-live-chat-author-badge-renderer'))
  badge.setAttribute('type', 'member')
  badge.setAttribute('aria-label', '會員 2 年')
  const icon = badge.appendChild(new env.Element('svg'))
  icon.appendChild(new env.Element('path')).setAttribute('d', 'M0 0h1v1z')
  const snapshot = env.api.authorSnapshot(env.api.readMessage(message.line))
  env.api.captureLine(message.line, history)
  assert.equal(env.profileCalls.length, 0)
  assert.equal(message.author.getAttribute('tabindex'), '0')
  const view = history.messages[0].view
  app.appendChild(view)
  message.line.remove()
  message.line.data.contextMenuEndpoint.liveChatItemContextMenuEndpoint.params = 'different-message'
  const author = view.querySelector('strong')
  assert.equal(view.querySelector('button'), null)
  assert.equal(author.listeners?.get('click'), undefined)
  env.api.showAuthorCard(snapshot, author)
  await settle()
  assert.equal(env.menuCalls[0].liveChatItemContextMenuEndpoint.params, 'first-message')
  assert.equal(env.api.getAuthorCard().querySelector('.ytuc-id').textContent, channelA)
  const copiedIcon = env.api.getAuthorCard().querySelector('.ytuc-badge').querySelector('svg')
  assert.notEqual(copiedIcon, icon)
  assert.notEqual(copiedIcon, snapshot.badges[0].visual)
  assert.equal(copiedIcon.querySelector('path').getAttribute('d'), 'M0 0h1v1z')
  assert.equal(snapshot.badges[0].visual.parentElement, null)
})

test('YouTube author cards: keep native role colors and badges below identity without a heading', async () => {
  for (const [role, color] of [['member', 'rgb(43, 166, 64)'], ['moderator', 'rgb(62, 166, 255)'], ['owner', 'rgb(255, 214, 0)']]) {
    const env = boot({ fetchProfile: () => Promise.resolve({ ok: true, json: async () => ({ metadata: {
      channelMetadataRenderer: { externalId: channelA, title: '頻道名稱', vanityChannelUrl: 'https://www.youtube.com/@example' },
    } }) }) })
    const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
    const message = env.message('@example', 'hello', role)
    message.line.data = { authorExternalChannelId: channelA }
    message.author.style.color = color
    const badge = message.chip.appendChild(new env.Element('yt-live-chat-author-badge-renderer'))
    badge.setAttribute('type', role)
    badge.style.color = color
    badge.appendChild(new env.Element('svg'))
    app.appendChild(message.line)
    const state = env.api.showAuthorCard(env.api.authorSnapshot(env.api.readMessage(message.line)), message.author)
    await settle()
    assert.equal(state.title.textContent, '頻道名稱')
    assert.equal(state.title.style.color, color)
    const identity = state.card.querySelector('.ytuc-identity')
    const nameRow = identity.querySelector('.ytuc-name-row')
    assert.equal(nameRow.children[0], state.title)
    assert.equal(nameRow.children.length, 1)
    assert.equal(state.card.querySelector('.ytuc-badge').style.color, color)
    assert.equal(identity.children[1].className, 'ytuc-handle')
    assert.equal(identity.children[2].className, 'ytuc-id')
    assert.equal(identity.parentElement.className, 'ytuc-header')
    assert.equal(state.card.querySelector('.ytuc-badge-section').parentElement, state.card)
    assert.equal(state.card.querySelector('.ytuc-badge-heading'), null)
  }
})

test('YouTube author cards: highlighted owner names and verified badges never copy dark chip ink onto the card', () => {
  const env = boot()
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const message = env.message('@BlueSR', 'CHAT', 'owner')
  message.chip.setAttribute('is-highlighted', '')
  message.author.style.color = 'rgb(15, 15, 15)'
  const verified = message.author.appendChild(new env.Element('yt-live-chat-author-badge-renderer'))
  verified.setAttribute('type', 'verified')
  verified.setAttribute('aria-label', '確認済み')
  verified.style.color = 'rgb(15, 15, 15)'
  verified.appendChild(new env.Element('svg')).appendChild(new env.Element('path'))
  app.appendChild(message.line)
  const snapshot = env.api.authorSnapshot(env.api.readMessage(message.line))
  const state = env.api.showAuthorCard(snapshot, message.author)
  assert.equal(state.title.style.color, 'var(--yt-live-chat-owner-color, #ffd600)')
  const badges = state.card.querySelectorAll('.ytuc-badge')
  assert.equal(badges[0].style.color, undefined)
  assert.ok(badges[0].querySelector('svg'))
  assert.equal(badges[1].textContent, 'Broadcaster')
  assert.equal(badges[1].style.color, 'var(--yt-live-chat-owner-color, #ffd600)')
  assert.equal(message.author.style.color, 'rgb(15, 15, 15)')
})

test('YouTube filtered messages: highlighted names use role colors without copying dark chip ink', () => {
  for (const [role, expected] of [
    ['owner', 'var(--yt-live-chat-owner-color, #ffd600)'],
    ['moderator', 'var(--yt-live-chat-moderator-color, #5e84f1)'],
    ['', ''],
  ]) {
    const env = boot()
    const history = env.api.getHistory('channel:@host')
    history.settings.users = ['@example']
    const message = env.message('@example', 'hello', role, 'highlighted-message')
    message.chip.setAttribute('is-highlighted', '')
    message.author.style.color = 'rgb(15, 15, 15)'
    assert.equal(env.api.captureLine(message.line, history), true)
    const author = history.messages[0].view.querySelector('strong')
    assert.equal(author.textContent, '@example')
    assert.equal(author.style.color, expected)
    assert.equal(message.author.style.color, 'rgb(15, 15, 15)')
  }
  const env = boot()
  const history = env.api.getHistory('channel:@host')
  const message = env.message('@mod', 'hello', 'moderator', 'normal-message')
  message.author.style.color = 'rgb(62, 166, 255)'
  env.api.captureLine(message.line, history)
  assert.equal(history.messages[0].view.querySelector('strong').style.color, 'rgb(62, 166, 255)')
})

test('YouTube filter mode: close existing cards and never open cards or native menu guards over the filter', () => {
  const env = boot()
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const opener = app.appendChild(new env.Element('button'))
  env.api.showAuthorCard({ user: '@alice', name: '@alice', channelId: '' }, opener)
  assert.ok(env.api.getAuthorCard())
  const state = { history: env.api.getHistory('channel:@host'), panel: new env.Element(), host: new env.Element(),
    button: new env.Element(), scroller: new env.Element(), sourceAriaHidden: null,
    list: new env.Element(), empty: {}, count: {}, latest: {} }
  env.api.setMounted(state)
  env.api.setEnabled(state, true)
  assert.equal(env.api.getAuthorCard(), null)
  assert.equal(env.api.showAuthorCard({ user: '@alice', name: '@alice', channelId: channelA }, opener), undefined)
  assert.equal(env.profileCalls.length, 0)
  const popup = app.appendChild(new env.Element('tp-yt-iron-dropdown'))
  let blocked = false
  env.api.guardMenuDismissal({ type: 'click', target: state.panel, preventDefault() {}, stopImmediatePropagation() { blocked = true } })
  assert.equal(blocked, false)
  assert.equal(popup.hidden, false)
  env.api.setMounted(null)
})

test('YouTube filter layer: use the browser top layer, track the chat bounds and release it on disable', () => {
  const env = boot()
  const panel = new env.Element()
  let opened = 0, closed = 0
  panel.showPopover = () => { opened++ }
  panel.hidePopover = () => { closed++ }
  const host = new env.Element()
  host.getBoundingClientRect = () => ({ left: 40, top: 80, width: 410, height: 500 })
  const state = { panel, host }
  env.api.setPanelLayer(state, true)
  assert.equal(opened, 1)
  assert.equal(panel.getAttribute('popover'), 'manual')
  assert.equal(panel.style.width, '410px')
  assert.equal(panel.style.top, '80px')
  host.getBoundingClientRect = () => ({ left: 50, top: 100, width: 300, height: 400 })
  env.api.positionFilterPanel(state)
  assert.equal(panel.style.left, '50px')
  assert.equal(panel.style.height, '400px')
  env.api.setPanelLayer(state, true)
  assert.equal(opened, 1)
  env.api.setPanelLayer(state, false)
  assert.equal(closed, 1)
  assert.equal(panel.style.position, '')
  assert.equal(panel.getAttribute('popover'), null)
})

test('YouTube filter layer: summaries can shrink the native scroller without shrinking the filter', () => {
  const env = boot()
  const renderer = new env.Element('yt-live-chat-renderer')
  renderer.getBoundingClientRect = () => ({ left: 20, top: 10, width: 330, bottom: 650, height: 640 })
  const input = renderer.appendChild(new env.Element())
  input.id = 'input-panel'
  input.getBoundingClientRect = () => ({ top: 590, height: 60 })
  const header = new env.Element()
  header.getBoundingClientRect = () => ({ bottom: 60 })
  const host = new env.Element()
  host.getBoundingClientRect = () => ({ left: 20, top: 60, width: 330, height: 530 })
  const state = { renderer, header, host, panel: new env.Element(), inTopLayer: true }
  env.api.positionFilterPanel(state)
  assert.equal(state.panel.style.top, '60px')
  assert.equal(state.panel.style.height, '530px')
  host.getBoundingClientRect = () => ({ left: 20, top: 60, width: 330, height: 200 })
  env.api.positionFilterPanel(state)
  assert.equal(state.panel.style.height, '530px')
  // Some native panels replace the input instead of keeping it visible.
  input.getBoundingClientRect = () => ({ top: 0, height: 0 })
  env.api.positionFilterPanel(state)
  assert.equal(state.panel.style.height, '590px')
})

test('YouTube author cards: shrink actual text widths to one line and restore sizes when the card widens', () => {
  const env = boot()
  let available = 120
  const text = (length) => {
    const node = new env.Element()
    Object.defineProperty(node, 'clientWidth', { get: () => available })
    Object.defineProperty(node, 'scrollWidth', { get: () => Math.ceil(length * parseFloat(node.style.fontSize) * 0.6) })
    return node
  }
  const state = { title: text(40), handle: text(30), id: text(24) }
  env.api.fitCardText(state)
  for (const node of Object.values(state)) assert.ok(node.scrollWidth <= node.clientWidth)
  assert.ok(parseFloat(state.title.style.fontSize) < 18)
  available = 600
  env.api.fitCardText(state)
  assert.equal(state.title.style.fontSize, '18px')
  assert.equal(state.handle.style.fontSize, '13px')
  assert.equal(state.id.style.fontSize, '12px')
})

test('YouTube user cards: exactly match chat bounds without an inset or width cap', () => {
  const env = boot()
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const chat = app.appendChild(new env.Element('yt-live-chat-renderer'))
  chat.getBoundingClientRect = () => ({ left: 20.5, right: 720.75, top: 40, width: 700.25, height: 500 })
  const opener = chat.appendChild(new env.Element('button'))
  const state = env.api.showAuthorCard({ user: '@alice', name: '@alice', channelId: '' }, opener)
  assert.equal(state.card.style.left, '20.5px')
  assert.equal(state.card.style.width, '700.25px')
})

test('YouTube card actions: preserve native report service and block navigation items in every language', async () => {
  for (const labels of [['檢舉', '封鎖'], ['報告', 'ブロック'], ['Report', 'Block']]) {
    const blockEndpoint = { showLiveChatDialogEndpoint: { fixture: 'native-block' } }
    const items = [
      { menuServiceItemRenderer: { text: { simpleText: labels[0] }, serviceEndpoint: { fixtureReport: true } } },
      { menuNavigationItemRenderer: { text: { simpleText: labels[1] }, navigationEndpoint: blockEndpoint } },
    ]
    const env = boot({ nativeMenu: () => Promise.resolve({ data: { liveChatItemContextMenuSupportedRenderers: { menuRenderer: {
      items,
    } } } }) })
    const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
    const opener = app.appendChild(new env.Element('button'))
    const state = env.api.showAuthorCard({ user: '@alice', name: '@alice', channelId: '',
      contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'message' } } }, opener)
    await settle()
    const menu = state.menuHost.querySelector('ytd-menu-popup-renderer')
    assert.equal(menu.data.items.map(item => (item.menuServiceItemRenderer || item.menuNavigationItemRenderer).text.simpleText).join('|'), labels.join('|'))
    assert.equal(menu.data.items[1].menuNavigationItemRenderer.navigationEndpoint, blockEndpoint)
  }
})

test('YouTube user cards: outside click dismisses without click-through; native commands retain a connected event path', async () => {
  const env = boot({ nativeMenu: () => Promise.resolve(menuResult('sample')) })
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const opener = app.appendChild(new env.Element('button'))
  const author = { user: '@alice', name: '@alice', channelId: '', contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'sample' } } }
  const state = env.api.showAuthorCard(author, opener)
  let blocked = false
  env.api.guardMenuDismissal({ type: 'click', target: opener, preventDefault() {}, stopImmediatePropagation() { blocked = true } })
  assert.equal(blocked, true)
  assert.equal(env.api.getAuthorCard(), null)
  blocked = false
  env.api.guardMenuDismissal({ type: 'click', target: opener, preventDefault() {}, stopImmediatePropagation() { blocked = true } })
  assert.equal(blocked, false)
  assert.equal(state.card.isConnected, false)
  const next = env.api.showAuthorCard(author, opener)
  await settle()
  const native = next.menuHost.querySelector('ytd-menu-popup-renderer')
  env.listeners.get('yt-action')({ target: native, detail: { actionName: 'yt-close-popup-action' }, stopPropagation() {} })
  assert.equal(env.api.getAuthorCard(), null)
  assert.equal(next.card.hidden, true)
  assert.equal(native.isConnected, true)
  const retire = [...env.timers].find(([, timer]) => timer.delay === 30000)
  assert.ok(retire)
  retire[1].fn()
  assert.equal(native.isConnected, false)
})

test('YouTube user cards: Enter and Space open the author card; Escape returns focus to its opener', () => {
  const env = boot()
  const app = env.document.body.appendChild(new env.Element('yt-live-chat-app'))
  const message = env.message('@keyboard_user', 'hello')
  app.appendChild(message.line)
  const fire = key => env.document.listeners.get('keydown')({ key, target: message.author,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} })
  fire('Enter')
  assert.ok(env.api.getAuthorCard())
  fire('Escape')
  assert.equal(env.api.getAuthorCard(), null)
  assert.equal(env.document.activeElement, message.author)
  fire(' ')
  assert.ok(env.api.getAuthorCard())
})


test('YouTube scopes: preserve legacy channel lists and share global lists without copying them into channels', () => {
  const env = boot({ saved: JSON.stringify({ 'channel:@host': { users: ['@chosen'], moderators: false } }) })
  const first = env.api.getHistory('channel:@host')
  const second = env.api.getHistory('channel:@other')
  assert.equal(first.settings.users.join(','), '@chosen')
  assert.equal(first.settings.moderators, false)
  assert.equal(second.settings.users.length, 0)
  first.settings = env.api.changeTargetUsers(first.settings, '@chosen', false, false, true)
  assert.equal(env.api.saveSettings(first, true), true)
  assert.equal(second.settings.globalUsers.join(','), '@chosen')
  assert.equal(second.settings.users.length, 0)
  second.settings.users = ['@chosen']
  env.api.saveSettings(second)
  const saved = JSON.parse(env.storage.get('youtube-live-chat-tweaks-settings-v1'))
  assert.equal(saved['@global'].users.join(','), '@chosen')
  assert.equal(saved['channel:@other'].globalUsers, undefined)
  const fresh = boot({ saved: env.storage.get('youtube-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.loadSettings('channel:@host').globalUsers.join(','), '@chosen')
  assert.equal(fresh.api.loadSettings('channel:@host').moderators, false)
  first.settings = env.api.changeTargetUsers(first.settings, '@chosen', true, false, true)
  env.api.saveSettings(first, true)
  assert.equal(second.settings.globalUsers.length, 0)
  assert.equal(second.settings.users.join(','), '@chosen')
})

test('YouTube scopes: capture global targets in every channel and let either exclusion list override includes and roles', () => {
  const env = boot()
  const first = env.api.getHistory('channel:@host')
  const second = env.api.getHistory('channel:@other')
  first.settings = env.api.changeTargetUsers(first.settings, '@chosen', false, false, true)
  env.api.saveSettings(first, true)
  const a = env.message('@chosen', 'global in first')
  const b = env.message('@chosen', 'global in second')
  assert.equal(env.api.captureLine(a.line, first), true)
  assert.equal(env.api.captureLine(b.line, second), true)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), true)
  second.settings = env.api.changeTargetUsers(second.settings, '@chosen', false, true)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), false)
  assert.equal(env.api.matchesFilter(first.messages[0], first.settings), true)
  first.settings.users = ['@chosen']
  first.settings = env.api.changeTargetUsers(first.settings, '@chosen', false, true, true)
  env.api.saveSettings(first, true)
  assert.equal(env.api.matchesFilter({ user: '@chosen', moderator: true, broadcaster: true }, first.settings), false)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), false)
  assert.equal(first.messages.length, 1)
})

test('YouTube scopes: global channel IDs keep matching renamed handles in different channels', () => {
  const env = boot()
  const first = env.api.getHistory('channel:@host')
  const second = env.api.getHistory('channel:@other')
  first.settings = env.api.changeTargetUsers(first.settings, channelA, false, false, true)
  env.api.saveSettings(first, true)
  const a = env.message('@old_handle', 'first stream')
  const b = env.message('@new_handle', 'second stream')
  a.line.data = b.line.data = { authorExternalChannelId: channelA }
  assert.equal(env.api.captureLine(a.line, first), true)
  assert.equal(env.api.captureLine(b.line, second), true)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), true)
  first.settings = env.api.changeTargetUsers(first.settings, channelA, false, true, true)
  env.api.saveSettings(first, true)
  assert.equal(env.api.matchesFilter(first.messages[0], first.settings), false)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), false)
})

test('YouTube scopes: sync global edits across stored histories and keep globals for the page when storage is blocked', () => {
  const env = boot()
  const first = env.api.getHistory('channel:@host')
  const second = env.api.getHistory('channel:@other')
  env.storage.set('youtube-live-chat-tweaks-settings-v1', JSON.stringify({ '@global': { users: ['@chosen'], excludedUsers: ['@chosen'] } }))
  env.listeners.get('storage')({ key: 'youtube-live-chat-tweaks-settings-v1' })
  assert.equal(first.settings.globalUsers.join(','), '@chosen')
  assert.equal(second.settings.globalExcludedUsers.join(','), '@chosen')
  env.storage.delete('youtube-live-chat-tweaks-settings-v1')
  env.listeners.get('storage')({ key: null })
  assert.equal(first.settings.globalUsers.length, 0)
  assert.equal(second.settings.globalExcludedUsers.length, 0)
  const blocked = boot({ blocked: true })
  const history = blocked.api.getHistory('channel:@host')
  history.settings = blocked.api.changeTargetUsers(history.settings, '@chosen', false, false, true)
  assert.equal(blocked.api.saveSettings(history, true), false)
  assert.equal(blocked.api.getHistory('channel:@other').settings.globalUsers.join(','), '@chosen')
})
