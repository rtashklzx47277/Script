// ==UserScript==
// @name               Youtube Live Chat Helper
// @version            0.1.0
// @description        sticky comment & copy emoji & hide heart
// @author             Derek
// @match              *://www.youtube.com/live_chat*
// @match              *://www.youtube.com/live_chat_replay*
// @grant              none
// ==/UserScript==

const $ = (element) => document.querySelector(element)

const css = `
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

  #ticker #container > #items /* SC列 */ {
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

/* 複製聊天室貼圖 */
const getCloneSelectedNode = () => {
  let selection = window.getSelection()
  if (!selection.rangeCount) return
  return selection.getRangeAt(0).cloneContents()
}

const copyAltToSharedTooltipText = (ele) => {
  let alt = ele.alt
  let sharedTooltipText = ele.getAttribute('shared-tooltip-text')
  if (document.contains(ele) && alt && sharedTooltipText && (alt != sharedTooltipText)) {
    ele.setAttribute('copyable', true)
    if (sharedTooltipText.match(alt)) ele.setAttribute('alt', sharedTooltipText)
  }
}

let toolbar = null

const waitElements = () => {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      toolbar = $('.ytcf-button-wrapper')
      if (toolbar) {
        observer.disconnect()
        resolve()
      }
    })
    observer.observe(document.body, { attributes: false, childList: true, subtree: true })
  })
}

const main = async () => {
  let cssStyle = document.createElement('style')
  cssStyle.setAttribute('id', 'livechat-css')
  cssStyle.textContent = css
  document.body.appendChild(cssStyle)

  /* 複製聊天室貼圖 */
  document.addEventListener('selectionchange', () => {
    let cloneSelectedNode = getCloneSelectedNode()
    if (!cloneSelectedNode) return
    cloneSelectedNode.querySelectorAll('img.emoji[shared-tooltip-text][alt]:not([copyable])').forEach(img => {
      if (img.id && document.querySelector(`#${img.id}`)) copyAltToSharedTooltipText(document.querySelector(`#${img.id}`))
    })
  })

  /* 增加SC列表按鈕及重整按鈕 */
  await waitElements()

  new MutationObserver(() => {
    if (toolbar.style.display === 'none') toolbar.style = ''
  }).observe(toolbar, { attributes: true, attributeFilter: ['style'] })

  toolbar.setAttribute('class', 'ytcf-button-wrapper')
  toolbar.children[1].setAttribute('class', 'ytcf-launch-button')
  toolbar.children[3].setAttribute('class', 'ytcf-settings-button')

  const innerHTML = document.documentElement.innerHTML
  const videoId = innerHTML.match(/"chat~([A-z0-9_-]{11})"/)
  const channelId = innerHTML.match(/"(UC[A-z0-9_-]{22})\//)

  let superChatBtn = document.createElement('button')
  superChatBtn.setAttribute('class', 'ytcf-super-chat-button')

  let span2 = document.createElement('span')
  span2.textContent = 'Super Chat List'

  superChatBtn.appendChild(span2)
  toolbar.insertBefore(superChatBtn, toolbar.children[2])

  superChatBtn.addEventListener('mousedown', (event) => {
    if (event.button === 0 || event.button === 1) window.open(videoId ? `https://www.hololyzer.net/youtube/realtime/superchat/${videoId[1]}.html` : `https://www.hololyzer.net/youtube/channel/${channelId[1]}.html`)
  })

  let reloadBtn = document.createElement('button')
  reloadBtn.setAttribute('class', 'ytcf-reload-button')

  let span1 = document.createElement('span')
  span1.textContent = 'Reload'

  reloadBtn.appendChild(span1)
  toolbar.insertBefore(reloadBtn, toolbar.children[3].nextSibling)

  reloadBtn.addEventListener('mousedown', (event) => {
    if (event.button === 0) location.reload()
  })
}

window.addEventListener('load', main)
