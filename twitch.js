// ==UserScript==
// @name          Twitch Optimizer
// @version       0.1.0
// @description   ScreenShot
// @author        Derek
// @match         *://www.twitch.tv/*
// @run-at        document-start
// @grant         GM_addStyle
// @grant         GM_download
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  GM_addStyle(`
    div.chat-room__content > div:has(~ div[aria-label="聊天訊息"]) {
      display: none !important;
    }
    div.chat-scrollable-area__message-container > div:has(img[alt="管理員"]):not(:has(div[data-a-user="nightbot"], div[data-a-user="moobot"])) {
      background: #18181b !important;
      border-radius: 4px !important;
      position: sticky !important;
      top: -1px !important;
      z-index: 9999 !important;
    }
    div.chat-scrollable-area__message-container > div:has(img[alt="管理員"]):not(:has(div[data-a-user="nightbot"], div[data-a-user="moobot"])) div.chat-line__message-highlight {
      background: rgba(255, 255, 255, 0.16) !important;
    }
  `)

  let $ = (element) => document.querySelector(element)
  let controlBar, videoTitle, videoPlayer

  const formatTime = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}h${now.getMinutes().toString().padStart(2, '0')}m${now.getSeconds().toString().padStart(2, '0')}s`
  }

  const screenShot = () => {
    let canvas = document.createElement('canvas')
    let context = canvas.getContext('2d')

    canvas.width = videoPlayer.videoWidth
    canvas.height = videoPlayer.videoHeight
    context.drawImage(videoPlayer, 0, 0)

    canvas.toBlob((blob) => {
      const item = new ClipboardItem({ "image/png": blob })
      navigator.clipboard.write([item])
    })

    const fileName = `${videoTitle.getAttribute('content')} - ${formatTime()}`.replace(/[\/\\:*\?"<>|]/g, '_')
    GM_download({
      url: canvas.toDataURL(),
      name: `ScreenShot/${fileName}.png`,
    })
  }

  const waitElements = () => {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        videoPlayer = $('video')
        videoTitle = $('meta[name=description]')
        controlBar = $('.player-controls__right-control-group')
        if (controlBar && videoPlayer && videoTitle) {
          if (controlBar.querySelectorAll('path').length === 6) {
            observer.disconnect()
            resolve()
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => {
        observer.disconnect()
        resolve()
      }, 5000)
    })
  }

  (async () => {
    await waitElements()
    let settingBtn = $('div.video-ref div.player-controls__right-control-group > div:has(button[aria-label="設定"])')
    let photoBtn = settingBtn.cloneNode(true)
    const svgContainer = photoBtn.querySelector('svg')
    svgContainer.setAttribute('viewBox', '0 -960 960 960')
    const pathContainer = svgContainer.querySelector('path[fill-rule=evenodd]')
    pathContainer.setAttribute('d', 'M480-260q75 0 127.5-52.5T660-440q0-75-52.5-127.5T480-620q-75 0-127.5 52.5T300-440q0 75 52.5 127.5T480-260Zm0-80q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29ZM160-120q-33 0-56.5-23.5T80-200v-480q0-33 23.5-56.5T160-760h126l74-80h240l74 80h126q33 0 56.5 23.5T880-680v480q0 33-23.5 56.5T800-120H160Zm0-80h640v-480H638l-73-80H395l-73 80H160v480Zm320-240Z')
    controlBar.insertBefore(photoBtn, settingBtn)
    photoBtn.addEventListener('click', screenShot)
  })()
})()
