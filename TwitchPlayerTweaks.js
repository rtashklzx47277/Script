// ==UserScript==
// @name        Twitch Player Tweaks
// @namespace   https://tampermonkey.net/
// @version     0.2.1
// @description Hide clips and interactive extensions, add screenshot button, support wheel volume, and use native-like tooltips.
// @author      Derek
// @match       *://www.twitch.tv/*
// @run-at      document-idle
// @grant       GM_download
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const PLAYER_SELECTOR = '[data-a-target="video-player"]'
  // Prefer Twitch's data-a-target test hook (locale-independent), but keep
  // the aria-label fallbacks — player builds exist where the hook is absent
  // and matching nothing means the screenshot button never appears.
  const THEATER_BUTTON_SELECTOR = [
    'button[data-a-target="player-theatre-mode-button"]',
    'button[aria-label^="劇院模式"]',
    'button[aria-label^="Theater Mode"]',
  ].join(', ')
  const VOLUME_SLIDER_SELECTOR =
    'input[data-a-target="player-volume-slider"]'

  const VOLUME_STEP = 0.05
  const VOLUME_BAR_DURATION = 3000
  const TOOLTIP_VERTICAL_GAP = 10

  const playerStates = new WeakMap()

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const addStyle = (css) => {
    const styleElement = document.createElement('style')
    styleElement.textContent = css
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  addStyle(`
    button[data-a-target="player-clip-button"],
    button[aria-label^="剪輯"],
    button[aria-label^="Clip"] {
      display: none !important;
    }

    .extensions-video-overlay-size-container,
    .extensions-dock__layout,
    .extensions-notifications,
    .extensions-popover {
      display: none !important;
    }

    .twitch-player-tweaks-volume-bar {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 20;
      width: 100%;
      height: 20px;
      color: #fff;
      background: rgba(0, 0, 0, 0.5);
      text-align: center;
      font-size: 13px;
      line-height: 20px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s ease;
    }

    .twitch-player-tweaks-volume-bar[data-visible="true"] {
      opacity: 0.95;
    }

    button[data-twitch-player-tweaks="screenshot"] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    button[data-twitch-player-tweaks="screenshot"] svg {
      fill: currentColor;
    }

    .twitch-player-tweaks-tooltip {
      position: absolute;
      z-index: 30;
      display: none;
      height: 27.6px;
      padding: 4px 8px;
      box-sizing: border-box;
      color: rgb(14, 14, 16);
      background: rgb(255, 255, 255);
      border-radius: 4px;
      font-family: Inter, "Noto Sans Arabic", Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      line-height: 19.6px;
      white-space: nowrap;
      pointer-events: none;
      transform: translateX(-50%);
    }

    .twitch-player-tweaks-tooltip::after {
      position: absolute;
      bottom: -5px;
      left: 50%;
      width: 10px;
      height: 10px;
      background: rgb(255, 255, 255);
      content: '';
      transform: translateX(-50%) rotate(45deg);
    }

    .twitch-player-tweaks-tooltip[data-visible="true"] {
      display: inline-block;
    }
  `)

  const setNativeInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set

    setter?.call(input, value)
  }

  // Class instead of id: multiple players (squad / mini player) each get
  // their own bar without producing duplicate ids in the document.
  const getVolumeBar = (player) => {
    let bar = $('.twitch-player-tweaks-volume-bar', player)

    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'twitch-player-tweaks-volume-bar'
      bar.dataset.visible = 'false'
      player.appendChild(bar)
    }

    return bar
  }

  const getTooltip = (player) => {
    let tooltip = $('.twitch-player-tweaks-tooltip', player)

    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.className = 'twitch-player-tweaks-tooltip'
      tooltip.dataset.visible = 'false'
      player.appendChild(tooltip)
    }

    return tooltip
  }

  const ensurePlayerState = (player) => {
    let state = playerStates.get(player)

    if (!state) {
      state = {
        volumeBar: getVolumeBar(player),
        volumeBarTimer: 0,
        tooltip: getTooltip(player),
      }

      player.addEventListener(
        'wheel',
        (event) => changeVolume(event, player),
        {
          capture: true,
          passive: false,
        }
      )

      playerStates.set(player, state)
    } else {
      state.volumeBar = getVolumeBar(player)
      state.tooltip = getTooltip(player)
    }

    return state
  }

  const showVolumeBar = (player, volume) => {
    const state = ensurePlayerState(player)

    clearTimeout(state.volumeBarTimer)

    state.volumeBar.textContent = `${Math.round(volume * 100)}`
    state.volumeBar.dataset.visible = 'true'

    state.volumeBarTimer = setTimeout(() => {
      state.volumeBar.dataset.visible = 'false'
    }, VOLUME_BAR_DURATION)
  }

  const syncVolumeSliders = (player, volume) => {
    const percent = Math.round(volume * 100)

    for (const slider of $$(VOLUME_SLIDER_SELECTOR, player)) {
      setNativeInputValue(slider, String(volume))
      slider.setAttribute('aria-valuenow', String(percent))
      slider.setAttribute('aria-valuetext', `${percent}%`)
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      slider.dispatchEvent(new Event('change', { bubbles: true }))

      const fill = slider.parentElement?.querySelector(
        '[data-test-selector="tw-range__fill-value-selector"]'
      )

      if (fill) fill.style.width = `${percent}%`
    }
  }

  const changeVolume = (event, player) => {
    const video = $('video', player)
    if (!video) return

    event.preventDefault()
    event.stopPropagation()

    const nextVolume = clamp(
      Number(
        (
          video.volume +
          (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP)
        ).toFixed(2)
      ),
      0,
      1
    )

    syncVolumeSliders(player, nextVolume)

    video.volume = nextVolume
    if (nextVolume > 0 && video.muted) video.muted = false

    video.dispatchEvent(new Event('volumechange', { bubbles: true }))
    showVolumeBar(player, nextVolume)
  }

  const showTooltip = (player, button, text) => {
    const state = ensurePlayerState(player)
    const playerRect = player.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()

    state.tooltip.textContent = text
    state.tooltip.dataset.visible = 'true'

    requestAnimationFrame(() => {
      const tooltipRect = state.tooltip.getBoundingClientRect()

      state.tooltip.style.left =
        `${buttonRect.left - playerRect.left + buttonRect.width / 2}px`

      state.tooltip.style.top =
        `${buttonRect.top - playerRect.top - tooltipRect.height - TOOLTIP_VERTICAL_GAP}px`
    })
  }

  const hideTooltip = (player) => {
    ensurePlayerState(player).tooltip.dataset.visible = 'false'
  }

  const getScreenshotFileName = () => {
    const segments = location.pathname.split('/').filter(Boolean)
    // On non-channel pages (e.g. /videos/<id>) the first segment isn't a
    // channel name; fall back to a generic prefix.
    const channel =
      (['videos', 'directory'].includes(segments[0]) ? '' : segments[0]) ||
      'twitch'
    const now = new Date()

    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '-',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')

    return `${channel}-${stamp}.png`
  }

  const takeScreenshot = (player) => {
    const video = $('video', player)
    if (!video || !video.videoWidth || !video.videoHeight) return

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    context.drawImage(video, 0, 0)

    const fileName = `ScreenShot/${getScreenshotFileName()}`

    canvas.toBlob((blob) => {
      if (!blob) return

      const objectUrl = URL.createObjectURL(blob)
      const revokeObjectUrl = () => URL.revokeObjectURL(objectUrl)
      const downloadFallback = () => {
        revokeObjectUrl()

        GM_download({
          url: canvas.toDataURL('image/png'),
          name: fileName,
        })
      }

      try {
        GM_download({
          url: objectUrl,
          name: fileName,
          onload: revokeObjectUrl,
          onerror: downloadFallback,
          ontimeout: downloadFallback,
        })
      } catch (_) {
        downloadFallback()
      }
    }, 'image/png')
  }

  const createScreenshotButton = (theaterButton, player) => {
    // Clone to inherit Twitch's current button classes at runtime (kept fresh
    // by Twitch itself), but strip Twitch's behavioral hook so its own code
    // never targets our button as the theater button.
    const button = theaterButton.cloneNode(false)

    button.dataset.twitchPlayerTweaks = 'screenshot'
    button.setAttribute('aria-label', '截圖')
    button.removeAttribute('title')
    button.removeAttribute('aria-haspopup')
    button.removeAttribute('data-a-target')

    // Bare SVG + own CSS instead of Twitch's build-hashed wrapper classes,
    // which change on every redeploy.
    button.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" focusable="false" aria-hidden="true" role="presentation">
        <path d="M9 4 7.5 6H5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-2.5L15 4H9Zm3 4a5 5 0 1 1 0 10a5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6a3 3 0 0 0 0-6Z"></path>
      </svg>
    `

    button.addEventListener('click', () => takeScreenshot(player))
    button.addEventListener('mouseenter', () => {
      showTooltip(player, button, '截圖')
    })
    button.addEventListener('mouseleave', () => {
      hideTooltip(player)
    })
    button.addEventListener('focus', () => {
      showTooltip(player, button, '截圖')
    })
    button.addEventListener('blur', () => {
      hideTooltip(player)
    })

    return button
  }

  const ensureScreenshotButtons = (player) => {
    for (const theaterButton of $$(THEATER_BUTTON_SELECTOR, player)) {
      const theaterButtonWrapper = theaterButton.parentElement
      const theaterSlot = theaterButtonWrapper?.parentElement
      const controls = theaterSlot?.parentElement

      if (!theaterButtonWrapper || !theaterSlot || !controls) continue

      if (
        controls.querySelector(
          ':scope > [data-twitch-player-tweaks-slot="screenshot"]'
        )
      ) {
        continue
      }

      const screenshotSlot = theaterSlot.cloneNode(false)
      const screenshotButtonWrapper = theaterButtonWrapper.cloneNode(false)
      const screenshotButton = createScreenshotButton(theaterButton, player)

      screenshotSlot.removeAttribute('data-a-target')
      screenshotButtonWrapper.removeAttribute('data-a-target')
      screenshotSlot.dataset.twitchPlayerTweaksSlot = 'screenshot'

      screenshotButtonWrapper.appendChild(screenshotButton)
      screenshotSlot.appendChild(screenshotButtonWrapper)
      controls.insertBefore(screenshotSlot, theaterSlot)
    }
  }

  const refresh = () => {
    for (const player of $$(PLAYER_SELECTOR)) {
      ensurePlayerState(player)
      ensureScreenshotButtons(player)
    }
  }

  // ponytail: throttle to ~4/s instead of per-frame, and let the cheap,
  // idempotent refresh() do the selector matching once — rather than running a
  // deep querySelector on every added node during Twitch's constant DOM churn.
  const REFRESH_INTERVAL = 250
  let refreshTimer = 0
  let lastRefresh = 0

  const scheduleRefresh = () => {
    if (refreshTimer) return

    const wait = Math.max(0, REFRESH_INTERVAL - (Date.now() - lastRefresh))
    refreshTimer = setTimeout(() => {
      refreshTimer = 0
      lastRefresh = Date.now()
      refresh()
    }, wait)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length) {
        scheduleRefresh()
        return
      }
    }
  })

  refresh()

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  })
})()
