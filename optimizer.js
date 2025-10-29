// ==UserScript==
// @name          Youtube Optimizer
// @version       0.1.0
// @description   Optimize youtube!
// @author        Derek
// @match         *://www.youtube.com/*
// @run-at        document-start
// @grant         GM_addStyle
// @grant         GM_download
// @noframes
// ==/UserScript==

// 貼圖排序

(() => {
  'use strict'

  GM_addStyle(`
    #voice-search-button,
    button.ytp-autonav-toggle,
    button.ytp-subtitles-button,
    button.ytp-remote-button,
    .html5-endscreen,
    .ytp-ce-element-show,
    .ytp-fullscreen-grid,
    #secondary-inner>#related {
      display: none !important;
    }
    #categories-wrapper img {
      loading: lazy !important;
    }
    #top-row > #owner {
      max-width: 65% !important;
      min-width: 65% !important;
    }
    #top-row > #actions {
      max-width: 35% !important;
      min-width: 35% !important;
    }
    #float-bar {
      width: 100%;
      height: 20px;
      position: relative;
      z-index: 9999;
      text-align: center;
      color: #fff;
      font-size: initial;
      opacity: 0.9;
      background-color: rgba(0, 0, 0, 0.5);
      display: none;
    }
  `)

  const $ = (element) => document.querySelector(element)
  const SVG_NS = 'http://www.w3.org/2000/svg'
  let container, sizeBtn, videoTitle, floatingBar, moviePlayer, progressBar, videoPlayer
  let floatingBarTimer = 0
  const data = {
    svg: {
      loop: 'm 13,13 h 10 v 3 l 4,-4 -4,-4 v 3 H 11 v 6 h 2 z M 23,23 H 13 v -3 l -4,4 4,4 v -3 h 12 v -6 h -2 z',
      photo: 'M480-260q75 0 127.5-52.5T660-440q0-75-52.5-127.5T480-620q-75 0-127.5 52.5T300-440q0 75 52.5 127.5T480-260Zm0-80q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29ZM160-120q-33 0-56.5-23.5T80-200v-480q0-33 23.5-56.5T160-760h126l74-80h240l74 80h126q33 0 56.5 23.5T880-680v480q0 33-23.5 56.5T800-120H160Zm0-80h640v-480H638l-73-80H395l-73 80H160v480Zm320-240Z',
      speed: 'M418-340q24 24 62 23.5t56-27.5l224-336-336 224q-27 18-28.5 55t22.5 61Zm62-460q59 0 113.5 16.5T696-734l-76 48q-33-17-68.5-25.5T480-720q-133 0-226.5 93.5T160-400q0 42 11.5 83t32.5 77h552q23-38 33.5-79t10.5-85q0-36-8.5-70T766-540l48-76q30 47 47.5 100T880-406q1 57-13 109t-41 99q-11 18-30 28t-40 10H204q-21 0-40-10t-30-28q-26-45-40-95.5T80-400q0-83 31.5-155.5t86-127Q252-737 325-768.5T480-800Zm7 313Z',
      theater: 'M 5.390625,7.9999999 V 26.179687 h 25.21875 V 7.9999999 Z M 7.410156,10.009766 H 28.589844 V 24.169922 H 7.410156 Z m 4.040294,4.050342 h 3.029835 V 12.040219 H 9.430562 v 5.049722 h 2.019888 z m 15.118897,3.029833 h -2.019888 v 3.029834 h -3.029834 v 2.019889 h 5.049722 z'
    },
    removeList: ['aria-label', 'aria-controls', 'aria-expanded', 'aria-haspopup', 'data-tooltip-target-id'],
  }

  const twoDigit = (num) => num.toString().padStart(2, '0')

  const timeFormat = (time) => {
    const second = time % 60
    const minute = Math.floor((time / 60) % 60)
    const hour = Math.floor(time / 3600)
    if (hour > 0) return `${hour}h${twoDigit(minute)}m${twoDigit(second)}s`
    else if (minute > 0) return `${minute}m${twoDigit(second)}s`
    else return `${twoDigit(second)}s`
  }

  const getFloatingBar = () => {
    let floatingBarElement = $('#float-bar')
    if (!floatingBarElement) {
      floatingBarElement = document.createElement('div')
      floatingBarElement.id = 'float-bar'
      floatingBarElement.style.position = 'absolute'
      floatingBarElement.style.top = '0px'
      moviePlayer.appendChild(floatingBarElement)
    }
    return floatingBarElement
  }

  const showFloatingBar = (timer, text) => {
    if (timer) clearTimeout(timer)
    floatingBar.textContent = text
    floatingBar.style.display = 'block'
    return setTimeout(() => { floatingBar.style.display = 'none'; }, 2000)

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
    const fileName = `${videoTitle.textContent} - ${timeFormat(progressBar.getAttribute('aria-valuenow'))}`.replace(/[\/\\:*\?"<>|]/g, '_')
    GM_download({
      url: canvas.toDataURL(),
      name: `ScreenShot/${fileName}.png`,
    })
  }

  const changeVolume = (e) => {
    e.preventDefault()
    let volume = moviePlayer.getVolume()
    moviePlayer.unMute(true)
    volume = e.deltaY < 0 ? volume + 5 : volume - 5
    volume = Math.max(0, Math.min(100, volume))
    moviePlayer.setVolume(volume, true)
    floatingBarTimer = showFloatingBar(floatingBarTimer, volume)
  }

  const changeSpeed = (e) => {
    e.preventDefault()
    let playbackRate = videoPlayer.playbackRate
    playbackRate = e.deltaY < 0 ? (playbackRate + 0.1).toFixed(1) : Math.max((playbackRate - 0.1).toFixed(1), 0.1)
    videoPlayer.playbackRate = playbackRate
    floatingBarTimer = showFloatingBar(floatingBarTimer, String(playbackRate) + 'x')
  }

  const resetSpeed = () => {
    videoPlayer.playbackRate = 1
    floatingBarTimer = showFloatingBar(floatingBarTimer, '1x')
  }

  const addButtons = () => {
    if (!$('button.ytp-photo-button')) {
      let photoBtn = document.createElement('button')
      photoBtn.className = 'ytp-photo-button ytp-button'
      photoBtn.title = '截圖'

      let photoSvg = document.createElementNS(SVG_NS, 'svg')
      photoSvg.setAttribute('height', '24')
      photoSvg.setAttribute('viewBox', '30 -930 900 900')
      photoSvg.setAttribute('width', '24')

      let photoPath = document.createElementNS(SVG_NS, 'path')
      photoPath.setAttribute('d', data.svg.photo)
      photoPath.setAttribute('fill', 'white')

      photoSvg.appendChild(photoPath)
      photoBtn.appendChild(photoSvg)
      sizeBtn.parentElement.insertBefore(photoBtn, sizeBtn)
      photoBtn.addEventListener('click', screenShot)
    }

    if (!$('button.ytp-speed-button')) {
      let speedBtn = document.createElement('button')
      speedBtn.className = 'ytp-speed-button ytp-button'
      speedBtn.title = '播放速度'

      let speedSvg = document.createElementNS(SVG_NS, 'svg')
      speedSvg.setAttribute('height', '24')
      speedSvg.setAttribute('viewBox', '55 -905 850 850')
      speedSvg.setAttribute('width', '24')

      let speedPath = document.createElementNS(SVG_NS, 'path')
      speedPath.setAttribute('d', data.svg.speed)
      speedPath.setAttribute('fill', 'white')

      speedSvg.appendChild(speedPath)
      speedBtn.appendChild(speedSvg)
      sizeBtn.parentElement.insertBefore(speedBtn, sizeBtn)
      speedBtn.addEventListener('wheel', changeSpeed)
      speedBtn.addEventListener('click', resetSpeed)
    }

    if (!container.wheelListener) {
      container.addEventListener('wheel', changeVolume)
      container.keydownListener = 'true'
    }

    if (!document.keydownListener) {
      document.addEventListener('keydown', (event) => {
        if (event.altKey && event.key === 's') screenShot()
      })
      document.keydownListener = 'true'
    }
  }

  const waitElements = () => {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        container = $('.html5-video-container')
        sizeBtn = $('button.ytp-size-button')
        videoTitle = $('a.ytp-title-link')
        moviePlayer = $('#movie_player')
        progressBar = $('.ytp-progress-bar')
        videoPlayer = $('video')

        if (container && sizeBtn && videoTitle && moviePlayer && progressBar && videoPlayer.getAttribute('style')) {
          observer.disconnect()
          resolve()
        }
      })
      observer.observe(document.body, { attributes: false, childList: true, subtree: true })
      setTimeout(() => {
        observer.disconnect()
        resolve()
      }, 5000)
    })
  }

  const main = async () => {
    await waitElements()
    floatingBar = getFloatingBar()
    addButtons()
  }

  document.addEventListener('yt-navigate-finish', (event) => {
    const url = event.detail.endpoint.commandMetadata.webCommandMetadata.url
    if (url.startsWith('/shorts/')) window.location.href = window.location.href.replace('shorts/', 'watch?v=')
    else if (url.startsWith('/watch?v=') || url.startsWith('/live/')) main()
  })
})()
