// ==UserScript==
// @name        YouTube Default Max Quality
// @namespace   https://tampermonkey.net/
// @version     0.2.0
// @description Sets the highest available playback quality on YouTube watch and live pages.
// @author      Derek
// @homepageURL https://github.com/rtashklzx47277/Script
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeDefaultMaxQuality.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeDefaultMaxQuality.js
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

  const main = async (token) => {
    const moviePlayer = await waitForMoviePlayer()
    if (!moviePlayer || token !== navigationToken) return null

    // The first quality list can be incomplete (e.g. 4K often appears only
    // after playback starts), so poll until MAX_WAIT and re-apply whenever a
    // new top quality shows up, instead of stopping at the first success.
    let appliedQuality = null

    const applyMaxQuality = () => {
      if (
        typeof moviePlayer.getAvailableQualityLevels !== 'function' ||
        typeof moviePlayer.setPlaybackQualityRange !== 'function'
      ) {
        return
      }

      const qualityLevels = moviePlayer.getAvailableQualityLevels()

      if (!Array.isArray(qualityLevels) || qualityLevels.length === 0) return

      const maxQuality = qualityLevels[0]
      if (!maxQuality || maxQuality === appliedQuality) return

      moviePlayer.setPlaybackQualityRange(maxQuality)
      appliedQuality = maxQuality
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

    applyMaxQuality()

    interval = setInterval(applyMaxQuality, CHECK_INTERVAL)
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
