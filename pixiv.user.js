// ==UserScript==
// @name          Pixiv Jump Directly
// @version       0.2.2
// @updateURL     https://raw.githubusercontent.com/rtashklzx47277/Script/main/pixiv.user.js
// @downloadURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/pixiv.user.js
// @description   Pixiv Jump Directly
// @author        Derek
// @match         *://www.pixiv.net/jump.php?*
// @run-at        document-start
// @grant         none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const rawTarget = window.location.search.slice(1)
  if (!rawTarget) return

  let targetUrl = rawTarget

  // A raw target may legitimately contain encoded delimiters such as %26.
  // Decode only when Pixiv encoded the whole target URL.
  if (!/^https?:\/\//i.test(targetUrl)) {
    try {
      targetUrl = decodeURIComponent(targetUrl)
    } catch (_) {
      return
    }
  }

  if (!/^https?:\/\//i.test(targetUrl)) return

  // In an unencoded jump target, the fragment belongs to the destination,
  // although the browser exposes it separately from location.search.
  if (window.location.hash && !targetUrl.includes('#')) {
    targetUrl += window.location.hash
  }

  window.location.href = targetUrl
})()
