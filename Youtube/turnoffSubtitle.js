// ==UserScript==
// @name               Auto Turnoff Youtube Video Subtitle
// @namespace          https://greasyfork.org/
// @version            0.1.0
// @description        auto turnoff video subtitle
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)

  const main = () => {
    const observer = new MutationObserver(() => {
      const moviePlayer = $('#movie_player')
      if (moviePlayer && moviePlayer.isSubtitlesOn()) {
        moviePlayer.toggleSubtitles()
        observer.disconnect()
      }
    })
    observer.observe($('#page-manager'), { childList: true, subtree: true })
    setTimeout(() => observer.disconnect(), 5000)
  }

  document.addEventListener('yt-navigate-finish', () => {
    const url = window.location.href
    if (url.includes('/watch?v=') || url.includes('/live/')) main()
  })
})()
