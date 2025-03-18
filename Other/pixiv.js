// ==UserScript==
// @name               Pixiv Jump Directly
// @version            0.1.0
// @description        Pixiv Jump Directly
// @author             Derek
// @match              *://www.pixiv.net/jump.php?*
// @grant              none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const url = window.location.href
  const firstHttpIndex = url.indexOf('http')
  const secondHttpIndex = url.indexOf('http', firstHttpIndex + 1)
  const targetUrl = window.location.href.substring(secondHttpIndex)
  const decodeUrl = decodeURIComponent(targetUrl)
  window.location.href = decodeUrl
})()
