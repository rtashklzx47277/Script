// ==UserScript==
// @name          NHT Optimizer
// @version       0.1.0
// @description   nht optimizer
// @author        Derek
// @match         *://nhentai.net/*
// @run-at        document-start
// @grant         GM_addStyle
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  GM_addStyle(`
    .blacklisted {
      display: none !important;
    }
  `)
})()
