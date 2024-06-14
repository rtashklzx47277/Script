// ==UserScript==
// @name               Youtube Twitch Like Mode
// @version            0.1.0
// @description        make Youtube Twitch liked
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// @noframes
// ==/UserScript==

const $ = (element) => document.querySelector(element)

let watchFlexy = null
let container = null
let video = null
let chat = null

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

  #content > #page-manager {
    margin: 0 !important;
  }

  #columns > #primary {
    min-width: 75vw !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  #primary #player,
  #player-container-outer {
    min-width: 75vw !important;
    max-height: 100vh !important;
  }

  .html5-video-container,
  #movie_player video {
    height: 100% !important;
  }

  .ytp-chrome-bottom,
  .ytp-progress-bar-container {
    min-width: calc(75vw - 24px) !important;
  }

  #primary #below {
    padding: 0 24px 0 !important;
  }

  #columns > #secondary,
  #secondary #chat {
    min-width: calc(25vw - ${getScrollbarWidth()}px) !important;
    min-height: 100vh !important;
    padding: 0 !important;
  }
`

const waitElements = () => {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      watchFlexy = $('ytd-watch-flexy')
      container = $('.html5-video-container')
      video = $('#movie_player video')
      chat = $('#chat')

      if (watchFlexy && container && video && chat) {
        observer.disconnect()
        resolve()
      }
    })

    observer.observe(document.body, { attributes: false, childList: true, subtree: true })

    setTimeout(() => {
      observer.disconnect()
      resolve()
    }, 5000)
  })
}

const main = async () => {
  await waitElements()

  if (!chat || !chat.isConnected || chat.hasAttribute('collapsed')) return

  let twitchStyle = document.createElement('style')
  twitchStyle.setAttribute('type', 'text/css')
  twitchStyle.setAttribute('id', 'twitch-mode')
  twitchStyle.textContent = css
  document.head.appendChild(twitchStyle)

  setTimeout(() => window.dispatchEvent(new Event('resize')), 1000)

  if (watchFlexy.calculateNormalPlayerSize_original) return

  watchFlexy.calculateNormalPlayerSize_original = watchFlexy.calculateNormalPlayerSize_
  watchFlexy.calculateCurrentPlayerSize_original = watchFlexy.calculateCurrentPlayerSize_
  watchFlexy.calculateNormalPlayerSize_ = watchFlexy.calculateCurrentPlayerSize_ = () => {
    if (!chat) return watchFlexy.calculateCurrentPlayerSize_original()
    else if (watchFlexy.theater) return { width: NaN, height: NaN }
    else return { width: window.innerWidth * 0.75, height: video.offsetHeight }
  }
}

document.addEventListener('yt-navigate-finish', (event) => {
  const url = event.detail.endpoint.commandMetadata.webCommandMetadata.url
  if (url.startsWith('/watch?v=') || url.startsWith('/live/')) main()
  else if ($('#twitch-mode')) $('#twitch-mode').remove()
})
