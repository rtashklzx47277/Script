// ==UserScript==
// @name        YouTube Channel Auto Pause
// @namespace   https://tampermonkey.net/
// @version     0.2.0
// @description Automatically pauses autoplaying videos on YouTube channel pages.
// @author      Derek
// @homepageURL https://github.com/rtashklzx47277/Script
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeChannelAutoPause.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeChannelAutoPause.js
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
  let navigationToken = 0

  // Modern channel URL prefixes only; legacy top-level vanity URLs
  // (youtube.com/name) redirect to /@handle, so they're intentionally
  // not matched here.
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

  const main = async (token) => {
    const video = await waitForChannelVideo()
    if (!video || token !== navigationToken) return null

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

    // ponytail: the 5s window is what separates autoplay from the user's own
    // play clicks; a trailer that starts later than that is deliberately left
    // alone rather than fighting the user.
    video.addEventListener('play', handlePlay)
    timeout = setTimeout(stop, MAX_WAIT)

    return stop
  }

  // yt-navigate-finish also fires on the initial page load, so runs can
  // overlap while main() awaits; the token makes the newest run win and
  // disposes stale ones instead of losing their cleanup.
  const run = async () => {
    const token = ++navigationToken

    cleanup?.()
    cleanup = null

    if (!isChannelPage()) return

    const stop = await main(token)

    if (token !== navigationToken) {
      stop?.()
      return
    }

    cleanup = stop
  }

  document.addEventListener('yt-navigate-finish', run)

  if (isChannelPage()) {
    run()
  }
})()
