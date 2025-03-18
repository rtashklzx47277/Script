// ==UserScript==
// @name         Youtube Optimizer
// @version      0.1.0
// @description  Optimize youtube!
// @author       Derek
// @match        *://www.youtube.com/*
// @run-at       document-body
// @grant        GM_download
// @noframes
// ==/UserScript==

// 貼圖排序

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)
  let container, settingBtn, videoTitle, floatingBar, moviePlayer, progressBar, videoPlayer
  let floatingBarTimer = 0
  const data = {
    svg: {
      loop: 'm 13,13 h 10 v 3 l 4,-4 -4,-4 v 3 H 11 v 6 h 2 z M 23,23 H 13 v -3 l -4,4 4,4 v -3 h 12 v -6 h -2 z',
      photo: 'M 26.079999,10.02 H 22.878298 L 21.029999,8 h -6.06 l -1.8483,2.02 H 9.9200015 c -1.111,0 -2.02,0.909 -2.02,2.02 v 12.12 c 0,1.111 0.909,2.02 2.02,2.02 H 26.079999 c 1.111,0 2.019999,-0.909 2.019999,-2.02 V 12.04 c 0,-1.111 -0.909,-2.02 -2.019999,-2.02 z m 0,14.14 H 9.9200015 V 12.04 h 4.0904965 l 1.8483,-2.02 h 4.2824 l 1.8483,2.02 h 4.0905 z m -8.08,-11.11 c -2.7876,0 -5.05,2.2624 -5.05,5.05 0,2.7876 2.2624,5.05 5.05,5.05 2.7876,0 5.049999,-2.2624 5.049999,-5.05 0,-2.7876 -2.262399,-5.05 -5.049999,-5.05 z m 0,8.08 c -1.6665,0 -3.03,-1.3635 -3.03,-3.03 0,-1.6665 1.3635,-3.03 3.03,-3.03 1.6665,0 3.03,1.3635 3.03,3.03 0,1.6665 -1.3635,3.03 -3.03,3.03 z',
      speed: 'm 27.526463,13.161756 -1.400912,2.107062 a 9.1116182,9.1116182 0 0 1 -0.250569,8.633258 H 10.089103 A 9.1116182,9.1116182 0 0 1 22.059491,11.202758 L 24.166553,9.8018471 A 11.389523,11.389523 0 0 0 8.1301049,25.041029 2.2779046,2.2779046 0 0 0 10.089103,26.179981 H 25.863592 A 2.2779046,2.2779046 0 0 0 27.845369,25.041029 11.389523,11.389523 0 0 0 27.537852,13.150367 Z M 16.376119,20.95219 a 2.2779046,2.2779046 0 0 0 3.223235,0 l 6.446471,-9.669705 -9.669706,6.44647 a 2.2779046,2.2779046 0 0 0 0,3.223235 z',
      theater: 'M 5.390625,7.9999999 V 26.179687 h 25.21875 V 7.9999999 Z M 7.410156,10.009766 H 28.589844 V 24.169922 H 7.410156 Z m 4.040294,4.050342 h 3.029835 V 12.040219 H 9.430562 v 5.049722 h 2.019888 z m 15.118897,3.029833 h -2.019888 v 3.029834 h -3.029834 v 2.019889 h 5.049722 z'
    },
    removeList: ['aria-label', 'aria-controls', 'aria-expanded', 'aria-haspopup', 'data-tooltip-target-id'],
    css: `
    #primary > ytd-section-list-renderer > #contents > ytd-item-section-renderer[is-playlist-video-container],
    button[data-tooltip-target-id="ytp-autonav-toggle-button"],
    button.ytp-miniplayer-button,
    .ytp-subtitles-button,
    #voice-search-button,
    a.ytp-prev-button,
    a.ytp-next-button,
    .html5-endscreen,
    .ytp-ce-element,
    div#related {
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
  `
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
    floatingBarTimer = showFloatingBar(floatingBarTimer,volume)
  }

  const changeSpeed = (e) => {
    e.preventDefault()
    let playbackRate = videoPlayer.playbackRate
    playbackRate = e.deltaY < 0 ? (playbackRate + 0.1).toFixed(1) : Math.max((playbackRate - 0.1).toFixed(1), 0.1)
    videoPlayer.playbackRate = playbackRate
    floatingBarTimer = showFloatingBar(floatingBarTimer,String(playbackRate) + 'x')
  }

  const resetSpeed = () => {
    videoPlayer.playbackRate = 1
    floatingBarTimer = showFloatingBar(floatingBarTimer,'1x')
  }

  const configureButton = (element, title, className, id, svg) => {
    element.title = title
    element.className = `${className} ytp-button`
    element.firstElementChild.lastElementChild.id = `ytp-id-${id}`
    element.firstElementChild.lastElementChild.setAttribute('d', svg)
    element.firstElementChild.firstElementChild.setAttribute('href', `#ytp-id-${id}`)
  }

  const addButtons = () => {
    if (!$('button.ytp-photo-button')) {
      let photoBtn = settingBtn.cloneNode(true)
      configureButton(photoBtn, 'スクリーンショット', 'ytp-photo-button', '97', data.svg.photo)
      settingBtn.parentElement.insertBefore(photoBtn, settingBtn)
      photoBtn.addEventListener('click', screenShot)
    }

    if (!$('button.ytp-speed-button')) {
      let speedBtn = settingBtn.cloneNode(true)
      data.removeList.forEach(attr => speedBtn.removeAttribute(attr))
      configureButton(speedBtn, '再生速度', 'ytp-speed-button', '98', data.svg.speed)
      settingBtn.parentElement.insertBefore(speedBtn, settingBtn)
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
        settingBtn = $('button.ytp-settings-button')
        videoTitle = $('a.ytp-title-link')
        moviePlayer = $('#movie_player')
        progressBar = $('.ytp-progress-bar')
        videoPlayer = $('video')

        if (container && settingBtn && videoTitle && moviePlayer && progressBar && videoPlayer.getAttribute('style')) {
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

  (() => {
    let styleElement = $('#youtube-css')
    if (!styleElement) {
      styleElement = document.createElement('style')
      styleElement.id = 'youtube-css'
      styleElement.textContent = data.css
      document.head.appendChild(styleElement)
    }
  })()

  document.addEventListener('yt-navigate-finish', (event) => {
    const url = event.detail.endpoint.commandMetadata.webCommandMetadata.url
    if (url.startsWith('/shorts/')) window.location.href = window.location.href.replace('shorts/', 'watch?v=')
    else if (url.startsWith('/watch?v=') || url.startsWith('/live/')) main()
  })
})()
