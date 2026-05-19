// ==UserScript==
// @name        YouTube Auto Disable Subtitles
// @namespace   https://tampermonkey.net/
// @version     0.1.0
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

  const isWatchPage = () =>
    location.pathname === '/watch' ||
    location.pathname.startsWith('/live/')

  const waitForMoviePlayer = () =>
    new Promise((resolve) => {
      const currentPlayer = $('#movie_player')

      if (currentPlayer) {
        resolve(currentPlayer)
        return
      }

      const observer = new MutationObserver(() => {
        const moviePlayer = $('#movie_player')

        if (!moviePlayer) return

        observer.disconnect()
        clearTimeout(timeout)
        resolve(moviePlayer)
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

  const main = async () => {
    const moviePlayer = await waitForMoviePlayer()
    if (!moviePlayer) return null

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

  const run = async () => {
    cleanup?.()
    cleanup = null

    if (isWatchPage()) {
      cleanup = await main()
    }
  }

  document.addEventListener('yt-navigate-finish', run)

  if (isWatchPage()) {
    run()
  }
})()
