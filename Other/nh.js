// ==UserScript==
// @name         Hide NHenTai Blacklist
// @version      0.1.0
// @description  hide nhentai blacklist
// @author       Derek
// @match        *://nhentai.net/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

if (!document.querySelector('#nht-css')) {
  let cssStyle = document.createElement('style')
  cssStyle.setAttribute('id', 'nht-css')
  cssStyle.textContent = `.blacklisted {
    display: none !important;
  }`
  document.body.appendChild(cssStyle)
}
