// ==UserScript==
// @name        YouTube Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.3.5
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js
// @description Adds live chat include/exclude account filters and session history, hides the chat mode menu, improves emoji copying and auto-follow, and adds reload.
// @author      Derek
// @match       *://www.youtube.com/live_chat*
// @match       *://www.youtube.com/live_chat_replay*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(() => {
  'use strict'

  const $ = (selector) => document.querySelector(selector)
  const addStyle = (css) => {
    const styleElement = document.createElement('style')
    styleElement.textContent = css
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  const SVG_NS = 'http://www.w3.org/2000/svg'
  // Prefixed to avoid colliding with any id YouTube may introduce.
  const RELOAD_BUTTON_ID = 'yt-chat-tweaks-reload-button'
  const RELOAD_ICON_PATH =
    'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'
  const EMOJI_SELECTOR =
    'img.emoji[shared-tooltip-text][alt]:not([data-copy-processed])'
  const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])
  const SELECTORS = {
    closeButton: '#close-button',
    contextMenu: '#live-chat-header-context-menu',
    items: '#items',
    scroller: '#item-scroller',
    showMore: '#show-more',
  }

  let contextMenu
  let closeButton
  let headerButtonsObserver
  let headerButtonsParent
  let itemsObserver
  let showMoreObserver
  let autoFollowController

  let scroller
  let items
  let showMoreButton

  let followLatest = true
  let pointerScrolling = false
  let pointerCancelTimer = 0
  let scrollFramePending = false

  addStyle(`
    :root {
      --chat-inline-padding: 1em;
      --chat-message-padding-block: 4px;
      --chat-emoji-picker-height: 130px;
    }

    yt-live-chat-app {
      min-width: 100% !important;
      min-height: 100% !important;
    }

    ytd-engagement-panel-section-list-renderer.yt-live-chat-app {
      max-width: 100% !important;
      min-width: 100% !important;
    }

    #panel-pages #pickers #search-panel, /* 貼圖搜尋 */
    #panel-pages #pickers #category-buttons, /* 類別選擇 */
    #categories > yt-emoji-picker-category-renderer:nth-child(n + 2), /* 貼圖類別 */
    #picker-buttons > yt-reaction-control-panel-overlay-view-model, /* 右下愛心 */
    #ticker #container > #left-arrow-container, /* SC列左箭頭 */
    #ticker #container > #right-arrow-container, /* SC列右箭頭 */
    #message #lower-buy-button, /* 購買SC */
    #message #footer-button, /* 購買會員 */
    #message #opt-in-prompt /* 購買贈禮 */ {
      display: none !important;
    }

    #ticker #container > #ticker-bar /* SC列 */ {
      padding: 2px var(--chat-inline-padding) 12px !important;
      overflow-x: auto !important;
    }

    #items > yt-live-chat-text-message-renderer, /* 一般訊息 */
    #items > ytd-sponsorships-live-chat-gift-redemption-announcement-renderer /* 贈禮公告 */ {
      padding: var(--chat-message-padding-block) var(--chat-inline-padding) !important;
    }

    #items > yt-live-chat-text-message-renderer > #author-photo,
    #items > ytd-sponsorships-live-chat-gift-redemption-announcement-renderer > #author-photo {
      margin: 0 var(--chat-inline-padding) 0 0 !important;
    }

    #pickers > #emoji {
      max-height: var(--chat-emoji-picker-height) !important;
      margin: 0 -24px !important;
    }

    #categories yt-emoji-picker-category-renderer {
      margin-right: var(--yt-emoji-picker-category-margin-left) !important;
    }

    #yt-chat-tweaks-reload-button {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      width: 40px !important;
      height: 40px !important;
      min-width: 40px !important;
      min-height: 40px !important;
      margin: 0 !important;
      padding: 8px !important;
      border: none !important;
      border-radius: 50% !important;
      background: transparent !important;
      cursor: pointer !important;
      flex: none !important;
    }

    #yt-chat-tweaks-filter-button:hover,
    #yt-chat-tweaks-reload-button:hover {
      background-color: var(--yt-live-chat-button-default-background-color, #8882) !important;
    }

    #yt-chat-tweaks-filter-button:active,
    #yt-chat-tweaks-reload-button:active {
      background-color: var(--yt-live-chat-button-default-background-color, #8884) !important;
    }

    #yt-chat-tweaks-reload-button svg {
      fill: currentColor !important;
    }
  `)

  const NATIVE_MESSAGE_SELECTOR = [
    'yt-live-chat-text-message-renderer', 'yt-live-chat-paid-message-renderer',
    'yt-live-chat-paid-sticker-renderer', 'yt-live-chat-membership-item-renderer',
    'yt-live-chat-sponsorships-gift-purchase-announcement-renderer',
  ].join(', ')

  const guardMessageMenu = event => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
    const line = target?.closest(NATIVE_MESSAGE_SELECTOR)
    if (!line || line.querySelector('#menu')?.contains(target)) return
    // Stop YouTube's whole-message menu handler, keeping selection and the
    // browser's default link navigation available (no preventDefault).
    event.stopPropagation()
  }
  document.addEventListener('click', guardMessageMenu, true)

  const getOpenChatMenu = () => [...document.querySelectorAll('tp-yt-iron-dropdown')]
    .find(menu => !menu.id && menu.parentElement?.matches('yt-live-chat-app') &&
      !menu.hidden && menu.getAttribute('aria-hidden') !== 'true' && menu.getClientRects().length > 0)

  const guardMenuDismissal = event => {
    const menu = getOpenChatMenu()
    if (!menu || menu.contains(event.target)) return
    // Keep the popup open through pointerdown/mousedown so the final click
    // can dismiss it without reaching or focusing the control underneath.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type === 'click') {
      if (typeof menu.close === 'function') menu.close()
      else document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true,
      }))
    }
  }
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    window.addEventListener(type, guardMenuDismissal, true)
  }
  // An embedded chat also dismisses before a click reaches the watch page.
  try {
    const parentWindow = window.parent
    if (parentWindow && parentWindow !== window && parentWindow.document) {
      const bindParent = attach => {
        for (const type of ['pointerdown', 'mousedown', 'click']) {
          parentWindow[attach ? 'addEventListener' : 'removeEventListener'](type, guardMenuDismissal, true)
        }
      }
      bindParent(true)
      window.addEventListener('pagehide', () => bindParent(false))
      window.addEventListener('pageshow', () => bindParent(true))
    }
  } catch (_) {} // Cross-origin embeds keep the guards inside the chat.

  addStyle(`
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}):has(> #menu) {
      position: relative !important;
      line-height: 1.5;
      padding-inline-end: calc(var(--chat-inline-padding) + 32px) !important;
    }
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) > #content {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) > #menu {
      inset-inline-end: var(--chat-inline-padding) !important;
      top: var(--chat-message-padding-block) !important;
      width: 32px;
      height: 1.5em;
      display: flex !important;
      align-items: center;
      transform: none !important;
      transition: none !important;
      visibility: visible !important;
      opacity: 0 !important;
      pointer-events: none;
    }
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}):is(:hover, :focus-within) > #menu {
      opacity: 1 !important;
      pointer-events: auto;
    }
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) > #menu #menu-button {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 32px;
      box-sizing: border-box;
      width: 32px;
      height: 32px;
      padding: 4px;
    }
    @media (hover: none) {
      #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) > #menu { opacity: 1 !important; pointer-events: auto; }
    }
  `)

  const debounce = (func, delay) => {
    let timeout
    return (...args) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => func(...args), delay)
    }
  }

  const createReloadIcon = () => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('xmlns', SVG_NS)
    svg.setAttribute('height', '24')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '24')
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('aria-hidden', 'true')
    svg.style.pointerEvents = 'none'
    svg.style.display = 'block'
    svg.style.width = '24px'
    svg.style.height = '24px'

    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', RELOAD_ICON_PATH)

    svg.appendChild(path)
    return svg
  }

  const syncReloadButtonColor = () => {
    const reloadButton = $(`#${RELOAD_BUTTON_ID}`)
    const nativeButton = closeButton?.querySelector('button')

    if (!reloadButton || !nativeButton) return

    reloadButton.style.color = getComputedStyle(nativeButton).color
  }

  const addReloadButton = () => {
    if ($(`#${RELOAD_BUTTON_ID}`) || !contextMenu) return

    const reloadButton = document.createElement('button')
    reloadButton.id = RELOAD_BUTTON_ID
    reloadButton.type = 'button'
    reloadButton.setAttribute('aria-label', '重新載入聊天室')
    reloadButton.appendChild(createReloadIcon())

    reloadButton.addEventListener('click', () => {
      location.reload()
    })

    const filterButton = $('#yt-chat-tweaks-filter-button')
    const anchor = filterButton?.parentElement === contextMenu.parentElement ? filterButton : contextMenu
    anchor.insertAdjacentElement('afterend', reloadButton)
    syncReloadButtonColor()
  }

  const collectHeaderElements = () => {
    contextMenu = $(SELECTORS.contextMenu)
    closeButton = $(SELECTORS.closeButton)

    return Boolean(contextMenu && closeButton)
  }

  const observeHeaderButtons = () => {
    const parent = contextMenu?.parentElement
    if (!parent) return

    headerButtonsObserver?.disconnect()
    headerButtonsParent = parent

    headerButtonsObserver = new MutationObserver(() => {
      collectHeaderElements()
      addReloadButton()
      syncReloadButtonColor()
    })

    headerButtonsObserver.observe(parent, {
      childList: true,
    })
  }

  const refreshHeader = () => {
    if (!collectHeaderElements()) return
    addReloadButton()
    if (contextMenu.parentElement !== headerButtonsParent) observeHeaderButtons()
  }

  const copyEmoji = () => {
    const handleSelectionChange = debounce(() => {
      const selection = window.getSelection()
      if (!selection || !selection.rangeCount || selection.isCollapsed) return

      const range = selection.getRangeAt(0)

      // Scope the scan to the selection's common ancestor instead of the
      // whole chat DOM: selecting one message only touches its own nodes.
      let root = range.commonAncestorContainer
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement
      if (!root) return

      // Walk the real nodes intersecting the selection instead of looking
      // clones up by id: emoji ids repeat across messages and getElementById
      // only ever returns the first occurrence.
      for (const img of root.querySelectorAll(EMOJI_SELECTOR)) {
        if (!range.intersectsNode(img)) continue

        const alt = img.alt
        const sharedTooltipText = img.getAttribute('shared-tooltip-text')

        if (!alt || !sharedTooltipText || alt === sharedTooltipText) continue

        img.setAttribute('data-copy-processed', 'true')

        if (sharedTooltipText.includes(alt)) {
          img.setAttribute('alt', sharedTooltipText)
        }
      }
    }, 100)

    document.addEventListener('selectionchange', handleSelectionChange)
  }

  const isEditableTarget = (target) =>
    target instanceof HTMLElement &&
    (
      target.isContentEditable ||
      target.matches('input, textarea, [role="textbox"]')
    )

  const isNearBottom = (element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= 4

  const isShowMoreVisible = () => {
    // Cheap attribute check first; getComputedStyle only when still needed.
    if (!showMoreButton || showMoreButton.hasAttribute('disabled')) return false

    const style = getComputedStyle(showMoreButton)

    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  const clickShowMore = () => {
    if (!showMoreButton || !isShowMoreVisible()) return

    const clickable = showMoreButton.querySelector('button') || showMoreButton
    clickable.click()
  }

  const scrollToBottom = () => {
    // One scrollTop write per frame: busy chats deliver several mutation
    // batches between frames, and each used to queue its own rAF.
    if (!scroller || scrollFramePending) return

    scrollFramePending = true
    const targetScroller = scroller

    requestAnimationFrame(() => {
      scrollFramePending = false

      if (followLatest && scroller === targetScroller) {
        targetScroller.scrollTop = targetScroller.scrollHeight
      }
    })
  }

  const keepFollowingLatest = () => {
    if (!followLatest) return

    clickShowMore()
    scrollToBottom()
  }

  // Window/document-level handlers live outside bindAutoFollow so rebinding
  // never stacks duplicates of them.
  const handlePointerUp = () => {
    if (!pointerScrolling) return

    if (scroller) followLatest = isNearBottom(scroller)
    pointerScrolling = false
    clearTimeout(pointerCancelTimer)
    pointerCancelTimer = 0
  }

  const handlePointerCancel = (event) => {
    clearTimeout(pointerCancelTimer)
    if (event.pointerType === 'touch' && pointerScrolling) {
      // Native touch panning cancels the pointer before it fires scroll.
      pointerCancelTimer = setTimeout(() => {
        pointerScrolling = false
        pointerCancelTimer = 0
      }, 1000)
    } else {
      pointerScrolling = false
      pointerCancelTimer = 0
    }
  }

  const handleScrollKeys = (event) => {
    if (isEditableTarget(event.target) || event.target?.closest?.('.ytcf-panel')) return

    if (SCROLL_UP_KEYS.has(event.key)) {
      followLatest = false
    }
  }

  const bindAutoFollow = () => {
    scroller = $(SELECTORS.scroller)
    items = $(SELECTORS.items)
    showMoreButton = $(SELECTORS.showMore)

    if (!scroller || !items || !showMoreButton) return false

    autoFollowController?.abort()
    autoFollowController = new AbortController()
    const { signal } = autoFollowController
    pointerScrolling = false
    clearTimeout(pointerCancelTimer)
    pointerCancelTimer = 0

    scroller.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaY < 0) {
          followLatest = false
        }
      },
      { passive: true, signal }
    )

    scroller.addEventListener('pointerdown', () => {
      pointerScrolling = true
    }, { signal })

    scroller.addEventListener('scroll', (event) => {
      if (isNearBottom(event.currentTarget)) {
        followLatest = true
      } else if (pointerScrolling) {
        followLatest = false
        if (pointerCancelTimer) {
          clearTimeout(pointerCancelTimer)
          pointerCancelTimer = 0
          pointerScrolling = false
        }
      }
    }, { signal })

    showMoreButton.addEventListener(
      'click',
      () => {
        followLatest = true
      },
      { capture: true, signal }
    )

    itemsObserver?.disconnect()
    itemsObserver = new MutationObserver(() => {
      keepFollowingLatest()
    })

    itemsObserver.observe(items, {
      childList: true,
    })

    showMoreObserver?.disconnect()
    showMoreObserver = new MutationObserver(() => {
      keepFollowingLatest()
    })

    showMoreObserver.observe(showMoreButton, {
      attributes: true,
      attributeFilter: ['disabled', 'style', 'class', 'hidden'],
    })

    keepFollowingLatest()

    return true
  }

  const setupAutoFollow = () => {
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    document.addEventListener('keydown', handleScrollKeys)

    refreshHeader()
    bindAutoFollow()

    // YouTube can replace the chat internals wholesale (e.g. switching
    // Top chat / Live chat), which strands listeners and observers on dead
    // nodes. A 1s poll checks node identity and late header insertion without
    // a subtree observer serviced on every chat message.
    setInterval(() => {
      refreshHeader()
      if (
        scroller?.isConnected &&
        items?.isConnected &&
        showMoreButton?.isConnected
      ) {
        return
      }

      bindAutoFollow()
    }, 1000)
  }

  // YouTube chat filtering.
  (() => {
    'use strict'

    const MESSAGE_SELECTOR = NATIVE_MESSAGE_SELECTOR
    const STORAGE_KEY = 'youtube-live-chat-tweaks-settings-v1'
    const MAX_MESSAGES = 2000
    const MAX_CHANNELS = 5
    const STREAMS_KEY = 'youtube-live-chat-tweaks-streams-v1'
    const histories = new Map()
    let unresolvedScope = ''
    let mounted = null
    let refreshTimer = 0

    const $ = (selector, root = document) => root.querySelector(selector)
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
    // YouTube enforces Trusted Types. Build UI without HTML string sinks.
    const element = (tag, attributes = {}, children = []) => {
      const node = document.createElement(tag)
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
      for (const child of children) node.appendChild(typeof child === 'string'
        ? document.createTextNode(child) : child)
      return node
    }
    const normalizeAccount = (input) => {
      const raw = String(input || '').trim().normalize('NFC')
      if (/^UC[\w-]{22}$/.test(raw)) return raw
      if (/^https?:\/\//i.test(raw)) {
        try {
          const url = new URL(raw)
          const id = url.pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/)?.[1]
          return /^(www\.)?youtube\.com$/i.test(url.hostname) && id ? id : ''
        } catch (_) { return '' }
      }
      const handle = raw.replace(/^@/, '').toLowerCase()
      return /^[^\s@/\\,，;；?#&]{1,100}$/u.test(handle) ? `@${handle}` : ''
    }
    const normalizeUsers = value => [...new Set(String(value || '').split(/[\s,，;；]+/)
      .map(normalizeAccount).filter(Boolean))]

    const readStorageObject = key => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || '{}')
        return value && typeof value === 'object' && !Array.isArray(value)
          ? Object.assign(Object.create(null), value) : Object.create(null)
      } catch (_) { return Object.create(null) }
    }
    const readSavedSettings = () => readStorageObject(STORAGE_KEY)

    const scopeFromOwner = root => {
      const link = root?.querySelector('#owner a[href^="/@"], #owner a[href^="/channel/"]')
      if (!link) return ''
      try {
        const path = new URL(link.getAttribute('href'), location.origin).pathname
        if (path.startsWith('/@')) {
          const account = normalizeAccount(decodeURIComponent(path.slice(1).split('/')[0]))
          return account ? `channel:${account}` : ''
        }
        const id = path.match(/^\/channel\/(UC[\w-]+)$/)?.[1]
        return id ? `channel:${id}` : ''
      } catch (_) { return '' }
    }

    const getChannel = () => {
      let parentDocument
      let parentUrl
      try {
        if (window.parent && window.parent !== window) {
          parentDocument = window.parent.document
          parentUrl = new URL(window.parent.location.href)
        }
      } catch (_) {}
      const url = new URL(location.href)
      let referrer
      try { referrer = new URL(document.referrer) } catch (_) {}
      const video = url.searchParams.get('v') || parentUrl?.searchParams.get('v') || referrer?.searchParams.get('v') || ''
      const token = url.searchParams.get('continuation') || url.pathname
      let hash = 2166136261
      for (const char of token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
      unresolvedScope = video ? `video:${video}` : `chat:${hash.toString(16)}`
      const aliases = readStorageObject(STREAMS_KEY)
      const owner = scopeFromOwner(parentDocument) || scopeFromOwner(document)
      if (owner) {
        if (video && aliases[video] !== owner) {
          aliases[video] = owner
          const keys = Object.keys(aliases)
          for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete aliases[key]
          try { localStorage.setItem(STREAMS_KEY, JSON.stringify(aliases)) } catch (_) {}
        }
        return owner
      }
      if (video && typeof aliases[video] === 'string') return aliases[video]
      const ownerName = $('[author-type="owner"] #author-name')?.textContent
      const ownerAccount = normalizeAccount(ownerName)
      if (ownerAccount) return `channel:${ownerAccount}`
      // Standalone chats without a readable owner/referrer keep their own settings.
      return unresolvedScope
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
      const user = normalizeAccount(input)
      if (!user) return null
      const key = exclude ? 'excludedUsers' : 'users'
      const users = settings[key] || []
      return { ...settings, [key]: remove
        ? users.filter(name => name !== user)
        : [...new Set([...users, user])] }
    }

    const getHistory = (channel) => {
      let history = histories.get(channel)
      const pending = channel.startsWith('channel:') ? histories.get(unresolvedScope) : null
      if (pending && !history) {
        history = pending
        histories.delete(unresolvedScope)
        const saved = readSavedSettings()
        history.channel = channel
        if (saved[channel]) history.settings = loadSettings(channel)
        else if (saved[unresolvedScope]) saveSettings(history)
      } else if (pending && pending !== history) {
        for (const record of pending.messages) {
          if (record.id && history.ids.has(record.id)) continue
          history.messages.push(record)
          if (record.id) history.ids.set(record.id, record)
        }
        while (history.messages.length > MAX_MESSAGES) {
          const oldest = history.messages.shift()
          if (oldest.id) history.ids.delete(oldest.id)
          oldest.view.remove()
        }
        histories.delete(unresolvedScope)
      }
      if (!history) {
        history = {
          channel, settings: loadSettings(channel), messages: [], nodes: new WeakMap(), ids: new Map(),
          enabled: false, follow: true,
        }
      }
      histories.delete(channel)
      histories.set(channel, history)
      if (histories.size > MAX_CHANNELS) histories.delete(histories.keys().next().value)
      return history
    }

    const readMessage = (line) => {
      const author = $('#author-name', line)
      const user = normalizeAccount(author?.textContent)
      // The renderer retains the sender's stable ID even when its DOM shows a handle.
      const rawId = line.data?.authorExternalChannelId || line.getAttribute('author-external-channel-id')
      const channelId = typeof rawId === 'string' && /^UC[\w-]{22}$/.test(rawId) ? rawId : ''
      let message = $('#message, #sticker, #header-subtext', line)
      if (!author || !user || !message) return null
      const chip = author.closest('yt-live-chat-author-chip') || line
      const badges = $$('yt-live-chat-author-badge-renderer', chip)
      const type = line.getAttribute('author-type') || author.getAttribute('type') || ''
      const classes = (author.getAttribute('class') || '').split(/\s+/)
      const moderator = type === 'moderator' || classes.includes('moderator') || badges.some(b => b.getAttribute('type') === 'moderator')
      const broadcaster = type === 'owner' || classes.includes('owner') || badges.some(b => b.getAttribute('type') === 'owner')
      const deleted = line.hasAttribute('is-deleted')
      if (deleted) {
        message = document.createElement('span')
        message.textContent = $('#deleted-state', line)?.textContent?.trim() || '訊息已刪除'
      }
      return { user, channelId, moderator, broadcaster, author, body: message, badges, deleted,
        id: line.id || '', time: $('#timestamp', line)?.textContent?.trim() || '' }
    }

    const includesAuthor = (users, message) => users.includes(message.user) ||
      (!!message.channelId && users.includes(message.channelId))

    const matchesFilter = (message, settings) =>
      !includesAuthor(settings.excludedUsers || [], message) && (
        (settings.moderators && message.moderator) ||
        (settings.broadcaster && message.broadcaster) || includesAuthor(settings.users, message)
      )

    const clonePresentation = source => {
      const copy = source.cloneNode(true)
      for (const node of [copy, ...$$('*', copy)]) {
        for (const attr of [...node.attributes]) {
          if (['id', 'tabindex', 'role'].includes(attr.name) || attr.name.startsWith('on') || attr.name.startsWith('data-')) node.removeAttribute(attr.name)
        }
      }
      for (const link of $$('a', copy)) {
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
      }
      return copy
    }

    const makeMessageView = message => {
      const row = document.createElement('div')
      row.className = 'ytcf-message'
      const time = document.createElement('time')
      time.className = 'ytcf-time'
      time.textContent = message.time || new Date().toLocaleTimeString('zh-TW', { hour12: false })
      row.appendChild(time)
      for (const badge of message.badges) {
        const copy = document.createElement('span')
        copy.className = 'ytcf-badge'
        copy.title = badge.getAttribute('aria-label') || badge.getAttribute('shared-tooltip-text') || ''
        const visual = $('img, svg', badge)
        if (visual) copy.appendChild(clonePresentation(visual))
        else copy.textContent = badge.getAttribute('type') === 'moderator' ? '🔧' : badge.getAttribute('type') === 'owner' ? '👑' : '★'
        row.appendChild(copy)
      }
      const author = document.createElement('strong')
      author.textContent = message.author.textContent
      author.style.color = getComputedStyle(message.author).color
      author.title = message.channelId || message.user
      row.appendChild(author)
      row.appendChild(document.createTextNode(': '))
      const content = clonePresentation(message.body)
      content.className = `${content.className || ''} ytcf-body`
      row.appendChild(content)
      return row
    }

    const captureLine = (line, history) => {
      const message = readMessage(line)
      if (!message || (!message.moderator && !message.broadcaster && !includesAuthor(history.settings.users, message))) return false
      const fingerprint = `${message.user}\n${message.channelId}\n${message.deleted}\n${message.body.innerHTML}`
      const previous = message.id ? history.ids.get(message.id) : history.nodes.get(line)
      if (previous?.fingerprint === fingerprint) {
        history.nodes.set(line, previous)
        return false
      }
      const view = makeMessageView(message)
      let record
      if (previous && history.messages.includes(previous)) {
        view.firstChild.textContent = previous.view.firstChild.textContent
        previous.view.replaceWith(view)
        record = Object.assign(previous, { user: message.user, channelId: message.channelId, moderator: message.moderator,
          broadcaster: message.broadcaster, view, fingerprint })
      } else {
        record = { id: message.id, user: message.user, channelId: message.channelId, moderator: message.moderator,
          broadcaster: message.broadcaster, view, fingerprint }
        history.messages.push(record)
        if (history.messages.length > MAX_MESSAGES) {
          const oldest = history.messages.shift()
          if (oldest.id && history.ids.get(oldest.id) === oldest) history.ids.delete(oldest.id)
          oldest.view.remove()
        }
      }
      history.nodes.set(line, record)
      if (message.id) history.ids.set(message.id, record)
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

    const setNativeChatAccessible = (state, enabled) => {
      // Keep the native viewport laid out and visible under the overlay so
      // YouTube can keep fetching/virtualizing messages while filtering.
      state.scroller.inert = enabled || state.sourceInert
      if (enabled) state.scroller.setAttribute('aria-hidden', 'true')
      else if (state.sourceAriaHidden === null) state.scroller.removeAttribute('aria-hidden')
      else state.scroller.setAttribute('aria-hidden', state.sourceAriaHidden)
    }

    const setEnabled = (state, enabled) => {
      state.history.enabled = enabled
      state.host.classList.toggle('ytcf-active', enabled)
      setNativeChatAccessible(state, enabled)
      if (enabled) {
        // The overlay manages its own reader position; keep the underlying
        // chat at the live edge so incoming target messages keep arriving.
        followLatest = true
        keepFollowingLatest()
      }
      state.panel.hidden = !enabled
      state.button.setAttribute('aria-pressed', String(enabled))
      if (enabled) renderMessages(state)
    }

    const showTargetStatus = (state, message = '') => {
      clearTimeout(state.statusTimer)
      state.status.textContent = message
      state.statusTimer = message ? setTimeout(() => {
        state.status.textContent = ''
        state.statusTimer = 0
      }, 3000) : 0
    }

    const renderTargets = (state) => {
      const { panel, history } = state
      const exclude = state.targetMode === 'exclude'
      const targets = exclude ? history.settings.excludedUsers || [] : history.settings.users
      const includeButton = $('.ytcf-mode-include', panel)
      const excludeButton = $('.ytcf-mode-exclude', panel)
      includeButton.textContent = `＋ 包含（${history.settings.users.length}）`
      excludeButton.textContent = `－ 排除（${(history.settings.excludedUsers || []).length}）`
      includeButton.setAttribute('aria-pressed', String(!exclude))
      excludeButton.setAttribute('aria-pressed', String(exclude))
      const query = $('[name="search-users"]', panel).value.trim().toLowerCase().replace(/^@/, '')
      const users = targets.filter(user => user.toLowerCase().includes(query)).sort()
      const list = $('.ytcf-target-list', panel)
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
      const empty = $('.ytcf-target-empty', panel)
      empty.hidden = users.length > 0
      empty.textContent = targets.length ? '找不到符合搜尋的帳號。'
        : exclude ? '尚未排除任何帳號。' : '尚未新增目標帳號。'
    }

    const createPanel = (state) => {
      const panel = document.createElement('section')
      panel.className = 'ytcf-panel'
      panel.setAttribute('aria-label', '指定用戶聊天室')
      panel.appendChild(element('div', { class: 'ytcf-toolbar' }, [
        element('div', { class: 'ytcf-options' }, [
          element('button', { type: 'button', class: 'ytcf-target-summary', 'aria-label': '目標用戶',
            'aria-controls': 'ytcf-target-settings', 'aria-expanded': 'false' }, ['目標用戶']),
          element('span', { class: 'ytcf-count' }),
        ]),
        element('div', { class: 'ytcf-targets', id: 'ytcf-target-settings', hidden: '' }, [
          element('div', { class: 'ytcf-roles' }, [
            element('label', {}, [element('input', { type: 'checkbox', name: 'broadcaster' }), ' Broadcaster']),
            element('label', {}, [element('input', { type: 'checkbox', name: 'moderators' }), ' Moderator']),
          ]),
          element('div', { class: 'ytcf-target-modes', role: 'group', 'aria-label': '帳號篩選方式' }, [
            element('button', { type: 'button', class: 'ytcf-mode-include', 'aria-label': '＋ 包含' }, ['＋ 包含']),
            element('button', { type: 'button', class: 'ytcf-mode-exclude', 'aria-label': '－ 排除' }, ['－ 排除']),
          ]),
          element('form', { class: 'ytcf-users' }, [
            element('label', {}, ['新增帳號', element('input', { type: 'text', name: 'users',
              placeholder: '頻道 ID 或 @帳號', autocomplete: 'off', spellcheck: 'false' })]),
            element('button', { type: 'submit' }, ['新增']),
          ]),
          element('label', { class: 'ytcf-target-search' }, ['搜尋帳號', element('input', {
            type: 'search', name: 'search-users', placeholder: '搜尋目標帳號', autocomplete: 'off',
          })]),
          element('ul', { class: 'ytcf-target-list', 'aria-label': '目標用戶清單' }),
          element('p', { class: 'ytcf-target-empty' }),
          element('p', { class: 'ytcf-target-status', role: 'status', 'aria-live': 'polite' }),
        ]),
      ]))
      panel.appendChild(element('p', { class: 'ytcf-empty' }, ['尚無符合條件的發言。新增目標帳號後開始收集。']))
      panel.appendChild(element('div', { class: 'ytcf-list', role: 'log',
        'aria-label': '篩選後的聊天訊息', 'aria-live': 'off' }))
      panel.appendChild(element('button', { class: 'ytcf-latest', type: 'button', hidden: '' }, ['回到最新訊息']))
      state.panel = panel
      state.list = $('.ytcf-list', panel)
      state.empty = $('.ytcf-empty', panel)
      state.count = $('.ytcf-count', panel)
      state.latest = $('.ytcf-latest', panel)
      const moderators = $('[name="moderators"]', panel)
      const broadcaster = $('[name="broadcaster"]', panel)
      const users = $('[name="users"]', panel)
      moderators.checked = state.history.settings.moderators
      broadcaster.checked = state.history.settings.broadcaster
      state.status = $('.ytcf-target-status', panel)
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
      $('.ytcf-users', panel).addEventListener('submit', event => {
        event.preventDefault()
        const exclude = state.targetMode === 'exclude'
        const key = exclude ? 'excludedUsers' : 'users'
        const nextSettings = changeTargetUsers(state.history.settings, users.value, false, exclude)
        if (!nextSettings) {
          showTargetStatus(state, '請輸入一個頻道 ID、頻道網址或 @帳號。')
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
      $('.ytcf-mode-include', panel).addEventListener('click', () => setTargetMode('include'))
      $('.ytcf-mode-exclude', panel).addEventListener('click', () => setTargetMode('exclude'))
      $('[name="search-users"]', panel).addEventListener('input', () => renderTargets(state))
      const targetSettings = $('.ytcf-targets', panel)
      const targetButton = $('.ytcf-target-summary', panel)
      const setTargetsOpen = open => {
        targetSettings.hidden = !open
        targetButton.setAttribute('aria-expanded', String(open))
        panel.classList.toggle('ytcf-managing', open)
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
      setNativeChatAccessible(mounted, false)
      mounted.host.classList.remove('ytcf-host', 'ytcf-active')
      mounted.scroller.classList.remove('ytcf-source')
      mounted = null
    }

    const refresh = () => {
      const channel = getChannel()
      const header = $('yt-live-chat-header-renderer')
      const scroller = $('#item-scroller')
      const sourceItems = scroller && $('#items', scroller)
      const menu = $('#live-chat-header-context-menu')
      if (mounted && (mounted.history.channel !== channel || mounted.header !== header ||
        mounted.scroller !== scroller || mounted.items !== sourceItems || !mounted.button.isConnected || !mounted.panel.isConnected)) unmount()
      if (mounted || !header || !menu || !sourceItems || !scroller?.parentElement) return
      const state = { history: getHistory(channel), header, scroller, items: sourceItems,
        host: scroller.parentElement, sourceInert: scroller.inert,
        sourceAriaHidden: scroller.getAttribute('aria-hidden') }
      state.host.classList.add('ytcf-host')
      scroller.classList.add('ytcf-source')
      const button = document.createElement('button')
      button.id = 'yt-chat-tweaks-filter-button'
      button.type = 'button'
      button.setAttribute('aria-label', '切換指定用戶聊天室')
      const icon = document.createElementNS(SVG_NS, 'svg')
      icon.setAttribute('width', '24')
      icon.setAttribute('height', '24')
      icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('fill', 'currentColor')
      path.setAttribute('d', 'M3 4h18v2l-7 8v6l-4 2v-8L3 6V4zm3 2 6 7 6-7H6z')
      icon.appendChild(path)
      button.appendChild(icon)
      state.button = button
      menu.insertAdjacentElement('afterend', button)
      const nativeButton = $('#close-button button')
      button.style.color = nativeButton ? getComputedStyle(nativeButton).color : 'var(--yt-live-chat-primary-text-color, #fff)'
      button.addEventListener('click', () => setEnabled(state, !state.history.enabled))
      createPanel(state)
      captureTree(sourceItems, state.history)
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
      state.observer.observe(sourceItems, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['author-type', 'type', 'is-deleted', 'author-external-channel-id'] })
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
      #yt-chat-tweaks-filter-button { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex: 0 0 40px; width: 40px; height: 40px; min-width: 40px; min-height: 40px; margin: 0; padding: 8px; border: 0; border-radius: 50%; color: inherit; background: transparent; cursor: pointer; }
      #yt-chat-tweaks-filter-button[aria-pressed="true"] { color: var(--yt-live-chat-link-text-color, #3ea6ff) !important; }
      /* The native popup caches small limits after header buttons are injected.
         Keep it inside the iframe and let its content use the available space. */
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) { left: auto !important; right: 8px !important; max-width: calc(100vw - 16px) !important; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) ytd-menu-popup-renderer { box-sizing: border-box; width: max-content !important; max-width: calc(100vw - 16px) !important; max-height: calc(100vh - 68px) !important; overflow-x: hidden !important; overflow-y: auto !important; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) tp-yt-paper-item { white-space: normal !important; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) .text-wrapper { min-width: 0; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) yt-formatted-string { white-space: normal !important; overflow-wrap: anywhere; }
      #yt-chat-tweaks-filter-button:focus-visible, .ytcf-panel button:focus-visible { outline: 2px solid var(--yt-live-chat-button-default-text-color, #065fd4); outline-offset: -2px; }
      .ytcf-host { position: relative; }
      .ytcf-active > .ytcf-source { pointer-events: none; isolation: isolate; }
      .ytcf-panel { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; min-height: 0; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-background-color, #fff); font-size: 13px; }
      .ytcf-panel [hidden], .ytcf-panel[hidden] { display: none !important; }
      .ytcf-toolbar { flex: 0 0 auto; padding: 10px; border-bottom: 1px solid var(--yt-live-chat-message-input-border-color, #8884); }
      .ytcf-options { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; font-size: 12px; }
      .ytcf-roles { display: flex; align-items: center; gap: 12px; flex-shrink: 0; margin-bottom: 12px; }
      .ytcf-roles label { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
      .ytcf-roles input { width: 13px; height: 13px; margin: 0; accent-color: var(--yt-live-chat-button-default-text-color, #065fd4); }
      .ytcf-count { margin-left: auto; flex-shrink: 0; white-space: nowrap; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-users { display: flex; align-items: center; gap: 6px; }
      .ytcf-users label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; white-space: nowrap; }
      .ytcf-users input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: inherit; background: var(--yt-live-chat-background-color, #fff); font-size: 12px; }
      .ytcf-panel button { padding: 6px 10px; border: 0; border-radius: 4px; color: var(--yt-live-chat-button-default-text-color, #065fd4); background: var(--yt-live-chat-action-panel-background-color, #8882); cursor: pointer; }
      .ytcf-users input, .ytcf-users button[type="submit"] { box-sizing: border-box; height: 30px; font: inherit; }
      .ytcf-users button[type="submit"] { flex-shrink: 0; padding: 0 10px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-button-default-background-color, #8882); font-weight: 600; }
      .ytcf-users button[type="submit"]:hover { filter: brightness(1.2); }
      .ytcf-empty { padding: 16px 12px; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 6px 0; }
      .ytcf-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; }
      .ytcf-message:hover { background: var(--yt-live-chat-action-panel-background-color, #8882); }
      .ytcf-time { margin-right: 6px; color: var(--yt-live-chat-secondary-text-color, #606060); font-size: 10px; }
      .ytcf-message > img { width: 18px; height: 18px; margin-right: 3px; vertical-align: middle; }
      .ytcf-message .emoji { max-height: 24px; vertical-align: middle; }
      .ytcf-badge { display: inline-flex; align-items: center; margin-right: 3px; vertical-align: middle; pointer-events: none; }
      .ytcf-badge img, .ytcf-badge svg { width: 18px; height: 18px; }
      yt-live-chat-header-renderer #view-selector { display: none !important; }
      .ytcf-latest { position: absolute; bottom: 8px; align-self: center; }
      .ytcf-managing > .ytcf-toolbar { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
      .ytcf-managing > .ytcf-empty, .ytcf-managing > .ytcf-list, .ytcf-managing > .ytcf-latest { display: none !important; }
      .ytcf-options { flex-shrink: 0; }
      .ytcf-panel .ytcf-target-summary { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 0; color: var(--yt-live-chat-button-default-text-color, #065fd4); background: transparent; white-space: nowrap; font: inherit; cursor: pointer; }
      .ytcf-target-summary::before { content: '▸'; }
      .ytcf-target-summary[aria-expanded="true"]::before { content: '▾'; }
      .ytcf-targets { margin-top: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .ytcf-targets > :not(.ytcf-target-list) { flex-shrink: 0; }
      .ytcf-target-modes { display: flex; gap: 6px; margin-bottom: 8px; }
      .ytcf-target-modes button { flex: 1; padding: 4px 8px; color: inherit; background: var(--yt-live-chat-action-panel-background-color, #8882); font-size: 12px; }
      .ytcf-target-modes button[aria-pressed="true"] { color: var(--yt-live-chat-background-color, #fff); background: var(--yt-live-chat-button-default-text-color, #065fd4); }
      .ytcf-target-search { display: flex; align-items: center; gap: 6px; margin-top: 8px; white-space: nowrap; }
      .ytcf-target-search input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: inherit; background: var(--yt-live-chat-background-color, #fff); font-size: 12px; }
      .ytcf-target-list { list-style: none; padding: 0; margin: 6px 0 0; flex: 1; min-height: 40px; overflow-y: auto; }
      .ytcf-target-list li { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 0; }
      .ytcf-target-list span { overflow-wrap: anywhere; }
      .ytcf-target-list button { flex-shrink: 0; padding: 3px 8px; background: var(--yt-live-chat-action-panel-background-color, #8882); color: inherit; font-size: 11px; }
      .ytcf-target-empty, .ytcf-target-status { margin: 6px 0 0; font-size: 11px; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-target-status:empty { display: none; }
    `
    ;(document.head || document.documentElement).appendChild(style)
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY || event.key === null) syncSettings()
    })
    setInterval(refresh, 1000)
    refresh()
    // End YouTube chat filtering.
  })()

  copyEmoji()
  setupAutoFollow()
})()
