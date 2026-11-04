// ==UserScript==
// @name        Twitch Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.7.0
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @description 依頻道主、管理員與帳號包含／排除名單篩選 Twitch 聊天，支援頻道／全域設定、7 天紀錄與自動跟隨。
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
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
  const OLDER_BATCH = 200
  const ARCHIVE_DB = 'twitch-live-chat-tweaks-history-v1'
  const pageKey = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  let archiveDatabase = null
  let messageOrder = 0
  let anonymousMessage = 0
  const MODERATOR_BADGE = '3267646d-33f0-4b17-b3df-f923a41db1d0'
  const histories = new Map()
  let globalTargets = { users: [], excludedUsers: [] }
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
      const stored = readSavedSettings()
      const saved = stored[channel]
      const global = stored['@global'] || globalTargets
      globalTargets = {
        users: normalizeUsers(Array.isArray(global.users) ? global.users.join(' ') : ''),
        excludedUsers: normalizeUsers(Array.isArray(global.excludedUsers) ? global.excludedUsers.join(' ') : ''),
      }
      return {
        moderators: saved?.moderators !== false,
        broadcaster: saved?.broadcaster !== false,
        users: normalizeUsers(Array.isArray(saved?.users) ? saved.users.join(' ') : ''),
        excludedUsers: normalizeUsers(Array.isArray(saved?.excludedUsers) ? saved.excludedUsers.join(' ') : ''),
        globalUsers: globalTargets.users, globalExcludedUsers: globalTargets.excludedUsers,
      }
    } catch (_) {
      return { moderators: true, broadcaster: true, users: [], excludedUsers: [],
        globalUsers: globalTargets.users, globalExcludedUsers: globalTargets.excludedUsers }
    }
  }

  const saveSettings = (history, global = false) => {
    const { moderators, broadcaster, users, excludedUsers = [], globalUsers = [], globalExcludedUsers = [] } = history.settings
    if (global) {
      globalTargets = { users: globalUsers, excludedUsers: globalExcludedUsers }
      for (const item of histories.values()) Object.assign(item.settings, { globalUsers, globalExcludedUsers })
    }
    try {
      const saved = readSavedSettings()
      if (global) saved['@global'] = globalTargets
      else saved[history.channel] = { moderators, broadcaster, users, excludedUsers }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
      return true
    } catch (_) { return false }
  }

  const changeTargetUsers = (settings, input, remove = false, exclude = false, global = false) => {
    const user = String(input || '').trim().toLowerCase().replace(/^@/, '')
    if (!/^[a-z0-9_]{1,25}$/.test(user)) return null
    const key = global ? exclude ? 'globalExcludedUsers' : 'globalUsers' : exclude ? 'excludedUsers' : 'users'
    const users = settings[key] || []
    return { ...settings, [key]: remove
      ? users.filter(name => name !== user)
      : [...new Set([...users, user])] }
  }

  const openArchive = () => {
    if (!archiveDatabase) archiveDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open(ARCHIVE_DB, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('messages', { keyPath: ['scope', 'storageId'] })
        store.createIndex('scope', 'scope')
        store.createIndex('expiresAt', 'expiresAt')
      }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => { database.close(); archiveDatabase = null }
        resolve(database)
      }
      request.onerror = () => { archiveDatabase = null; reject(request.error) }
      request.onblocked = () => { archiveDatabase = null; reject(new Error('History database is blocked')) }
    })
    return archiveDatabase
  }
  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('History transaction failed'))
  })
  const pruneArchive = async () => {
    if (typeof indexedDB === 'undefined') return
    const database = await openArchive()
    const transaction = database.transaction('messages', 'readwrite')
    const done = transactionDone(transaction)
    const request = transaction.objectStore('messages').index('expiresAt').openCursor()
    const now = Date.now()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || cursor.value.expiresAt > now) return
      cursor.delete()
      cursor.continue()
    }
    await done
  }

  // Persist inert presentation only, including picture/srcset emotes. Native
  // buttons become spans so restored emotes cannot become inactive controls.
  const ARCHIVE_TAGS = new Set(['div', 'span', 'strong', 'time', 'img', 'a', 'b', 'i', 'em', 'br', 'picture', 'source'])
  const ARCHIVE_ATTRIBUTES = new Set(['class', 'src', 'srcset', 'alt', 'href', 'aria-label', 'width', 'height', 'type', 'dir'])
  const ARCHIVE_STYLES = ['color', 'fontWeight', 'fontStyle', 'textDecoration', 'width', 'height',
    'maxWidth', 'maxHeight', 'display', 'position', 'top', 'right', 'bottom', 'left', 'verticalAlign', 'transform']
  const archiveTree = (node, depth = 0) => {
    if (depth > 20) return null
    if (node.nodeType === 3 || node.tagName === '#text') return { text: node.textContent }
    if (node.nodeType !== 1) return null
    const tag = (node.localName || node.tagName).toLowerCase()
    if (['script', 'style', 'iframe', 'object', 'embed', 'input'].includes(tag)) return null
    return { tag: ARCHIVE_TAGS.has(tag) ? tag : 'span',
      attributes: [...node.attributes].filter(attr => ARCHIVE_ATTRIBUTES.has(attr.name)).map(attr => [attr.name, attr.value]),
      styles: ARCHIVE_STYLES.filter(name => node.style[name]).map(name => [name, node.style[name]]),
      children: [...node.childNodes].map(child => archiveTree(child, depth + 1)).filter(Boolean) }
  }
  const safeArchiveUrl = value => {
    if (typeof value !== 'string' || !value.trim()) return ''
    try {
      const url = new URL(value, location.href)
      return ['https:', 'http:'].includes(url.protocol) || /^data:image\/(png|gif|jpe?g|webp|avif);base64,/i.test(value) ? url.href : ''
    } catch (_) { return '' }
  }
  const safeSrcset = value => value.split(',').map(part => {
    const [url, descriptor, extra] = part.trim().split(/\s+/)
    const safe = safeArchiveUrl(url)
    return safe && !extra && (!descriptor || /^\d+(?:\.\d+)?[wx]$/.test(descriptor))
      ? [safe, descriptor].filter(Boolean).join(' ') : ''
  }).filter(Boolean).join(', ')
  const restoreTree = (tree, budget = { remaining: 3000 }, depth = 0) => {
    if (!tree || typeof tree !== 'object' || depth > 20 || --budget.remaining < 0) return null
    if (typeof tree.text === 'string') return document.createTextNode(tree.text)
    const tag = ARCHIVE_TAGS.has(tree.tag) ? tree.tag : 'span'
    const node = document.createElement(tag)
    for (const attr of Array.isArray(tree.attributes) ? tree.attributes : []) {
      if (!Array.isArray(attr) || attr.length !== 2) continue
      let [name, value] = attr
      if (!ARCHIVE_ATTRIBUTES.has(name) || typeof value !== 'string') continue
      if (name === 'src' || name === 'href') value = safeArchiveUrl(value)
      if (name === 'srcset') value = safeSrcset(value)
      if (value) node.setAttribute(name, value)
    }
    if (tag === 'a') { node.target = '_blank'; node.rel = 'noopener noreferrer' }
    for (const entry of Array.isArray(tree.styles) ? tree.styles : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [name, value] = entry
      if (!ARCHIVE_STYLES.includes(name) || typeof value !== 'string') continue
      if (name === 'position' && !['static', 'relative', 'absolute'].includes(value)) continue
      node.style[name] = value
    }
    for (const child of Array.isArray(tree.children) ? tree.children : []) {
      const restored = restoreTree(child, budget, depth + 1)
      if (restored) node.appendChild(restored)
    }
    return node
  }
  const archiveRecord = (history, record) => ({
    scope: history.scope, storageId: record.storageId, id: record.id, user: record.user,
    createdAt: record.createdAt, order: record.order, expiresAt: record.createdAt + RETENTION_MS,
    moderator: record.moderator, broadcaster: record.broadcaster,
    fingerprint: record.fingerprint, tree: archiveTree(record.view),
  })
  const validArchiveRecord = (saved, scope) => saved && saved.scope === scope &&
    typeof saved.storageId === 'string' && typeof saved.id === 'string' &&
    typeof saved.user === 'string' && /^[a-z0-9_]{1,25}$/.test(saved.user) &&
    Number.isFinite(saved.createdAt) && saved.createdAt <= Date.now() && saved.createdAt + RETENTION_MS > Date.now() &&
    saved.tree && typeof saved.tree === 'object'
  const restoreRecord = saved => {
    if (saved.tree?.tag !== 'div') return null
    const view = restoreTree(saved.tree)
    if (!view || view.firstChild?.tagName?.toLowerCase() !== 'time') return null
    view.className = 'ttc-message'
    return { id: saved.id, storageId: saved.storageId, user: saved.user, createdAt: saved.createdAt,
      order: Number.isSafeInteger(saved.order) ? saved.order : 0,
      moderator: saved.moderator === true, broadcaster: saved.broadcaster === true,
      fingerprint: saved.fingerprint, view, retained: true }
  }
  const updateArchiveStatus = history => {
    if (mounted?.history !== history || !mounted.panel) return
    const status = $('.ttc-history-status', mounted.panel)
    if (!status) return
    status.hidden = history.archiveReady && !history.archiveError
    status.textContent = history.archiveError ? '此瀏覽器無法保存紀錄；目前僅暫存於本次頁面。'
      : history.archiveReady ? '' : '正在載入已保存的紀錄…'
  }
  const loadOlderRecords = state => {
    const { history, list } = state
    const saved = [...history.older.values()].slice(-OLDER_BATCH)
    const restored = []
    const beforeHeight = list.scrollHeight
    const beforeTop = list.scrollTop
    for (const item of saved) {
      history.older.delete(item.storageId)
      if (!validArchiveRecord(item, history.scope)) continue
      const record = restoreRecord(item)
      if (!record) continue
      restored.push(record)
      if (record.id) history.ids.set(record.id, record)
    }
    history.displayLimit += restored.length
    history.messages.push(...restored)
    history.messages.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
    history.follow = false
    renderMessages(state, true)
    list.scrollTop = beforeTop + list.scrollHeight - beforeHeight
  }

  const flushHistory = async history => {
    if (!history.archiveReady || history.archiveError) return
    if (history.writePromise) {
      try { await history.writePromise } catch (_) {}
      return flushHistory(history)
    }
    if (!history.saveQueue.size) return
    const batch = [...history.saveQueue.values()]
    history.saveQueue.clear()
    history.writePromise = (async () => {
      const database = await openArchive()
      const transaction = database.transaction('messages', 'readwrite')
      const done = transactionDone(transaction)
      const store = transaction.objectStore('messages')
      for (const saved of batch) {
        const request = store.get([saved.scope, saved.storageId])
        request.onsuccess = () => {
          const previous = request.result
          if (previous && Number.isFinite(previous.createdAt) && previous.createdAt <= saved.createdAt) {
            saved.createdAt = previous.createdAt
            saved.order = Number.isSafeInteger(previous.order) ? previous.order : saved.order
          }
          saved.expiresAt = saved.createdAt + RETENTION_MS
          const current = saved.id ? history.ids.get(saved.id) : null
          if (current?.storageId === saved.storageId) {
            current.createdAt = Math.min(current.createdAt, saved.createdAt)
            current.order = saved.order
          }
          const older = history.older.get(saved.storageId)
          if (older) older.createdAt = Math.min(older.createdAt, saved.createdAt)
          if (saved.expiresAt > Date.now()) store.put(saved)
        }
      }
      await done
    })()
    try { await history.writePromise }
    catch (_) {
      history.archiveError = true
      updateArchiveStatus(history)
    } finally { history.writePromise = null }
  }
  const saveRecord = (history, record) => {
    if (history.archiveError) return
    const saved = archiveRecord(history, record)
    if (history.older.has(record.storageId)) history.older.set(record.storageId, saved)
    history.saveQueue.set(record.storageId, saved)
    if (history.saveScheduled) return
    history.saveScheduled = true
    Promise.resolve().then(() => { history.saveScheduled = false; return flushHistory(history) })
  }
  const trimHistory = history => {
    while (history.messages.length > history.displayLimit) {
      const oldest = history.messages.shift()
      if (!history.archiveError) history.older.set(oldest.storageId, archiveRecord(history, oldest))
      forgetRecord(history, oldest)
    }
  }
  const restoreHistory = async history => {
    if (typeof indexedDB === 'undefined') {
      history.archiveReady = true
      history.archiveError = true
      return
    }
    try {
      const database = await openArchive()
      await pruneArchive()
      const transaction = database.transaction('messages', 'readonly')
      const done = transactionDone(transaction)
      const request = transaction.objectStore('messages').index('scope').getAll(history.scope)
      const read = new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [saved] = await Promise.all([read, done])
      const records = saved.filter(item => validArchiveRecord(item, history.scope))
        .sort((a, b) => a.createdAt - b.createdAt || (a.order || 0) - (b.order || 0))
      for (const item of records) {
        const current = item.id ? history.ids.get(item.id) : null
        if (current) {
          current.createdAt = Math.min(current.createdAt, item.createdAt)
          current.order = Number.isSafeInteger(item.order) ? item.order : current.order
          current.view.firstChild.textContent = restoreTree(item.tree)?.firstChild?.textContent || current.view.firstChild.textContent
          saveRecord(history, current)
        } else history.older.set(item.storageId, item)
      }
      const take = Math.max(0, history.displayLimit - history.messages.length)
      const latest = take ? [...history.older.values()].slice(-take) : []
      const restored = []
      for (const item of latest) {
        history.older.delete(item.storageId)
        const record = restoreRecord(item)
        if (!record) continue
        restored.push(record)
        if (record.id) history.ids.set(record.id, record)
        history.dirty.add(record)
      }
      history.messages.unshift(...restored)
      history.messages.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
      history.archiveReady = true
      await flushHistory(history)
      if (mounted?.history === history && history.enabled) renderMessages(mounted, true)
    } catch (_) { history.archiveReady = true; history.archiveError = true }
    updateArchiveStatus(history)
  }
  const pruneHistories = () => {
    const cutoff = Date.now() - RETENTION_MS
    for (const history of histories.values()) {
      history.messages = history.messages.filter(record => {
        if (record.createdAt > cutoff) return true
        forgetRecord(history, record)
        history.saveQueue.delete(record.storageId)
        return false
      })
      for (const [key, saved] of history.older) if (saved.createdAt <= cutoff) history.older.delete(key)
    }
    if (mounted?.history.enabled) renderMessages(mounted)
    pruneArchive().catch(() => {})
  }

  const getHistory = (channel) => {
    let history = histories.get(channel)
    if (!history) {
      history = {
        channel, settings: loadSettings(channel), messages: [], nodes: new WeakMap(),
        scope: channel, ids: new Map(), older: new Map(), saveQueue: new Map(), displayLimit: MAX_MESSAGES,
        archiveReady: false, archiveError: false,
        enabled: false, follow: true, dirty: new Set(), removed: new Set(),
      }
      history.restorePromise = restoreHistory(history)
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
    return { user, moderator, broadcaster, author, body, badges,
      id: line.getAttribute('data-id') || line.getAttribute('data-message-id') || line.id || '' }
  }

  const matchesFilter = (message, settings) =>
    !(settings.excludedUsers || []).includes(message.user) && !(settings.globalExcludedUsers || []).includes(message.user) && (
      (settings.moderators && message.moderator) ||
      (settings.broadcaster && message.broadcaster) || settings.users.includes(message.user) || (settings.globalUsers || []).includes(message.user)
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
      copy.removeAttribute('title')
      row.appendChild(copy)
    }
    const author = document.createElement('strong')
    author.textContent = message.author.textContent
    author.style.color = message.author.style.color
    row.appendChild(author)
    row.appendChild(document.createTextNode(': '))
    const body = message.body.cloneNode(true)
    for (const node of [body, ...$$('*', body)]) {
      for (const attr of [...node.attributes]) {
        if (attr.name === 'id' || attr.name === 'tabindex' || attr.name === 'role' || attr.name === 'title' ||
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
    if (!message.moderator && !message.broadcaster && !history.settings.users.includes(message.user) &&
      !(history.settings.globalUsers || []).includes(message.user)) return false
    const fingerprint = `${message.user}\n${message.moderator}\n${message.broadcaster}\n${message.author.textContent}\n${message.body.innerHTML}`
    const previous = message.id ? history.ids.get(message.id) : history.nodes.get(line)
    const archived = message.id ? history.older.get(message.id) : null
    if (previous?.fingerprint === fingerprint) { history.nodes.set(line, previous); return false }
    const view = makeMessageView(message)
    let record
    if (previous && previous.user === message.user && previous.retained) {
      // Reflect edits/deletion placeholders while the original line is still present.
      view.firstChild.textContent = previous.view.firstChild.textContent
      record = Object.assign(previous, { moderator: message.moderator,
        broadcaster: message.broadcaster, view, fingerprint })
    } else {
      record = { id: message.id, user: message.user, moderator: message.moderator,
        broadcaster: message.broadcaster, view, fingerprint, retained: true,
        storageId: message.id || `${pageKey}-${++anonymousMessage}`,
        createdAt: archived?.createdAt || Date.now(), order: archived?.order || ++messageOrder }
      if (archived) {
        view.firstChild.textContent = restoreTree(archived.tree)?.firstChild?.textContent || view.firstChild.textContent
        history.older.delete(message.id)
      }
      history.messages.push(record)
      trimHistory(history)
    }
    history.nodes.set(line, record)
    if (message.id) history.ids.set(message.id, record)
    history.dirty.add(record)
    saveRecord(history, record)
    return true
  }

  // Keep these collection/render helpers in sync across both chat scripts.
  const forgetRecord = (history, record) => {
    record.retained = false
    history.dirty.delete(record)
    if (record.id && history.ids?.get(record.id) === record) history.ids.delete(record.id)
    if (record.renderedView) history.removed.add(record)
  }

  const collectMessageLines = (node, lines) => {
    if (node.nodeType !== 1) return
    const line = node.closest(MESSAGE_SELECTOR)
    if (line) lines.add(line)
    else for (const child of $$(MESSAGE_SELECTOR, node)) lines.add(child)
  }

  const captureTree = (node, history) => {
    const lines = new Set()
    collectMessageLines(node, lines)
    let changed = false
    for (const line of lines) changed = captureLine(line, history) || changed
    return changed
  }

  const captureMutations = (mutations, history) => {
    const lines = new Set()
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) collectMessageLines(node, lines)
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement
      const line = target?.closest(MESSAGE_SELECTOR)
      if (line) lines.add(line)
    }
    // Snapshot data now, even in background tabs: native renderers may be
    // pruned/reused before the browser delivers another animation frame.
    let changed = false
    for (const line of lines) changed = captureLine(line, history) || changed
    return changed
  }

  const cancelMessageRender = state => {
    if (state.renderFrame) cancelAnimationFrame(state.renderFrame)
    state.renderFrame = 0
  }

  const renderMessages = (state, rebuild = false) => {
    cancelMessageRender(state)
    const { history, list, empty, count, latest } = state
    const filterKey = JSON.stringify(history.settings)
    const full = rebuild || state.renderedHistory !== history || state.filterKey !== filterKey
    if (full) state.visibleCount = 0
    for (const record of history.removed) {
      if (!full && record.renderedView?.parentElement === list && record.visible) state.visibleCount--
      record.renderedView?.remove()
      record.renderedView = null
      record.visible = false
    }
    history.removed.clear()
    for (const record of full ? history.messages : history.dirty) {
      const oldView = record.renderedView
      const wasVisible = oldView?.parentElement === list && record.visible
      const show = matchesFilter(record, history.settings)
      state.visibleCount += Number(show) - (full ? 0 : Number(!!wasVisible))
      if (record.view.hidden !== !show) record.view.hidden = !show
      if (oldView && oldView !== record.view) {
        if (oldView.parentElement === list) oldView.replaceWith(record.view)
        else oldView.remove()
      }
      if (full || record.view.parentElement !== list) list.appendChild(record.view)
      record.renderedView = record.view
      record.visible = show
    }
    history.dirty.clear()
    state.renderedHistory = history
    state.filterKey = filterKey
    empty.hidden = state.visibleCount > 0
    const countText = `${state.visibleCount} 則`
    if (count.textContent !== countText) count.textContent = countText
    if (state.older) {
      state.older.hidden = !history.older.size
      state.older.textContent = `載入較早紀錄（${history.older.size}）`
    }
    // All row writes finish before the one layout read needed for following.
    if (history.follow) list.scrollTop = list.scrollHeight
    latest.hidden = history.follow
  }

  const scheduleMessageRender = state => {
    if (!state.history.enabled || document.hidden || state.renderFrame) return
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0
      if (mounted === state && state.history.enabled && !document.hidden) renderMessages(state)
    })
  }

  const releaseMessageViews = state => {
    cancelMessageRender(state)
    for (const record of [...state.history.messages, ...state.history.removed]) {
      record.renderedView?.remove()
      record.renderedView = null
      record.visible = false
    }
    state.history.removed.clear()
  }

  const handleMessageVisibility = () => {
    if (!mounted) return
    if (document.hidden) cancelMessageRender(mounted)
    else if (mounted.history.dirty.size || mounted.history.removed.size) scheduleMessageRender(mounted)
  }

  let panelFramePending = false
  const positionFilterPanel = state => {
    if (!state.inTopLayer) return
    const rect = state.host.getBoundingClientRect()
    Object.assign(state.panel.style, { position: 'fixed', inset: 'auto', margin: '0',
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }
  const schedulePanelPosition = () => {
    if (!mounted?.inTopLayer || panelFramePending) return
    panelFramePending = true
    requestAnimationFrame(() => {
      panelFramePending = false
      if (mounted) positionFilterPanel(mounted)
    })
  }
  const setPanelLayer = (state, enabled) => {
    const { panel } = state
    if (!enabled) {
      if (state.inTopLayer) { try { panel.hidePopover() } catch (_) {} }
      state.inTopLayer = false
      state.layerObserver?.disconnect()
      state.layerObserver = null
      panel.removeAttribute('popover')
      for (const name of ['position', 'inset', 'margin', 'left', 'top', 'width', 'height']) panel.style[name] = ''
      return
    }
    if (typeof panel.showPopover !== 'function') return
    if (!state.inTopLayer) {
      panel.setAttribute('popover', 'manual')
      try { panel.showPopover() } catch (_) { setPanelLayer(state, false); return }
      state.inTopLayer = true
      if (typeof ResizeObserver === 'function') {
        state.layerObserver = new ResizeObserver(schedulePanelPosition)
        state.layerObserver.observe(state.host)
      }
    }
    positionFilterPanel(state)
  }

  const setEnabled = (state, enabled) => {
    cancelMessageRender(state)
    state.history.enabled = enabled
    state.host.classList.toggle('ttc-active', enabled)
    state.panel.hidden = !enabled
    setPanelLayer(state, enabled)
    state.button.setAttribute('aria-pressed', String(enabled))
    state.button.title = enabled ? '' : '只看 Broadcaster、Moderator 與指定用戶'
    if (enabled) renderMessages(state, true)
  }

  const targetSettings = state => state.targetScope === 'global'
    ? { users: state.history.settings.globalUsers || [], excludedUsers: state.history.settings.globalExcludedUsers || [] }
    : state.history.settings

  const renderTargets = (state) => {
    const { panel, history } = state
    const exclude = state.targetMode === 'exclude'
    const global = state.targetScope === 'global'
    const settings = targetSettings(state)
    const targets = exclude ? settings.excludedUsers || [] : settings.users
    const includeButton = $('.ttc-mode-include', panel)
    const excludeButton = $('.ttc-mode-exclude', panel)
    includeButton.textContent = `＋ 包含（${settings.users.length}）`
    excludeButton.textContent = `－ 排除（${(settings.excludedUsers || []).length}）`
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
        state.updateSettings(changeTargetUsers(history.settings, user, true, exclude, global),
          exclude ? `已取消排除 ${user}。` : `已移除 ${user}。`, global)
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
          <label class="ttc-target-scope">名單範圍<select name="target-scope"><option value="channel">目前頻道</option><option value="global">全域</option></select></label>
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
      <p class="ttc-history-status" role="status"></p>
      <p class="ttc-empty">尚無符合條件的發言。新增目標帳號後開始收集。</p>
      <button class="ttc-older" type="button" hidden>載入較早紀錄</button>
      <div class="ttc-list" role="log" aria-label="篩選後的聊天訊息" aria-live="off"></div>
      <button class="ttc-latest" type="button" hidden>回到最新訊息</button>`
    state.panel = panel
    state.list = $('.ttc-list', panel)
    state.empty = $('.ttc-empty', panel)
    state.count = $('.ttc-count', panel)
    state.latest = $('.ttc-latest', panel)
    state.older = $('.ttc-older', panel)
    state.older.addEventListener('click', () => loadOlderRecords(state))
    const moderators = $('[name="moderators"]', panel)
    const broadcaster = $('[name="broadcaster"]', panel)
    const users = $('[name="users"]', panel)
    moderators.checked = state.history.settings.moderators
    broadcaster.checked = state.history.settings.broadcaster
    state.status = $('.ttc-target-status', panel)
    state.targetMode = 'include'
    state.targetScope = 'channel'
    state.updateSettings = (settings, message = '', global = false) => {
      state.history.settings = settings
      const saved = saveSettings(state.history, global)
      showTargetStatus(state, saved ? message : '此瀏覽器無法儲存設定；設定僅保留至本次頁面結束。')
      renderTargets(state)
      captureTree(state.scroller, state.history)
      if (state.history.enabled) renderMessages(state, true)
    }
    const applyRoles = () => state.updateSettings({ ...state.history.settings,
      moderators: moderators.checked, broadcaster: broadcaster.checked })
    moderators.addEventListener('change', applyRoles)
    broadcaster.addEventListener('change', applyRoles)
    $('.ttc-users', panel).addEventListener('submit', event => {
      event.preventDefault()
      const exclude = state.targetMode === 'exclude'
      const global = state.targetScope === 'global'
      const key = global ? exclude ? 'globalExcludedUsers' : 'globalUsers' : exclude ? 'excludedUsers' : 'users'
      const nextSettings = changeTargetUsers(state.history.settings, users.value, false, exclude, global)
      if (!nextSettings) {
        showTargetStatus(state, '請輸入一個英文帳號。')
        return
      }
      const added = nextSettings[key].length - (state.history.settings[key] || []).length
      state.updateSettings(nextSettings, added
        ? exclude ? '已排除帳號。' : '已新增帳號。'
        : '此帳號已在名單中。', global)
      users.value = ''
    })
    const setTargetMode = mode => {
      state.targetMode = mode
      showTargetStatus(state)
      renderTargets(state)
    }
    $('.ttc-mode-include', panel).addEventListener('click', () => setTargetMode('include'))
    $('.ttc-mode-exclude', panel).addEventListener('click', () => setTargetMode('exclude'))
    $('[name="target-scope"]', panel).addEventListener('change', event => {
      state.targetScope = event.target.value === 'global' ? 'global' : 'channel'
      showTargetStatus(state)
      renderTargets(state)
    })
    $('[name="search-users"]', panel).addEventListener('input', () => renderTargets(state))
    const targetSettings = $('.ttc-targets', panel)
    const targetButton = $('.ttc-target-summary', panel)
    const setTargetsOpen = open => {
      targetSettings.hidden = !open
      targetButton.setAttribute('aria-expanded', String(open))
      panel.classList.toggle('ttc-managing', open)
    }
    targetButton.addEventListener('click', () => setTargetsOpen(targetSettings.hidden))
    setTargetsOpen(false)
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
    releaseMessageViews(mounted)
    setPanelLayer(mounted, false)
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
      if (captureMutations(mutations, state.history)) scheduleMessageRender(state)
    })
    state.observer.observe(scroller, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-a-user', 'alt', 'src'] })
    mounted = state
    setEnabled(state, state.history.enabled)
    updateArchiveStatus(state.history)
  }

  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => { refreshTimer = 0; refresh() }, 250)
  }

  const syncSettings = () => {
    globalTargets = { users: [], excludedUsers: [] }
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
    .ttc-panel { position: absolute; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; box-sizing: border-box; min-height: 0; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; color: var(--color-text-base, #efeff1); background: var(--color-background-base, #18181b); font-size: 13px; }
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
    .ttc-toolbar button, .ttc-latest, .ttc-older { padding: 6px 10px; border: 0; border-radius: 4px; color: #fff; background: #9147ff; cursor: pointer; }
    .ttc-users input, .ttc-users button[type="submit"] { box-sizing: border-box; height: 30px; font: inherit; }
    .ttc-users button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0 10px; border: 1px solid transparent; border-radius: 4px; font-weight: 600; line-height: 1; }
    .ttc-empty { padding: 16px 12px; color: var(--color-text-alt-2, #adadb8); }
    .ttc-history-status { margin: 0; padding: 8px 12px; color: var(--color-text-alt-2, #adadb8); font-size: 12px; }
    .ttc-older { align-self: center; flex-shrink: 0; margin: 6px; }
    .ttc-list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 6px 0; }
    .ttc-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; }
    .ttc-message:hover { background: var(--color-background-button-text-hover, #ffffff11); }
    .ttc-time { margin-right: 6px; color: var(--color-text-alt-2, #adadb8); font-size: 10px; }
    .ttc-message > img { width: 18px; height: 18px; margin-right: 3px; vertical-align: middle; }
    .ttc-message .chat-image { max-height: 28px; vertical-align: middle; }
    .ttc-latest { position: absolute; bottom: 8px; align-self: center; }
    .ttc-managing > .ttc-toolbar { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
    .ttc-managing > .ttc-empty, .ttc-managing > .ttc-list, .ttc-managing > .ttc-latest, .ttc-managing > .ttc-older { display: none !important; }
    .ttc-options { flex-shrink: 0; }
    .ttc-panel .ttc-target-summary { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 0; color: var(--color-text-link, #bf94ff); background: transparent; white-space: nowrap; font: inherit; cursor: pointer; }
    .ttc-target-summary::before { content: '▸'; }
    .ttc-target-summary[aria-expanded="true"]::before { content: '▾'; }
    .ttc-targets { margin-top: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .ttc-targets > :not(.ttc-target-list) { flex-shrink: 0; }
    .ttc-target-scope { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
    .ttc-target-scope select { flex: 1; min-width: 0; height: 30px; padding: 4px 8px; border: 1px solid var(--color-border-input, #8886); border-radius: 4px; color: inherit; background: var(--color-background-input, #18181b); font: inherit; }
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
  window.addEventListener('resize', schedulePanelPosition)
  window.addEventListener('scroll', schedulePanelPosition, true)
  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => {
      const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement
      return !element?.closest('.ttc-panel, .ttc-toggle, [data-a-target="chat-scroller"]')
    })) scheduleRefresh()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('popstate', scheduleRefresh)
  document.addEventListener('visibilitychange', handleMessageVisibility)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pruneHistories() })
  window.addEventListener('pagehide', () => { for (const history of histories.values()) flushHistory(history).catch(() => {}) })
  setInterval(pruneHistories, 60000)
  // Twitch's SPA can reuse the same chat nodes on pushState without adding DOM.
  let lastPath = location.pathname
  setInterval(() => {
    if (lastPath === location.pathname) return
    lastPath = location.pathname
    scheduleRefresh()
  }, 1000)
  refresh()
})()
