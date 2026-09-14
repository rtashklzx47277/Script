// ==UserScript==
// @name        YouTube Live Clock
// @namespace   https://tampermonkey.net/
// @version     0.2.1
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveClock.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveClock.user.js
// @description Shows elapsed time on live streams and absolute clock time on live archives.
// @author      Derek
// @match       *://www.youtube.com/*
// @grant       none
// @run-at      document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  // You can choose your ideal date format by changing FORMAT below.
  const FORMAT = 1
  /*
    1: 2022/10/31 06:37:10 (default)
    2: 10/31/2022 06:37:10
    3: 31/10/2022 06:37:10
    4: Mon 31/10/2022 06:37:10
    5: Monday 31/10/2022 06:37:10
    6: Monday 31 October 2022 06:37:10
  */

  const $ = (element) => document.querySelector(element)
  const addStyle = (css) => {
    const styleElement = document.createElement('style')
    styleElement.textContent = css
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  const WEEK_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const WEEK_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const MONTH_FULL = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]

  let currentVideoId = null
  let timeContent
  let timeWrapper
  let progressBar
  let progressObserver = null
  let navigationToken = 0

  addStyle(`
    .ytp-chrome-bottom .ytp-time-display,
    .ytp-chrome-bottom .ytp-right-controls {
      display: flex !important;
    }

    #yt-live-clock-absolute,
    #yt-live-clock-elapsed {
      margin-left: 1em !important;
      font-weight: normal !important;
      white-space: nowrap !important;
    }
  `)

  const twoDigit = (num) =>
    String(num).padStart(2, '0')

  const timeFormat = (time) => {
    const totalSeconds = Math.floor(Number(time) || 0)
    const second = totalSeconds % 60
    const minute = Math.floor((totalSeconds / 60) % 60)
    const hour = Math.floor(totalSeconds / 3600)

    return hour > 0
      ? `${hour}:${twoDigit(minute)}:${twoDigit(second)}`
      : `${minute}:${twoDigit(second)}`
  }

  const dateFormat = (date) => {
    const year = date.getFullYear()
    const month = twoDigit(date.getMonth() + 1)
    const day = twoDigit(date.getDate())
    const weekShort = WEEK_SHORT[date.getDay()]
    const weekFull = WEEK_FULL[date.getDay()]
    const monthFull = MONTH_FULL[date.getMonth()]
    const time = `${twoDigit(date.getHours())}:${twoDigit(date.getMinutes())}:${twoDigit(date.getSeconds())}`

    return {
      1: `(${year}/${month}/${day} ${time})`,
      2: `(${month}/${day}/${year} ${time})`,
      3: `(${day}/${month}/${year} ${time})`,
      4: `(${weekShort} ${day}/${month}/${year} ${time})`,
      5: `(${weekFull} ${day}/${month}/${year} ${time})`,
      6: `(${weekFull} ${day} ${monthFull} ${year} ${time})`,
    }[FORMAT] ?? `(${year}/${month}/${day} ${time})`
  }

  const removeClocks = () => {
    $('#yt-live-clock-absolute')?.remove()
    $('#yt-live-clock-elapsed')?.remove()
  }

  const cleanup = () => {
    progressObserver?.disconnect()
    progressObserver = null
    removeClocks()
  }

  const getVideoIdFromUrl = (rawUrl) => {
    const url = new URL(rawUrl, location.origin)

    if (url.pathname === '/watch') {
      return url.searchParams.get('v')
    }

    if (url.pathname.startsWith('/live/')) {
      return url.pathname.split('/')[2] || null
    }

    return null
  }

  const parseMicroformat = (microformatScript, videoId) => {
    try {
      const data = JSON.parse(microformatScript?.textContent ?? '')
      const embedUrl = new URL(data?.embedUrl, location.origin)
      const embeddedVideoId = embedUrl.pathname.startsWith('/embed/')
        ? embedUrl.pathname.split('/')[2]
        : null

      return embeddedVideoId === videoId ? data : null
    } catch (_) {
      return null
    }
  }

  const waitElements = (videoId) => {
    return new Promise((resolve) => {
      const check = () => {
        timeContent = $('.ytp-chrome-bottom .ytp-time-contents')
        timeWrapper = $('.ytp-chrome-bottom .ytp-time-wrapper')
        progressBar = $('.ytp-chrome-bottom .ytp-progress-bar')

        const microformatScript = $('#microformat script')
        const microformatText = microformatScript?.textContent ?? ''
        const microformatData = parseMicroformat(microformatScript, videoId)

        if (!timeContent || !timeWrapper || !progressBar || !microformatData) {
          return null
        }

        return {
          microformatScript,
          microformatText,
          microformatData,
        }
      }

      const initialResult = check()

      if (initialResult) {
        resolve(initialResult)
        return
      }

      let microformatObserver = null
      let settled = false
      let timeout = 0

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        observer.disconnect()
        microformatObserver?.disconnect()
        resolve(result)
      }

      const observer = new MutationObserver(() => {
        const result = check()
        if (result) finish(result)
      })

      // Player chrome and the #microformat <script> appearing or being replaced
      // surface as childList mutations.
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      })

      // ponytail: keep the heavy characterData watch scoped to #microformat
      // (in-place JSON-LD updates between navigations), not the whole body.
      const microformat = $('#microformat')

      if (microformat) {
        microformatObserver = new MutationObserver(() => {
          const result = check()
          if (result) finish(result)
        })

        microformatObserver.observe(microformat, {
          childList: true,
          characterData: true,
          subtree: true,
        })
      }

      timeout = setTimeout(() => finish(null), 5000)
    })
  }

  const getPublication = (microformatData) => {
    const publications = Array.isArray(microformatData?.publication)
      ? microformatData.publication
      : microformatData?.publication
        ? [microformatData.publication]
        : []

    return publications.find((item) => item?.startDate) ?? null
  }

  const getClock = (publication) => {
    const isArchived = Boolean(publication.endDate)
    const clockId = isArchived
      ? 'yt-live-clock-absolute'
      : 'yt-live-clock-elapsed'

    const staleClockId = isArchived
      ? 'yt-live-clock-elapsed'
      : 'yt-live-clock-absolute'

    $(`#${staleClockId}`)?.remove()

    let clock = $(`#${clockId}`)

    if (!clock) {
      clock = document.createElement('span')
      clock.id = clockId

      const targetNode = isArchived
        ? timeContent
        : timeWrapper

      targetNode.appendChild(clock)
    }

    return clock
  }

  const getClockText = (publication) => {
    const progressTime = Number(progressBar.getAttribute('aria-valuenow')) || 0

    if (publication.endDate) {
      const startTime = Date.parse(publication.startDate)

      // Malformed startDate would otherwise render "(NaN/NaN/NaN ...)".
      if (Number.isFinite(startTime)) {
        return dateFormat(new Date(startTime + progressTime * 1000))
      }
    }

    return timeFormat(progressTime)
  }

  const main = async (videoId) => {
    if (currentVideoId === videoId && progressObserver) return

    const token = ++navigationToken

    currentVideoId = videoId
    cleanup()

    const result = await waitElements(videoId)

    if (!result || token !== navigationToken || videoId !== currentVideoId) return

    const publication = getPublication(result.microformatData)

    if (!publication) {
      removeClocks()
      return
    }

    const liveClock = getClock(publication)
    const updateClock = () => {
      const nextText = getClockText(publication)

      if (liveClock.textContent !== nextText) {
        liveClock.textContent = nextText
      }
    }

    updateClock()

    // ponytail: bound to this progressBar node; if YT rebuilds the player DOM
    // mid-video the clock freezes until the next navigation. Watch for node
    // disconnection if that ever matters in practice.
    progressObserver = new MutationObserver(updateClock)
    progressObserver.observe(progressBar, {
      attributes: true,
      attributeFilter: ['aria-valuenow'],
    })
  }

  const handleNavigation = (rawUrl) => {
    const videoId = getVideoIdFromUrl(rawUrl)

    if (!videoId) {
      navigationToken++
      currentVideoId = null
      cleanup()
      return
    }

    main(videoId)
  }

  document.addEventListener('yt-navigate-finish', (event) => {
    // Not every navigation event carries the full endpoint shape; fall back
    // to location.href instead of throwing and killing the handler.
    const url =
      event?.detail?.endpoint?.commandMetadata?.webCommandMetadata?.url ??
      location.href

    handleNavigation(url)
  })

  handleNavigation(location.href)
})()
