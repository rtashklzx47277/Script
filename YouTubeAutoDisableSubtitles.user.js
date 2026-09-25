// ==UserScript==
// @name        YouTube Auto Disable Subtitles
// @namespace   https://tampermonkey.net/
// @version     0.2.2
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeAutoDisableSubtitles.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeAutoDisableSubtitles.user.js
// @description Automatically turns off subtitles on YouTube watch and live pages.
// @author      Derek
// @match       *://www.youtube.com/*
// @run-at      document-idle
// @grant       none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)

  const CHECK_INTERVAL = 250
  const MAX_WAIT = 5000

  let cleanup = null
  let navigationToken = 0
  let pendingWaitCancel = null

  const isWatchPage = () =>
    location.pathname === '/watch' ||
    location.pathname.startsWith('/live/')

  const findReadyPlayer = () => {
    const player = $('#movie_player')
    return (
      typeof player?.isSubtitlesOn === 'function' &&
      typeof player?.toggleSubtitles === 'function'
    ) ? player : null
  }

  const waitForMoviePlayer = () =>
    new Promise((resolve) => {
      const currentPlayer = findReadyPlayer()

      if (currentPlayer) {
        resolve(currentPlayer)
        return
      }

      const observer = new MutationObserver(() => {
        const moviePlayer = findReadyPlayer()

        if (!moviePlayer) return

        finish(moviePlayer)
      })

      let fallbackTimer = 0
      let pollTimer = 0
      let settled = false
      const cancel = () => finish(null)
      const finish = (moviePlayer) => {
        if (settled) return
        settled = true
        clearTimeout(fallbackTimer)
        clearInterval(pollTimer)
        observer.disconnect()
        if (pendingWaitCancel === cancel) pendingWaitCancel = null
        resolve(moviePlayer)
      }

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      })

      pendingWaitCancel = cancel
      // Player methods can become ready without a DOM mutation.
      const checkPlayer = () => {
        const moviePlayer = findReadyPlayer()
        if (moviePlayer) finish(moviePlayer)
      }
      pollTimer = setInterval(checkPlayer, CHECK_INTERVAL)
      fallbackTimer = setTimeout(() => {
        observer.disconnect()
        clearInterval(pollTimer)
        pollTimer = setInterval(checkPlayer, 1000)
      }, 10000)
    })

  const disableSubtitlesIfNeeded = (moviePlayer) => {
    if (
      typeof moviePlayer.isSubtitlesOn !== 'function' ||
      typeof moviePlayer.toggleSubtitles !== 'function'
    ) {
      return false
    }

    if (!moviePlayer.isSubtitlesOn()) {
      return false
    }

    moviePlayer.toggleSubtitles()
    return true
  }

  const main = async (token) => {
    const moviePlayer = await waitForMoviePlayer()
    if (!moviePlayer || token !== navigationToken) return null

    if (disableSubtitlesIfNeeded(moviePlayer)) {
      return null
    }

    let interval = 0
    let timeout = 0

    const stop = () => {
      if (interval) {
        clearInterval(interval)
        interval = 0
      }

      if (timeout) {
        clearTimeout(timeout)
        timeout = 0
      }
    }

    interval = setInterval(() => {
      if (disableSubtitlesIfNeeded(moviePlayer)) {
        stop()
      }
    }, CHECK_INTERVAL)

    timeout = setTimeout(stop, MAX_WAIT)

    return stop
  }

  // yt-navigate-finish also fires on the initial page load, so runs can
  // overlap while main() awaits; the token makes the newest run win and
  // disposes stale ones instead of losing their cleanup.
  const run = async () => {
    const token = ++navigationToken

    pendingWaitCancel?.()
    cleanup?.()
    cleanup = null

    if (!isWatchPage()) return

    const stop = await main(token)

    if (token !== navigationToken) {
      stop?.()
      return
    }

    cleanup = stop
  }

  document.addEventListener('yt-navigate-finish', run)

  if (isWatchPage()) {
    run()
  }
})()
