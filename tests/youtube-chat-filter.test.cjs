const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function boot({ saved, blocked = false, trustedTypes = false } = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag
      this.nodeType = 1
      this.children = []
      this.attrs = new Map()
      this.style = {}
      this.textContent = ''
      this._innerHTML = ''
      this.hidden = false
      this.value = ''
    }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })) }
    get firstChild() { return this.children[0] }
    get innerHTML() { return this._innerHTML }
    set innerHTML(value) {
      if (trustedTypes) throw new TypeError('This document requires TrustedHTML assignment')
      this._innerHTML = value
    }
    get isConnected() { return this === document || !!this.parentElement?.isConnected }
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
      this.listeners.set(name, handler)
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
    appendChild(child) {
      child.remove()
      this.children.push(child)
      child.parentElement = this
      return child
    }
    insertAdjacentElement(position, child) {
      assert.equal(position, 'beforebegin')
      child.remove()
      const parent = this.parentElement
      parent.children.splice(parent.children.indexOf(this), 0, child)
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
  const context = {
    document, location: { pathname: '/live_chat', href: 'https://www.youtube.com/live_chat?v=sample_video', origin: 'https://www.youtube.com' }, console, URL,
    window: { addEventListener(name, fn) { listeners.set(name, fn) } },
    setTimeout() {}, setInterval() {}, requestAnimationFrame() {},
    Node: { ELEMENT_NODE: 1 }, HTMLElement: Element, AbortController,
    getComputedStyle: () => ({ color: 'white', display: 'block', visibility: 'visible' }),
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
      readMessage, matchesFilter, captureLine, captureTree, renderMessages, changeTargetUsers,
      refresh, setEnabled, get mounted() { return mounted } };
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
  return { api: context.api, message, Element, storage, location: context.location, document, window: context.window }
}

test('YouTube filters: mount, toggle and remount when Trusted Types rejects HTML strings', () => {
  const env = boot({ trustedTypes: true })
  const { document, Element, api } = env
  const header = document.body.appendChild(new Element('yt-live-chat-header-renderer'))
  const menu = header.appendChild(new Element('yt-live-chat-button'))
  menu.id = 'live-chat-header-context-menu'
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
  assert.ok(state.panel.isConnected)
  assert.ok(state.panel.querySelector('.ytcf-targets').querySelector('[name="broadcaster"]'))
  assert.equal(state.panel.querySelector('.ytcf-options').querySelector('[name="moderators"]'), null)
  assert.equal(state.panel.querySelector('.ytcf-target-summary').getAttribute('aria-expanded'), 'true')
  assert.ok(state.panel.className.includes('ytcf-managing'))
  state.panel.querySelector('.ytcf-target-summary').listeners.get('click')()
  assert.equal(state.panel.querySelector('.ytcf-target-summary').getAttribute('aria-expanded'), 'false')
  assert.equal(state.panel.className.includes('ytcf-managing'), false)
  assert.equal(state.panel.hidden, true)
  api.setEnabled(state, true)
  assert.equal(state.panel.hidden, false)
  assert.equal(state.count.textContent, '1 則')
  assert.equal(scroller.getAttribute('aria-hidden'), 'true')
  state.button.remove()
  api.refresh()
  state = api.mounted
  assert.equal(header.querySelectorAll('#yt-chat-tweaks-filter-button').length, 1)
  assert.equal(host.querySelectorAll('.ytcf-panel').length, 1)
  assert.equal(state.count.textContent, '1 則')
  api.setEnabled(state, false)
  assert.equal(scroller.getAttribute('aria-hidden'), null)
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
