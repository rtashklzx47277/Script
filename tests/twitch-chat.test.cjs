const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function boot({ saved, blocked = false } = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag
      this.nodeType = 1
      this.children = []
      this.attrs = new Map()
      this.style = {}
      this.textContent = ''
      this.innerHTML = ''
      this.hidden = false
      this.value = ''
    }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })) }
    get firstChild() { return this.children[0] }
    addEventListener() {}
    setAttribute(name, value) { this.attrs.set(name, value) }
    getAttribute(name) { return this.attrs.get(name) || null }
    removeAttribute(name) { this.attrs.delete(name) }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim()
        if (part === '*') return true
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
      copy.innerHTML = this.innerHTML
      copy.textContent = this.textContent
      if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true))
      return copy
    }
  }
  const document = new Element('document')
  document.head = new Element('head')
  document.body = new Element('body')
  document.createElement = tag => new Element(tag)
  document.createTextNode = text => Object.assign(new Element('#text'), { textContent: text })
  const storage = new Map(saved ? [['twitch-live-chat-tweaks-settings-v1', saved]] : [])
  const listeners = new Map()
  const timers = new Map()
  const frames = new Map()
  let nextTimer = 0
  const context = {
    document, location: { pathname: '/sample_channel' }, console,
    window: { addEventListener(name, fn) { listeners.set(name, fn) } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, setInterval() {},
    requestAnimationFrame(fn) { const id = ++nextTimer; frames.set(id, fn); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    MutationObserver: class { observe() {} },
    localStorage: {
      getItem(key) { if (blocked) throw Error('Blocked'); return storage.get(key) || null },
      setItem(key, value) { if (blocked) throw Error('Blocked'); storage.set(key, value) },
    },
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'TwitchLiveChatTweaks.user.js'), 'utf8')
  vm.createContext(context)
  vm.runInContext(source.replace(/\}\)\(\)\s*$/, `globalThis.api = {
    normalizeUsers, getChannel, getHistory, loadSettings, saveSettings, readMessage,
    matchesFilter, captureLine, captureTree, captureMutations, renderMessages, changeTargetUsers, showTargetStatus,
    scheduleMessageRender, releaseMessageViews, handleMessageVisibility,
    setPanelLayer, positionFilterPanel,
    setMounted: state => { mounted = state }
  }; })()`), context)
  const message = (user, text, role = '') => {
    const line = new Element()
    line.setAttribute('data-a-target', 'chat-line-message')
    const authorContainer = line.appendChild(new Element())
    authorContainer.className = 'chat-line__username-container'
    if (role) {
      const badge = authorContainer.appendChild(new Element('img'))
      badge.className = 'chat-badge'
      badge.setAttribute('alt', role)
      if (role === 'localized-mod') badge.setAttribute('src',
        'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1')
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
  return { api: context.api, message, Element, storage, timers, frames, document, location: context.location, listeners,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() } }
}

require('./helpers/chat-update-cases.cjs')({ test, assert, boot, site: 'Twitch' })

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
  for (const [name, badge] of [['MOD_NAME', 'localized-mod'], ['sample_channel', ''], ['chosen', '']]) {
    assert.equal(env.api.captureLine(env.message(name, 'hello', badge).line, history), true)
  }
  assert.equal(env.api.captureLine(env.message('ordinary', 'ignored').line, history), false)
  assert.equal(history.messages.length, 3)
  assert.equal(env.api.matchesFilter(history.messages[0], { moderators: false, broadcaster: false, users: [] }), false)
  assert.equal(env.api.matchesFilter(history.messages[1], { moderators: false, broadcaster: true, users: [] }), true)
  assert.equal(env.api.matchesFilter(history.messages[2], { moderators: false, broadcaster: false, users: ['chosen'] }), true)
})

