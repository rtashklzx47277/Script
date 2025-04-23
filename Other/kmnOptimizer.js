// ==UserScript==
// @name          KMN Optimizer
// @version       0.1.0
// @description   KMN optimizer
// @author        Derek
// @match         *://kemono.su/*
// @run-at        document-start
// @grant         GM_addStyle
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  GM_addStyle(`
    .post__thumbnail img {
      max-height: 100vh !important;
    }
  `)

  let listObserver = null
  let imageObserver = null
  let keyListener = null
  let currentIndex = -1

  const $ = (element) => document.querySelector(element)
  const $$ = (element) => document.querySelectorAll(element)

  const reverseList = () => {
    const ul = $('aside ul')
    const items = Array.from(ul.getElementsByTagName('li'))
    items.sort((a, b) => {
      const hrefA = a.querySelector('a').getAttribute('href')
      const hrefB = b.querySelector('a').getAttribute('href')
      return hrefB.localeCompare(hrefA)
    })
    ul.innerHTML = ''
    items.forEach(item => ul.appendChild(item))
  }

  const startKeyListener = () => {
    keyListener = (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault()
      const thumbnails = Array.from($$('.post__thumbnail'))
      if (thumbnails.length === 0) return
      thumbnails.forEach(el => el.setAttribute('tabindex', '0'))

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (event.key === 'ArrowUp' && currentIndex > 0) currentIndex--
        else if (event.key === 'ArrowDown' && currentIndex < thumbnails.length - 1) currentIndex++

        thumbnails[currentIndex].focus()
        thumbnails[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
    document.addEventListener('keydown', keyListener)
  }

  const waitForList = () => {
    const list = $('aside ul')
    if (list) reverseList()

    listObserver = new MutationObserver(() => {
      const list = $('aside ul')
      if (list) {
        reverseList()
        listObserver.disconnect()
        listObserver = null
      }
    })
    listObserver.observe(document.body, { childList: true, subtree: true })
  }

  const waitForImages = () => {
    const thumbnails = $$('.post__thumbnail')
    if (thumbnails.length > 0) {
      startKeyListener()
      return
    }

    imageObserver = new MutationObserver(() => {
      const thumbnails = $$('.post__thumbnail')
      if (thumbnails.length > 0) {
        startKeyListener()
        imageObserver.disconnect()
        imageObserver = null
      }
    })
    imageObserver.observe(document.body, { childList: true, subtree: true })
  }

  const clearObserversAndListeners = () => {
    if (imageObserver) {
      imageObserver.disconnect()
      imageObserver = null
    }
    if (keyListener) {
      document.removeEventListener('keydown', keyListener)
      keyListener = null
    }
  }

  const handleUrlChange = (url) => {
    clearObserversAndListeners()
    if (url.toLowerCase().includes('discord')) waitForList()
    if (/\/post\//i.test(url)) waitForImages()
  }

  const originalPushState = history.pushState
  history.pushState = function () {
    originalPushState.apply(this, arguments)
    handleUrlChange(location.href)
  }

  window.addEventListener('popstate', () => handleUrlChange(location.href))
  handleUrlChange(location.href)
})()
