// ==UserScript==
// @name        Twitch Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.7.3
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @description 依頻道主、管理員、VIP 與全域帳號包含／排除名單篩選 Twitch 聊天，保留最近 100 則／7 天紀錄並支援自動跟隨。
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
  const MAX_MESSAGES = 100
  const MAX_CHANNELS = 5
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
  const ARCHIVE_DB = 'twitch-live-chat-tweaks-history-v1'
  const pageKey = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  let archiveDatabase = null
  let messageOrder = 0
  let anonymousMessage = 0
  const MODERATOR_BADGE = '3267646d-33f0-4b17-b3df-f923a41db1d0'
  const VIP_BADGE = 'b817aba4-fad8-49e2-b88a-7cc744dfa6ec'
  const histories = new Map()
  const defaultSettings = () => ({ moderators: true, broadcaster: true, vip: true, users: [], excludedUsers: [] })
  let globalSettings = defaultSettings()
  let mounted = null
  let refreshTimer = 0

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const buildElement = (tag, attributes = {}, children = [], svg = false) => {
    const node = svg && typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (value === false || value == null) continue
      const text = value === true ? '' : String(value)
      node.setAttribute(name, text)
      if (name === 'class' && typeof node.className === 'string') node.className = text
      if (name === 'id') node.id = text
      if (name === 'hidden') node.hidden = true
    }
    for (const child of children) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    }
    return node
  }
  const element = (tag, attributes, children) => buildElement(tag, attributes, children, false)
  const svgElement = (tag, attributes, children) => buildElement(tag, attributes, children, true)
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

  const cloneSettings = settings => ({
    moderators: settings.moderators !== false,
    broadcaster: settings.broadcaster !== false,
    vip: settings.vip !== false,
    users: [...(settings.users || [])],
    excludedUsers: [...(settings.excludedUsers || [])],
  })

  const loadSettings = (channel = '') => {
    try {
      const stored = readSavedSettings()
      const flat = 'moderators' in stored || 'broadcaster' in stored || 'vip' in stored ||
        Array.isArray(stored.users) || Array.isArray(stored.excludedUsers)
      if (flat) {
        globalSettings = {
          moderators: stored.moderators !== false,
          broadcaster: stored.broadcaster !== false,
          vip: stored.vip !== false,
          users: normalizeUsers(Array.isArray(stored.users) ? stored.users.join(' ') : ''),
          excludedUsers: normalizeUsers(Array.isArray(stored.excludedUsers) ? stored.excludedUsers.join(' ') : ''),
        }
        return cloneSettings(globalSettings)
      }
      const entries = Object.values(stored).filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
      if (!entries.length) return cloneSettings(globalSettings)
      const legacyGlobal = stored['@global'] && typeof stored['@global'] === 'object' ? stored['@global'] : null
      const legacyChannel = channel && stored[channel] && typeof stored[channel] === 'object' ? stored[channel] : null
      globalSettings = {
        moderators: legacyGlobal?.moderators ?? legacyChannel?.moderators ?? !entries.some(entry => entry.moderators === false),
        broadcaster: legacyGlobal?.broadcaster ?? legacyChannel?.broadcaster ?? !entries.some(entry => entry.broadcaster === false),
        vip: legacyGlobal?.vip ?? legacyChannel?.vip ?? !entries.some(entry => entry.vip === false),
        users: normalizeUsers(entries.flatMap(entry => Array.isArray(entry.users) ? entry.users : []).join(' ')),
        excludedUsers: normalizeUsers(entries.flatMap(entry => Array.isArray(entry.excludedUsers) ? entry.excludedUsers : []).join(' ')),
      }
      return cloneSettings(globalSettings)
    } catch (_) {
      return cloneSettings(globalSettings)
    }
  }

  const saveSettings = (history) => {
    const next = {
      moderators: history.settings.moderators !== false,
      broadcaster: history.settings.broadcaster !== false,
      vip: history.settings.vip !== false,
      users: normalizeUsers((history.settings.users || []).join(' ')),
      excludedUsers: normalizeUsers((history.settings.excludedUsers || []).join(' ')),
    }
    globalSettings = cloneSettings(next)
    for (const item of histories.values()) item.settings = cloneSettings(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
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
    const now = Date.now()
    const range = typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.upperBound(now) : undefined
    const request = transaction.objectStore('messages').index('expiresAt').openCursor(range)
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
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed) return ''
    try {
      const url = new URL(trimmed, location.href)
      return ['https:', 'http:'].includes(url.protocol) || /^data:image\/(png|gif|jpe?g|webp|avif);base64,/i.test(trimmed) ? url.href : ''
    } catch (_) { return '' }
  }
  const safeSrcset = value => {
    const candidates = []
    let rest = typeof value === 'string' ? value.trim() : ''
    while (rest) {
      let candidate
      const dataMatch = rest.match(/^(data:[^\s,]*,[^\s,]+(?:\s+[^\s,]*)?)(?:\s*,\s*(.*))?$/is)
      if (dataMatch) {
        candidate = dataMatch[1]
        rest = (dataMatch[2] || '').trim()
      } else {
        const comma = rest.indexOf(',')
        candidate = (comma === -1 ? rest : rest.slice(0, comma)).trim()
        rest = comma === -1 ? '' : rest.slice(comma + 1).trim()
      }
      if (!candidate) continue
      const [url, descriptor, extra] = candidate.split(/\s+/)
      const safe = safeArchiveUrl(url)
      if (safe && !extra && (!descriptor || /^\d+(?:\.\d+)?[wx]$/.test(descriptor))) {
        candidates.push([safe, descriptor].filter(Boolean).join(' '))
      }
    }
    return candidates.join(', ')
  }
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
    moderator: record.moderator, broadcaster: record.broadcaster, vip: record.vip,
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
      moderator: saved.moderator === true, broadcaster: saved.broadcaster === true, vip: saved.vip === true,
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

  const flushHistory = async history => {
    if (!history.archiveReady || history.archiveError) return
    if (history.writePromise) {
      try { await history.writePromise } catch (_) {}
      return flushHistory(history)
    }
    if (!history.saveQueue.size && !history.deleteQueue.size) return
    const batch = [...history.saveQueue.values()]
    const deletes = [...history.deleteQueue].filter(id => !history.saveQueue.has(id))
    history.saveQueue.clear()
    history.deleteQueue.clear()
    history.writePromise = (async () => {
      const database = await openArchive()
      const transaction = database.transaction('messages', 'readwrite')
      const done = transactionDone(transaction)
      const store = transaction.objectStore('messages')
      for (const storageId of deletes) store.delete([history.scope, storageId])
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
          if (saved.expiresAt > Date.now()) store.put(saved)
          else store.delete([saved.scope, saved.storageId])
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
    history.deleteQueue.delete(record.storageId)
    history.saveQueue.set(record.storageId, saved)
    if (history.saveScheduled) return
    history.saveScheduled = true
    Promise.resolve().then(() => { history.saveScheduled = false; return flushHistory(history) })
  }
  const trimHistory = history => {
    while (history.messages.length > MAX_MESSAGES) {
      const oldest = history.messages.shift()
      history.saveQueue.delete(oldest.storageId)
      history.deleteQueue.add(oldest.storageId)
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
      const restored = []
      for (const item of records) {
        const current = item.id ? history.ids.get(item.id) : null
        if (current) {
          current.createdAt = Math.min(current.createdAt, item.createdAt)
          current.order = Number.isSafeInteger(item.order) ? item.order : current.order
          current.view.firstChild.textContent = restoreTree(item.tree)?.firstChild?.textContent || current.view.firstChild.textContent
          saveRecord(history, current)
        } else {
          const record = restoreRecord(item)
          if (!record) continue
          restored.push(record)
          if (record.id) history.ids.set(record.id, record)
          history.dirty.add(record)
        }
      }
      history.messages.unshift(...restored)
      history.messages.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
      trimHistory(history)
      history.archiveReady = true
      await flushHistory(history)
      if (mounted?.history === history && history.enabled) renderMessages(mounted, true)
    } catch (_) { history.archiveReady = true; history.archiveError = true }
    updateArchiveStatus(history)
  }
  const pruneHistories = () => {
    const cutoff = Date.now() - RETENTION_MS
    let changed = false
    for (const history of histories.values()) {
      const before = history.messages.length
      history.messages = history.messages.filter(record => {
        if (record.createdAt > cutoff) return true
        forgetRecord(history, record)
        history.saveQueue.delete(record.storageId)
        history.deleteQueue.delete(record.storageId)
        return false
      })
      if (history.messages.length !== before) changed = true
    }
    if (changed && mounted?.history.enabled) renderMessages(mounted)
    pruneArchive().catch(() => {})
  }

  const getHistory = (channel) => {
    let history = histories.get(channel)
    if (!history) {
      history = {
        channel, settings: loadSettings(channel), messages: [], nodes: new WeakMap(),
        scope: channel, ids: new Map(), saveQueue: new Map(), deleteQueue: new Set(),
        archiveReady: false, archiveError: false,
        enabled: false, follow: true, dirty: new Set(), removed: new Set(),
      }
      history.restorePromise = restoreHistory(history)
    }
    histories.delete(channel)
    histories.set(channel, history)
    if (histories.size > MAX_CHANNELS) {
      const oldest = histories.keys().next().value
      const evicted = histories.get(oldest)
      histories.delete(oldest)
      if (evicted?.saveQueue?.size || evicted?.deleteQueue?.size) {
        Promise.resolve(evicted.restorePromise).then(() => flushHistory(evicted)).catch(() => {})
      }
    }
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
    const vip = badges.some(badge =>
      (badge.getAttribute('src') || '').includes(VIP_BADGE) ||
      (badge.getAttribute('srcset') || '').includes(VIP_BADGE) ||
      /^(vip|vip\s*(?:徽章|バッジ))$/i.test((badge.getAttribute('alt') || '').trim()))
    return { user, moderator, broadcaster, vip, author, body, badges,
      id: line.getAttribute('data-id') || line.getAttribute('data-message-id') || line.id || '' }
  }

  const matchesFilter = (message, settings) =>
    !(settings.excludedUsers || []).includes(message.user) && Boolean(
      (settings.moderators && message.moderator) ||
      (settings.broadcaster && message.broadcaster) ||
      (settings.vip && message.vip) ||
      settings.users.includes(message.user)
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
    const previous = message.id ? history.ids.get(message.id) : history.nodes.get(line)
    // Keep all roles even when unchecked so turning a role back on restores its history.
    if (!(previous?.retained && previous.user === message.user) && !message.moderator && !message.broadcaster &&
      !message.vip && !history.settings.users.includes(message.user)) return false
    const fingerprint = `${message.user}\n${message.moderator}\n${message.broadcaster}\n${message.vip}\n${message.author.textContent}\n${message.body.innerHTML}`
    if (previous?.fingerprint === fingerprint) { history.nodes.set(line, previous); return false }
    const view = makeMessageView(message)
    let record
    if (previous && previous.user === message.user && previous.retained) {
      // Reflect edits/deletion placeholders while the original line is still present.
      view.firstChild.textContent = previous.view.firstChild.textContent
      record = Object.assign(previous, { moderator: message.moderator,
        broadcaster: message.broadcaster, vip: message.vip, view, fingerprint })
    } else {
      record = { id: message.id, user: message.user, moderator: message.moderator,
        broadcaster: message.broadcaster, vip: message.vip, view, fingerprint, retained: true,
        storageId: message.id || `${pageKey}-${++anonymousMessage}`,
        createdAt: Date.now(), order: ++messageOrder }
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

  const cancelListFollow = state => {
    if (state.followFrame) cancelAnimationFrame(state.followFrame)
    state.followFrame = 0
  }

  const scheduleListFollow = state => {
    if (mounted !== state || !state.history.enabled || !state.history.follow || document.hidden || state.followFrame || state.renderFrame) return
    state.followFrame = requestAnimationFrame(() => {
      state.followFrame = 0
      if (mounted !== state || !state.history.enabled || !state.history.follow || document.hidden) return
      state.list.scrollTop = state.list.scrollHeight
      state.followScrollTop = state.list.scrollTop
      state.latest.hidden = true
    })
  }

  const renderMessages = (state, rebuild = false) => {
    cancelMessageRender(state)
    cancelListFollow(state)
    const { history, list, empty, count, latest } = state
    const filterKey = JSON.stringify(history.settings)
    const full = rebuild || state.renderedHistory !== history || state.filterKey !== filterKey
    if (full) {
      state.visibleCount = 0
      state.mountedTailOrder = 0
    }
    for (const record of history.removed) {
      if (record.renderedView) state.messageResizeObserver?.unobserve(record.renderedView)
      if (!full && record.renderedView?.parentElement === list && record.visible) state.visibleCount--
      record.renderedView?.remove()
      record.renderedView = null
      record.visible = false
    }
    history.removed.clear()
    let needsReorder = false
    for (const record of full ? history.messages : history.dirty) {
      const oldView = record.renderedView
      const wasVisible = oldView?.parentElement === list && record.visible
      const show = matchesFilter(record, history.settings)
      state.visibleCount += Number(show) - (full ? 0 : Number(!!wasVisible))
      if (!show) {
        if (oldView) {
          state.messageResizeObserver?.unobserve(oldView)
          oldView.remove()
        }
        record.renderedView = null
        record.visible = false
        continue
      }
      record.view.hidden = false
      if (oldView && oldView !== record.view) {
        state.messageResizeObserver?.unobserve(oldView)
        if (oldView.parentElement === list) oldView.replaceWith(record.view)
        else oldView.remove()
      }
      if (full || record.view.parentElement !== list) {
        if (!full && state.mountedTailOrder && record.order <= state.mountedTailOrder) needsReorder = true
        list.appendChild(record.view)
      }
      if (!state.mountedTailOrder || record.order > state.mountedTailOrder) state.mountedTailOrder = record.order
      record.renderedView = record.view
      record.visible = true
      state.messageResizeObserver?.observe(record.view)
    }
    history.dirty.clear()
    state.renderedHistory = history
    state.filterKey = filterKey
    if (needsReorder) { renderMessages(state, true); return }
    empty.hidden = state.visibleCount > 0
    const countText = `${state.visibleCount} 則`
    if (count.textContent !== countText) count.textContent = countText
    // All row writes finish before the one layout read needed for following.
    if (history.follow) {
      list.scrollTop = list.scrollHeight
      state.followScrollTop = list.scrollTop
    }
    latest.hidden = history.follow
  }

  const scheduleMessageRender = state => {
    if (!state.history.enabled || document.hidden || state.renderFrame) return
    cancelListFollow(state)
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0
      if (mounted === state && state.history.enabled && !document.hidden) renderMessages(state)
    })
  }

  const releaseMessageViews = state => {
    state.messageResizeObserver?.disconnect()
    cancelListFollow(state)
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
    if (document.hidden) { cancelMessageRender(mounted); cancelListFollow(mounted) }
    else {
      if (mounted.history.dirty.size || mounted.history.removed.size) scheduleMessageRender(mounted)
      scheduleListFollow(mounted)
    }
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
    state.messageResizeObserver?.disconnect()
    cancelListFollow(state)
    state.readerScrollIntent = false
    cancelMessageRender(state)
    state.history.enabled = enabled
    state.host.classList.toggle('ttc-active', enabled)
    state.panel.hidden = !enabled
    setPanelLayer(state, enabled)
    state.button.setAttribute('aria-pressed', String(enabled))
    state.button.title = enabled ? '' : '只看 Broadcaster、Moderator、VIP 與指定用戶'
    if (enabled) renderMessages(state, true)
  }

  const renderTargets = (state) => {
    const { panel, history } = state
    const exclude = state.targetMode === 'exclude'
    const settings = history.settings
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
    const panel = element('section', { class: 'ttc-panel', 'aria-label': '指定用戶聊天室' }, [
      element('div', { class: 'ttc-toolbar' }, [
        element('div', { class: 'ttc-options' }, [
          element('button', {
            type: 'button',
            class: 'ttc-target-summary',
            'aria-label': '目標用戶',
            'aria-controls': 'ttc-target-settings',
            'aria-expanded': 'false',
          }, ['目標用戶']),
          element('span', { class: 'ttc-count' }),
        ]),
        element('div', { class: 'ttc-targets', id: 'ttc-target-settings', hidden: '' }, [
          element('div', { class: 'ttc-roles' }, [
            element('label', {}, [element('input', { type: 'checkbox', name: 'broadcaster' }), ' Broadcaster']),
            element('label', {}, [element('input', { type: 'checkbox', name: 'moderators' }), ' Moderator']),
            element('label', {}, [element('input', { type: 'checkbox', name: 'vip' }), ' VIP']),
          ]),
          element('div', { class: 'ttc-target-modes', role: 'group', 'aria-label': '帳號篩選方式' }, [
            element('button', { type: 'button', class: 'ttc-mode-include', 'aria-label': '＋ 包含' }, ['＋ 包含']),
            element('button', { type: 'button', class: 'ttc-mode-exclude', 'aria-label': '－ 排除' }, ['－ 排除']),
          ]),
          element('form', { class: 'ttc-users' }, [
            element('label', {}, [
              '新增帳號',
              element('input', {
                type: 'text',
                name: 'users',
                placeholder: '英文帳號',
                autocomplete: 'off',
                spellcheck: 'false',
              }),
            ]),
            element('button', { type: 'submit' }, ['新增']),
          ]),
          element('label', { class: 'ttc-target-search' }, [
            '搜尋帳號',
            element('input', { type: 'search', name: 'search-users', placeholder: '搜尋目標帳號', autocomplete: 'off' }),
          ]),
          element('ul', { class: 'ttc-target-list', 'aria-label': '目標用戶清單' }),
          element('p', { class: 'ttc-target-empty' }),
          element('p', { class: 'ttc-target-status', role: 'status', 'aria-live': 'polite' }),
        ]),
      ]),
      element('p', { class: 'ttc-history-status', role: 'status' }),
      element('p', { class: 'ttc-empty' }, ['尚無符合條件的發言。新增目標帳號後開始收集。']),
      element('div', { class: 'ttc-list', role: 'log', 'aria-label': '篩選後的聊天訊息', 'aria-live': 'off' }),
      element('button', { class: 'ttc-latest', type: 'button', hidden: '' }, ['回到最新訊息']),
    ])
    state.panel = panel
    state.list = $('.ttc-list', panel)
    if (typeof ResizeObserver === 'function') {
      state.messageResizeObserver = new ResizeObserver(() => scheduleListFollow(state))
    }
    // Image loading may change a row after the initial append and scroll.
    // Capture load/error too, including browsers without ResizeObserver.
    state.list.addEventListener('load', () => scheduleListFollow(state), true)
    state.list.addEventListener('error', () => scheduleListFollow(state), true)
    state.empty = $('.ttc-empty', panel)
    state.count = $('.ttc-count', panel)
    state.latest = $('.ttc-latest', panel)
    const moderators = $('[name="moderators"]', panel)
    const broadcaster = $('[name="broadcaster"]', panel)
    const vip = $('[name="vip"]', panel)
    const users = $('[name="users"]', panel)
    moderators.checked = state.history.settings.moderators
    broadcaster.checked = state.history.settings.broadcaster
    vip.checked = state.history.settings.vip
    state.status = $('.ttc-target-status', panel)
    state.targetMode = 'include'
    state.updateSettings = (settings, message = '') => {
      state.history.settings = settings
      const saved = saveSettings(state.history)
      showTargetStatus(state, saved ? message : '此瀏覽器無法儲存設定；設定僅保留至本次頁面結束。')
      renderTargets(state)
      captureTree(state.scroller, state.history)
      if (state.history.enabled) renderMessages(state, true)
    }
    const applyRoles = () => state.updateSettings({ ...state.history.settings,
      moderators: moderators.checked, broadcaster: broadcaster.checked, vip: vip.checked })
    moderators.addEventListener('change', applyRoles)
    broadcaster.addEventListener('change', applyRoles)
    vip.addEventListener('change', applyRoles)
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
    setTargetsOpen(false)
    renderTargets(state)
    state.list.addEventListener('scroll', () => {
      if (!state.history.enabled || state.panel.hidden) return
      const nearBottom = state.list.scrollHeight - state.list.scrollTop - state.list.clientHeight < 40
      const movedUp = Number.isFinite(state.followScrollTop) && state.list.scrollTop < state.followScrollTop - 1
      // A delayed image can invalidate a pending programmatic scroll event.
      // Preserve following unless the reader actually moves up or scrolls.
      if (state.history.follow && !state.readerScrollIntent && !movedUp && !nearBottom) {
        scheduleListFollow(state)
        return
      }
      state.history.follow = nearBottom
      if (nearBottom) {
        state.readerScrollIntent = false
        state.followScrollTop = state.list.scrollTop
      }
      state.latest.hidden = state.history.follow
    }, { passive: true })
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      state.list.addEventListener(event, () => {
        state.readerScrollIntent = true
      }, { passive: true })
    }
    state.latest.addEventListener('click', () => {
      state.readerScrollIntent = false
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
    const button = element('button', {
      type: 'button',
      class: 'ttc-toggle',
      'aria-label': '切換指定用戶聊天室',
    }, [
      svgElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgElement('path', { fill: 'currentColor', d: 'M3 4h18v2l-7 8v6l-4 2v-8L3 6V4zm3 2 6 7 6-7H6z' }),
      ]),
    ])
    button.type = 'button'
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
      attributes: true, attributeFilter: ['data-a-user', 'alt', 'src', 'srcset'] })
    mounted = state
    setEnabled(state, state.history.enabled)
    updateArchiveStatus(state.history)
  }

  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => { refreshTimer = 0; refresh() }, 250)
  }

  const syncSettings = () => {
    globalSettings = defaultSettings()
    for (const history of histories.values()) history.settings = loadSettings(history.channel)
    if (!mounted) return
    const { panel, history } = mounted
    $('[name="moderators"]', panel).checked = history.settings.moderators
    $('[name="broadcaster"]', panel).checked = history.settings.broadcaster
    $('[name="vip"]', panel).checked = history.settings.vip
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
    .ttc-roles { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex-shrink: 0; margin-bottom: 12px; }
    .ttc-roles label { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
    .ttc-roles input { width: 13px; height: 13px; margin: 0; accent-color: #9147ff; }
    .ttc-count { margin-left: auto; flex-shrink: 0; white-space: nowrap; color: var(--color-text-alt-2, #adadb8); }
    .ttc-users { display: flex; align-items: center; gap: 6px; }
    .ttc-users label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; white-space: nowrap; }
    .ttc-users input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--color-border-base, #ffffff44); border-radius: 4px; color: inherit; background: var(--color-background-input, #ffffff11); font-size: 12px; }
    .ttc-toolbar button, .ttc-latest { padding: 6px 10px; border: 0; border-radius: 4px; color: #fff; background: #9147ff; cursor: pointer; }
    .ttc-users input, .ttc-users button[type="submit"] { box-sizing: border-box; height: 30px; font: inherit; }
    .ttc-users button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0 10px; border: 1px solid transparent; border-radius: 4px; font-weight: 600; line-height: 1; }
    .ttc-empty { padding: 16px 12px; color: var(--color-text-alt-2, #adadb8); }
    .ttc-history-status { margin: 0; padding: 8px 12px; color: var(--color-text-alt-2, #adadb8); font-size: 12px; }
    .ttc-list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 6px 0; }
    .ttc-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; content-visibility: auto; contain-intrinsic-size: auto 30px; }
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
  window.addEventListener('resize', schedulePanelPosition)
  window.addEventListener('scroll', schedulePanelPosition, true)
  const observer = new MutationObserver(mutations => {
    if (mounted?.button.isConnected && mounted.panel.isConnected &&
      mounted.scroller.isConnected && getChannel() === mounted.history.channel) return
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
