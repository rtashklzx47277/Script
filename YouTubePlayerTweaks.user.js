// ==UserScript==
// @name        YouTube Player Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.2.22
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubePlayerTweaks.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubePlayerTweaks.user.js
// @description 提供 YouTube 原解析度 PNG 截圖、滾輪音量與速度調整、直播追平、擴大直播回看範圍，並於 Shorts 隱藏影片內資訊與預設右側頁籤面板。
// @author      Derek
// @match       *://www.youtube.com/*
// @grant       unsafeWindow
// @run-at      document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  // ---- Live DVR unlock ---------------------------------------------------------------
  // Make DVR-disabled live streams seekable and widen the rewind window to 7 days, by
  // patching the player response on its two real delivery paths (the inline global and
  // JSON.parse) plus the rewind-cap flag inside ytcfg. We deliberately do NOT define
  // Object.prototype.playerResponse: that makes `'playerResponse' in <any object>` true
  // and breaks YouTube's comment / share panels. unsafeWindow is required because this
  // script is sandboxed (it holds a @grant), so page globals aren't on our own `window`.
  const pageWindow =
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window)

  const MAX_DVR_SECONDS = 43200 * 14
  const DVR_WINDOW_FLAG = 'html5_max_live_dvr_window_plus_margin_secs'
  const DVR_WINDOW_FLAG_PATTERN = new RegExp(`${DVR_WINDOW_FLAG}=[\\d.]+`)

  const streamRunningOver12h = (microformat) => {
    const live = microformat?.playerMicroformatRenderer?.liveBroadcastDetails
    if (!live?.startTimestamp) return false
    const startTime = Date.parse(live.startTimestamp)
    return Number.isFinite(startTime) && (Date.now() - startTime) / 1000 > 43200
  }

  const modifyPlayerResponse = (response) => {
    const { streamingData, videoDetails, playerConfig, microformat } = response

    // Only live streams have DVR; leave normal videos and finished VODs alone.
    if (!videoDetails || !videoDetails.isLive) return

    videoDetails.isLiveDvrEnabled = true

    const mediaCommonConfig = playerConfig?.mediaCommonConfig
    if (mediaCommonConfig) {
      mediaCommonConfig.useServerDrivenAbr = false
      if (mediaCommonConfig.serverPlaybackStartConfig) {
        mediaCommonConfig.serverPlaybackStartConfig.enable = false
      }
    }

    if (streamingData) {
      if (
        streamingData.serverAbrStreamingUrl &&
        (streamingData.hlsManifestUrl || streamingData.dashManifestUrl)
      ) {
        delete streamingData.serverAbrStreamingUrl
      }

      if (
        Array.isArray(streamingData.adaptiveFormats) &&
        streamRunningOver12h(microformat)
      ) {
        for (const format of streamingData.adaptiveFormats) {
          format.maxDvrDurationSec = MAX_DVR_SECONDS
        }
      }
    }
  }

  const patchResponse = (data) => {
    if (!data || typeof data !== 'object') return false
    if (data.videoDetails) modifyPlayerResponse(data)
    else if (data.playerResponse?.videoDetails) modifyPlayerResponse(data.playerResponse)
    else return false
    return true
  }

  // Source 1: the inline `ytInitialPlayerResponse` on first load. Intercept once, then
  // release the global so uBO and other scriptlets can keep editing it normally.
  const initialDescriptor =
    Object.getOwnPropertyDescriptor(pageWindow, 'ytInitialPlayerResponse')
  const previousInitialGetter = initialDescriptor?.get
  const previousInitialSetter = initialDescriptor?.set
  let initialResponse = pageWindow.ytInitialPlayerResponse

  if (!patchResponse(initialResponse)) {
    try {
      Object.defineProperty(pageWindow, 'ytInitialPlayerResponse', {
        configurable: true,
        enumerable: initialDescriptor ? initialDescriptor.enumerable : true,
        get() {
          return previousInitialGetter ? previousInitialGetter.call(this) : initialResponse
        },
        set(value) {
          previousInitialSetter?.call(this, value)
          initialResponse = value
          const current = previousInitialGetter ? previousInitialGetter.call(this) : value
          const didPatch = patchResponse(current) || (current !== value && patchResponse(value))
          if (didPatch && !previousInitialGetter && !previousInitialSetter) {
            Object.defineProperty(pageWindow, 'ytInitialPlayerResponse', {
              configurable: true,
              enumerable: initialDescriptor ? initialDescriptor.enumerable : true,
              writable: true,
              value,
            })
          }
        },
      })
    } catch (_) {
      patchResponse(pageWindow.ytInitialPlayerResponse)
    }
  }

  // Source 2: player responses fetched on later in-site navigations pass through JSON.parse.
  const nativeJsonParse = pageWindow.JSON.parse
  pageWindow.JSON.parse = function (...args) {
    const data = nativeJsonParse.apply(this, args)
    try {
      patchResponse(data)
    } catch (_) {
      // Never let our hook break the page.
    }
    return data
  }

  // Lift the ~13h rewind cap: the flag lives in a serialized "key=value&..." string inside
  // ytcfg's per-player config, which the player parses — rewrite it before that happens.
  // Track patched configs individually (no global "done" flag), so player
  // configs registered later (miniplayer, inline preview) still get patched.
  const patchedPlayerConfigs = new WeakSet()

  const liftDvrCap = (ytcfg) => {
    const store = typeof ytcfg.d === 'function' && ytcfg.d()
    const players = store?.WEB_PLAYER_CONTEXT_CONFIGS
    if (!players) return

    for (const id in players) {
      const config = players[id]
      if (
        typeof config?.serializedExperimentFlags !== 'string' ||
        patchedPlayerConfigs.has(config)
      ) {
        continue
      }

      config.serializedExperimentFlags = config.serializedExperimentFlags.replace(
        DVR_WINDOW_FLAG_PATTERN,
        `${DVR_WINDOW_FLAG}=${MAX_DVR_SECONDS}`
      )
      patchedPlayerConfigs.add(config)
    }
  }

  const hookYtcfg = (ytcfg) => {
    if (!ytcfg || ytcfg.__dvrHooked) return ytcfg
    ytcfg.__dvrHooked = true

    const nativeSet = ytcfg.set
    if (typeof nativeSet === 'function') {
      ytcfg.set = function (...args) {
        const result = nativeSet.apply(this, args)
        try {
          liftDvrCap(ytcfg)
        } catch (_) {}
        return result
      }
    }

    try {
      liftDvrCap(ytcfg)
    } catch (_) {}
    return ytcfg
  }

  // ytcfg is created by an inline page script that runs after us; intercept its creation.
  let ytcfgRef = hookYtcfg(pageWindow.ytcfg)
  try {
    Object.defineProperty(pageWindow, 'ytcfg', {
      configurable: true,
      get() {
        return ytcfgRef
      },
      set(value) {
        ytcfgRef = hookYtcfg(value)
      },
    })
  } catch (_) {
    // Already present and non-configurable — handled by the direct hook above.
  }

  const $ = (element) => document.querySelector(element)
  const addStyle = (css) => {
    const styleElement = document.createElement('style')
    styleElement.textContent = css
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const SCREENSHOT_KEY = 's'
  const SCREENSHOT_WORKER_TIMEOUT = 15000
  const TOOLTIP_VERTICAL_GAP = 22
  const FEEDBACK_DURATION = 3000
  const LIVE_CATCHUP_TARGET_BUFFER = 0.5
  const LIVE_CATCHUP_RATE = 1.5
  const LIVE_CATCHUP_INTERVAL = 250
  const MAX_VOLUME_GAIN = 3

  let container
  let sizeBtn
  let videoTitle
  let moviePlayer
  let progressBar
  let videoPlayer
  let volumeAudioContext = null
  let volumeGain = null
  let volumeSource = null
  const volumeSources = new WeakMap()
  const failedVolumeVideos = new WeakSet()
  let volumeGainEnabled = false
  let volumeActivationBound = false
  let pendingVolumeTarget = null
  let floatingBar
  let tooltip
  let tooltipText
  let tooltipKey
  let tooltipFrame = 0
  let tooltipHideTimer = 0
  let tooltipButton = null
  let liveBtn
  let floatingBarTimer = 0
  let persistentFloatingBarText = ''
  let liveCatchupTimer = 0
  let liveCatchupPreviousRate = null
  let screenshotWorker = null
  let screenshotWorkerAvailable = true
  let screenshotWorkerJobId = 0
  let screenshotInFlight = false
  const screenshotWorkerJobs = new Map()

  const data = {
    svg: {
      live: 'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4a2 2 0 0 1 0-4ZM6.34 6.34a8 8 0 0 0 0 11.32l1.42-1.42a6 6 0 0 1 0-8.48L6.34 6.34Zm11.32 0l-1.42 1.42a6 6 0 0 1 0 8.48l1.42 1.42a8 8 0 0 0 0-11.32Z',
      photo: 'M480-260q75 0 127.5-52.5T660-440q0-75-52.5-127.5T480-620q-75 0-127.5 52.5T300-440q0 75 52.5 127.5T480-260Zm0-80q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29ZM160-120q-33 0-56.5-23.5T80-200v-480q0-33 23.5-56.5T160-760h126l74-80h240l74 80h126q33 0 56.5 23.5T880-680v480q0 33-23.5 56.5T800-120H160Zm0-80h640v-480H638l-73-80H395l-73 80H160v480Zm320-240Z',
      speed: 'M418-340q24 24 62 23.5t56-27.5l224-336-336 224q-27 18-28.5 55t22.5 61Zm62-460q59 0 113.5 16.5T696-734l-76 48q-33-17-68.5-25.5T480-720q-133 0-226.5 93.5T160-400q0 42 11.5 83t32.5 77h552q23-38 33.5-79t10.5-85q0-36-8.5-70T766-540l48-76q30 47 47.5 100T880-406q1 57-13 109t-41 99q-11 18-30 28t-40 10H204q-21 0-40-10t-30-28q-26-45-40-95.5T80-400q0-83 31.5-155.5t86-127Q252-737 325-768.5T480-800Zm7 313Z',
      close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    },
  }

  addStyle(`
    /* Always hide in-video Shorts metadata and keep native info/comments inside
       the right-side panel with a top tab switcher. */
    ytd-shorts ytd-reel-video-renderer .ytReelPlayerOverlayViewModelMetadataContainer,
    ytd-shorts ytd-reel-video-renderer #metapanel {
      display: none !important;
    }

    ytd-shorts[data-yt-shorts-tabs]:not([small-screen-persistent-panel]) {
      --yt-shorts-tabs-height: 44px;
      --ytd-comments-engagement-panel-content-height: calc(max(var(--ytd-shorts-player-height), var(--ytd-reels-min-height, 576px)) - var(--yt-shorts-tabs-height));
      --ytd-engagement-panel-content-min-height: calc(var(--ytd-reels-min-height, 576px) - var(--yt-shorts-tabs-height));
      --ytd-engagement-panel-content-height: calc(max(var(--ytd-shorts-player-height), var(--ytd-reels-min-height, 576px)) + 56px - var(--yt-shorts-tabs-height));
    }

    #anchored-panel[data-yt-shorts-tabs] {
      display: flex !important;
      flex-direction: column !important;
    }

    #anchored-panel[data-yt-shorts-tabs] > ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] {
      flex: 1 1 auto !important;
      min-height: 0 !important;
      max-height: calc(100% - var(--yt-shorts-tabs-height, 44px)) !important;
      width: 100% !important;
    }

    #anchored-panel[data-yt-shorts-tabs] ytd-engagement-panel-title-header-renderer #visibility-button,
    #anchored-panel[data-yt-shorts-tabs] yt-video-title-header-view-model .ytVideoTitleHeaderViewModelHeaderButton,
    #anchored-panel[data-yt-shorts-tabs] yt-floating-button-view-model.ytFloatingButtonViewModelHostSdDesktop {
      display: none !important;
    }

    #yt-shorts-panel-tabs {
      order: -10;
      flex: 0 0 auto;
      box-sizing: border-box;
      height: var(--yt-shorts-tabs-height, 44px);
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      padding: 0 8px 0 12px;
      background-color: var(--yt-spec-base-background, #212121);
      color: var(--yt-spec-text-primary, #f1f1f1);
      border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.1));
      border-radius: 12px 12px 0 0;
    }

    html:not([dark]) #yt-shorts-panel-tabs {
      background-color: var(--yt-spec-base-background, #fff);
      color: var(--yt-spec-text-primary, #0f0f0f);
      border-bottom-color: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1));
    }

    #yt-shorts-panel-tabs[hidden],
    ytd-shorts:not([is-watch-while-mode]) #yt-shorts-panel-tabs {
      display: none !important;
    }

    .yt-shorts-panel-tablist {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
      align-items: stretch;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      gap: 4px;
    }

    .yt-shorts-panel-tablist::-webkit-scrollbar {
      display: none;
    }

    .yt-shorts-panel-tab {
      position: relative;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-inline-size: 64px;
      min-block-size: 44px;
      padding: 0 12px;
      border: 0;
      margin: 0;
      background: transparent;
      color: var(--yt-spec-text-secondary, #aaa);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      white-space: nowrap;
      cursor: pointer;
    }

    html:not([dark]) .yt-shorts-panel-tab {
      color: var(--yt-spec-text-secondary, #606060);
    }

    .yt-shorts-panel-tab:hover {
      color: var(--yt-spec-text-primary, #f1f1f1);
    }

    html:not([dark]) .yt-shorts-panel-tab:hover {
      color: var(--yt-spec-text-primary, #0f0f0f);
    }

    .yt-shorts-panel-tab[aria-selected="true"] {
      color: var(--yt-spec-text-primary, #f1f1f1);
    }

    html:not([dark]) .yt-shorts-panel-tab[aria-selected="true"] {
      color: var(--yt-spec-text-primary, #0f0f0f);
    }

    .yt-shorts-panel-tab[aria-selected="true"]::after {
      content: "";
      position: absolute;
      inset: auto 8px 0;
      border-block-end: 2px solid currentColor;
    }

    .yt-shorts-panel-close {
      flex: none;
      align-self: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      margin: 0 0 0 8px;
      border-radius: 50%;
      background: transparent;
      color: var(--yt-spec-text-primary, #f1f1f1);
      cursor: pointer;
    }

    html:not([dark]) .yt-shorts-panel-close {
      color: var(--yt-spec-text-primary, #0f0f0f);
    }

    .yt-shorts-panel-close:hover {
      background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.1));
    }

    html:not([dark]) .yt-shorts-panel-close:hover {
      background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.08));
    }

    .yt-shorts-panel-tab:focus-visible,
    .yt-shorts-panel-close:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: -2px;
    }

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
      height: 25px;
      color: #fff;
      background-color: rgba(0, 0, 0, 0.5);
      text-align: center;
      font-size: 16px;
      line-height: 25px;
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
      pointer-events: auto;
    }

    #yt-player-tweaks-tooltip[data-has-key="false"]
      .ytp-tooltip-bottom-text > .ytp-tooltip-keyboard-shortcut {
      display: none !important;
    }
  `)

  const isWatchPage = () =>
    location.pathname === '/watch' ||
    location.pathname.startsWith('/live/')

  const isShortsPage = () => location.pathname.startsWith('/shorts/')

  const eventTarget = (event) => event?.composedPath?.()[0] || event?.target

  const isEditableTarget = (target) =>
    target instanceof HTMLElement &&
    (
      target.isContentEditable ||
      target.matches('input, textarea, select, [role="textbox"], [contenteditable="true"], [contenteditable=""]')
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
    let element = moviePlayer.querySelector('#yt-player-tweaks-float-bar')

    if (!element) {
      element = document.createElement('div')
      element.id = 'yt-player-tweaks-float-bar'
      moviePlayer.appendChild(element)
    }

    return element
  }

  const showFloatingBar = (timer, text) => {
    if (timer) clearTimeout(timer)

    floatingBar.textContent = text
    floatingBar.style.display = 'block'

    return setTimeout(() => {
      if (persistentFloatingBarText) {
        floatingBar.textContent = persistentFloatingBarText
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

  const TOOLTIP_HOVER_GRACE = 100

  const getTooltip = () => {
    let element = $('#yt-player-tweaks-tooltip')

    if (!element) {
      element = document.createElement('div')
      element.id = 'yt-player-tweaks-tooltip'
      element.className = 'ytp-tooltip ytp-bottom'
      element.setAttribute('role', 'tooltip')
      element.dataset.visible = 'false'
      element.dataset.hasKey = 'false'

      const wrapper = document.createElement('div')
      wrapper.className = 'ytp-tooltip-text-wrapper'

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
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = 0
    if (tooltipButton && tooltipButton !== button) {
      tooltipButton.removeAttribute?.('aria-describedby')
    }
    tooltipButton = button
    if (tooltip?.id) button?.setAttribute?.('aria-describedby', tooltip.id)

    tooltipText.textContent = text
    tooltipKey.textContent = key
    tooltip.dataset.hasKey = String(Boolean(key))
    tooltip.dataset.visible = 'true'

    if (tooltipFrame) cancelAnimationFrame(tooltipFrame)
    tooltipFrame = requestAnimationFrame(() => {
      tooltipFrame = 0
      if (!tooltip || tooltip.dataset.visible !== 'true') return
      positionTooltip(button)
    })
  }

  const hideTooltip = () => {
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = 0
    if (tooltipFrame) {
      cancelAnimationFrame(tooltipFrame)
      tooltipFrame = 0
    }
    if (tooltipButton) {
      tooltipButton.removeAttribute?.('aria-describedby')
      tooltipButton = null
    }
    if (tooltip) tooltip.dataset.visible = 'false'
  }

  const scheduleHideTooltip = () => {
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = setTimeout(() => {
      tooltipHideTimer = 0
      hideTooltip()
    }, TOOLTIP_HOVER_GRACE)
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
      let queue = Promise.resolve()

      const encode = async ({ id, frame, width, height }) => {
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

      self.onmessage = ({ data }) => {
        queue = queue.then(() => encode(data))
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
    // Worker startup can fail while the ImageBitmap fallback is still pending.
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
        // VideoFrame serialization shares the underlying pixels. Keep our
        // reference so a worker failure can still encode the clicked frame.
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

  const encodeScreenshot = async () => {
    const source = videoPlayer
    const width = source.videoWidth
    const height = source.videoHeight
    let frame

    try {
      // Usually already started while the player was idle.
      const worker = getScreenshotWorker()
      if (!worker) {
        return encodeScreenshotOnMainThread(source, width, height)
      }

      if (typeof VideoFrame === 'function') {
        try {
          // Freeze the decoded frame synchronously, avoiding an intermediate
          // ImageBitmap conversion on the UI thread.
          frame = new VideoFrame(source)
        } catch (_) {}
      }
      if (!frame) frame = await createImageBitmap(source)

      return await encodeScreenshotInWorker(worker, frame, width, height)
    } catch (_) {
      return encodeScreenshotOnMainThread(frame || source, width, height)
    } finally {
      // The fallback draws synchronously before returning its PNG promise.
      frame?.close()
    }
  }

  const screenShot = () => {
    if (
      screenshotInFlight ||
      !videoPlayer ||
      !videoPlayer.videoWidth ||
      !videoPlayer.videoHeight
    ) {
      return
    }

    screenshotInFlight = true

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

    // Freeze the current frame, then draw and encode in the worker. One PNG
    // is shared by clipboard and download, so neither path re-encodes it.
    const blobPromise = encodeScreenshot().finally(() => {
      screenshotInFlight = false
    })

    // Called inside the user gesture so the clipboard keeps its permission.
    try {
      navigator.clipboard
        .write([new ClipboardItem({ 'image/png': blobPromise })])
        .catch(() => {})
    } catch (_) {
      // Clipboard permission may be unavailable; downloading still works.
    }

    blobPromise.then((blob) => {
      if (!blob) return

      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = `${fileName}.png`
      link.hidden = true

      // Start downloading as soon as the PNG is ready, without an extension
      // round-trip. The browser saves to its configured download location.
      try {
        ;(document.body || document.documentElement).appendChild(link)
        link.click()
      } finally {
        link.remove()
        // Keep the URL alive until the browser has picked up the download.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)
      }
    }).catch((error) => {
      console.warn('[YouTube Player Tweaks] Screenshot failed:', error)
      if (floatingBar?.isConnected) {
        floatingBarTimer = showFloatingBar(floatingBarTimer, '截圖失敗，請再試一次')
      }
    })
  }


  const isLivePlayback = () =>
    Boolean(moviePlayer?.getVideoData?.()?.isLive)

  const getBufferedRangeHealth = () => {
    if (!videoPlayer?.buffered?.length) return null

    const currentTime = videoPlayer.currentTime

    for (let index = videoPlayer.buffered.length - 1; index >= 0; index--) {
      const start = videoPlayer.buffered.start(index)
      const end = videoPlayer.buffered.end(index)

      if (start <= currentTime && currentTime <= end) {
        return Math.max(0, end - currentTime)
      }
    }

    return null
  }

  const getProgressBufferHealth = () => {
    const progressState = moviePlayer?.getProgressState?.()

    if (
      Number.isFinite(progressState?.loaded) &&
      Number.isFinite(progressState?.current)
    ) {
      return Math.max(0, progressState.loaded - progressState.current)
    }

    return null
  }

  const getLiveBufferHealth = () => {
    const bufferedHealth = getBufferedRangeHealth()

    if (Number.isFinite(bufferedHealth)) return bufferedHealth

    return getProgressBufferHealth()
  }

  const getPlaybackRate = () => {
    const playerRate = Number(moviePlayer?.getPlaybackRate?.())

    if (Number.isFinite(playerRate)) return playerRate

    return Number(videoPlayer?.playbackRate)
  }

  const setPlaybackRate = (rate) => {
    if (!Number.isFinite(rate)) return

    try {
      moviePlayer?.setPlaybackRate?.(rate)
    } catch (_) {
      // Some player states reject API playback-rate changes.
    }

    if (videoPlayer) {
      videoPlayer.playbackRate = rate
    }
  }

  const restorePlaybackRate = (rate) => {
    // Restore once through both APIs. A later 1.5x value may be the user's
    // own choice, so it cannot safely be treated as a failed restore.
    setPlaybackRate(Number.isFinite(rate) ? rate : 1)
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
      Number.isFinite(liveCatchupPreviousRate)
    ) {
      restorePlaybackRate(liveCatchupPreviousRate)
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

    // Only touch the player API when the rate actually drifted, instead of
    // re-issuing setPlaybackRate 4x per second.
    if (Number(videoPlayer.playbackRate) !== LIVE_CATCHUP_RATE) {
      setPlaybackRate(LIVE_CATCHUP_RATE)
    }
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

    liveCatchupPreviousRate = getPlaybackRate()
    liveCatchupTimer = setInterval(runLiveCatchupStep, LIVE_CATCHUP_INTERVAL)

    updateLiveButtonState()
    runLiveCatchupStep()
    if (liveCatchupTimer) showPersistentFloatingBar('追直播中')
  }

  const syncVolumeGain = () => {
    if (!volumeGain || !moviePlayer) return

    // The native media volume is already 0–1. Scaling its output by 3x
    // that value makes quiet settings quieter and full volume up to 300%.
    const volume = Math.max(0, Math.min(100, moviePlayer.getVolume()))
    volumeGain.gain.value = MAX_VOLUME_GAIN * volume / 100
  }

  const bindVolumeActivation = () => {
    if (volumeActivationBound) return
    volumeActivationBound = true
    const activate = () => {
      if (!volumeAudioContext) return
      const resumeAndApply = () => {
        if (volumeAudioContext?.state !== 'running') return
        if (volumeGainEnabled && (pendingVolumeTarget || videoPlayer)) {
          pendingVolumeTarget = null
          ensureVolumeGain()
        }
        document.removeEventListener?.('pointerdown', activate, true)
        document.removeEventListener?.('keydown', activate, true)
        volumeActivationBound = false
      }
      if (volumeAudioContext.state === 'suspended') {
        volumeAudioContext.resume().then(resumeAndApply).catch(() => {})
      } else {
        resumeAndApply()
      }
    }
    document.addEventListener('pointerdown', activate, { capture: true, passive: true })
    document.addEventListener('keydown', activate, { capture: true, passive: true })
  }

  const ensureVolumeGain = () => {
    volumeGainEnabled = true
    const AudioContextClass = pageWindow.AudioContext || pageWindow.webkitAudioContext
    if (!AudioContextClass || !videoPlayer || failedVolumeVideos.has(videoPlayer)) return

    let source
    try {
      // A cross-origin media URL without CORS would become silent when routed
      // through MediaElementAudioSourceNode. YouTube's same-origin blob is safe.
      const sourceUrl = videoPlayer.currentSrc
      if (sourceUrl && new URL(sourceUrl, pageWindow.location.href).origin !== pageWindow.location.origin) return

      if (!volumeAudioContext) {
        volumeAudioContext = new AudioContextClass()
        volumeGain = volumeAudioContext.createGain()
        volumeGain.connect(volumeAudioContext.destination)
      }

      if (volumeAudioContext.state === 'suspended') {
        volumeAudioContext.resume().then(() => {
          if (volumeAudioContext?.state === 'running' && volumeGainEnabled && videoPlayer) {
            pendingVolumeTarget = null
            ensureVolumeGain()
          }
        }).catch(() => {})
      }

      // Never call createMediaElementSource before AudioContext is running:
      // taking ownership during a wheel gesture without user activation mutes playback.
      if (volumeAudioContext.state !== 'running') {
        pendingVolumeTarget = videoPlayer
        bindVolumeActivation()
        return
      }

      const cachedSource = volumeSources.get(videoPlayer)
      if (!cachedSource || volumeSource !== cachedSource) {
        volumeSource?.disconnect()
        volumeSource = cachedSource
        if (!volumeSource) {
          source = volumeAudioContext.createMediaElementSource(videoPlayer)
          volumeSource = source
          volumeSources.set(videoPlayer, volumeSource)
        }
        volumeSource.connect(volumeGain)
      }

      syncVolumeGain()
    } catch (_) {
      if (source) {
        try {
          source.disconnect()
          source.connect(volumeAudioContext.destination)
        } catch (_) {}
      }
      if (!volumeSources.has(videoPlayer)) failedVolumeVideos.add(videoPlayer)
      // Keep YouTube's native volume working if Web Audio is unavailable.
    }
  }

  const changeVolume = (event) => {
    event.preventDefault()

    let volume = moviePlayer.getVolume()
    moviePlayer.unMute(true)

    volume = event.deltaY < 0 ? volume + 5 : volume - 5
    volume = Math.max(0, Math.min(100, volume))

    moviePlayer.setVolume(volume, true)
    ensureVolumeGain()
    floatingBarTimer = showFloatingBar(floatingBarTimer, String(volume))
  }

  const changeSpeed = (event) => {
    event.preventDefault()
    event.stopPropagation()

    if (liveCatchupTimer) {
      stopLiveCatchup('', false)
    }

    let playbackRate = getPlaybackRate()
    playbackRate =
      event.deltaY < 0
        ? Math.min(16, playbackRate + 0.1)
        : Math.max(0.1, playbackRate - 0.1)

    playbackRate = Number(playbackRate.toFixed(1))
    setPlaybackRate(playbackRate)

    floatingBarTimer = showFloatingBar(floatingBarTimer, `${playbackRate}x`)
  }

  const resetSpeed = () => {
    if (liveCatchupTimer) {
      stopLiveCatchup('', false)
    }

    setPlaybackRate(1)
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

  const bindTooltipEvents = (button, getLabel, shortcut, signal) => {
    const show = (event) => showTooltip(event.currentTarget, getLabel(), shortcut)
    button.addEventListener('mouseenter', show, { signal })
    button.addEventListener('mouseleave', scheduleHideTooltip, { signal })
    button.addEventListener('focus', show, { signal })
    button.addEventListener('blur', hideTooltip, { signal })
  }

  const bindButtonEvents = ({ liveBtn, photoBtn, speedBtn }, signal) => {
    liveBtn.addEventListener('click', toggleLiveCatchup, { signal })
    bindTooltipEvents(liveBtn, getLiveTooltipText, '', signal)

    photoBtn.addEventListener('click', screenShot, { signal })
    bindTooltipEvents(photoBtn, () => '截圖', 'S', signal)

    speedBtn.addEventListener('click', resetSpeed, { signal })
    speedBtn.addEventListener('wheel', changeSpeed, { passive: false, signal })
    bindTooltipEvents(speedBtn, () => '播放速度', '', signal)

    videoPlayer.addEventListener('loadedmetadata', updateLiveButtonVisibility, { signal })
    videoPlayer.addEventListener('playing', updateLiveButtonVisibility, { signal })
    videoPlayer.addEventListener('volumechange', syncVolumeGain, { signal })
    moviePlayer.addEventListener('pointerdown', (event) => {
      if (event.target?.closest?.('.ytp-volume-area')) ensureVolumeGain()
    }, { capture: true, signal })
  }

  const handleWheelCapture = (event) => {
    if (!container || !moviePlayer || event.ctrlKey || event.deltaY === 0) return

    const target = event.target
    if (!(target instanceof Node)) return

    if (container.contains(target)) {
      event.stopImmediatePropagation()
      changeVolume(event)
    }
  }

  const handleShortsWheel = (event) => {
    if (!isShortsPage() || event.ctrlKey || event.deltaY === 0) return
    if (!(event.target instanceof Node) || isEditableTarget(eventTarget(event))) return

    const shorts = event.target.closest?.('ytd-shorts')
    if (!shorts) return

    // Shorts can keep multiple reels in the DOM. Locate the player under the
    // pointer each time, including after an in-feed switch without navigation.
    // Its extracted overlay is outside the video container, so use geometry.
    for (const player of shorts.querySelectorAll('.html5-video-player')) {
      const reel = player.closest('ytd-reel-video-renderer')
      const area = reel?.querySelector('#short-video-container') || player
      const rect = area.getBoundingClientRect()
      if (
        rect.width <= 0 || rect.height <= 0 ||
        event.clientX < rect.left || event.clientX >= rect.right ||
        event.clientY < rect.top || event.clientY >= rect.bottom
      ) continue

      const activeVideo = player.querySelector('video')
      if (
        !activeVideo ||
        typeof player.getVolume !== 'function' ||
        typeof player.setVolume !== 'function' ||
        typeof player.unMute !== 'function'
      ) continue

      if (moviePlayer !== player) {
        if (floatingBarTimer) clearTimeout(floatingBarTimer)
        floatingBarTimer = 0
        if (floatingBar) floatingBar.style.display = 'none'
      }

      moviePlayer = player
      videoPlayer = activeVideo
      floatingBar = getFloatingBar()
      event.stopImmediatePropagation()
      changeVolume(event)
      return
    }
  }

  const SHORTS_PANEL_COMMENTS = 'engagement-panel-comments-section'
  const SHORTS_PANEL_DESCRIPTION = 'engagement-panel-structured-description'
  const SHORTS_PANEL_EXPANDED = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
  const SHORTS_MIN_SIDE_PANEL_WIDTH = 960
  const SHORTS_AUTO_OPEN_MAX_ATTEMPTS = 12
  const SHORTS_AUTO_OPEN_RETRY_MS = 250
  const SHORTS_DESC_FALLBACK_MS = 180
  const SHORTS_DESC_MENU_POLL_MS = 50
  const SHORTS_DESC_MENU_MAX_POLLS = 8
  const SHORTS_PENDING_GRACE_MS = 900

  const SHORTS_COMMENT_PATH_RE = /^(?:M1 6a4 4 0 014-4h14|M20 2H4|M8 7h8|M18 4H6)/
  const SHORTS_COMMENT_LABEL_RE = /comment|留言|コメント|评论|댓글/i
  const SHORTS_MORE_ACTIONS_LABEL_RE = /more actions|其他動作|その他の操作|更多操作|더보기/i
  const SHORTS_THREE_DOTS_PATH_RE = /^(?:M12 16\.5|M12 4a2|M12 8c1\.1)/
  const SHORTS_DESC_PATH_RE = /^M4 5a1 1 0 000 2h16/
  const SHORTS_DESC_TEXT_RE = /^(description|說明|説明|简介|설명)$/i

  let shortsPanelDismissed = false
  let activeShortsSession = null

  const getShortKey = () => {
    const match = location.pathname.match(/^\/shorts\/([^/?#]+)/)
    return match ? match[1] : location.pathname
  }

  const getActiveShortsReel = (shorts) => {
    if (!shorts) return null
    const explicit = shorts.querySelector('ytd-reel-video-renderer[is-active]')
    if (explicit) return explicit
    const reels = shorts.querySelectorAll('ytd-reel-video-renderer')
    if (reels.length === 1) return reels[0]
    if (!reels.length) return null
    const bounds = shorts.querySelector('#shorts-container')?.getBoundingClientRect?.()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return reels[0]

    let bestReel = reels[0]
    let bestOverlap = -1
    for (const reel of reels) {
      const target = reel.querySelector('#short-video-container') || reel
      const rect = target.getBoundingClientRect?.()
      if (!rect) continue
      const overlapX = Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left))
      const overlapY = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top))
      const overlap = overlapX * overlapY
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestReel = reel
      }
    }
    return bestReel
  }

  const getExpandedShortsPanel = (shorts) => {
    const root = shorts?.querySelector('#anchored-panel') || shorts
    if (!root) return null
    for (const panel of root.querySelectorAll('ytd-engagement-panel-section-list-renderer')) {
      if (panel.getAttribute('visibility') === SHORTS_PANEL_EXPANDED) return panel
    }
    return null
  }

  const isControlDisabled = (element) =>
    !element ||
    Boolean(element.disabled) ||
    element.hasAttribute?.('disabled') ||
    element.getAttribute?.('aria-disabled') === 'true'

  const findShortsCommentsButton = (reel) => {
    if (!reel) return null
    const legacy = reel.querySelector('#comments-button button') || reel.querySelector('#comments-button')
    if (legacy) return legacy

    const actionBar = reel.querySelector('reel-action-bar-view-model')
    if (!actionBar) return null

    const candidates = []
    for (const button of actionBar.querySelectorAll('button')) {
      if (!button.closest?.('button-view-model')) continue
      if (button.closest?.('like-button-view-model, dislike-button-view-model, pivot-button-view-model')) {
        continue
      }
      candidates.push(button)
    }

    for (const button of candidates) {
      for (const path of button.querySelectorAll('path')) {
        const d = path.getAttribute?.('d') || ''
        if (SHORTS_COMMENT_PATH_RE.test(d)) return button
      }
    }

    for (const button of candidates) {
      const label = button.getAttribute?.('aria-label') || ''
      if (SHORTS_COMMENT_LABEL_RE.test(label)) return button
    }

    return candidates[0] || null
  }

  const findShortsDescriptionTitleTarget = (reel) => {
    if (!reel) return null
    return (
      reel.querySelector('yt-shorts-video-title-view-model h1[role="link"]') ||
      reel.querySelector('.ytShortsVideoTitleViewModelShortsVideoTitle') ||
      reel.querySelector('yt-shorts-video-title-view-model')
    )
  }

  const findShortsMoreActionsButton = (reel) => {
    if (!reel) return null
    for (const button of reel.querySelectorAll('button')) {
      if (button.closest?.('reel-action-bar-view-model, .ytReelPlayerOverlayViewModelMetadataContainer')) {
        continue
      }
      const label = button.getAttribute?.('aria-label') || ''
      if (SHORTS_MORE_ACTIONS_LABEL_RE.test(label)) return button
      if (button.closest?.('#menu-button')) return button
      for (const path of button.querySelectorAll('path')) {
        const d = path.getAttribute?.('d') || ''
        if (SHORTS_THREE_DOTS_PATH_RE.test(d)) return button
      }
    }
    return null
  }

  const isDropdownVisible = (dropdown) => {
    if (!dropdown || dropdown.hasAttribute?.('hidden')) return false
    if (dropdown.getAttribute?.('aria-hidden') === 'true') return false
    if (dropdown.style?.display === 'none') return false
    return true
  }

  const findDescriptionMenuItem = () => {
    const menus = []
    const dropdowns = [...document.querySelectorAll('tp-yt-iron-dropdown')]
    for (const dropdown of dropdowns) {
      if (!isDropdownVisible(dropdown)) continue
      const menu = dropdown.querySelector('yt-list-view-model[role="menu"]')
      if (menu) menus.push(menu)
    }
    if (!dropdowns.length) {
      const fallbackMenu = document.querySelector('yt-list-view-model[role="menu"]')
      if (fallbackMenu && isDropdownVisible(fallbackMenu)) menus.push(fallbackMenu)
    }

    for (const menu of menus) {
      const items = menu.querySelectorAll('yt-list-item-view-model')
      if (!items.length) continue
      for (const item of items) {
        for (const path of item.querySelectorAll('path')) {
          const d = path.getAttribute?.('d') || ''
          if (SHORTS_DESC_PATH_RE.test(d)) {
            return item.querySelector('button, [role="menuitem"]') || item
          }
        }
      }
      for (const item of items) {
        const text = (item.textContent || '').trim()
        if (SHORTS_DESC_TEXT_RE.test(text)) {
          return item.querySelector('button, [role="menuitem"]') || item
        }
      }
      const first = items[0]
      return first.querySelector('button, [role="menuitem"]') || first
    }
    return null
  }

  const findNativePanelCloseButton = (panel) => {
    if (!panel) return null
    return (
      panel.querySelector('#visibility-button button') ||
      panel.querySelector('yt-video-title-header-view-model .ytVideoTitleHeaderViewModelHeaderButton button') ||
      panel.querySelector('yt-floating-button-view-model button')
    )
  }

  const canAutoOpenShortsPanel = (shorts, reel) => {
    if (!shorts || !shorts.querySelector('#anchored-panel')) return false
    if (shortsPanelDismissed) return false
    if (
      document.fullscreenElement ||
      shorts.hasAttribute('is-fullscreen') ||
      reel?.hasAttribute('is-fullscreen')
    ) {
      return false
    }
    if (
      shorts.hasAttribute('small-screen-persistent-panel') ||
      shorts.querySelector('#anchored-panel-scrim')
    ) {
      return false
    }
    const width = window.innerWidth
    if (Number.isFinite(width) && width > 0 && width < SHORTS_MIN_SIDE_PANEL_WIDTH) {
      return false
    }
    return true
  }

  const startShortsPanelController = (signal) => {
    let frame = 0
    let currentShortKey = getShortKey()
    let desiredTab = 'comments'
    let pendingTarget = null
    let pendingUntil = 0
    let autoOpenAttempts = 0
    let autoOpenExhausted = false
    let waitingAutoRetry = false
    let autoOpenTimer = 0
    let menuFallbackTimer = 0
    let menuPollTimer = 0
    let internalClick = false
    let lastActiveTab = null

    const tabBar = document.createElement('div')
    tabBar.id = 'yt-shorts-panel-tabs'
    tabBar.hidden = true

    const tablist = document.createElement('div')
    tablist.className = 'yt-shorts-panel-tablist'
    tablist.setAttribute('role', 'tablist')
    tablist.setAttribute('focusgroup', 'tablist nomemory')
    tablist.setAttribute('aria-label', 'Shorts 面板')

    const makeTab = (id, label, selected) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'yt-shorts-panel-tab'
      tab.setAttribute('role', 'tab')
      tab.dataset.tab = id
      tab.setAttribute('aria-selected', String(selected))
      tab.setAttribute('tabindex', selected ? '0' : '-1')
      if (selected) tab.setAttribute('focusgroupstart', '')
      tab.textContent = label
      return tab
    }

    const commentsTab = makeTab('comments', '留言', true)
    const descTab = makeTab('description', '影片資訊', false)
    const tabs = [commentsTab, descTab]
    tablist.append(commentsTab, descTab)

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'yt-shorts-panel-close'
    closeBtn.setAttribute('aria-label', '關閉')

    const closeSvg = document.createElementNS(SVG_NS, 'svg')
    closeSvg.setAttribute('width', '20')
    closeSvg.setAttribute('height', '20')
    closeSvg.setAttribute('viewBox', '0 0 24 24')
    closeSvg.setAttribute('aria-hidden', 'true')
    closeSvg.setAttribute('focusable', 'false')

    const closePath = document.createElementNS(SVG_NS, 'path')
    closePath.setAttribute('d', data.svg.close)
    closePath.setAttribute('fill', 'currentColor')
    closeSvg.appendChild(closePath)
    closeBtn.appendChild(closeSvg)

    tabBar.append(tablist, closeBtn)

    const updateTabSelection = (activeTab) => {
      if (lastActiveTab === activeTab) return
      lastActiveTab = activeTab
      const fallbackTab = activeTab === 'description' ? descTab : commentsTab
      for (const tab of tabs) {
        const selected = tab.dataset.tab === activeTab
        const focusable = activeTab ? selected : tab === fallbackTab
        const selectedStr = String(selected)
        if (tab.getAttribute('aria-selected') !== selectedStr) {
          tab.setAttribute('aria-selected', selectedStr)
        }
        const nextTabIndex = focusable ? '0' : '-1'
        if (tab.getAttribute('tabindex') !== nextTabIndex) {
          tab.setAttribute('tabindex', nextTabIndex)
        }
        if (selected) {
          if (!tab.hasAttribute('focusgroupstart')) tab.setAttribute('focusgroupstart', '')
        } else if (tab.hasAttribute('focusgroupstart')) {
          tab.removeAttribute('focusgroupstart')
        }
      }
    }

    const clearAutoOpenTimer = () => {
      if (autoOpenTimer) {
        clearTimeout(autoOpenTimer)
        autoOpenTimer = 0
      }
    }

    const clearMenuTimers = () => {
      if (menuFallbackTimer) {
        clearTimeout(menuFallbackTimer)
        menuFallbackTimer = 0
      }
      if (menuPollTimer) {
        clearInterval(menuPollTimer)
        menuPollTimer = 0
      }
    }

    const clearAllTimers = () => {
      clearAutoOpenTimer()
      clearMenuTimers()
    }

    const clearShortsTabsState = (shorts, anchoredPanel) => {
      if (!tabBar.hidden) tabBar.hidden = true
      if (shorts?.hasAttribute('data-yt-shorts-tabs')) {
        shorts.removeAttribute('data-yt-shorts-tabs')
      }
      if (anchoredPanel?.hasAttribute('data-yt-shorts-tabs')) {
        anchoredPanel.removeAttribute('data-yt-shorts-tabs')
      }
    }

    const triggerInternalClick = (element) => {
      if (!element) return
      internalClick = true
      try {
        element.click()
      } finally {
        internalClick = false
      }
    }

    const openComments = (reel) => {
      const btn = findShortsCommentsButton(reel)
      if (!btn) return 'missing'
      if (isControlDisabled(btn)) {
        autoOpenExhausted = true
        return 'disabled'
      }
      triggerInternalClick(btn)
      return 'clicked'
    }

    const openDescription = (shorts, reel) => {
      clearMenuTimers()
      if (getExpandedShortsPanel(shorts)?.getAttribute('target-id') === SHORTS_PANEL_DESCRIPTION) {
        return
      }

      const startMenuFallback = () => {
        menuFallbackTimer = 0
        if (signal.aborted || desiredTab !== 'description' || shortsPanelDismissed) return
        const latestShorts = $('ytd-shorts')
        const latestReel = getActiveShortsReel(latestShorts)
        if (getExpandedShortsPanel(latestShorts)?.getAttribute('target-id') === SHORTS_PANEL_DESCRIPTION) {
          return
        }
        const moreBtn = findShortsMoreActionsButton(latestReel)
        if (!moreBtn) return
        triggerInternalClick(moreBtn)

        const firstTry = findDescriptionMenuItem()
        if (firstTry) {
          triggerInternalClick(firstTry)
          return
        }

        let polls = 0
        menuPollTimer = setInterval(() => {
          polls++
          if (
            signal.aborted ||
            desiredTab !== 'description' ||
            shortsPanelDismissed ||
            getExpandedShortsPanel($('ytd-shorts'))?.getAttribute('target-id') === SHORTS_PANEL_DESCRIPTION
          ) {
            clearMenuTimers()
            return
          }
          const item = findDescriptionMenuItem()
          if (item) {
            clearMenuTimers()
            triggerInternalClick(item)
            return
          }
          if (polls >= SHORTS_DESC_MENU_MAX_POLLS) {
            clearMenuTimers()
          }
        }, SHORTS_DESC_MENU_POLL_MS)
      }

      const titleTarget = findShortsDescriptionTitleTarget(reel)
      if (titleTarget) {
        triggerInternalClick(titleTarget)
        if (getExpandedShortsPanel(shorts)?.getAttribute('target-id') === SHORTS_PANEL_DESCRIPTION) {
          return
        }
        menuFallbackTimer = setTimeout(startMenuFallback, SHORTS_DESC_FALLBACK_MS)
        return
      }

      startMenuFallback()
    }

    const scheduleAutoOpenRetry = () => {
      if (autoOpenTimer || autoOpenExhausted || signal.aborted) return
      if (autoOpenAttempts >= SHORTS_AUTO_OPEN_MAX_ATTEMPTS) {
        autoOpenExhausted = true
        waitingAutoRetry = false
        return
      }
      autoOpenAttempts++
      autoOpenTimer = setTimeout(() => {
        autoOpenTimer = 0
        waitingAutoRetry = false
        if (!signal.aborted) sync()
      }, SHORTS_AUTO_OPEN_RETRY_MS)
    }

    const ensureDesiredPanel = (shorts, reel) => {
      if (desiredTab !== 'comments' || autoOpenExhausted || waitingAutoRetry) return
      const status = openComments(reel)
      if (status === 'disabled') {
        clearAutoOpenTimer()
        return
      }
      if (status === 'clicked') {
        const expanded = getExpandedShortsPanel(shorts)
        if (expanded?.getAttribute('target-id') === SHORTS_PANEL_COMMENTS) {
          clearAutoOpenTimer()
          waitingAutoRetry = false
          return
        }
        waitingAutoRetry = true
      }
      scheduleAutoOpenRetry()
    }

    const sync = () => {
      frame = 0
      if (signal.aborted) return

      const nextShortKey = getShortKey()
      if (nextShortKey !== currentShortKey) {
        currentShortKey = nextShortKey
        desiredTab = 'comments'
        pendingTarget = null
        pendingUntil = 0
        autoOpenAttempts = 0
        autoOpenExhausted = false
        waitingAutoRetry = false
        clearAllTimers()
      }

      const shorts = $('ytd-shorts')
      const anchoredPanel = shorts?.querySelector('#anchored-panel')
      if (!shorts || !anchoredPanel) {
        clearShortsTabsState(shorts, anchoredPanel || tabBar.parentElement)
        return
      }

      const reel = getActiveShortsReel(shorts)
      let expandedPanel = getExpandedShortsPanel(shorts)
      let expandedId = expandedPanel?.getAttribute('target-id') || ''

      if (
        desiredTab === 'comments' &&
        expandedId !== SHORTS_PANEL_COMMENTS &&
        !pendingTarget &&
        canAutoOpenShortsPanel(shorts, reel) &&
        !autoOpenExhausted
      ) {
        ensureDesiredPanel(shorts, reel)
        expandedPanel = getExpandedShortsPanel(shorts)
        expandedId = expandedPanel?.getAttribute('target-id') || ''
      }

      if (!expandedId) {
        clearShortsTabsState(shorts, anchoredPanel)
        return
      }

      clearAutoOpenTimer()
      waitingAutoRetry = false

      if (tabBar.parentElement !== anchoredPanel || anchoredPanel.firstChild !== tabBar) {
        anchoredPanel.insertBefore(tabBar, anchoredPanel.firstChild || null)
      }
      if (!shorts.hasAttribute('data-yt-shorts-tabs')) {
        shorts.setAttribute('data-yt-shorts-tabs', '')
      }
      if (!anchoredPanel.hasAttribute('data-yt-shorts-tabs')) {
        anchoredPanel.setAttribute('data-yt-shorts-tabs', '')
      }
      if (tabBar.hidden) tabBar.hidden = false

      const actualTab =
        expandedId === SHORTS_PANEL_COMMENTS
          ? 'comments'
          : expandedId === SHORTS_PANEL_DESCRIPTION
            ? 'description'
            : ''

      if (actualTab === desiredTab) {
        clearMenuTimers()
      }
      if (pendingTarget && (pendingTarget === actualTab || Date.now() >= pendingUntil)) {
        pendingTarget = null
        pendingUntil = 0
      }

      const displayTab = pendingTarget && Date.now() < pendingUntil ? pendingTarget : actualTab
      updateTabSelection(displayTab)
    }

    const schedule = () => {
      if (!frame && !signal.aborted) frame = requestAnimationFrame(sync)
    }

    tablist.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(event.target)
      if (index === -1) return
      let nextIndex = -1
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = tabs.length - 1
      if (nextIndex === -1) return

      event.preventDefault()
      event.stopPropagation()
      const nextTab = tabs[nextIndex]
      for (const tab of tabs) {
        tab.setAttribute('tabindex', tab === nextTab ? '0' : '-1')
      }
      nextTab.focus?.()
      nextTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', container: 'nearest' })
    }, { signal })

    commentsTab.addEventListener('click', () => {
      shortsPanelDismissed = false
      desiredTab = 'comments'
      autoOpenExhausted = false
      waitingAutoRetry = false
      clearAllTimers()
      const shorts = $('ytd-shorts')
      const reel = getActiveShortsReel(shorts)
      const status = openComments(reel)
      if (status === 'disabled') {
        pendingTarget = null
        pendingUntil = 0
        sync()
        return
      }
      pendingTarget = 'comments'
      pendingUntil = Date.now() + SHORTS_PENDING_GRACE_MS
      updateTabSelection('comments')
      commentsTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', container: 'nearest' })
      sync()
    }, { signal })

    descTab.addEventListener('click', () => {
      shortsPanelDismissed = false
      desiredTab = 'description'
      pendingTarget = 'description'
      pendingUntil = Date.now() + SHORTS_PENDING_GRACE_MS
      autoOpenExhausted = false
      waitingAutoRetry = false
      clearAllTimers()
      updateTabSelection('description')
      descTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', container: 'nearest' })
      const shorts = $('ytd-shorts')
      const reel = getActiveShortsReel(shorts)
      openDescription(shorts, reel)
      sync()
    }, { signal })

    closeBtn.addEventListener('click', () => {
      shortsPanelDismissed = true
      pendingTarget = null
      pendingUntil = 0
      waitingAutoRetry = false
      clearAllTimers()
      const expanded = getExpandedShortsPanel($('ytd-shorts'))
      const nativeClose = findNativePanelCloseButton(expanded)
      if (nativeClose) triggerInternalClick(nativeClose)
      sync()
    }, { signal })

    const onDocumentClick = (event) => {
      if (internalClick) return
      const target = eventTarget(event)
      if (!(target instanceof Node) || tabBar.contains?.(target)) return

      const nativeCloseHost = target.closest?.(
        '#anchored-panel #visibility-button, #anchored-panel .ytVideoTitleHeaderViewModelHeaderButton, #anchored-panel yt-floating-button-view-model'
      )
      if (nativeCloseHost || target.id === 'anchored-panel-scrim') {
        shortsPanelDismissed = true
        pendingTarget = null
        pendingUntil = 0
        waitingAutoRetry = false
        clearAllTimers()
        return
      }

      const shorts = $('ytd-shorts')
      const reel = getActiveShortsReel(shorts)
      const commentsBtn = findShortsCommentsButton(reel)
      if (commentsBtn && (target === commentsBtn || commentsBtn.contains?.(target))) {
        shortsPanelDismissed = false
        desiredTab = 'comments'
        pendingTarget = 'comments'
        pendingUntil = Date.now() + SHORTS_PENDING_GRACE_MS
        autoOpenExhausted = false
        waitingAutoRetry = false
        clearAllTimers()
        schedule()
        return
      }

      const dropdownItem = target.closest?.(
        'tp-yt-iron-dropdown yt-list-item-view-model, yt-list-view-model[role="menu"] yt-list-item-view-model'
      )
      if (dropdownItem) {
        const descItem = findDescriptionMenuItem()
        if (descItem && (dropdownItem === descItem || dropdownItem.contains?.(descItem))) {
          shortsPanelDismissed = false
          desiredTab = 'description'
          pendingTarget = 'description'
          pendingUntil = Date.now() + SHORTS_PENDING_GRACE_MS
          autoOpenExhausted = false
          waitingAutoRetry = false
          clearAutoOpenTimer()
          schedule()
        }
      }
    }

    const isSelfTabBarMutation = (mutation) => {
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-yt-shorts-tabs') {
        return true
      }
      if (mutation.type === 'childList') {
        const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]
        if (
          nodes.length > 0 &&
          nodes.every((node) => node === tabBar || node?.id === 'yt-shorts-panel-tabs' || node?.closest?.('#yt-shorts-panel-tabs'))
        ) {
          return true
        }
      }
      return false
    }

    const isRelevantShortsMutation = (mutations) => {
      if (!mutations?.length) return true
      for (const mutation of mutations) {
        if (isSelfTabBarMutation(mutation)) continue
        const target = mutation.target?.nodeType === 1
          ? mutation.target
          : mutation.target?.parentElement
        if (target?.closest?.('#yt-shorts-panel-tabs')) continue
        if (target?.closest?.('ytd-shorts')) return true
        for (const list of [mutation.addedNodes, mutation.removedNodes]) {
          for (const node of list || []) {
            if (node?.nodeType !== 1) continue
            if (node === tabBar || node.id === 'yt-shorts-panel-tabs' || node.closest?.('#yt-shorts-panel-tabs')) {
              continue
            }
            if (
              node.matches?.('ytd-shorts, ytd-reel-video-renderer, #anchored-panel') ||
              node.querySelector?.('ytd-shorts, ytd-reel-video-renderer, #anchored-panel')
            ) {
              return true
            }
          }
        }
      }
      return false
    }

    const observer = new MutationObserver((mutations) => {
      if (isRelevantShortsMutation(mutations)) schedule()
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'visibility',
        'target-id',
        'is-watch-while-mode',
        'small-screen-persistent-panel',
        'is-fullscreen',
        'is-active',
        'disabled',
        'aria-disabled',
      ],
    })

    const onScroll = () => {
      if (getShortKey() !== currentShortKey) schedule()
    }

    window.addEventListener('resize', schedule, { signal })
    window.addEventListener('popstate', schedule, { signal })
    document.addEventListener('fullscreenchange', schedule, { signal })
    document.addEventListener('yt-page-data-updated', schedule, { signal })
    document.addEventListener('click', onDocumentClick, { capture: true, signal })
    document.addEventListener('scroll', onScroll, { capture: true, passive: true, signal })

    signal.addEventListener('abort', () => {
      cancelAnimationFrame(frame)
      clearAllTimers()
      observer.disconnect()
      const shorts = $('ytd-shorts')
      const anchoredPanel = shorts?.querySelector('#anchored-panel') || tabBar.parentElement
      clearShortsTabsState(shorts, anchoredPanel)
      tabBar.remove()
    }, { once: true })

    schedule()

    return {
      onNavigate: sync,
    }
  }

  const startShortsVolumeControl = () => {
    const controller = new AbortController()
    const { signal } = controller
    const panelController = startShortsPanelController(signal)

    // Register before the Shorts player exists; it has no theater button or
    // regular progress bar, and may be replaced as the feed advances.
    document.addEventListener('wheel', handleShortsWheel, {
      capture: true,
      passive: false,
      signal,
    })
    const syncShortsAudio = (event, requireActive = false) => {
      if (!volumeGainEnabled) return
      const target = event.target
      if (!target || target.tagName?.toLowerCase?.() !== 'video') return
      const shorts = target.closest?.('ytd-shorts')
      const player = target.closest?.('.html5-video-player')
      if (!shorts || !player || typeof player.getVolume !== 'function') return
      if (requireActive) {
        const reel = target.closest?.('ytd-reel-video-renderer')
        const active = reel?.hasAttribute?.('is-active') ||
          (!shorts.querySelector?.('ytd-reel-video-renderer[is-active]') && target.paused === false)
        if (!active) return
      }
      moviePlayer = player
      videoPlayer = target
      ensureVolumeGain()
    }
    document.addEventListener('playing', (event) => syncShortsAudio(event, false), { capture: true, signal })
    document.addEventListener('volumechange', (event) => {
      if (event.target === videoPlayer) syncVolumeGain()
      else syncShortsAudio(event, true)
    }, { capture: true, signal })

    return {
      onNavigate: panelController.onNavigate,
      dispose: () => {
        controller.abort()
        if (floatingBarTimer) clearTimeout(floatingBarTimer)
        floatingBarTimer = 0
        if (floatingBar) floatingBar.style.display = 'none'
        moviePlayer = null
        videoPlayer = null
        floatingBar = null
      },
    }
  }

  const handleKeydown = (event) => {
    if (event.key === 'Escape' && tooltip?.dataset?.visible === 'true') {
      hideTooltip()
      return
    }
    if (
      event.key?.toLowerCase() === SCREENSHOT_KEY &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      !isEditableTarget(eventTarget(event))
    ) {
      event.preventDefault()
      screenShot()
    }
  }

  const collectPlayerElements = () => {
    moviePlayer = $('#movie_player')
    const pick = (selector, globalSelector = selector) => {
      const scoped = moviePlayer?.querySelector?.(selector)
      if (scoped) return scoped
      const candidate = $(globalSelector)
      const owner = candidate?.closest?.('.html5-video-player')
      return !owner || owner === moviePlayer ? candidate : null
    }
    container = pick('.html5-video-container')
    sizeBtn = pick('button.ytp-size-button')
    videoTitle = pick('a.ytp-title-link')
    progressBar = pick('.ytp-progress-bar')
    videoPlayer = pick('video', '#movie_player video')

    return Boolean(container && sizeBtn && moviePlayer && progressBar && videoPlayer)
  }

  const waitElements = () => {
    return new Promise((resolve) => {
      if (collectPlayerElements()) {
        resolve(true)
        return
      }

      const observer = new MutationObserver(() => {
        if (collectPlayerElements()) finish(true)
      })

      let settled = false
      let fallbackTimer = 0
      let pollTimer = 0
      const cancel = () => finish(false)
      const finish = (ready) => {
        if (settled) return
        settled = true
        clearTimeout(fallbackTimer)
        clearInterval(pollTimer)
        observer.disconnect()
        if (pendingWaitCancel === cancel) pendingWaitCancel = null
        resolve(ready)
      }

      observer.observe(document.documentElement, {
        attributes: false,
        childList: true,
        subtree: true,
      })
      pendingWaitCancel = cancel

      fallbackTimer = setTimeout(() => {
        observer.disconnect()
        pollTimer = setInterval(() => {
          if (collectPlayerElements()) finish(true)
        }, 1000)
      }, 10000)
    })
  }

  const main = async (token) => {
    const ready = await waitElements()
    if (!ready || token !== navigationToken) return null

    const controller = new AbortController()
    const { signal } = controller

    floatingBar = getFloatingBar()
    tooltip = getTooltip()
    tooltip.addEventListener('mouseenter', () => {
      clearTimeout(tooltipHideTimer)
      tooltipHideTimer = 0
    }, { signal })
    tooltip.addEventListener('mouseleave', scheduleHideTooltip, { signal })

    if (volumeGainEnabled || volumeAudioContext) ensureVolumeGain()

    const buttons = ensureButtons()
    bindButtonEvents(buttons, signal)

    // Pay worker startup before the first click (including keyboard captures).
    // The worker allocates its full-size canvas only when a screenshot is taken.
    const warmScreenshotWorker = () => {
      if (signal.aborted) return
      try {
        getScreenshotWorker()
      } catch (_) {}
    }
    if (typeof requestIdleCallback === 'function') {
      const warmupId = requestIdleCallback(warmScreenshotWorker, { timeout: 1000 })
      signal.addEventListener('abort', () => cancelIdleCallback(warmupId), { once: true })
    } else {
      const warmupId = setTimeout(warmScreenshotWorker, 250)
      signal.addEventListener('abort', () => clearTimeout(warmupId), { once: true })
    }

    // Document-level capture on purpose: wheel events can be stopped before
    // they ever reach #movie_player, so a player-scoped listener misses them.
    // Non-passive is required to preventDefault; the handler bails fast
    // unless the cursor is over the video area.
    document.addEventListener('wheel', handleWheelCapture, {
      capture: true,
      passive: false,
      signal,
    })

    document.addEventListener('keydown', handleKeydown, { signal })

    return () => {
      stopLiveCatchup('', true)
      controller.abort()
      hideTooltip()
    }
  }

  let cleanup = null
  let navigationToken = 0
  let pendingWaitCancel = null

  // yt-navigate-finish also fires on the initial page load, so runs can
  // overlap while main() awaits; the token makes the newest run win and
  // disposes stale ones instead of leaking their listeners.
  const handleNavigation = async () => {
    const token = ++navigationToken

    if (isShortsPage()) {
      if (activeShortsSession) {
        activeShortsSession.onNavigate()
        return
      }
      pendingWaitCancel?.()
      cleanup?.()
      cleanup = null
      const session = startShortsVolumeControl()
      activeShortsSession = session
      cleanup = () => {
        if (activeShortsSession === session) activeShortsSession = null
        session.dispose()
      }
      return
    }

    pendingWaitCancel?.()
    cleanup?.()
    cleanup = null
    shortsPanelDismissed = false

    if (!isWatchPage()) return

    const dispose = await main(token)

    if (token !== navigationToken) {
      dispose?.()
      return
    }

    cleanup = dispose
  }

  document.addEventListener('yt-navigate-finish', handleNavigation)

  if (isWatchPage() || isShortsPage()) {
    handleNavigation()
  }
})()
