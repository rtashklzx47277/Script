// ==UserScript==
// @name        Twitch ScreenShot
// @version     0.1.0
// @description ScreenShot
// @author      Derek
// @match       *://www.twitch.tv/*
// @grant       GM_download
// @noframes
// ==/UserScript==

let videoTitle = null
let settingBtn = null
let videoPlayer = null

let $ = (element) => document.querySelector(element)

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

  const now = new Date()
  const hours = now.getHours()
  const minutes = now.getMinutes()
  const seconds = now.getSeconds()
  const formattedHours = hours < 10 ? '0' + hours : hours
  const formattedMinutes = minutes < 10 ? '0' + minutes : minutes
  const formattedSeconds = seconds < 10 ? '0' + seconds : seconds
  const formattedTime = `${formattedHours}h${formattedMinutes}m${formattedSeconds}s`

  const fileName = `${videoTitle.textContent} - ${formattedTime}`.replace(/[\/\\:*\?"<>|]/g, '_')
  GM_download({
    url: canvas.toDataURL(),
    name: `ScreenShot/${fileName}.png`,
  })
}

const waitElements = () => {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      videoPlayer = $('video')
      videoTitle = $('h2[data-a-target=stream-title]')
      settingBtn = $('.player-controls__right-control-group')
      if (settingBtn && videoPlayer && videoTitle && $('.player-controls__right-control-group').querySelectorAll('path').length === 6) {
        observer.disconnect()
        resolve()
      }
    })
    observer.observe(document.body, { attributes: false, childList: true, subtree: true })
  })
}


await waitElements()
let photoBtn = settingBtn.children[1].cloneNode(true)
photoBtn.lastElementChild.firstElementChild.firstElementChild.firstElementChild.firstElementChild.firstElementChild.lastElementChild.setAttribute('viewBox', '6 5 23 23')
photoBtn.lastElementChild.firstElementChild.firstElementChild.firstElementChild.firstElementChild.firstElementChild.lastElementChild.firstElementChild.lastElementChild.setAttribute('d', 'M 26.079999,10.02 H 22.878298 L 21.029999,8 h -6.06 l -1.8483,2.02 H 9.9200015 c -1.111,0 -2.02,0.909 -2.02,2.02 v 12.12 c 0,1.111 0.909,2.02 2.02,2.02 H 26.079999 c 1.111,0 2.019999,-0.909 2.019999,-2.02 V 12.04 c 0,-1.111 -0.909,-2.02 -2.019999,-2.02 z m 0,14.14 H 9.9200015 V 12.04 h 4.0904965 l 1.8483,-2.02 h 4.2824 l 1.8483,2.02 h 4.0905 z m -8.08,-11.11 c -2.7876,0 -5.05,2.2624 -5.05,5.05 0,2.7876 2.2624,5.05 5.05,5.05 2.7876,0 5.049999,-2.2624 5.049999,-5.05 0,-2.7876 -2.262399,-5.05 -5.049999,-5.05 z m 0,8.08 c -1.6665,0 -3.03,-1.3635 -3.03,-3.03 0,-1.6665 1.3635,-3.03 3.03,-3.03 1.6665,0 3.03,1.3635 3.03,3.03 0,1.6665 -1.3635,3.03 -3.03,3.03 z')
settingBtn.insertBefore(photoBtn, settingBtn.children[2])
photoBtn.addEventListener('click', screenShot)
