// ==UserScript==
// @name         EXHT Image Fit Window
// @version      0.1.0
// @description  EXHT Image Fit Window
// @author       Derek
// @match        *://exhentai.org/s/*
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const $ = (element) => document.querySelector(element)

  if (!$('#exht-css')) {
    const styleElement = document.createElement('style')
    styleElement.id = 'exht-css'
    styleElement.textContent = `
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
      #i3 img {
        object-fit: contain !important;
        max-height: 85vh !important;
      }
    `
    document.head.appendChild(styleElement)
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') $('#i5 a').click()
  })
})()
