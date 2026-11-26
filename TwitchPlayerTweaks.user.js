// ==UserScript==
// @name        Twitch Player Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.3.8
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchPlayerTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchPlayerTweaks.user.js
// @description 提供 Twitch 原解析度 PNG 截圖、滾輪音量與音量增益、VOD 直播當下時間，隱藏剪輯按鈕及互動擴充。
// @author      Derek
// @match       *://www.twitch.tv/*
// @run-at      document-idle
// @grant       none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  // You can choose your ideal VOD broadcast date format by changing VOD_CLOCK_FORMAT below.
  const VOD_CLOCK_FORMAT = 1
  /*
    1: 2022/10/31 06:37:10 (default)
    2: 10/31/2022 06:37:10
    3: 31/10/2022 06:37:10
    4: Mon 31/10/2022 06:37:10
    5: Monday 31/10/2022 06:37:10
    6: Monday 31 October 2022 06:37:10
  */

  const PLAYER_SELECTOR = '[data-a-target="video-player"]'
  // Prefer Twitch's data-a-target test hook (locale-independent), but keep
  // the aria-label fallbacks — player builds exist where the hook is absent
  // and matching nothing means the screenshot button never appears.
  const THEATER_BUTTON_SELECTOR = [
    'button[data-a-target="player-theatre-mode-button"]',
    'button[aria-label^="劇院模式"]',
    'button[aria-label^="Theater Mode"]',
  ].join(', ')
  const VOLUME_SLIDER_SELECTOR =
    'input[data-a-target="player-volume-slider"]'
  const VOD_SEEKBAR_TIME_SELECTOR =
    '[data-a-target="player-seekbar-current-time"]'
  const LEFT_CONTROLS_SELECTOR = '.player-controls__left-control-group'

  const VOLUME_STEP = 0.05
  const MAX_VOLUME_GAIN = 3
  const VOLUME_BAR_DURATION = 3000
  const TOOLTIP_VERTICAL_GAP = 10
  const SCREENSHOT_WORKER_TIMEOUT = 15000
  const GQL_URL = 'https://gql.twitch.tv/gql'
  const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
  const GQL_TIMEOUT_MS = 8000
  const GQL_RETRY_COOLDOWN_MS = 30000
  const MAX_VOD_START_CACHE = 50
  const WEEK_SHORT_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
  const WEEK_FULL_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long' })
  const MONTH_FULL_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long' })

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const playerStates = new WeakMap()
  const activeVodClockPlayers = new Set()
  const vodStartCache = new Map()
  const vodStartRequests = new Map()
  const volumeSources = new WeakMap()
  const boundVolumeVideos = new WeakSet()
  const failedVolumeVideos = new WeakSet()
  const activeVolumeVideos = new Set()
  const pendingVolumeVideos = new Set()
  let volumeAudioContext = null
  let volumeGainEnabled = false
  let volumeActivationBound = false
  const screenshotWorkerJobs = new Map()
  let screenshotWorker = null
  let screenshotWorkerAvailable = true
  let screenshotWorkerJobId = 0
  let screenshotInFlight = false
  let screenshotWarmupScheduled = false

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const addStyle = (css) => {
    const styleElement = document.createElement('style')
    styleElement.textContent = css
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  addStyle(`
    button[data-a-target="player-clip-button"],
    button[aria-label^="剪輯"],
    button[aria-label^="Clip"] {
      display: none !important;
    }

    .extensions-video-overlay-size-container,
    .extensions-dock__layout,
    .extensions-notifications,
    .extensions-popover {
      display: none !important;
    }

    .twitch-player-tweaks-volume-bar {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 20;
      width: 100%;
      height: 25px;
      color: #fff;
      background: rgba(0, 0, 0, 0.5);
      text-align: center;
      font-size: 16px;
      line-height: 25px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s ease;
    }

    .twitch-player-tweaks-volume-bar[data-visible="true"] {
      opacity: 0.95;
    }

    button[data-twitch-player-tweaks="screenshot"] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    button[data-twitch-player-tweaks="screenshot"] svg {
      fill: currentColor;
    }

    .twitch-player-tweaks-tooltip {
      position: absolute;
      z-index: 30;
      display: none;
      height: 27.6px;
      padding: 4px 8px;
      box-sizing: border-box;
      color: rgb(14, 14, 16);
      background: rgb(255, 255, 255);
      border-radius: 4px;
      font-family: Inter, "Noto Sans Arabic", Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      line-height: 19.6px;
      white-space: nowrap;
      pointer-events: none;
      transform: translateX(-50%);
    }

    .twitch-player-tweaks-tooltip::after {
      position: absolute;
      bottom: -5px;
      left: 50%;
      width: 10px;
      height: 10px;
      background: rgb(255, 255, 255);
      content: '';
      transform: translateX(-50%) rotate(45deg);
    }

    .twitch-player-tweaks-tooltip[data-visible="true"] {
      display: inline-block;
      pointer-events: auto;
    }

    .twitch-player-tweaks-vod-clock {
      margin-left: 0.6em !important;
      margin-right: auto !important;
      color: #fff;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.5;
      white-space: nowrap !important;
      font-variant-numeric: tabular-nums;
      user-select: text;
    }

    .player-controls__left-control-group > .twitch-player-tweaks-vod-clock {
      margin-right: 0 !important;
    }

    :has(> [data-a-target="player-seekbar-current-time"] + .twitch-player-tweaks-vod-clock) {
      display: flex;
      align-items: center;
    }
  `)

  const setNativeInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set

    setter?.call(input, value)
  }

  // Class instead of id: multiple players (squad / mini player) each get
  // their own bar without producing duplicate ids in the document.
  const getVolumeBar = (player) => {
    let bar = $('.twitch-player-tweaks-volume-bar', player)

    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'twitch-player-tweaks-volume-bar'
      bar.dataset.visible = 'false'
      player.appendChild(bar)
    }

    return bar
  }

  const TOOLTIP_HOVER_GRACE = 100
  let nextTooltipId = 0
  let openTooltipPlayer = null
  let tooltipDismissBound = false

  const getTooltip = (player) => {
    let tooltip = $('.twitch-player-tweaks-tooltip', player)

    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.id = `twitch-player-tweaks-tooltip-${++nextTooltipId}`
      tooltip.className = 'twitch-player-tweaks-tooltip'
      tooltip.setAttribute('role', 'tooltip')
      tooltip.dataset.visible = 'false'
      player.appendChild(tooltip)
    } else if (!tooltip.id) {
      tooltip.id = `twitch-player-tweaks-tooltip-${++nextTooltipId}`
      tooltip.setAttribute('role', 'tooltip')
    }

    return tooltip
  }

  const ensurePlayerState = (player) => {
    let state = playerStates.get(player)

    if (!state) {
      const tooltip = getTooltip(player)
      state = {
        volumeBar: getVolumeBar(player),
        volumeBarTimer: 0,
        tooltip,
        tooltipFrame: 0,
        tooltipHideTimer: 0,
        tooltipButton: null,
        vodClock: null,
        vodClockTimeEl: null,
        vodClockObserver: null,
        vodClockVideo: null,
        vodClockVideoHandler: null,
        vodClockId: null,
        vodClockStartMs: null,
      }

      tooltip.addEventListener('mouseenter', () => {
        clearTimeout(state.tooltipHideTimer)
        state.tooltipHideTimer = 0
      })
      tooltip.addEventListener('mouseleave', () => {
        scheduleHideTooltip(player)
      })

      player.addEventListener(
        'wheel',
        (event) => changeVolume(event, player),
        {
          capture: true,
          passive: false,
        }
      )
      player.addEventListener('pointerdown', event => {
        if (event.target?.closest?.(`${VOLUME_SLIDER_SELECTOR}, [data-a-target="player-mute-unmute-button"]`)) {
          volumeGainEnabled = true
          ensureVolumeGain($('video', player))
        }
      }, { capture: true })

      playerStates.set(player, state)
    } else {
      state.volumeBar = getVolumeBar(player)
      state.tooltip = getTooltip(player)
    }

    const video = $('video', player)
    if (video && !boundVolumeVideos.has(video)) {
      boundVolumeVideos.add(video)
      const sync = () => {
        const owner = video.closest(PLAYER_SELECTOR)
        if (volumeGainEnabled && video.isConnected && owner && $('video', owner) === video) ensureVolumeGain(video)
      }
      for (const name of ['volumechange', 'loadedmetadata', 'playing']) video.addEventListener(name, sync)
    }
    if (volumeGainEnabled) ensureVolumeGain(video)
    return state
  }

  const bindVolumeActivation = () => {
    if (volumeActivationBound) return
    volumeActivationBound = true
    const activate = () => {
      if (!volumeAudioContext) return
      const flushPending = () => {
        if (volumeAudioContext?.state !== 'running') return
        for (const target of [...pendingVolumeVideos]) {
          pendingVolumeVideos.delete(target)
          if (volumeGainEnabled && target.isConnected) ensureVolumeGain(target)
        }
        document.removeEventListener?.('pointerdown', activate, true)
        document.removeEventListener?.('keydown', activate, true)
        volumeActivationBound = false
      }
      if (volumeAudioContext.state === 'suspended') {
        volumeAudioContext.resume().then(flushPending).catch(() => {})
      } else {
        flushPending()
      }
    }
    document.addEventListener('pointerdown', activate, { capture: true, passive: true })
    document.addEventListener('keydown', activate, { capture: true, passive: true })
  }

  const ensureVolumeGain = video => {
    if (!video || !volumeGainEnabled || failedVolumeVideos.has(video)) return
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    let graph = volumeSources.get(video)
    let source
    let gain
    try {
      if (!graph) {
        // Routing a non-CORS remote stream through Web Audio would silence it.
        // Wait for a known same-origin source (including Twitch's MSE blob).
        if (!video.currentSrc || video.mediaKeys || new URL(video.currentSrc, location.href).origin !== location.origin) return
      }
      if (!volumeAudioContext) volumeAudioContext = new AudioContextClass()
      if (volumeAudioContext.state === 'suspended') {
        volumeAudioContext.resume().then(() => {
          if (volumeAudioContext?.state === 'running' && volumeGainEnabled && video.isConnected) {
            pendingVolumeVideos.delete(video)
            ensureVolumeGain(video)
          }
        }).catch(() => {})
      }
      // Never call createMediaElementSource while AudioContext is suspended without
      // user activation: taking ownership before running mutes native audio.
      if (volumeAudioContext.state !== 'running') {
        pendingVolumeVideos.add(video)
        bindVolumeActivation()
        return
      }
      if (!graph) {
        gain = volumeAudioContext.createGain()
        gain.connect(volumeAudioContext.destination)
        source = volumeAudioContext.createMediaElementSource(video)
        source.connect(gain)
        graph = { source, gain, connected: true }
        volumeSources.set(video, graph)
      } else if (!graph.connected) {
        graph.gain?.connect(volumeAudioContext.destination)
        graph.source.connect(graph.gain || volumeAudioContext.destination)
        graph.connected = true
      }
      // Match YouTube: native volume v multiplied by a gain of 3v.
      if (graph.gain) graph.gain.gain.value = MAX_VOLUME_GAIN * clamp(video.volume, 0, 1)
      activeVolumeVideos.add(video)
    } catch (_) {
      // If graph creation fails after taking ownership, reconnect directly so
      // native playback can continue without trying to wrap this video twice.
      gain?.disconnect()
      if (source) {
        try {
          source.disconnect()
          source.connect(volumeAudioContext.destination)
          volumeSources.set(video, { source, gain: null, connected: true })
          activeVolumeVideos.add(video)
        } catch (_) {
          failedVolumeVideos.add(video)
        }
      } else {
        failedVolumeVideos.add(video)
      }
    }
  }

  const showVolumeBar = (player, volume) => {
    const state = ensurePlayerState(player)

    clearTimeout(state.volumeBarTimer)

    state.volumeBar.textContent = `${Math.round(volume * 100)}`
    state.volumeBar.dataset.visible = 'true'

    state.volumeBarTimer = setTimeout(() => {
      state.volumeBar.dataset.visible = 'false'
    }, VOLUME_BAR_DURATION)
  }

  const syncVolumeSliders = (player, volume) => {
    const percent = Math.round(volume * 100)

    for (const slider of $$(VOLUME_SLIDER_SELECTOR, player)) {
      setNativeInputValue(slider, String(volume))
      slider.setAttribute('aria-valuenow', String(percent))
      slider.setAttribute('aria-valuetext', `${percent}%`)
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      slider.dispatchEvent(new Event('change', { bubbles: true }))

      const fill = slider.parentElement?.querySelector(
        '[data-test-selector="tw-range__fill-value-selector"]'
      )

      if (fill) fill.style.width = `${percent}%`
    }
  }

  const changeVolume = (event, player) => {
    const video = $('video', player)
    if (!video || event.ctrlKey || event.deltaY === 0) return

    event.preventDefault()
    event.stopPropagation()
    volumeGainEnabled = true

    const nextVolume = clamp(
      Number(
        (
          video.volume +
          (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP)
        ).toFixed(2)
      ),
      0,
      1
    )

    syncVolumeSliders(player, nextVolume)

    video.volume = nextVolume
    if (nextVolume > 0 && video.muted) video.muted = false
    ensureVolumeGain(video)

    video.dispatchEvent(new Event('volumechange', { bubbles: true }))
    showVolumeBar(player, nextVolume)
  }

  const bindTooltipDismiss = () => {
    if (tooltipDismissBound) return
    tooltipDismissBound = true
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && openTooltipPlayer) {
        hideTooltip(openTooltipPlayer)
      }
    })
  }

  const showTooltip = (player, button, text) => {
    const state = ensurePlayerState(player)
    clearTimeout(state.tooltipHideTimer)
    state.tooltipHideTimer = 0
    if (state.tooltipFrame) cancelAnimationFrame(state.tooltipFrame)
    if (openTooltipPlayer && openTooltipPlayer !== player) {
      hideTooltip(openTooltipPlayer)
    }

    if (state.tooltipButton && state.tooltipButton !== button) {
      state.tooltipButton.removeAttribute?.('aria-describedby')
    }
    state.tooltipButton = button
    if (state.tooltip.id) button.setAttribute?.('aria-describedby', state.tooltip.id)
    openTooltipPlayer = player
    bindTooltipDismiss()

    state.tooltip.textContent = text
    state.tooltip.dataset.visible = 'true'

    state.tooltipFrame = requestAnimationFrame(() => {
      state.tooltipFrame = 0
      if (button.isConnected === false || state.tooltip.dataset.visible !== 'true') return
      const playerRect = player.getBoundingClientRect()
      const buttonRect = button.getBoundingClientRect()
      const tooltipRect = state.tooltip.getBoundingClientRect()
      const halfWidth = tooltipRect.width / 2
      const rawLeft = buttonRect.left - playerRect.left + buttonRect.width / 2
      const minLeft = halfWidth + 8
      const maxLeft = Math.max(minLeft, playerRect.width - halfWidth - 8)
      const left = playerRect.width > 0 && tooltipRect.width > 0
        ? clamp(rawLeft, minLeft, maxLeft)
        : rawLeft

      state.tooltip.style.left = `${left}px`

      state.tooltip.style.top =
        `${buttonRect.top - playerRect.top - tooltipRect.height - TOOLTIP_VERTICAL_GAP}px`
    })
  }

  const hideTooltip = (player) => {
    const state = ensurePlayerState(player)
    clearTimeout(state.tooltipHideTimer)
    state.tooltipHideTimer = 0
    if (state.tooltipFrame) {
      cancelAnimationFrame(state.tooltipFrame)
      state.tooltipFrame = 0
    }
    state.tooltip.dataset.visible = 'false'
    if (state.tooltipButton) {
      state.tooltipButton.removeAttribute?.('aria-describedby')
      state.tooltipButton = null
    }
    if (openTooltipPlayer === player) openTooltipPlayer = null
  }

  const scheduleHideTooltip = (player) => {
    const state = ensurePlayerState(player)
    clearTimeout(state.tooltipHideTimer)
    state.tooltipHideTimer = setTimeout(() => {
      state.tooltipHideTimer = 0
      hideTooltip(player)
    }, TOOLTIP_HOVER_GRACE)
  }

  const getScreenshotFileName = () => {
    const segments = location.pathname.split('/').filter(Boolean)
    // On non-channel pages (e.g. /videos/<id>) the first segment isn't a
    // channel name; fall back to a generic prefix.
    const channel =
      (['videos', 'directory'].includes(segments[0]) ? '' : segments[0]) ||
      'twitch'
    const now = new Date()

    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '-',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')

    return `${channel}-${stamp}.png`
  }

  const stopScreenshotWorker = (error, disable = false) => {
    screenshotWorker?.terminate()
    screenshotWorker = null
    if (disable) screenshotWorkerAvailable = false

    for (const { reject, timer } of screenshotWorkerJobs.values()) {
      clearTimeout(timer)
      reject(error)
    }
    screenshotWorkerJobs.clear()
  }

  const getScreenshotWorker = () => {
    if (
      !screenshotWorkerAvailable ||
      typeof Worker !== 'function' ||
      typeof OffscreenCanvas !== 'function'
    ) {
      return null
    }
    if (screenshotWorker) return screenshotWorker

    const workerSource = `
      let canvas
      let context

      self.onmessage = async ({ data }) => {
        const { id, frame, width, height } = data
        try {
          try {
            if (!canvas || canvas.width !== width || canvas.height !== height) {
              canvas = new OffscreenCanvas(width, height)
              context = canvas.getContext('2d', { alpha: false })
            }
            if (!context) throw new Error('Canvas 2D is unavailable')
            context.drawImage(frame, 0, 0, width, height)
          } finally {
            frame.close()
          }

          const blob = await canvas.convertToBlob({ type: 'image/png' })
          self.postMessage({ id, blob })
        } catch (error) {
          self.postMessage({ id, error: error?.message || 'PNG encode failed' })
        }
      }
    `

    const workerUrl = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' })
    )

    try {
      const worker = new Worker(workerUrl)

      worker.addEventListener('message', ({ data }) => {
        const job = screenshotWorkerJobs.get(data.id)
        if (!job) return

        screenshotWorkerJobs.delete(data.id)
        clearTimeout(job.timer)
        if (data.blob) job.resolve(data.blob)
        else job.reject(new Error(data.error || 'PNG encode failed'))
      })

      const handleWorkerError = () => {
        if (screenshotWorker !== worker) return
        stopScreenshotWorker(new Error('Screenshot worker failed'), true)
      }
      worker.addEventListener('error', handleWorkerError)
      worker.addEventListener('messageerror', handleWorkerError)

      screenshotWorker = worker
      return worker
    } catch (error) {
      screenshotWorkerAvailable = false
      throw error
    } finally {
      URL.revokeObjectURL(workerUrl)
    }
  }

  const encodeScreenshotInWorker = (worker, frame, width, height) => {
    if (worker !== screenshotWorker) {
      return Promise.reject(new Error('Screenshot worker is unavailable'))
    }
    const id = ++screenshotWorkerJobId

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stopScreenshotWorker(new Error('Screenshot worker timed out'), true)
      }, SCREENSHOT_WORKER_TIMEOUT)
      screenshotWorkerJobs.set(id, { resolve, reject, timer })

      try {
        // Keep our frame reference for a fallback on worker failure.
        worker.postMessage({ id, frame, width, height })
      } catch (error) {
        screenshotWorkerJobs.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  const encodeScreenshotOnMainThread = (source, width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas 2D is unavailable')
    context.drawImage(source, 0, 0, width, height)

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('PNG encode failed'))
      }, 'image/png')
    })
  }

  const encodeScreenshot = async (video) => {
    const width = video.videoWidth
    const height = video.videoHeight
    let frame

    try {
      const worker = getScreenshotWorker()
      if (!worker) return encodeScreenshotOnMainThread(video, width, height)

      if (typeof VideoFrame === 'function') {
        try {
          frame = new VideoFrame(video)
        } catch (_) {}
      }
      if (!frame) frame = await createImageBitmap(video)

      return await encodeScreenshotInWorker(worker, frame, width, height)
    } catch (_) {
      return encodeScreenshotOnMainThread(frame || video, width, height)
    } finally {
      // The main-thread fallback draws before its PNG promise is returned.
      frame?.close()
    }
  }

  const scheduleScreenshotWorkerWarmup = () => {
    if (screenshotWarmupScheduled) return
    screenshotWarmupScheduled = true

    const warm = () => {
      try {
        getScreenshotWorker()
      } catch (_) {}
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(warm, { timeout: 1000 })
    } else {
      setTimeout(warm, 250)
    }
  }

  const takeScreenshot = (player) => {
    const video = $('video', player)
    if (screenshotInFlight || !video || !video.videoWidth || !video.videoHeight) {
      return
    }

    screenshotInFlight = true
    const fileName = getScreenshotFileName()
    const blobPromise = encodeScreenshot(video).finally(() => {
      screenshotInFlight = false
    })

    // Start the clipboard write within the click's user gesture.
    try {
      navigator.clipboard
        .write([new ClipboardItem({ 'image/png': blobPromise })])
        .catch(() => {})
    } catch (_) {
      // Download still works when clipboard access is unavailable.
    }

    blobPromise.then((blob) => {
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = fileName
      link.hidden = true

      try {
        ;(document.body || document.documentElement).appendChild(link)
        link.click()
      } finally {
        link.remove()
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)
      }
    }).catch((error) => {
      console.warn('[Twitch Player Tweaks] Screenshot failed:', error)
    })
  }

  const createScreenshotButton = (theaterButton, player) => {
    // Clone to inherit Twitch's current button classes at runtime (kept fresh
    // by Twitch itself), but strip Twitch's behavioral hook so its own code
    // never targets our button as the theater button.
    const button = theaterButton.cloneNode(false)

    button.dataset.twitchPlayerTweaks = 'screenshot'
    button.setAttribute('aria-label', '截圖')
    button.removeAttribute('title')
    button.removeAttribute('aria-haspopup')
    button.removeAttribute('data-a-target')

    // Bare SVG + own CSS instead of Twitch's build-hashed wrapper classes,
    // which change on every redeploy.
    const createSvgElement = (tag, attributes = {}) => {
      const node = typeof document.createElementNS === 'function'
        ? document.createElementNS(SVG_NS, tag)
        : document.createElement(tag)
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
      return node
    }
    const icon = createSvgElement('svg', {
      width: '24',
      height: '24',
      viewBox: '0 0 24 24',
      focusable: 'false',
      'aria-hidden': 'true',
      role: 'presentation',
    })
    icon.appendChild(createSvgElement('path', {
      d: 'M9 4 7.5 6H5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-2.5L15 4H9Zm3 4a5 5 0 1 1 0 10a5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6a3 3 0 0 0 0-6Z',
    }))
    button.appendChild(icon)

    button.addEventListener('click', () => takeScreenshot(player))
    button.addEventListener('mouseenter', () => {
      showTooltip(player, button, '截圖')
    })
    button.addEventListener('mouseleave', () => {
      scheduleHideTooltip(player)
    })
    button.addEventListener('focus', () => {
      showTooltip(player, button, '截圖')
    })
    button.addEventListener('blur', () => {
      hideTooltip(player)
    })

    return button
  }

  const ensureScreenshotButtons = (player) => {
    for (const theaterButton of $$(THEATER_BUTTON_SELECTOR, player)) {
      const theaterButtonWrapper = theaterButton.parentElement
      const theaterSlot = theaterButtonWrapper?.parentElement
      const controls = theaterSlot?.parentElement

      if (!theaterButtonWrapper || !theaterSlot || !controls) continue

      if (
        controls.querySelector(
          ':scope > [data-twitch-player-tweaks-slot="screenshot"]'
        )
      ) {
        continue
      }

      const screenshotSlot = theaterSlot.cloneNode(false)
      const screenshotButtonWrapper = theaterButtonWrapper.cloneNode(false)
      const screenshotButton = createScreenshotButton(theaterButton, player)

      screenshotSlot.removeAttribute('data-a-target')
      screenshotButtonWrapper.removeAttribute('data-a-target')
      screenshotSlot.dataset.twitchPlayerTweaksSlot = 'screenshot'

      screenshotButtonWrapper.appendChild(screenshotButton)
      screenshotSlot.appendChild(screenshotButtonWrapper)
      controls.insertBefore(screenshotSlot, theaterSlot)
      scheduleScreenshotWorkerWarmup()
    }
  }

  const twoDigit = (num) => String(num).padStart(2, '0')

  const getVodIdFromUrl = (rawUrl = location.href) => {
    try {
      const url = new URL(rawUrl, location.origin)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0]?.toLowerCase() === 'videos' && /^\d+$/.test(parts[1] || '')) {
        return parts[1]
      }
      if (parts.length >= 3 && parts[1]?.toLowerCase() === 'video' && /^\d+$/.test(parts[2] || '')) {
        return parts[2]
      }
    } catch (_) {}
    return null
  }

  const parseVodTimestamp = (text) => {
    const match = String(text || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
    if (!match) return null
    const hour = match[1] ? Number(match[1]) : 0
    const minute = Number(match[2])
    const second = Number(match[3])
    if (second >= 60 || (match[1] && minute >= 60)) return null
    return hour * 3600 + minute * 60 + second
  }

  const formatVodDate = (date) => {
    const year = date.getFullYear()
    const month = twoDigit(date.getMonth() + 1)
    const day = twoDigit(date.getDate())
    const time = `${twoDigit(date.getHours())}:${twoDigit(date.getMinutes())}:${twoDigit(date.getSeconds())}`

    switch (VOD_CLOCK_FORMAT) {
      case 2:
        return `(${month}/${day}/${year} ${time})`
      case 3:
        return `(${day}/${month}/${year} ${time})`
      case 4:
        return `(${WEEK_SHORT_FORMAT.format(date)} ${day}/${month}/${year} ${time})`
      case 5:
        return `(${WEEK_FULL_FORMAT.format(date)} ${day}/${month}/${year} ${time})`
      case 6:
        return `(${WEEK_FULL_FORMAT.format(date)} ${day} ${MONTH_FULL_FORMAT.format(date)} ${year} ${time})`
      case 1:
      default:
        return `(${year}/${month}/${day} ${time})`
    }
  }

  const matchesVodJsonLdUrl = (rawUrl, vodId) => {
    if (typeof rawUrl !== 'string' || !rawUrl) return false
    try {
      const url = new URL(rawUrl, location.origin)
      if (getVodIdFromUrl(url.href) === vodId) return true
      if (url.searchParams.get('video') === vodId) return true
    } catch (_) {}
    return false
  }

  const flattenJsonLdItems = (node, items = []) => {
    if (!node || typeof node !== 'object') return items
    if (Array.isArray(node)) {
      for (const entry of node) flattenJsonLdItems(entry, items)
      return items
    }
    if (Array.isArray(node['@graph'])) {
      for (const entry of node['@graph']) flattenJsonLdItems(entry, items)
    }
    items.push(node)
    return items
  }

  const readVodStartFromJsonLd = (vodId) => {
    if (!vodId) return null
    for (const script of $$('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || '')
        for (const item of flattenJsonLdItems(parsed)) {
          const type = item?.['@type']
          const isVideoObject = Array.isArray(type) ? type.includes('VideoObject') : type === 'VideoObject'
          if (!isVideoObject) continue
          const matched =
            matchesVodJsonLdUrl(item.contentUrl, vodId) ||
            matchesVodJsonLdUrl(item.embedUrl, vodId) ||
            matchesVodJsonLdUrl(item['@id'], vodId)
          if (!matched) continue
          const startMs = Date.parse(item.uploadDate || '')
          if (Number.isFinite(startMs)) return startMs
        }
      } catch (_) {}
    }
    return null
  }

  const setVodStartCache = (vodId, entry) => {
    vodStartCache.delete(vodId)
    vodStartCache.set(vodId, entry)
    if (vodStartCache.size > MAX_VOD_START_CACHE) {
      vodStartCache.delete(vodStartCache.keys().next().value)
    }
  }

  const fetchVodStartTime = (vodId) => {
    if (!vodId) return Promise.resolve(null)
    const cached = vodStartCache.get(vodId)
    if (cached && Date.now() < cached.retryAfter) {
      return Promise.resolve(cached.value)
    }
    const inflight = vodStartRequests.get(vodId)
    if (inflight) return inflight

    const request = (async () => {
      try {
        if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
        const signal =
          typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(GQL_TIMEOUT_MS)
            : undefined
        const response = await fetch(GQL_URL, {
          method: 'POST',
          headers: {
            'Client-ID': GQL_CLIENT_ID,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: 'query($id: ID!) { video(id: $id) { id createdAt publishedAt broadcastType } }',
            variables: { id: vodId },
          }),
          ...(signal ? { signal } : {}),
        })
        if (!response?.ok) throw new Error(`HTTP ${response?.status}`)
        const payload = await response.json()
        const video = payload?.data?.video
        if (!video || (video.id && String(video.id) !== String(vodId))) {
          setVodStartCache(vodId, { value: null, retryAfter: Date.now() + GQL_RETRY_COOLDOWN_MS })
          return null
        }
        const broadcastType = String(video.broadcastType || '').toUpperCase()
        if (broadcastType && broadcastType !== 'ARCHIVE') {
          setVodStartCache(vodId, { value: null, retryAfter: Infinity })
          return null
        }
        const startMs = Date.parse(video.createdAt || video.publishedAt || '')
        if (Number.isFinite(startMs)) {
          setVodStartCache(vodId, { value: startMs, retryAfter: Infinity })
          return startMs
        }
        setVodStartCache(vodId, { value: null, retryAfter: Date.now() + GQL_RETRY_COOLDOWN_MS })
        return null
      } catch (_) {
        const fallbackMs = readVodStartFromJsonLd(vodId)
        if (Number.isFinite(fallbackMs)) {
          setVodStartCache(vodId, { value: fallbackMs, retryAfter: Infinity })
          return fallbackMs
        }
        setVodStartCache(vodId, { value: null, retryAfter: Date.now() + GQL_RETRY_COOLDOWN_MS })
        return null
      } finally {
        vodStartRequests.delete(vodId)
      }
    })()

    vodStartRequests.set(vodId, request)
    return request
  }

  const removeVodClock = (state) => {
    if (!state) return
    state.vodClockObserver?.disconnect()
    state.vodClockObserver = null
    if (state.vodClockVideo && state.vodClockVideoHandler) {
      state.vodClockVideo.removeEventListener?.('timeupdate', state.vodClockVideoHandler)
      state.vodClockVideo.removeEventListener?.('seeked', state.vodClockVideoHandler)
    }
    state.vodClockVideo = null
    state.vodClockVideoHandler = null
    state.vodClockTimeEl = null
    state.vodClockId = null
    state.vodClockStartMs = null
    state.vodClock?.remove()
    state.vodClock = null
    const owner = [...activeVodClockPlayers].find((player) => playerStates.get(player) === state)
    if (owner) activeVodClockPlayers.delete(owner)
  }

  const getPlayerSeconds = (player, currentTimeEl) => {
    const parsed = parseVodTimestamp(currentTimeEl?.textContent)
    if (parsed !== null) return parsed
    const video = $('video', player)
    if (video && Number.isFinite(video.currentTime) && video.currentTime >= 0) {
      return Math.floor(video.currentTime)
    }
    return null
  }

  const updateVodClock = (player, state) => {
    if (!state.vodClock || !Number.isFinite(state.vodClockStartMs)) return
    const seconds = getPlayerSeconds(player, state.vodClockTimeEl)
    if (seconds === null) {
      state.vodClock.hidden = true
      if (state.vodClock.textContent !== '') state.vodClock.textContent = ''
      return
    }
    const nextText = formatVodDate(new Date(state.vodClockStartMs + seconds * 1000))
    state.vodClock.hidden = false
    if (state.vodClock.textContent !== nextText) state.vodClock.textContent = nextText
  }

  const ensureVodClock = (player, vodId) => {
    const state = ensurePlayerState(player)
    if (!vodId) {
      removeVodClock(state)
      return
    }
    if (state.vodClockId && state.vodClockId !== vodId) {
      removeVodClock(state)
    }

    const cached = vodStartCache.get(vodId)
    if (!cached || Date.now() >= cached.retryAfter) {
      fetchVodStartTime(vodId).then((startMs) => {
        if (startMs !== null && getVodIdFromUrl(location.href) === vodId) refresh()
      })
      return
    }
    if (!Number.isFinite(cached.value)) {
      removeVodClock(state)
      return
    }

    const currentTimeEl = $(VOD_SEEKBAR_TIME_SELECTOR, player)
    const leftControls = currentTimeEl ? null : $(LEFT_CONTROLS_SELECTOR, player)
    if (!currentTimeEl?.parentElement && !leftControls) return

    let clock = state.vodClock || $('[data-twitch-player-tweaks="vod-clock"]', player)
    if (!clock) {
      clock = document.createElement('span')
      clock.className = 'twitch-player-tweaks-vod-clock'
      clock.dataset.twitchPlayerTweaks = 'vod-clock'
      clock.setAttribute('data-twitch-player-tweaks', 'vod-clock')
      clock.setAttribute('title', '直播當下時間')
    }

    if (currentTimeEl?.parentElement) {
      const parent = currentTimeEl.parentElement
      const siblings = [...parent.children]
      const index = siblings.indexOf(currentTimeEl)
      if (siblings[index + 1] !== clock) {
        parent.insertBefore(clock, siblings[index + 1] || null)
      }
    } else if (leftControls && clock.parentElement !== leftControls) {
      leftControls.appendChild(clock)
    }

    state.vodClock = clock
    state.vodClockId = vodId
    state.vodClockStartMs = cached.value
    activeVodClockPlayers.add(player)

    if (state.vodClockTimeEl !== currentTimeEl) {
      state.vodClockObserver?.disconnect()
      state.vodClockObserver = null
      state.vodClockTimeEl = currentTimeEl || null
      if (currentTimeEl && typeof MutationObserver === 'function') {
        state.vodClockObserver = new MutationObserver(() => updateVodClock(player, state))
        state.vodClockObserver.observe(currentTimeEl, {
          childList: true,
          characterData: true,
          subtree: true,
        })
      }
    }

    const video = $('video', player) || null
    if (state.vodClockVideo !== video) {
      if (state.vodClockVideo && state.vodClockVideoHandler) {
        state.vodClockVideo.removeEventListener?.('timeupdate', state.vodClockVideoHandler)
        state.vodClockVideo.removeEventListener?.('seeked', state.vodClockVideoHandler)
      }
      state.vodClockVideo = video
      if (video) {
        state.vodClockVideoHandler = () => updateVodClock(player, state)
        video.addEventListener?.('timeupdate', state.vodClockVideoHandler)
        video.addEventListener?.('seeked', state.vodClockVideoHandler)
      } else {
        state.vodClockVideoHandler = null
      }
    }

    updateVodClock(player, state)
  }

  const refresh = () => {
    const vodId = getVodIdFromUrl(location.href)
    const currentPlayers = new Set()
    const currentVideos = new Set()
    for (const player of $$(PLAYER_SELECTOR)) {
      currentPlayers.add(player)
      ensurePlayerState(player)
      ensureScreenshotButtons(player)
      ensureVodClock(player, vodId)
      const video = $('video', player)
      if (video) currentVideos.add(video)
    }
    for (const player of [...activeVodClockPlayers]) {
      if (!currentPlayers.has(player) || !vodId) {
        removeVodClock(playerStates.get(player))
      }
    }
    for (const video of activeVolumeVideos) {
      if (currentVideos.has(video)) continue
      const graph = volumeSources.get(video)
      graph.source.disconnect()
      graph.gain?.disconnect()
      graph.connected = false
      activeVolumeVideos.delete(video)
      pendingVolumeVideos.delete(video)
    }
    for (const video of pendingVolumeVideos) {
      if (!video.isConnected) pendingVolumeVideos.delete(video)
    }
  }

  // Throttle to ~4/s instead of per-frame, and let the cheap,
  // idempotent refresh() do the selector matching once — rather than running a
  // deep querySelector on every added node during Twitch's constant DOM churn.
  const REFRESH_INTERVAL = 250
  let refreshTimer = 0
  let lastRefresh = 0

  const scheduleRefresh = () => {
    if (refreshTimer) return

    const wait = Math.max(0, REFRESH_INTERVAL - (Date.now() - lastRefresh))
    refreshTimer = setTimeout(() => {
      refreshTimer = 0
      lastRefresh = Date.now()
      refresh()
    }, wait)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (!mutation.addedNodes.length && !mutation.removedNodes?.length) continue
      const target =
        mutation.target?.nodeType === 1
          ? mutation.target
          : mutation.target?.parentElement
      if (target?.closest?.('.stream-chat')) continue
      scheduleRefresh()
      return
    }
  })

  refresh()

  window.addEventListener?.('popstate', scheduleRefresh)

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  })
})()
