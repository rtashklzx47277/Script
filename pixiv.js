// ==UserScript==
// @name          Pixiv Jump Directly
// @version       0.2.0
// @description   Pixiv Jump Directly
// @author        Derek
// @homepageURL   https://github.com/rtashklzx47277/Script
// @updateURL     https://raw.githubusercontent.com/rtashklzx47277/Script/main/pixiv.js
// @downloadURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/pixiv.js
// @match         *://www.pixiv.net/jump.php?*
// @run-at        document-start
// @grant         none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  // ponytail: naive "second http" scan; assumes jump.php embeds the target as
  // the only other URL in the query. Switch to URL/searchParams parsing if
  // pixiv ever changes the format.
  const url = window.location.href
  const firstHttpIndex = url.indexOf('http')
  const secondHttpIndex = url.indexOf('http', firstHttpIndex + 1)
  if (secondHttpIndex < 0) return // no embedded target URL; avoid redirecting to self

  const targetUrl = url.substring(secondHttpIndex)

  let decodedUrl
  try {
    decodedUrl = decodeURIComponent(targetUrl)
  } catch (_) {
    decodedUrl = targetUrl // malformed % sequence; use the raw string as-is
  }

  window.location.href = decodedUrl
})()
