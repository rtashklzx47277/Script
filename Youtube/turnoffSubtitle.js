// ==UserScript==
// @name               Auto Turnoff Youtube Video Subtitle
// @name:zh-TW         Auto Turnoff Youtube Video Subtitle
// @namespace          https://greasyfork.org/
// @version            1.0.0
// @description        auto turnoff video subtitle
// @description:zh-TW  自動關閉字幕
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// @noframes
// ==/UserScript==

const $ = (element) => document.querySelector(element)

const main = () => {
  if (window.location.href.includes('/watch?v=')) {
    const observer = new MutationObserver(() => {
      const moviePlayer = $('#movie_player')
      const captionContainer = $('.ytp-caption-window-container')
      if (moviePlayer && captionContainer && captionContainer.childNodes.length !== 0) {
        moviePlayer.toggleSubtitles()
        observer.disconnect()
      }
    })
    observer.observe(document.body, { attributes: false, childList: true, subtree: true })
  }
}

document.addEventListener('yt-navigate-finish', main)
