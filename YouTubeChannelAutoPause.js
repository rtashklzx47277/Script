// ==UserScript==
// @name        YouTube Channel Auto Pause
// @namespace   https://tampermonkey.net/
// @version     0.1.0
// @description Automatically pauses autoplaying videos on YouTube channel pages.
// @author      Derek
// @match       *://www.youtube.com/*
// @run-at      document-idle
// @grant       none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)

  const MAX_WAIT = 5000

  let cleanup = null

  const isChannelPage = () =>
    /^(\/@|\/channel\/|\/user\/|\/c\/)/.test(location.pathname)

  const waitForChannelVideo = () =>
    new Promise((resolve) => {
      const currentVideo = $('ytd-browse video')

      if (currentVideo) {
        resolve(currentVideo)
        return
      }

      const observer = new MutationObserver(() => {
        const video = $('ytd-browse video')

        if (!video) return

        observer.disconnect()
        clearTimeout(timeout)
        resolve(video)
      })

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      })

      const timeout = setTimeout(() => {
        observer.disconnect()
        resolve(null)
      }, MAX_WAIT)
    })

  const main = async () => {
    const video = await waitForChannelVideo()
    if (!video) return null

    if (!video.paused) {
      video.pause()
      return null
    }

    let timeout = 0

    const handlePlay = () => {
      video.pause()
      stop()
    }

    const stop = () => {
      video.removeEventListener('play', handlePlay)

      if (timeout) {
        clearTimeout(timeout)
        timeout = 0
      }
    }

    video.addEventListener('play', handlePlay)
    timeout = setTimeout(stop, MAX_WAIT)

    return stop
  }

  const run = async () => {
    cleanup?.()
    cleanup = null

    if (isChannelPage()) {
      cleanup = await main()
    }
  }

  document.addEventListener('yt-navigate-finish', run)

  if (isChannelPage()) {
    run()
  }
})()
