// ==UserScript==
// @name               Youtube Twitch Like Mode
// @version            0.1.0
// @description        make Youtube Twitch liked
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)
  let chat, video, container, watchFlexy
  const scrollbarWidth = (() => {
    let dummy = document.createElement('div')
    document.body.appendChild(dummy)
    dummy.style.overflowY = 'scroll'
    const width = dummy.offsetWidth - dummy.clientWidth + 1
    dummy.remove()
    return width
  })()
  const css = `
    #masthead-container {
      display: none !important;
    }
  
    #content > #page-manager {
      margin: 0 !important;
    }
  
    #columns > #primary {
      min-width: 75vw !important;
      margin: 0 !important;
      padding: 0 !important;
    }
  
    #primary #player,
    #player-container-outer {
      min-width: 75vw !important;
      max-height: 100vh !important;
    }
  
    .html5-video-container,
    #movie_player video {
      height: 100% !important;
    }
  
    .ytp-chrome-bottom,
    .ytp-progress-bar-container {
      min-width: calc(75vw - 24px) !important;
    }
  
    #primary #below {
      padding: 0 24px 0 !important;
    }
  
    #columns > #secondary,
    #secondary #chat {
      min-width: calc(25vw - ${scrollbarWidth}px) !important;
      min-height: 100vh !important;
      padding: 0 !important;
    }
  `

  const waitElements = () => {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        watchFlexy = $('ytd-watch-flexy')
        container = $('.html5-video-container')
        video = $('#movie_player video')
        chat = $('#chat')

        if (watchFlexy && container && video && chat) {
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

  const injectCSS = () => {
    let styleElement = $('#twitch-mode')
    if (!styleElement) {
      styleElement = document.createElement('style')
      styleElement.id = 'twitch-mode'
      styleElement.textContent = css
      document.head.appendChild(styleElement)
    }
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

    if (watchFlexy.calculateNormalPlayerSize_original) return

    watchFlexy.calculateNormalPlayerSize_original = watchFlexy.calculateNormalPlayerSize_
    watchFlexy.calculateCurrentPlayerSize_original = watchFlexy.calculateCurrentPlayerSize_
    watchFlexy.calculateNormalPlayerSize_ = watchFlexy.calculateCurrentPlayerSize_ = () => {
      if (!chat || !chat.isConnected || chat.hasAttribute('collapsed')) return watchFlexy.calculateCurrentPlayerSize_original()
      else if (watchFlexy.theater) return { width: NaN, height: NaN }
      else return { width: window.innerWidth * 0.75, height: video.offsetHeight }
    }
  }

  const removeCSS = () => {
    const styleElement = $('#twitch-mode')
    if (styleElement) styleElement.remove()
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

    if (watchFlexy.calculateNormalPlayerSize_original) {
      watchFlexy.calculateNormalPlayerSize_ = watchFlexy.calculateNormalPlayerSize_original
      watchFlexy.calculateCurrentPlayerSize_ = watchFlexy.calculateCurrentPlayerSize_original
      delete watchFlexy.calculateNormalPlayerSize_original
      delete watchFlexy.calculateCurrentPlayerSize_original
    }
  }

  const monitorChat = () => {
    const observer = new MutationObserver(() => {
      chat = $('#chat')
      if (chat && chat.isConnected && !chat.hasAttribute('collapsed')) injectCSS()
      else removeCSS()
    })
    observer.observe(chat, { attributes: true })
    return observer
  }

  const main = async () => {
    await waitElements()
    if (!watchFlexy || !container || !video || !chat) return
    if (chat && chat.isConnected && !chat.hasAttribute('collapsed')) injectCSS()
    else removeCSS()

    const chatObserver = monitorChat()
    return () => {
      chatObserver.disconnect()
      removeCSS()
    }
  }

  let cleanup
  document.addEventListener('yt-navigate-finish', async (event) => {
    if (cleanup) cleanup()
    const url = event.detail.endpoint.commandMetadata.webCommandMetadata.url
    if (url.startsWith('/watch?v=') || url.startsWith('/live/')) cleanup = await main()
    else cleanup = null
  })
})()
