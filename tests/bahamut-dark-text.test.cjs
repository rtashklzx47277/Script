const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repoRoot = path.resolve(__dirname, '..')
const scriptSource = fs.readFileSync(path.join(repoRoot, 'BahamutForumDarkTextFix.user.js'), 'utf8')

function createMockDom({ articleBg = 'rgb(39, 39, 39)', dataTheme = 'dark' } = {}) {
  const mutationObservers = []
  const mediaListeners = []
  const rafCallbacks = []
  let nextRafId = 1

  class MockElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase()
      this.nodeType = 1
      this.children = []
      this.parentElement = null
      this.attrs = new Map()
      this.isConnected = true
      this.id = ''
      this.computedBg = 'rgba(0, 0, 0, 0)'
      this.textContent = ''
      this.isContentEditable = false
      this._classes = new Set()
      this.classList = {
        contains: (name) => this._classes.has(name),
        add: (name) => this._classes.add(name),
        remove: (name) => this._classes.delete(name),
      }
      const props = new Map()
      this.style = {
        get color() {
          return props.get('color')?.value || ''
        },
        set color(value) {
          if (value === '' || value == null) props.delete('color')
          else props.set('color', { value: String(value), priority: '' })
        },
        setProperty(name, value, priority = '') {
          if (value === '' || value == null) props.delete(name)
          else props.set(name, { value: String(value), priority: String(priority || '') })
        },
        removeProperty(name) {
          props.delete(name)
        },
        getPropertyValue(name) {
          return props.get(name)?.value || ''
        },
        getPropertyPriority(name) {
          return props.get(name)?.priority || ''
        },
      }
    }

    appendChild(child) {
      child.parentElement = this
      child.isConnected = this.isConnected
      this.children.push(child)
      return child
    }

    setAttribute(name, value) {
      const str = String(value)
      this.attrs.set(name, str)
      if (name === 'id') this.id = str
      if (name === 'class') {
        this._classes = new Set(str.split(/\s+/).filter(Boolean))
      }
    }

    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null
    }

    removeAttribute(name) {
      this.attrs.delete(name)
    }

    matches(selector) {
      if (selector === '.c-article__content') return this._classes.has('c-article__content')
      return false
    }

    closest(selector) {
      let cur = this
      while (cur) {
        if (cur.matches(selector)) return cur
        cur = cur.parentElement
      }
      return null
    }

    querySelectorAll(selector) {
      const results = []
      const walk = (node) => {
        for (const child of node.children) {
          if (selector === '.c-article__content') {
            if (child._classes.has('c-article__content')) results.push(child)
          } else if (selector.includes('[color]')) {
            if (
              child.attrs.has('color') ||
              child.attrs.has('bgcolor') ||
              child.style.getPropertyValue('color') ||
              (child.attrs.get('style') || '').toLowerCase().includes('color') ||
              (child.attrs.get('style') || '').toLowerCase().includes('background')
            ) {
              results.push(child)
            }
          }
          walk(child)
        }
      }
      walk(this)
      return results
    }
  }

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      mutationObservers.push(this)
    }
    observe(target, options) {
      this.targets.push({ target, options })
    }
    disconnect() {}
    triggerAdded(target, addedNodes) {
      this.callback([{ type: 'childList', target, addedNodes }])
    }
    triggerAttribute(target) {
      this.callback([{ type: 'attributes', target }])
    }
  }

  const documentElement = new MockElement('html')
  if (dataTheme) documentElement.setAttribute('data-theme', dataTheme)
  documentElement.computedBg = articleBg

  const head = new MockElement('head')
  const body = new MockElement('body')
  body.computedBg = articleBg
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => {
      const find = (node) => {
        if (node.id === id) return node
        for (const c of node.children) {
          const hit = find(c)
          if (hit) return hit
        }
        return null
      }
      return find(documentElement)
    },
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener: () => {},
  }

  const window = {
    document,
    getComputedStyle: (el) => ({ backgroundColor: el.computedBg || 'rgba(0, 0, 0, 0)' }),
    matchMedia: () => ({
      matches: dataTheme === 'dark',
      addEventListener: (_, fn) => mediaListeners.push(fn),
    }),
    requestAnimationFrame: (cb) => {
      const id = nextRafId++
      rafCallbacks.push(cb)
      return id
    },
  }

  return {
    MockElement,
    document,
    window,
    mutationObservers,
    runRaf() {
      const queue = rafCallbacks.splice(0, rafCallbacks.length)
      for (const cb of queue) cb()
    },
    runScript() {
      vm.runInNewContext(scriptSource, {
        window,
        document,
        MutationObserver: MockMutationObserver,
        setTimeout,
        clearTimeout,
      })
    },
  }
}

