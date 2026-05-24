// ==UserScript==
// @name        YouTube Player Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.1.0
// @description Adds player controls, unlocks live DVR, extends long-stream rewind, and provides wheel volume control on YouTube videos.
// @author      Derek
// @match       *://www.youtube.com/*
// @grant       GM_download
// @run-at      document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  // Interop with other scripts that also hook playerResponse.
  const playerResponseDescriptor =
    Object.getOwnPropertyDescriptor(Object.prototype, 'playerResponse')

  const playerResponseGetter =
    playerResponseDescriptor?.get ??
    function () {
      return this[Symbol.for('YouTubePlayerTweaks')]
    }

  const playerResponseSetter =
    playerResponseDescriptor?.set ??
    function (value) {
      this[Symbol.for('YouTubePlayerTweaks')] = value
    }

  const $ = (element) => document.querySelector(element)
  const addStyle = (css) => {
    const styleElement = document.createElement('style')
    styleElement.textContent = css
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const SCREENSHOT_KEY = 's'
  const TOOLTIP_VERTICAL_GAP = 22
  const FEEDBACK_DURATION = 3000
  const LIVE_CATCHUP_TARGET_BUFFER = 0.5
  const LIVE_CATCHUP_RATE = 1.5
  const LIVE_CATCHUP_INTERVAL = 250
  const DEFAULT_MAX_DVR_SECONDS = 43200
  const EXTENDED_MAX_DVR_SECONDS = DEFAULT_MAX_DVR_SECONDS * 14
  const LIVE_DVR_WINDOW_FLAG = 'html5_max_live_dvr_window_plus_margin_secs'

  let container
  let sizeBtn
  let videoTitle
  let moviePlayer
  let progressBar
  let videoPlayer
  let floatingBar
  let tooltip
  let tooltipText
  let tooltipKey
  let liveBtn
  let floatingBarTimer = 0
  let persistentFloatingBarText = ''
  let liveCatchupTimer = 0
  let liveCatchupPreviousRate = null
  let pageController = null

  const data = {
    svg: {
      live: 'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4a2 2 0 0 1 0-4ZM6.34 6.34a8 8 0 0 0 0 11.32l1.42-1.42a6 6 0 0 1 0-8.48L6.34 6.34Zm11.32 0l-1.42 1.42a6 6 0 0 1 0 8.48l1.42 1.42a8 8 0 0 0 0-11.32Z',
      photo: 'M480-260q75 0 127.5-52.5T660-440q0-75-52.5-127.5T480-620q-75 0-127.5 52.5T300-440q0 75 52.5 127.5T480-260Zm0-80q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29ZM160-120q-33 0-56.5-23.5T80-200v-480q0-33 23.5-56.5T160-760h126l74-80h240l74 80h126q33 0 56.5 23.5T880-680v480q0 33-23.5 56.5T800-120H160Zm0-80h640v-480H638l-73-80H395l-73 80H160v480Zm320-240Z',
      speed: 'M418-340q24 24 62 23.5t56-27.5l224-336-336 224q-27 18-28.5 55t22.5 61Zm62-460q59 0 113.5 16.5T696-734l-76 48q-33-17-68.5-25.5T480-720q-133 0-226.5 93.5T160-400q0 42 11.5 83t32.5 77h552q23-38 33.5-79t10.5-85q0-36-8.5-70T766-540l48-76q30 47 47.5 100T880-406q1 57-13 109t-41 99q-11 18-30 28t-40 10H204q-21 0-40-10t-30-28q-26-45-40-95.5T80-400q0-83 31.5-155.5t86-127Q252-737 325-768.5T480-800Zm7 313Z',
    },
  }

  addStyle(`
    #voice-search-button,
    button.ytp-autonav-toggle,
    button.ytp-subtitles-button,
    button.ytp-remote-button,
    .html5-endscreen,
    .ytp-ce-element-show,
    .ytp-fullscreen-grid,
    #below ytd-merch-shelf-renderer {
      display: none !important;
    }

    #yt-player-tweaks-float-bar {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 70;
      display: none;
      width: 100%;
      height: 20px;
      color: #fff;
      background-color: rgba(0, 0, 0, 0.5);
      text-align: center;
      font-size: initial;
      line-height: 20px;
      opacity: 0.9;
      pointer-events: none;
    }

    #yt-player-tweaks-tooltip {
      display: none;
      pointer-events: none;
      z-index: 80;
    }

    #yt-player-tweaks-tooltip[data-visible="true"] {
      display: block;
    }

    #yt-player-tweaks-tooltip[data-has-key="false"]
      .ytp-tooltip-bottom-text > .ytp-tooltip-keyboard-shortcut {
      display: none !important;
    }
  `)

  const isWatchPage = () =>
    location.pathname === '/watch' ||
    location.pathname.startsWith('/live/')

  const isEditableTarget = (target) =>
    target instanceof HTMLElement &&
    (
      target.isContentEditable ||
      target.matches('input, textarea, [role="textbox"]')
    )

  const twoDigit = (num) => num.toString().padStart(2, '0')

  const timeFormat = (time) => {
    const totalSeconds = Math.floor(Number(time) || 0)
    const second = totalSeconds % 60
    const minute = Math.floor((totalSeconds / 60) % 60)
    const hour = Math.floor(totalSeconds / 3600)

    if (hour > 0) return `${hour}h${twoDigit(minute)}m${twoDigit(second)}s`
    if (minute > 0) return `${minute}m${twoDigit(second)}s`
    return `${twoDigit(second)}s`
  }

  const getFloatingBar = () => {
    let element = $('#yt-player-tweaks-float-bar')

    if (!element) {
      element = document.createElement('div')
      element.id = 'yt-player-tweaks-float-bar'
      moviePlayer.appendChild(element)
    }

    return element
  }

  const showFloatingBar = (timer, text) => {
    if (timer) clearTimeout(timer)

    const textToRestore = persistentFloatingBarText

    floatingBar.textContent = text
    floatingBar.style.display = 'block'

    return setTimeout(() => {
      if (textToRestore) {
        floatingBar.textContent = textToRestore
        floatingBar.style.display = 'block'
        return
      }

      floatingBar.style.display = 'none'
    }, FEEDBACK_DURATION)
  }

  const showPersistentFloatingBar = (text) => {
    if (floatingBarTimer) {
      clearTimeout(floatingBarTimer)
      floatingBarTimer = 0
    }

    persistentFloatingBarText = text
    floatingBar.textContent = text
    floatingBar.style.display = 'block'
  }

  const hidePersistentFloatingBar = () => {
    persistentFloatingBarText = ''
    floatingBar.style.display = 'none'
  }

  const getTooltip = () => {
    let element = $('#yt-player-tweaks-tooltip')

    if (!element) {
      element = document.createElement('div')
      element.id = 'yt-player-tweaks-tooltip'
      element.className = 'ytp-tooltip ytp-bottom'
      element.dataset.visible = 'false'
      element.dataset.hasKey = 'false'

      const wrapper = document.createElement('div')
      wrapper.className = 'ytp-tooltip-text-wrapper'
      wrapper.setAttribute('aria-hidden', 'true')

      const bottomText = document.createElement('div')
      bottomText.className = 'ytp-tooltip-bottom-text'

      const text = document.createElement('span')
      text.className = 'ytp-tooltip-text'

      const key = document.createElement('div')
      key.className = 'ytp-tooltip-keyboard-shortcut'

      bottomText.append(text, key)
      wrapper.appendChild(bottomText)
      element.appendChild(wrapper)
      moviePlayer.appendChild(element)
    }

    tooltipText = element.querySelector('.ytp-tooltip-text')
    tooltipKey = element.querySelector('.ytp-tooltip-bottom-text > .ytp-tooltip-keyboard-shortcut')

    return element
  }

  const positionTooltip = (button) => {
    const playerRect = moviePlayer.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()

    const centeredLeft =
      buttonRect.left -
      playerRect.left +
      buttonRect.width / 2 -
      tooltipRect.width / 2

    const left = Math.max(
      8,
      Math.min(centeredLeft, playerRect.width - tooltipRect.width - 8)
    )

    const top = Math.max(
      8,
      buttonRect.top - playerRect.top - tooltipRect.height - TOOLTIP_VERTICAL_GAP
    )

    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
  }

  const showTooltip = (button, text, key = '') => {
    tooltipText.textContent = text
    tooltipKey.textContent = key
    tooltip.dataset.hasKey = String(Boolean(key))
    tooltip.dataset.visible = 'true'

    requestAnimationFrame(() => positionTooltip(button))
  }

  const hideTooltip = () => {
    tooltip.dataset.visible = 'false'
  }

  const screenShot = () => {
    if (!videoPlayer || !videoPlayer.videoWidth || !videoPlayer.videoHeight) return

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = videoPlayer.videoWidth
    canvas.height = videoPlayer.videoHeight
    context.drawImage(videoPlayer, 0, 0)

    const currentTime =
      Number(progressBar?.getAttribute('aria-valuenow')) ||
      Number(videoPlayer.currentTime) ||
      0

    const rawTitle =
      videoTitle?.textContent?.trim() ||
      document.title.replace(/\s*-\s*YouTube$/, '') ||
      'YouTube'

    const fileName =
      `${rawTitle} - ${timeFormat(currentTime)}`.replace(/[\/\\:*?"<>|]/g, '_')

    canvas.toBlob(async (blob) => {
      if (!blob) return

      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      } catch (_) {
        // Clipboard permission may be unavailable; downloading still works.
      }

      const objectUrl = URL.createObjectURL(blob)
      const revokeObjectUrl = () => URL.revokeObjectURL(objectUrl)
      const downloadFallback = () => {
        revokeObjectUrl()

        GM_download({
          url: canvas.toDataURL('image/png'),
          name: `ScreenShot/${fileName}.png`,
        })
      }

      try {
        GM_download({
          url: objectUrl,
          name: `ScreenShot/${fileName}.png`,
          onload: revokeObjectUrl,
          onerror: downloadFallback,
          ontimeout: downloadFallback,
        })
      } catch (_) {
        downloadFallback()
      }
    }, 'image/png')
  }

  const isObject = (value) =>
    value !== null &&
    typeof value === 'object'

  const getKeyByPropName = (object, propName) =>
    isObject(object)
      ? Object.keys(object).find((key) => object[key]?.[propName])
      : undefined

  const disableServerDrivenPlayback = (playerConfig, streamingData) => {
    const mediaCommonConfig = playerConfig?.mediaCommonConfig

    if (isObject(mediaCommonConfig)) {
      mediaCommonConfig.useServerDrivenAbr = false

      if (isObject(mediaCommonConfig.serverPlaybackStartConfig)) {
        mediaCommonConfig.serverPlaybackStartConfig.enable = false
      }
    }

    if (
      isObject(streamingData) &&
      streamingData.serverAbrStreamingUrl &&
      (streamingData.hlsManifestUrl || streamingData.dashManifestUrl)
    ) {
      delete streamingData.serverAbrStreamingUrl
    }
  }

  const enableLiveDvr = (response, owner) => {
    if (!isObject(response)) return

    const {
      streamingData,
      videoDetails,
      playerConfig,
      microformat,
    } = response

    if (!isObject(videoDetails) || !videoDetails.isLive) return

    videoDetails.isLiveDvrEnabled = true
    disableServerDrivenPlayback(playerConfig, streamingData)

    if (!isObject(streamingData)) return

    const playerMicroformat = microformat?.playerMicroformatRenderer
    const liveDetails = playerMicroformat?.liveBroadcastDetails

    if (!isObject(liveDetails) || !liveDetails.startTimestamp) return

    const startTime = Date.parse(liveDetails.startTimestamp)
    if (!Number.isFinite(startTime)) return

    const durationSeconds = Math.floor((Date.now() - startTime) / 1000)
    if (durationSeconds <= DEFAULT_MAX_DVR_SECONDS) return

    if (Array.isArray(streamingData.adaptiveFormats)) {
      for (const format of streamingData.adaptiveFormats) {
        format.maxDvrDurationSec = EXTENDED_MAX_DVR_SECONDS
      }
    }

    const configKey = getKeyByPropName(owner, 'experiments')
    const flags = configKey && owner[configKey]?.experiments?.flags

    if (isObject(flags)) {
      flags[LIVE_DVR_WINDOW_FLAG] = EXTENDED_MAX_DVR_SECONDS
    }
  }

  Object.defineProperty(Object.prototype, 'playerResponse', {
    set(value) {
      enableLiveDvr(value, this)
      playerResponseSetter.call(this, value)
    },
    get() {
      return playerResponseGetter.call(this)
    },
    configurable: true,
  })

  const isLivePlayback = () =>
    Boolean(moviePlayer?.getVideoData?.()?.isLive)

  const getBufferedRangeEnd = () => {
    if (!videoPlayer?.buffered?.length) return null

    const currentTime = videoPlayer.currentTime

    for (let index = videoPlayer.buffered.length - 1; index >= 0; index--) {
      const start = videoPlayer.buffered.start(index)
      const end = videoPlayer.buffered.end(index)

      if (start <= currentTime && currentTime <= end) return end
    }

    return videoPlayer.buffered.end(videoPlayer.buffered.length - 1)
  }

  const getLiveBufferHealth = () => {
    const progressState = moviePlayer?.getProgressState?.()

    if (
      Number.isFinite(progressState?.loaded) &&
      Number.isFinite(progressState?.current)
    ) {
      return Math.max(0, progressState.loaded - progressState.current)
    }

    const bufferedEnd = getBufferedRangeEnd()

    if (!Number.isFinite(bufferedEnd)) return null

    return Math.max(0, bufferedEnd - videoPlayer.currentTime)
  }

  const updateLiveButtonState = () => {
    if (!liveBtn) return

    liveBtn.setAttribute('aria-pressed', String(Boolean(liveCatchupTimer)))
  }

  const stopLiveCatchup = (message = '', restoreRate = true) => {
    if (liveCatchupTimer) {
      clearInterval(liveCatchupTimer)
      liveCatchupTimer = 0
    }

    if (
      restoreRate &&
      Number.isFinite(liveCatchupPreviousRate) &&
      videoPlayer
    ) {
      videoPlayer.playbackRate = liveCatchupPreviousRate
    }

    liveCatchupPreviousRate = null
    updateLiveButtonState()
    hidePersistentFloatingBar()

    if (message) {
      floatingBarTimer = showFloatingBar(floatingBarTimer, message)
    }
  }

  const runLiveCatchupStep = () => {
    if (!isLivePlayback() || !videoPlayer || videoPlayer.paused || videoPlayer.ended) {
      stopLiveCatchup('', true)
      return
    }

    const bufferHealth = getLiveBufferHealth()

    if (!Number.isFinite(bufferHealth)) return

    if (bufferHealth <= LIVE_CATCHUP_TARGET_BUFFER) {
      stopLiveCatchup('最低延遲', true)
      return
    }

    videoPlayer.playbackRate = LIVE_CATCHUP_RATE
  }

  const toggleLiveCatchup = () => {
    if (!isLivePlayback()) return

    if (liveCatchupTimer) {
      stopLiveCatchup('停止追直播', true)
      return
    }

    const bufferHealth = getLiveBufferHealth()

    if (!Number.isFinite(bufferHealth)) return

    if (bufferHealth <= LIVE_CATCHUP_TARGET_BUFFER) {
      floatingBarTimer = showFloatingBar(floatingBarTimer, '已是最低延遲')
      return
    }

    liveCatchupPreviousRate = videoPlayer.playbackRate
    liveCatchupTimer = setInterval(runLiveCatchupStep, LIVE_CATCHUP_INTERVAL)

    updateLiveButtonState()
    runLiveCatchupStep()
    showPersistentFloatingBar('追直播中')
  }

  const changeVolume = (event) => {
    event.preventDefault()

    let volume = moviePlayer.getVolume()
    moviePlayer.unMute(true)

    volume = event.deltaY < 0 ? volume + 5 : volume - 5
    volume = Math.max(0, Math.min(100, volume))

    moviePlayer.setVolume(volume, true)
    floatingBarTimer = showFloatingBar(floatingBarTimer, String(volume))
  }

  const changeSpeed = (event) => {
    event.preventDefault()
    event.stopPropagation()

    if (liveCatchupTimer) {
      stopLiveCatchup('', false)
    }

    let playbackRate = Number(videoPlayer.playbackRate)
    playbackRate =
      event.deltaY < 0
        ? Math.min(16, playbackRate + 0.1)
        : Math.max(0.1, playbackRate - 0.1)

    playbackRate = Number(playbackRate.toFixed(1))
    videoPlayer.playbackRate = playbackRate

    floatingBarTimer = showFloatingBar(floatingBarTimer, `${playbackRate}x`)
  }

  const resetSpeed = () => {
    if (liveCatchupTimer) {
      stopLiveCatchup('', false)
    }

    videoPlayer.playbackRate = 1
    floatingBarTimer = showFloatingBar(floatingBarTimer, '1x')
  }

  const createIconButton = ({ className, ariaLabel, path, viewBox }) => {
    const button = document.createElement('button')
    button.className = `${className} ytp-button`
    button.setAttribute('aria-label', ariaLabel)

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('height', '24')
    svg.setAttribute('viewBox', viewBox)
    svg.setAttribute('width', '24')

    const svgPath = document.createElementNS(SVG_NS, 'path')
    svgPath.setAttribute('d', path)
    svgPath.setAttribute('fill', 'white')

    svg.appendChild(svgPath)
    button.appendChild(svg)

    return button
  }

  const updateLiveButtonVisibility = () => {
    if (!liveBtn) return

    const shouldShow = isLivePlayback()
    liveBtn.hidden = !shouldShow

    if (!shouldShow && liveCatchupTimer) {
      stopLiveCatchup('', true)
    }
  }

  const getLiveTooltipText = () =>
    liveCatchupTimer ? '停止追直播' : '最低延遲'

  const ensureButtons = () => {
    liveBtn = $('button.ytp-live-catchup-button')
    let photoBtn = $('button.ytp-photo-button')
    let speedBtn = $('button.ytp-speed-button')

    if (!photoBtn) {
      photoBtn = createIconButton({
        className: 'ytp-photo-button',
        ariaLabel: '截圖',
        path: data.svg.photo,
        viewBox: '30 -930 900 900',
      })
    }

    if (!speedBtn) {
      speedBtn = createIconButton({
        className: 'ytp-speed-button',
        ariaLabel: '播放速度',
        path: data.svg.speed,
        viewBox: '55 -905 850 850',
      })
    }

    if (!liveBtn) {
      liveBtn = createIconButton({
        className: 'ytp-live-catchup-button',
        ariaLabel: '最低延遲',
        path: data.svg.live,
        viewBox: '3 3 18 18',
      })
    }

    const buttonGroup = sizeBtn.parentElement
    buttonGroup.insertBefore(photoBtn, sizeBtn)
    buttonGroup.insertBefore(speedBtn, sizeBtn)
    buttonGroup.insertBefore(liveBtn, speedBtn)

    updateLiveButtonVisibility()

    return { liveBtn, photoBtn, speedBtn }
  }

  const bindButtonEvents = ({ liveBtn, photoBtn, speedBtn }, signal) => {
    liveBtn.addEventListener('click', toggleLiveCatchup, { signal })
    liveBtn.addEventListener('mouseenter', (event) => {
      showTooltip(event.currentTarget, getLiveTooltipText())
    }, { signal })
    liveBtn.addEventListener('mouseleave', hideTooltip, { signal })
    liveBtn.addEventListener('focus', (event) => {
      showTooltip(event.currentTarget, getLiveTooltipText())
    }, { signal })
    liveBtn.addEventListener('blur', hideTooltip, { signal })

    photoBtn.addEventListener('click', screenShot, { signal })
    photoBtn.addEventListener('mouseenter', (event) => {
      showTooltip(event.currentTarget, '截圖', 'S')
    }, { signal })
    photoBtn.addEventListener('mouseleave', hideTooltip, { signal })
    photoBtn.addEventListener('focus', (event) => {
      showTooltip(event.currentTarget, '截圖', 'S')
    }, { signal })
    photoBtn.addEventListener('blur', hideTooltip, { signal })

    speedBtn.addEventListener('click', resetSpeed, { signal })
    speedBtn.addEventListener('wheel', changeSpeed, { passive: false, signal })
    speedBtn.addEventListener('mouseenter', (event) => {
      showTooltip(event.currentTarget, '播放速度')
    }, { signal })
    speedBtn.addEventListener('mouseleave', hideTooltip, { signal })
    speedBtn.addEventListener('focus', (event) => {
      showTooltip(event.currentTarget, '播放速度')
    }, { signal })
    speedBtn.addEventListener('blur', hideTooltip, { signal })

    videoPlayer.addEventListener('loadedmetadata', updateLiveButtonVisibility, { signal })
    videoPlayer.addEventListener('playing', updateLiveButtonVisibility, { signal })
  }

  const handleWheelCapture = (event) => {
    if (!container || !moviePlayer) return

    const target = event.target
    if (!(target instanceof Node)) return

    if (container.contains(target)) {
      event.stopImmediatePropagation()
      changeVolume(event)
    }
  }

  const handleKeydown = (event) => {
    if (
      event.key.toLowerCase() === SCREENSHOT_KEY &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !isEditableTarget(event.target)
    ) {
      event.preventDefault()
      screenShot()
    }
  }

  const collectPlayerElements = () => {
    container = $('.html5-video-container')
    sizeBtn = $('button.ytp-size-button')
    videoTitle = $('a.ytp-title-link')
    moviePlayer = $('#movie_player')
    progressBar = $('.ytp-progress-bar')
    videoPlayer = $('#movie_player video')

    return Boolean(container && sizeBtn && moviePlayer && progressBar && videoPlayer)
  }

  const waitElements = () => {
    return new Promise((resolve) => {
      if (collectPlayerElements()) {
        resolve(true)
        return
      }

      const observer = new MutationObserver(() => {
        if (collectPlayerElements()) {
          observer.disconnect()
          resolve(true)
        }
      })

      observer.observe(document.documentElement, {
        attributes: false,
        childList: true,
        subtree: true,
      })

      setTimeout(() => {
        observer.disconnect()
        resolve(collectPlayerElements())
      }, 5000)
    })
  }

  const main = async () => {
    const ready = await waitElements()
    if (!ready) return null

    pageController = new AbortController()
    const { signal } = pageController

    floatingBar = getFloatingBar()
    tooltip = getTooltip()

    const buttons = ensureButtons()
    bindButtonEvents(buttons, signal)

    document.addEventListener('wheel', handleWheelCapture, {
      capture: true,
      passive: false,
      signal,
    })

    document.addEventListener('keydown', handleKeydown, { signal })

    return () => {
      stopLiveCatchup('', true)
      pageController?.abort()
      pageController = null
      hideTooltip()
    }
  }

  let cleanup = null

  const handleNavigation = async () => {
    cleanup?.()
    cleanup = null

    if (isWatchPage()) {
      cleanup = await main()
    }
  }

  document.addEventListener('yt-navigate-finish', handleNavigation)

  if (isWatchPage()) {
    handleNavigation()
  }
})()
