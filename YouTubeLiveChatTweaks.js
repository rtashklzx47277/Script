// ==UserScript==
// @name        YouTube Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.2.0
// @description Tweaks YouTube live chat layout, emoji copying, adds a reload button, and keeps latest chat followed unless you scroll up manually.
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
  let itemsObserver
  let showMoreObserver

  let scroller
  let items
  let showMoreButton

  let followLatest = true
  let pointerScrolling = false

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

    #yt-chat-tweaks-reload-button:hover {
      background-color: rgba(255, 255, 255, 0.1) !important;
    }

    #yt-chat-tweaks-reload-button:active {
      background-color: rgba(255, 255, 255, 0.2) !important;
    }

    #yt-chat-tweaks-reload-button svg {
      fill: currentColor !important;
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
    reloadButton.title = '重新載入聊天室'
    reloadButton.setAttribute('aria-label', '重新載入聊天室')
    reloadButton.appendChild(createReloadIcon())

    reloadButton.addEventListener('click', () => {
      location.reload()
    })

    contextMenu.insertAdjacentElement('afterend', reloadButton)
    syncReloadButtonColor()
  }

  const collectHeaderElements = () => {
    contextMenu = $(SELECTORS.contextMenu)
    closeButton = $(SELECTORS.closeButton)

    return Boolean(contextMenu && closeButton)
  }

  const waitHeaderElements = () =>
    new Promise((resolve) => {
      if (collectHeaderElements()) {
        resolve(true)
        return
      }

      const observer = new MutationObserver(() => {
        if (collectHeaderElements()) {
          observer.disconnect()
          resolve(true)
        }
      })

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      })

      setTimeout(() => {
        observer.disconnect()
        resolve(collectHeaderElements())
      }, 5000)
    })

  const observeHeaderButtons = () => {
    const parent = contextMenu?.parentElement
    if (!parent) return

    headerButtonsObserver?.disconnect()

    headerButtonsObserver = new MutationObserver(() => {
      collectHeaderElements()
      addReloadButton()
      syncReloadButtonColor()
    })

    headerButtonsObserver.observe(parent, {
      childList: true,
    })
  }

  const copyEmoji = () => {
    const handleSelectionChange = debounce(() => {
      const selection = window.getSelection()
      if (!selection || !selection.rangeCount || selection.isCollapsed) return

      const range = selection.getRangeAt(0)

      // Walk the real nodes intersecting the selection instead of looking
      // clones up by id: emoji ids repeat across messages and getElementById
      // only ever returns the first occurrence.
      for (const img of document.querySelectorAll(EMOJI_SELECTOR)) {
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
    if (!scroller) return

    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight
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
  }

  const handlePointerCancel = () => {
    pointerScrolling = false
  }

  const handleScrollKeys = (event) => {
    if (isEditableTarget(event.target)) return

    if (SCROLL_UP_KEYS.has(event.key)) {
      followLatest = false
    }
  }

  const bindAutoFollow = () => {
    scroller = $(SELECTORS.scroller)
    items = $(SELECTORS.items)
    showMoreButton = $(SELECTORS.showMore)

    if (!scroller || !items || !showMoreButton) return false

    scroller.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaY < 0) {
          followLatest = false
        }
      },
      { passive: true }
    )

    scroller.addEventListener('pointerdown', () => {
      pointerScrolling = true
    })

    scroller.addEventListener('scroll', (event) => {
      if (isNearBottom(event.currentTarget)) {
        followLatest = true
      } else if (pointerScrolling) {
        followLatest = false
      }
    })

    showMoreButton.addEventListener(
      'click',
      () => {
        followLatest = true
      },
      true
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

    bindAutoFollow()

    // YouTube can replace the chat internals wholesale (e.g. switching
    // Top chat / Live chat), which strands listeners and observers on dead
    // nodes. Keep watching and rebind whenever the bound nodes drop out of
    // the document; this also covers the initial wait before chat renders.
    const observer = new MutationObserver(() => {
      if (
        scroller?.isConnected &&
        items?.isConnected &&
        showMoreButton?.isConnected
      ) {
        return
      }

      bindAutoFollow()
    })

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  }

  ;(async () => {
    const found = await waitHeaderElements()
    if (!found) return

    addReloadButton()
    observeHeaderButtons()
    copyEmoji()
    setupAutoFollow()
  })()
})()
