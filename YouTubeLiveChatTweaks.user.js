// ==UserScript==
// @name        YouTube Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.8.14
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js
// @description 提供 YouTube 聊天室用戶資訊卡、獨立 SC／會員事件紀錄與類型顏色篩選、全域角色與帳號包含／排除篩選、表情複製、重新載入與自動跟隨。
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
      background-color: var(--yt-spec-button-chip-background-hover, color-mix(in srgb, var(--yt-live-chat-primary-text-color, #0f0f0f) 20%, transparent)) !important;
    }

    #yt-chat-tweaks-filter-button:active,
    #yt-chat-tweaks-sc-button:active,
    #yt-chat-tweaks-reload-button:active {
      background-color: color-mix(in srgb, var(--yt-spec-touch-response, var(--yt-live-chat-primary-text-color, #0f0f0f)) 30%, transparent) !important;
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

  const getOpenChatMenu = () => getAuthorCard() || (isFilteredChat() ? null : [...document.querySelectorAll('tp-yt-iron-dropdown')]
    .find(menu => !menu.id && menu.parentElement?.matches('yt-live-chat-app') &&
      !menu.hidden && menu.getAttribute('aria-hidden') !== 'true' && menu.getClientRects().length > 0))

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
      target.matches('input, textarea, select, [role="textbox"], [contenteditable="true"], [contenteditable=""]')
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
    const target = event.composedPath?.()[0] || event.target
    if (isEditableTarget(target) || target?.closest?.('.ytcf-panel') || event.target?.closest?.('.ytcf-panel')) return

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
    const TARGET_PROFILES_KEY = 'youtube-live-chat-tweaks-target-profiles-v1'
    const MAX_CHANNELS = 5
    const ARCHIVE_DB = 'youtube-live-chat-tweaks-history-v1'
    const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
    const STREAMS_KEY = 'youtube-live-chat-tweaks-streams-v1'
    const DEFAULT_SETTINGS = { moderators: true, broadcaster: true, verified: true, users: [], excludedUsers: [] }
    const SUPPORT_EVENTS = ['superChat', 'superSticker', 'membership', 'milestone', 'membershipGift']
    const SC_COLOR_TIERS = [
      { key: 'blue', label: '藍色', color: '#2962ff' },
      { key: 'cyan', label: '淺藍', color: '#00e5ff' },
      { key: 'green', label: '綠色', color: '#00e676' },
      { key: 'yellow', label: '黃色', color: '#ffe600' },
      { key: 'orange', label: '橙色', color: '#ff8000' },
      { key: 'magenta', label: '洋紅', color: '#f500d6' },
      { key: 'red', label: '紅色', color: '#e62117' },
    ]
    const SC_COLOR_KEYS = new Set(SC_COLOR_TIERS.map(tier => tier.key))
    const EXACT_SC_TIER_COLORS = new Map([
      ['1565c0', 'blue'], ['1e88e5', 'blue'], ['0d47a1', 'blue'], ['1976d2', 'blue'], ['2196f3', 'blue'], ['2962ff', 'blue'], ['0000ff', 'blue'],
      ['00b8d4', 'cyan'], ['00e5ff', 'cyan'], ['0097a7', 'cyan'], ['00acc1', 'cyan'], ['00838f', 'cyan'], ['00ffff', 'cyan'],
      ['00897b', 'green'], ['00bfa5', 'green'], ['1de9b6', 'green'], ['0f9d58', 'green'], ['00e676', 'green'], ['00796b', 'green'], ['00c853', 'green'], ['00ff00', 'green'],
      ['ffb300', 'yellow'], ['ffca28', 'yellow'], ['ffc107', 'yellow'], ['ffa000', 'yellow'], ['ffd600', 'yellow'], ['ffea00', 'yellow'], ['ffe600', 'yellow'], ['ffff00', 'yellow'],
      ['e65100', 'orange'], ['f57c00', 'orange'], ['ef6c00', 'orange'], ['ff6d00', 'orange'], ['ff9100', 'orange'], ['fb8c00', 'orange'], ['ff8000', 'orange'], ['ff8800', 'orange'],
      ['c2185b', 'magenta'], ['e91e63', 'magenta'], ['ad1457', 'magenta'], ['d81b60', 'magenta'], ['ec407a', 'magenta'], ['880e4f', 'magenta'], ['f500d6', 'magenta'], ['ff00ff', 'magenta'],
      ['d00000', 'red'], ['e62117', 'red'], ['c62828', 'red'], ['d32f2f', 'red'], ['b71c1c', 'red'], ['ff1744', 'red'], ['f44336', 'red'], ['ff0000', 'red'],
    ])
    const createDefaultSupportFilter = () => ({
      membership: true,
      milestone: true,
      membershipGift: true,
      colors: Object.fromEntries(SC_COLOR_TIERS.map(tier => [tier.key, true])),
    })
    const histories = new Map()
    const profiles = new Map()
    const profileRequests = new Map()
    const handleCache = new Map()
    const handleRequests = new Map()
    const targetProfiles = new Map()
    const targetResolveRequests = new Map()
    const targetResolveRetryAt = new Map()
    let targetProfilesLoaded = false
    const TARGET_PROFILE_FAIL_TTL = 30000
    const MAX_TARGET_PROFILES = 200
    const viewRecords = new WeakMap()
    const nowMs = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
    const yieldToMain = () => (typeof scheduler !== 'undefined' && typeof scheduler?.yield === 'function'
      ? scheduler.yield()
      : new Promise(resolve => setTimeout(resolve, 0)))
    let pageSettings = null
    let unresolvedScope = ''
    let mounted = null
    isFilteredChat = () => !!mounted?.history.enabled
    let refreshTimer = 0
    let archiveDatabase
    const pageKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    let anonymousMessage = 0
    let messageOrder = 0

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
          if (!/^(www\.)?youtube\.com$/i.test(url.hostname)) return ''
          const id = url.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1]
          if (id) return id
          const handleMatch = url.pathname.match(/^\/(@[^/]+)(?:\/|$)/)?.[1]
          return handleMatch ? normalizeAccount(decodeURIComponent(handleMatch)) : ''
        } catch (_) { return '' }
      }
      const handle = raw.replace(/^@/, '').toLowerCase()
      return /^[^\s@/\\,，;；?#&]{1,100}$/u.test(handle) ? `@${handle}` : ''
    }
    const normalizeUsers = value => [...new Set(String(value || '').split(/[\s,，;；]+/)
      .map(normalizeAccount).filter(Boolean))]

    const storageObjectCache = new Map()
    const readStorageObject = key => {
      try {
        const raw = localStorage.getItem(key) || '{}'
        let cached = storageObjectCache.get(key)
        if (!cached || cached.raw !== raw) {
          const value = JSON.parse(raw)
          cached = {
            raw,
            data: value && typeof value === 'object' && !Array.isArray(value) ? value : null,
          }
          storageObjectCache.set(key, cached)
        }
        return cached.data ? Object.assign(Object.create(null), cached.data) : Object.create(null)
      } catch (_) { return Object.create(null) }
    }
    const readSavedSettings = () => readStorageObject(STORAGE_KEY)
    const displayHandle = value => typeof value === 'string' && value.trim().startsWith('@') && normalizeAccount(value) ? value.trim() : ''

    const loadTargetProfiles = () => {
      if (targetProfilesLoaded) return
      targetProfilesLoaded = true
      const saved = readStorageObject(TARGET_PROFILES_KEY)
      for (const [rawKey, entry] of Object.entries(saved)) {
        const key = normalizeAccount(rawKey)
        if (!key || !entry || typeof entry !== 'object') continue
        const channelId = typeof entry.channelId === 'string' && /^UC[\w-]{22}$/.test(entry.channelId) ? entry.channelId : ''
        const handle = displayHandle(entry.handle) || ''
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (channelId || handle || name) targetProfiles.set(key, { channelId, handle, name })
      }
    }

    const saveTargetProfiles = () => {
      loadTargetProfiles()
      const saved = readSavedSettings()
      const activeKeys = new Set([
        ...(Array.isArray(saved.users) ? saved.users : []),
        ...(Array.isArray(saved.excludedUsers) ? saved.excludedUsers : []),
      ])
      for (const history of histories.values()) {
        for (const u of history.settings?.users || []) activeKeys.add(u)
        for (const u of history.settings?.excludedUsers || []) activeKeys.add(u)
      }
      if (targetProfiles.size > MAX_TARGET_PROFILES) {
        for (const key of [...targetProfiles.keys()]) {
          if (targetProfiles.size <= MAX_TARGET_PROFILES) break
          if (!activeKeys.has(key)) targetProfiles.delete(key)
        }
      }
      const data = Object.create(null)
      for (const [key, entry] of targetProfiles) {
        if (entry.channelId || entry.handle || entry.name) data[key] = entry
      }
      try { localStorage.setItem(TARGET_PROFILES_KEY, JSON.stringify(data)) } catch (_) {}
    }

    const mergeTargetEntry = (existing, incoming) => {
      const channelId = incoming.channelId || existing?.channelId || ''
      const handle = incoming.handle && (!existing?.handle || incoming.handle.toLowerCase() !== existing.handle.toLowerCase() || existing.handle === existing.handle.toLowerCase())
        ? incoming.handle : (existing?.handle || incoming.handle || '')
      const name = incoming.name || existing?.name || ''
      if (existing && existing.channelId === channelId && existing.handle === handle && existing.name === name) return null
      return { channelId, handle, name }
    }

    const recordTargetProfile = ({ channelId = '', handle = '', name = '', alias = '' } = {}, persist = false) => {
      loadTargetProfiles()
      const id = typeof channelId === 'string' && /^UC[\w-]{22}$/.test(channelId) ? channelId : ''
      const cleanHandle = displayHandle(handle) || ''
      const handleKey = cleanHandle ? normalizeAccount(cleanHandle) : ''
      const cleanAlias = normalizeAccount(alias)
      const cleanName = typeof name === 'string' ? name.trim() : ''
      const keys = [...new Set([id, handleKey, cleanAlias].filter(Boolean))]
      if (!keys.length || (!id && !cleanHandle && !cleanName)) return false
      let seed = null
      for (const key of keys) {
        const existing = targetProfiles.get(key)
        if (!existing) continue
        seed = seed ? mergeTargetEntry(seed, existing) || seed : existing
      }
      const merged = mergeTargetEntry(seed, { channelId: id, handle: cleanHandle, name: cleanName })
      let changed = Boolean(!seed || merged)
      const value = merged || seed
      if (!value) return false
      for (const key of keys) {
        const prev = targetProfiles.get(key)
        if (!prev || prev.channelId !== value.channelId || prev.handle !== value.handle || prev.name !== value.name) {
          targetProfiles.delete(key)
          targetProfiles.set(key, { ...value })
          changed = true
        }
      }
      if (changed && persist) saveTargetProfiles()
      return changed
    }

    const noteTargetRecord = (record, settings = null, persist = false) => {
      if (!record) return false
      const activeSettings = settings || readSavedSettings()
      const targets = [...(activeSettings.users || []), ...(activeSettings.excludedUsers || [])]
      if (!targets.length) return false
      const matches = targets.includes(record.user) || (record.channelId && targets.includes(record.channelId))
      if (!matches) return false
      const rawName = String(record.profileName || record.authorName || '').trim()
      const name = record.profileName ? record.profileName.trim() : (rawName && !rawName.startsWith('@') ? rawName : '')
      const handle = displayHandle(record.profileHandle) || displayHandle(record.authorHandle) || displayHandle(record.authorName) || ''
      return recordTargetProfile({ channelId: record.channelId || '', handle, name }, persist)
    }

    const getTargetMetadata = (user, history = null) => {
      loadTargetProfiles()
      const isId = /^UC[\w-]{22}$/.test(user)
      let channelId = isId ? user : ''
      let handle = ''
      let name = ''
      const cachedTarget = targetProfiles.get(user)
      if (cachedTarget) {
        if (!channelId && cachedTarget.channelId) channelId = cachedTarget.channelId
        handle = cachedTarget.handle || ''
        name = cachedTarget.name || ''
      }
      if (channelId) {
        const memProfile = profiles.get(channelId)?.profile
        if (memProfile) {
          if (!name && memProfile.title) name = memProfile.title
          if (!handle && memProfile.handle) handle = memProfile.handle
        }
        const byId = targetProfiles.get(channelId)
        if (byId) {
          if (!handle && byId.handle) handle = byId.handle
          if (!name && byId.name) name = byId.name
        }
      }
      if (handle && !channelId) {
        const byHandle = targetProfiles.get(normalizeAccount(handle))
        if (byHandle?.channelId) channelId = byHandle.channelId
        if (!name && byHandle?.name) name = byHandle.name
      }
      if (!channelId || !handle || !name) {
        const scan = history ? [history, ...histories.values()] : [...histories.values()]
        const seenHistories = new Set()
        for (const item of scan) {
          if (!item || seenHistories.has(item)) continue
          seenHistories.add(item)
          for (let i = item.messages.length - 1; i >= 0; i--) {
            const record = item.messages[i]
            const hit = (isId && record.channelId === user) || (!isId && (record.user === user || (channelId && record.channelId === channelId)))
            if (!hit) continue
            if (!channelId && /^UC[\w-]{22}$/.test(record.channelId)) channelId = record.channelId
            const recordHandle = displayHandle(record.profileHandle) || displayHandle(record.authorHandle) || displayHandle(record.authorName)
            if (recordHandle && (!handle || handle === handle.toLowerCase())) handle = recordHandle
            const recordName = record.profileName || (!String(record.authorName || '').startsWith('@') ? record.authorName : '')
            if (!name && recordName) name = String(recordName).trim()
            if (channelId && handle && name) break
          }
          if (channelId && handle && name) break
        }
      }
      if (!handle && user.startsWith('@')) handle = user
      const pending = targetResolveRequests.has(user) || (Boolean(channelId) && profileRequests.has(channelId))
      return { channelId, handle, name, pending }
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

    // Store presentation as a small DOM tree. Restoring never uses innerHTML,
    // and only inert elements, safe URLs and color properties are accepted.
    const ARCHIVE_TAGS = new Set(['div', 'span', 'strong', 'time', 'img', 'a', 'b', 'i', 'em', 'br',
      'svg', 'path', 'g', 'circle', 'rect', 'ellipse', 'line', 'polygon', 'polyline'])
    const ARCHIVE_ATTRIBUTES = new Set(['class', 'src', 'alt', 'href', 'aria-label', 'viewBox', 'd',
      'fill', 'stroke', 'stroke-width', 'width', 'height', 'x', 'y', 'r', 'cx', 'cy', 'rx', 'ry', 'points', 'transform'])
    const archiveTree = (node, depth = 0) => {
      if (depth > 20) return null
      if (node.nodeType === 3 || node.tagName === '#text') return { text: node.textContent }
      if (node.nodeType !== 1) return null
      if (node.matches('.ytcf-locate')) return null
      return {
        tag: (node.localName || node.tagName).toLowerCase(), svg: node.namespaceURI === SVG_NS,
        attributes: [...node.attributes].filter(attr => ARCHIVE_ATTRIBUTES.has(attr.name)).map(attr => [attr.name, attr.value]),
        color: node.style.color || '', background: node.style.backgroundColor || '',
        children: [...node.childNodes].map(child => archiveTree(child, depth + 1)).filter(Boolean),
      }
    }
    const safeArchiveUrl = value => {
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (!trimmed) return ''
      try {
        const url = new URL(trimmed, location.href)
        return ['https:', 'http:'].includes(url.protocol) || /^data:image\/(png|gif|jpe?g|webp|avif);base64,/i.test(trimmed) ? url.href : ''
      } catch (_) { return '' }
    }
    const restoreTree = (tree, budget = { remaining: 3000 }, depth = 0) => {
      if (!tree || typeof tree !== 'object' || depth > 20 || --budget.remaining < 0) return null
      if (typeof tree.text === 'string') return document.createTextNode(tree.text)
      const tag = ARCHIVE_TAGS.has(tree.tag) ? tree.tag : 'span'
      const node = tree.svg && ['svg', 'path', 'g', 'circle', 'rect', 'ellipse', 'line', 'polygon', 'polyline'].includes(tag)
        ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)
      for (const attr of Array.isArray(tree.attributes) ? tree.attributes : []) {
        if (!Array.isArray(attr) || attr.length !== 2) continue
        let [name, value] = attr
        if (!ARCHIVE_ATTRIBUTES.has(name) || typeof value !== 'string') continue
        if (name === 'href' || name === 'src') {
          value = safeArchiveUrl(value)
          if (!value) continue
        }
        if (['fill', 'stroke'].includes(name) && /url\s*\(/i.test(value)) continue
        if (name === 'class') value = value.split(/\s+/).filter(part => part.startsWith('ytcf-') || part === 'emoji').join(' ')
        node.setAttribute(name, value)
      }
      if (tag === 'a') { node.target = '_blank'; node.rel = 'noopener noreferrer' }
      if (typeof tree.color === 'string') node.style.color = tree.color
      if (typeof tree.background === 'string') node.style.backgroundColor = tree.background
      for (const child of Array.isArray(tree.children) ? tree.children : []) {
        const restored = restoreTree(child, budget, depth + 1)
        if (restored) node.appendChild(restored)
      }
      return node
    }
    const formatSupportView = (view, superChat) => {
      const amount = $('.ytcf-amount', view)
      if (superChat && amount) amount.textContent = amount.textContent.replace(/^SC\s+/, '')
      const details = $$('.ytcf-event-details', view).filter(node => node.parentElement === view)
      if (details.length) {
        const header = element('span', { class: 'ytcf-event-header' })
        details[0].insertAdjacentElement('beforebegin', header)
        for (const detail of details) {
          if (header.childNodes.length) header.appendChild(document.createTextNode(' '))
          header.appendChild(detail)
        }
      }
    }
    const treeSearchText = (tree, depth = 0) => {
      if (!tree || depth > 20) return ''
      const alt = (Array.isArray(tree.attributes) ? tree.attributes : [])
        .filter(attr => Array.isArray(attr) && attr[0] === 'alt').map(attr => attr[1])
      return [typeof tree.text === 'string' ? tree.text : '', ...alt,
        ...(Array.isArray(tree.children) ? tree.children : []).map(child => treeSearchText(child, depth + 1))].join('')
    }
    const parseCssRgb = value => {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (!raw || raw === 'transparent') return null
      const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1]
      if (hex) {
        if (hex.length <= 4) {
          if (hex.length === 4 && hex[3] === '0') return null
          const hex6 = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
          return { r: parseInt(hex6.slice(0, 2), 16), g: parseInt(hex6.slice(2, 4), 16), b: parseInt(hex6.slice(4, 6), 16), hex6 }
        }
        if (hex.length === 8 && hex.slice(6) === '00') return null
        const hex6 = hex.slice(0, 6)
        return { r: parseInt(hex6.slice(0, 2), 16), g: parseInt(hex6.slice(2, 4), 16), b: parseInt(hex6.slice(4, 6), 16), hex6 }
      }
      const rgb = raw.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?%?))?\s*\)$/)
      if (!rgb) return null
      if (rgb[4] !== undefined && parseFloat(rgb[4]) <= 0) return null
      const clamp = n => Math.max(0, Math.min(255, Math.round(Number(n))))
      const [r, g, b] = [clamp(rgb[1]), clamp(rgb[2]), clamp(rgb[3])]
      const hex6 = [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')
      return { r, g, b, hex6 }
    }
    const classifyRgbTier = rgb => {
      if (!rgb) return ''
      const exact = EXACT_SC_TIER_COLORS.get(rgb.hex6)
      if (exact) return exact
      const [r, g, b] = [rgb.r / 255, rgb.g / 255, rgb.b / 255]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const delta = max - min
      if (delta < 0.08) return ''
      let hue = delta === 0 ? 0
        : max === r ? 60 * (((g - b) / delta) % 6)
        : max === g ? 60 * ((b - r) / delta + 2)
        : 60 * ((r - g) / delta + 4)
      if (hue < 0) hue += 360
      if (hue < 16 || hue >= 345) return 'red'
      if (hue < 40) return 'orange'
      if (hue < 75) return 'yellow'
      if (hue < 175) return 'green'
      if (hue < 200) return 'cyan'
      if (hue < 260) return 'blue'
      return 'magenta'
    }
    const classifySupportColors = colors => colors
      ? (classifyRgbTier(parseCssRgb(colors.bodyBackground)) || classifyRgbTier(parseCssRgb(colors.headerBackground)))
      : ''
    const findTreeAmountBackground = (tree, depth = 0) => {
      if (!tree || typeof tree !== 'object' || depth > 8) return ''
      const cls = (Array.isArray(tree.attributes) ? tree.attributes : [])
        .find(attr => Array.isArray(attr) && attr[0] === 'class')?.[1] || ''
      if (typeof cls === 'string' && cls.split(/\s+/).includes('ytcf-amount') && tree.background) return tree.background
      for (const child of Array.isArray(tree.children) ? tree.children : []) {
        const found = findTreeAmountBackground(child, depth + 1)
        if (found) return found
      }
      return ''
    }
    const getRecordColorTier = record => {
      if (!record || (record.supportEvent !== 'superChat' && record.supportEvent !== 'superSticker')) return ''
      if (record.scColor) return record.scColor
      let tier = ''
      if (!record._hasView && record._savedTree) {
        tier = classifySupportColors({
          bodyBackground: record._savedTree.background,
          headerBackground: findTreeAmountBackground(record._savedTree),
        })
      } else {
        const view = record._hydratedView || (!('_hasView' in record) ? record.view : null)
        if (view) {
          tier = classifySupportColors({
            bodyBackground: view.style.backgroundColor,
            headerBackground: $('.ytcf-amount', view)?.style.backgroundColor || '',
          })
        }
      }
      if (tier) record.scColor = tier
      return tier
    }
    const matchesSupportFilter = (record, filter = null) => {
      if (!record?.supportEvent) return false
      if (!filter) return true
      if (record.supportEvent === 'superChat' || record.supportEvent === 'superSticker') {
        const colors = filter.colors || {}
        const tier = getRecordColorTier(record)
        return tier ? Boolean(colors[tier]) : Object.values(colors).every(Boolean)
      }
      return filter[record.supportEvent] !== false
    }
    const archiveRecord = (history, record) => ({
      scope: history.scope, storageId: record.storageId, createdAt: record.createdAt,
      order: record.order,
      expiresAt: record.createdAt + RETENTION_MS, id: record.id, user: record.user, channelId: record.channelId,
      moderator: record.moderator, broadcaster: record.broadcaster, verified: record.verified,
      superChat: record.superChat, supportEvent: record.supportEvent,
      scColor: getRecordColorTier(record),
      fingerprint: record.fingerprint,
      authorName: record.authorName, authorHandle: record.authorHandle,
      profileName: record.profileName, profileHandle: record.profileHandle,
      tree: !record._hasView && record._savedTree ? record._savedTree : archiveTree(record.view),
    })
    const validArchiveRecord = (saved, scope) => saved && saved.scope === scope &&
      typeof saved.storageId === 'string' && typeof saved.id === 'string' && typeof saved.user === 'string' &&
      Number.isFinite(saved.createdAt) && saved.createdAt <= Date.now() && saved.createdAt + RETENTION_MS > Date.now() &&
      saved.tree && typeof saved.tree === 'object'
    const restoreRecord = saved => {
      if (saved.tree?.tag !== 'div' || saved.tree.children?.[0]?.tag?.toLowerCase() !== 'time' ||
        saved.supportEvent === 'giftRecipients') return null
      const record = { id: saved.id, storageId: saved.storageId, createdAt: saved.createdAt,
        order: Number.isSafeInteger(saved.order) ? saved.order : 0,
        user: saved.user, channelId: typeof saved.channelId === 'string' ? saved.channelId : '',
        moderator: saved.moderator === true, broadcaster: saved.broadcaster === true, verified: saved.verified === true,
        superChat: saved.superChat === true,
        supportEvent: SUPPORT_EVENTS.includes(saved.supportEvent) ? saved.supportEvent : '',
        scColor: SC_COLOR_KEYS.has(saved.scColor) ? saved.scColor : '',
        authorName: typeof saved.authorName === 'string' ? saved.authorName : '',
        authorHandle: typeof saved.authorHandle === 'string' ? saved.authorHandle : '',
        profileName: typeof saved.profileName === 'string' ? saved.profileName : '',
        profileHandle: typeof saved.profileHandle === 'string' ? saved.profileHandle : '',
        fingerprint: saved.fingerprint, retained: true,
        _savedTree: saved.tree, _hydratedView: null, _hasView: false, _searchText: '' }
      Object.defineProperty(record, 'view', {
        configurable: true,
        enumerable: true,
        get() {
          if (this._hydratedView) return this._hydratedView
          const view = restoreTree(this._savedTree) || document.createElement('div')
          view.classList.add('ytcf-message')
          this._hydratedView = view
          this._hasView = true
          this._savedTree = null
          viewRecords.set(view, this)
          applySupportAuthor(this)
          formatSupportView(view, this.superChat)
          bindRecordAuthor(this)
          return view
        },
        set(next) {
          this._hydratedView = next
          this._hasView = Boolean(next)
          this._savedTree = null
          if (next) viewRecords.set(next, this)
        },
      })
      return record
    }
    const updateArchiveStatus = history => {
      if (mounted?.history !== history) return
      const status = $('.ytcf-history-status', mounted.panel)
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
      history.saveQueue.set(record.storageId, saved)
      if (history.saveScheduled) return
      history.saveScheduled = true
      Promise.resolve().then(() => { history.saveScheduled = false; return flushHistory(history) })
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
        let targetChanged = false
        let deadline = nowMs() + 50
        for (const item of records) {
          const current = item.id ? history.ids.get(item.id) : null
          if (current) {
            current.createdAt = Math.min(current.createdAt, item.createdAt)
            current.order = Number.isSafeInteger(item.order) ? item.order : current.order
            if (!current.profileName && typeof item.profileName === 'string') {
              current.profileName = item.profileName
              current.profileHandle = typeof item.profileHandle === 'string' ? item.profileHandle : ''
              current._searchText = ''
              applySupportAuthor(current)
            }
            current.view.firstChild.textContent = restoreTree(item.tree)?.firstChild?.textContent || current.view.firstChild.textContent
            targetChanged = noteTargetRecord(current, history.settings) || targetChanged
            saveRecord(history, current)
          } else {
            const record = restoreRecord(item)
            if (!record) continue
            restored.push(record)
            if (record.id) history.ids.set(record.id, record)
            history.byStorageId.set(record.storageId, record)
            history.dirty.add(record)
            targetChanged = noteTargetRecord(record, history.settings) || targetChanged
          }
          if (nowMs() >= deadline) {
            await yieldToMain()
            deadline = nowMs() + 50
          }
        }
        if (targetChanged) saveTargetProfiles()
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
      let removedCurrent = false
      for (const history of histories.values()) {
        const before = history.messages.length
        history.messages = history.messages.filter(record => {
          if (record.createdAt > cutoff) return true
          forgetRecord(history, record)
          history.saveQueue.delete(record.storageId)
          return false
        })
        if (mounted?.history === history && history.messages.length !== before) removedCurrent = true
      }
      if (removedCurrent && mounted?.history.enabled) renderMessages(mounted)
      pruneArchive().catch(() => {})
    }

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

    const isFlatSettings = saved => saved && typeof saved === 'object' && (
      typeof saved.moderators === 'boolean' ||
      typeof saved.broadcaster === 'boolean' ||
      typeof saved.verified === 'boolean' ||
      Array.isArray(saved.users) ||
      Array.isArray(saved.excludedUsers)
    )

    const loadSettings = (channel = '') => {
      if (pageSettings) {
        return { ...pageSettings, users: [...pageSettings.users], excludedUsers: [...pageSettings.excludedUsers] }
      }
      try {
        const stored = readSavedSettings()
        if (isFlatSettings(stored)) {
          return {
            moderators: stored.moderators !== false,
            broadcaster: stored.broadcaster !== false,
            verified: stored.verified !== false,
            users: normalizeUsers(Array.isArray(stored.users) ? stored.users.join(' ') : ''),
            excludedUsers: normalizeUsers(Array.isArray(stored.excludedUsers) ? stored.excludedUsers.join(' ') : ''),
          }
        }
        const preferred = channel && stored[channel] && typeof stored[channel] === 'object' ? stored[channel] : null
        let moderators = preferred?.moderators
        let broadcaster = preferred?.broadcaster
        let verified = preferred?.verified
        const users = []
        const excludedUsers = []
        for (const [key, entry] of Object.entries(stored)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          if (key !== '@global') {
            if (typeof moderators !== 'boolean' && typeof entry.moderators === 'boolean') moderators = entry.moderators
            if (typeof broadcaster !== 'boolean' && typeof entry.broadcaster === 'boolean') broadcaster = entry.broadcaster
            if (typeof verified !== 'boolean' && typeof entry.verified === 'boolean') verified = entry.verified
          }
          if (Array.isArray(entry.users)) users.push(...entry.users)
          if (Array.isArray(entry.globalUsers)) users.push(...entry.globalUsers)
          if (Array.isArray(entry.excludedUsers)) excludedUsers.push(...entry.excludedUsers)
          if (Array.isArray(entry.globalExcludedUsers)) excludedUsers.push(...entry.globalExcludedUsers)
        }
        return {
          moderators: moderators !== false,
          broadcaster: broadcaster !== false,
          verified: verified !== false,
          users: normalizeUsers(users.join(' ')),
          excludedUsers: normalizeUsers(excludedUsers.join(' ')),
        }
      } catch (_) {
        return { ...DEFAULT_SETTINGS, users: [], excludedUsers: [] }
      }
    }

    const saveSettings = (history) => {
      const { moderators, broadcaster, verified, users, excludedUsers = [] } = history.settings
      const settings = { moderators, broadcaster, verified, users: [...users], excludedUsers: [...excludedUsers] }
      for (const item of histories.values()) {
        item.settings = { ...settings, users: [...settings.users], excludedUsers: [...settings.excludedUsers] }
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
        pageSettings = null
        return true
      } catch (_) {
        pageSettings = settings
        return false
      }
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
      const scope = unresolvedScope || channel
      let history = histories.get(channel)
      if (history && history.scope !== scope) history = null
      const pending = channel.startsWith('channel:') ? histories.get(unresolvedScope) : null
      if (pending && !history) {
        history = pending
        histories.delete(unresolvedScope)
        history.channel = channel
      } else if (pending && pending !== history) {
        for (const record of pending.messages) {
          if (record.id && history.ids.has(record.id)) continue
          history.messages.push(record)
          history.dirty.add(record)
          if (record.id) history.ids.set(record.id, record)
          history.byStorageId.set(record.storageId, record)
        }
        history.messages.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
        histories.delete(unresolvedScope)
      }
      if (!history) {
        history = {
          channel, settings: loadSettings(channel), messages: [], nodes: new WeakMap(), ids: new Map(),
          byStorageId: new Map(), enabled: false, supportOnly: false, supportSearch: '',
          supportFilter: createDefaultSupportFilter(),
          follow: true, dirty: new Set(), removed: new Set(),
          scope, saveQueue: new Map(), archiveReady: false, archiveError: false,
        }
        history.restorePromise = restoreHistory(history)
      }
      histories.delete(channel)
      histories.set(channel, history)
      if (histories.size > MAX_CHANNELS) {
        const oldest = histories.keys().next().value
        const evicted = histories.get(oldest)
        histories.delete(oldest)
        if (evicted?.saveQueue?.size) {
          Promise.resolve(evicted.restorePromise).then(() => flushHistory(evicted)).catch(() => {})
        }
      }
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
      const headerBackground = argbColor(data.headerBackgroundColor) || argbColor(data.moneyChipBackgroundColor) || background(header)
      return {
        headerBackground,
        bodyBackground: argbColor(data.bodyBackgroundColor) || argbColor(data.backgroundColor) || background(content) || headerBackground,
        headerText: argbColor(data.headerTextColor) || argbColor(data.moneyChipTextColor) || paint($('#purchase-amount', line) || header, 'color'),
        bodyText: argbColor(data.bodyTextColor) || paint($('#message', line) || content, 'color'),
        author: argbColor(data.authorNameTextColor) || paint($('#author-name', line), 'color'),
        timestamp: argbColor(data.timestampColor) || argbColor(data.bodyTextColor) || paint(content, 'color'),
      }
    }

    const textValue = value => value?.simpleText || value?.runs?.map(run => run.text || '').join('') || ''
    const EVENT_LABELS = {
      superSticker: '超級貼圖',
      membership: '會員加入',
      milestone: '會員里程碑',
      membershipGift: '會員贈禮',
    }

    const readMessage = (line, shouldKeep = null) => {
      let author = $('#author-name', line)
      const data = rendererData(line)
      const identity = data.header?.sponsorshipsLiveChatHeaderRenderer || data
      const superChat = line.matches('yt-live-chat-paid-message-renderer')
      const superSticker = line.matches('yt-live-chat-paid-sticker-renderer')
      const paid = superChat || superSticker
      let supportEvent = superSticker ? 'superSticker' : superChat ? 'superChat' : Object.entries(MEMBERSHIP_EVENT_SELECTORS)
        .find(([, selector]) => line.matches(selector))?.[0] || ''
      // Other name-restoring scripts may change the DOM. Keep identity based
      // on YouTube's original author handle and stable channel ID.
      const originalName = textValue(identity.authorName) || textValue(data.authorName)
      if (!author && supportEvent && originalName) author = element('span', {}, [originalName])
      const user = normalizeAccount(originalName || author?.textContent)
      if (!author || !user) return null
      // The renderer retains the sender's stable ID even when its DOM shows a handle.
      const rawId = identity.authorExternalChannelId || data.authorExternalChannelId || line.getAttribute('author-external-channel-id')
      const channelId = typeof rawId === 'string' && /^UC[\w-]{22}$/.test(rawId) ? rawId : ''
      const id = line.id || data.id || ''
      const chip = author.closest('yt-live-chat-author-chip') || line
      const badges = $$('yt-live-chat-author-badge-renderer', chip)
      const type = line.getAttribute('author-type') || author.getAttribute('type') || ''
      const classes = (author.getAttribute('class') || '').split(/\s+/)
      const moderator = type === 'moderator' || classes.includes('moderator') || badges.some(b => b.getAttribute('type') === 'moderator')
      const broadcaster = type === 'owner' || classes.includes('owner') || badges.some(b => b.getAttribute('type') === 'owner')
      const verified = type === 'verified' || badges.some(b => b.getAttribute('type') === 'verified' ||
        rendererData(b).icon?.iconType === 'VERIFIED') ||
        (identity.authorBadges || data.authorBadges || []).some(b => b?.liveChatAuthorBadgeRenderer?.icon?.iconType === 'VERIFIED')
      if (shouldKeep && !shouldKeep({ id, user, channelId, moderator, broadcaster, verified, supportEvent })) return null
      if (supportEvent === 'membership' && (textValue(data.headerPrimaryText) || $('#header-primary-text', line)?.textContent?.trim())) {
        supportEvent = 'milestone'
      }
      const amount = paid ? ($('#purchase-amount', line)?.textContent?.trim() ||
        textValue(data.purchaseAmountText)) : ''
      // Membership headers and the optional milestone comment are separate
      // fields. Preserve both instead of taking the first node in DOM order.
      let message = $('#message', line) || $('#sticker', line)
      let sticker = null
      if (superSticker) {
        const source = $('#sticker', line)
        const image = source?.matches('img') ? source : source && $('img', source)
        const thumbnails = Array.isArray(data.sticker?.thumbnails) ? data.sticker.thumbnails : []
        const url = safeArchiveUrl(image?.getAttribute('src') || thumbnails.at(-1)?.url || '')
        const alt = image?.getAttribute('alt') || source?.getAttribute('aria-label') ||
          data.sticker?.accessibility?.accessibilityData?.label || '超級貼圖'
        sticker = { url, alt: typeof alt === 'string' ? alt : '超級貼圖' }
        message = element('span', { class: 'ytcf-sticker' }, [url
          ? element('img', { src: url, alt: sticker.alt }) : sticker.alt])
      }
      let details = []
      if (supportEvent && !paid) {
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
      if (!message) return null
      const deleted = line.hasAttribute('is-deleted')
      if (deleted) {
        message = document.createElement('span')
        message.textContent = $('#deleted-state', line)?.textContent?.trim() || '訊息已刪除'
      }
      return { user, channelId, moderator, broadcaster, verified, superChat, supportEvent, amount, sticker, author, body: message, details, badges, deleted,
        authorHandle: [originalName, author.textContent].find(name => typeof name === 'string' && name.trim().startsWith('@') && normalizeAccount(name))?.trim() || '',
        colors: supportEvent ? readEventColors(line, data) : null,
        id, time: $('#timestamp', line)?.textContent?.trim() || textValue(data.timestampText),
        avatar: safeArchiveUrl($('#author-photo img', line)?.getAttribute('src') || identity.authorPhoto?.thumbnails?.[0]?.url || ''),
        contextMenuEndpoint: data.contextMenuEndpoint || identity.contextMenuEndpoint }
    }

    // Profile lookups are public and shared by channel ID, for cards and
    // visible SC/membership authors. No network interception is needed.
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
      if ('_authorColor' in message) return message._authorColor
      if (!message.author.closest('yt-live-chat-author-chip')?.hasAttribute('is-highlighted')) {
        return (message._authorColor = getComputedStyle(message.author).color)
      }
      // Custom cards and filtered rows do not retain the chip's light background.
      const role = message.broadcaster ? 'owner' : message.moderator ? 'moderator'
        : message.badges.some(badge => badge.getAttribute('type') === 'member') ? 'member' : ''
      return (message._authorColor = CARD_ROLE_COLORS[role] || '')
    }
    const authorSnapshot = message => {
      const highlighted = message.supportEvent || message.author.closest('yt-live-chat-author-chip')?.hasAttribute('is-highlighted')
      const role = message.broadcaster ? 'owner' : message.moderator ? 'moderator'
        : message.badges.some(badge => badge.getAttribute('type') === 'member') ? 'member' : ''
      return {
        user: message.user, channelId: message.channelId, name: message.author.textContent,
        // Highlighted native chips use dark ink on a light background. The card
        // has its own background, so use role colors and its own neutral ink.
        color: highlighted ? CARD_ROLE_COLORS[role] || '' : authorNameColor(message),
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

    const postInnerTube = async (endpoint, payload) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        const client = window.ytcfg?.get?.('INNERTUBE_CONTEXT')?.client || {}
        const response = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
          method: 'POST', credentials: 'omit', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: { client: {
            clientName: 'WEB',
            clientVersion: client.clientVersion || window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20261012.01.00',
            hl: client.hl || document.documentElement?.lang || 'zh-TW', gl: client.gl || 'TW',
          } }, ...payload }),
        })
        return response.ok ? await response.json() : null
      } catch (_) {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }

    const extractHandleFromUrl = value => {
      try {
        const url = new URL(value, 'https://www.youtube.com')
        if (/^(www\.)?youtube\.com$/.test(url.hostname) && url.pathname.startsWith('/@')) {
          return displayHandle(decodeURIComponent(url.pathname.slice(1).split('/')[0]))
        }
      } catch (_) {}
      return ''
    }

    const getProfile = channelId => {
      if (!/^UC[\w-]{22}$/.test(channelId)) return Promise.resolve(null)
      const cached = profiles.get(channelId)
      if (cached && cached.expires > Date.now()) return Promise.resolve(cached.profile)
      if (profileRequests.has(channelId)) return profileRequests.get(channelId)
      const request = (async () => {
        let profile = null
        try {
          const data = await postInnerTube('browse', { browseId: channelId })
          if (!data) throw new Error('Profile lookup failed')
          const metadata = data.metadata?.channelMetadataRenderer
          if (metadata?.externalId && metadata.externalId !== channelId) throw new Error('Channel ID mismatch')
          const title = metadata?.title || data.header?.pageHeaderRenderer?.pageTitle
          if (typeof title !== 'string' || !title.trim()) throw new Error('Missing channel name')
          const handle = extractHandleFromUrl(metadata?.vanityChannelUrl || metadata?.ownerUrls?.[0] || metadata?.channelUrl)
          profile = { channelId, title: title.trim(), handle }
        } catch (_) {
          // Briefly cache failures too, so reopening a card cannot flood requests.
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

    const resolveHandle = account => {
      const handleKey = normalizeAccount(account)
      if (!handleKey.startsWith('@')) return Promise.resolve(null)
      const cached = handleCache.get(handleKey)
      if (cached && cached.expires > Date.now()) return Promise.resolve(cached.result)
      if (handleRequests.has(handleKey)) return handleRequests.get(handleKey)
      const request = (async () => {
        let result = null
        try {
          const data = await postInnerTube('navigation/resolve_url', {
            url: `https://www.youtube.com/@${encodeURIComponent(handleKey.slice(1))}`,
          })
          const browse = data?.endpoint?.browseEndpoint
          const channelId = typeof browse?.browseId === 'string' && /^UC[\w-]{22}$/.test(browse.browseId) ? browse.browseId : ''
          const canonicalHandle = extractHandleFromUrl(browse?.canonicalBaseUrl)
          if (channelId) {
            const profile = await getProfile(channelId)
            result = {
              channelId,
              handle: profile?.handle || canonicalHandle || displayHandle(account) || handleKey,
              name: profile?.title || '',
            }
          }
        } catch (_) {}
        handleCache.delete(handleKey)
        handleCache.set(handleKey, { result, expires: result ? Infinity : Date.now() + TARGET_PROFILE_FAIL_TTL })
        if (handleCache.size > 200) handleCache.delete(handleCache.keys().next().value)
        return result
      })()
      handleRequests.set(handleKey, request)
      request.finally(() => handleRequests.delete(handleKey))
      return request
    }

    const supportAuthorViews = new WeakMap()
    const supportAuthorQueue = []
    let activeAuthorLookups = 0
    const applySupportAuthor = record => {
      if (!record.supportEvent) return
      record._searchText = ''
      if ('_hasView' in record && !record._hasView) return
      const author = $('.ytcf-author', record.view) || $('strong', record.view)
      if (!author) return
      author.classList.add('ytcf-author')
      if (!record.authorName) record.authorName = author.textContent.trim()
      record.authorHandle = displayHandle(record.authorHandle) || displayHandle(record.authorName)
      const name = record.profileName || record.authorName
      const handle = displayHandle(record.profileHandle) || record.authorHandle
      const label = handle && name.toLowerCase() !== handle.toLowerCase() ? `${name} ${handle}` : name
      if (author.textContent === label && (!handle || $('.ytcf-handle-at', author))) return
      author.textContent = ''
      if (handle) {
        const at = label.length - handle.length
        if (at) author.appendChild(document.createTextNode(label.slice(0, at)))
        author.appendChild(element('span', { class: 'ytcf-handle-at' }, ['@']))
        author.appendChild(document.createTextNode(label.slice(at + 1)))
      } else author.textContent = label
    }
    const resolveSupportAuthor = (history, record) => {
      if (!record.supportEvent || !record.retained || !/^UC[\w-]{22}$/.test(record.channelId) ||
        record.profileResolved || record.profileRetryAt > Date.now()) return Promise.resolve(null)
      if (record.profileRequest) return record.profileRequest
      record.profileRequest = (async () => {
        const channelId = record.channelId
        try {
          const profile = await getProfile(channelId)
          if (!record.retained || record.channelId !== channelId) return null
          if (!profile) { record.profileRetryAt = Date.now() + 30000; return null }
          record.profileName = profile.title
          record.profileHandle = displayHandle(profile.handle)
          record.profileResolved = true
          applySupportAuthor(record)
          noteTargetRecord(record, history.settings, true)
          saveRecord(history, record)
          if (mounted?.history === history && history.supportOnly && history.supportSearch) scheduleMessageRender(mounted)
          return profile
        } catch (_) { record.profileRetryAt = Date.now() + 30000; return null }
        finally { record.profileRequest = null }
      })()
      return record.profileRequest
    }
    const drainSupportAuthors = () => {
      while (activeAuthorLookups < 4 && supportAuthorQueue.length) {
        const { history, record } = supportAuthorQueue.shift()
        record.profileQueued = false
        if (mounted?.history !== history || !history.enabled || !history.supportOnly || !record.retained) continue
        activeAuthorLookups++
        resolveSupportAuthor(history, record).finally(() => { activeAuthorLookups--; drainSupportAuthors() })
      }
    }
    const queueSupportAuthor = (history, record) => {
      if (record.profileQueued || record.profileRequest || record.profileResolved || record.profileRetryAt > Date.now() ||
        !/^UC[\w-]{22}$/.test(record.channelId)) return
      record.profileQueued = true
      supportAuthorQueue.push({ history, record })
      drainSupportAuthors()
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
      if (state.inTopLayer) { try { state.card.hidePopover() } catch (_) {} }
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
      if (mounted?.history.enabled && !mounted.panel.contains(opener)) return
      dismissCard()
      const app = $('yt-live-chat-app')
      if (!app) return
      const card = element('section', { class: 'ytuc-card', role: 'dialog', tabindex: '-1',
        'aria-label': '用戶資訊', 'aria-modal': 'false' })
      const photo = element('div', { class: 'ytuc-photo', 'aria-hidden': 'true' })
      const safeAvatar = safeArchiveUrl(originalImageUrl(author.avatar))
      if (/^https:\/\//.test(safeAvatar)) photo.appendChild(element('img', { src: safeAvatar, alt: '' }))
      else photo.textContent = (author.name || author.user || '?').replace(/^@/, '').slice(0,1).toUpperCase()
      const title = element('a', { class: 'ytuc-name', target: '_blank', rel: 'noopener noreferrer' }, [author.name || author.user])
      if (author.color) title.style.color = author.color
      const rawUser = String(author.user || '').trim().replace(/^\/+/, '')
      const safeHandle = rawUser.startsWith('@')
        ? `@${encodeURIComponent(rawUser.slice(1))}`
        : encodeURIComponent(rawUser)
      title.href = author.channelId
        ? `https://www.youtube.com/channel/${encodeURIComponent(author.channelId)}`
        : `https://www.youtube.com/${safeHandle}`
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
            for (const image of visual.tagName?.toLowerCase() === 'img' ? [visual] : $$('img', visual)) {
              const src = image.getAttribute('src') || ''
              const safe = safeArchiveUrl(originalImageUrl(src))
              if (!safe) {
                image.removeAttribute('src')
                image.removeAttribute('srcset')
              } else if (safe !== src) {
                image.setAttribute('src', safe)
                image.removeAttribute('srcset')
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
          noteTargetRecord({
            channelId: author.channelId,
            user: normalizeAccount(profile.handle || author.user),
            profileName: profile.title,
            profileHandle: profile.handle,
          }, null, true)
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
      // The filtered list is itself a popover; a later top-layer entry keeps
      // the card above it while preserving YouTube's native event ancestry.
      if (mounted?.inTopLayer && typeof card.showPopover === 'function') {
        card.setAttribute('popover', 'manual')
        try { card.showPopover(); state.inTopLayer = true }
        catch (_) { card.removeAttribute('popover') }
      }
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
      !includesAuthor(settings.excludedUsers || [], message) && (
        (settings.moderators && message.moderator) ||
        (settings.broadcaster && message.broadcaster) ||
        (settings.verified && message.verified) ||
        includesAuthor(settings.users, message)
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
      const safeAvatar = safeArchiveUrl(message.avatar)
      if (safeAvatar) {
        const avatar = document.createElement('img')
        avatar.className = 'ytcf-avatar'
        avatar.src = safeAvatar
        avatar.alt = ''
        row.appendChild(avatar)
      }
      const author = document.createElement('strong')
      author.className = 'ytcf-author'
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
        const label = message.superChat || message.supportEvent === 'superSticker'
          ? message.amount || EVENT_LABELS[message.supportEvent] || 'SC' : EVENT_LABELS[message.supportEvent]
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
      if (message.supportEvent) formatSupportView(row, message.superChat)
      return row
    }

    const bindRecordAuthor = record => {
      const author = $('.ytcf-author', record.view) || $('strong', record.view)
      if (!author) return
      author.classList.add('ytcf-author')
      author.setAttribute('role', 'button')
      author.setAttribute('tabindex', '0')
      author.setAttribute('aria-label', '查看用戶資訊')
      const open = event => {
        event.preventDefault()
        event.stopPropagation()
        // Older archives predate author snapshots. Their inert presentation
        // still contains identity and badge visuals, but no native commands.
        const snapshot = record.authorInfo || {
          user: record.user, channelId: record.channelId,
          name: record.authorName || author.textContent,
          color: record.supportEvent ? CARD_ROLE_COLORS[record.broadcaster ? 'owner' : record.moderator ? 'moderator' : ''] || '' : author.style.color,
          avatar: $('.ytcf-avatar', record.view)?.getAttribute('src') || '',
          broadcaster: record.broadcaster, moderator: record.moderator,
          badges: $$('.ytcf-badge', record.view).map(badge => ({
            label: badge.getAttribute('aria-label') || badge.textContent || '徽章',
            visual: $('img, svg', badge), color: record.supportEvent ? '' : badge.style.color,
          })),
        }
        showAuthorCard({ ...snapshot, name: record.profileName || snapshot.name }, author)
      }
      author.addEventListener('click', open)
      author.addEventListener('keydown', event => {
        if (['Enter', ' '].includes(event.key)) open(event)
      })
    }

    const captureLine = (line, history) => {
      const author = $('#author-name', line)
      if (author) {
        if (author.getAttribute('role') !== 'button') author.setAttribute('role', 'button')
        if (author.getAttribute('tabindex') !== '0') author.setAttribute('tabindex', '0')
        if (author.getAttribute('aria-label') !== '查看用戶資訊') author.setAttribute('aria-label', '查看用戶資訊')
      }
      const message = readMessage(line, candidate => {
        if (candidate.id && history.ids.get(candidate.id)?.retained) return true
        if (!candidate.id && history.nodes.get(line)?.retained) return true
        return Boolean(
          candidate.supportEvent || candidate.moderator || candidate.broadcaster || candidate.verified ||
          includesAuthor(history.settings.users, candidate)
        )
      })
      if (!message) return false
      const previous = message.id ? history.ids.get(message.id) : history.nodes.get(line)
      if (!previous?.retained && (!message.supportEvent && !message.moderator && !message.broadcaster && !message.verified && !includesAuthor(history.settings.users, message))) return false
      const fingerprint = `${message.user}\n${message.channelId}\n${message.deleted}\n${message.moderator}\n${message.broadcaster}\n${message.verified}\n${message.supportEvent}\n${message.amount}\n${JSON.stringify(message.sticker)}\n${JSON.stringify(message.colors)}\n${message.details.map(node => node.innerHTML || node.textContent).join('\n')}\n${message.author.textContent}\n${message.body.innerHTML}`
      if (previous?.fingerprint === fingerprint) {
        history.nodes.set(line, previous)
        return false
      }
      const view = makeMessageView(message)
      const scColor = classifySupportColors(message.colors)
      let record
      if (previous?.retained) {
        view.firstChild.textContent = previous.view.firstChild.textContent
        record = Object.assign(previous, { user: message.user, channelId: message.channelId, moderator: message.moderator,
          authorName: message.author.textContent.trim(), authorHandle: message.authorHandle,
          broadcaster: message.broadcaster, verified: message.verified, superChat: message.superChat, supportEvent: message.supportEvent,
          scColor,
          _searchText: '', view, fingerprint })
      } else {
        record = { id: message.id, user: message.user, channelId: message.channelId, moderator: message.moderator,
          authorName: message.author.textContent.trim(), authorHandle: message.authorHandle,
          profileName: '', profileHandle: '',
          broadcaster: message.broadcaster, verified: message.verified, superChat: message.superChat, supportEvent: message.supportEvent,
          scColor,
          storageId: message.id || `${pageKey}-${++anonymousMessage}`,
          createdAt: Date.now(), order: ++messageOrder,
          _searchText: '', view, fingerprint, retained: true }
        history.messages.push(record)
        history.byStorageId.set(record.storageId, record)
      }
      viewRecords.set(record.view, record)
      history.nodes.set(line, record)
      if (message.id) history.ids.set(message.id, record)
      history.dirty.add(record)
      record.authorInfo = authorSnapshot(message)
      applySupportAuthor(record)
      bindRecordAuthor(record)
      noteTargetRecord(record, history.settings, true)
      saveRecord(history, record)
      return true
    }

    // Keep these collection/render helpers in sync across both chat scripts.
    const forgetRecord = (history, record) => {
      record.retained = false
      record._searchText = ''
      history.dirty.delete(record)
      if (record.id && history.ids?.get(record.id) === record) history.ids.delete(record.id)
      if (history.byStorageId?.get(record.storageId) === record) history.byStorageId.delete(record.storageId)
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

    const normalizeSearch = value => String(value || '').normalize('NFKC').toLowerCase().trim()
    const supportSearchText = record => {
      if (record._searchText) return record._searchText
      const useTree = !record._hasView && record._savedTree
      const text = normalizeSearch([EVENT_LABELS[record.supportEvent], record.authorName, record.authorHandle, record.profileName,
        record.profileHandle, record.user, record.channelId,
        useTree ? treeSearchText(record._savedTree) : [...record.view.childNodes]
          .filter(node => !node.matches?.('.ytcf-locate')).map(node => node.textContent).join(''),
        ...(!useTree ? $$('img', record.view).map(image => image.getAttribute('alt') || '') : [])].join(' '))
      record._searchText = text
      return text
    }
    const unmountRecordView = (state, record) => {
      const oldView = record.renderedView
      if (oldView) {
        state.authorObserver?.unobserve(oldView)
        state.messageResizeObserver?.unobserve(oldView)
        oldView.remove()
      }
      record.renderedView = null
      record.visible = false
    }
    const findNextMountedRecord = (history, record, list) => {
      const start = history.messages.indexOf(record)
      if (start < 0) return null
      for (let i = start + 1; i < history.messages.length; i++) {
        const next = history.messages[i]
        if (next.visible && next.renderedView?.parentElement === list) return next
      }
      return null
    }
    const updateSupportFilterUI = state => {
      if (!state?.panel || !state.supportFilterUI) return
      const filter = state.history.supportFilter || (state.history.supportFilter = createDefaultSupportFilter())
      const ui = state.supportFilterUI
      for (const key of ['membership', 'milestone', 'membershipGift']) {
        const item = ui.types[key]
        if (item) item.input.checked = filter[key] !== false
      }
      for (const tier of SC_COLOR_TIERS) {
        const item = ui.colors[tier.key]
        if (item) item.input.checked = filter.colors?.[tier.key] !== false
      }
    }
    const renderSupportSearch = (state, query) => {
      const { history, list, empty, count, latest } = state
      const filter = history.supportFilter || (history.supportFilter = createDefaultSupportFilter())
      updateSupportFilterUI(state)
      if (!state.inSearchMode) {
        releaseMessageViews(state)
        state.inSearchMode = true
      }
      const words = query.split(/\s+/u)
      const hits = history.messages
        .filter(record => record.retained && matchesSupportFilter(record, filter) &&
          words.every(word => supportSearchText(record).includes(word)))
        .sort((a, b) => a.createdAt - b.createdAt || (a.order || 0) - (b.order || 0))
      const shown = new Set(hits)
      for (const record of state.searchShown || []) if (!shown.has(record)) unmountRecordView(state, record)
      let index = 0
      const scrollTop = list.scrollTop
      for (const record of shown) {
        const view = record.view
        if (record.renderedView && record.renderedView !== view) {
          state.authorObserver?.unobserve(record.renderedView)
          state.messageResizeObserver?.unobserve(record.renderedView)
          record.renderedView.remove()
        }
        view.hidden = false
        if (!$('.ytcf-locate', view)) {
          const locate = element('button', { type: 'button', class: 'ytcf-locate',
            'aria-label': '在完整 SC／會員紀錄中定位這則訊息' }, ['定位'])
          locate.addEventListener('click', () => locateSupportRecord(state, record.storageId))
          view.appendChild(locate)
        }
        const existing = list.children[index++]
        if (existing !== view) {
          if (existing) existing.insertAdjacentElement('beforebegin', view)
          else list.appendChild(view)
        }
        record.renderedView = view
        record.visible = true
        state.messageResizeObserver?.observe(view)
        supportAuthorViews.set(view, { history, record })
        if (state.authorObserver) state.authorObserver.observe(view)
        else queueSupportAuthor(history, record)
      }
      state.searchShown = shown
      state.visibleCount = shown.size
      history.dirty.clear()
      history.removed.clear()
      state.renderedHistory = null
      empty.hidden = shown.size > 0
      empty.textContent = '找不到符合搜尋的 SC 或會員紀錄。'
      count.textContent = `${hits.length} 則符合`
      if (history.follow) list.scrollTop = list.scrollHeight
      else list.scrollTop = scrollTop
      latest.hidden = history.follow
      rememberReaderPosition(state)
    }

    const renderMessages = (state, rebuild = false) => {
      cancelMessageRender(state)
      cancelListFollow(state)
      const { history, list, empty, count, latest } = state
      const query = history.supportOnly ? normalizeSearch(history.supportSearch) : ''
      if (query) { renderSupportSearch(state, query); return }
      if (state.inSearchMode) releaseMessageViews(state)
      if (history.supportOnly) {
        history.supportFilter ||= createDefaultSupportFilter()
        updateSupportFilterUI(state)
        const hasAnySupport = history.messages.some(record => record.retained && record.supportEvent)
        empty.textContent = hasAnySupport ? '找不到符合篩選條件的 SC 或會員紀錄。' : '尚未收到 SC 或會員事件。'
      } else {
        empty.textContent = '尚無符合條件的發言。新增目標帳號後開始收集。'
      }
      const filterKey = JSON.stringify([history.settings, history.supportOnly, history.supportOnly ? history.supportFilter : null])
      const full = rebuild || state.renderedHistory !== history || state.filterKey !== filterKey
      if (full) state.visibleCount = 0
      for (const record of history.removed) {
        if (!full && record.renderedView?.parentElement === list && record.visible) state.visibleCount--
        unmountRecordView(state, record)
      }
      history.removed.clear()
      let visibleIndex = 0
      let tailOrder = full ? -Infinity : (state.mountedTailOrder ?? -Infinity)
      for (const record of full ? history.messages : history.dirty) {
        const oldView = record.renderedView
        const wasVisible = oldView?.parentElement === list && record.visible
        const show = history.supportOnly ? matchesSupportFilter(record, history.supportFilter) : matchesFilter(record, history.settings)
        state.visibleCount += Number(show) - (full ? 0 : Number(!!wasVisible))
        if (!show) {
          unmountRecordView(state, record)
          continue
        }
        const view = record.view
        if (view.hidden) view.hidden = false
        if (oldView && oldView !== view) {
          state.authorObserver?.unobserve(oldView)
          state.messageResizeObserver?.unobserve(oldView)
          if (!full && oldView.parentElement === list) oldView.replaceWith(view)
          else oldView.remove()
        }
        if (full) {
          const existing = list.children[visibleIndex++]
          if (existing !== view) {
            if (existing) existing.insertAdjacentElement('beforebegin', view)
            else list.appendChild(view)
          }
          tailOrder = record.order
        } else if (view.parentElement !== list) {
          if (record.order > tailOrder) {
            list.appendChild(view)
            tailOrder = record.order
          } else {
            const next = findNextMountedRecord(history, record, list)
            if (next) next.renderedView.insertAdjacentElement('beforebegin', view)
            else {
              list.appendChild(view)
              tailOrder = Math.max(tailOrder, record.order)
            }
          }
        }
        record.renderedView = view
        record.visible = true
        state.messageResizeObserver?.observe(view)
        if (history.supportOnly) {
          supportAuthorViews.set(view, { history, record })
          if (state.authorObserver) state.authorObserver.observe(view)
          else queueSupportAuthor(history, record)
        } else state.authorObserver?.unobserve(view)
      }
      state.mountedTailOrder = tailOrder
      history.dirty.clear()
      state.renderedHistory = history
      state.filterKey = filterKey
      empty.hidden = state.visibleCount > 0
      const countText = `${state.visibleCount} 則`
      if (count.textContent !== countText) count.textContent = countText
      // All row writes finish before the one layout read needed for following.
      if (history.follow) list.scrollTop = list.scrollHeight
      latest.hidden = history.follow
      rememberReaderPosition(state)
    }

    const scheduleMessageRender = state => {
      if (!state.history.enabled || document.hidden || state.renderFrame) return
      cancelListFollow(state)
      state.renderFrame = requestAnimationFrame(() => {
        state.renderFrame = 0
        if (mounted === state && state.history.enabled && !document.hidden) renderMessages(state)
      })
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
        state.latest.hidden = true
        rememberReaderPosition(state)
      })
    }
    const releaseMessageViews = state => {
      clearLocatedRecord(state)
      state.authorObserver?.disconnect()
      state.messageResizeObserver?.disconnect()
      cancelListFollow(state)
      cancelMessageRender(state)
      for (const record of new Set([...state.history.messages, ...state.history.removed, ...(state.searchShown || [])])) {
        const view = record.renderedView || ('_hasView' in record ? record._hydratedView : record.view)
        if (view) $('.ytcf-locate', view)?.remove()
        record.renderedView?.remove()
        record.renderedView = null
        record.visible = false
      }
      state.inSearchMode = false
      state.searchShown = null
      state.renderedHistory = null
      state.mountedTailOrder = -Infinity
      state.history.removed.clear()
    }

    const clearLocatedRecord = state => {
      clearTimeout(state.locationTimer)
      state.locatedView?.removeAttribute('data-ytcf-located')
      state.locatedView?.removeAttribute('tabindex')
      state.locatedView = null
      state.locationTimer = 0
      state.locationPinned = false
    }
    const locateSupportRecord = (state, storageId) => {
      const { history, list } = state
      if (!history.enabled || !history.supportOnly) return false
      const record = history.byStorageId?.get(storageId) ||
        history.messages.find(row => row.storageId === storageId)
      if (!record || !record.retained || !record.supportEvent || record.createdAt + RETENTION_MS <= Date.now()) return false
      history.supportFilter ||= createDefaultSupportFilter()
      if (!matchesSupportFilter(record, history.supportFilter)) {
        if (record.supportEvent === 'superChat' || record.supportEvent === 'superSticker') {
          const tier = getRecordColorTier(record)
          if (tier) history.supportFilter.colors[tier] = true
          else for (const item of SC_COLOR_TIERS) history.supportFilter.colors[item.key] = true
        } else history.supportFilter[record.supportEvent] = true
        updateSupportFilterUI(state)
      }
      history.supportSearch = ''
      if (state.supportSearch) state.supportSearch.value = ''
      history.follow = false
      renderMessages(state, true)
      clearLocatedRecord(state)
      state.locationPinned = true
      const view = record.view
      state.locatedView = view
      view.setAttribute('data-ytcf-located', '')
      view.setAttribute('tabindex', '-1')
      view.focus({ preventScroll: true })
      const rowBounds = view.getBoundingClientRect()
      const listBounds = list.getBoundingClientRect()
      list.scrollTop = Math.max(0, list.scrollTop + rowBounds.top - listBounds.top - (list.clientHeight - rowBounds.height) / 2)
      rememberReaderPosition(state)
      state.locationTimer = setTimeout(() => {
        view.removeAttribute('data-ytcf-located')
        view.removeAttribute('tabindex')
        state.locatedView = null
        state.locationTimer = 0
      }, 3000)
      return true
    }

    const handleMessageVisibility = () => {
      if (!mounted) return
      if (document.hidden) { cancelMessageRender(mounted); cancelListFollow(mounted) }
      else {
        if (mounted.history.dirty.size || mounted.history.removed.size || mounted.history.supportSearch) scheduleMessageRender(mounted)
        scheduleListFollow(mounted)
      }
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

    const rememberReaderPosition = state => {
      const { history, list } = state
      if (!history.enabled || !state.readerReady || state.readerRestoring || state.panel.hidden || !list.isConnected) return
      const position = { top: list.scrollTop, follow: history.follow }
      if (history.follow) state.followScrollTop = position.top
      if (!history.follow) {
        const top = list.getBoundingClientRect().top
        const children = list.children
        let low = 0
        let high = children.length
        while (low < high) {
          const mid = (low + high) >> 1
          const child = children[mid]
          if (!child.hidden && child.getBoundingClientRect().bottom > top) high = mid
          else low = mid + 1
        }
        let anchor = children[low]
        while (anchor && (anchor.hidden || anchor.getBoundingClientRect().bottom <= top)) anchor = children[++low]
        if (!anchor && children.length) {
          for (let i = 0; i < children.length; i++) {
            const candidate = children[i]
            if (!candidate.hidden && candidate.getBoundingClientRect().bottom > top) { anchor = candidate; break }
          }
        }
        const record = anchor ? (viewRecords.get(anchor) || history.messages.find(row => row.renderedView === anchor)) : null
        position.anchor = record?.storageId
        position.offset = anchor ? anchor.getBoundingClientRect().top - top : 0
      }
      history.readerPositions ||= {}
      history.readerPositions[history.supportOnly ? 'support' : 'filtered'] = position
    }
    const restoreReaderPosition = (state, position) => {
      const { history, list } = state
      state.readerRestoring = true
      history.follow = position?.follow ?? true
      renderMessages(state, true)
      if (!history.follow) {
        const record = history.byStorageId?.get(position.anchor) ||
          history.messages.find(row => row.storageId === position.anchor)
        if (record?.renderedView?.parentElement === list && !record.renderedView.hidden) {
          list.scrollTop += record.renderedView.getBoundingClientRect().top - list.getBoundingClientRect().top - position.offset
        } else list.scrollTop = position.top
      }
      // Ignore the scroll event generated by restoring a paused viewport.
      // A real wheel, pointer, touch or keyboard gesture releases this guard.
      state.locationPinned = !history.follow
      state.readerReady = true
      state.readerRestoring = false
      rememberReaderPosition(state)
    }
    const setEnabled = (state, enabled, supportOnly = false) => {
      rememberReaderPosition(state)
      clearLocatedRecord(state)
      state.authorObserver?.disconnect()
      state.messageResizeObserver?.disconnect()
      cancelListFollow(state)
      state.readerScrollIntent = false
      cancelMessageRender(state)
      closeAuthorCard()
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
      updateArchiveStatus(state.history)
      setPanelLayer(state, enabled)
      state.button.setAttribute('aria-pressed', String(enabled && !supportOnly))
      state.scButton?.setAttribute('aria-pressed', String(enabled && supportOnly))
      state.panel.setAttribute('aria-label', supportOnly ? 'SC／會員紀錄' : '指定用戶聊天室')
      const summary = $('.ytcf-target-summary', state.panel)
      const title = $('.ytcf-sc-title', state.panel)
      if (summary) summary.hidden = supportOnly
      if (title) title.hidden = !supportOnly
      if (state.supportSearch) {
        state.supportSearch.parentElement.hidden = !supportOnly
        state.supportSearch.value = state.history.supportSearch || ''
      }
      if (supportOnly) updateSupportFilterUI(state)
      if (supportOnly) {
        const targets = $('.ytcf-targets', state.panel)
        if (targets) targets.hidden = true
        summary?.setAttribute('aria-expanded', 'false')
        state.panel.classList.remove('ytcf-managing')
      }
      if (state.empty) state.empty.textContent = supportOnly ? '本次頁面尚未收到 SC 或會員事件。'
        : '尚無符合條件的發言。新增目標帳號後開始收集。'
      if (enabled) restoreReaderPosition(state, state.history.readerPositions?.[supportOnly ? 'support' : 'filtered'])
    }

    const showTargetStatus = (state, message = '') => {
      clearTimeout(state.statusTimer)
      state.status.textContent = message
      state.statusTimer = message ? setTimeout(() => {
        state.status.textContent = ''
        state.statusTimer = 0
      }, 3000) : 0
    }

    const resolveTargetIdentity = (user, state = mounted) => {
      const target = normalizeAccount(user)
      if (!target) return Promise.resolve(null)
      if (targetResolveRequests.has(target)) return targetResolveRequests.get(target)
      const retryAt = targetResolveRetryAt.get(target) || 0
      if (retryAt > Date.now()) return Promise.resolve(null)
      const info = getTargetMetadata(target, state?.history)
      const isId = /^UC[\w-]{22}$/.test(target)
      if (info.channelId && info.handle && info.name && !(isId && info.handle === info.handle.toLowerCase())) {
        return Promise.resolve(info)
      }
      const request = (async () => {
        let resolved = null
        try {
          if (isId) {
            const profile = await getProfile(target)
            if (profile) resolved = { channelId: target, handle: profile.handle, name: profile.title }
          } else if (info.channelId) {
            const profile = await getProfile(info.channelId)
            if (profile) resolved = { channelId: info.channelId, handle: profile.handle || info.handle, name: profile.title }
          } else {
            resolved = await resolveHandle(target)
          }
          if (resolved && (resolved.channelId || resolved.name || resolved.handle)) {
            targetResolveRetryAt.delete(target)
            recordTargetProfile({ ...resolved, alias: target }, true)
          } else {
            targetResolveRetryAt.set(target, Date.now() + TARGET_PROFILE_FAIL_TTL)
          }
        } catch (_) {
          targetResolveRetryAt.set(target, Date.now() + TARGET_PROFILE_FAIL_TTL)
        }
        return resolved
      })()
      targetResolveRequests.set(target, request)
      request.finally(() => {
        targetResolveRequests.delete(target)
        if (mounted?.panel?.isConnected) renderTargets(mounted)
      })
      return request
    }

    const resolveMissingTargets = (state = mounted) => {
      if (!state?.history?.settings) return []
      const { users = [], excludedUsers = [] } = state.history.settings
      const tasks = []
      let started = false
      for (const user of new Set([...users, ...excludedUsers])) {
        const info = getTargetMetadata(user, state.history)
        if (info.channelId && info.handle && info.name) continue
        if ((targetResolveRetryAt.get(user) || 0) > Date.now()) continue
        const before = targetResolveRequests.has(user)
        tasks.push(resolveTargetIdentity(user, state))
        if (!before && targetResolveRequests.has(user)) started = true
      }
      if (started && state.panel?.isConnected) renderTargets(state)
      return tasks
    }

    const renderTargets = (state) => {
      const { panel, history } = state
      const exclude = state.targetMode === 'exclude'
      const { settings } = history
      const targets = exclude ? settings.excludedUsers || [] : settings.users
      const includeButton = $('.ytcf-mode-include', panel)
      const excludeButton = $('.ytcf-mode-exclude', panel)
      includeButton.textContent = `＋ 包含（${settings.users.length}）`
      excludeButton.textContent = `－ 排除（${(settings.excludedUsers || []).length}）`
      includeButton.setAttribute('aria-pressed', String(!exclude))
      excludeButton.setAttribute('aria-pressed', String(exclude))
      const rawQuery = $('[name="search-users"]', panel).value.trim().toLowerCase()
      const rows = targets.map(user => {
        const info = getTargetMetadata(user, history)
        const nameText = info.name || (info.pending ? '載入頻道名稱…' : '名稱未取得')
        const handleText = info.handle || (user.startsWith('@') ? user : (info.pending ? '查詢 @帳號中…' : '@帳號未取得'))
        const idText = info.channelId || (/^UC[\w-]{22}$/.test(user) ? user : (info.pending ? '查詢 UCID 中…' : 'UCID 未取得'))
        return { user, info, nameText, handleText, idText }
      }).filter(({ user, info }) => {
        if (!rawQuery) return true
        return [info.name, info.handle, info.channelId, user]
          .some(field => typeof field === 'string' && field.toLowerCase().includes(rawQuery))
      }).sort((a, b) => a.user.localeCompare(b.user))
      const list = $('.ytcf-target-list', panel)
      list.setAttribute('aria-label', exclude ? '排除帳號清單' : '包含帳號清單')
      list.replaceChildren()
      for (const { user, info, nameText, handleText, idText } of rows) {
        const row = document.createElement('li')
        row.dataset.targetUser = user
        const details = element('div', { class: 'ytcf-target-info' }, [
          element('span', { class: 'ytcf-target-name' }, [nameText]),
          element('span', { class: 'ytcf-target-handle' }, [handleText]),
          element('span', { class: 'ytcf-target-id' }, [idText]),
        ])
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = '移除'
        remove.setAttribute('aria-label', `移除 ${info.name || info.handle || user}`)
        remove.addEventListener('click', () => {
          state.updateSettings(changeTargetUsers(history.settings, user, true, exclude),
            exclude ? `已取消排除 ${user}。` : `已移除 ${user}。`)
        })
        row.appendChild(details)
        row.appendChild(remove)
        list.appendChild(row)
      }
      const empty = $('.ytcf-target-empty', panel)
      empty.hidden = rows.length > 0
      empty.textContent = targets.length ? '找不到符合搜尋的帳號。'
        : exclude ? '尚未排除任何帳號。' : '尚未新增目標帳號。'
    }

    const createPanel = (state) => {
      const panel = document.createElement('section')
      panel.className = 'ytcf-panel'
      panel.setAttribute('aria-label', '指定用戶聊天室')
      const makeScCheckbox = ({ id, attrName, attrValue, text = '', swatch = null }) => {
        const input = element('input', { type: 'checkbox', id, [attrName]: attrValue })
        const label = element('label', { for: id, ...(swatch ? { title: `Super Chat ${swatch.label}` } : {}) }, swatch
          ? [
              element('span', { class: `ytcf-sc-swatch ytcf-sc-swatch--${swatch.key}`, 'aria-hidden': 'true' }),
              element('span', { class: 'ytcf-visually-hidden' }, [swatch.label]),
            ]
          : [text])
        const option = element('span', { class: 'ytcf-sc-option' }, [input, label])
        return { option, input }
      }
      const supportTypes = {
        membership: makeScCheckbox({ id: 'ytcf-sc-filter-membership', attrName: 'data-sc-type', attrValue: 'membership', text: 'membership' }),
        milestone: makeScCheckbox({ id: 'ytcf-sc-filter-milestone', attrName: 'data-sc-type', attrValue: 'milestone', text: 'milestone' }),
        membershipGift: makeScCheckbox({ id: 'ytcf-sc-filter-membership-gift', attrName: 'data-sc-type', attrValue: 'membershipGift', text: 'membershipGift' }),
      }
      const supportColors = Object.fromEntries(SC_COLOR_TIERS.map(tier => [tier.key, makeScCheckbox({
        id: `ytcf-sc-color-${tier.key}`, attrName: 'data-sc-color', attrValue: tier.key, swatch: tier,
      })]))
      const supportFilterFieldset = element('fieldset', { class: 'ytcf-sc-filters' }, [
        element('legend', { class: 'ytcf-visually-hidden' }, ['篩選事件類型與金額顏色']),
        element('div', { class: 'ytcf-sc-filter-row' }, [
          supportTypes.membership.option, supportTypes.milestone.option, supportTypes.membershipGift.option,
        ]),
        element('div', { class: 'ytcf-sc-filter-row ytcf-sc-filter-row--colors', role: 'group', 'aria-label': 'Super Chat 顏色' }, [
          ...SC_COLOR_TIERS.map(tier => supportColors[tier.key].option),
        ]),
      ])
      panel.appendChild(element('div', { class: 'ytcf-toolbar' }, [
        element('div', { class: 'ytcf-options' }, [
          element('button', { type: 'button', class: 'ytcf-target-summary',
            'aria-controls': 'ytcf-target-settings', 'aria-expanded': 'false' }, ['目標用戶']),
          element('span', { class: 'ytcf-sc-title', hidden: '' }, ['SC／會員紀錄']),
          element('span', { class: 'ytcf-count' }),
        ]),
        element('search', { class: 'ytcf-sc-search', hidden: '' }, [
          element('label', { class: 'ytcf-visually-hidden', for: 'ytcf-input-search-support' }, ['搜尋 SC／會員紀錄']),
          element('input', { id: 'ytcf-input-search-support', type: 'search', name: 'search-support',
            placeholder: '搜尋頻道名稱、@帳號或留言', autocomplete: 'off', autocorrect: 'off',
            autocapitalize: 'none', spellcheck: 'false' }),
          supportFilterFieldset,
        ]),
        element('div', { class: 'ytcf-targets', id: 'ytcf-target-settings', hidden: '' }, [
          element('div', { class: 'ytcf-roles' }, [
            element('span', { class: 'ytcf-role' }, [
              element('input', { type: 'checkbox', id: 'ytcf-role-broadcaster', name: 'broadcaster' }),
              element('label', { for: 'ytcf-role-broadcaster' }, ['Broadcaster']),
            ]),
            element('span', { class: 'ytcf-role' }, [
              element('input', { type: 'checkbox', id: 'ytcf-role-moderators', name: 'moderators' }),
              element('label', { for: 'ytcf-role-moderators' }, ['Moderator']),
            ]),
            element('span', { class: 'ytcf-role' }, [
              element('input', { type: 'checkbox', id: 'ytcf-role-verified', name: 'verified' }),
              element('label', { for: 'ytcf-role-verified' }, ['Verified']),
            ]),
          ]),
          element('div', { class: 'ytcf-target-modes', role: 'group', 'aria-label': '帳號篩選方式' }, [
            element('button', { type: 'button', class: 'ytcf-mode-include' }, ['＋ 包含']),
            element('button', { type: 'button', class: 'ytcf-mode-exclude' }, ['－ 排除']),
          ]),
          element('form', { class: 'ytcf-users' }, [
            element('label', { for: 'ytcf-input-users' }, ['新增帳號']),
            element('input', { id: 'ytcf-input-users', type: 'text', name: 'users',
              placeholder: '頻道 ID、網址或 @帳號', autocomplete: 'off', autocorrect: 'off',
              autocapitalize: 'none', spellcheck: 'false' }),
            element('button', { type: 'submit' }, ['新增']),
          ]),
          element('search', { class: 'ytcf-target-search' }, [
            element('label', { for: 'ytcf-input-search-users' }, ['搜尋帳號']),
            element('input', { id: 'ytcf-input-search-users', type: 'search', name: 'search-users',
              placeholder: '搜尋名稱、@帳號或 UCID', autocomplete: 'off', autocorrect: 'off',
              autocapitalize: 'none', spellcheck: 'false' }),
          ]),
          element('ul', { class: 'ytcf-target-list', 'aria-label': '目標用戶清單' }),
          element('p', { class: 'ytcf-target-empty' }),
          element('p', { class: 'ytcf-target-status', role: 'status' }),
        ]),
      ]))
      panel.appendChild(element('p', { class: 'ytcf-empty' }, ['尚無符合條件的發言。新增目標帳號後開始收集。']))
      panel.appendChild(element('p', { class: 'ytcf-history-status', hidden: '' }))
      panel.appendChild(element('div', { class: 'ytcf-list', role: 'log',
        'aria-label': '篩選後的聊天訊息', 'aria-live': 'off' }))
      panel.appendChild(element('button', { class: 'ytcf-latest', type: 'button', hidden: '' }, ['回到最新訊息']))
      state.panel = panel
      state.list = $('.ytcf-list', panel)
      if (typeof ResizeObserver === 'function') {
        state.messageResizeObserver = new ResizeObserver(() => scheduleListFollow(state))
      }
      // Image loading may change a row after the initial append and scroll.
      // Capture load/error too, including browsers without ResizeObserver.
      state.list.addEventListener('load', () => scheduleListFollow(state), true)
      state.list.addEventListener('error', () => scheduleListFollow(state), true)
      if (typeof IntersectionObserver === 'function') {
        state.authorObserver = new IntersectionObserver(entries => {
          for (const entry of entries) {
            const author = entry.isIntersecting && supportAuthorViews.get(entry.target)
            if (author) queueSupportAuthor(author.history, author.record)
          }
        }, { root: state.list, rootMargin: '100px' })
      }
      state.empty = $('.ytcf-empty', panel)
      state.count = $('.ytcf-count', panel)
      state.latest = $('.ytcf-latest', panel)
      state.supportSearch = $('[name="search-support"]', panel)
      state.supportFilterUI = { types: supportTypes, colors: supportColors }
      const applySupportFilterChange = () => {
        clearLocatedRecord(state)
        updateSupportFilterUI(state)
        if (state.history.enabled && state.history.supportOnly) renderMessages(state, true)
      }
      for (const [key, item] of Object.entries(supportTypes)) {
        item.input.addEventListener('change', () => {
          state.history.supportFilter ||= createDefaultSupportFilter()
          state.history.supportFilter[key] = Boolean(item.input.checked)
          applySupportFilterChange()
        })
      }
      for (const tier of SC_COLOR_TIERS) {
        supportColors[tier.key].input.addEventListener('change', () => {
          const filter = state.history.supportFilter ||= createDefaultSupportFilter()
          filter.colors[tier.key] = Boolean(supportColors[tier.key].input.checked)
          applySupportFilterChange()
        })
      }
      updateSupportFilterUI(state)
      state.supportSearch.addEventListener('input', () => {
        clearLocatedRecord(state)
        state.history.supportSearch = state.supportSearch.value
        state.readerScrollIntent = false
        state.history.follow = true
        if (state.history.enabled && state.history.supportOnly) renderMessages(state, true)
      })
      const moderators = $('[name="moderators"]', panel)
      const broadcaster = $('[name="broadcaster"]', panel)
      const verified = $('[name="verified"]', panel)
      const users = $('[name="users"]', panel)
      moderators.checked = state.history.settings.moderators
      broadcaster.checked = state.history.settings.broadcaster
      verified.checked = state.history.settings.verified
      state.status = $('.ytcf-target-status', panel)
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
        moderators: moderators.checked, broadcaster: broadcaster.checked, verified: verified.checked })
      for (const input of [moderators, broadcaster, verified]) input.addEventListener('change', applyRoles)
      $('.ytcf-users', panel).addEventListener('submit', event => {
        event.preventDefault()
        const rawInput = users.value.trim()
        const exclude = state.targetMode === 'exclude'
        const key = exclude ? 'excludedUsers' : 'users'
        const account = normalizeAccount(rawInput)
        const nextSettings = changeTargetUsers(state.history.settings, rawInput, false, exclude)
        if (!nextSettings) {
          showTargetStatus(state, '請輸入一個頻道 ID、頻道網址或 @帳號。')
          return
        }
        const rawHandle = displayHandle(rawInput) || extractHandleFromUrl(rawInput)
        if (account.startsWith('@') && rawHandle) recordTargetProfile({ handle: rawHandle, alias: account }, true)
        const added = nextSettings[key].length - (state.history.settings[key] || []).length
        state.updateSettings(nextSettings, added
          ? exclude ? '已排除帳號。' : '已新增帳號。'
          : '此帳號已在名單中。')
        users.value = ''
        if (account) resolveTargetIdentity(account, state)
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
        if (open) resolveMissingTargets(state)
      }
      targetButton.addEventListener('click', () => setTargetsOpen(targetSettings.hidden))
      setTargetsOpen(false)
      renderTargets(state)
      state.list.addEventListener('scroll', () => {
        if (!state.history.enabled || state.panel.hidden || state.readerRestoring || state.locationPinned) return
        const nearBottom = state.list.scrollHeight - state.list.scrollTop - state.list.clientHeight < 40
        const movedUp = Number.isFinite(state.followScrollTop) && state.list.scrollTop < state.followScrollTop - 1
        // A delayed image can invalidate a pending programmatic scroll event.
        // Preserve following unless the reader actually moves up or scrolls.
        if (state.history.follow && !state.readerScrollIntent && !movedUp && !nearBottom) {
          scheduleListFollow(state)
          return
        }
        state.history.follow = nearBottom
        if (nearBottom) state.readerScrollIntent = false
        state.latest.hidden = state.history.follow
        rememberReaderPosition(state)
      }, { passive: true })
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        state.list.addEventListener(event, () => {
          state.locationPinned = false
          state.readerScrollIntent = true
        }, { passive: true })
      }
      state.latest.addEventListener('click', () => {
        clearLocatedRecord(state)
        state.readerScrollIntent = false
        state.history.follow = true
        renderMessages(state)
      })
      state.host.appendChild(panel)
    }

    const unmount = () => {
      if (!mounted) return
      rememberReaderPosition(mounted)
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
      if (mounted && (mounted.history.channel !== channel || mounted.history.scope !== unresolvedScope || mounted.header !== header ||
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
        attributes: true, attributeFilter: ['author-type', 'type', 'is-deleted', 'author-external-channel-id', 'style', 'src', 'alt'] })
      mounted = state
      setEnabled(state, state.history.enabled, state.history.supportOnly)
      updateArchiveStatus(state.history)
    }

    const scheduleRefresh = () => {
      if (refreshTimer) return
      refreshTimer = setTimeout(() => { refreshTimer = 0; refresh() }, 250)
    }

    const reloadTargetProfiles = () => {
      targetProfilesLoaded = false
      targetProfiles.clear()
      loadTargetProfiles()
      if (!mounted) return
      renderTargets(mounted)
      if (!$('.ytcf-targets', mounted.panel)?.hidden) resolveMissingTargets(mounted)
    }

    const syncSettings = () => {
      pageSettings = null
      const settings = loadSettings()
      for (const history of histories.values()) {
        history.settings = { ...settings, users: [...settings.users], excludedUsers: [...settings.excludedUsers] }
      }
      if (!mounted) return
      const { panel, history } = mounted
      $('[name="moderators"]', panel).checked = history.settings.moderators
      $('[name="broadcaster"]', panel).checked = history.settings.broadcaster
      $('[name="verified"]', panel).checked = history.settings.verified
      renderTargets(mounted)
      if (!$('.ytcf-targets', panel)?.hidden) resolveMissingTargets(mounted)
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
      #yt-chat-tweaks-filter-button:focus-visible, #yt-chat-tweaks-sc-button:focus-visible, .ytcf-panel button:focus-visible, .ytcf-panel input:focus-visible { outline: 2px solid var(--yt-live-chat-button-default-text-color, #065fd4); outline-offset: -2px; }
      .ytcf-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .ytcf-host { position: relative; }
      .ytcf-active > .ytcf-source { pointer-events: none; isolation: isolate; }
      .ytcf-panel { position: absolute; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; box-sizing: border-box; min-height: 0; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-background-color, #fff); font-size: 13px; }
      .ytcf-panel [hidden], .ytcf-panel[hidden] { display: none !important; }
      .ytcf-toolbar { flex: 0 0 auto; padding: 10px; border-bottom: 1px solid var(--yt-live-chat-message-input-border-color, #8884); }
      .ytcf-options { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; font-size: 12px; }
      .ytcf-roles { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex-shrink: 0; margin-bottom: 12px; }
      .ytcf-role { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
      .ytcf-roles input { width: 13px; height: 13px; margin: 0; accent-color: var(--yt-live-chat-button-default-text-color, #065fd4); }
      .ytcf-count { margin-left: auto; flex-shrink: 0; white-space: nowrap; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-sc-search { display: block; margin-top: 8px; }
      .ytcf-sc-search input[type="search"] { box-sizing: border-box; width: 100%; min-width: 0; height: 30px; padding: 5px 8px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: inherit; background: var(--yt-live-chat-background-color, #fff); font: inherit; }
      .ytcf-sc-filters { display: flex; flex-direction: column; gap: 2px; border: 0; margin: 6px 0 0; padding: 0; min-width: 0; font-size: 12px; }
      .ytcf-sc-filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; }
      .ytcf-sc-filter-row--colors { gap: 2px 6px; }
      .ytcf-sc-option { display: inline-flex; align-items: center; gap: 3px; min-block-size: 24px; white-space: nowrap; }
      .ytcf-sc-option input[type="checkbox"] { width: 13px; height: 13px; margin: 0; flex: none; accent-color: var(--yt-live-chat-link-text-color, var(--yt-live-chat-button-default-text-color, #065fd4)); cursor: pointer; }
      .ytcf-sc-option input[type="checkbox"]:focus-visible { outline: 2px solid var(--yt-live-chat-button-default-text-color, #065fd4); outline-offset: 1px; }
      .ytcf-sc-option label { display: inline-flex; align-items: center; gap: 2px; min-block-size: 24px; cursor: pointer; }
      .ytcf-sc-swatch { display: inline-block; width: 13px; height: 13px; flex: none; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--yt-live-chat-primary-text-color, #0f0f0f) 32%, transparent); border-radius: 2px; forced-color-adjust: none; }
      ${SC_COLOR_TIERS.map(tier => `.ytcf-sc-swatch--${tier.key} { background-color: ${tier.color}; }`).join(' ')}
      .ytcf-panel:not(.ytcf-managing) > .ytcf-toolbar { max-height: 52%; overflow-y: auto; }
      .ytcf-users { display: flex; align-items: center; gap: 6px; }
      .ytcf-users label { white-space: nowrap; }
      .ytcf-users input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: inherit; background: var(--yt-live-chat-background-color, #fff); font-size: 12px; }
      .ytcf-panel button { padding: 6px 10px; border: 0; border-radius: 4px; color: var(--yt-live-chat-button-default-text-color, #065fd4); background: var(--yt-live-chat-action-panel-background-color, #8882); cursor: pointer; }
      .ytcf-users input, .ytcf-users button[type="submit"] { box-sizing: border-box; height: 30px; font: inherit; }
      .ytcf-users button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0 10px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-button-default-background-color, #8882); font-weight: 600; line-height: 1; }
      .ytcf-users button[type="submit"]:hover { filter: brightness(1.2); }
      .ytcf-empty { padding: 16px 12px; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-history-status { margin: 0; padding: 8px 12px; color: var(--yt-live-chat-secondary-text-color, #606060); font-size: 12px; }
      .ytcf-list, .ytcf-target-list, .ytcf-panel > .ytcf-toolbar { --ytcf-scrollbar-thumb: color-mix(in srgb, var(--yt-live-chat-primary-text-color, #0f0f0f) 42%, transparent); --ytcf-scrollbar-track: transparent; scrollbar-color: var(--ytcf-scrollbar-thumb) var(--ytcf-scrollbar-track); scrollbar-width: auto; overscroll-behavior: contain; }
      @media (prefers-contrast: more) {
        .ytcf-list, .ytcf-target-list, .ytcf-panel > .ytcf-toolbar { --ytcf-scrollbar-thumb: var(--yt-live-chat-primary-text-color, #0f0f0f); --ytcf-scrollbar-track: var(--yt-live-chat-background-color, #fff); }
        #yt-chat-tweaks-filter-button:focus-visible, #yt-chat-tweaks-sc-button:focus-visible, .ytcf-panel button:focus-visible, .ytcf-panel input:focus-visible { outline: 2px solid currentColor; }
        .ytcf-sc-swatch { border-color: var(--yt-live-chat-primary-text-color, #0f0f0f); }
      }
      .ytcf-list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 6px 0; }
      .ytcf-message { padding: 5px 10px; overflow-wrap: anywhere; line-height: 1.6; content-visibility: auto; contain-intrinsic-size: auto none auto 36px; }
      .ytcf-message:has(> .ytcf-locate) { position: relative; padding-right: 58px; }
      .ytcf-panel .ytcf-locate { position: absolute; top: 5px; right: 6px; padding: 2px 6px; border: 1px solid currentColor; color: inherit; background: transparent; font: inherit; font-size: 11px; }
      .ytcf-message[data-ytcf-located] { outline: 2px solid #ffb300; outline-offset: -2px; box-shadow: inset 0 0 0 4px #0008; }
      /* Lift the handle's @ optically without changing text flow or line height. */
      .ytcf-author .ytcf-handle-at { position: relative; top: -0.08em; }
      .ytcf-author { cursor: pointer; }
      .ytcf-author:hover { text-decoration: underline; }
      .ytcf-author:focus-visible { outline: 2px solid var(--yt-live-chat-link-text-color, #3ea6ff); outline-offset: 2px; }
      .ytcf-message:hover { background: var(--yt-live-chat-action-panel-background-color, #8882); }
      .ytcf-support-event { margin: 3px 6px; border-radius: 4px; }
      .ytcf-support-event .ytcf-body a, .ytcf-event-details a { color: inherit; text-decoration: underline; }
      .ytcf-event-header { display: block; }
      .ytcf-event-details { display: inline !important; }
      .ytcf-amount { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 4px; color: var(--yt-live-chat-primary-text-color, #0f0f0f); background: var(--yt-live-chat-action-panel-background-color, #8882); font-weight: 600; }
      .ytuc-card {
        position: fixed; inset: auto; margin: 0; padding: 0; z-index: 2200; box-sizing: border-box; overflow: auto; overscroll-behavior: contain;
        border: 2px solid var(--yt-live-chat-secondary-text-color, #606060);
        border-color: color-mix(in srgb, var(--yt-live-chat-primary-text-color, #0f0f0f) 35%, var(--yt-live-chat-background-color, #fff));
        border-radius: 8px; box-shadow: 0 12px 40px #0009, 0 2px 8px #0006;
        color: var(--yt-live-chat-primary-text-color, #0f0f0f);
        background: var(--yt-live-chat-background-color, #fff);
        background: color-mix(in srgb, var(--yt-live-chat-background-color, #fff) 90%, var(--yt-live-chat-primary-text-color, #0f0f0f));
        font: 13px/1.5 Roboto, Arial, sans-serif;
        opacity: 1;
        transition-property: opacity, transform, display, overlay;
        transition-duration: 0.16s;
        transition-timing-function: ease-out;
        transition-behavior: allow-discrete;
      }
      @media (prefers-reduced-motion: no-preference) {
        .ytuc-card { transform: scale(1); }
        @starting-style { .ytuc-card { opacity: 0; transform: scale(0.96); } }
      }
      @media (prefers-reduced-motion: reduce) {
        .ytuc-card { transition-duration: 0.08s; }
        @starting-style { .ytuc-card { opacity: 0; } }
      }
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
      .ytuc-actions { padding: 12px; border-top: 1px solid var(--yt-live-chat-message-input-border-color, #8883); border-top-color: color-mix(in srgb, var(--yt-live-chat-primary-text-color, #0f0f0f) 24%, var(--yt-live-chat-background-color, #fff)); background: var(--yt-live-chat-action-panel-background-color, #8881); background: color-mix(in srgb, var(--yt-live-chat-background-color, #fff) 84%, var(--yt-live-chat-primary-text-color, #0f0f0f)); }
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
      .ytcf-message .ytcf-sticker { display: block !important; margin-top: 4px; }
      .ytcf-sticker img { display: block; max-width: min(100%, 144px); max-height: 96px; width: auto; height: auto; object-fit: contain; }
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
      .ytcf-target-summary::before { content: '▸'; content: '▸' / ''; }
      .ytcf-target-summary[aria-expanded="true"]::before { content: '▾'; content: '▾' / ''; }
      .ytcf-targets { margin-top: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .ytcf-targets > :not(.ytcf-target-list) { flex-shrink: 0; }
      .ytcf-target-modes { display: flex; gap: 6px; margin-bottom: 8px; }
      .ytcf-target-modes button { flex: 1; padding: 4px 8px; color: inherit; background: var(--yt-live-chat-action-panel-background-color, #8882); font-size: 12px; }
      .ytcf-target-modes button[aria-pressed="true"] { color: var(--yt-live-chat-background-color, #fff); background: var(--yt-live-chat-button-default-text-color, #065fd4); }
      .ytcf-target-search { display: flex; align-items: center; gap: 6px; margin-top: 8px; white-space: nowrap; }
      .ytcf-target-search input { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; padding: 5px 8px; border: 1px solid var(--yt-live-chat-message-input-border-color, #8886); border-radius: 4px; color: inherit; background: var(--yt-live-chat-background-color, #fff); font-size: 12px; }
      .ytcf-target-list { list-style: none; padding: 0; margin: 6px 0 0; flex: 1; min-height: 40px; overflow-y: auto; }
      .ytcf-target-list li { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--yt-live-chat-message-input-border-color, #8882); }
      .ytcf-target-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
      .ytcf-target-info span { overflow-wrap: anywhere; }
      .ytcf-target-name { font-weight: 600; color: var(--yt-live-chat-primary-text-color, #0f0f0f); }
      .ytcf-target-handle, .ytcf-target-id { font-size: 11px; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-target-id { font-family: ui-monospace, Consolas, monospace; user-select: text; }
      .ytcf-target-list button { flex-shrink: 0; padding: 3px 8px; background: var(--yt-live-chat-action-panel-background-color, #8882); color: inherit; font-size: 11px; }
      .ytcf-target-empty, .ytcf-target-status { margin: 6px 0 0; font-size: 11px; color: var(--yt-live-chat-secondary-text-color, #606060); }
      .ytcf-target-status:empty { display: none; }
    `
    ;(document.head || document.documentElement).appendChild(style)
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY || event.key === null) syncSettings()
      if (event.key === TARGET_PROFILES_KEY || event.key === null) reloadTargetProfiles()
    })
    window.addEventListener('resize', schedulePanelPosition)
    document.addEventListener('visibilitychange', () => {
      handleMessageVisibility()
      if (!document.hidden) pruneHistories()
      else for (const history of histories.values()) flushHistory(history)
    })
    window.addEventListener('pagehide', () => {
      for (const history of histories.values()) flushHistory(history)
    })
    window.addEventListener('scroll', schedulePanelPosition, true)
    setInterval(refresh, 1000)
    setInterval(pruneHistories, 60000)
    refresh()
    // End YouTube chat filtering.
  })()

  copyEmoji()
  setupAutoFollow()
})()
