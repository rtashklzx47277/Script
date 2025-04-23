// ==UserScript==
// @name          EXHT Optimizer
// @version       0.1.0
// @description   EXHT optimizer
// @author        Derek
// @match         *://exhentai.org/s/*
// @run-at        document-start
// @grant         GM_addStyle
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  GM_addStyle(`
    #i1 > h1,
    #i2,
    #i4 > div:first-child,
    #i6,
    #i7,
    div.dp {
      display: none !important;
    }
    html {
      height: 100vh !important;
      weight: 100vw !important;
    }
    #i1 {
      height: calc(100% - 10px) !important;
      width: calc(100% - 10px) !important;
      margin: 5px !important;
      border: 0.5px !important;
      padding: 5px 0 0 !important;
    }
    #i3 img {
      object-fit: contain !important;
      max-height: 88vh !important;
    }
  `)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') document.querySelector('#i5 a').click()
  })
})()
