// ==UserScript==
// @name               Auto Pause Youtube Channel Homepage Video
// @name:zh-TW         Auto Pause Youtube Channel Homepage Video
// @namespace          https://greasyfork.org/scripts/453851
// @version            1.2.0
// @description        auto pause the channel homepage video
// @description:zh-TW  自動暫停Youtube頻道首頁的影片
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
      const moviePlayer = $('ytd-browse video')
      if (moviePlayer && !moviePlayer.paused) {
        moviePlayer.pause()
        observer.disconnect()
      }
    })
    observer.observe($('#page-manager'), { childList: true, subtree: true })
    setTimeout(() => observer.disconnect(), 5000)
  }

  document.addEventListener('yt-navigate-finish', () => {
    if (/^(\/@|\/channel\/|\/user\/|\/c\/)/.test(window.location.pathname)) main()
  })
})()
