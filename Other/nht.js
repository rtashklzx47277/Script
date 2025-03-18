// ==UserScript==
// @name         Hide NHT Blacklist
// @version      0.1.0
// @description  hide nht blacklist
// @author       Derek
// @match        *://nhentai.net/*
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  if (!document.querySelector('#nht-css')) {
    let styleElement = document.createElement('style')
    styleElement.id = 'nht-css'
    styleElement.textContent = `.blacklisted {
      display: none !important;
    }`
    document.head.appendChild(styleElement)
  }
})()
