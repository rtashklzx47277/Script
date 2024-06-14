// ==UserScript==
// @name         EXH Image Fit Window
// @version      0.1.0
// @description  EXH Image Fit Window
// @author       Derek
// @match        *://exhentai.org/s/*
// @run-at       document-body
// @grant        none
// @noframes
// ==/UserScript==

const $ = (element) => document.querySelector(element)

const css = `
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
    max-height: 88vh !important;
  }
`

if (!$('#exh-css')) {
  const cssStyle = document.createElement('style')
  cssStyle.setAttribute('id', 'exh-css')
  cssStyle.textContent = css
  document.head.appendChild(cssStyle)
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') $('#i5 a').click()
})
