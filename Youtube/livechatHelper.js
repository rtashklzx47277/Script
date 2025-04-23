// ==UserScript==
// @name          Youtube Live Chat Helper
// @version       0.1.0
// @description   sticky comment & copy emoji & hide heart
// @author        Derek
// @match         *://www.youtube.com/live_chat*
// @match         *://www.youtube.com/live_chat_replay*
// @run-at        document-start
// @grant         none
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)
  let toolbar

  const addButtons = () => {
    if ($('.ytcf-reload-button')) return

    const reloadBtn = document.createElement('button')
    reloadBtn.className = 'ytcf-reload-button'
    const span = document.createElement('span')
    span.textContent = '↻'
    reloadBtn.appendChild(span)
    reloadBtn.addEventListener('mousedown', (e) => {
      if (e.button === 0) location.reload()
    })

    const closeBtn = document.createElement('button')
    closeBtn.className = 'ytcf-super-chat-button'
    const span2 = document.createElement('span')
    span2.textContent = 'X'
    closeBtn.appendChild(span2)
    closeBtn.addEventListener('mousedown', (e) => {
      if (e.button === 0) $('#close-button button.yt-spec-button-shape-next')?.click()
    })

    toolbar.append(reloadBtn, closeBtn)
  }

  const setupToolbar = async () => {
    toolbar = await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const ele = $('.ytcf-button-wrapper')
        if (ele) {
          observer.disconnect()
          resolve(ele)
        }
      })
      observer.observe(document, { childList: true, subtree: true })
    })

    toolbar.setAttribute('class', 'ytcf-button-wrapper')
    toolbar.children[1].setAttribute('class', 'ytcf-launch-button')
    toolbar.children[1].firstElementChild.textContent = 'Ytc-Filter'
    toolbar.children[3].setAttribute('class', 'ytcf-settings-button')
    addButtons()

    new MutationObserver(() => {
      if (toolbar.style.display === 'none') toolbar.style = ''
    }).observe(toolbar, { attributes: true, attributeFilter: ['style'] })
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
      if (!selection.rangeCount) return

      const cloneSelectedNode = selection.getRangeAt(0).cloneContents()
      cloneSelectedNode.querySelectorAll('img.emoji[shared-tooltip-text][alt]:not([copyable])').forEach(img => {
        const originalImg = document.querySelector(`#${img.id}`)
        if (!originalImg || !document.contains(originalImg)) return

        const alt = originalImg.alt
        const sharedTooltipText = originalImg.getAttribute('shared-tooltip-text')
        if (alt && sharedTooltipText && alt !== sharedTooltipText) {
          originalImg.setAttribute('copyable', true);
          if (sharedTooltipText.includes(alt)) originalImg.setAttribute('alt', sharedTooltipText);
        }
      })
    }, 100)
    document.addEventListener('selectionchange', handleSelectionChange)
  }

  (async () => {
    let styleElement = document.createElement('style')
    styleElement.textContent = `
      #chat-messages > yt-live-chat-header-renderer,  /* 標頭 */
      #panel-pages #pickers #search-panel, /* 貼圖搜尋 */
      #panel-pages #pickers #category-buttons, /* 類別選擇 */
      #picker-buttons > yt-reaction-control-panel-overlay-view-model, /* 右下愛心 */
      #ticker #container > #left-arrow-container, /* SC列左箭頭 */
      #ticker #container > #right-arrow-container,  /* SC列右箭頭 */
      #message #lower-buy-button, /* 購買SC */
      #message #footer-button, /* 購買會員 */
      #message #opt-in-prompt, /* 購買贈禮 */
      .ytcf-button-wrapper > .static-logo, /* YTCF LOGO */
      .ytcf-button-wrapper > .ytcf-popout-button, /* YTCF Popout */
      .ytcf-button-wrapper .top-bar-icon /* YTCF Icon */ {
        display: none !important;
      }
      #ticker #container > #ticker-bar /* SC列 */ {
        padding: 2px 1em 12px 1em !important;
        overflow-x: auto !important;
      }
      #items > yt-live-chat-text-message-renderer, /* 頭貼左側 */
      #items > ytd-sponsorships-live-chat-gift-redemption-announcement-renderer /* 贈禮頭貼左側 */ {
        padding: 4px 1em !important;
      }
      #items > yt-live-chat-text-message-renderer > #author-photo, /* 頭貼右側 */
      #items > ytd-sponsorships-live-chat-gift-redemption-announcement-renderer > #author-photo /* 贈禮頭貼右側 */ {
        margin: 0 1em 0 0 !important;
      }
      /* 懸浮留言 */
      #item-offset {
        overflow: visible !important;
      }
      #items {
        transform: none !important;
      }
      ytd-engagement-panel-section-list-renderer #content {
        margin-right: 8.5vw !important;
      }
      #item-offset yt-live-chat-text-message-renderer[author-type="owner"],
      #item-offset yt-live-chat-text-message-renderer[author-type="moderator"] {
        background: var(--yt-live-chat-message-highlight-background-color) !important;
        position: sticky !important;
        top: -1px !important;
        z-index: 9999 !important;
      }
      .ytcf-button-wrapper {
        display: flex !important;
        justify-content: space-around !important;
        margin: 5px 0 !important;
      }
      .ytcf-button-wrapper > button {
        border: 2px solid aqua !important;
        border-radius: 5px !important;
        background-color: black !important;
        color: white !important;
      }
      .hyperchat-root .context-menu {
        margin-right: 0 !important;
      }
    `
    document.head.appendChild(styleElement)
    await setupToolbar()
    copyEmoji()
  })()
})()