test('Twitch chat: quoted badges do not grant the author moderator status', () => {
  const env = boot()
  const { line } = env.message('ordinary', 'reply')
  const quote = line.appendChild(new env.Element('img'))
  quote.className = 'chat-badge'
  quote.setAttribute('alt', 'Moderator')
  assert.equal(env.api.readMessage(line, 'sample_channel').moderator, false)
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

test('Twitch chat: channel-specific settings survive reload, message history does not', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  history.settings.users = ['chosen']
  env.api.captureLine(env.message('chosen', 'hello').line, history)
  assert.equal(env.api.saveSettings(history), true)
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.getHistory('sample_channel').settings.users[0], 'chosen')
  assert.equal(fresh.api.getHistory('sample_channel').messages.length, 0)
  assert.equal(fresh.api.getHistory('other_channel').settings.users.length, 0)
  env.location.pathname = '/popout/sample_channel/chat'
  assert.equal(env.api.getChannel(), 'sample_channel')
  env.location.pathname = '/directory'
  assert.equal(env.api.getChannel(), '')
})

test('Twitch chat: cap history and update visible count without forcing a reader to the bottom', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  for (let i = 0; i < 2002; i++) env.api.captureLine(env.message('mod', String(i), 'Moderator').line, history)
  assert.equal(history.messages.length, 2000)
  assert.equal(history.messages[0].view.children.at(-1).innerHTML, '2')
  const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
  state.list.scrollTop = 123
  state.list.scrollHeight = 9999
  history.follow = false
  env.api.renderMessages(state)
  assert.equal(state.list.scrollTop, 123)
  assert.equal(state.count.textContent, '2000 則')
  assert.equal(state.latest.hidden, false)
  history.follow = true
  env.api.renderMessages(state)
  assert.equal(state.list.scrollTop, 9999)
})

test('Twitch targets: accept one login, reject multiple logins, remove only the selected account', () => {
  const env = boot()
  const initial = { moderators: false, broadcaster: true, users: ['alice'] }
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
  env.api.saveSettings({ channel: 'other_channel', settings: initial })
  assert.equal(env.api.loadSettings('sample_channel').users.join(','), 'alice,carol')
  assert.equal(env.api.loadSettings('other_channel').users.join(','), 'alice')
})

test('Twitch targets: remote edits update mounted filters and start capturing the newly added account', () => {
  const env = boot()
  const history = env.api.getHistory('sample_channel')
  history.enabled = true
  const panel = new env.Element()
  for (const name of ['moderators', 'broadcaster', 'users']) {
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
    sample_channel: { moderators: false, broadcaster: false, users: ['alice'] },
  }))
  env.listeners.get('storage')({ key: 'unrelated-setting' })
  assert.equal(history.messages.length, 0)
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(history.messages.length, 1)
  assert.equal(panel.querySelector('.ttc-target-list').children[0].children[0].textContent, 'alice')
  assert.equal(state.count.textContent, '1 則')
  env.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({
    sample_channel: { moderators: false, broadcaster: false, users: [] },
  }))
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
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

test('Twitch exclusions: preserve legacy targets and save normalized exclusions per channel', () => {
  const env = boot({ saved: JSON.stringify({ sample_channel: { users: ['alice'] } }) })
  const history = env.api.getHistory('sample_channel')
  assert.equal(history.settings.users.join(','), 'alice')
  assert.equal(history.settings.excludedUsers.length, 0)
  history.settings = env.api.changeTargetUsers(history.settings, ' @MOD_BOT ', false, true)
  assert.equal(env.api.changeTargetUsers(history.settings, 'a,b', false, true), null)
  env.api.saveSettings(history)
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.loadSettings('sample_channel').excludedUsers.join(','), 'mod_bot')
  assert.equal(fresh.api.loadSettings('sample_channel').users.join(','), 'alice')
  assert.equal(fresh.api.loadSettings('other_channel').excludedUsers.length, 0)
})


