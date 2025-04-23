// ==UserScript==
// @name          Twitch ScreenShot
// @version       0.1.0
// @description   ScreenShot
// @author        Derek
// @match         *://www.twitch.tv/*
// @run-at        document-start
// @grant         GM_download
// @noframes
// ==/UserScript==

(() => {
  'use strict'

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
    let settingBtn = $('button[aria-label=設定]').parentElement.parentElement.parentElement
    let photoBtn = settingBtn.cloneNode(true)
    const svgContainer = photoBtn.querySelector('svg')
    svgContainer.setAttribute('viewBox', '6 5 23 23')
    const path = svgContainer.querySelector('path[fill-rule=evenodd]')
    path.setAttribute('d', 'M 26.079999,10.02 H 22.878298 L 21.029999,8 h -6.06 l -1.8483,2.02 H 9.9200015 c -1.111,0 -2.02,0.909 -2.02,2.02 v 12.12 c 0,1.111 0.909,2.02 2.02,2.02 H 26.079999 c 1.111,0 2.019999,-0.909 2.019999,-2.02 V 12.04 c 0,-1.111 -0.909,-2.02 -2.019999,-2.02 z m 0,14.14 H 9.9200015 V 12.04 h 4.0904965 l 1.8483,-2.02 h 4.2824 l 1.8483,2.02 h 4.0905 z m -8.08,-11.11 c -2.7876,0 -5.05,2.2624 -5.05,5.05 0,2.7876 2.2624,5.05 5.05,5.05 2.7876,0 5.049999,-2.2624 5.049999,-5.05 0,-2.7876 -2.262399,-5.05 -5.049999,-5.05 z m 0,8.08 c -1.6665,0 -3.03,-1.3635 -3.03,-3.03 0,-1.6665 1.3635,-3.03 3.03,-3.03 1.6665,0 3.03,1.3635 3.03,3.03 0,1.6665 -1.3635,3.03 -3.03,3.03 z')
    controlBar.insertBefore(photoBtn, settingBtn)
    photoBtn.addEventListener('click', screenShot)
  })()
})()
