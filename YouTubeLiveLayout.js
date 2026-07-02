// ==UserScript==
// @name        YouTube Live Layout
// @namespace   https://tampermonkey.net/
// @version     0.2.0
// @description Keeps normal videos untouched, expands theater mode without chat, and uses a 75/25 theater layout for videos with chat.
// @author      Derek
// @match       *://www.youtube.com/*
// @grant       none
// @run-at      document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const PRIMARY_RATIO = 0.75
  const SECONDARY_RATIO = 1 - PRIMARY_RATIO
  const PRIMARY_WIDTH = `${PRIMARY_RATIO * 100}vw`
  const SECONDARY_WIDTH = `${SECONDARY_RATIO * 100}vw`
  const FALLBACK_ASPECT_RATIO = 16 / 9
  const AUTO_THEATER_WINDOW = 5000

  const $ = (selector) => document.querySelector(selector)

  let watchFlexy
  let chat
  let moviePlayer
  let video
  let sizeButton

  let cleanup = null
  let navigationToken = 0
  let autoTheaterAttempted = false
  let autoTheaterWindowOpen = false
  let autoTheaterTimer = 0
  let currentLayout = ''
  let lastChatTheaterPlayerHeight = ''
  let layoutSyncFrame = 0

  const scrollbarWidth = (() => {
    const dummy = document.createElement('div')
    dummy.style.overflowY = 'scroll'
    dummy.style.width = '100px'
    dummy.style.height = '100px'
    dummy.style.position = 'absolute'
    dummy.style.top = '-9999px'

    document.documentElement.appendChild(dummy)

    const width = dummy.offsetWidth - dummy.clientWidth
    dummy.remove()

    return width
  })()

  const theaterFillCSS = `
    html,
    body {
      overflow-x: clip !important;
    }

    #masthead-container {
      display: none !important;
    }

    ytd-page-manager,
    #content > #page-manager {
      margin: 0 !important;
    }

    #full-bleed-container,
    #player-full-bleed-container {
      width: 100% !important;
      min-width: 100% !important;
      max-width: 100% !important;
      min-height: 100vh !important;
    }
  `

  const chatTheaterCSS = `
    html,
    body {
      overflow-x: clip !important;
    }

    #masthead-container {
      display: none !important;
    }

    ytd-page-manager,
    #content > #page-manager {
      margin: 0 !important;
    }

    #full-bleed-container,
    #player-full-bleed-container,
    #movie_player {
      width: ${PRIMARY_WIDTH} !important;
      min-width: ${PRIMARY_WIDTH} !important;
      max-width: ${PRIMARY_WIDTH} !important;
      height: var(--yt-live-layout-player-height) !important;
      min-height: var(--yt-live-layout-player-height) !important;
      max-height: var(--yt-live-layout-player-height) !important;
    }

    #chat {
      position: fixed !important;
      top: 0 !important;
      right: auto !important;
      bottom: auto !important;
      left: ${PRIMARY_WIDTH} !important;
      width: calc(${SECONDARY_WIDTH} - ${scrollbarWidth}px) !important;
      min-width: calc(${SECONDARY_WIDTH} - ${scrollbarWidth}px) !important;
      max-width: calc(${SECONDARY_WIDTH} - ${scrollbarWidth}px) !important;
      height: 100vh !important;
      min-height: 100vh !important;
    }

    iframe#chatframe {
      width: 100% !important;
      min-width: 100% !important;
      height: 100% !important;
      min-height: 100% !important;
    }

    #columns {
      width: ${PRIMARY_WIDTH} !important;
      min-width: ${PRIMARY_WIDTH} !important;
      max-width: ${PRIMARY_WIDTH} !important;
      margin: 0 !important;
      padding-right: 0 !important;
      box-sizing: border-box !important;
      overflow-x: clip !important;
    }

    #columns > #primary {
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow-x: clip !important;
    }

    #primary #below {
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
      padding: 0 24px !important;
      overflow-x: clip !important;
    }

    #primary #below #above-the-fold #top-row {
      min-width: 0 !important;
    }

    #primary #below #above-the-fold #top-row > #owner {
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      flex: 1 1 auto !important;
    }

    #primary #below #above-the-fold #top-row > #actions {
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      flex: 0 0 auto !important;
    }

    .ytp-chrome-bottom,
    .ytp-progress-bar-container {
      min-width: calc(${PRIMARY_WIDTH} - 24px) !important;
    }
  `

  const fullscreenCSS = `
    #masthead-container,
    #chat-container,
    #chat,
    iframe#chatframe,
    #panels,
    #panels-full-bleed-container {
      display: none !important;
    }

    ytd-page-manager,
    #content,
    #page-manager,
    #full-bleed-container,
    #player-full-bleed-container,
    #movie_player,
    .html5-video-player,
    .html5-video-container {
      width: 100vw !important;
      min-width: 100vw !important;
      max-width: 100vw !important;
      height: 100vh !important;
      min-height: 100vh !important;
      max-height: 100vh !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    #movie_player video {
      width: 100% !important;
      height: 100% !important;
    }
  `

  const isWatchPage = () =>
    location.pathname === '/watch' || location.pathname.startsWith('/live/')

  const hasVisibleChat = () =>
    Boolean(chat && chat.isConnected && !chat.hasAttribute('collapsed'))

  const isFullscreen = () =>
    Boolean(
      document.fullscreenElement ||
      moviePlayer?.classList.contains('ytp-fullscreen')
    )

  const getVideoAspectRatio = () => {
    if (video?.videoWidth && video?.videoHeight) {
      return video.videoWidth / video.videoHeight
    }

    return FALLBACK_ASPECT_RATIO
  }

  const updateChatTheaterMetrics = () => {
    const width = window.innerWidth * PRIMARY_RATIO
    const height = Math.min(
      window.innerHeight,
      width / getVideoAspectRatio()
    )

    const nextHeight = `${height}px`

    if (nextHeight === lastChatTheaterPlayerHeight) {
      return false
    }

    lastChatTheaterPlayerHeight = nextHeight

    document.documentElement.style.setProperty(
      '--yt-live-layout-player-height',
      nextHeight
    )

    return true
  }

  const clearChatTheaterMetrics = () => {
    lastChatTheaterPlayerHeight = ''

    document.documentElement.style.removeProperty(
      '--yt-live-layout-player-height'
    )
  }

  const collectElements = () => {
    watchFlexy = $('ytd-watch-flexy')
    chat = $('#chat')
    moviePlayer = $('#movie_player')
    video = $('#movie_player video')
    sizeButton = $('.ytp-size-button')

    return Boolean(watchFlexy && moviePlayer && video)
  }

  const waitElements = () =>
    new Promise((resolve) => {
      if (collectElements()) {
        resolve(true)
        return
      }

      const observer = new MutationObserver(() => {
        if (collectElements()) {
          observer.disconnect()
          resolve(true)
        }
      })

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      })

      setTimeout(() => {
        observer.disconnect()
        resolve(collectElements())
      }, 5000)
    })

  const setStyle = (id, css) => {
    let styleElement = $(`#${id}`)

    if (!styleElement) {
      styleElement = document.createElement('style')
      styleElement.id = id
      document.head.appendChild(styleElement)
    }

    styleElement.textContent = css
  }

  const removeStyle = (id) => {
    $(`#${id}`)?.remove()
  }

  const dispatchResize = () => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }

  const beginAutoTheaterWindow = () => {
    autoTheaterAttempted = false
    autoTheaterWindowOpen = true

    if (autoTheaterTimer) clearTimeout(autoTheaterTimer)

    autoTheaterTimer = setTimeout(() => {
      autoTheaterWindowOpen = false
    }, AUTO_THEATER_WINDOW)
  }

  const maybeAutoSwitchToTheater = () => {
    if (
      !autoTheaterWindowOpen ||
      autoTheaterAttempted ||
      !hasVisibleChat() ||
      watchFlexy.theater ||
      !sizeButton
    ) {
      return
    }

    autoTheaterAttempted = true
    autoTheaterWindowOpen = false

    requestAnimationFrame(() => {
      sizeButton.click()
    })
  }

  const applyLayout = (layout) => {
    if (currentLayout === layout) return

    currentLayout = layout

    removeStyle('yt-theater-fill')
    removeStyle('yt-chat-theater')
    removeStyle('yt-video-only-fullscreen')

    if (layout === 'theater-fill') {
      setStyle('yt-theater-fill', theaterFillCSS)
    }

    if (layout === 'chat-theater') {
      setStyle('yt-chat-theater', chatTheaterCSS)
      window.scrollTo({ left: 0, top: window.scrollY })
    }

    if (layout === 'fullscreen') {
      setStyle('yt-video-only-fullscreen', fullscreenCSS)
    }

    dispatchResize()
  }

  const syncLayout = () => {
    collectElements()
    maybeAutoSwitchToTheater()

    if (isFullscreen()) {
      clearChatTheaterMetrics()
      applyLayout('fullscreen')
      return
    }

    if (hasVisibleChat() && watchFlexy.theater) {
      const metricsChanged = updateChatTheaterMetrics()
      applyLayout('chat-theater')

      if (metricsChanged && currentLayout === 'chat-theater') {
        dispatchResize()
      }

      return
    }

    clearChatTheaterMetrics()

    if (!hasVisibleChat() && watchFlexy.theater) {
      applyLayout('theater-fill')
      return
    }

    applyLayout('default')
  }

  const queueLayoutSync = () => {
    if (layoutSyncFrame) return

    layoutSyncFrame = requestAnimationFrame(() => {
      layoutSyncFrame = 0
      syncLayout()
    })
  }

  const monitorLayout = () => {
    const observer = new MutationObserver(queueLayoutSync)

    // ponytail: drop the childList firehose (fired on every comment/related-video
    // DOM change). Layout only reacts to the theater/collapsed attributes; subtree
    // stays so `collapsed` on the deep #chat element is still covered.
    observer.observe(watchFlexy, {
      attributes: true,
      subtree: true,
      attributeFilter: ['theater', 'collapsed']
    })

    const onResize = queueLayoutSync

    const onLoadedMetadata = queueLayoutSync

    document.addEventListener('fullscreenchange', queueLayoutSync)
    window.addEventListener('resize', onResize)
    video.addEventListener('loadedmetadata', onLoadedMetadata)

    return () => {
      observer.disconnect()
      document.removeEventListener('fullscreenchange', queueLayoutSync)
      window.removeEventListener('resize', onResize)
      video.removeEventListener('loadedmetadata', onLoadedMetadata)

      if (layoutSyncFrame) {
        cancelAnimationFrame(layoutSyncFrame)
        layoutSyncFrame = 0
      }
    }
  }

  const main = async (token) => {
    const ready = await waitElements()

    // Stale run (user already navigated again, possibly off the watch page):
    // bail before styling anything — watch-page elements linger in the DOM on
    // other pages, so waitElements alone can succeed there.
    if (!ready || token !== navigationToken) return null

    beginAutoTheaterWindow()
    syncLayout()

    const stopMonitoring = monitorLayout()

    return () => {
      stopMonitoring()
      currentLayout = ''

      if (autoTheaterTimer) {
        clearTimeout(autoTheaterTimer)
        autoTheaterTimer = 0
      }

      autoTheaterAttempted = false
      autoTheaterWindowOpen = false

      clearChatTheaterMetrics()

      removeStyle('yt-theater-fill')
      removeStyle('yt-chat-theater')
      removeStyle('yt-video-only-fullscreen')
    }
  }

  // yt-navigate-finish also fires on the initial page load, so runs can
  // overlap while main() awaits; the token makes the newest run win and
  // disposes stale ones instead of losing their cleanup.
  const run = async () => {
    const token = ++navigationToken

    cleanup?.()
    cleanup = null

    if (!isWatchPage()) return

    const dispose = await main(token)

    if (token !== navigationToken) {
      dispose?.()
      return
    }

    cleanup = dispose
  }

  run()

  document.addEventListener('yt-navigate-finish', () => {
    run()
  })
})()
