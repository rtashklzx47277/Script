// ==UserScript==
// @name               Auto Change Youtube Video Resolution to Max
// @name:zh-TW         Auto Change Youtube Video Resolution to Max
// @namespace          https://greasyfork.org/scripts/453854
// @version            1.2.0
// @description        auto change the video resolution to Max
// @description:zh-TW  自動將影片畫質切換至最高畫質
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
      if (moviePlayer) {
        const maxRes = moviePlayer.getAvailableQualityLevels()[0]
        moviePlayer.setPlaybackQualityRange(maxRes)
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
