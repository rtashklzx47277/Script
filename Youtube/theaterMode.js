// ==UserScript==
// @name               Youtube Theater Fill Up Window
// @name:zh-TW         Youtube Theater Fill Up Window
// @namespace          https://greasyfork.org/scripts/454092
// @version            1.2.0
// @description        make theater mode fill up window
// @description:zh-TW  讓劇院模式填滿視窗
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const autoTheater = 0 //change the value into 「1」 to make Theater mode default!

  const $ = (element) => document.querySelector(element)
  let container, watchFlexy
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
    ytd-page-manager {
      margin: 0 !important;
    }
    #full-bleed-container {
      min-height: 100vh !important;
      min-width: calc(100vw - ${scrollbarWidth}px) !important;
    }
  `

  const waitElements = () => {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        watchFlexy = $('ytd-watch-flexy')
        container = $('#player-full-bleed-container')

        if (watchFlexy && container) {
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
    let styleElement = $('#theater-mode')
    if (!styleElement) {
      styleElement = document.createElement('style')
      styleElement.id = 'theater-mode'
      styleElement.textContent = css
      document.head.appendChild(styleElement)
    }
  }

  const removeCSS = () => {
    const styleElement = $('#theater-mode')
    if (styleElement) styleElement.remove()
  }

  const monitorTheater = () => {
    const observer = new MutationObserver(() => {
      if (watchFlexy.theater) injectCSS()
      else removeCSS()
    })
    observer.observe(container, { childList: true })
    return observer
  }

  const main = async () => {
    await waitElements()
    if (autoTheater === 1 && !watchFlexy.theater) setTimeout(() => { $('.ytp-size-button').click() }, 500)
    if (watchFlexy.theater) injectCSS()
    else removeCSS()

    const chatObserver = monitorTheater()
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