test('Twitch scopes: preserve legacy channel lists and share global lists without copying them into channels', () => {
  const env = boot({ saved: JSON.stringify({ 'sample_channel': { users: ['chosen'], moderators: false } }) })
  const first = env.api.getHistory('sample_channel')
  const second = env.api.getHistory('other_channel')
  assert.equal(first.settings.users.join(','), 'chosen')
  assert.equal(first.settings.moderators, false)
  assert.equal(second.settings.users.length, 0)
  first.settings = env.api.changeTargetUsers(first.settings, 'chosen', false, false, true)
  assert.equal(env.api.saveSettings(first, true), true)
  assert.equal(second.settings.globalUsers.join(','), 'chosen')
  assert.equal(second.settings.users.length, 0)
  second.settings.users = ['chosen']
  env.api.saveSettings(second)
  const saved = JSON.parse(env.storage.get('twitch-live-chat-tweaks-settings-v1'))
  assert.equal(saved['@global'].users.join(','), 'chosen')
  assert.equal(saved['other_channel'].globalUsers, undefined)
  const fresh = boot({ saved: env.storage.get('twitch-live-chat-tweaks-settings-v1') })
  assert.equal(fresh.api.loadSettings('sample_channel').globalUsers.join(','), 'chosen')
  assert.equal(fresh.api.loadSettings('sample_channel').moderators, false)
  first.settings = env.api.changeTargetUsers(first.settings, 'chosen', true, false, true)
  env.api.saveSettings(first, true)
  assert.equal(second.settings.globalUsers.length, 0)
  assert.equal(second.settings.users.join(','), 'chosen')
})

test('Twitch scopes: capture global targets in every channel and let either exclusion list override includes and roles', () => {
  const env = boot()
  const first = env.api.getHistory('sample_channel')
  const second = env.api.getHistory('other_channel')
  first.settings = env.api.changeTargetUsers(first.settings, 'chosen', false, false, true)
  env.api.saveSettings(first, true)
  const a = env.message('chosen', 'global in first')
  const b = env.message('chosen', 'global in second')
  assert.equal(env.api.captureLine(a.line, first), true)
  assert.equal(env.api.captureLine(b.line, second), true)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), true)
  second.settings = env.api.changeTargetUsers(second.settings, 'chosen', false, true)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), false)
  assert.equal(env.api.matchesFilter(first.messages[0], first.settings), true)
  first.settings.users = ['chosen']
  first.settings = env.api.changeTargetUsers(first.settings, 'chosen', false, true, true)
  env.api.saveSettings(first, true)
  assert.equal(env.api.matchesFilter({ user: 'chosen', moderator: true, broadcaster: true }, first.settings), false)
  assert.equal(env.api.matchesFilter(second.messages[0], second.settings), false)
  assert.equal(first.messages.length, 1)
})

test('Twitch scopes: sync global edits across stored histories and keep globals for the page when storage is blocked', () => {
  const env = boot()
  const first = env.api.getHistory('sample_channel')
  const second = env.api.getHistory('other_channel')
  env.storage.set('twitch-live-chat-tweaks-settings-v1', JSON.stringify({ '@global': { users: ['chosen'], excludedUsers: ['chosen'] } }))
  env.listeners.get('storage')({ key: 'twitch-live-chat-tweaks-settings-v1' })
  assert.equal(first.settings.globalUsers.join(','), 'chosen')
  assert.equal(second.settings.globalExcludedUsers.join(','), 'chosen')
  env.storage.delete('twitch-live-chat-tweaks-settings-v1')
  env.listeners.get('storage')({ key: null })
  assert.equal(first.settings.globalUsers.length, 0)
  assert.equal(second.settings.globalExcludedUsers.length, 0)
  const blocked = boot({ blocked: true })
  const history = blocked.api.getHistory('sample_channel')
  history.settings = blocked.api.changeTargetUsers(history.settings, 'chosen', false, false, true)
  assert.equal(blocked.api.saveSettings(history, true), false)
  assert.equal(blocked.api.getHistory('other_channel').settings.globalUsers.join(','), 'chosen')
})
