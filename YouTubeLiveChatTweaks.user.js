// ==UserScript==
// @name        YouTube Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.6.6
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js
// @description 提供 YouTube 聊天室用戶資訊卡、獨立 SC／會員事件紀錄、角色與帳號包含／排除篩選、表情複製、重新載入與自動跟隨。
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
  let scrollFrame = 0

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

    /* Use one inline flow so wrapped text can also use the avatar's column. */
    #item-scroller #items > yt-live-chat-text-message-renderer {
      display: block !important;
    }

    #item-scroller #items > yt-live-chat-text-message-renderer > #content {
      display: inline !important;
    }

    #item-scroller #items > yt-live-chat-text-message-renderer > #author-photo {
      display: inline-block !important;
      float: none !important;
      width: 1.4em !important;
      height: 1.4em !important;
      margin: 0 4px 0 0 !important;
      vertical-align: middle !important;
    }

    /* YouTube gives the inner image fixed width/height attributes (24px).
       Resize it with the host to avoid an off-center crop inside the circle. */
    #item-scroller #items > yt-live-chat-text-message-renderer > #author-photo > img {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      object-position: center !important;
    }

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
    #yt-chat-tweaks-sc-button:hover,
    #yt-chat-tweaks-reload-button:hover {
      background-color: var(--yt-live-chat-button-default-background-color, #8882) !important;
    }

    #yt-chat-tweaks-filter-button:active,
    #yt-chat-tweaks-sc-button:active,
    #yt-chat-tweaks-reload-button:active {
      background-color: var(--yt-live-chat-button-default-background-color, #8884) !important;
    }

    #yt-chat-tweaks-reload-button svg {
      fill: currentColor !important;
    }
  `)

  const MEMBERSHIP_EVENT_SELECTORS = {
    membership: 'yt-live-chat-membership-item-renderer',
    membershipGift: 'ytd-sponsorships-live-chat-gift-purchase-announcement-renderer, yt-live-chat-sponsorships-gift-purchase-announcement-renderer',
  }
  const NATIVE_MESSAGE_SELECTOR = [
    'yt-live-chat-text-message-renderer', 'yt-live-chat-paid-message-renderer',
    'yt-live-chat-paid-sticker-renderer', ...Object.values(MEMBERSHIP_EVENT_SELECTORS),
  ].join(', ')

  const rendererData = line => line.polymerController?.data || line.data || {}
  let openAuthorCard = () => {}
  let getAuthorCard = () => null
  let closeAuthorCard = () => {}
  let isFilteredChat = () => false

  const guardMessageMenu = event => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
    const line = target?.closest(NATIVE_MESSAGE_SELECTOR)
    if (!line || line.querySelector('#menu')?.contains(target)) return
    const author = target.closest('#author-name')
    if (author) {
      event.preventDefault()
      openAuthorCard(line, author)
    }
    // Stop YouTube's whole-message menu handler, keeping selection and the
    // browser's default link navigation available (no preventDefault).
    event.stopPropagation()
  }
  document.addEventListener('click', guardMessageMenu, true)

  const getOpenChatMenu = () => isFilteredChat() ? null : [...document.querySelectorAll('tp-yt-iron-dropdown')]
    .find(menu => !menu.id && menu.parentElement?.matches('yt-live-chat-app') &&
      !menu.hidden && menu.getAttribute('aria-hidden') !== 'true' && menu.getClientRects().length > 0) || getAuthorCard()

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
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) {
      line-height: 1.5;
      padding-inline-end: var(--chat-inline-padding) !important;
    }
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) > #content {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    #item-scroller #items > :is(${NATIVE_MESSAGE_SELECTOR}) #menu {
      display: none !important;
    }
    :is(${NATIVE_MESSAGE_SELECTOR}) #author-name { cursor: pointer; }
    :is(${NATIVE_MESSAGE_SELECTOR}) #author-name:hover { text-decoration: underline; }
    :is(${NATIVE_MESSAGE_SELECTOR}) #author-name:focus-visible { outline: 2px solid var(--yt-live-chat-link-text-color, #3ea6ff); outline-offset: 2px; }
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

    const filterButton = $('#yt-chat-tweaks-sc-button') || $('#yt-chat-tweaks-filter-button')
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

  const cancelScrollFrame = () => {
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    scrollFrame = 0
  }

  const scrollToBottom = () => {
    if (!scroller) return

    // Background tabs suspend rAF. Do not let a queued foreground frame
    // block new messages or YouTube's resume control while the tab is hidden.
    if (document.hidden) {
      cancelScrollFrame()
      if (followLatest) scroller.scrollTop = scroller.scrollHeight
      return
    }

    // One scrollTop write per frame: busy chats deliver several mutation
    // batches between frames, and each used to queue its own rAF.
    if (scrollFrame) return
    const targetScroller = scroller

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0

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

  const handleAutoFollowVisibility = () => {
    cancelScrollFrame()
    keepFollowingLatest()
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

    cancelScrollFrame()
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
    document.addEventListener('visibilitychange', handleAutoFollowVisibility)

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
        // Also recover from native pause/layout changes without new items.
        if (document.hidden) keepFollowingLatest()
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
    let globalTargets = { users: [], excludedUsers: [] }
    let unresolvedScope = ''
    let mounted = null
    isFilteredChat = () => !!mounted?.history.enabled
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
      const user = normalizeAccount(input)
      if (!user) return null
      const key = global ? exclude ? 'globalExcludedUsers' : 'globalUsers' : exclude ? 'excludedUsers' : 'users'
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
          history.dirty.add(record)
          if (record.id) history.ids.set(record.id, record)
        }
        while (history.messages.length > MAX_MESSAGES) {
          const oldest = history.messages.shift()
          forgetRecord(history, oldest)
        }
        histories.delete(unresolvedScope)
      }
      if (!history) {
        history = {
          channel, settings: loadSettings(channel), messages: [], nodes: new WeakMap(), ids: new Map(),
          enabled: false, supportOnly: false, follow: true, dirty: new Set(), removed: new Set(),
        }
      }
      histories.delete(channel)
      histories.set(channel, history)
      if (histories.size > MAX_CHANNELS) histories.delete(histories.keys().next().value)
      return history
    }

    // YouTube renderer colors are packed ARGB integers. Keep the source palette
    // rather than deriving a tier from currency-dependent purchase amounts.
    const argbColor = value => {
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) return ''
      const hex = (value >>> 0).toString(16).padStart(8, '0')
      return `#${hex.slice(2)}${hex.slice(0, 2)}`
    }
    const readEventColors = (line, data) => {
      const header = $('#header', line) || line
      const content = $('#content', line) || line
      const paint = (node, property) => node ? getComputedStyle(node)[property] || '' : ''
      const background = node => {
        const value = paint(node, 'backgroundColor')
        return value === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(value) ? '' : value
      }
      const headerBackground = argbColor(data.headerBackgroundColor) || background(header)
      return {
        headerBackground,
        bodyBackground: argbColor(data.bodyBackgroundColor) || background(content) || headerBackground,
        headerText: argbColor(data.headerTextColor) || paint($('#purchase-amount', line) || header, 'color'),
        bodyText: argbColor(data.bodyTextColor) || paint($('#message', line) || content, 'color'),
        author: argbColor(data.authorNameTextColor) || paint($('#author-name', line), 'color'),
        timestamp: argbColor(data.timestampColor) || argbColor(data.bodyTextColor) || paint(content, 'color'),
      }
    }

    const textValue = value => value?.simpleText || value?.runs?.map(run => run.text || '').join('') || ''
    const EVENT_LABELS = { membership: '會員加入', milestone: '會員里程碑', membershipGift: '會員贈禮' }

    const readMessage = (line) => {
      let author = $('#author-name', line)
      const data = rendererData(line)
      const identity = data.header?.sponsorshipsLiveChatHeaderRenderer || data
      const superChat = line.matches('yt-live-chat-paid-message-renderer')
      let supportEvent = superChat ? 'superChat' : Object.entries(MEMBERSHIP_EVENT_SELECTORS)
        .find(([, selector]) => line.matches(selector))?.[0] || ''
      if (supportEvent === 'membership' && (textValue(data.headerPrimaryText) || $('#header-primary-text', line)?.textContent?.trim())) {
        supportEvent = 'milestone'
      }
      // Other name-restoring scripts may change the DOM. Keep identity based
      // on YouTube's original author handle and stable channel ID.
      const originalName = textValue(identity.authorName) || textValue(data.authorName)
      if (!author && supportEvent && originalName) author = element('span', {}, [originalName])
      const user = normalizeAccount(originalName || author?.textContent)
      // The renderer retains the sender's stable ID even when its DOM shows a handle.
      const rawId = identity.authorExternalChannelId || data.authorExternalChannelId || line.getAttribute('author-external-channel-id')
      const channelId = typeof rawId === 'string' && /^UC[\w-]{22}$/.test(rawId) ? rawId : ''
      const amount = superChat ? ($('#purchase-amount', line)?.textContent?.trim() ||
        textValue(data.purchaseAmountText)) : ''
      // Membership headers and the optional milestone comment are separate
      // fields. Preserve both instead of taking the first node in DOM order.
      let message = $('#message', line) || $('#sticker', line)
      let details = []
      if (supportEvent && !superChat) {
        const headers = $$('#header-primary-text, #header-subtext, #primary-text', line)
        details = headers.filter(node => node !== message && !node.contains(message) &&
          !headers.some(other => other !== node && other.contains(node)))
        if (!details.length) {
          details = [data.headerPrimaryText, data.headerSubtext, data.primaryText]
            .map(textValue).filter(Boolean).map(text => element('span', {}, [text]))
        }
      }
      // Low-tier SC, welcome announcements and gifts may have no comment.
      if (!message && supportEvent) message = document.createElement('span')
      if (!message) message = $('#header-subtext', line)
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
      return { user, channelId, moderator, broadcaster, superChat, supportEvent, amount, author, body: message, details, badges, deleted,
        colors: supportEvent ? readEventColors(line, data) : null,
        id: line.id || data.id || '', time: $('#timestamp', line)?.textContent?.trim() || textValue(data.timestampText),
        avatar: $('#author-photo img', line)?.getAttribute('src') || identity.authorPhoto?.thumbnails?.[0]?.url || '',
        contextMenuEndpoint: data.contextMenuEndpoint || identity.contextMenuEndpoint }
    }

    // Profile lookups are public, on demand, and shared by channel ID. No
    // per-message requests or network interception are needed.
    const profiles = new Map()
    const profileRequests = new Map()
    const cardStates = new WeakMap()
    const retiredCards = new Set()
    let activeCard = null

    const originalImageUrl = value => {
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && (url.hostname === 'ggpht.com' || url.hostname.endsWith('.ggpht.com'))) {
          url.pathname = url.pathname.replace(/=s\d+(?:-[^/]*)?$/, '')
          return url.href
        }
      } catch (_) {}
      return value
    }

    const CARD_ROLE_COLORS = {
      owner: 'var(--yt-live-chat-owner-color, #ffd600)',
      moderator: 'var(--yt-live-chat-moderator-color, #5e84f1)',
      member: 'var(--yt-live-chat-sponsor-color, #2ba640)',
    }
    const authorNameColor = message => {
      if (!message.author.closest('yt-live-chat-author-chip')?.hasAttribute('is-highlighted')) {
        return getComputedStyle(message.author).color
      }
      // Custom cards and filtered rows do not retain the chip's light background.
      const role = message.broadcaster ? 'owner' : message.moderator ? 'moderator'
        : message.badges.some(badge => badge.getAttribute('type') === 'member') ? 'member' : ''
      return CARD_ROLE_COLORS[role] || ''
    }
    const authorSnapshot = message => {
      const highlighted = message.author.closest('yt-live-chat-author-chip')?.hasAttribute('is-highlighted')
      return {
        user: message.user, channelId: message.channelId, name: message.author.textContent,
        // Highlighted native chips use dark ink on a light background. The card
        // has its own background, so use role colors and its own neutral ink.
        color: authorNameColor(message),
        avatar: message.avatar, broadcaster: message.broadcaster, moderator: message.moderator,
        badges: message.badges.map(badge => {
          const visual = $('img, svg', badge)
          const type = badge.getAttribute('type')
          return { type, color: highlighted ? CARD_ROLE_COLORS[type] || '' : getComputedStyle(badge).color,
            label: badge.getAttribute('aria-label') || badge.getAttribute('shared-tooltip-text') || '徽章',
            visual: visual ? clonePresentation(visual) : null }
        }),
        // Retained messages must not keep the original renderer/DOM alive.
        contextMenuEndpoint: message.contextMenuEndpoint
          ? JSON.parse(JSON.stringify(message.contextMenuEndpoint)) : null,
      }
    }

    const getProfile = channelId => {
      if (!/^UC[\w-]{22}$/.test(channelId)) return Promise.resolve(null)
      const cached = profiles.get(channelId)
      if (cached && cached.expires > Date.now()) return Promise.resolve(cached.profile)
      if (profileRequests.has(channelId)) return profileRequests.get(channelId)
      const request = (async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 8000)
        let profile = null
        try {
          const client = window.ytcfg?.get?.('INNERTUBE_CONTEXT')?.client || {}
          const response = await fetch('/youtubei/v1/browse?prettyPrint=false', {
            method: 'POST', credentials: 'omit', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client: {
              clientName: 'WEB',
              clientVersion: client.clientVersion || window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20261012.01.00',
              hl: client.hl || document.documentElement?.lang || 'zh-TW', gl: client.gl || 'TW',
            } }, browseId: channelId }),
          })
          if (!response.ok) throw new Error('Profile lookup failed')
          const data = await response.json()
          const metadata = data.metadata?.channelMetadataRenderer
          if (metadata?.externalId && metadata.externalId !== channelId) throw new Error('Channel ID mismatch')
          const title = metadata?.title || data.header?.pageHeaderRenderer?.pageTitle
          if (typeof title !== 'string' || !title.trim()) throw new Error('Missing channel name')
          let handle = ''
          try {
            const url = new URL(metadata?.vanityChannelUrl || metadata?.ownerUrls?.[0])
            if (/^(www\.)?youtube\.com$/.test(url.hostname) && url.pathname.startsWith('/@')) {
              handle = decodeURIComponent(url.pathname.slice(1).split('/')[0])
            }
          } catch (_) {}
          profile = { title: title.trim(), handle }
        } catch (_) {
          // Briefly cache failures too, so reopening a card cannot flood requests.
        } finally {
          clearTimeout(timeout)
        }
        profiles.delete(channelId)
        profiles.set(channelId, { profile, expires: profile ? Infinity : Date.now() + 30000 })
        if (profiles.size > 200) profiles.delete(profiles.keys().next().value)
        return profile
      })()
      profileRequests.set(channelId, request)
      request.finally(() => profileRequests.delete(channelId))
      return request
    }

    const fitCardText = state => {
      for (const [node, size] of [[state.title, 18], [state.handle, 13], [state.id, 12]]) {
        if (!node) continue
        node.style.fontSize = `${size}px`
        const available = node.clientWidth
        if (!(available > 0)) continue
        let fitted = size
        // Measure actual glyphs rather than guessing from character count.
        // Recheck after scaling to account for rounding and font metrics.
        for (let pass = 0; pass < 3 && node.scrollWidth > available; pass++) {
          fitted *= Math.max(0.1, available - 1) / node.scrollWidth
          node.style.fontSize = `${fitted}px`
        }
      }
    }

    const positionCard = state => {
      const width = document.documentElement?.clientWidth || window.innerWidth || 400
      const height = document.documentElement?.clientHeight || window.innerHeight || 600
      const chat = $('yt-live-chat-renderer')?.getBoundingClientRect()
      const left = chat?.left || 0
      const cardWidth = chat?.width || width
      state.card.style.width = `${cardWidth}px`
      fitCardText(state)
      const cardHeight = state.card.getBoundingClientRect().height
      let top = state.anchor.bottom + 6
      if (top + cardHeight > height - 8) top = state.anchor.top - cardHeight - 6
      state.card.style.left = `${left}px`
      state.card.style.top = `${Math.max(8, Math.min(top, height - cardHeight - 8))}px`
      state.card.style.maxHeight = `${Math.max(0, height - 16)}px`
    }

    const dismissCard = (state = activeCard, restoreFocus = false) => {
      if (!state || state.closed) return
      state.closed = true
      state.card.hidden = true
      state.resizeObserver?.disconnect()
      clearTimeout(state.menuTimer)
      if (activeCard === state) activeCard = null
      if (restoreFocus && state.opener.isConnected) state.opener.focus()
      // Native service-item commands can complete asynchronously. Keep their
      // event path to yt-live-chat-app connected while dialogs/requests finish.
      if (state.nativeClicked) {
        retiredCards.add(state)
        state.retireTimer = setTimeout(() => {
          state.card.remove()
          retiredCards.delete(state)
        }, 30000)
      } else state.card.remove()
    }
    closeAuthorCard = () => dismissCard()
    getAuthorCard = () => activeCard?.card || null

    const requestNativeMenu = (state, endpoint) => {
      // This is the same service-request event used by YouTube's own menu
      // items. Its transport supplies authentication, context and permissions.
      const detail = { actionName: 'yt-service-request', args: [state.menuHost, endpoint],
        optionalAction: false, returnValue: [] }
      state.menuHost.dispatchEvent(new CustomEvent('yt-action', { bubbles: true, composed: true, detail }))
      const promise = detail.returnValue[0]?.ajaxPromise
      if (!promise?.then) return Promise.reject(new Error('Native menu transport unavailable'))
      return Promise.resolve(promise).then(result => result?.data || result?.response || result)
    }

    const loadCardMenu = state => {
      const run = ++state.menuRun
      state.menuStatus.textContent = '載入操作…'
      state.menuRetry.hidden = true
      if (!state.author.contextMenuEndpoint) {
        state.menuStatus.textContent = '此訊息沒有可用的操作。'
        return
      }
      clearTimeout(state.menuTimer)
      state.menuTimer = setTimeout(() => {
        if (state.closed || run !== state.menuRun) return
        state.menuStatus.textContent = '操作載入較久，可以重試。'
        state.menuRetry.hidden = false
        positionCard(state)
      }, 15000)
      requestNativeMenu(state, state.author.contextMenuEndpoint).then(data => {
        if (state.closed || run !== state.menuRun) return
        clearTimeout(state.menuTimer)
        const menuData = data?.liveChatItemContextMenuSupportedRenderers?.menuRenderer
        if (!menuData || !Array.isArray(menuData.items) || !menuData.items.length) {
          state.menuStatus.textContent = window.ytcfg?.get?.('LOGGED_IN') === false
            ? '登入 YouTube 後可使用報告／封鎖。' : '目前沒有可用的操作。'
          positionCard(state)
          return
        }
        const menu = element('ytd-menu-popup-renderer', { class: 'ytuc-menu' })
        state.menuHost.appendChild(menu)
        // Keep the original native item models, labels and command handlers.
        // Report remains tied to the clicked message; block to its author.
        ;(menu.polymerController || menu).data = menuData
        state.menuStatus.hidden = true
        state.menuRetry.hidden = true
        positionCard(state)
      }).catch(() => {
        if (state.closed || run !== state.menuRun) return
        clearTimeout(state.menuTimer)
        state.menuStatus.textContent = '無法載入操作。'
        state.menuRetry.hidden = false
        positionCard(state)
      })
    }

    const showAuthorCard = (author, opener) => {
      if (mounted?.history.enabled) return
      dismissCard()
      const app = $('yt-live-chat-app')
      if (!app) return
      const card = element('section', { class: 'ytuc-card', role: 'dialog', tabindex: '-1',
        'aria-label': '用戶資訊', 'aria-modal': 'false' })
      const photo = element('div', { class: 'ytuc-photo', 'aria-hidden': 'true' })
      if (/^https:\/\//.test(author.avatar)) photo.appendChild(element('img', { src: originalImageUrl(author.avatar), alt: '' }))
      else photo.textContent = (author.name || author.user || '?').replace(/^@/, '').slice(0,1).toUpperCase()
      const title = element('a', { class: 'ytuc-name', target: '_blank', rel: 'noopener noreferrer' }, [author.name || author.user])
      if (author.color) title.style.color = author.color
      title.href = author.channelId ? `https://www.youtube.com/channel/${author.channelId}`
        : `https://www.youtube.com/${author.user}`
      const close = element('button', { class: 'ytuc-close', type: 'button', 'aria-label': '關閉用戶資訊' }, ['×'])
      const handle = element('div', { class: 'ytuc-handle' }, [author.user])
      const id = element('div', { class: 'ytuc-id' }, [author.channelId || '無法取得頻道 ID'])
      const profileStatus = element('p', { class: 'ytuc-status', role: 'status' }, [author.channelId ? '載入頻道名稱…' : '頻道名稱暫時無法載入。'])
      const profileRetry = element('button', { class: 'ytuc-retry', type: 'button', hidden: '' }, ['重試名稱'])
      const nameRow = element('div', { class: 'ytuc-name-row' }, [title])
      const identity = element('div', { class: 'ytuc-identity' }, [nameRow, handle, id])
      const badges = [...(author.badges || [])]
      let badgeList
      if (author.broadcaster && !badges.some(badge => badge.type === 'owner')) badges.push({ label: 'Broadcaster', color: author.color })
      if (author.moderator && !badges.some(badge => badge.type === 'moderator')) badges.push({ label: 'Moderator', color: author.color })
      if (badges.length) {
        badgeList = element('div', { class: 'ytuc-badges', role: 'list', 'aria-label': '徽章' })
        for (const badge of badges) {
          const item = element('span', { class: 'ytuc-badge', role: 'listitem', 'aria-label': badge.label, title: badge.label })
          if (badge.color) item.style.color = badge.color
          if (badge.visual) {
            const visual = clonePresentation(badge.visual)
            if (visual.tagName?.toLowerCase() === 'img') {
              const src = visual.getAttribute('src') || ''
              const original = originalImageUrl(src)
              if (original !== src) {
                visual.setAttribute('src', original)
                visual.removeAttribute('srcset')
              }
            }
            item.appendChild(visual)
          } else item.textContent = badge.label
          badgeList.appendChild(item)
        }
      }
      identity.appendChild(profileStatus)
      identity.appendChild(profileRetry)
      const header = element('div', { class: 'ytuc-header' }, [photo, identity, close])
      const menuStatus = element('p', { class: 'ytuc-status', role: 'status' }, ['載入操作…'])
      const menuRetry = element('button', { class: 'ytuc-retry', type: 'button', hidden: '' }, ['重試操作'])
      const menuHost = element('div', { class: 'ytuc-actions' }, [menuStatus, menuRetry])
      card.appendChild(header)
      if (badgeList) card.appendChild(element('div', { class: 'ytuc-badge-section' }, [badgeList]))
      card.appendChild(menuHost)
      const state = { author, opener, anchor: opener.getBoundingClientRect(), card, title, handle, id,
        profileStatus, profileRetry, menuHost, menuStatus, menuRetry, menuRun: 0, closed: false }
      cardStates.set(card, state)
      activeCard = state
      card.close = () => dismissCard(state)
      close.addEventListener('click', () => dismissCard(state, true))
      card.addEventListener('click', event => {
        if (event.target?.closest('ytd-menu-popup-renderer')) state.nativeClicked = true
      }, true)
      const loadProfile = () => getProfile(author.channelId).then(profile => {
        if (state.closed) return
        if (profile) {
          title.textContent = profile.title
          if (profile.handle) handle.textContent = profile.handle
          profileStatus.hidden = true
          profileRetry.hidden = true
        } else {
          profileStatus.textContent = '頻道名稱暫時無法載入。'
          profileRetry.hidden = !author.channelId
        }
        positionCard(state)
      })
      profileRetry.addEventListener('click', () => {
        profiles.delete(author.channelId)
        profileStatus.textContent = '載入頻道名稱…'
        profileRetry.hidden = true
        loadProfile()
      })
      menuRetry.addEventListener('click', () => {
        for (const menu of $$('ytd-menu-popup-renderer', menuHost)) menu.remove()
        loadCardMenu(state)
      })
      app.appendChild(card)
      positionCard(state)
      const chat = $('yt-live-chat-renderer')
      if (chat && typeof ResizeObserver === 'function') {
        state.resizeObserver = new ResizeObserver(() => { if (!state.closed) positionCard(state) })
        state.resizeObserver.observe(chat)
      }
      document.fonts?.ready.then(() => { if (!state.closed) positionCard(state) })
      card.focus({ preventScroll: true })
      if (author.channelId) loadProfile()
      loadCardMenu(state)
      return state
    }
    openAuthorCard = (line, opener) => {
      const message = readMessage(line)
      if (message) showAuthorCard(authorSnapshot(message), opener)
    }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && activeCard) {
        event.preventDefault()
        event.stopImmediatePropagation()
        dismissCard(activeCard, true)
        return
      }
      const target = event.target?.closest?.('#author-name')
      const line = target?.closest(MESSAGE_SELECTOR)
      if (!line || !['Enter', ' '].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      openAuthorCard(line, target)
    }, true)
    window.addEventListener('yt-action', event => {
      if (event.detail?.actionName !== 'yt-close-popup-action') return
      const state = cardStates.get(event.target?.closest?.('.ytuc-card'))
      if (!state) return
      event.stopPropagation()
      state.nativeClicked = true
      dismissCard(state)
    }, true)
    window.addEventListener('resize', () => { if (activeCard) positionCard(activeCard) })
    window.addEventListener('pagehide', () => {
      dismissCard()
      for (const state of retiredCards) {
        clearTimeout(state.retireTimer)
        state.card.remove()
      }
      retiredCards.clear()
    })

    const includesAuthor = (users, message) => users.includes(message.user) ||
      (!!message.channelId && users.includes(message.channelId))

    const matchesFilter = (message, settings) =>
      !includesAuthor(settings.excludedUsers || [], message) && !includesAuthor(settings.globalExcludedUsers || [], message) && (
        (settings.moderators && message.moderator) ||
        (settings.broadcaster && message.broadcaster) ||
        includesAuthor(settings.users, message) || includesAuthor(settings.globalUsers || [], message)
      )

    const clonePresentation = source => {
      const copy = source.cloneNode(true)
      for (const node of [copy, ...$$('*', copy)]) {
        for (const attr of [...node.attributes]) {
          if (['id', 'tabindex', 'role', 'title'].includes(attr.name) || attr.name.startsWith('on') || attr.name.startsWith('data-')) node.removeAttribute(attr.name)
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
      if (message.supportEvent) {
        row.classList.add('ytcf-support-event')
        row.style.backgroundColor = message.colors.bodyBackground
        row.style.color = message.colors.bodyText
      }
      const time = document.createElement('time')
      time.className = 'ytcf-time'
      if (message.supportEvent) time.style.color = message.colors.timestamp
      time.textContent = message.time || new Date().toLocaleTimeString('zh-TW', { hour12: false })
      row.appendChild(time)
      if (message.avatar) {
        const avatar = document.createElement('img')
        avatar.className = 'ytcf-avatar'
        avatar.src = message.avatar
        avatar.alt = ''
        row.appendChild(avatar)
      }
      const author = document.createElement('strong')
      author.textContent = message.author.textContent
      author.style.color = message.supportEvent ? message.colors.author : authorNameColor(message)
      row.appendChild(author)
      row.appendChild(document.createTextNode(' '))
      for (const badge of message.badges) {
        const copy = document.createElement('span')
        copy.className = 'ytcf-badge'
        copy.setAttribute('aria-label', badge.getAttribute('aria-label') || badge.getAttribute('shared-tooltip-text') || '')
        const visual = $('img, svg', badge)
        if (visual) copy.appendChild(clonePresentation(visual))
        else copy.textContent = badge.getAttribute('type') === 'moderator' ? '🔧' : badge.getAttribute('type') === 'owner' ? '👑' : '★'
        row.appendChild(copy)
      }
      if (message.supportEvent) {
        const label = message.superChat ? message.amount ? `SC ${message.amount}` : 'SC' : EVENT_LABELS[message.supportEvent]
        const amount = element('span', { class: 'ytcf-amount' }, [label])
        amount.style.backgroundColor = message.colors.headerBackground
        amount.style.color = message.colors.headerText
        row.appendChild(amount)
      }
      for (const detail of message.details) {
        const copy = clonePresentation(detail)
        copy.className = `${copy.className || ''} ytcf-event-details`
        copy.style.color = message.colors.bodyText
        row.appendChild(copy)
      }
      const content = clonePresentation(message.body)
      content.className = `${content.className || ''} ytcf-body`
      if (message.supportEvent) content.style.color = message.colors.bodyText
      row.appendChild(content)
      return row
    }

    const captureLine = (line, history) => {
      const author = $('#author-name', line)
      if (author) {
        if (author.getAttribute('role') !== 'button') author.setAttribute('role', 'button')
        if (author.getAttribute('tabindex') !== '0') author.setAttribute('tabindex', '0')
        if (author.getAttribute('aria-label') !== '查看用戶資訊') author.setAttribute('aria-label', '查看用戶資訊')
      }
      const message = readMessage(line)
      if (!message || (!message.supportEvent && !message.moderator && !message.broadcaster && !includesAuthor(history.settings.users, message) &&
        !includesAuthor(history.settings.globalUsers || [], message))) return false
      const fingerprint = `${message.user}\n${message.channelId}\n${message.deleted}\n${message.moderator}\n${message.broadcaster}\n${message.supportEvent}\n${message.amount}\n${JSON.stringify(message.colors)}\n${message.details.map(node => node.innerHTML || node.textContent).join('\n')}\n${message.author.textContent}\n${message.body.innerHTML}`
      const previous = message.id ? history.ids.get(message.id) : history.nodes.get(line)
      if (previous?.fingerprint === fingerprint) {
        history.nodes.set(line, previous)
        return false
      }
      const view = makeMessageView(message)
      let record
      if (previous?.retained) {
        view.firstChild.textContent = previous.view.firstChild.textContent
        record = Object.assign(previous, { user: message.user, channelId: message.channelId, moderator: message.moderator,
          broadcaster: message.broadcaster, superChat: message.superChat, supportEvent: message.supportEvent, view, fingerprint })
      } else {
        record = { id: message.id, user: message.user, channelId: message.channelId, moderator: message.moderator,
          broadcaster: message.broadcaster, superChat: message.superChat, supportEvent: message.supportEvent, view, fingerprint, retained: true }
        history.messages.push(record)
        if (history.messages.length > MAX_MESSAGES) {
          const oldest = history.messages.shift()
          forgetRecord(history, oldest)
        }
      }
      history.nodes.set(line, record)
      if (message.id) history.ids.set(message.id, record)
      history.dirty.add(record)
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
      const filterKey = JSON.stringify([history.settings, history.supportOnly])
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
        const show = history.supportOnly ? !!record.supportEvent : matchesFilter(record, history.settings)
        state.visibleCount += Number(show) - (full ? 0 : Number(!!wasVisible))
        if (record.view.hidden !== !show) record.view.hidden = !show
        if (oldView && oldView !== record.view) {
          if (oldView.parentElement === list) oldView.replaceWith(record.view)
          else oldView.remove()
        }
        if (record.view.parentElement !== list) list.appendChild(record.view)
        record.renderedView = record.view
        record.visible = show
      }
      history.dirty.clear()
      state.renderedHistory = history
      state.filterKey = filterKey
      empty.hidden = state.visibleCount > 0
      const countText = `${state.visibleCount} 則`
      if (count.textContent !== countText) count.textContent = countText
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

    const setNativeChatAccessible = (state, enabled) => {
      // Keep the native viewport laid out and visible under the overlay so
      // YouTube can keep fetching/virtualizing messages while filtering.
      state.scroller.inert = enabled || state.sourceInert
      if (enabled) state.scroller.setAttribute('aria-hidden', 'true')
      else if (state.sourceAriaHidden === null) state.scroller.removeAttribute('aria-hidden')
      else state.scroller.setAttribute('aria-hidden', state.sourceAriaHidden)
    }

    let panelFramePending = false
    const positionFilterPanel = state => {
      if (!state.inTopLayer) return
      // Native summaries/banners can shrink the message scroller. Cover the
      // whole chat between its header and actual input, independent of them.
      const rect = state.renderer?.getBoundingClientRect() || state.host.getBoundingClientRect()
      const header = state.header?.getBoundingClientRect()
      const input = state.renderer && $('#input-panel', state.renderer)?.getBoundingClientRect()
      const top = header ? Math.max(rect.top, header.bottom) : rect.top
      const bottom = input?.height > 0 && input.top >= top ? input.top : rect.bottom ?? rect.top + rect.height
      Object.assign(state.panel.style, { position: 'fixed', inset: 'auto', margin: '0',
        left: `${rect.left}px`, top: `${top}px`, width: `${rect.width}px`, height: `${Math.max(0, bottom - top)}px` })
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
          if (state.renderer) state.layerObserver.observe(state.renderer)
          if (state.header) state.layerObserver.observe(state.header)
          const input = state.renderer && $('#input-panel', state.renderer)
          if (input) state.layerObserver.observe(input)
        }
      }
      positionFilterPanel(state)
    }

    const setEnabled = (state, enabled, supportOnly = false) => {
      cancelMessageRender(state)
      if (enabled) closeAuthorCard()
      state.history.enabled = enabled
      state.history.supportOnly = supportOnly
      state.host.classList.toggle('ytcf-active', enabled)
      setNativeChatAccessible(state, enabled)
      if (enabled) {
        // The overlay manages its own reader position; keep the underlying
        // chat at the live edge so incoming target messages keep arriving.
        followLatest = true
        keepFollowingLatest()
      }
      state.panel.hidden = !enabled
      setPanelLayer(state, enabled)
      state.button.setAttribute('aria-pressed', String(enabled && !supportOnly))
      state.scButton?.setAttribute('aria-pressed', String(enabled && supportOnly))
      state.panel.setAttribute('aria-label', supportOnly ? 'SC／會員紀錄' : '指定用戶聊天室')
      const summary = $('.ytcf-target-summary', state.panel)
      const title = $('.ytcf-sc-title', state.panel)
      if (summary) summary.hidden = supportOnly
      if (title) title.hidden = !supportOnly
      if (supportOnly) {
        const targets = $('.ytcf-targets', state.panel)
        if (targets) targets.hidden = true
        summary?.setAttribute('aria-expanded', 'false')
        state.panel.classList.remove('ytcf-managing')
      }
      if (state.empty) state.empty.textContent = supportOnly ? '本次頁面尚未收到 SC 或會員事件。'
        : '尚無符合條件的發言。新增目標帳號後開始收集。'
      if (enabled) renderMessages(state, true)
    }

    const showTargetStatus = (state, message = '') => {
      clearTimeout(state.statusTimer)
      state.status.textContent = message
      state.statusTimer = message ? setTimeout(() => {
        state.status.textContent = ''
        state.statusTimer = 0
      }, 3000) : 0
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
      const includeButton = $('.ytcf-mode-include', panel)
      const excludeButton = $('.ytcf-mode-exclude', panel)
      includeButton.textContent = `＋ 包含（${settings.users.length}）`
      excludeButton.textContent = `－ 排除（${(settings.excludedUsers || []).length}）`
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
          state.updateSettings(changeTargetUsers(history.settings, user, true, exclude, global),
            exclude ? `已取消排除 ${user}。` : `已移除 ${user}。`, global)
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
          element('span', { class: 'ytcf-sc-title', hidden: '' }, ['SC／會員紀錄']),
          element('span', { class: 'ytcf-count' }),
        ]),
        element('div', { class: 'ytcf-targets', id: 'ytcf-target-settings', hidden: '' }, [
          element('div', { class: 'ytcf-roles' }, [
            element('label', {}, [element('input', { type: 'checkbox', name: 'broadcaster' }), ' Broadcaster']),
            element('label', {}, [element('input', { type: 'checkbox', name: 'moderators' }), ' Moderator']),
          ]),
          element('label', { class: 'ytcf-target-scope' }, ['名單範圍', element('select', { name: 'target-scope' }, [
            element('option', { value: 'channel' }, ['目前頻道']),
            element('option', { value: 'global' }, ['全域']),
          ])]),
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
      $('.ytcf-users', panel).addEventListener('submit', event => {
        event.preventDefault()
        const exclude = state.targetMode === 'exclude'
        const global = state.targetScope === 'global'
        const key = global ? exclude ? 'globalExcludedUsers' : 'globalUsers' : exclude ? 'excludedUsers' : 'users'
        const nextSettings = changeTargetUsers(state.history.settings, users.value, false, exclude, global)
        if (!nextSettings) {
          showTargetStatus(state, '請輸入一個頻道 ID、頻道網址或 @帳號。')
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
      $('.ytcf-mode-include', panel).addEventListener('click', () => setTargetMode('include'))
      $('.ytcf-mode-exclude', panel).addEventListener('click', () => setTargetMode('exclude'))
      $('[name="target-scope"]', panel).addEventListener('change', event => {
        state.targetScope = event.target.value === 'global' ? 'global' : 'channel'
        showTargetStatus(state)
        renderTargets(state)
      })
      $('[name="search-users"]', panel).addEventListener('input', () => renderTargets(state))
      const targetSettings = $('.ytcf-targets', panel)
      const targetButton = $('.ytcf-target-summary', panel)
      const setTargetsOpen = open => {
        targetSettings.hidden = !open
        targetButton.setAttribute('aria-expanded', String(open))
        panel.classList.toggle('ytcf-managing', open)
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
      closeAuthorCard()
      setPanelLayer(mounted, false)
      clearTimeout(mounted.statusTimer)
      mounted.observer.disconnect()
      mounted.button.remove()
      mounted.scButton.remove()
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
        mounted.scroller !== scroller || mounted.items !== sourceItems || !mounted.button.isConnected ||
        !mounted.scButton.isConnected || !mounted.panel.isConnected)) unmount()
      if (mounted || !header || !menu || !sourceItems || !scroller?.parentElement) return
      const state = { history: getHistory(channel), header, scroller, items: sourceItems,
        renderer: scroller.closest('yt-live-chat-renderer'),
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
      button.addEventListener('click', () => setEnabled(state, !state.history.enabled || state.history.supportOnly))
      const scButton = element('button', { id: 'yt-chat-tweaks-sc-button', type: 'button',
        'aria-label': '切換 SC／會員紀錄' })
      const nativeScIcon = $('#picker-buttons #product-picker svg')
      const scIcon = nativeScIcon ? nativeScIcon.cloneNode(true) : document.createElementNS(SVG_NS, 'svg')
      scIcon.setAttribute('width', '24')
      scIcon.setAttribute('height', '24')
      scIcon.setAttribute('viewBox', '0 0 24 24')
      scIcon.setAttribute('aria-hidden', 'true')
      scIcon.setAttribute('fill', 'currentColor')
      if (!nativeScIcon) {
        const scPath = document.createElementNS(SVG_NS, 'path')
        // Native #product-picker path verified on YouTube on 2026-10-21.
        // Chat headers can appear before the purchase picker (or on replays).
        scPath.setAttribute('d', 'M21.5 4h-19A1.5 1.5 0 001 5.5v13A1.5 1.5 0 002.5 20h19a1.5 1.5 0 001.5-1.5v-13A1.5 1.5 0 0021.5 4ZM3 18V6h18v12H3Zm9-11.5a1 1 0 00-1 1v.638c-.357.101-.689.26-.979.49A2.35 2.35 0 009.13 10.5c-.007.424.112.84.342 1.197.21.31.497.563.831.734.546.29 1.23.411 1.693.502.557.109.899.19 1.117.315.087.048.11.082.114.09.004.005.028.044.028.162 0 .024-.008.118-.165.235-.162.122-.5.27-1.09.27-.721 0-1.049-.21-1.181-.323a.7.7 0 01-.132-.15l-.01-.018.005.013.006.014.002.009a.996.996 0 00-1.884.64l.947-.316-.003.001c-.9.3-.942.315-.943.317l.001.003.003.006.004.015.012.032c.045.111.1.218.162.321.146.236.324.444.535.624.357.306.841.566 1.476.702v.605a1 1 0 002 0v-.614c1.29-.289 2.245-1.144 2.245-2.386 0-.44-.103-.852-.327-1.212-.22-.355-.52-.6-.82-.77-.555-.316-1.244-.445-1.719-.539-.568-.111-.915-.185-1.143-.305a.5.5 0 01-.1-.07l-.004-.002V10.6a.401.401 0 01-.012-.1c0-.158.053-.244.14-.314.109-.086.34-.19.74-.19.373-.001.73.144.997.404a.995.995 0 001.518-1.286l-.699.58.698-.582v-.001l-.002-.001-.002-.003-.006-.006-.016-.018a2.984 2.984 0 00-.178-.182A3.44 3.44 0 0013 8.154V7.5a1 1 0 00-1-1Z')
        scIcon.appendChild(scPath)
      }
      scButton.appendChild(scIcon)
      scButton.style.color = button.style.color
      state.scButton = scButton
      button.insertAdjacentElement('afterend', scButton)
      scButton.addEventListener('click', () => setEnabled(state, !state.history.enabled || !state.history.supportOnly, true))
      createPanel(state)
      captureTree(sourceItems, state.history)
      state.observer = new MutationObserver(mutations => {
        if (getChannel() !== state.history.channel) { scheduleRefresh(); return }
        if (captureMutations(mutations, state.history)) scheduleMessageRender(state)
      })
      state.observer.observe(sourceItems, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['author-type', 'type', 'is-deleted', 'author-external-channel-id', 'style'] })
      mounted = state
      setEnabled(state, state.history.enabled, state.history.supportOnly)
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
      #yt-chat-tweaks-filter-button, #yt-chat-tweaks-sc-button { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex: 0 0 40px; width: 40px; height: 40px; min-width: 40px; min-height: 40px; margin: 0; padding: 8px; border: 0; border-radius: 50%; color: inherit; background: transparent; cursor: pointer; }
      #yt-chat-tweaks-filter-button[aria-pressed="true"], #yt-chat-tweaks-sc-button[aria-pressed="true"] { color: var(--yt-live-chat-link-text-color, #3ea6ff) !important; }
      /* The native popup caches small limits after header buttons are injected.
         Keep it inside the iframe and let its content use the available space. */
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) { left: auto !important; right: 8px !important; max-width: calc(100vw - 16px) !important; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) ytd-menu-popup-renderer { box-sizing: border-box; width: max-content !important; max-width: calc(100vw - 16px) !important; max-height: calc(100vh - 68px) !important; overflow-x: hidden !important; overflow-y: auto !important; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) tp-yt-paper-item { white-space: normal !important; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) .text-wrapper { min-width: 0; }
      yt-live-chat-app > tp-yt-iron-dropdown:not([id]):has(yt-live-chat-toggle-renderer) yt-formatted-string { white-space: normal !important; overflow-wrap: anywhere; }
      #yt-chat-tweaks-filter-button:focus-visible, #yt-chat-tweaks-sc-button:focus-visible, .ytcf-panel button:focus-visible { outline: 2px solid var(--yt-live-chat-button-default-text-color, #065fd4); outline-offset: -2px; }
      .ytcf-host { position: relative; }
      .ytcf-active > .ytcf-source { pointer-events: none; isolation: isolate; }
      .ytcf-panel { position: absolute; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; box-sizing: border-box; min-height: 0; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-background-color, #fff); font-size: 13px; }
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
      .ytcf-users button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0 10px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-button-default-background-color, #8882); font-weight: 600; line-height: 1; }
      .ytcf-users button[type="submit"]:hover { filter: brightness(1.2); }
      .ytcf-empty { padding: 16px 12px; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 6px 0; }
      .ytcf-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; }
      .ytcf-message:hover { background: var(--yt-live-chat-action-panel-background-color, #8882); }
      .ytcf-support-event { margin: 3px 6px; border-radius: 4px; }
      .ytcf-support-event .ytcf-body a, .ytcf-event-details a { color: inherit; text-decoration: underline; }
      .ytcf-event-details { display: block; }
      .ytcf-amount { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 4px; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-action-panel-background-color, #8882); font-weight: 600; }
      .ytuc-card { position: fixed; z-index: 2200; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--yt-live-chat-message-input-border-color, #8884); border-radius: 8px; box-shadow: 0 8px 28px #0006; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-background-color, #fff); font: 13px/1.5 Roboto, Arial, sans-serif; }
      .ytuc-card[hidden], .ytuc-card [hidden] { display: none !important; }
      .ytuc-header { display: flex; align-items: flex-start; gap: 12px; padding: 16px 12px; }
      .ytuc-photo { display: flex; align-items: center; justify-content: center; flex: 0 0 56px; width: 56px; height: 56px; overflow: hidden; border-radius: 50%; background: var(--yt-live-chat-button-default-background-color, #8883); font-size: 24px; }
      .ytuc-photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .ytuc-name-row { line-height: 1.4; }
      .ytuc-name { display: block; width: 100%; white-space: nowrap; color: inherit; text-decoration: none; font-size: 18px; font-weight: 600; }
      .ytuc-name:hover { text-decoration: underline; }
      .ytuc-card .ytuc-close { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 28px; width: 28px; height: 28px; margin: 0; padding: 0; border: 0; border-radius: 50%; color: inherit; background: none; cursor: pointer; font: 24px/1 Arial, sans-serif; }
      .ytuc-close:hover { background: var(--yt-live-chat-button-default-background-color, #8882); }
      .ytuc-identity { flex: 1; min-width: 0; padding-top: 4px; }
      .ytuc-handle { margin-top: 6px; width: 100%; white-space: nowrap; }
      .ytuc-id { margin-top: 4px; width: 100%; white-space: nowrap; color: var(--yt-live-chat-secondary-text-color, #606060); user-select: text; font: 12px/1.5 ui-monospace, Consolas, monospace; }
      .ytuc-badge-section { padding: 0 12px 12px; }
      .ytuc-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .ytuc-badge { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 36px; min-height: 36px; padding: 4px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8884); border-radius: 4px; font-size: 11px; }
      .ytuc-badge img, .ytuc-badge svg { display: block; width: 26px !important; height: 26px !important; object-fit: contain; }
      .ytuc-badge svg { fill: currentColor; }
      .ytuc-actions { padding: 12px; border-top: 1px solid var(--yt-live-chat-message-input-border-color, #8883); background: var(--yt-live-chat-action-panel-background-color, #8881); }
      .ytuc-status { margin: 0; color: var(--yt-live-chat-secondary-text-color, #606060); font-size: 12px; }
      .ytuc-identity .ytuc-status { margin-top: 8px; }
      .ytuc-card .ytuc-retry { margin-top: 8px; padding: 4px 10px; border: 0; border-radius: 16px; color: inherit; background: var(--yt-live-chat-button-default-background-color, #8882); cursor: pointer; font: inherit; }
      .ytuc-card button:focus-visible, .ytuc-card a:focus-visible { outline: 2px solid var(--yt-live-chat-link-text-color, #3ea6ff); outline-offset: 2px; }
      .ytuc-menu { display: block; min-width: 0 !important; max-width: 100% !important; max-height: none !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; color: inherit; background: transparent !important; }
      .ytuc-menu :is(ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, a.yt-simple-endpoint, tp-yt-paper-item, yt-formatted-string, yt-icon) { color: inherit !important; }
      .ytuc-menu > #items { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 !important; color: inherit; background: transparent !important; }
      .ytuc-menu tp-yt-paper-item { display: inline-flex !important; box-sizing: border-box; width: max-content !important; max-width: 100%; min-height: 32px !important; min-width: 0 !important; gap: 0 !important; padding: 4px 12px !important; border-radius: 18px; background: var(--yt-live-chat-button-default-background-color, #8882); white-space: normal; cursor: pointer; }
      .ytuc-menu tp-yt-paper-item:hover { filter: brightness(1.15); }
      .ytuc-menu yt-icon { width: 20px; height: 20px; margin-right: 6px !important; }
      .ytuc-menu .text-wrapper { flex: 0 1 auto !important; min-width: 0; width: max-content !important; }
      .ytuc-menu .text-wrapper > .title { flex: none !important; width: auto !important; min-width: 0 !important; margin: 0 !important; }
      /* Block uses a navigation item with a direct label, unlike Report's
         service item and text-wrapper. Both native labels reserve 24px. */
      .ytuc-menu ytd-menu-navigation-item-renderer tp-yt-paper-item > yt-formatted-string { flex: 0 1 auto !important; width: auto !important; min-width: 0 !important; margin: 0 !important; }
      .ytuc-menu .item { flex: 0 1 auto !important; width: max-content !important; min-width: 0 !important; max-width: 100%; }
      .ytcf-time { margin-right: 6px; color: var(--yt-live-chat-secondary-text-color, #606060); font-size: 10px; }
      .ytcf-avatar { display: inline-block; width: 1.4em; height: 1.4em; margin-right: 4px; border-radius: 50%; vertical-align: middle; }
      .ytcf-body { display: inline !important; }
      .ytcf-message .emoji { max-height: 24px; vertical-align: middle; }
      .ytcf-badge { display: inline-flex; align-items: center; margin-right: 3px; vertical-align: middle; pointer-events: none; }
      .ytcf-badge img, .ytcf-badge svg { width: 18px; height: 18px; }
      yt-live-chat-header-renderer #view-selector { display: none !important; }
      yt-live-chat-header-renderer > #viewer-leaderboard-entry-point { order: -1 !important; margin-inline-start: 0 !important; margin-inline-end: auto !important; }
      .ytcf-latest { position: absolute; bottom: 8px; align-self: center; }
      .ytcf-managing > .ytcf-toolbar { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
      .ytcf-managing > .ytcf-empty, .ytcf-managing > .ytcf-list, .ytcf-managing > .ytcf-latest { display: none !important; }
      .ytcf-options { flex-shrink: 0; }
      .ytcf-panel .ytcf-target-summary { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 0; color: var(--yt-live-chat-button-default-text-color, #065fd4); background: transparent; white-space: nowrap; font: inherit; cursor: pointer; }
      .ytcf-target-summary::before { content: '▸'; }
      .ytcf-target-summary[aria-expanded="true"]::before { content: '▾'; }
      .ytcf-targets { margin-top: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .ytcf-targets > :not(.ytcf-target-list) { flex-shrink: 0; }
      .ytcf-target-scope { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
      .ytcf-target-scope select { flex: 1; min-width: 0; height: 30px; padding: 4px 8px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: inherit; background: var(--yt-live-chat-background-color, #fff); font: inherit; }
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
    window.addEventListener('resize', schedulePanelPosition)
    document.addEventListener('visibilitychange', handleMessageVisibility)
    window.addEventListener('scroll', schedulePanelPosition, true)
    setInterval(refresh, 1000)
    refresh()
    // End YouTube chat filtering.
  })()

  copyEmoji()
  setupAutoFollow()
})()
