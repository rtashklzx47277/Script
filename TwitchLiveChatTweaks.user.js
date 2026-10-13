// ==UserScript==
// @name        Twitch Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.4.6
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @description Filter chat by broadcaster, moderator and include/exclude account lists, with session history and a header toggle.
// @author      Derek
// @match       *://www.twitch.tv/*
// @run-at      document-idle
// @grant       none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const MESSAGE_SELECTOR = '[data-a-target="chat-line-message"]'
  const USER_SELECTOR = '[data-a-target="chat-message-username"]'
  const STORAGE_KEY = 'twitch-live-chat-tweaks-settings-v1'
  const MAX_MESSAGES = 2000
  const MAX_CHANNELS = 5
  const MODERATOR_BADGE = '3267646d-33f0-4b17-b3df-f923a41db1d0'
  const histories = new Map()
  let mounted = null
  let refreshTimer = 0

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
  const normalizeUsers = (value) => [...new Set(String(value || '')
    .toLowerCase().split(/[\s,，;；]+/).map(name => name.replace(/^@/, ''))
    .filter(name => /^[a-z0-9_]{1,25}$/.test(name)))]

  const getChannel = () => {
    const parts = location.pathname.toLowerCase().split('/').filter(Boolean)
    if (parts[0] === 'popout' && parts[2] === 'chat') return parts[1]
    if (parts.length === 1 && /^[a-z0-9_]+$/.test(parts[0]) &&
      !['directory', 'downloads', 'settings', 'subscriptions', 'wallet', 'inventory', 'videos'].includes(parts[0])) {
      return parts[0]
    }
    return ''
  }

  const readSavedSettings = () => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.assign(Object.create(null), value) : Object.create(null)
    } catch (_) { return Object.create(null) }
  }

  const loadSettings = (channel) => {
    try {
      const saved = readSavedSettings()[channel]
      return {
        moderators: saved?.moderators !== false,
        broadcaster: saved?.broadcaster !== false,
        users: normalizeUsers(Array.isArray(saved?.users) ? saved.users.join(' ') : ''),
        excludedUsers: normalizeUsers(Array.isArray(saved?.excludedUsers) ? saved.excludedUsers.join(' ') : ''),
      }
    } catch (_) {
      return { moderators: true, broadcaster: true, users: [], excludedUsers: [] }
    }
  }

  const saveSettings = (history) => {
    try {
      const saved = readSavedSettings()
      saved[history.channel] = history.settings
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
      return true
    } catch (_) { return false }
  }

  const changeTargetUsers = (settings, input, remove = false, exclude = false) => {
    const user = String(input || '').trim().toLowerCase().replace(/^@/, '')
    if (!/^[a-z0-9_]{1,25}$/.test(user)) return null
    const key = exclude ? 'excludedUsers' : 'users'
    const users = settings[key] || []
    return { ...settings, [key]: remove
      ? users.filter(name => name !== user)
      : [...new Set([...users, user])] }
  }

  const getHistory = (channel) => {
    let history = histories.get(channel)
    if (!history) {
      history = {
        channel, settings: loadSettings(channel), messages: [], nodes: new WeakMap(),
        enabled: false, follow: true,
      }
    }
    histories.delete(channel)
    histories.set(channel, history)
    if (histories.size > MAX_CHANNELS) histories.delete(histories.keys().next().value)
    return history
  }

  const readMessage = (line, channel) => {
    const author = $(USER_SELECTOR, line)
    const user = (author?.getAttribute('data-a-user') || line.getAttribute('data-a-user') || '').toLowerCase()
    const body = $('[data-a-target="chat-line-message-body"]', line)
    if (!user || !author || !body) return null
    // Use the author's badges only: quoted replies can contain another user's badges.
    const authorContainer = author.closest('.chat-line__username-container') || author.parentElement
    const badges = $$('[data-a-target="chat-badge"] img, img.chat-badge', authorContainer)
    const moderator = badges.some(badge =>
      (badge.getAttribute('src') || '').includes(MODERATOR_BADGE) ||
      /^(moderator|管理員|モデレーター)$/i.test(badge.getAttribute('alt') || ''))
    const broadcaster = user === channel || badges.some(badge =>
      /^(broadcaster|實況主|頻道主|配信者)$/i.test(badge.getAttribute('alt') || ''))
    return { user, moderator, broadcaster, author, body, badges }
  }

  const matchesFilter = (message, settings) =>
    !(settings.excludedUsers || []).includes(message.user) && (
      (settings.moderators && message.moderator) ||
      (settings.broadcaster && message.broadcaster) || settings.users.includes(message.user)
    )

  const makeMessageView = (message) => {
    // Copy presentation only. Never keep React-owned message nodes or inactive controls.
    const row = document.createElement('div')
    row.className = 'ttc-message'
    const time = document.createElement('time')
    time.className = 'ttc-time'
    time.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false })
    row.appendChild(time)
    for (const badge of message.badges) {
      const copy = badge.cloneNode(false)
      copy.removeAttribute('tabindex')
      row.appendChild(copy)
    }
    const author = document.createElement('strong')
    author.textContent = message.author.textContent
    author.style.color = message.author.style.color
    author.title = message.user
    row.appendChild(author)
    row.appendChild(document.createTextNode(': '))
    const body = message.body.cloneNode(true)
    for (const node of [body, ...$$('*', body)]) {
      for (const attr of [...node.attributes]) {
        if (attr.name === 'id' || attr.name === 'tabindex' || attr.name === 'role' ||
          attr.name.startsWith('on') || attr.name.startsWith('data-')) node.removeAttribute(attr.name)
      }
    }
    for (const link of $$('a', body)) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
    row.appendChild(body)
    return row
  }

  const captureLine = (line, history) => {
    const message = readMessage(line, history.channel)
    if (!message) return false
    // Keep both roles even when unchecked so turning a role back on restores its history.
    if (!message.moderator && !message.broadcaster && !history.settings.users.includes(message.user)) return false
    const fingerprint = `${message.user}\n${message.body.innerHTML}`
    const previous = history.nodes.get(line)
    if (previous?.fingerprint === fingerprint) return false
    const view = makeMessageView(message)
    if (previous && previous.user === message.user && history.messages.includes(previous)) {
      // Reflect edits/deletion placeholders while the original line is still present.
      view.firstChild.textContent = previous.view.firstChild.textContent
      previous.view.replaceWith(view)
      Object.assign(previous, { moderator: message.moderator,
        broadcaster: message.broadcaster, view, fingerprint })
    } else {
      const record = { user: message.user, moderator: message.moderator,
        broadcaster: message.broadcaster, view, fingerprint }
      history.nodes.set(line, record)
      history.messages.push(record)
      if (history.messages.length > MAX_MESSAGES) history.messages.shift().view.remove()
    }
    return true
  }

  const captureTree = (node, history) => {
    if (node.nodeType !== 1) return false
    let changed = false
    if (node.matches(MESSAGE_SELECTOR)) changed = captureLine(node, history)
    for (const line of $$(MESSAGE_SELECTOR, node)) changed = captureLine(line, history) || changed
    return changed
  }

  const renderMessages = (state, rebuild = false) => {
    const { history, list, empty, count, latest } = state
    if (rebuild) list.replaceChildren()
    let visible = 0
    for (const record of history.messages) {
      const show = matchesFilter(record, history.settings)
      record.view.hidden = !show
      if (show) visible++
      if (record.view.parentElement !== list) list.appendChild(record.view)
    }
    empty.hidden = visible > 0
    count.textContent = `${visible} 則`
    if (history.follow) list.scrollTop = list.scrollHeight
    latest.hidden = history.follow
  }

  const setEnabled = (state, enabled) => {
    state.history.enabled = enabled
    state.host.classList.toggle('ttc-active', enabled)
    state.panel.hidden = !enabled
    state.button.setAttribute('aria-pressed', String(enabled))
    state.button.title = enabled ? '顯示一般聊天室' : '只看 Broadcaster、Moderator 與指定用戶'
    if (enabled) renderMessages(state)
  }

  const renderTargets = (state) => {
    const { panel, history } = state
    const exclude = state.targetMode === 'exclude'
    const targets = exclude ? history.settings.excludedUsers || [] : history.settings.users
    const includeButton = $('.ttc-mode-include', panel)
    const excludeButton = $('.ttc-mode-exclude', panel)
    includeButton.textContent = `＋ 包含（${history.settings.users.length}）`
    excludeButton.textContent = `－ 排除（${(history.settings.excludedUsers || []).length}）`
    includeButton.setAttribute('aria-pressed', String(!exclude))
    excludeButton.setAttribute('aria-pressed', String(exclude))
    const query = $('[name="search-users"]', panel).value.trim().toLowerCase().replace(/^@/, '')
    const users = targets.filter(user => user.includes(query)).sort()
    const list = $('.ttc-target-list', panel)
    list.setAttribute('aria-label', exclude ? '排除帳號清單' : '包含帳號清單')
    list.replaceChildren()
    for (const user of users) {
      const row = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = user
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '移除'
      remove.setAttribute('aria-label', `移除 ${user}`)
      remove.addEventListener('click', () => {
        state.updateSettings(changeTargetUsers(history.settings, user, true, exclude),
          exclude ? `已取消排除 ${user}。` : `已移除 ${user}。`)
      })
      row.appendChild(name)
      row.appendChild(remove)
      list.appendChild(row)
    }
    const empty = $('.ttc-target-empty', panel)
    empty.hidden = users.length > 0
    empty.textContent = targets.length ? '找不到符合搜尋的帳號。'
      : exclude ? '尚未排除任何帳號。' : '尚未新增目標帳號。'
  }

  const showTargetStatus = (state, message = '') => {
    clearTimeout(state.statusTimer)
    state.status.textContent = message
    state.statusTimer = message ? setTimeout(() => {
      state.status.textContent = ''
      state.statusTimer = 0
    }, 3000) : 0
  }

  const createPanel = (state) => {
    const panel = document.createElement('section')
    panel.className = 'ttc-panel'
    panel.setAttribute('aria-label', '指定用戶聊天室')
    panel.innerHTML = `
      <div class="ttc-toolbar">
        <div class="ttc-options">
          <button type="button" class="ttc-target-summary" aria-label="目標用戶" aria-controls="ttc-target-settings" aria-expanded="false">目標用戶</button>
          <span class="ttc-count"></span>
        </div>
        <div class="ttc-targets" id="ttc-target-settings" hidden>
          <div class="ttc-roles">
            <label><input type="checkbox" name="broadcaster"> Broadcaster</label>
            <label><input type="checkbox" name="moderators"> Moderator</label>
          </div>
          <div class="ttc-target-modes" role="group" aria-label="帳號篩選方式">
            <button type="button" class="ttc-mode-include" aria-label="＋ 包含">＋ 包含</button>
            <button type="button" class="ttc-mode-exclude" aria-label="－ 排除">－ 排除</button>
          </div>
          <form class="ttc-users">
            <label>新增帳號<input type="text" name="users" placeholder="英文帳號" autocomplete="off" spellcheck="false"></label>
            <button type="submit">新增</button>
          </form>
          <label class="ttc-target-search">搜尋帳號<input type="search" name="search-users" placeholder="搜尋目標帳號" autocomplete="off"></label>
          <ul class="ttc-target-list" aria-label="目標用戶清單"></ul>
          <p class="ttc-target-empty"></p>
          <p class="ttc-target-status" role="status" aria-live="polite"></p>
        </div>
      </div>
      <p class="ttc-empty">尚無符合條件的發言。新增目標帳號後開始收集。</p>
      <div class="ttc-list" role="log" aria-label="篩選後的聊天訊息" aria-live="off"></div>
      <button class="ttc-latest" type="button" hidden>回到最新訊息</button>`
    state.panel = panel
    state.list = $('.ttc-list', panel)
    state.empty = $('.ttc-empty', panel)
    state.count = $('.ttc-count', panel)
    state.latest = $('.ttc-latest', panel)
    const moderators = $('[name="moderators"]', panel)
    const broadcaster = $('[name="broadcaster"]', panel)
    const users = $('[name="users"]', panel)
    moderators.checked = state.history.settings.moderators
    broadcaster.checked = state.history.settings.broadcaster
    state.status = $('.ttc-target-status', panel)
    state.targetMode = 'include'
    state.updateSettings = (settings, message = '') => {
      state.history.settings = settings
      const saved = saveSettings(state.history)
      showTargetStatus(state, saved ? message : '此瀏覽器無法儲存設定；設定僅保留至本次頁面結束。')
      renderTargets(state)
      captureTree(state.scroller, state.history)
      renderMessages(state, true)
    }
    const applyRoles = () => state.updateSettings({ ...state.history.settings,
      moderators: moderators.checked, broadcaster: broadcaster.checked })
    moderators.addEventListener('change', applyRoles)
    broadcaster.addEventListener('change', applyRoles)
    $('.ttc-users', panel).addEventListener('submit', event => {
      event.preventDefault()
      const exclude = state.targetMode === 'exclude'
      const key = exclude ? 'excludedUsers' : 'users'
      const nextSettings = changeTargetUsers(state.history.settings, users.value, false, exclude)
      if (!nextSettings) {
        showTargetStatus(state, '請輸入一個英文帳號。')
        return
      }
      const added = nextSettings[key].length - (state.history.settings[key] || []).length
      state.updateSettings(nextSettings, added
        ? exclude ? '已排除帳號。' : '已新增帳號。'
        : '此帳號已在名單中。')
      users.value = ''
    })
    const setTargetMode = mode => {
      state.targetMode = mode
      showTargetStatus(state)
      renderTargets(state)
    }
    $('.ttc-mode-include', panel).addEventListener('click', () => setTargetMode('include'))
    $('.ttc-mode-exclude', panel).addEventListener('click', () => setTargetMode('exclude'))
    $('[name="search-users"]', panel).addEventListener('input', () => renderTargets(state))
    const targetSettings = $('.ttc-targets', panel)
    const targetButton = $('.ttc-target-summary', panel)
    const setTargetsOpen = open => {
      targetSettings.hidden = !open
      targetButton.setAttribute('aria-expanded', String(open))
      panel.classList.toggle('ttc-managing', open)
    }
    targetButton.addEventListener('click', () => setTargetsOpen(targetSettings.hidden))
    setTargetsOpen(state.history.settings.users.length === 0)
    renderTargets(state)
    state.list.addEventListener('scroll', () => {
      state.history.follow = state.list.scrollHeight - state.list.scrollTop - state.list.clientHeight < 40
      state.latest.hidden = state.history.follow
    }, { passive: true })
    state.latest.addEventListener('click', () => {
      state.history.follow = true
      renderMessages(state)
    })
    state.host.appendChild(panel)
  }

  const unmount = () => {
    if (!mounted) return
    clearTimeout(mounted.statusTimer)
    mounted.observer.disconnect()
    mounted.button.remove()
    mounted.panel.remove()
    mounted.host.classList.remove('ttc-host', 'ttc-active')
    mounted.scroller.classList.remove('ttc-source')
    mounted = null
  }

  const refresh = () => {
    const channel = getChannel()
    const header = $('.stream-chat-header')
    const stream = header?.closest('.stream-chat')
    const scroller = stream && $('[data-a-target="chat-scroller"]', stream)
    if (mounted && (mounted.history.channel !== channel || mounted.header !== header ||
      mounted.scroller !== scroller || !mounted.button.isConnected || !mounted.panel.isConnected)) unmount()
    if (mounted || !channel || !header || !scroller?.parentElement) return
    const state = { history: getHistory(channel), header, scroller, host: scroller.parentElement }
    state.host.classList.add('ttc-host')
    scroller.classList.add('ttc-source')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ttc-toggle'
    button.setAttribute('aria-label', '切換指定用戶聊天室')
    button.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h18v2l-7 8v6l-4 2v-8L3 6V4zm3 2 6 7 6-7H6z"/></svg>`
    state.button = button
    const community = $('[data-test-selector="chat-viewer-list"]', header)
    const actions = community?.parentElement?.parentElement
    if (actions && header.contains(actions)) actions.insertBefore(button, community.parentElement)
    else header.appendChild(button)
    button.addEventListener('click', () => setEnabled(state, !state.history.enabled))
    createPanel(state)
    captureTree(scroller, state.history)
    state.observer = new MutationObserver(mutations => {
      if (getChannel() !== state.history.channel) { scheduleRefresh(); return }
      let changed = false
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) changed = captureTree(node, state.history) || changed
        const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement
        const line = element?.closest(MESSAGE_SELECTOR)
        if (line) changed = captureLine(line, state.history) || changed
      }
      if (changed && state.history.enabled) renderMessages(state)
    })
    state.observer.observe(scroller, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-a-user', 'alt', 'src'] })
    mounted = state
    setEnabled(state, state.history.enabled)
  }

  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => { refreshTimer = 0; refresh() }, 250)
  }

  const syncSettings = () => {
    for (const history of histories.values()) history.settings = loadSettings(history.channel)
    if (!mounted) return
    const { panel, history } = mounted
    $('[name="moderators"]', panel).checked = history.settings.moderators
    $('[name="broadcaster"]', panel).checked = history.settings.broadcaster
    renderTargets(mounted)
    captureTree(mounted.scroller, history)
    if (history.enabled) renderMessages(mounted, true)
  }

  const style = document.createElement('style')
  style.textContent = `
    .ttc-toggle { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 32px; width: 32px; height: 32px; padding: 4px; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }
    .ttc-toggle:hover { background: var(--color-background-button-text-hover, #ffffff22); }
    .ttc-toggle[aria-pressed="true"] { color: var(--color-text-link, #bf94ff); background: var(--color-background-button-text-hover, #ffffff22); }
    .ttc-toggle:focus-visible, .ttc-panel button:focus-visible { outline: 2px solid #9147ff; outline-offset: -2px; }
    .ttc-host { position: relative; }
    .ttc-active > .ttc-source { visibility: hidden; pointer-events: none; }
    .ttc-panel { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; min-height: 0; color: var(--color-text-base, #efeff1); background: var(--color-background-base, #18181b); font-size: 13px; }
    .ttc-panel [hidden], .ttc-panel[hidden] { display: none !important; }
    .ttc-toolbar { flex: 0 0 auto; padding: 10px; border-bottom: 1px solid var(--color-border-base, #ffffff22); }
    .ttc-options { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; font-size: 12px; }
    .ttc-roles { display: flex; align-items: center; gap: 12px; flex-shrink: 0; margin-bottom: 12px; }
    .ttc-roles label { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
    .ttc-roles input { width: 13px; height: 13px; margin: 0; accent-color: #9147ff; }
    .ttc-count { margin-left: auto; flex-shrink: 0; white-space: nowrap; color: var(--color-text-alt-2, #adadb8); }
    .ttc-users { display: flex; align-items: center; gap: 6px; }
    .ttc-users label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; white-space: nowrap; }
    .ttc-users input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--color-border-base, #ffffff44); border-radius: 4px; color: inherit; background: var(--color-background-input, #ffffff11); font-size: 12px; }
    .ttc-panel button { padding: 6px 10px; border: 0; border-radius: 4px; color: #fff; background: #9147ff; cursor: pointer; }
    .ttc-users input, .ttc-users button[type="submit"] { box-sizing: border-box; height: 30px; font: inherit; }
    .ttc-users button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0 10px; border: 1px solid transparent; border-radius: 4px; font-weight: 600; line-height: 1; }
    .ttc-empty { padding: 16px 12px; color: var(--color-text-alt-2, #adadb8); }
    .ttc-list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 6px 0; }
    .ttc-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; }
    .ttc-message:hover { background: var(--color-background-button-text-hover, #ffffff11); }
    .ttc-time { margin-right: 6px; color: var(--color-text-alt-2, #adadb8); font-size: 10px; }
    .ttc-message > img { width: 18px; height: 18px; margin-right: 3px; vertical-align: middle; }
    .ttc-message .chat-image { max-height: 28px; vertical-align: middle; }
    .ttc-latest { position: absolute; bottom: 8px; align-self: center; }
    .ttc-managing > .ttc-toolbar { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
    .ttc-managing > .ttc-empty, .ttc-managing > .ttc-list, .ttc-managing > .ttc-latest { display: none !important; }
    .ttc-options { flex-shrink: 0; }
    .ttc-panel .ttc-target-summary { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 0; color: var(--color-text-link, #bf94ff); background: transparent; white-space: nowrap; font: inherit; cursor: pointer; }
    .ttc-target-summary::before { content: '▸'; }
    .ttc-target-summary[aria-expanded="true"]::before { content: '▾'; }
    .ttc-targets { margin-top: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .ttc-targets > :not(.ttc-target-list) { flex-shrink: 0; }
    .ttc-target-modes { display: flex; gap: 6px; margin-bottom: 8px; }
    .ttc-target-modes button { flex: 1; padding: 4px 8px; color: inherit; background: var(--color-background-button-text-hover, #ffffff22); font-size: 12px; }
    .ttc-target-modes button[aria-pressed="true"] { color: #fff; background: #9147ff; }
    .ttc-target-search { display: flex; align-items: center; gap: 6px; margin-top: 8px; white-space: nowrap; }
    .ttc-target-search input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--color-border-base, #ffffff44); border-radius: 4px; color: inherit; background: var(--color-background-input, #ffffff11); font-size: 12px; }
    .ttc-target-list { list-style: none; padding: 0; margin: 6px 0 0; flex: 1; min-height: 40px; overflow-y: auto; }
    .ttc-target-list li { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 0; }
    .ttc-target-list span { overflow-wrap: anywhere; }
    .ttc-target-list button { flex-shrink: 0; padding: 3px 8px; background: var(--color-background-button-text-hover, #ffffff22); color: inherit; font-size: 11px; }
    .ttc-target-empty, .ttc-target-status { margin: 6px 0 0; font-size: 11px; color: var(--color-text-alt-2, #adadb8); }
    .ttc-target-status:empty { display: none; }
  `
  ;(document.head || document.documentElement).appendChild(style)
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) syncSettings()
  })
  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => {
      const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement
      return !element?.closest('.ttc-panel, .ttc-toggle, [data-a-target="chat-scroller"]')
    })) scheduleRefresh()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('popstate', scheduleRefresh)
  // Twitch's SPA can reuse the same chat nodes on pushState without adding DOM.
  let lastPath = location.pathname
  setInterval(() => {
    if (lastPath === location.pathname) return
    lastPath = location.pathname
    scheduleRefresh()
  }, 1000)
  refresh()
})()
