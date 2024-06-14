// ==UserScript==
// @name               Youtube Theater Fill Up Window
// @name:zh-TW         Youtube Theater Fill Up Window
// @namespace          https://greasyfork.org/scripts/454092
// @version            1.1.2
// @description        make theater mode fill up window
// @description:zh-TW  讓劇院模式填滿視窗
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// @noframes
// ==/UserScript==

const autoTheater = 0 //change the value into 「1」 to make Theater mode default!

const $ = (element) => document.querySelector(element)

const getScrollbarWidth = () => {
  let dummy = document.createElement('div')
  document.body.appendChild(dummy)
  dummy.style.overflowY = 'scroll'
  const clientWidth = dummy.clientWidth
  const offsetWidth = dummy.offsetWidth
  dummy.remove()
  return offsetWidth - clientWidth + 1
}

const css = `
  #masthead-container {
    display: none !important;
  }
  ytd-page-manager {
    margin: 0 !important;
  }
  #full-bleed-container {
    min-height: 100vh !important;
    min-width: calc(100vw - ${getScrollbarWidth()}px) !important;
  }
`

let theaterStyle = document.createElement('style')
theaterStyle.setAttribute('type', 'text/css')
theaterStyle.setAttribute('id', 'theater-mode')
theaterStyle.textContent = css

const theaterMode = () => {
  if ($('#player-full-bleed-container > #player-container') && !$('#theater-mode')) document.head.appendChild(theaterStyle)
  else if (!$('#player-full-bleed-container > #player-container') && $('#theater-mode')) $('#theater-mode').remove()
}

const main = () => {
  if (autoTheater === 1 && !$('ytd-watch-flexy').isTheater_()) setTimeout(() => { $('.ytp-size-button').click() }, 500)

  if ($('ytd-watch-flexy').isTheater_()) theaterMode()

  const observer = new MutationObserver(theaterMode)
  observer.observe($('#player-full-bleed-container'), { attributes: false, childList: true })
}

document.addEventListener('yt-navigate-finish', (event) => {
  if (event.detail.endpoint.commandMetadata.webCommandMetadata.url.startsWith('/watch?v=')) main()
  else if ($('#theater-mode')) $('#theater-mode').remove()
})
