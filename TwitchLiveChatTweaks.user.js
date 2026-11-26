// ==UserScript==
// @name        Twitch Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.11.6
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js
// @description 依頻道主、管理員、VIP、回覆篩選目標與全域帳號包含／排除名單篩選 Twitch 直播與 VOD 聊天，保留回覆目標引言與最近 1000 則／7 天紀錄，支援跨日分隔、搜尋、自動跟隨與 VOD 時間切換（影片秒數／直播時刻），修正 VOD 聊天室多位元組字元後的貼圖位移問題，並在原生 VOD 聊天室高亮 @提及篩選目標的留言；分割螢幕時隱藏聊天室上方橫幅與輸入區底部列。
// @author      Derek
// @match       *://www.twitch.tv/*
// @run-at      document-start
// @grant       none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const MESSAGE_SELECTOR = '[data-a-target="chat-line-message"], .vod-message, [data-test-selector="message-layout"]'
  const USER_SELECTOR = '[data-a-target="chat-message-username"], .chat-author__display-name, [data-test-selector="message-author"], [data-test-selector="message-username"]'
  const BODY_SELECTOR = '[data-a-target="chat-line-message-body"], [data-test-selector="message-text"]'
  const STORAGE_KEY = 'twitch-live-chat-tweaks-settings-v1'
  const MAX_MESSAGES = 1000
  const MAX_CHANNELS = 5
  const MAX_DISPLAY_NAMES = 500
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
  const VOD_REPLY_WINDOW_S = 300
  const GQL_URL = 'https://gql.twitch.tv/gql'
  const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
  const GQL_TIMEOUT_MS = 8000
  const GQL_RETRY_COOLDOWN_MS = 30000
  const MAX_VOD_START_CACHE = 50
  const ARCHIVE_DB = 'twitch-live-chat-tweaks-history-v1'
  const pageKey = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  const nowMs = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  const yieldToMain = () => (typeof scheduler !== 'undefined' && typeof scheduler?.yield === 'function'
    ? scheduler.yield()
    : new Promise(resolve => setTimeout(resolve, 0)))
  let archiveDatabase = null
  let messageOrder = 0
  let anonymousMessage = 0
  const MODERATOR_BADGE = '3267646d-33f0-4b17-b3df-f923a41db1d0'
  const VIP_BADGE = 'b817aba4-fad8-49e2-b88a-7cc744dfa6ec'
  const BROADCASTER_BADGE = '5527c58c-fb7d-422d-b71b-f309dcb85cc1'
  const RESERVED_PATHS = new Set(['directory', 'downloads', 'settings', 'subscriptions', 'wallet', 'inventory', 'videos', 'popout', 'moderator', 'search', 'p', 'jobs', 'turbo', 'prime'])
  const histories = new Map()
  const vodStartCache = new Map()
  const vodStartRequests = new Map()
  const viewDates = new WeakMap()
  const rowAnchorKeys = new WeakMap()
  const normalizeVodTimeMode = value => value === 'broadcast' ? 'broadcast' : 'offset'
  const defaultSettings = () => ({ moderators: true, broadcaster: true, vip: true, replies: true, vodTimeMode: 'offset', users: [], excludedUsers: [] })
  let globalSettings = defaultSettings()
  let mounted = null
  let refreshTimer = 0

  const countCodePoints = text => {
    if (typeof text !== 'string' || !text) return 0
    let count = 0
    for (const _ of text) count++
    return count
  }

  // Twitch VOD GQL returns UTF-8 byte offsets in emote.from while its client
  // tokenizes messages by Unicode code point, causing CJK/emoji text to drop emotes.
  const fixVodEmoteOffsets = payload => {
    const entries = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' ? [payload] : [])
    let changed = false
    for (const entry of entries) {
      const edges = entry?.data?.video?.comments?.edges
      if (!Array.isArray(edges)) continue
      for (const edge of edges) {
        const fragments = edge?.node?.message?.fragments
        if (!Array.isArray(fragments)) continue
        let cpOffset = 0
        for (const fragment of fragments) {
          const text = typeof fragment?.text === 'string' ? fragment.text : ''
          const cpLen = countCodePoints(text)
          const emote = fragment?.emote
          if (emote && typeof emote === 'object' && emote.emoteID) {
            const leadWs = countCodePoints(text.match(/^\s*/)[0])
            const trimmedLen = countCodePoints(text.trim())
            const expectedFrom = cpOffset + leadWs
            const expectedTo = expectedFrom + Math.max(0, trimmedLen - 1)
            if (emote.from !== expectedFrom) {
              emote.from = expectedFrom
              changed = true
            }
            if (typeof emote.id === 'string' && emote.id.startsWith(`${emote.emoteID};`)) {
              const expectedId = `${emote.emoteID};${expectedFrom};${expectedTo}`
              if (emote.id !== expectedId) {
                emote.id = expectedId
                changed = true
              }
            }
          }
          cpOffset += cpLen
        }
      }
    }
    return changed
  }

  const installVodEmoteFetchFix = () => {
    const fetchHost = typeof window !== 'undefined' && typeof window.fetch === 'function'
      ? window
      : (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis : null)
    if (!fetchHost || fetchHost.fetch.__ttcVodEmoteFix) return
    const origFetch = fetchHost.fetch
    const ttcVodEmoteFetch = function (...args) {
      const input = args[0]
      const reqUrl = typeof input === 'string' ? input : (input?.href || input?.url || '')
      if (!/^https:\/\/gql\.twitch\.tv\/gql(?:$|[?#])/i.test(reqUrl)) {
        return origFetch.apply(this, args)
      }
      const reqBody = args[1] && typeof args[1].body === 'string' ? args[1].body : null
      if (reqBody !== null && !reqBody.includes('VideoCommentsByOffsetOrCursor')) {
        return origFetch.apply(this, args)
      }
      return Promise.resolve(origFetch.apply(this, args)).then(async response => {
        if (!response || !response.ok || typeof response.clone !== 'function') return response
        try {
          const rawText = await response.clone().text()
          if (!rawText.includes('EmbeddedEmote')) return response
          const payload = JSON.parse(rawText)
          if (!fixVodEmoteOffsets(payload) || typeof Response !== 'function') return response
          const headers = typeof Headers === 'function' ? new Headers(response.headers) : response.headers
          if (typeof headers?.delete === 'function') {
            headers.delete('content-length')
            headers.delete('content-encoding')
          }
          const patched = new Response(JSON.stringify(payload), {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
          if (response.url) {
            try { Object.defineProperty(patched, 'url', { value: response.url, configurable: true }) } catch (_) {}
          }
          return patched
        } catch (_) {
          return response
        }
      })
    }
    ttcVodEmoteFetch.__ttcVodEmoteFix = true
    try { fetchHost.fetch = ttcVodEmoteFetch } catch (_) {}
  }

  installVodEmoteFetchFix()

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
      if (name === 'hidden') node.hidden = value === 'until-found' ? 'until-found' : true
    }
    for (const child of children) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    }
    return node
  }
  const element = (tag, attributes, children) => buildElement(tag, attributes, children, false)
  const svgElement = (tag, attributes, children) => buildElement(tag, attributes, children, true)
  const normalizeLogin = value => {
    const name = String(value || '').trim().toLowerCase().replace(/^@/, '')
    return /^[a-z0-9_]{1,25}$/.test(name) ? name : ''
  }
  const normalizeUsers = (value) => [...new Set(String(value || '')
    .toLowerCase().split(/[\s,，;；]+/).map(name => name.replace(/^@/, ''))
    .filter(name => /^[a-z0-9_]{1,25}$/.test(name)))]

  const loginFromHref = href => {
    if (!href) return ''
    try {
      const url = new URL(href, location.href)
      if (!/(?:^|\.)twitch\.tv$/i.test(url.hostname)) return ''
      const path = url.pathname.toLowerCase().split('/').filter(Boolean)
      return path.length === 1 && /^[a-z0-9_]{1,25}$/.test(path[0]) && !RESERVED_PATHS.has(path[0]) ? path[0] : ''
    } catch (_) { return '' }
  }

  const getVodOwner = () => {
    for (const container of $$('.channel-info-content, [data-a-target="user-channel-header-item"], [data-a-target="watch-mode-to-channel-link"]')) {
      for (const link of container.tagName?.toLowerCase() === 'a' ? [container] : $$('a', container)) {
        const login = loginFromHref(link.getAttribute('href'))
        if (login) return login
      }
    }
    const parts = location.pathname.toLowerCase().split('/').filter(Boolean)
    if (parts.length >= 3 && parts[1] === 'video' && /^\d+$/.test(parts[2]) &&
      /^[a-z0-9_]{1,25}$/.test(parts[0]) && !RESERVED_PATHS.has(parts[0])) return parts[0]
    return ''
  }

  const getChannel = () => {
    const parts = location.pathname.toLowerCase().split('/').filter(Boolean)
    if (parts[0] === 'popout' && parts[2] === 'chat' && /^[a-z0-9_]{1,25}$/.test(parts[1])) return parts[1]
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1])) return `vod:${parts[1]}`
    if (parts.length >= 3 && parts[1] === 'video' && /^\d+$/.test(parts[2]) &&
      /^[a-z0-9_]{1,25}$/.test(parts[0]) && !RESERVED_PATHS.has(parts[0])) return `vod:${parts[2]}`
    if (parts.length === 1 && /^[a-z0-9_]+$/.test(parts[0]) && !RESERVED_PATHS.has(parts[0])) {
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
    replies: settings.replies !== false,
    vodTimeMode: normalizeVodTimeMode(settings.vodTimeMode),
    users: [...(settings.users || [])],
    excludedUsers: [...(settings.excludedUsers || [])],
  })

  const loadSettings = (channel = '') => {
    try {
      const stored = readSavedSettings()
      const flat = 'moderators' in stored || 'broadcaster' in stored || 'vip' in stored || 'replies' in stored ||
        'vodTimeMode' in stored || Array.isArray(stored.users) || Array.isArray(stored.excludedUsers)
      if (flat) {
        globalSettings = {
          moderators: stored.moderators !== false,
          broadcaster: stored.broadcaster !== false,
          vip: stored.vip !== false,
          replies: stored.replies !== false,
          vodTimeMode: normalizeVodTimeMode(stored.vodTimeMode),
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
        replies: legacyGlobal?.replies ?? legacyChannel?.replies ?? !entries.some(entry => entry.replies === false),
        vodTimeMode: normalizeVodTimeMode(legacyGlobal?.vodTimeMode ?? legacyChannel?.vodTimeMode ?? entries.find(entry => entry.vodTimeMode === 'broadcast')?.vodTimeMode),
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
      replies: history.settings.replies !== false,
      vodTimeMode: normalizeVodTimeMode(history.settings.vodTimeMode),
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
  const viewTime = view => (view ? [...view.children].find(child => child.tagName?.toLowerCase() === 'time') || null : null)
  const sanitizeReply = reply => {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null
    const parentId = typeof reply.parentId === 'string' ? reply.parentId.trim() : ''
    const parentUser = normalizeLogin(reply.parentUser)
    const parentDisplayName = typeof reply.parentDisplayName === 'string' ? reply.parentDisplayName.replace(/\s+/g, ' ').trim() : ''
    const parentText = typeof reply.parentText === 'string' ? reply.parentText.replace(/\s+/g, ' ').trim() : ''
    const parentDeleted = reply.parentDeleted === true
    if (!parentUser && !parentDisplayName && !parentText && !parentDeleted) return null
    return {
      parentId,
      parentUser,
      parentDisplayName,
      parentText,
      parentDeleted,
      parentModerator: reply.parentModerator === true,
      parentBroadcaster: reply.parentBroadcaster === true,
      parentVip: reply.parentVip === true,
      ...(reply.inferred === true ? { inferred: true } : {}),
    }
  }
  const stripLoginSuffix = (name, user) => {
    const cleaned = String(name || '').replace(/\s+/g, ' ').trim()
    if (!cleaned || !user) return cleaned
    const suffix = ` (${user})`
    if (cleaned.toLowerCase().endsWith(suffix)) return cleaned.slice(0, -suffix.length).trim()
    return cleaned
  }
  const rememberUser = (history, user, displayName, { moderator = false, broadcaster = false, vip = false, color = '' } = {}) => {
    const login = normalizeLogin(user)
    if (!history || !login) return false
    let changed = false
    if (history.knownRoles) {
      const prev = history.knownRoles.get(login)
      const nextColor = color || prev?.color || ''
      const nextRole = {
        moderator: Boolean(moderator),
        broadcaster: Boolean(broadcaster),
        vip: Boolean(vip),
        color: nextColor,
      }
      if (nextRole.moderator || nextRole.broadcaster || nextRole.vip || nextColor) {
        if (Boolean(prev?.moderator) !== nextRole.moderator ||
          Boolean(prev?.broadcaster) !== nextRole.broadcaster ||
          Boolean(prev?.vip) !== nextRole.vip) {
          changed = true
        }
        history.knownRoles.delete(login)
        history.knownRoles.set(login, nextRole)
        if (history.knownRoles.size > MAX_DISPLAY_NAMES) {
          for (const [key, entry] of history.knownRoles) {
            if (!entry.moderator && !entry.broadcaster && !entry.vip) {
              history.knownRoles.delete(key)
              break
            }
          }
        }
      } else {
        if (prev && (prev.moderator || prev.broadcaster || prev.vip)) changed = true
        history.knownRoles.delete(login)
      }
    }
    if (history.displayNames) {
      const cleanName = stripLoginSuffix(displayName, login)
      const lower = cleanName.toLowerCase()
      if (cleanName && lower !== login) {
        if (history.displayNames.get(lower) !== login) changed = true
        history.displayNames.delete(lower)
        history.displayNames.set(lower, login)
        if (history.displayNames.size > MAX_DISPLAY_NAMES) {
          history.displayNames.delete(history.displayNames.keys().next().value)
        }
      }
    }
    return changed
  }
  const archiveRecord = (history, record) => ({
    scope: history.scope, storageId: record.storageId, id: record.id, user: record.user,
    createdAt: record.createdAt, order: record.order, expiresAt: record.createdAt + RETENTION_MS,
    vodOffset: hasVodOffset(record) ? Math.floor(record.vodOffset) : null,
    broadcastAt: Number.isFinite(record.broadcastAt) ? record.broadcastAt : null,
    moderator: record.moderator, broadcaster: record.broadcaster, vip: record.vip,
    reply: sanitizeReply(record.reply),
    fingerprint: record.fingerprint, tree: archiveTree(record.view),
  })
  const validArchiveRecord = (saved, scope) => saved && saved.scope === scope &&
    typeof saved.storageId === 'string' && typeof saved.id === 'string' &&
    typeof saved.user === 'string' && /^[a-z0-9_]{1,25}$/.test(saved.user) &&
    Number.isFinite(saved.createdAt) && saved.createdAt <= Date.now() && saved.createdAt + RETENTION_MS > Date.now() &&
    saved.tree && typeof saved.tree === 'object'
  const hasVodOffset = record => Number.isFinite(record?.vodOffset) && record.vodOffset >= 0
  const formatVodTime = seconds => {
    const total = Math.max(0, Math.floor(seconds))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`
  }
  const parseVodTimestamp = text => {
    const match = String(text || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
    if (!match) return null
    const h = match[1] ? Number(match[1]) : 0
    const m = Number(match[2])
    const s = Number(match[3])
    if (s >= 60 || (match[1] && m >= 60)) return null
    return h * 3600 + m * 60 + s
  }
  const formatClockTime = timestamp => {
    const date = new Date(timestamp)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  }
  const vodIdFromJsonLdUrl = rawUrl => {
    if (typeof rawUrl !== 'string' || !rawUrl) return ''
    try {
      const url = new URL(rawUrl, location.origin)
      const parts = url.pathname.toLowerCase().split('/').filter(Boolean)
      if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return parts[1]
      if (parts.length >= 3 && parts[1] === 'video' && /^\d+$/.test(parts[2] || '') &&
        /^[a-z0-9_]{1,25}$/.test(parts[0]) && !RESERVED_PATHS.has(parts[0])) return parts[2]
      const queryId = url.searchParams.get('video') || ''
      if (/^\d+$/.test(queryId)) return queryId
    } catch (_) {}
    return ''
  }
  const flattenJsonLd = (node, items = []) => {
    if (!node || typeof node !== 'object') return items
    if (Array.isArray(node)) {
      for (const entry of node) flattenJsonLd(entry, items)
      return items
    }
    if (Array.isArray(node['@graph'])) {
      for (const entry of node['@graph']) flattenJsonLd(entry, items)
    }
    items.push(node)
    return items
  }
  const readVodStartFromJsonLd = vodId => {
    if (!vodId) return null
    for (const script of $$('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || '')
        for (const item of flattenJsonLd(parsed)) {
          const type = item?.['@type']
          const isVideoObject = Array.isArray(type) ? type.includes('VideoObject') : type === 'VideoObject'
          if (!isVideoObject) continue
          const matched = vodIdFromJsonLdUrl(item.contentUrl) === vodId ||
            vodIdFromJsonLdUrl(item.embedUrl) === vodId ||
            vodIdFromJsonLdUrl(item['@id']) === vodId
          if (!matched) continue
          const startMs = Date.parse(item.uploadDate || '')
          if (Number.isFinite(startMs)) return startMs
        }
      } catch (_) {}
    }
    return null
  }
  const setVodStartCache = (vodId, entry) => {
    vodStartCache.delete(vodId)
    vodStartCache.set(vodId, entry)
    if (vodStartCache.size > MAX_VOD_START_CACHE) vodStartCache.delete(vodStartCache.keys().next().value)
  }
  const fetchVodStartTime = vodId => {
    if (!vodId) return Promise.resolve(null)
    const cached = vodStartCache.get(vodId)
    if (cached && Date.now() < cached.retryAfter) return Promise.resolve(cached.value)
    const inflight = vodStartRequests.get(vodId)
    if (inflight) return inflight
    const request = (async () => {
      try {
        if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(GQL_TIMEOUT_MS)
          : undefined
        const response = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'query($id: ID!) { video(id: $id) { id createdAt publishedAt broadcastType } }',
            variables: { id: vodId },
          }),
          ...(signal ? { signal } : {}),
        })
        if (!response?.ok) throw new Error(`HTTP ${response?.status}`)
        const payload = await response.json()
        const video = payload?.data?.video
        if (!video || (video.id && String(video.id) !== String(vodId))) {
          setVodStartCache(vodId, { value: null, retryAfter: Date.now() + GQL_RETRY_COOLDOWN_MS })
          return null
        }
        const broadcastType = String(video.broadcastType || '').toUpperCase()
        if (broadcastType && broadcastType !== 'ARCHIVE') {
          setVodStartCache(vodId, { value: null, retryAfter: Infinity })
          return null
        }
        const startMs = Date.parse(video.createdAt || video.publishedAt || '')
        if (Number.isFinite(startMs)) {
          setVodStartCache(vodId, { value: startMs, retryAfter: Infinity })
          return startMs
        }
        setVodStartCache(vodId, { value: null, retryAfter: Date.now() + GQL_RETRY_COOLDOWN_MS })
        return null
      } catch (_) {
        const fallbackMs = readVodStartFromJsonLd(vodId)
        if (Number.isFinite(fallbackMs)) {
          setVodStartCache(vodId, { value: fallbackMs, retryAfter: Infinity })
          return fallbackMs
        }
        setVodStartCache(vodId, { value: null, retryAfter: Date.now() + GQL_RETRY_COOLDOWN_MS })
        return null
      } finally {
        vodStartRequests.delete(vodId)
      }
    })()
    vodStartRequests.set(vodId, request)
    return request
  }
  const resolveVodBroadcastTime = (record, history = null) => {
    if (Number.isFinite(record?.broadcastAt)) return record.broadcastAt
    if (hasVodOffset(record) && Number.isFinite(history?.vodStartTime)) {
      return history.vodStartTime + Math.floor(record.vodOffset) * 1000
    }
    return null
  }
  const getRecordDateKey = (record, history = null) => {
    if (!record) return ''
    if (hasVodOffset(record)) {
      if (history?.settings?.vodTimeMode !== 'broadcast') return ''
      const broadcastMs = resolveVodBroadcastTime(record, history)
      return broadcastMs !== null ? formatDateKey(broadcastMs) : ''
    }
    return formatDateKey(record.createdAt)
  }
  const applyVodTime = (time, view, vodOffset) => {
    const offset = Math.floor(vodOffset)
    const label = formatVodTime(offset)
    time.textContent = label
    time.setAttribute('datetime', `PT${offset}S`)
    time.setAttribute('title', `影片時間 ${label}`)
    if (view) viewDates.delete(view)
  }
  const applyBroadcastVodTime = (time, view, broadcastMs, vodOffset = null) => {
    const date = new Date(broadcastMs)
    const label = formatClockTime(broadcastMs)
    const dateKey = formatDateKey(broadcastMs)
    time.textContent = label
    time.setAttribute('datetime', date.toISOString())
    time.setAttribute('title', Number.isFinite(vodOffset) && vodOffset >= 0
      ? `${dateKey} ${label}（影片時間 ${formatVodTime(vodOffset)}）`
      : `${dateKey} ${label}`)
    if (view) viewDates.set(view, dateKey)
  }
  const syncRecordTime = (record, history = null) => {
    const time = viewTime(record?.view)
    if (!time) return
    if (hasVodOffset(record)) {
      if (history?.settings?.vodTimeMode === 'broadcast') {
        const broadcastMs = resolveVodBroadcastTime(record, history)
        if (broadcastMs !== null) {
          applyBroadcastVodTime(time, record.view, broadcastMs, record.vodOffset)
          return
        }
      }
      applyVodTime(time, record.view, record.vodOffset)
      return
    }
    const date = new Date(record.createdAt)
    if (!time.getAttribute('datetime')) time.setAttribute('datetime', date.toISOString())
    if (!time.getAttribute('title')) time.setAttribute('title', `${formatDateKey(record.createdAt)} ${time.textContent}`)
    viewDates.set(record.view, formatDateKey(record.createdAt))
  }
  const syncHistoryTimes = history => {
    if (!history) return
    for (const record of history.messages) syncRecordTime(record, history)
  }
  const compareRecords = (a, b) => (hasVodOffset(a) && hasVodOffset(b) && a.vodOffset !== b.vodOffset
    ? a.vodOffset - b.vodOffset
    : a.createdAt - b.createdAt || (a.order || 0) - (b.order || 0))
  const formatDateKey = timestamp => {
    const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now())
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
  }
  const siblingView = (view, delta) => {
    if (delta < 0 && 'previousElementSibling' in view) return view.previousElementSibling
    if (delta > 0 && 'nextElementSibling' in view) return view.nextElementSibling
    const siblings = view.parentElement?.children
    if (!siblings) return null
    return siblings[siblings.indexOf(view) + delta] || null
  }
  const syncDateMarker = (view, previousView) => {
    if (!view) return
    const dateKey = viewDates.get(view)
    const prevKey = previousView ? viewDates.get(previousView) : ''
    if (dateKey && dateKey !== prevKey) view.setAttribute('data-date', dateKey)
    else view.removeAttribute('data-date')
  }
  const formatAuthorLabel = (displayName, user) => {
    const name = String(displayName || '').replace(/\s+/g, ' ').trim()
    if (!name) return user || ''
    if (!user) return name
    const lower = name.toLowerCase()
    if (lower === user || lower.includes(`(${user})`)) return name
    return `${name} (${user})`
  }
  const makeReplyView = reply => {
    const quote = element('div', { class: 'ttc-reply' })
    const text = element('span', { class: 'ttc-reply-text' })
    const label = formatAuthorLabel(reply.parentDisplayName, reply.parentUser)
    const bodyText = reply.parentText || (reply.parentDeleted ? '訊息已刪除' : '')
    if (label) {
      text.appendChild(document.createTextNode('回覆 '))
      text.appendChild(element('span', { class: 'ttc-reply-author', dir: 'auto' }, [`@${label}`]))
      if (bodyText) text.appendChild(document.createTextNode('：'))
    }
    if (bodyText) {
      text.appendChild(element('span', {
        class: reply.parentDeleted ? 'ttc-reply-body ttc-reply-deleted' : 'ttc-reply-body',
        dir: 'auto',
      }, [bodyText]))
    }
    quote.appendChild(text)
    return quote
  }
  const syncReplyView = record => {
    if (!record?.view || !record.reply) return
    const nextQuote = makeReplyView(record.reply)
    const oldQuote = $('.ttc-reply', record.view)
    if (oldQuote) oldQuote.replaceWith(nextQuote)
    else record.view.insertBefore(nextQuote, record.view.firstChild || null)
    record.view.className = 'ttc-message ttc-has-reply'
  }
  const makeOrphanParentView = (reply, history) => {
    const row = element('div', { class: 'ttc-message ttc-orphan-message' }, [
      element('span', { class: 'ttc-orphan-tag' }, ['原留言']),
    ])
    const label = formatAuthorLabel(reply?.parentDisplayName, reply?.parentUser)
    const bodyText = reply?.parentText || (reply?.parentDeleted ? '訊息已刪除' : '')
    const color = reply?.parentUser ? history?.knownRoles?.get(reply.parentUser)?.color || '' : ''
    if (label) {
      const author = element('strong', { class: 'ttc-orphan-author', dir: 'auto' }, [label])
      if (color) author.style.color = color
      row.appendChild(author)
      if (bodyText) row.appendChild(document.createTextNode(': '))
    }
    if (bodyText) {
      row.appendChild(element('span', {
        class: reply?.parentDeleted ? 'ttc-orphan-body ttc-reply-deleted' : 'ttc-orphan-body',
        dir: 'auto',
      }, [bodyText]))
    }
    return row
  }
  const restoreRecord = (saved, history = null) => {
    if (saved.tree?.tag !== 'div') return null
    const view = restoreTree(saved.tree)
    const time = viewTime(view)
    if (!view || !time) return null
    const reply = sanitizeReply(saved.reply)
    const vodOffset = hasVodOffset(saved) ? Math.floor(saved.vodOffset) : null
    const broadcastAt = Number.isFinite(saved.broadcastAt) ? saved.broadcastAt : null
    view.className = reply ? 'ttc-message ttc-has-reply' : 'ttc-message'
    if (reply && !$('.ttc-reply', view)) view.insertBefore(makeReplyView(reply), view.firstChild)
    const authorNode = [...view.children].find(child => child.tagName?.toLowerCase() === 'strong')
    if (authorNode) authorNode.textContent = formatAuthorLabel(authorNode.textContent, saved.user)
    if (reply) {
      const replyLabel = formatAuthorLabel(reply.parentDisplayName, reply.parentUser)
      const replyAuthor = $('.ttc-reply-author', view)
      if (replyAuthor && replyLabel) replyAuthor.textContent = `@${replyLabel}`
    }
    const record = { id: saved.id, storageId: saved.storageId, user: saved.user, createdAt: saved.createdAt,
      vodOffset, broadcastAt,
      order: Number.isSafeInteger(saved.order) ? saved.order : 0,
      moderator: saved.moderator === true, broadcaster: saved.broadcaster === true, vip: saved.vip === true,
      reply,
      fingerprint: saved.fingerprint, view, retained: true }
    syncRecordTime(record, history)
    return record
  }
  const updateArchiveStatus = history => {
    if (mounted?.history !== history || !mounted.panel) return
    const status = $('.ttc-history-status', mounted.panel)
    if (!status) return
    if (history.archiveError) status.setAttribute('role', 'status')
    else status.removeAttribute('role')
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
      const records = saved.filter(item => validArchiveRecord(item, history.scope)).sort(compareRecords)
      const restored = []
      let deadline = nowMs() + 50
      for (const item of records) {
        const current = item.id ? history.ids.get(item.id) : null
        if (current) {
          current.createdAt = Math.min(current.createdAt, item.createdAt)
          current.order = Number.isSafeInteger(item.order) ? item.order : current.order
          if (!hasVodOffset(current) && hasVodOffset(item)) current.vodOffset = Math.floor(item.vodOffset)
          if (!Number.isFinite(current.broadcastAt) && Number.isFinite(item.broadcastAt)) current.broadcastAt = item.broadcastAt
          const currentTime = viewTime(current.view)
          const savedTime = viewTime(restoreTree(item.tree))
          if (hasVodOffset(current)) {
            if (currentTime) syncRecordTime(current, history)
            else viewDates.delete(current.view)
          } else {
            if (currentTime) {
              currentTime.textContent = savedTime?.textContent || currentTime.textContent
              currentTime.setAttribute('datetime', new Date(current.createdAt).toISOString())
              currentTime.setAttribute('title', `${formatDateKey(current.createdAt)} ${currentTime.textContent}`)
            }
            viewDates.set(current.view, formatDateKey(current.createdAt))
          }
          current._searchText = ''
          saveRecord(history, current)
        } else {
          const record = restoreRecord(item, history)
          if (!record) continue
          record._searchText = ''
          restored.push(record)
          if (record.id) history.ids.set(record.id, record)
          history.byStorageId?.set(record.storageId, record)
          history.dirty.add(record)
        }
        if (nowMs() >= deadline) {
          await yieldToMain()
          deadline = nowMs() + 50
        }
      }
      history.messages.unshift(...restored)
      history.messages.sort(compareRecords)
      const owner = history.channel.startsWith('vod:') ? getVodOwner() : history.channel
      for (const record of history.messages) {
        const authorNode = [...record.view.children].find(child => child.tagName?.toLowerCase() === 'strong')
        rememberUser(history, record.user, authorNode?.textContent || '', {
          moderator: record.moderator,
          broadcaster: record.broadcaster,
          vip: record.vip,
          color: authorNode?.style?.color || '',
        })
      }
      for (const record of history.messages) {
        if (!record.reply) continue
        let parentRecord = record.reply.parentId ? (history.ids.get(record.reply.parentId) || history.byStorageId?.get(record.reply.parentId)) : null
        const resolvedUser = record.reply.parentUser ||
          parentRecord?.user ||
          (record.reply.parentDisplayName ? history.displayNames?.get(record.reply.parentDisplayName.toLowerCase()) : '') ||
          ''
        if (!parentRecord && record.reply.inferred && resolvedUser && resolvedUser !== record.user && hasVodOffset(record)) {
          parentRecord = findVodReplyParent(history, resolvedUser, record.vodOffset, record.id || record.storageId)
        }
        const nextParentId = parentRecord ? (parentRecord.id || parentRecord.storageId) : record.reply.parentId
        const nextParentText = parentRecord && record.reply.inferred
          ? (extractViewBodyText(parentRecord.view) || record.reply.parentText)
          : record.reply.parentText
        const known = resolvedUser ? history.knownRoles?.get(resolvedUser) : null
        const nextModerator = Boolean(record.reply.parentModerator || parentRecord?.moderator || known?.moderator)
        const nextBroadcaster = Boolean(record.reply.parentBroadcaster || (owner && resolvedUser === owner) || parentRecord?.broadcaster || known?.broadcaster)
        const nextVip = Boolean(record.reply.parentVip || parentRecord?.vip || known?.vip)
        if (nextParentId !== record.reply.parentId ||
          nextParentText !== record.reply.parentText ||
          resolvedUser !== record.reply.parentUser ||
          nextModerator !== record.reply.parentModerator ||
          nextBroadcaster !== record.reply.parentBroadcaster ||
          nextVip !== record.reply.parentVip) {
          record.reply = sanitizeReply({
            ...record.reply,
            parentId: nextParentId,
            parentUser: resolvedUser,
            parentText: nextParentText,
            parentModerator: nextModerator,
            parentBroadcaster: nextBroadcaster,
            parentVip: nextVip,
          })
          syncReplyView(record)
          record._searchText = ''
          history.dirty.add(record)
          saveRecord(history, record)
        }
      }
      if (mounted?.history === history && mounted.scroller) captureTree(mounted.scroller, history)
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

  const ensureVodStartTime = async history => {
    if (!history?.channel?.startsWith('vod:')) return null
    const vodId = history.channel.slice(4)
    const startMs = await fetchVodStartTime(vodId)
    if (Number.isFinite(startMs)) {
      history.vodStartTime = startMs
      syncHistoryTimes(history)
      if (mounted?.history === history && history.enabled) renderMessages(mounted, true)
    }
    return startMs
  }

  const getHistory = (channel) => {
    let history = histories.get(channel)
    if (!history) {
      history = {
        channel, settings: loadSettings(channel), vodStartTime: null, messages: [], nodes: new WeakMap(),
        scope: channel, ids: new Map(), byStorageId: new Map(), knownRoles: new Map(), displayNames: new Map(),
        saveQueue: new Map(), deleteQueue: new Set(),
        archiveReady: false, archiveError: false,
        enabled: false, follow: true, search: '', dirty: new Set(), removed: new Set(),
      }
      history.restorePromise = restoreHistory(history)
      if (channel.startsWith('vod:')) history.vodStartPromise = ensureVodStartTime(history)
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

  const readFiberMessage = (line, expectedUser = '') => {
    try {
      const key = Object.keys(line).find(name => name.startsWith('__reactFiber') || name.startsWith('__reactInternalInstance'))
      if (!key) return null
      let current = line[key]
      for (let step = 0; step < 20 && current; step++) {
        const message = current.memoizedProps?.message || current.memoizedProps?.msg
        if (message && typeof message === 'object') {
          const fiberUser = String(message.user?.userLogin || message.user?.login || '').toLowerCase()
          if (expectedUser && fiberUser && fiberUser !== expectedUser) {
            current = current.return
            continue
          }
          if (message.id || message.reply || fiberUser) return message
        }
        current = current.return
      }
    } catch (_) {}
    return null
  }

  const readDomReply = (line, authorContainer, body) => {
    const ignored = node => Boolean(
      !node ||
      authorContainer?.contains?.(node) ||
      body?.contains?.(node) ||
      node.closest?.('.chat-line__icons, .chat-line__reply-icon')
    )
    const explicit = $$('[data-a-target="chat-line-reply"], [data-test-selector="chat-reply-quote"], .chat-line__reply, .reply-line', line)
      .find(node => !ignored(node))
    const pCandidates = $$('p', line).filter(node => !ignored(node))
    const candidates = explicit ? [explicit, ...pCandidates.filter(p => !explicit.contains?.(p))] : pCandidates
    const dataNode = explicit || line
    let parentId = (
      dataNode.getAttribute?.('data-reply-parent-id') ||
      dataNode.getAttribute?.('data-parent-msg-id') ||
      line.getAttribute?.('data-reply-parent-id') ||
      line.getAttribute?.('data-parent-msg-id') || ''
    ).trim()
    let parentUser = normalizeLogin(
      dataNode.getAttribute?.('data-reply-parent-user') ||
      dataNode.getAttribute?.('data-parent-user-login') ||
      line.getAttribute?.('data-reply-parent-user') ||
      line.getAttribute?.('data-parent-user-login') || ''
    )
    let parentDisplayName = (
      dataNode.getAttribute?.('data-reply-parent-display-name') ||
      line.getAttribute?.('data-reply-parent-display-name') || ''
    ).replace(/\s+/g, ' ').trim()
    let parentText = (
      dataNode.getAttribute?.('data-reply-parent-text') ||
      line.getAttribute?.('data-reply-parent-text') || ''
    ).replace(/\s+/g, ' ').trim()

    for (const candidate of candidates) {
      const p = candidate.tagName?.toLowerCase() === 'p' ? candidate : $('p', candidate)
      const textHost = p || candidate
      const dirSpans = $$('span', textHost).filter(span => span.getAttribute('dir') === 'auto')
      const authorSpan = dirSpans.find(span => span.textContent.trim().startsWith('@'))
      const titleText = (textHost.getAttribute?.('title') || candidate.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim()
      const bodySpan = authorSpan ? dirSpans.find(span => span !== authorSpan) : null
      const spanBodyText = bodySpan ? bodySpan.textContent.replace(/\s+/g, ' ').trim() : ''
      const rawText = textHost.textContent.trim()
      const match = rawText.match(/^(?:回覆|回复|Replying to|Reply to)\s*@([^\s:：]+)\s*[:：]\s*([\s\S]*)$/i) ||
        rawText.match(/^@([^\s:：]+)\s*(?:への返信|に返信|님에게\s*답장)\s*[:：]\s*([\s\S]*)$/i)
      const isReplyCandidate = Boolean(explicit || match || (authorSpan && (titleText || bodySpan)))
      if (!isReplyCandidate) continue
      if (!parentDisplayName) {
        if (authorSpan) parentDisplayName = authorSpan.textContent.trim().slice(1).replace(/\s+/g, ' ').trim()
        else if (match) parentDisplayName = match[1].trim()
      }
      if (!parentText) {
        if (titleText) parentText = titleText
        else if (spanBodyText) parentText = spanBodyText
        else if (match) parentText = match[2].replace(/\s+/g, ' ').trim()
      }
      if (!parentId) {
        parentId = (candidate.getAttribute?.('data-reply-parent-id') || candidate.getAttribute?.('data-parent-msg-id') || '').trim()
      }
      if (!parentUser) {
        parentUser = normalizeLogin(candidate.getAttribute?.('data-reply-parent-user') || candidate.getAttribute?.('data-parent-user-login') || '')
      }
      if (parentId || parentUser || parentDisplayName || parentText) break
    }
    if (!parentId && !parentUser && !parentDisplayName && !parentText) return null
    return { parentId, parentUser, parentDisplayName, parentText }
  }

  const extractNodeText = node => {
    if (!node) return ''
    if (node.nodeType === 3 || node.tagName === '#text') return String(node.textContent || '')
    if (node.nodeType !== 1) return ''
    const tag = (node.localName || node.tagName || '').toLowerCase()
    if (tag === 'img') return node.getAttribute?.('alt') || ''
    if (tag === 'br') return ' '
    const parts = []
    for (const child of [...(node.childNodes || [])]) {
      const piece = extractNodeText(child)
      if (piece) parts.push(piece)
    }
    return parts.join('')
  }

  const extractViewBodyText = view => {
    if (!view?.children) return ''
    const body = [...view.children].reverse().find(child => {
      const tag = (child.localName || child.tagName || '').toLowerCase()
      return tag && tag !== '#text' && tag !== 'time' && tag !== 'strong' && tag !== 'img' &&
        !child.classList?.contains?.('ttc-reply') && !child.matches?.('.ttc-reply')
    })
    return extractNodeText(body).replace(/\s+/g, ' ').trim()
  }

  const pushVodMention = (list, seen, raw) => {
    const clean = String(raw || '').replace(/^@/, '').trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) return
    seen.add(key)
    list.push(clean)
  }

  const readVodMentionFromTokens = tokens => {
    if (!Array.isArray(tokens)) return ''
    for (const token of tokens) {
      if (token?.type === 0) {
        if (!String(token.content || '').trim()) continue
        return ''
      }
      if (token?.type === 4 && typeof token.content?.recipient === 'string') {
        return token.content.recipient.replace(/^@/, '').trim()
      }
      return ''
    }
    return ''
  }

  const readVodMentionsFromTokens = tokens => {
    const mentions = []
    if (!Array.isArray(tokens)) return mentions
    const seen = new Set()
    for (const token of tokens) {
      if (token?.type === 4 && typeof token.content?.recipient === 'string') {
        pushVodMention(mentions, seen, token.content.recipient)
      }
    }
    return mentions
  }

  const readVodMentionFromDom = body => {
    for (const node of [...(body?.childNodes || [])]) {
      if (node.nodeType === 3 || node.tagName === '#text') {
        if (!String(node.textContent || '').trim()) continue
        return ''
      }
      if (node.nodeType !== 1) continue
      if (node.matches?.('[data-a-target="chat-message-mention"], .mention-fragment')) {
        return String(node.textContent || '').trim().replace(/^@/, '').trim()
      }
      if (!String(node.textContent || '').trim() && !$('img', node)) continue
      return ''
    }
    return ''
  }

  const readVodMentionsFromDom = body => {
    const mentions = []
    if (!body) return mentions
    const seen = new Set()
    for (const node of $$('[data-a-target="chat-message-mention"], .mention-fragment', body)) {
      pushVodMention(mentions, seen, node.textContent)
    }
    return mentions
  }

  const readVodMeta = (line, expectedUser = '') => {
    let id = ''
    let vodOffset = null
    let broadcastAt = null
    let mentionRecipient = ''
    let mentions = []
    try {
      const key = Object.keys(line).find(name => name.startsWith('__reactFiber') || name.startsWith('__reactInternalInstance'))
      let current = key ? line[key] : null
      for (let step = 0; step < 20 && current; step++, current = current.return) {
        const props = current.memoizedProps
        if (!props || typeof props !== 'object') continue
        const mc = props.messageContext
        const comment = mc?.comment && typeof mc.comment === 'object' ? mc.comment : null
        if (comment || Number.isFinite(props.timeStampOffset)) {
          const fiberUser = String(
            comment?.commenter?.login || comment?.commenter?.userLogin ||
            mc?.author?.login || mc?.author?.userLogin || mc?.author?.name || ''
          ).toLowerCase()
          if (expectedUser && fiberUser && fiberUser !== expectedUser) continue
          if (!id && typeof comment?.id === 'string' && comment.id) id = comment.id
          const rawOffset = [props.timeStampOffset, comment?.contentOffset, comment?.contentOffsetSeconds]
            .find(value => Number.isFinite(value) && value >= 0)
          if (vodOffset === null && Number.isFinite(rawOffset)) vodOffset = Math.floor(rawOffset)
          const rawBroadcastAt = comment?.createdAt ?? props.createdAt
          if (broadcastAt === null) {
            if (typeof rawBroadcastAt === 'string' && rawBroadcastAt) {
              const parsedAt = Date.parse(rawBroadcastAt)
              if (Number.isFinite(parsedAt)) broadcastAt = parsedAt
            } else if (Number.isFinite(rawBroadcastAt) && rawBroadcastAt > 0) {
              broadcastAt = rawBroadcastAt
            }
          }
          if (Array.isArray(comment?.message?.tokens)) {
            if (!mentionRecipient) mentionRecipient = readVodMentionFromTokens(comment.message.tokens)
            if (!mentions.length) mentions = readVodMentionsFromTokens(comment.message.tokens)
          }
          if (id && vodOffset !== null && (mentionRecipient || mentions.length || Array.isArray(comment?.message?.tokens))) break
        }
      }
    } catch (_) {}
    if (vodOffset === null) {
      const header = $('.vod-message__header', line)
      const tsNode = $('.vod-message__timestamp, [data-test-selector="message-timestamp"]', line)
      const headerParts = header ? [...$$('button, p', header), header] : []
      for (const node of [...(tsNode ? [tsNode] : []), ...headerParts]) {
        if (!node) continue
        const parsed = parseVodTimestamp(node.textContent)
        if (parsed !== null) { vodOffset = parsed; break }
      }
    }
    return { id, vodOffset, broadcastAt, mentionRecipient, mentions }
  }

  const resolveParentRoles = (channel, history, parentUser, parentRecord, existing = null) => {
    const known = parentUser ? history?.knownRoles?.get(parentUser) : null
    return {
      parentModerator: Boolean(existing?.parentModerator || (parentRecord ? parentRecord.moderator : known?.moderator)),
      parentBroadcaster: Boolean(existing?.parentBroadcaster ||
        (Boolean(channel) && parentUser && parentUser === channel) ||
        (parentRecord ? parentRecord.broadcaster : known?.broadcaster)),
      parentVip: Boolean(existing?.parentVip || (parentRecord ? parentRecord.vip : known?.vip)),
    }
  }

  const readMessage = (line, channel, history = null, isVod = false) => {
    const author = $(USER_SELECTOR, line)
    // Use the author's badges only: quoted replies can contain another user's badges.
    const authorLink = author?.closest?.('.video-chat__message-author')
    const authorContainer = author?.closest('.chat-line__username-container, [data-test-selector="message-header"]') ||
      authorLink?.parentElement || author?.closest('.vod-message__header') || author?.parentElement
    const user = (
      author?.getAttribute('data-a-user') ||
      author?.closest?.('[data-a-user]')?.getAttribute('data-a-user') ||
      line.getAttribute('data-a-user') ||
      $('[data-a-user]', authorContainer || line)?.getAttribute('data-a-user') ||
      loginFromHref(author?.closest?.('a')?.getAttribute('href') || $$('a', authorContainer || line).find(a => a.getAttribute('href'))?.getAttribute('href')) ||
      ''
    ).toLowerCase()
    const contentParent = $('[data-a-target="chat-message-text"], .text-fragment, .chat-line__message--emote-button, [data-a-target="chat-message-mention"], .mention-fragment', line)?.parentElement ||
      $('.video-chat__message', line)?.lastElementChild
    const body = $(BODY_SELECTOR, line) || (contentParent && contentParent !== authorContainer ? contentParent : null)
    if (!user || !author || !body || body.contains?.(author)) return null
    const badges = $$('[data-a-target="chat-badge"] img, img.chat-badge', authorContainer).filter(badge => !body.contains?.(badge))
    const moderator = badges.some(badge =>
      (badge.getAttribute('src') || '').includes(MODERATOR_BADGE) ||
      /^(moderator|管理員(?:徽章)?|モデレーター)$/i.test((badge.getAttribute('alt') || '').trim()))
    const broadcaster = (Boolean(channel) && user === channel) || badges.some(badge =>
      (badge.getAttribute('src') || '').includes(BROADCASTER_BADGE) ||
      (badge.getAttribute('srcset') || '').includes(BROADCASTER_BADGE) ||
      /^(broadcaster|實況主|頻道主|配信者)$/i.test(badge.getAttribute('alt') || ''))
    const vip = badges.some(badge =>
      (badge.getAttribute('src') || '').includes(VIP_BADGE) ||
      (badge.getAttribute('srcset') || '').includes(VIP_BADGE) ||
      /^(vip|vip\s*(?:徽章|バッジ))$/i.test((badge.getAttribute('alt') || '').trim()))
    const fiberMsg = readFiberMessage(line, user)
    const vodLine = Boolean(isVod || line.matches?.('.vod-message') || line.closest?.('.video-chat'))
    const vodMeta = vodLine ? readVodMeta(line, user) : null
    const id = line.getAttribute('data-id') || line.getAttribute('data-message-id') || line.getAttribute('data-a-id') || line.id ||
      (typeof fiberMsg?.id === 'string' ? fiberMsg.id : '') ||
      vodMeta?.id ||
      ''
    const rawReply = fiberMsg?.reply && typeof fiberMsg.reply === 'object' ? fiberMsg.reply : null
    const domReply = readDomReply(line, authorContainer, body)
    let reply = null
    if (rawReply || domReply) {
      const parentId = String(rawReply?.parentMsgId || domReply?.parentId || '').trim()
      const parentDisplayName = String(rawReply?.parentDisplayName || domReply?.parentDisplayName || '').replace(/\s+/g, ' ').trim()
      const parentRecord = parentId ? (history?.ids?.get(parentId) || history?.byStorageId?.get(parentId)) : null
      const parentUser = normalizeLogin(rawReply?.parentUserLogin) ||
        normalizeLogin(domReply?.parentUser) ||
        parentRecord?.user ||
        (parentDisplayName ? history?.displayNames?.get(parentDisplayName.toLowerCase()) : '') ||
        normalizeLogin(parentDisplayName) ||
        ''
      const parentDeleted = Boolean(rawReply?.parentDeleted)
      const parentText = domReply?.parentText ||
        String(rawReply?.parentMessageBody || '').replace(/\s+/g, ' ').trim() ||
        (parentDeleted ? '訊息已刪除' : '')
      reply = sanitizeReply({
        parentId,
        parentUser,
        parentDisplayName,
        parentText,
        parentDeleted,
        ...resolveParentRoles(channel, history, parentUser, parentRecord),
      })
    } else if (vodLine) {
      const mentionRecipient = vodMeta?.mentionRecipient || readVodMentionFromDom(body)
      if (mentionRecipient) {
        const parentUser = (history?.displayNames?.get(mentionRecipient.toLowerCase())) || normalizeLogin(mentionRecipient) || ''
        if (parentUser && parentUser !== user) {
          const parentRecord = findVodReplyParent(history, parentUser, vodMeta?.vodOffset ?? null, id)
          const roles = resolveParentRoles(channel, history, parentUser, parentRecord)
          if (parentRecord) {
            reply = sanitizeReply({
              parentId: parentRecord.id || parentRecord.storageId || '',
              parentUser,
              parentDisplayName: mentionRecipient,
              parentText: extractViewBodyText(parentRecord.view),
              parentDeleted: false,
              ...roles,
              inferred: true,
            })
          } else if (history?.settings &&
            isReplyToActiveTarget({ parentUser, ...roles }, history.settings) &&
            !matchesTarget({ user, moderator, broadcaster, vip }, history.settings)) {
            reply = sanitizeReply({
              parentId: '',
              parentUser,
              parentDisplayName: mentionRecipient,
              parentText: '',
              parentDeleted: false,
              ...roles,
              inferred: true,
            })
          }
        }
      }
    }
    const vodMentions = []
    if (vodLine) {
      const seenVodMentions = new Set()
      for (const raw of vodMeta?.mentions || []) pushVodMention(vodMentions, seenVodMentions, raw)
      for (const raw of readVodMentionsFromDom(body)) pushVodMention(vodMentions, seenVodMentions, raw)
    }
    return { user, moderator, broadcaster, vip, reply, author, body, badges, id,
      vodOffset: vodMeta ? vodMeta.vodOffset : null,
      broadcastAt: vodMeta ? vodMeta.broadcastAt : null,
      mentions: vodMentions }
  }

  const resolveMentionUser = (mentionText, history) => {
    const clean = String(mentionText || '').replace(/^@/, '').trim()
    if (!clean) return ''
    return history?.displayNames?.get(clean.toLowerCase()) || normalizeLogin(clean) || ''
  }

  const isVodNativeLine = (line, history) =>
    Boolean(history?.channel?.startsWith('vod:') && line && (line.matches?.('.vod-message') || line.closest?.('.video-chat')))

  const matchesVodMentionTarget = (mentionText, senderUser, owner, history) => {
    const mentionUser = resolveMentionUser(mentionText, history)
    if (!mentionUser || mentionUser === senderUser) return false
    const roles = resolveParentRoles(owner, history, mentionUser, null)
    return matchesTarget({
      user: mentionUser,
      moderator: roles.parentModerator,
      broadcaster: roles.parentBroadcaster,
      vip: roles.parentVip,
    }, history.settings)
  }

  const applyVodMentionHighlight = (line, message, owner, history) => {
    if (!line?.classList) return false
    const active = Boolean(
      isVodNativeLine(line, history) &&
      message?.mentions?.length &&
      history?.settings &&
      !(history.settings.excludedUsers || []).includes(message.user) &&
      message.mentions.some(mentionText => matchesVodMentionTarget(mentionText, message.user, owner, history))
    )
    line.classList.toggle('ttc-vod-mention-line', active)
    return active
  }

  const syncVodMentionHighlights = (root, history) => {
    if (!root || !history?.channel?.startsWith('vod:')) return
    const owner = getVodOwner()
    const lines = new Set()
    collectMessageLines(root, lines)
    for (const line of lines) {
      const message = readMessage(line, owner, history, true)
      if (message) applyVodMentionHighlight(line, message, owner, history)
      else line.classList?.remove('ttc-vod-mention-line')
    }
  }

  const clearVodMentionHighlights = root => {
    if (!root) return
    if (root.classList?.contains('ttc-vod-mention-line')) root.classList.remove('ttc-vod-mention-line')
    for (const line of $$('.ttc-vod-mention-line', root)) line.classList.remove('ttc-vod-mention-line')
  }

  const matchesTarget = (target, settings) =>
    Boolean(target?.user) &&
    !(settings.excludedUsers || []).includes(target.user) && Boolean(
      (settings.moderators && target.moderator) ||
      (settings.broadcaster && target.broadcaster) ||
      (settings.vip && target.vip) ||
      (settings.users || []).includes(target.user)
    )

  const isReplyToActiveTarget = (reply, settings) =>
    Boolean(reply?.parentUser) && matchesTarget({
      user: reply.parentUser,
      moderator: Boolean(reply.parentModerator),
      broadcaster: Boolean(reply.parentBroadcaster),
      vip: Boolean(reply.parentVip),
    }, settings)

  const matchesReplyTarget = (reply, settings) =>
    settings.replies !== false && isReplyToActiveTarget(reply, settings)

  const matchesFilter = (message, settings) =>
    !(settings.excludedUsers || []).includes(message.user) &&
    (matchesTarget(message, settings) || matchesReplyTarget(message.reply, settings))

  const findVodReplyParent = (history, parentUser, replyOffset, selfId = '') => {
    if (!history || !parentUser) return null
    let best = null
    for (const record of history.messages) {
      if (!record.retained || record.user !== parentUser) continue
      if (selfId && (record.id === selfId || record.storageId === selfId)) continue
      if (history.settings && !matchesTarget(record, history.settings)) continue
      if (Number.isFinite(replyOffset)) {
        if (!hasVodOffset(record) || record.vodOffset > replyOffset || replyOffset - record.vodOffset > VOD_REPLY_WINDOW_S) continue
      }
      if (!best || compareRecords(record, best) > 0) best = record
    }
    return best
  }

  const relinkVodReplies = (history, parentRecord) => {
    if (!history || !parentRecord?.retained || !hasVodOffset(parentRecord)) return
    if (history.settings && !matchesTarget(parentRecord, history.settings)) return
    const parentKeyId = parentRecord.id || parentRecord.storageId
    if (!parentKeyId) return
    const parentText = extractViewBodyText(parentRecord.view)
    for (const candidate of history.messages) {
      if (candidate === parentRecord || !candidate.retained || !candidate.reply?.inferred) continue
      if (candidate.reply.parentUser !== parentRecord.user || !hasVodOffset(candidate)) continue
      if (parentRecord.vodOffset > candidate.vodOffset || candidate.vodOffset - parentRecord.vodOffset > VOD_REPLY_WINDOW_S) continue
      const currentParentId = candidate.reply.parentId
      let shouldLink = false
      if (!currentParentId) {
        shouldLink = true
      } else if (currentParentId === parentKeyId) {
        shouldLink = (Boolean(parentText) && candidate.reply.parentText !== parentText) ||
          candidate.reply.parentModerator !== Boolean(parentRecord.moderator) ||
          candidate.reply.parentBroadcaster !== Boolean(parentRecord.broadcaster) ||
          candidate.reply.parentVip !== Boolean(parentRecord.vip)
      } else {
        const currentParent = history.ids?.get(currentParentId) || history.byStorageId?.get(currentParentId)
        shouldLink = !currentParent || !hasVodOffset(currentParent) ||
          currentParent.vodOffset < parentRecord.vodOffset ||
          (currentParent.vodOffset === parentRecord.vodOffset && compareRecords(currentParent, parentRecord) < 0)
      }
      if (!shouldLink) continue
      const nextReply = sanitizeReply({
        ...candidate.reply,
        parentId: parentKeyId,
        parentText,
        parentModerator: parentRecord.moderator,
        parentBroadcaster: parentRecord.broadcaster,
        parentVip: parentRecord.vip,
        inferred: true,
      })
      if (!nextReply) continue
      candidate.reply = nextReply
      syncReplyView(candidate)
      candidate._searchText = ''
      history.dirty.add(candidate)
      saveRecord(history, candidate)
    }
  }

  const makeMessageView = (message, createdAt = Date.now(), vodOffset = message.vodOffset ?? null, history = null, broadcastAt = message.broadcastAt ?? null) => {
    // Copy presentation only. Never keep React-owned message nodes or inactive controls.
    const row = document.createElement('div')
    row.className = message.reply ? 'ttc-message ttc-has-reply' : 'ttc-message'
    if (message.reply) row.appendChild(makeReplyView(message.reply))
    const time = document.createElement('time')
    time.className = 'ttc-time'
    if (Number.isFinite(vodOffset) && vodOffset >= 0) {
      const broadcastMs = history?.settings?.vodTimeMode === 'broadcast'
        ? resolveVodBroadcastTime({ vodOffset, broadcastAt }, history)
        : null
      if (broadcastMs !== null) applyBroadcastVodTime(time, row, broadcastMs, vodOffset)
      else applyVodTime(time, row, vodOffset)
    } else {
      const date = new Date(createdAt)
      time.textContent = date.toLocaleTimeString('zh-TW', { hour12: false })
      time.setAttribute('datetime', date.toISOString())
      time.setAttribute('title', `${formatDateKey(createdAt)} ${time.textContent}`)
      viewDates.set(row, formatDateKey(createdAt))
    }
    row.appendChild(time)
    for (const badge of message.badges) {
      const copy = badge.cloneNode(false)
      copy.removeAttribute('tabindex')
      copy.removeAttribute('title')
      row.appendChild(copy)
    }
    const author = document.createElement('strong')
    author.textContent = formatAuthorLabel(message.author.textContent, message.user)
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

  const captureLine = (line, history, deferResync = false) => {
    const isVod = history.channel.startsWith('vod:')
    const owner = isVod ? getVodOwner() : history.channel
    const message = readMessage(line, owner, history, isVod)
    if (!message) return false
    const learned = rememberUser(history, message.user, message.author.textContent, {
      moderator: message.moderator,
      broadcaster: message.broadcaster,
      vip: message.vip,
      color: message.author.style?.color || '',
    })
    if (isVod) {
      applyVodMentionHighlight(line, message, owner, history)
      if (learned) {
        if (deferResync) history.mentionResyncNeeded = true
        else syncVodMentionHighlights(mounted?.history === history ? mounted.scroller : null, history)
      }
    }
    const previous = message.id ? history.ids.get(message.id) : history.nodes.get(line)
    // Only retain messages matching the active filter so unchecked roles and
    // excluded accounts cannot evict matching history from the 1000-message cap.
    if (!(previous?.retained && previous.user === message.user) && !matchesFilter(message, history.settings)) return false
    if (previous?.retained && previous.user === message.user && previous.reply?.inferred && previous.reply.parentId &&
      message.reply?.inferred && !message.reply.parentId && message.reply.parentUser === previous.reply.parentUser) {
      message.reply = previous.reply
    }
    const replyKey = message.reply
      ? `${message.reply.parentId}\n${message.reply.parentUser}\n${message.reply.parentDisplayName}\n${message.reply.parentText}\n${message.reply.parentDeleted}\n${message.reply.parentModerator}\n${message.reply.parentBroadcaster}\n${message.reply.parentVip}`
      : ''
    const fingerprint = `${message.user}\n${message.moderator}\n${message.broadcaster}\n${message.vip}\n${replyKey}\n${message.author.textContent}\n${message.body.innerHTML}`
    if (previous?.fingerprint === fingerprint) { history.nodes.set(line, previous); return false }
    const createdAt = previous && previous.user === message.user && previous.retained ? previous.createdAt : Date.now()
    const vodOffset = previous && previous.user === message.user && previous.retained && hasVodOffset(previous)
      ? previous.vodOffset
      : (hasVodOffset(message) ? Math.floor(message.vodOffset) : null)
    const broadcastAt = previous && previous.user === message.user && previous.retained && Number.isFinite(previous.broadcastAt)
      ? previous.broadcastAt
      : (Number.isFinite(message.broadcastAt) ? message.broadcastAt : null)
    const view = makeMessageView(message, createdAt, vodOffset, history, broadcastAt)
    let record
    if (previous && previous.user === message.user && previous.retained) {
      // Reflect edits/deletion placeholders while the original line is still present.
      const prevTime = viewTime(previous.view)
      const nextTime = viewTime(view)
      if (vodOffset === null && prevTime && nextTime) {
        nextTime.textContent = prevTime.textContent
        nextTime.setAttribute('datetime', new Date(createdAt).toISOString())
        nextTime.setAttribute('title', `${formatDateKey(createdAt)} ${nextTime.textContent}`)
      }
      record = Object.assign(previous, { moderator: message.moderator,
        broadcaster: message.broadcaster, vip: message.vip, reply: message.reply, vodOffset, broadcastAt, _searchText: '', view, fingerprint })
    } else {
      record = { id: message.id, user: message.user, moderator: message.moderator,
        broadcaster: message.broadcaster, vip: message.vip, reply: message.reply, vodOffset, broadcastAt, _searchText: '', view, fingerprint, retained: true,
        storageId: message.id || `${pageKey}-${++anonymousMessage}`,
        createdAt, order: ++messageOrder }
      const tail = history.messages.at(-1)
      history.messages.push(record)
      if (hasVodOffset(record) && tail && compareRecords(record, tail) < 0) history.messages.sort(compareRecords)
      trimHistory(history)
    }
    history.nodes.set(line, record)
    if (message.id) history.ids.set(message.id, record)
    history.byStorageId?.set(record.storageId, record)
    history.dirty.add(record)
    saveRecord(history, record)
    if (isVod && hasVodOffset(record)) relinkVodReplies(history, record)
    return true
  }

  // Keep these collection/render helpers in sync across both chat scripts.
  const forgetRecord = (history, record) => {
    record.retained = false
    record._searchText = ''
    history.dirty.delete(record)
    if (record.id && history.ids?.get(record.id) === record) history.ids.delete(record.id)
    if (record.storageId && history.byStorageId?.get(record.storageId) === record) history.byStorageId.delete(record.storageId)
    if (record.renderedView) history.removed.add(record)
  }

  const rootMessageLine = node => {
    let current = node?.closest?.(MESSAGE_SELECTOR)
    while (current?.parentElement) {
      const upper = current.parentElement.closest?.(MESSAGE_SELECTOR)
      if (!upper) break
      current = upper
    }
    return current || null
  }

  const collectMessageLines = (node, lines) => {
    if (node.nodeType !== 1 || node.closest?.('.ttc-panel')) return
    const line = rootMessageLine(node)
    if (line) lines.add(line)
    else for (const child of $$(MESSAGE_SELECTOR, node)) {
      const root = rootMessageLine(child)
      if (root) lines.add(root)
    }
  }

  const captureTree = (node, history) => {
    const lines = new Set()
    collectMessageLines(node, lines)
    history.mentionResyncNeeded = false
    let changed = false
    for (const line of lines) changed = captureLine(line, history, true) || changed
    if (history.mentionResyncNeeded) {
      history.mentionResyncNeeded = false
      syncVodMentionHighlights(mounted?.history === history ? mounted.scroller : node, history)
    }
    return changed
  }

  const captureMutations = (mutations, history) => {
    const lines = new Set()
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) collectMessageLines(node, lines)
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement
      if (target?.closest?.('.ttc-panel')) continue
      const line = rootMessageLine(target)
      if (line) lines.add(line)
    }
    // Snapshot data now, even in background tabs: native renderers may be
    // pruned/reused before the browser delivers another animation frame.
    history.mentionResyncNeeded = false
    let changed = false
    for (const line of lines) changed = captureLine(line, history, true) || changed
    if (history.mentionResyncNeeded) {
      history.mentionResyncNeeded = false
      syncVodMentionHighlights(mounted?.history === history ? mounted.scroller : null, history)
    }
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

  const normalizeSearch = value => String(value || '').normalize('NFKC').toLowerCase().trim()
  const messageSearchText = record => {
    if (record._searchText) return record._searchText
    const text = normalizeSearch([
      record.user,
      record.reply?.parentUser || '',
      record.reply?.parentDisplayName || '',
      record.reply?.parentText || '',
      ...[...record.view.childNodes]
        .filter(node => !node.matches?.('.ttc-time'))
        .map(node => node.textContent),
      ...$$('img', record.view).map(image => image.getAttribute('alt') || ''),
    ].join(' '))
    record._searchText = text
    return text
  }
  const unmountRecordView = (state, record) => {
    const oldView = record.renderedView
    if (oldView) {
      state.messageResizeObserver?.unobserve(oldView)
      oldView.remove()
    }
    record.renderedView = null
    record.visible = false
  }
  const renderMessageSearch = (state, query) => {
    const { history, list, empty, count, latest } = state
    if (!state.inSearchMode) {
      releaseMessageViews(state)
      state.inSearchMode = true
    }
    const words = query.split(/\s+/u)
    const hits = history.messages
      .filter(record => record.retained && matchesFilter(record, history.settings) &&
        words.every(word => messageSearchText(record).includes(word)))
      .sort(compareRecords)
    const shown = new Set(hits)
    for (const record of state.searchShown || []) if (!shown.has(record)) unmountRecordView(state, record)
    let index = 0
    let previousView = null
    const scrollTop = list.scrollTop
    for (const record of shown) {
      const view = record.view
      if (record.renderedView && record.renderedView !== view) {
        state.messageResizeObserver?.unobserve(record.renderedView)
        record.renderedView.remove()
      }
      view.hidden = false
      const dateKey = getRecordDateKey(record, history)
      if (dateKey) viewDates.set(view, dateKey)
      else viewDates.delete(view)
      syncDateMarker(view, previousView)
      previousView = view
      const existing = list.children[index++]
      if (existing !== view) {
        if (existing) list.insertBefore(view, existing)
        else list.appendChild(view)
      }
      record.renderedView = view
      record.visible = true
      state.messageResizeObserver?.observe(view)
    }
    state.searchShown = shown
    state.visibleCount = shown.size
    history.dirty.clear()
    history.removed.clear()
    state.renderedHistory = null
    empty.hidden = shown.size > 0
    empty.textContent = '找不到符合搜尋的聊天訊息。'
    count.textContent = `${hits.length} 則符合`
    if (history.follow) {
      list.scrollTop = list.scrollHeight
      state.followScrollTop = list.scrollTop
    } else {
      list.scrollTop = scrollTop
    }
    latest.hidden = history.follow
  }

  let nextReplyDrawerId = 0
  const isCollapsedReply = (record, settings) =>
    Boolean(record?.reply) &&
    !matchesTarget(record, settings) &&
    matchesReplyTarget(record.reply, settings)
  const adjacentDatedRow = (node, delta) => {
    let cur = node ? siblingView(node, delta) : null
    while (cur && !viewDates.has(cur)) cur = siblingView(cur, delta)
    return cur || null
  }
  const setDrawerOpen = (drawer, open) => {
    const next = Boolean(open)
    drawer.open = next
    drawer.toggle.setAttribute('aria-expanded', String(next))
    if (next) {
      drawer.panel.hidden = false
      drawer.panel.removeAttribute('hidden')
    } else {
      drawer.panel.hidden = 'until-found'
      drawer.panel.setAttribute('hidden', 'until-found')
    }
  }
  const resolveReplyThread = (record, history, settings, list) => {
    const parentId = record.reply?.parentId
    if (parentId) {
      const parent = history.ids.get(parentId) || history.byStorageId?.get(parentId)
      const mountedParent = parent?.retained && parent.visible && parent.renderedView &&
        (parent.renderedView.parentElement === list ||
          parent.renderedView.closest?.('.ttc-thread')?.parentElement === list) &&
        matchesTarget(parent, settings)
        ? parent
        : null
      return { key: `id:${parentId}`, parentRecord: mountedParent }
    }
    return { key: `quote:${record.reply.parentUser}\n${record.reply.parentText}`, parentRecord: null }
  }
  const updateDrawerSummary = (state, drawer) => {
    const hasReplies = drawer.replies.size > 0
    const wasHidden = drawer.toggle.hidden
    drawer.toggle.textContent = `${drawer.replies.size} 則回覆`
    drawer.toggle.hidden = !hasReplies
    if (hasReplies) drawer.toggle.removeAttribute('hidden')
    else drawer.toggle.setAttribute('hidden', '')
    if (drawer.group) {
      drawer.orphanRow?.classList?.toggle('ttc-has-replies', hasReplies)
      if (!hasReplies) {
        drawer.open = false
        drawer.toggle.setAttribute('aria-expanded', 'false')
        drawer.panel.hidden = true
        drawer.panel.setAttribute('hidden', '')
      } else if (wasHidden) {
        setDrawerOpen(drawer, state.openReplyThreads?.has(drawer.key))
      }
    }
  }
  const ensureReplyDrawer = (state, key, parentRecord, sampleReply, createdAt, dateKey = '') => {
    state.replyDrawers ||= new Map()
    state.openReplyThreads ||= new Set()
    const existing = state.replyDrawers.get(key)
    if (existing) return existing
    const panelId = `ttc-replies-${++nextReplyDrawerId}`
    const toggle = element('button', {
      type: 'button',
      class: 'ttc-replies-toggle',
      'aria-expanded': 'false',
      'aria-controls': panelId,
    }, ['0 則回覆'])
    const replyList = element('div', { class: 'ttc-replies-list' })
    const panel = element('div', { class: 'ttc-replies', id: panelId, hidden: 'until-found' }, [replyList])
    let head
    let wrapper
    let orphanRow = null
    if (parentRecord) {
      head = element('div', { class: 'ttc-thread-head' }, [toggle])
      wrapper = element('div', { class: 'ttc-thread' }, [head, panel])
      parentRecord.renderedView.replaceWith(wrapper)
      head.insertBefore(parentRecord.renderedView, toggle)
      parentRecord.renderedView.classList.add('ttc-has-replies')
      parentRecord.renderedView.removeAttribute('data-date')
      const parentDateKey = getRecordDateKey(parentRecord, state.history)
      if (parentDateKey) viewDates.set(wrapper, parentDateKey)
      else viewDates.delete(wrapper)
      syncDateMarker(wrapper, adjacentDatedRow(wrapper, -1))
    } else {
      orphanRow = makeOrphanParentView(sampleReply, state.history)
      head = element('div', { class: 'ttc-thread-head ttc-orphan-head' }, [orphanRow, toggle])
      wrapper = element('div', { class: 'ttc-reply-group' }, [head, panel])
      if (dateKey) viewDates.set(wrapper, dateKey)
      else viewDates.delete(wrapper)
      state.list.appendChild(wrapper)
      syncDateMarker(wrapper, adjacentDatedRow(wrapper, -1))
    }
    const drawer = {
      key, wrapper, head, toggle, panel, list: replyList, orphanRow,
      group: parentRecord ? null : wrapper, parentRecord: parentRecord || null,
      open: false, replies: new Set(), anchors: new Set(), lastReply: null,
    }
    rowAnchorKeys.set(wrapper, parentRecord ? `msg:${parentRecord.storageId}` : `drawer:${key}`)
    setDrawerOpen(drawer, state.openReplyThreads.has(key))
    toggle.addEventListener('click', () => {
      const list = state.list
      const canMeasure = typeof list?.getBoundingClientRect === 'function' && typeof head.getBoundingClientRect === 'function'
      const before = canMeasure ? head.getBoundingClientRect().top - list.getBoundingClientRect().top : 0
      const next = !drawer.open
      if (next) state.openReplyThreads.add(key)
      else state.openReplyThreads.delete(key)
      setDrawerOpen(drawer, next)
      if (canMeasure) {
        const delta = head.getBoundingClientRect().top - list.getBoundingClientRect().top - before
        if (Math.abs(delta) > 0.5) list.scrollTop += delta
      }
      if (mounted === state && Number.isFinite(list.scrollHeight) && Number.isFinite(list.clientHeight) && list.clientHeight > 0) {
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
        if (next && !nearBottom) {
          cancelListFollow(state)
          state.history.follow = false
          state.latest.hidden = false
        } else if (!next && nearBottom && state.history.follow) {
          state.followScrollTop = list.scrollTop
        }
      }
    })
    panel.addEventListener('beforematch', () => {
      state.openReplyThreads.add(key)
      setDrawerOpen(drawer, true)
      if (mounted === state) {
        cancelListFollow(state)
        state.history.follow = false
        state.latest.hidden = false
      }
    })
    state.replyDrawers.set(key, drawer)
    return drawer
  }
  const removeDrawer = (state, drawer, unwrapParent = true) => {
    if (drawer.group) {
      const nextDated = adjacentDatedRow(drawer.wrapper, 1)
      drawer.wrapper.remove()
      if (nextDated?.parentElement === state.list) syncDateMarker(nextDated, adjacentDatedRow(nextDated, -1))
    } else {
      const parentView = drawer.parentRecord?.renderedView
      parentView?.classList.remove('ttc-has-replies')
      drawer.parentRecord?.view?.classList.remove('ttc-has-replies')
      if (unwrapParent && parentView && parentView.parentElement === drawer.head && drawer.wrapper.parentElement === state.list) {
        drawer.wrapper.replaceWith(parentView)
        const parentDateKey = getRecordDateKey(drawer.parentRecord, state.history)
        if (parentDateKey) viewDates.set(parentView, parentDateKey)
        else viewDates.delete(parentView)
        syncDateMarker(parentView, adjacentDatedRow(parentView, -1))
        const nextDated = adjacentDatedRow(parentView, 1)
        if (nextDated?.parentElement === state.list) syncDateMarker(nextDated, parentView)
      } else {
        const nextDated = adjacentDatedRow(drawer.wrapper, 1)
        drawer.wrapper.remove()
        if (nextDated?.parentElement === state.list) syncDateMarker(nextDated, adjacentDatedRow(nextDated, -1))
      }
    }
    state.replyDrawers?.delete(drawer.key)
  }
  const detachFromDrawer = (state, record) => {
    if (!record.replyThreadKey) return
    const drawer = state.replyDrawers?.get(record.replyThreadKey)
    record.replyThreadKey = ''
    if (!drawer) return
    drawer.replies.delete(record)
    if (drawer.lastReply === record) {
      drawer.lastReply = null
      for (const item of drawer.replies) {
        if (!drawer.lastReply || compareRecords(item, drawer.lastReply) > 0) drawer.lastReply = item
      }
    }
    if (drawer.replies.size > 0 || drawer.anchors.size > 0) updateDrawerSummary(state, drawer)
    else removeDrawer(state, drawer)
  }
  const detachOrphanAnchor = (state, record) => {
    if (!record.orphanParentKey) return
    const drawer = state.replyDrawers?.get(record.orphanParentKey)
    record.orphanParentKey = ''
    if (!drawer) return
    drawer.anchors.delete(record)
    if (drawer.replies.size === 0 && drawer.anchors.size === 0) removeDrawer(state, drawer)
  }
  const unregisterTargetReplyRef = (state, record) => {
    const prevId = record.targetReplyRefId
    if (!prevId) return
    record.targetReplyRefId = ''
    const refs = state.targetReplyRefs?.get(prevId)
    if (!refs) return
    refs.delete(record)
    if (!refs.size) state.targetReplyRefs.delete(prevId)
  }
  const registerTargetReplyRef = (state, record, parentId) => {
    if (!parentId) { unregisterTargetReplyRef(state, record); return }
    if (record.targetReplyRefId === parentId && state.targetReplyRefs?.get(parentId)?.has(record)) return
    unregisterTargetReplyRef(state, record)
    state.targetReplyRefs ||= new Map()
    let refs = state.targetReplyRefs.get(parentId)
    if (!refs) {
      refs = new Set()
      state.targetReplyRefs.set(parentId, refs)
    }
    refs.add(record)
    record.targetReplyRefId = parentId
  }
  const clearTargetReplyRefs = state => {
    if (!state.targetReplyRefs) return
    for (const refs of state.targetReplyRefs.values()) {
      for (const record of refs) record.targetReplyRefId = ''
    }
    state.targetReplyRefs.clear()
  }
  const clearReplyDrawers = state => {
    for (const drawer of [...(state.replyDrawers?.values() || [])]) {
      for (const record of drawer.replies) record.replyThreadKey = ''
      for (const record of drawer.anchors) record.orphanParentKey = ''
      removeDrawer(state, drawer, false)
    }
    state.replyDrawers?.clear()
    clearTargetReplyRefs(state)
  }
  const collapseReplyDrawers = state => {
    state.openReplyThreads?.clear()
    for (const drawer of state.replyDrawers?.values() || []) {
      if (drawer.replies.size > 0) setDrawerOpen(drawer, false)
    }
  }

  const resolveAnchorNode = (state, key) => {
    if (!key || !state?.list) return null
    if (key.startsWith('msg:')) {
      const record = state.history?.byStorageId?.get(key.slice(4))
      if (!record?.retained || !record.visible || !record.renderedView) return null
      if (record.renderedView.parentElement === state.list) return record.renderedView
      const thread = record.renderedView.closest?.('.ttc-thread')
      return thread?.parentElement === state.list ? thread : null
    }
    if (key.startsWith('drawer:')) {
      const drawer = state.replyDrawers?.get(key.slice(7))
      return drawer?.wrapper?.parentElement === state.list ? drawer.wrapper : null
    }
    return null
  }
  const captureViewportAnchor = state => {
    const list = state?.list
    if (!list || state.panel?.hidden) return null
    const children = list.children
    if (!children.length || typeof list.getBoundingClientRect !== 'function' ||
      typeof children[0]?.getBoundingClientRect !== 'function') {
      return { key: '', offset: 0, top: list.scrollTop }
    }
    const listTop = list.getBoundingClientRect().top
    let low = 0
    let high = children.length
    while (low < high) {
      const mid = (low + high) >> 1
      const child = children[mid]
      if (!child.hidden && child.getBoundingClientRect().bottom > listTop) high = mid
      else low = mid + 1
    }
    let anchor = children[low]
    while (anchor && (anchor.hidden || anchor.getBoundingClientRect().bottom <= listTop)) anchor = children[++low]
    if (!anchor) {
      for (let i = 0; i < children.length; i++) {
        const candidate = children[i]
        if (!candidate.hidden && candidate.getBoundingClientRect().bottom > listTop) { anchor = candidate; break }
      }
    }
    return {
      key: anchor ? rowAnchorKeys.get(anchor) || '' : '',
      offset: anchor ? anchor.getBoundingClientRect().top - listTop : 0,
      top: list.scrollTop,
    }
  }
  const restoreViewportAnchor = (state, anchor) => {
    const list = state?.list
    if (!list || !anchor) return
    const node = anchor.key ? resolveAnchorNode(state, anchor.key) : null
    if (node && typeof list.getBoundingClientRect === 'function' && typeof node.getBoundingClientRect === 'function') {
      const delta = node.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
      if (Math.abs(delta) > 0.5) list.scrollTop += delta
    } else {
      list.scrollTop = anchor.top
    }
  }

  const isOutOfOrder = (state, record) => {
    if (hasVodOffset(record) && Number.isFinite(state.mountedTailOffset)) {
      return record.vodOffset < state.mountedTailOffset ||
        (record.vodOffset === state.mountedTailOffset && Boolean(state.mountedTailOrder && record.order <= state.mountedTailOrder))
    }
    return Boolean(state.mountedTailOrder && record.order <= state.mountedTailOrder)
  }
  const noteMountedTail = (state, record) => {
    if (hasVodOffset(record)) {
      if (!Number.isFinite(state.mountedTailOffset) || record.vodOffset > state.mountedTailOffset) {
        state.mountedTailOffset = record.vodOffset
        state.mountedTailOrder = record.order
      } else if (record.vodOffset === state.mountedTailOffset && (!state.mountedTailOrder || record.order > state.mountedTailOrder)) {
        state.mountedTailOrder = record.order
      }
      return
    }
    if (!state.mountedTailOrder || record.order > state.mountedTailOrder) state.mountedTailOrder = record.order
  }

  const renderMessages = (state, rebuild = false, preservedAnchor = null) => {
    cancelMessageRender(state)
    cancelListFollow(state)
    const { history, list, empty, count, latest } = state
    const query = normalizeSearch(history.search)
    if (query) { renderMessageSearch(state, query); return }
    if (state.inSearchMode) releaseMessageViews(state)
    empty.textContent = '尚無符合條件的發言。新增目標帳號後開始收集。'
    state.replyDrawers ||= new Map()
    state.openReplyThreads ||= new Set()
    state.targetReplyRefs ||= new Map()
    const filterKey = JSON.stringify(history.settings)
    const full = rebuild || state.renderedHistory !== history || state.filterKey !== filterKey
    const anchor = preservedAnchor || (!history.follow ? captureViewportAnchor(state) : null)
    if (full) {
      state.visibleCount = 0
      state.mountedTailOrder = 0
      state.mountedTailOffset = null
      clearReplyDrawers(state)
      if (list.children.length) {
        state.messageResizeObserver?.disconnect()
        list.replaceChildren()
      }
    }
    let needsReorder = false
    for (const record of history.removed) {
      const wasVisible = Boolean(record.renderedView?.parentElement && record.visible)
      const threadId = record.id || record.storageId
      const existingDrawer = !full && threadId ? state.replyDrawers.get(`id:${threadId}`) : null
      if (record.renderedView) state.messageResizeObserver?.unobserve(record.renderedView)
      if (!full && wasVisible) state.visibleCount--
      record.renderedView?.remove()
      if (record.replyThreadKey) detachFromDrawer(state, record)
      else if (threadId && (existingDrawer || state.targetReplyRefs.get(threadId)?.size)) needsReorder = true
      if (record.orphanParentKey) detachOrphanAnchor(state, record)
      unregisterTargetReplyRef(state, record)
      record.renderedView = null
      record.visible = false
      record.replyThreadKey = ''
      record.orphanParentKey = ''
      record.targetReplyRefId = ''
    }
    history.removed.clear()
    if (!full && list.firstChild && viewDates.has(list.firstChild)) syncDateMarker(list.firstChild, null)
    for (const record of full ? history.messages : history.dirty) {
      const oldView = record.renderedView
      const wasVisible = Boolean(oldView?.parentElement && record.visible)
      const show = matchesFilter(record, history.settings)
      state.visibleCount += Number(show) - (full ? 0 : Number(!!wasVisible))
      if (!show) {
        const threadId = record.id || record.storageId
        const existingDrawer = !full && threadId ? state.replyDrawers.get(`id:${threadId}`) : null
        if (oldView) {
          const datedAnchor = oldView.parentElement === list
            ? oldView
            : (existingDrawer && !existingDrawer.group ? existingDrawer.wrapper : null)
          const nextDated = !full && datedAnchor ? adjacentDatedRow(datedAnchor, 1) : null
          state.messageResizeObserver?.unobserve(oldView)
          oldView.remove()
          if (record.replyThreadKey) detachFromDrawer(state, record)
          else if (threadId && (existingDrawer || state.targetReplyRefs.get(threadId)?.size)) needsReorder = true
          if (nextDated?.parentElement === list) syncDateMarker(nextDated, adjacentDatedRow(nextDated, -1))
        }
        if (record.orphanParentKey) detachOrphanAnchor(state, record)
        unregisterTargetReplyRef(state, record)
        record.renderedView = null
        record.visible = false
        record.replyThreadKey = ''
        record.orphanParentKey = ''
        record.targetReplyRefId = ''
        continue
      }
      if (isCollapsedReply(record, history.settings)) {
        const { key, parentRecord } = resolveReplyThread(record, history, history.settings, list)
        if (record.replyThreadKey && record.replyThreadKey !== key) detachFromDrawer(state, record)
        if (!full && record.orphanParentKey) detachOrphanAnchor(state, record)
        unregisterTargetReplyRef(state, record)
        const existed = state.replyDrawers.has(key)
        const drawerDateKey = getRecordDateKey(parentRecord || record, history)
        const drawer = ensureReplyDrawer(state, key, parentRecord, record.reply, record.createdAt, drawerDateKey)
        if (!existed && drawer.group) {
          if (!full && isOutOfOrder(state, record)) needsReorder = true
          noteMountedTail(state, record)
        }
        record.view.hidden = false
        record.view.removeAttribute('data-date')
        if (oldView && oldView !== record.view) {
          state.messageResizeObserver?.unobserve(oldView)
          if (oldView.parentElement === drawer.list) oldView.replaceWith(record.view)
          else oldView.remove()
        }
        if (full || record.view.parentElement !== drawer.list) {
          if (!full && hasVodOffset(record) && drawer.lastReply && compareRecords(record, drawer.lastReply) < 0) {
            needsReorder = true
          }
          drawer.list.appendChild(record.view)
        }
        drawer.replies.add(record)
        if (!drawer.lastReply || compareRecords(record, drawer.lastReply) > 0) drawer.lastReply = record
        updateDrawerSummary(state, drawer)
        record.renderedView = record.view
        record.visible = true
        record.replyThreadKey = key
        state.messageResizeObserver?.observe(record.view)
        continue
      }
      if (!full && record.replyThreadKey) {
        detachFromDrawer(state, record)
        needsReorder = true
      }
      if (record.reply && isReplyToActiveTarget(record.reply, history.settings)) {
        const parentId = record.reply.parentId
        const realParent = parentId ? (history.ids.get(parentId) || history.byStorageId?.get(parentId)) : null
        const hasRealParent = Boolean(realParent?.retained && matchesTarget(realParent, history.settings))
        if (hasRealParent) {
          if (record.orphanParentKey) detachOrphanAnchor(state, record)
          registerTargetReplyRef(state, record, parentId)
        } else {
          unregisterTargetReplyRef(state, record)
          const anchorKey = parentId ? `id:${parentId}` : `quote:${record.reply.parentUser}\n${record.reply.parentText}`
          if (record.orphanParentKey && record.orphanParentKey !== anchorKey) detachOrphanAnchor(state, record)
          const existed = state.replyDrawers.has(anchorKey)
          const anchorDateKey = getRecordDateKey(record, history)
          const anchorDrawer = ensureReplyDrawer(state, anchorKey, null, record.reply, record.createdAt, anchorDateKey)
          if (!full && !existed && isOutOfOrder(state, record)) {
            needsReorder = true
          }
          anchorDrawer.anchors.add(record)
          record.orphanParentKey = anchorKey
          updateDrawerSummary(state, anchorDrawer)
        }
      } else {
        if (record.orphanParentKey) detachOrphanAnchor(state, record)
        unregisterTargetReplyRef(state, record)
      }
      const threadId = record.id || record.storageId
      const existingDrawer = !full && threadId ? state.replyDrawers.get(`id:${threadId}`) : null
      if (existingDrawer && !existingDrawer.group) {
        record.view.hidden = false
        record.view.classList.add('ttc-has-replies')
        record.view.removeAttribute('data-date')
        if (oldView && oldView !== record.view) {
          state.messageResizeObserver?.unobserve(oldView)
          if (oldView.parentElement === existingDrawer.head) oldView.replaceWith(record.view)
          else oldView.remove()
        }
        if (record.view.parentElement !== existingDrawer.head) {
          existingDrawer.head.insertBefore(record.view, existingDrawer.toggle)
        }
        existingDrawer.parentRecord = record
        const drawerDateKey = getRecordDateKey(record, history)
        if (drawerDateKey) viewDates.set(existingDrawer.wrapper, drawerDateKey)
        else viewDates.delete(existingDrawer.wrapper)
        syncDateMarker(existingDrawer.wrapper, adjacentDatedRow(existingDrawer.wrapper, -1))
        record.renderedView = record.view
        record.visible = true
        record.replyThreadKey = ''
        state.messageResizeObserver?.observe(record.view)
        continue
      }
      record.view.hidden = false
      const dateKey = getRecordDateKey(record, history)
      if (dateKey) viewDates.set(record.view, dateKey)
      else viewDates.delete(record.view)
      rowAnchorKeys.set(record.view, `msg:${record.storageId}`)
      if (oldView && oldView !== record.view) {
        state.messageResizeObserver?.unobserve(oldView)
        if (oldView.parentElement === list) oldView.replaceWith(record.view)
        else oldView.remove()
      }
      if (full || record.view.parentElement !== list) {
        if (!full && isOutOfOrder(state, record)) needsReorder = true
        list.appendChild(record.view)
      }
      if (existingDrawer?.group) needsReorder = true
      syncDateMarker(record.view, adjacentDatedRow(record.view, -1))
      if (!full) {
        const nextDated = adjacentDatedRow(record.view, 1)
        if (nextDated?.parentElement === list) syncDateMarker(nextDated, record.view)
      }
      noteMountedTail(state, record)
      record.renderedView = record.view
      record.visible = true
      record.replyThreadKey = ''
      state.messageResizeObserver?.observe(record.view)
    }
    history.dirty.clear()
    state.renderedHistory = history
    state.filterKey = filterKey
    if (needsReorder) { renderMessages(state, true, anchor); return }
    empty.hidden = state.visibleCount > 0
    const countText = `${state.visibleCount} 則`
    if (count.textContent !== countText) count.textContent = countText
    // All row writes finish before the one layout read needed for following.
    if (history.follow) {
      list.scrollTop = list.scrollHeight
      state.followScrollTop = list.scrollTop
      state.locationPinned = false
    } else if (anchor) {
      state.restoringScroll = true
      restoreViewportAnchor(state, anchor)
      state.restoringScroll = false
      state.locationPinned = true
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
    clearReplyDrawers(state)
    for (const record of new Set([...state.history.messages, ...state.history.removed, ...(state.searchShown || [])])) {
      record.renderedView?.remove()
      record.renderedView = null
      record.visible = false
      record.replyThreadKey = ''
      record.orphanParentKey = ''
      record.targetReplyRefId = ''
      record.view?.classList?.remove('ttc-has-replies')
    }
    state.targetReplyRefs?.clear()
    state.inSearchMode = false
    state.searchShown = null
    state.renderedHistory = null
    state.mountedTailOrder = 0
    state.mountedTailOffset = null
    state.history.removed.clear()
  }

  const handleMessageVisibility = () => {
    if (!mounted) return
    if (document.hidden) { cancelMessageRender(mounted); cancelListFollow(mounted) }
    else {
      if (mounted.history.dirty.size || mounted.history.removed.size || mounted.history.search) scheduleMessageRender(mounted)
      scheduleListFollow(mounted)
    }
  }

  let panelFramePending = false
  const TOOLTIP_TEXT = '聊天室篩選'
  const TOOLTIP_GAP = 11
  const TOOLTIP_HOVER_GRACE = 100
  let nextTooltipId = 0
  let openTooltipState = null
  let tooltipDismissBound = false

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const bindTooltipDismiss = () => {
    if (tooltipDismissBound) return
    tooltipDismissBound = true
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && openTooltipState) hideTooltip(openTooltipState)
    })
  }

  const positionTooltip = state => {
    const { button, tooltip } = state
    if (!state.tooltipOpen || typeof button?.getBoundingClientRect !== 'function' ||
      typeof tooltip?.getBoundingClientRect !== 'function') return
    const rect = button.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      hideTooltip(state)
      return
    }
    const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
      ? window.innerWidth : (document.documentElement?.clientWidth || 0)
    const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
      ? window.innerHeight : (document.documentElement?.clientHeight || 0)
    const placeLeft = rect.left >= 140
    if (placeLeft) {
      tooltip.setAttribute('data-placement', 'left')
      tooltip.style.maxWidth = `${Math.max(120, Math.floor(rect.left - TOOLTIP_GAP - 8))}px`
    } else {
      tooltip.setAttribute('data-placement', 'bottom')
      tooltip.style.maxWidth = viewportWidth > 0 ? `${Math.max(120, Math.floor(viewportWidth - 16))}px` : ''
    }
    const tipRect = tooltip.getBoundingClientRect()
    if (placeLeft) {
      const left = Math.max(8, Math.round(rect.left - TOOLTIP_GAP - tipRect.width))
      const rawTop = rect.top + (rect.height - tipRect.height) / 2
      const top = viewportHeight > 0
        ? clamp(Math.round(rawTop), 8, Math.max(8, Math.round(viewportHeight - tipRect.height - 8)))
        : Math.round(rawTop)
      tooltip.style.left = `${left}px`
      tooltip.style.top = `${top}px`
    } else {
      const rawLeft = rect.left + (rect.width - tipRect.width) / 2
      const left = viewportWidth > 0
        ? clamp(Math.round(rawLeft), 8, Math.max(8, Math.round(viewportWidth - tipRect.width - 8)))
        : Math.round(rawLeft)
      tooltip.style.left = `${left}px`
      tooltip.style.top = `${Math.round(rect.bottom + TOOLTIP_GAP)}px`
    }
  }

  const ensureTooltip = state => {
    if (state.tooltip) return state.tooltip
    const tooltip = element('div', {
      id: `ttc-tooltip-${++nextTooltipId}`,
      class: 'ttc-tooltip',
      role: 'tooltip',
      popover: 'hint',
      'data-visible': 'false',
      'data-placement': 'left',
    }, [TOOLTIP_TEXT])
    tooltip.addEventListener('mouseenter', () => {
      clearTimeout(state.tooltipHideTimer)
      state.tooltipHideTimer = 0
    })
    tooltip.addEventListener('mouseleave', () => {
      scheduleHideTooltip(state)
    })
    ;(document.body || document.documentElement).appendChild(tooltip)
    state.tooltip = tooltip
    state.tooltipOpen = false
    state.tooltipLayerOpen = false
    state.tooltipFrame = 0
    state.tooltipHideTimer = 0
    return tooltip
  }

  const hideTooltip = state => {
    clearTimeout(state.tooltipHideTimer)
    state.tooltipHideTimer = 0
    if (state.tooltipFrame) {
      cancelAnimationFrame(state.tooltipFrame)
      state.tooltipFrame = 0
    }
    state.tooltipOpen = false
    if (openTooltipState === state) openTooltipState = null
    if (!state.tooltip) return
    state.tooltip.setAttribute('data-visible', 'false')
    state.tooltip.style.visibility = ''
    if (state.tooltipLayerOpen) {
      try { state.tooltip.hidePopover() } catch (_) {}
      state.tooltipLayerOpen = false
    }
  }

  const scheduleHideTooltip = state => {
    clearTimeout(state.tooltipHideTimer)
    state.tooltipHideTimer = setTimeout(() => {
      state.tooltipHideTimer = 0
      hideTooltip(state)
    }, TOOLTIP_HOVER_GRACE)
  }

  const showTooltip = state => {
    if (state.history.enabled || state.button?.isConnected === false) return
    const tooltip = ensureTooltip(state)
    clearTimeout(state.tooltipHideTimer)
    state.tooltipHideTimer = 0
    if (state.tooltipFrame) cancelAnimationFrame(state.tooltipFrame)
    if (openTooltipState && openTooltipState !== state) hideTooltip(openTooltipState)
    openTooltipState = state
    state.tooltipOpen = true
    bindTooltipDismiss()
    tooltip.textContent = TOOLTIP_TEXT
    tooltip.setAttribute('data-visible', 'true')
    tooltip.style.visibility = 'hidden'
    if (!state.tooltipLayerOpen && typeof tooltip.showPopover === 'function') {
      try { tooltip.showPopover(); state.tooltipLayerOpen = true } catch (_) {}
    }
    state.tooltipFrame = requestAnimationFrame(() => {
      state.tooltipFrame = 0
      if (!state.tooltipOpen || state.history.enabled || state.button?.isConnected === false) return
      positionTooltip(state)
      if (state.tooltipOpen) tooltip.style.visibility = ''
    })
  }

  const positionFilterPanel = state => {
    if (!state.inTopLayer) return
    const streamRect = state.stream?.getBoundingClientRect?.()
    const hostRect = state.host?.getBoundingClientRect?.()
    const rect = streamRect && (streamRect.width > 0 || streamRect.height > 0) ? streamRect : hostRect
    if (!rect) return
    const rectBottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height
    const header = state.header?.getBoundingClientRect?.()
    const input = state.stream && $('.chat-input', state.stream)?.getBoundingClientRect?.()
    const hostBottom = hostRect && hostRect.height > 0
      ? (Number.isFinite(hostRect.bottom) ? hostRect.bottom : hostRect.top + hostRect.height)
      : 0
    const top = header && header.height > 0 ? Math.max(rect.top, header.bottom) : rect.top
    const bottom = input?.height > 0 && input.top >= top
      ? input.top
      : (hostBottom >= top ? Math.min(rectBottom, hostBottom) : rectBottom)
    const width = Math.max(0, rect.width)
    const height = Math.max(0, bottom - top)
    if (width === 0 || height === 0) {
      Object.assign(state.panel.style, {
        position: 'fixed', inset: 'auto', margin: '0',
        left: '0px', top: '0px', width: '0px', height: '0px',
        visibility: 'hidden', pointerEvents: 'none',
      })
      return
    }
    Object.assign(state.panel.style, {
      position: 'fixed', inset: 'auto', margin: '0',
      left: `${rect.left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      visibility: '', pointerEvents: '',
    })
  }
  const schedulePanelPosition = () => {
    if ((!mounted?.inTopLayer && !mounted?.tooltipOpen) || panelFramePending) return
    panelFramePending = true
    requestAnimationFrame(() => {
      panelFramePending = false
      if (!mounted) return
      if (mounted.inTopLayer) positionFilterPanel(mounted)
      if (mounted.tooltipOpen) positionTooltip(mounted)
    })
  }
  const setPanelLayer = (state, enabled) => {
    const { panel } = state
    if (!enabled) {
      if (state.inTopLayer) { try { panel.hidePopover() } catch (_) {} }
      state.inTopLayer = false
      state.layerObserver?.disconnect()
      state.layerObserver = null
      state.layoutObserver?.disconnect()
      state.layoutObserver = null
      if (state.layoutTarget && state.onLayoutTransition) {
        state.layoutTarget.removeEventListener?.('transitionend', state.onLayoutTransition)
      }
      state.layoutTarget = null
      state.onLayoutTransition = null
      panel.removeAttribute('popover')
      for (const name of ['position', 'inset', 'margin', 'left', 'top', 'width', 'height', 'visibility', 'pointerEvents']) panel.style[name] = ''
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
        if (state.stream) state.layerObserver.observe(state.stream)
        if (state.header) state.layerObserver.observe(state.header)
        const input = state.stream && $('.chat-input', state.stream)
        if (input) state.layerObserver.observe(input)
        if (document.documentElement) state.layerObserver.observe(document.documentElement)
      }
      const layoutTarget = state.stream?.closest?.('.right-column') || state.stream
      if (layoutTarget) {
        state.layoutTarget = layoutTarget
        if (typeof MutationObserver === 'function') {
          state.layoutObserver = new MutationObserver(schedulePanelPosition)
          state.layoutObserver.observe(layoutTarget, { attributes: true, attributeFilter: ['class', 'style'] })
        }
        state.onLayoutTransition = event => {
          if (!event || event.target === layoutTarget) schedulePanelPosition()
        }
        layoutTarget.addEventListener?.('transitionend', state.onLayoutTransition)
      }
    }
    positionFilterPanel(state)
  }

  const setEnabled = (state, enabled) => {
    state.messageResizeObserver?.disconnect()
    cancelListFollow(state)
    state.readerScrollIntent = false
    cancelMessageRender(state)
    if (!enabled && !state.panel.hidden) {
      state.savedReaderAnchor = !state.history.follow ? captureViewportAnchor(state) : null
    }
    state.history.enabled = enabled
    state.host.classList.toggle('ttc-active', enabled)
    state.panel.hidden = !enabled
    setPanelLayer(state, enabled)
    state.button.setAttribute('aria-pressed', String(enabled))
    state.button.removeAttribute('title')
    const tooltip = ensureTooltip(state)
    if (enabled) {
      state.button.removeAttribute('aria-describedby')
      hideTooltip(state)
    } else {
      state.button.setAttribute('aria-describedby', tooltip.id)
      collapseReplyDrawers(state)
    }
    if (enabled) {
      if (state.messageSearch) state.messageSearch.value = state.history.search || ''
      const savedAnchor = !state.history.follow ? state.savedReaderAnchor : null
      state.savedReaderAnchor = null
      renderMessages(state, true, savedAnchor)
    }
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

  const renderVodTimeMode = (state) => {
    const { panel, history } = state
    if (!panel || !history) return
    const group = $('.ttc-vod-time-modes', panel)
    if (!group) return
    group.hidden = !history.channel.startsWith('vod:')
    const broadcast = normalizeVodTimeMode(history.settings?.vodTimeMode) === 'broadcast'
    $('.ttc-vod-time-offset', panel)?.setAttribute('aria-pressed', String(!broadcast))
    $('.ttc-vod-time-broadcast', panel)?.setAttribute('aria-pressed', String(broadcast))
  }

  const createPanel = (state) => {
    const panel = element('section', { class: 'ttc-panel', 'aria-label': '指定用戶聊天室' }, [
      element('div', { class: 'ttc-toolbar' }, [
        element('div', { class: 'ttc-options' }, [
          element('button', {
            type: 'button',
            class: 'ttc-target-summary',
            'aria-controls': 'ttc-target-settings',
            'aria-expanded': 'false',
          }, ['目標用戶']),
          element('div', {
            class: 'ttc-vod-time-modes',
            role: 'group',
            'aria-label': 'VOD 時間顯示方式',
            hidden: !state.history.channel.startsWith('vod:'),
          }, [
            element('button', { type: 'button', class: 'ttc-vod-time-offset' }, ['影片時間']),
            element('button', { type: 'button', class: 'ttc-vod-time-broadcast' }, ['直播時刻']),
          ]),
          element('span', { class: 'ttc-count' }),
        ]),
        element('search', { class: 'ttc-message-search' }, [
          element('label', { class: 'ttc-visually-hidden', for: 'ttc-input-search-messages' }, ['搜尋聊天紀錄']),
          element('input', {
            id: 'ttc-input-search-messages',
            type: 'search',
            name: 'search-messages',
            placeholder: '搜尋帳號或留言',
            autocomplete: 'off',
            autocorrect: 'off',
            autocapitalize: 'none',
            spellcheck: 'false',
          }),
        ]),
        element('div', { class: 'ttc-targets', id: 'ttc-target-settings', hidden: '' }, [
          element('div', { class: 'ttc-roles' }, [
            element('span', { class: 'ttc-role' }, [
              element('input', { type: 'checkbox', id: 'ttc-role-broadcaster', name: 'broadcaster' }),
              element('label', { for: 'ttc-role-broadcaster' }, ['Broadcaster']),
            ]),
            element('span', { class: 'ttc-role' }, [
              element('input', { type: 'checkbox', id: 'ttc-role-moderators', name: 'moderators' }),
              element('label', { for: 'ttc-role-moderators' }, ['Moderator']),
            ]),
            element('span', { class: 'ttc-role' }, [
              element('input', { type: 'checkbox', id: 'ttc-role-vip', name: 'vip' }),
              element('label', { for: 'ttc-role-vip' }, ['VIP']),
            ]),
            element('span', { class: 'ttc-role' }, [
              element('input', { type: 'checkbox', id: 'ttc-role-replies', name: 'replies' }),
              element('label', { for: 'ttc-role-replies' }, ['回覆篩選目標']),
            ]),
          ]),
          element('div', { class: 'ttc-target-modes', role: 'group', 'aria-label': '帳號篩選方式' }, [
            element('button', { type: 'button', class: 'ttc-mode-include' }, ['＋ 包含']),
            element('button', { type: 'button', class: 'ttc-mode-exclude' }, ['－ 排除']),
          ]),
          element('form', { class: 'ttc-users' }, [
            element('label', { for: 'ttc-input-users' }, ['新增帳號']),
            element('input', {
              id: 'ttc-input-users',
              type: 'text',
              name: 'users',
              placeholder: '英文帳號',
              autocomplete: 'off',
              autocorrect: 'off',
              autocapitalize: 'none',
              spellcheck: 'false',
            }),
            element('button', { type: 'submit' }, ['新增']),
          ]),
          element('search', { class: 'ttc-target-search' }, [
            element('label', { for: 'ttc-input-search-users' }, ['搜尋帳號']),
            element('input', {
              id: 'ttc-input-search-users',
              type: 'search',
              name: 'search-users',
              placeholder: '搜尋目標帳號',
              autocomplete: 'off',
              autocorrect: 'off',
              autocapitalize: 'none',
              spellcheck: 'false',
            }),
          ]),
          element('ul', { class: 'ttc-target-list', 'aria-label': '目標用戶清單' }),
          element('p', { class: 'ttc-target-empty' }),
          element('p', { class: 'ttc-target-status', role: 'status' }),
        ]),
      ]),
      element('p', { class: 'ttc-history-status' }),
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
    state.messageSearch = $('[name="search-messages"]', panel)
    state.messageSearch.value = state.history.search || ''
    state.messageSearch.addEventListener('input', () => {
      state.history.search = state.messageSearch.value
      state.readerScrollIntent = false
      state.history.follow = true
      if (state.history.enabled) renderMessages(state, true)
    })
    const moderators = $('[name="moderators"]', panel)
    const broadcaster = $('[name="broadcaster"]', panel)
    const vip = $('[name="vip"]', panel)
    const replies = $('[name="replies"]', panel)
    const users = $('[name="users"]', panel)
    moderators.checked = state.history.settings.moderators
    broadcaster.checked = state.history.settings.broadcaster
    vip.checked = state.history.settings.vip
    replies.checked = state.history.settings.replies
    state.status = $('.ttc-target-status', panel)
    state.targetMode = 'include'
    state.updateSettings = (settings, message = '') => {
      state.history.settings = settings
      const saved = saveSettings(state.history)
      for (const item of histories.values()) syncHistoryTimes(item)
      showTargetStatus(state, saved ? message : '此瀏覽器無法儲存設定；設定僅保留至本次頁面結束。')
      renderTargets(state)
      renderVodTimeMode(state)
      if (normalizeVodTimeMode(settings.vodTimeMode) === 'broadcast' &&
        state.history.channel.startsWith('vod:') && !Number.isFinite(state.history.vodStartTime)) {
        ensureVodStartTime(state.history)
      }
      captureTree(state.scroller, state.history)
      if (state.history.enabled) renderMessages(state, true)
    }
    const setVodTimeMode = mode => {
      const nextMode = normalizeVodTimeMode(mode)
      if (normalizeVodTimeMode(state.history.settings.vodTimeMode) === nextMode) return
      state.updateSettings({ ...state.history.settings, vodTimeMode: nextMode })
    }
    $('.ttc-vod-time-offset', panel).addEventListener('click', () => setVodTimeMode('offset'))
    $('.ttc-vod-time-broadcast', panel).addEventListener('click', () => setVodTimeMode('broadcast'))
    const applyRoles = () => state.updateSettings({ ...state.history.settings,
      moderators: moderators.checked, broadcaster: broadcaster.checked, vip: vip.checked, replies: replies.checked })
    for (const input of [moderators, broadcaster, vip, replies]) input.addEventListener('change', applyRoles)
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
      $('.ttc-message-search', panel).hidden = open
    }
    targetButton.addEventListener('click', () => setTargetsOpen(targetSettings.hidden))
    setTargetsOpen(false)
    renderTargets(state)
    renderVodTimeMode(state)
    state.list.addEventListener('scroll', () => {
      if (!state.history.enabled || state.panel.hidden || state.restoringScroll) return
      if (!state.history.follow && state.locationPinned && !state.readerScrollIntent) return
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
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      state.list.addEventListener(type, event => {
        if (type === 'pointerdown' && event?.target?.closest?.('.ttc-replies-toggle, a')) return
        if (type === 'keydown' && event?.key && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        state.readerScrollIntent = true
        state.locationPinned = false
      }, { passive: true })
    }
    state.latest.addEventListener('click', () => {
      state.readerScrollIntent = false
      state.locationPinned = false
      state.savedReaderAnchor = null
      state.history.follow = true
      renderMessages(state)
    })
    state.host.appendChild(panel)
  }

  const unmount = () => {
    if (!mounted) return
    hideTooltip(mounted)
    releaseMessageViews(mounted)
    mounted.openReplyThreads?.clear()
    setPanelLayer(mounted, false)
    clearTimeout(mounted.statusTimer)
    mounted.observer.disconnect()
    mounted.button.remove()
    mounted.tooltip?.remove()
    mounted.panel.remove()
    mounted.header.classList.remove('ttc-vod-header')
    mounted.host.classList.remove('ttc-host', 'ttc-active')
    mounted.scroller.classList.remove('ttc-source')
    clearVodMentionHighlights(mounted.scroller)
    mounted = null
  }

  const refresh = () => {
    const channel = getChannel()
    const header = $('.stream-chat-header, .video-chat__header')
    const stream = header?.closest('.stream-chat, .video-chat')
    const vodWrapper = stream && $('.video-chat__message-list-wrapper', stream)
    const scroller = stream && (
      $('[data-a-target="chat-scroller"]', stream) ||
      (vodWrapper && ($('.scrollable-area', vodWrapper) || vodWrapper))
    )
    const host = scroller && (scroller.parentElement && scroller.parentElement !== stream && !scroller.parentElement.contains?.(header)
      ? scroller.parentElement : scroller)
    if (mounted && (mounted.history.channel !== channel || mounted.header !== header ||
      mounted.scroller !== scroller || !mounted.button.isConnected || !mounted.panel.isConnected)) unmount()
    if (mounted || !channel || !header || !host) return
    const state = { history: getHistory(channel), stream, header, scroller, host }
    state.host.classList.add('ttc-host')
    scroller.classList.add('ttc-source')
    const button = element('button', {
      type: 'button',
      class: 'ttc-toggle',
      'aria-label': '切換指定用戶聊天室',
    }, [
      svgElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgElement('path', { fill: 'currentColor', d: 'M3 3h18v2l-7 8v6l-4 2v-8L3 5V3zm3 2 6 7 6-7H6z' }),
      ]),
    ])
    button.type = 'button'
    state.button = button
    const community = $('[data-test-selector="chat-viewer-list"]', header)
    const actions = community?.parentElement?.parentElement
    if (actions && header.contains(actions)) actions.insertBefore(button, community.parentElement)
    else {
      if (header.matches?.('.video-chat__header')) header.classList.add('ttc-vod-header')
      header.appendChild(button)
    }
    button.addEventListener('click', () => setEnabled(state, !state.history.enabled))
    button.addEventListener('mouseenter', () => showTooltip(state))
    button.addEventListener('mouseleave', () => scheduleHideTooltip(state))
    button.addEventListener('focus', () => showTooltip(state))
    button.addEventListener('blur', () => hideTooltip(state))
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
    for (const history of histories.values()) {
      history.settings = loadSettings(history.channel)
      syncHistoryTimes(history)
    }
    if (!mounted) return
    const { panel, history } = mounted
    $('[name="moderators"]', panel).checked = history.settings.moderators
    $('[name="broadcaster"]', panel).checked = history.settings.broadcaster
    $('[name="vip"]', panel).checked = history.settings.vip
    const repliesInput = $('[name="replies"]', panel)
    if (repliesInput) repliesInput.checked = history.settings.replies
    renderTargets(mounted)
    renderVodTimeMode(mounted)
    if (normalizeVodTimeMode(history.settings.vodTimeMode) === 'broadcast' &&
      history.channel.startsWith('vod:') && !Number.isFinite(history.vodStartTime)) {
      ensureVodStartTime(history)
    }
    captureTree(mounted.scroller, history)
    if (history.enabled) renderMessages(mounted, true)
  }

  let domInitialized = false
  const initDom = () => {
    if (domInitialized || !document.body) return
    domInitialized = true
    const style = document.createElement('style')
    style.textContent = `
      .ttc-toggle { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 32px; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; color: inherit; background: transparent; cursor: pointer; }
      .ttc-vod-header { position: relative; box-sizing: border-box; padding-inline: 48px; }
      .ttc-vod-header > .ttc-toggle { position: absolute; inset-inline-end: 8px; inset-block-start: 50%; transform: translateY(-50%); }
      .ttc-toggle:not(:last-child) { margin-right: 8px; }
      .ttc-toggle:hover { background: var(--color-background-button-text-hover, #ffffff22); }
      .ttc-toggle:active { background: var(--color-background-button-text-active, #ffffff33); }
      .ttc-toggle[aria-pressed="true"] { color: var(--color-text-link, #bf94ff); background: var(--color-background-button-text-hover, #ffffff22); }
      .ttc-toggle:focus-visible, .ttc-panel button:focus-visible, .ttc-panel input:focus-visible { outline: 2px solid #9147ff; outline-offset: -2px; }
      .ttc-visually-hidden:where(:not(:focus-within, :active)) { position: absolute; clip-path: inset(50%); overflow: hidden; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; white-space: nowrap; }
      .ttc-tooltip { position: fixed; inset: auto; z-index: 2147483647; display: none; overflow: visible; box-sizing: border-box; width: max-content; min-height: 27.6px; margin: 0; padding: 4px 8px; border: 0; border-radius: 4px; color: var(--color-text-tooltip, #0e0e10); background: var(--color-background-tooltip, #ffffff); font-family: Inter, "Noto Sans Arabic", Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 19.6px; overflow-wrap: break-word; pointer-events: none; }
      .ttc-tooltip::after { position: absolute; top: 50%; right: -4px; width: 8px; height: 8px; background: inherit; content: ''; transform: translateY(-50%) rotate(45deg); }
      .ttc-tooltip[data-placement="bottom"]::after { top: -4px; right: auto; left: 50%; transform: translateX(-50%) rotate(45deg); }
      .ttc-tooltip[data-visible="true"] { display: inline-block; pointer-events: auto; }
      .ttc-host { position: relative; }
      .ttc-active > .ttc-source, .ttc-active.ttc-source { visibility: hidden; pointer-events: none; }
      .ttc-panel { position: absolute; inset: 0; z-index: 2147483647; visibility: visible; pointer-events: auto; display: flex; flex-direction: column; box-sizing: border-box; min-height: 0; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; color: var(--color-text-base, #efeff1); background: var(--color-background-base, #18181b); font-size: 13px; }
      .ttc-panel [hidden]:not([hidden="until-found" i]), .ttc-panel[hidden] { display: none !important; }
      .ttc-toolbar { flex: 0 0 auto; padding: 10px; border-bottom: 1px solid var(--color-border-base, #ffffff22); }
      .ttc-options { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; font-size: 12px; }
      .ttc-message-search { display: block; margin-top: 8px; }
      .ttc-message-search input[type="search"] { box-sizing: border-box; width: 100%; min-width: 0; height: 30px; padding: 5px 8px; border: 1px solid var(--color-border-base, #ffffff44); border-radius: 4px; color: inherit; background: var(--color-background-input, #ffffff11); font: inherit; }
      .ttc-managing .ttc-message-search { display: none; }
      .ttc-roles { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; flex-shrink: 0; margin-bottom: 12px; }
      .ttc-role { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
      .ttc-role label, .ttc-roles input { cursor: pointer; }
      .ttc-roles input { width: 13px; height: 13px; margin: 0; accent-color: #9147ff; }
      .ttc-roles input:focus-visible { outline-offset: 2px; }
      .ttc-count { margin-left: auto; flex-shrink: 0; white-space: nowrap; color: var(--color-text-alt-2, #adadb8); }
      .ttc-users { display: flex; align-items: center; gap: 6px; }
      .ttc-users label { white-space: nowrap; }
      .ttc-users input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--color-border-base, #ffffff44); border-radius: 4px; color: inherit; background: var(--color-background-input, #ffffff11); font-size: 12px; }
      .ttc-toolbar button, .ttc-latest { padding: 6px 10px; border: 0; border-radius: 4px; color: #fff; background: #9147ff; cursor: pointer; }
      .ttc-users input, .ttc-users button[type="submit"] { box-sizing: border-box; height: 30px; font: inherit; }
      .ttc-users button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0 10px; border: 1px solid transparent; border-radius: 4px; font-weight: 600; line-height: 1; }
      .ttc-empty { padding: 16px 12px; color: var(--color-text-alt-2, #adadb8); }
      .ttc-history-status { margin: 0; padding: 8px 12px; color: var(--color-text-alt-2, #adadb8); font-size: 12px; }
      .ttc-list, .ttc-target-list, .ttc-managing > .ttc-toolbar { --ttc-scrollbar-thumb: rgba(255, 255, 255, 0.45); --ttc-scrollbar-track: transparent; scrollbar-color: var(--ttc-scrollbar-thumb) var(--ttc-scrollbar-track); scrollbar-width: auto; overscroll-behavior: contain; }
      .video-chat .vod-message.ttc-vod-mention-line { background: var(--color-background-button-text-hover, rgba(145, 71, 255, 0.14)); background: color-mix(in srgb, var(--color-text-link, #9147ff) 14%, transparent); box-shadow: inset 3px 0 0 var(--color-text-link, #9147ff); border-radius: 4px; }
      .video-chat .vod-message.ttc-vod-mention-line:hover { background: var(--color-background-button-text-active, rgba(145, 71, 255, 0.22)); background: color-mix(in srgb, var(--color-text-link, #9147ff) 22%, transparent); }
      .video-chat .vod-message.ttc-vod-mention-line .mention-fragment { color: var(--color-text-link, #bf94ff); font-weight: 600; }
      @media (prefers-contrast: more) {
        .ttc-list, .ttc-target-list, .ttc-managing > .ttc-toolbar { --ttc-scrollbar-thumb: #ffffff; --ttc-scrollbar-track: #000000; }
        .ttc-toggle:focus-visible, .ttc-panel button:focus-visible, .ttc-panel input:focus-visible, .ttc-replies-toggle:focus-visible { outline: 2px solid currentColor; }
        .video-chat .vod-message.ttc-vod-mention-line { outline: 1px solid currentColor; outline-offset: -1px; box-shadow: inset 4px 0 0 currentColor; }
      }
      .ttc-list { flex: 1; min-height: 0; overflow: auto; padding: 6px 0; }
      .ttc-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; content-visibility: auto; contain-intrinsic-size: auto none auto 30px; }
      .ttc-message.ttc-has-reply { contain-intrinsic-size: auto none auto 52px; }
      .ttc-thread, .ttc-reply-group { padding: 5px 10px; content-visibility: auto; contain-intrinsic-size: auto none auto 30px; }
      .ttc-thread:hover, .ttc-reply-group:hover { background: var(--color-background-button-text-hover, #ffffff11); }
      .ttc-thread-head { overflow-wrap: anywhere; line-height: 1.6; }
      .ttc-thread-head > .ttc-message { display: inline; padding: 0; content-visibility: visible; contain-intrinsic-size: auto; }
      .ttc-thread-head > .ttc-message:hover { background: transparent; }
      .ttc-thread-head > .ttc-message > :last-child:not(.ttc-reply) { display: inline; }
      .ttc-reply { display: flex; align-items: baseline; gap: 4px; margin-bottom: 2px; padding-left: 6px; border-left: 2px solid var(--color-border-base, #ffffff33); color: var(--color-text-alt-2, #adadb8); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
      .ttc-reply::before { content: '↩'; content: '↩' / ''; flex: 0 0 auto; opacity: 0.85; }
      .ttc-reply-text { flex: 1; min-inline-size: 0; }
      .ttc-reply-author { font-weight: 600; }
      .ttc-reply-deleted { font-style: italic; }
      .ttc-orphan-tag { display: inline-block; margin-right: 6px; padding: 0 4px; border-radius: 3px; color: var(--color-text-alt-2, #adadb8); background: var(--color-background-button-text-hover, #ffffff18); font-size: 10px; line-height: 1.4; vertical-align: baseline; }
      .ttc-replies-toggle { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 1px 5px; border: 0; border-radius: 4px; color: var(--color-text-link, #bf94ff); background: transparent; font: inherit; font-size: 12px; font-weight: 600; line-height: 1.4; white-space: nowrap; vertical-align: baseline; cursor: pointer; user-select: none; }
      .ttc-replies-toggle:hover { background: var(--color-background-button-text-hover, #ffffff18); }
      .ttc-replies-toggle:focus-visible { outline: 2px solid #9147ff; outline-offset: 1px; }
      .ttc-replies-toggle::before { content: '▸'; content: '▸' / ''; display: inline-block; flex-shrink: 0; font-size: 11px; line-height: 1; }
      .ttc-replies-toggle[aria-expanded="true"]::before { transform: rotate(90deg); }
      @media (prefers-reduced-motion: no-preference) {
        .ttc-replies-toggle::before { transition: transform 0.15s ease; }
      }
      .ttc-replies-list { margin: 4px 0 2px 12px; padding-left: 8px; border-left: 2px solid var(--color-border-base, #ffffff33); }
      .ttc-replies-list > .ttc-message { padding: 3px 6px; }
      .ttc-replies-list > .ttc-message.ttc-has-reply { contain-intrinsic-size: auto none auto 30px; }
      .ttc-replies-list > .ttc-message > .ttc-reply { display: none; }
      .ttc-message[data-date]::before, .ttc-thread[data-date]::before, .ttc-reply-group[data-date]::before { content: attr(data-date); display: block; margin: 2px 0 6px; padding: 2px 0 4px; border-bottom: 1px solid var(--color-border-base, #ffffff22); color: var(--color-text-alt-2, #adadb8); font-size: 11px; font-weight: 600; text-align: center; letter-spacing: 0.04em; }
      .ttc-message:hover { background: var(--color-background-button-text-hover, #ffffff11); }
      .ttc-time { margin-right: 6px; color: var(--color-text-alt-2, #adadb8); font-size: 10px; }
      .ttc-message > img { width: 18px; height: 18px; margin-right: 3px; vertical-align: middle; }
      .ttc-message .chat-image { max-height: 28px; vertical-align: middle; }
      .ttc-latest { position: absolute; bottom: 8px; align-self: center; }
      .ttc-managing > .ttc-toolbar { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
      .ttc-managing > .ttc-empty, .ttc-managing > .ttc-list, .ttc-managing > .ttc-latest { display: none !important; }
      .ttc-options { flex-shrink: 0; }
      .ttc-panel .ttc-target-summary { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 0; color: var(--color-text-link, #bf94ff); background: transparent; white-space: nowrap; font: inherit; cursor: pointer; }
      .ttc-target-summary::before { content: '▸'; content: '▸' / ''; }
      .ttc-target-summary[aria-expanded="true"]::before { content: '▾'; content: '▾' / ''; }
      .ttc-targets { margin-top: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .ttc-targets > :not(.ttc-target-list) { flex-shrink: 0; }
      .ttc-target-modes { display: flex; gap: 6px; margin-bottom: 8px; }
      .ttc-target-modes button { flex: 1; padding: 4px 8px; color: inherit; background: var(--color-background-button-text-hover, #ffffff22); font-size: 12px; }
      .ttc-target-modes button[aria-pressed="true"] { color: #fff; background: #9147ff; }
      .ttc-vod-time-modes { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
      .ttc-vod-time-modes button { padding: 2px 6px; color: inherit; background: var(--color-background-button-text-hover, #ffffff22); font-size: 11px; line-height: 1.4; white-space: nowrap; }
      .ttc-vod-time-modes button[aria-pressed="true"] { color: #fff; background: #9147ff; }
      .ttc-target-search { display: flex; align-items: center; gap: 6px; margin-top: 8px; white-space: nowrap; }
      .ttc-target-search input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--color-border-base, #ffffff44); border-radius: 4px; color: inherit; background: var(--color-background-input, #ffffff11); font-size: 12px; }
      .ttc-target-list { list-style: none; padding: 0; margin: 6px 0 0; flex: 1; min-height: 40px; overflow-y: auto; }
      .ttc-target-list li { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 0; }
      .ttc-target-list span { overflow-wrap: anywhere; }
      .ttc-target-list button { flex-shrink: 0; padding: 3px 8px; background: var(--color-background-button-text-hover, #ffffff22); color: inherit; font-size: 11px; }
      .ttc-target-empty, .ttc-target-status { margin: 6px 0 0; font-size: 11px; color: var(--color-text-alt-2, #adadb8); }
      .ttc-target-status:empty { display: none; }
      .right-column--below .chat-room__content > :has(~ [class*="chat-list--"]),
      .right-column--below .chat-room__notifications,
      .right-column--below .chat-room__overlay,
      .right-column--below :is(.chat-input__buttons-container, [data-test-selector="chat-input-buttons-container"]) { display: none !important; }
      .right-column--below .chat-scrollable-area__message-container { padding-top: 0 !important; }
    `
    ;(document.head || document.documentElement).appendChild(style)
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY || event.key === null) syncSettings()
    })
    window.addEventListener('resize', schedulePanelPosition)
    window.addEventListener('scroll', schedulePanelPosition, true)
    document.addEventListener('fullscreenchange', schedulePanelPosition)
    const observer = new MutationObserver(mutations => {
      if (mounted?.button.isConnected && mounted.panel.isConnected &&
        mounted.scroller.isConnected && getChannel() === mounted.history.channel) return
      if (mutations.some(mutation => {
        const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement
        return !element?.closest('.ttc-panel, .ttc-toggle, .ttc-tooltip, [data-a-target="chat-scroller"], .video-chat__message-list-wrapper')
      })) scheduleRefresh()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('popstate', scheduleRefresh)
    document.addEventListener('visibilitychange', () => {
      handleMessageVisibility()
      if (!document.hidden) pruneHistories()
    })
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
  }

  if (document.readyState === 'loading' || !document.body) {
    document.addEventListener?.('DOMContentLoaded', initDom, { once: true })
    window.addEventListener?.('load', initDom, { once: true })
  } else {
    initDom()
  }
})()
