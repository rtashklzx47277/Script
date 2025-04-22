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

  const style = document.createElement('style')
  style.textContent = `.blacklisted {
    display: none !important;
  }`
  document.head.appendChild(style)
})()
