// ==UserScript==
// @name         Kemono Discord Sort
// @version      0.1.0
// @description  sort discord
// @author       Derek
// @match        *://kemono.su/discord/server/*
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const sortLists = () => {
    const uls = document.querySelectorAll('ul')
    if (uls.length < 2) return false

    const ul = uls[0]
    const items = Array.from(ul.getElementsByTagName('li'))
    items.sort((a, b) => {
      const hrefA = a.querySelector('a').getAttribute('href')
      const hrefB = b.querySelector('a').getAttribute('href')
      return hrefB.localeCompare(hrefA)
    })
    ul.innerHTML = ''
    items.forEach(item => ul.appendChild(item))

    return true
  }

  const runSort = () => {
    if (sortLists()) {
      if (observer) observer.disconnect()
      return
    }

    if (!observer) {
      observer = new MutationObserver(() => {
        if (sortLists()) observer.disconnect()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }
  }

  let observer = null
  runSort()
  window.addEventListener('popstate', () => { runSort() })
})()
