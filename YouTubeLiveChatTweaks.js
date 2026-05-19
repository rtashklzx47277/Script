// ==UserScript==
// @name        YouTube Live Chat Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.1.0
// @description Tweaks YouTube live chat layout, emoji copying, adds a reload button, and keeps latest chat followed unless you scroll up manually.
// @author      Derek
// @match       *://www.youtube.com/live_chat*
// @match       *://www.youtube.com/live_chat_replay*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)

  let contextMenu
  let closeButton
  let itemScroller
  let items
  let shouldFollowLatest = true
  let userScrollTimer = 0
  let followLatestFrame = 0

  const injectCSS = () => {
    const styleElement = document.createElement('style')
    styleElement.textContent = `
      yt-live-chat-app {
        min-width: 100% !important;
        min-height: 100% !important;
      }

      ytd-engagement-panel-section-list-renderer.yt-live-chat-app {
        max-width: 100% !important;
        min-width: 100% !important;
      }

      #picker-buttons > yt-reaction-control-panel-overlay-view-model,
      #ticker #container > #left-arrow-container,
      #ticker #container > #right-arrow-container,
      #message #lower-buy-button,
      #message #footer-button,
      #message #opt-in-prompt {
        display: none !important;
      }

      #ticker #container > #ticker-bar {
        padding: 2px 1em 12px 1em !important;
        overflow-x: auto !important;
      }

      #items > yt-live-chat-text-message-renderer,
      #items > ytd-sponsorships-live-chat-gift-redemption-announcement-renderer {
        padding: 4px 1em !important;
      }

      #items > yt-live-chat-text-message-renderer > #author-photo,
      #items > ytd-sponsorships-live-chat-gift-redemption-announcement-renderer > #author-photo {
        margin: 0 1em 0 0 !important;
      }

      #pickers > #emoji {
        max-height: 130px !important;
        margin: 0 -24px 0 !important;
      }

      #categories yt-emoji-picker-category-renderer {
        margin-right: var(--yt-emoji-picker-category-margin-left) !important;
      }

      #reload-button {
        display: inline-flex !important;
      }
    `

    document.head.appendChild(styleElement)
  }

  const debounce = (func, delay) => {
    let timeout

    return (...args) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => func(...args), delay)
    }
  }

  const copyEmoji = () => {
    const handleSelectionChange = debounce(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
      if (
        items &&
        !items.contains(selection.anchorNode) &&
        !items.contains(selection.focusNode)
      ) {
        return
      }

      document
        .querySelectorAll('img[shared-tooltip-text][alt]:not([data-copyable])')
        .forEach((img) => {
          if (!selection.containsNode(img, true)) return

          const alt = img.alt
          const sharedTooltipText = img.getAttribute('shared-tooltip-text')

          if (!alt || !sharedTooltipText || alt === sharedTooltipText) return

          img.dataset.copyable = 'true'

          if (sharedTooltipText.includes(alt)) {
            img.alt = sharedTooltipText
          }
        })
    }, 100)

    document.addEventListener('selectionchange', handleSelectionChange)
  }

  const addReloadButton = () => {
    if ($('#reload-button') || !closeButton) return

    const reloadButton = closeButton.cloneNode(true)
    reloadButton.id = 'reload-button'

    const button = reloadButton.querySelector('button')
    const path = reloadButton.querySelector('svg path')

    if (button) {
      button.title = '重新載入'
      button.setAttribute('aria-label', '重新載入')
    }

    if (path) {
      path.setAttribute(
        'd',
        'M12 5V2L8 6l4 4V7c2.76 0 5 2.24 5 5a5 5 0 1 1-8.66-3.46L6.92 7.12A7 7 0 1 0 19 12c0-3.87-3.13-7-7-7Z'
      )
    }

    reloadButton.addEventListener('click', () => location.reload())
    closeButton.insertAdjacentElement('beforebegin', reloadButton)
  }

  const isNearBottom = () => {
    if (!itemScroller) return true

    return itemScroller.scrollHeight - itemScroller.scrollTop - itemScroller.clientHeight <= 4
  }

  const scrollToBottom = () => {
    if (!itemScroller) return

    itemScroller.scrollTop = itemScroller.scrollHeight
  }

  const scheduleScrollToBottom = () => {
    if (followLatestFrame) return

    followLatestFrame = requestAnimationFrame(() => {
      followLatestFrame = 0
      scrollToBottom()
    })
  }

  const getShowMoreButton = () =>
    $('#show-more') ||
    $('#show-more-button')

  const clickShowMoreIfNeeded = () => {
    if (!shouldFollowLatest) return

    const showMoreButton = getShowMoreButton()
    if (!showMoreButton) return

    const style = getComputedStyle(showMoreButton)
    if (style.display === 'none' || style.visibility === 'hidden') return

    showMoreButton.click()
  }

  const markUserScroll = () => {
    clearTimeout(userScrollTimer)

    userScrollTimer = setTimeout(() => {
      shouldFollowLatest = isNearBottom()
    }, 50)
  }

  const followLatest = () => {
    const observer = new MutationObserver(() => {
      clickShowMoreIfNeeded()

      if (shouldFollowLatest) {
        scheduleScrollToBottom()
      }
    })

    observer.observe(items, {
      childList: true,
      subtree: false,
    })

    const resizeObserver = new ResizeObserver(() => {
      if (shouldFollowLatest) {
        scheduleScrollToBottom()
      }
    })

    resizeObserver.observe(items)

    itemScroller.addEventListener('wheel', markUserScroll, { passive: true })
    itemScroller.addEventListener('touchmove', markUserScroll, { passive: true })
    itemScroller.addEventListener('pointerup', markUserScroll, { passive: true })

    itemScroller.addEventListener('scroll', () => {
      if (!shouldFollowLatest && isNearBottom()) {
        shouldFollowLatest = true
      }
    }, { passive: true })

    shouldFollowLatest = isNearBottom()

    if (shouldFollowLatest) {
      scrollToBottom()
    }
  }

  const waitElements = () => {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        contextMenu = $('#live-chat-header-context-menu')
        closeButton = $('#close-button')
        itemScroller = $('#item-scroller')
        items = $('#items')

        if (contextMenu && closeButton && itemScroller && items) {
          observer.disconnect()
          resolve()
        }
      })

      observer.observe(document, {
        attributes: false,
        childList: true,
        subtree: true,
      })
    })
  }

  ;(async () => {
    injectCSS()
    copyEmoji()
    await waitElements()
    addReloadButton()
    followLatest()
  })()
})()