function parseRgbString(str) {
  const m = str.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/)
  assert.ok(m, `Expected rgb/rgba string, got: ${str}`)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] ? Number(m[4]) : 1 }
}

function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(c1, c2) {
  const l1 = luminance(c1)
  const l2 = luminance(c2)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

test('BahamutForumDarkTextFix: preserves hues and boosts contrast in dark mode', () => {
  const dom = createMockDom({ articleBg: 'rgb(39, 39, 39)', dataTheme: 'dark' })
  const { MockElement, document } = dom

  const article = new MockElement('div')
  article.setAttribute('class', 'c-article__content')
  article.computedBg = 'rgb(39, 39, 39)'
  document.body.appendChild(article)

  const blackFont = new MockElement('font')
  blackFont.setAttribute('color', '#000000')
  article.appendChild(blackFont)

  const darkGrayFont = new MockElement('font')
  darkGrayFont.setAttribute('color', '#333333')
  article.appendChild(darkGrayFont)

  const mutedGrayFont = new MockElement('font')
  mutedGrayFont.setAttribute('color', '#666666')
  article.appendChild(mutedGrayFont)

  const redFont = new MockElement('font')
  redFont.setAttribute('color', '#ff0000')
  article.appendChild(redFont)

  const blueFont = new MockElement('font')
  blueFont.setAttribute('color', '#0000ff')
  article.appendChild(blueFont)

  const greenSpan = new MockElement('span')
  greenSpan.style.setProperty('color', 'green')
  article.appendChild(greenSpan)

  const purpleSpan = new MockElement('span')
  purpleSpan.style.setProperty('color', 'hsl(300, 100%, 25%)')
  article.appendChild(purpleSpan)

  const bareHexFont = new MockElement('font')
  bareHexFont.setAttribute('color', '000080')
  article.appendChild(bareHexFont)

  const yellowFont = new MockElement('font')
  yellowFont.setAttribute('color', '#ffff00')
  article.appendChild(yellowFont)

  dom.runScript()

  const bg = { r: 39, g: 39, b: 39 }
  assert.equal(article.getAttribute('data-baha-dark-article'), '1')
  const styleEl = document.getElementById('baha-dark-text-fix-style')
  assert.ok(styleEl)
  assert.match(styleEl.textContent, /color:\s*inherit\s*!important/)

  const blackRgb = parseRgbString(blackFont.style.getPropertyValue('color'))
  const gray333Rgb = parseRgbString(darkGrayFont.style.getPropertyValue('color'))
  const mutedRgb = parseRgbString(mutedGrayFont.style.getPropertyValue('color'))
  assert.ok(contrast(blackRgb, bg) >= 5.0)
  assert.ok(contrast(gray333Rgb, bg) >= 5.0)
  assert.ok(contrast(mutedRgb, bg) >= 5.0)
  assert.ok(blackRgb.r >= gray333Rgb.r && gray333Rgb.r > mutedRgb.r)

  const redRgb = parseRgbString(redFont.style.getPropertyValue('color'))
  assert.equal(redFont.style.getPropertyPriority('color'), 'important')
  assert.ok(redRgb.r > redRgb.g && redRgb.r > redRgb.b)
  assert.ok(contrast(redRgb, bg) >= 4.95)

  const blueRgb = parseRgbString(blueFont.style.getPropertyValue('color'))
  assert.equal(blueFont.style.getPropertyPriority('color'), 'important')
  assert.ok(blueRgb.b > blueRgb.r && blueRgb.b > blueRgb.g)
  assert.ok(contrast(blueRgb, bg) >= 4.95)

  const greenRgb = parseRgbString(greenSpan.style.getPropertyValue('color'))
  assert.ok(greenRgb.g > greenRgb.r && greenRgb.g > greenRgb.b)
  assert.ok(contrast(greenRgb, bg) >= 4.95)

  const purpleRgb = parseRgbString(purpleSpan.style.getPropertyValue('color'))
  assert.ok(purpleRgb.r > purpleRgb.g && purpleRgb.b > purpleRgb.g)
  assert.ok(contrast(purpleRgb, bg) >= 4.95)

  const navyRgb = parseRgbString(bareHexFont.style.getPropertyValue('color'))
  assert.ok(navyRgb.b > navyRgb.r && navyRgb.b > navyRgb.g)
  assert.ok(contrast(navyRgb, bg) >= 4.95)

  const yellowRgb = parseRgbString(yellowFont.style.getPropertyValue('color'))
  assert.deepEqual(yellowRgb, { r: 255, g: 255, b: 0, a: 1 })
})

test('BahamutForumDarkTextFix: leaves light mode untouched and restores colors on dark-to-light switch', () => {
  const dom = createMockDom({ articleBg: 'rgb(39, 39, 39)', dataTheme: 'dark' })
  const { MockElement, document, mutationObservers } = dom

  const article = new MockElement('div')
  article.setAttribute('class', 'c-article__content')
  article.computedBg = 'rgb(39, 39, 39)'
  document.body.appendChild(article)

  const fontOnly = new MockElement('font')
  fontOnly.setAttribute('color', '#ff0000')
  article.appendChild(fontOnly)

  const inlineColored = new MockElement('span')
  inlineColored.style.setProperty('color', '#0000ff')
  article.appendChild(inlineColored)

  dom.runScript()

  assert.equal(article.getAttribute('data-baha-dark-article'), '1')
  assert.notEqual(fontOnly.style.getPropertyValue('color'), '')
  assert.notEqual(inlineColored.style.getPropertyValue('color'), '#0000ff')

  // Simulate switching Bahamut back to light mode.
  document.documentElement.setAttribute('data-theme', 'light')
  document.documentElement.computedBg = 'rgb(255, 255, 255)'
  document.body.computedBg = 'rgb(255, 255, 255)'
  article.computedBg = 'rgb(255, 255, 255)'

  const themeObserver = mutationObservers.find((obs) =>
    obs.targets.some((t) => t.options.attributes))
  assert.ok(themeObserver)
  themeObserver.triggerAttribute(document.documentElement)
  dom.runRaf()

  assert.equal(article.getAttribute('data-baha-dark-article'), null)
  assert.equal(fontOnly.style.getPropertyValue('color'), '')
  assert.equal(inlineColored.style.getPropertyValue('color'), '#0000ff')
  assert.equal(inlineColored.style.getPropertyPriority('color'), '')
})

test('BahamutForumDarkTextFix: handles preserved light highlight backgrounds, dynamic posts, and contenteditable', () => {
  const dom = createMockDom({ articleBg: 'rgb(39, 39, 39)', dataTheme: 'dark' })
  const { MockElement, document, mutationObservers } = dom

  const article = new MockElement('div')
  article.setAttribute('class', 'c-article__content')
  article.computedBg = 'rgb(39, 39, 39)'
  document.body.appendChild(article)

  const yellowBox = new MockElement('span')
  yellowBox.setAttribute('style', 'background-color: #ffff00; color: #000000')
  yellowBox.style.setProperty('color', '#000000')
  yellowBox.computedBg = 'rgb(255, 255, 0)'
  article.appendChild(yellowBox)

  const uncoloredHighlight = new MockElement('span')
  uncoloredHighlight.setAttribute('style', 'background-color: #ffffcc')
  uncoloredHighlight.computedBg = 'rgb(255, 255, 204)'
  article.appendChild(uncoloredHighlight)

  const editor = new MockElement('div')
  editor.setAttribute('contenteditable', 'true')
  const editableFont = new MockElement('font')
  editableFont.setAttribute('color', '#0000ff')
  editor.appendChild(editableFont)
  article.appendChild(editor)

  dom.runScript()

  assert.deepEqual(parseRgbString(yellowBox.style.getPropertyValue('color')), { r: 0, g: 0, b: 0, a: 1 })
  assert.deepEqual(parseRgbString(uncoloredHighlight.style.getPropertyValue('color')), { r: 34, g: 34, b: 34, a: 1 })
  assert.equal(editableFont.style.getPropertyValue('color'), '')

  // Dynamically inserted post content
  const newArticle = new MockElement('div')
  newArticle.setAttribute('class', 'c-article__content')
  newArticle.computedBg = 'rgb(39, 39, 39)'
  const dynamicRed = new MockElement('font')
  dynamicRed.setAttribute('color', '#cc0000')
  newArticle.appendChild(dynamicRed)
  document.body.appendChild(newArticle)

  const domObserver = mutationObservers.find((obs) =>
    obs.targets.some((t) => t.options.childList))
  assert.ok(domObserver)
  domObserver.triggerAdded(document.body, [newArticle])
  dom.runRaf()

  const dynamicRgb = parseRgbString(dynamicRed.style.getPropertyValue('color'))
  assert.ok(dynamicRgb.r > dynamicRgb.g && dynamicRgb.r > dynamicRgb.b)
  assert.ok(contrast(dynamicRgb, { r: 39, g: 39, b: 39 }) >= 4.95)
})
