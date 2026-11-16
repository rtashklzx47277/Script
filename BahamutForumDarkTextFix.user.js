// ==UserScript==
// @name        Bahamut Forum Dark Text Fix
// @namespace   https://tampermonkey.net/
// @version     0.1.0
// @updateURL   https://raw.githubusercontent.com/rtashklzx47277/Script/main/BahamutForumDarkTextFix.user.js
// @downloadURL https://raw.githubusercontent.com/rtashklzx47277/Script/main/BahamutForumDarkTextFix.user.js
// @description 改善巴哈姆特哈啦區黑暗模式強制將文章文字全部改為白色的問題，保留原有色相並自動調整深色與低對比字體以維持可讀性。
// @author      Derek
// @match       *://forum.gamer.com.tw/*
// @run-at      document-idle
// @grant       none
// @noframes
// ==/UserScript==

(() => {
  'use strict'

  const STYLE_ID = 'baha-dark-text-fix-style'
  const ARTICLE_SELECTOR = '.c-article__content'
  const DARK_ARTICLE_ATTR = 'data-baha-dark-article'
  const COLORED_NODE_SELECTOR = '[color], [bgcolor], [style*="color" i], [style*="background" i]'
  const LIGHT_BG_TEXT_COLOR = 'rgb(34, 34, 34)'
  const DARK_BG_LUMINANCE_THRESHOLD = 0.35
  const TARGET_CONTRAST = 5.0
  const NEUTRAL_CHROMA_THRESHOLD = 18 / 255
  const DARK_NEUTRAL_CUTOFF = 0.55

  const NAMED_COLORS = {
    aliceblue: [240, 248, 255],
    antiquewhite: [250, 235, 215],
    aqua: [0, 255, 255],
    aquamarine: [127, 255, 212],
    azure: [240, 255, 255],
    beige: [245, 245, 220],
    bisque: [255, 228, 196],
    black: [0, 0, 0],
    blanchedalmond: [255, 235, 205],
    blue: [0, 0, 255],
    blueviolet: [138, 43, 226],
    brown: [165, 42, 42],
    burlywood: [222, 184, 135],
    cadetblue: [95, 158, 160],
    chartreuse: [127, 255, 0],
    chocolate: [210, 105, 30],
    coral: [255, 127, 80],
    cornflowerblue: [100, 149, 237],
    cornsilk: [255, 248, 220],
    crimson: [220, 20, 60],
    cyan: [0, 255, 255],
    darkblue: [0, 0, 139],
    darkcyan: [0, 139, 139],
    darkgoldenrod: [184, 134, 11],
    darkgray: [169, 169, 169],
    darkgreen: [0, 100, 0],
    darkgrey: [169, 169, 169],
    darkkhaki: [189, 183, 107],
    darkmagenta: [139, 0, 139],
    darkolivegreen: [85, 107, 47],
    darkorange: [255, 140, 0],
    darkorchid: [153, 50, 204],
    darkred: [139, 0, 0],
    darksalmon: [233, 150, 122],
    darkseagreen: [143, 188, 143],
    darkslateblue: [72, 61, 139],
    darkslategray: [47, 79, 79],
    darkslategrey: [47, 79, 79],
    darkturquoise: [0, 206, 209],
    darkviolet: [148, 0, 211],
    deeppink: [255, 20, 147],
    deepskyblue: [0, 191, 255],
    dimgray: [105, 105, 105],
    dimgrey: [105, 105, 105],
    dodgerblue: [30, 144, 255],
    firebrick: [178, 34, 34],
    floralwhite: [255, 250, 240],
    forestgreen: [34, 139, 34],
    fuchsia: [255, 0, 255],
    gainsboro: [220, 220, 220],
    ghostwhite: [248, 248, 255],
    gold: [255, 215, 0],
    goldenrod: [218, 165, 32],
    gray: [128, 128, 128],
    green: [0, 128, 0],
    greenyellow: [173, 255, 47],
    grey: [128, 128, 128],
    honeydew: [240, 255, 240],
    hotpink: [255, 105, 180],
    indianred: [205, 92, 92],
    indigo: [75, 0, 130],
    ivory: [255, 255, 240],
    khaki: [240, 230, 140],
    lavender: [230, 230, 250],
    lavenderblush: [255, 240, 245],
    lawngreen: [124, 252, 0],
    lemonchiffon: [255, 250, 205],
    lightblue: [173, 216, 230],
    lightcoral: [240, 128, 128],
    lightcyan: [224, 255, 255],
    lightgoldenrodyellow: [250, 250, 210],
    lightgray: [211, 211, 211],
    lightgreen: [144, 238, 144],
    lightgrey: [211, 211, 211],
    lightpink: [255, 182, 193],
    lightsalmon: [255, 160, 122],
    lightseagreen: [32, 178, 170],
    lightskyblue: [135, 206, 250],
    lightslategray: [119, 136, 153],
    lightslategrey: [119, 136, 153],
    lightsteelblue: [176, 196, 222],
    lightyellow: [255, 255, 224],
    lime: [0, 255, 0],
    limegreen: [50, 205, 50],
    linen: [250, 240, 230],
    magenta: [255, 0, 255],
    maroon: [128, 0, 0],
    mediumaquamarine: [102, 205, 170],
    mediumblue: [0, 0, 205],
    mediumorchid: [186, 85, 211],
    mediumpurple: [147, 112, 219],
    mediumseagreen: [60, 179, 113],
    mediumslateblue: [123, 104, 238],
    mediumspringgreen: [0, 250, 154],
    mediumturquoise: [72, 209, 204],
    mediumvioletred: [199, 21, 133],
    midnightblue: [25, 25, 112],
    mintcream: [245, 255, 250],
    mistyrose: [255, 228, 225],
    moccasin: [255, 228, 181],
    navajowhite: [255, 222, 173],
    navy: [0, 0, 128],
    oldlace: [253, 245, 230],
    olive: [128, 128, 0],
    olivedrab: [107, 142, 35],
    orange: [255, 165, 0],
    orangered: [255, 69, 0],
    orchid: [218, 112, 214],
    palegoldenrod: [238, 232, 170],
    palegreen: [152, 251, 152],
    paleturquoise: [175, 238, 238],
    palevioletred: [219, 112, 147],
    papayawhip: [255, 239, 213],
    peachpuff: [255, 218, 185],
    peru: [205, 133, 63],
    pink: [255, 192, 203],
    plum: [221, 160, 221],
    powderblue: [176, 224, 230],
    purple: [128, 0, 128],
    rebeccapurple: [102, 51, 153],
    red: [255, 0, 0],
    rosybrown: [188, 143, 143],
    royalblue: [65, 105, 225],
    saddlebrown: [139, 69, 19],
    salmon: [250, 128, 114],
    sandybrown: [244, 164, 96],
    seagreen: [46, 139, 87],
    seashell: [255, 245, 238],
    sienna: [160, 82, 45],
    silver: [192, 192, 192],
    skyblue: [135, 206, 235],
    slateblue: [106, 90, 205],
    slategray: [112, 128, 144],
    slategrey: [112, 128, 144],
    snow: [255, 250, 250],
    springgreen: [0, 255, 127],
    steelblue: [70, 130, 180],
    tan: [210, 180, 140],
    teal: [0, 128, 128],
    thistle: [216, 191, 216],
    tomato: [255, 99, 71],
    turquoise: [64, 224, 208],
    violet: [238, 130, 238],
    wheat: [245, 222, 179],
    white: [255, 255, 255],
    whitesmoke: [245, 245, 245],
    yellow: [255, 255, 0],
    yellowgreen: [154, 205, 50],
  }

  const originalSnapshots = new WeakMap()
  const trackedContainers = new Set()
  let canvasContext = null
  let rafId = 0
  let pendingContainers = new Set()
  let fullRescanQueued = false

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const getCanvasContext = () => {
    if (canvasContext !== null) return canvasContext || null
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      canvasContext = canvas.getContext('2d') || false
    } catch (_) {
      canvasContext = false
    }
    return canvasContext || null
  }

  const parseHexColor = (hex) => {
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16)
      const g = parseInt(hex[1] + hex[1], 16)
      const b = parseInt(hex[2] + hex[2], 16)
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1
      return { r, g, b, a }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      return { r, g, b, a }
    }
    return null
  }

  const parseRgbChannel = (token) => {
    const trimmed = token.trim()
    if (trimmed.endsWith('%')) {
      const pct = Number.parseFloat(trimmed.slice(0, -1))
      return Number.isFinite(pct) ? clamp((pct / 100) * 255, 0, 255) : NaN
    }
    const num = Number.parseFloat(trimmed)
    return Number.isFinite(num) ? clamp(num, 0, 255) : NaN
  }

  const parseAlphaValue = (token) => {
    const trimmed = token.trim()
    if (trimmed.endsWith('%')) {
      const pct = Number.parseFloat(trimmed.slice(0, -1))
      return Number.isFinite(pct) ? clamp(pct / 100, 0, 1) : NaN
    }
    const num = Number.parseFloat(trimmed)
    return Number.isFinite(num) ? clamp(num, 0, 1) : NaN
  }

  const parseHueDegrees = (token) => {
    const trimmed = token.trim().toLowerCase()
    let deg
    if (trimmed.endsWith('deg')) deg = Number.parseFloat(trimmed.slice(0, -3))
    else if (trimmed.endsWith('rad')) deg = (Number.parseFloat(trimmed.slice(0, -3)) * 180) / Math.PI
    else if (trimmed.endsWith('grad')) deg = Number.parseFloat(trimmed.slice(0, -4)) * 0.9
    else if (trimmed.endsWith('turn')) deg = Number.parseFloat(trimmed.slice(0, -4)) * 360
    else deg = Number.parseFloat(trimmed)
    if (!Number.isFinite(deg)) return NaN
    return ((deg % 360) + 360) % 360
  }

  const hslToRgb = (h, s, l) => {
    const hue = ((h % 360) + 360) % 360
    const sat = clamp(s, 0, 1)
    const light = clamp(l, 0, 1)
    const c = (1 - Math.abs(2 * light - 1)) * sat
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    const m = light - c / 2
    let r1 = 0
    let g1 = 0
    let b1 = 0
    if (hue < 60) [r1, g1, b1] = [c, x, 0]
    else if (hue < 120) [r1, g1, b1] = [x, c, 0]
    else if (hue < 180) [r1, g1, b1] = [0, c, x]
    else if (hue < 240) [r1, g1, b1] = [0, x, c]
    else if (hue < 300) [r1, g1, b1] = [x, 0, c]
    else [r1, g1, b1] = [c, 0, x]
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    }
  }

  const rgbToHsl = (r, g, b) => {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const delta = max - min
    const l = (max + min) / 2
    let h = 0
    let s = 0
    if (delta > 0) {
      s = delta / (1 - Math.abs(2 * l - 1))
      if (max === rn) h = 60 * (((gn - bn) / delta) % 6)
      else if (max === gn) h = 60 * ((bn - rn) / delta + 2)
      else h = 60 * ((rn - gn) / delta + 4)
      if (h < 0) h += 360
    }
    return { h, s: clamp(s, 0, 1), l, chroma: delta }
  }

  const parseFunctionalColor = (lower) => {
    const rgbMatch = lower.match(/^rgba?\(([^)]+)\)$/)
    if (rgbMatch) {
      const inner = rgbMatch[1].trim()
      let channels
      let alphaToken = null
      if (inner.includes(',')) {
        const parts = inner.split(',')
        if (parts.length !== 3 && parts.length !== 4) return null
        channels = parts.slice(0, 3)
        alphaToken = parts[3] ?? null
      } else {
        const slashParts = inner.split('/')
        if (slashParts.length > 2) return null
        channels = slashParts[0].trim().split(/\s+/)
        if (channels.length !== 3) return null
        alphaToken = slashParts[1] ?? null
      }
      const r = parseRgbChannel(channels[0])
      const g = parseRgbChannel(channels[1])
      const b = parseRgbChannel(channels[2])
      const a = alphaToken !== null ? parseAlphaValue(alphaToken) : 1
      if (![r, g, b, a].every(Number.isFinite)) return null
      return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a }
    }

    const hslMatch = lower.match(/^hsla?\(([^)]+)\)$/)
    if (hslMatch) {
      const inner = hslMatch[1].trim()
      let channels
      let alphaToken = null
      if (inner.includes(',')) {
        const parts = inner.split(',')
        if (parts.length !== 3 && parts.length !== 4) return null
        channels = parts.slice(0, 3)
        alphaToken = parts[3] ?? null
      } else {
        const slashParts = inner.split('/')
        if (slashParts.length > 2) return null
        channels = slashParts[0].trim().split(/\s+/)
        if (channels.length !== 3) return null
        alphaToken = slashParts[1] ?? null
      }
      const h = parseHueDegrees(channels[0])
      const sPct = channels[1].trim()
      const lPct = channels[2].trim()
      if (!sPct.endsWith('%') || !lPct.endsWith('%')) return null
      const s = Number.parseFloat(sPct.slice(0, -1)) / 100
      const l = Number.parseFloat(lPct.slice(0, -1)) / 100
      const a = alphaToken !== null ? parseAlphaValue(alphaToken) : 1
      if (![h, s, l, a].every(Number.isFinite)) return null
      const rgb = hslToRgb(h, s, l)
      return { ...rgb, a }
    }

    return null
  }

  const parseColor = (raw, { allowBareHex = false } = {}) => {
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    const lower = trimmed.toLowerCase()
    if (
      lower === 'inherit' ||
      lower === 'initial' ||
      lower === 'unset' ||
      lower === 'revert' ||
      lower === 'revert-layer' ||
      lower === 'currentcolor' ||
      lower.startsWith('var(')
    ) {
      return null
    }
    if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

    if (lower.startsWith('#')) {
      const hex = lower.slice(1)
      if (/^[0-9a-f]+$/.test(hex)) {
        const parsed = parseHexColor(hex)
        if (parsed) return parsed
      }
    }

    if (allowBareHex && /^[0-9a-f]{3}([0-9a-f]{3})?$/.test(lower)) {
      const parsed = parseHexColor(lower)
      if (parsed) return parsed
    }

    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, lower)) {
      const [r, g, b] = NAMED_COLORS[lower]
      return { r, g, b, a: 1 }
    }

    const functional = parseFunctionalColor(lower)
    if (functional) return functional

    // Fall back to Canvas 2D color normalization for CSS Color 4 formats such as oklch().
    const ctx = getCanvasContext()
    if (ctx) {
      ctx.fillStyle = '#010203'
      ctx.fillStyle = trimmed
      const firstPass = ctx.fillStyle
      ctx.fillStyle = '#040506'
      ctx.fillStyle = trimmed
      const secondPass = ctx.fillStyle
      if (firstPass === secondPass && firstPass !== '#010203') {
        return parseColor(firstPass)
      }
    }
    return null
  }

  const formatColor = ({ r, g, b, a = 1 }) => {
    const rr = Math.round(clamp(r, 0, 255))
    const gg = Math.round(clamp(g, 0, 255))
    const bb = Math.round(clamp(b, 0, 255))
    if (a >= 0.999) return `rgb(${rr}, ${gg}, ${bb})`
    return `rgba(${rr}, ${gg}, ${bb}, ${Number(clamp(a, 0, 1).toFixed(3))})`
  }

  const relativeLuminance = ({ r, g, b }) => {
    const toLinear = (c) => {
      const srgb = clamp(c, 0, 255) / 255
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  }

  const contrastRatio = (c1, c2) => {
    const l1 = relativeLuminance(c1)
    const l2 = relativeLuminance(c2)
    const brighter = Math.max(l1, l2)
    const darker = Math.min(l1, l2)
    return (brighter + 0.05) / (darker + 0.05)
  }

  const compositeOver = (fg, bg) => {
    const a = clamp(fg.a ?? 1, 0, 1)
    if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 }
    if (a <= 0) return { r: bg.r, g: bg.g, b: bg.b, a: 1 }
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    }
  }

  const isDocumentDarkHint = () => {
    const root = document.documentElement
    const body = document.body
    const rootTheme = root?.getAttribute('data-theme')?.toLowerCase()
    const bodyTheme = body?.getAttribute('data-theme')?.toLowerCase()
    if (rootTheme === 'dark' || bodyTheme === 'dark') return true
    if (
      root?.classList?.contains('dark') ||
      root?.classList?.contains('theme-dark') ||
      body?.classList?.contains('dark') ||
      body?.classList?.contains('theme-dark')
    ) {
      return true
    }
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    return (rootTheme === 'auto' || bodyTheme === 'auto') && prefersDark
  }

  const getFallbackPageBg = () =>
    isDocumentDarkHint() ? { r: 39, g: 39, b: 39, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }

  const getEffectiveBackground = (element, bgCache) => {
    if (!element) return getFallbackPageBg()
    if (bgCache.has(element)) return bgCache.get(element)

    const chain = []
    let current = element
    while (current) {
      if (bgCache.has(current)) {
        chain.push({ cached: bgCache.get(current) })
        break
      }
      chain.push({ node: current })
      current = current.parentElement
    }

    let bg = chain[chain.length - 1]?.cached || getFallbackPageBg()
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i]
      if (!entry.node) continue
      let parsed = null
      try {
        const computedBg = window.getComputedStyle(entry.node)?.backgroundColor
        parsed = computedBg ? parseColor(computedBg) : null
      } catch (_) {
        parsed = null
      }
      if (parsed && parsed.a > 0) {
        bg = compositeOver(parsed, bg)
      }
      bgCache.set(entry.node, bg)
    }

    return bg
  }

  const adjustColorForBackground = (fg, bg) => {
    if (!fg || (fg.a ?? 1) <= 0.05) return null
    const bgLuminance = relativeLuminance(bg)
    if (bgLuminance >= DARK_BG_LUMINANCE_THRESHOLD) {
      return formatColor(fg)
    }

    const alpha = fg.a ?? 1
    const effectiveContrast = (candidateRgb) =>
      contrastRatio(compositeOver({ ...candidateRgb, a: alpha }, bg), bg)

    const { h, s, l, chroma } = rgbToHsl(fg.r, fg.g, fg.b)

    // Map dark neutral body text (#000000, #333333, #666666...) monotonically
    // onto dark-mode light grays so primary text stays crisp and muted notes stay dimmer.
    if (chroma <= NEUTRAL_CHROMA_THRESHOLD && l <= DARK_NEUTRAL_CUTOFF) {
      let targetLightness
      if (l <= 0.22) {
        targetLightness = 0.88 - (l / 0.22) * 0.03
      } else {
        targetLightness = 0.85 - ((l - 0.22) / (DARK_NEUTRAL_CUTOFF - 0.22)) * 0.2
      }
      let candidate = hslToRgb(h, s, targetLightness)
      if (effectiveContrast(candidate) >= TARGET_CONTRAST) {
        return formatColor({ ...candidate, a: alpha })
      }
      let low = targetLightness
      let high = 1.0
      for (let i = 0; i < 18; i++) {
        const mid = (low + high) / 2
        const probe = hslToRgb(h, s, mid)
        if (effectiveContrast(probe) >= TARGET_CONTRAST) high = mid
        else low = mid
      }
      candidate = hslToRgb(h, s, high)
      return formatColor({ ...candidate, a: alpha })
    }

    if (effectiveContrast(fg) >= TARGET_CONTRAST) {
      return formatColor(fg)
    }

    const minSat = hslToRgb(h, s, 0.98)
    const maxContrast = effectiveContrast(minSat)
    let low = l
    let high = maxContrast >= TARGET_CONTRAST ? 0.98 : 1.0
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2
      const probe = hslToRgb(h, s, mid)
      if (effectiveContrast(probe) >= TARGET_CONTRAST) high = mid
      else low = mid
    }
    const adjusted = hslToRgb(h, s, high)
    return formatColor({ ...adjusted, a: alpha })
  }

  const ensureStyleTag = () => {
    if (document.getElementById(STYLE_ID)) return
    const host = document.head || document.documentElement
    if (!host) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
:is(#BH-master, :root) ${ARTICLE_SELECTOR}[${DARK_ARTICLE_ATTR}="1"] :is(
  div, p, span, font, b, strong, i, em, u, s, strike, del, ins,
  small, big, sub, sup, h1, h2, h3, h4, h5, h6,
  ul, ol, li, dl, dt, dd, table, tbody, thead, tfoot, tr, th, td, caption, center
):not([class^="c-"]):not([class*=" c-"]) {
  color: inherit !important;
}
`
    host.appendChild(style)
  }

  const getOriginalColorInfo = (element) => {
    let snapshot = originalSnapshots.get(element)
    if (!snapshot) {
      snapshot = {
        styleColor: element.style.getPropertyValue('color'),
        stylePriority: element.style.getPropertyPriority('color'),
        attrColor: element.getAttribute('color') || '',
      }
      originalSnapshots.set(element, snapshot)
    }
    return snapshot
  }

  const restoreElementColor = (element) => {
    const snapshot = originalSnapshots.get(element)
    if (!snapshot) return
    if (snapshot.styleColor) {
      element.style.setProperty('color', snapshot.styleColor, snapshot.stylePriority)
    } else {
      element.style.removeProperty('color')
    }
  }

  const isInsideEditable = (element) => {
    let current = element
    while (current) {
      if (typeof current.getAttribute === 'function') {
        const editable = current.getAttribute('contenteditable')
        if (editable === '' || editable === 'true') return true
      }
      if (current.isContentEditable) return true
      current = current.parentElement
    }
    return false
  }

  const processArticle = (article, bgCache) => {
    if (!article || !article.isConnected || isInsideEditable(article)) return
    trackedContainers.add(article)

    const articleBg = getEffectiveBackground(article, bgCache)
    const isDark = relativeLuminance(articleBg) < DARK_BG_LUMINANCE_THRESHOLD

    const coloredNodes = article.querySelectorAll(COLORED_NODE_SELECTOR)

    if (!isDark) {
      if (article.getAttribute(DARK_ARTICLE_ATTR) === '1') {
        article.removeAttribute(DARK_ARTICLE_ATTR)
      }
      for (const node of coloredNodes) {
        restoreElementColor(node)
      }
      return
    }

    ensureStyleTag()

    const pendingWrites = []
    for (const node of coloredNodes) {
      if (isInsideEditable(node)) continue
      const snapshot = getOriginalColorInfo(node)
      const nodeBg = getEffectiveBackground(node, bgCache)
      let parsed = null
      if (snapshot.styleColor) {
        parsed = parseColor(snapshot.styleColor, { allowBareHex: false })
      } else if (snapshot.attrColor) {
        parsed = parseColor(snapshot.attrColor, { allowBareHex: true })
      } else if (relativeLuminance(nodeBg) >= DARK_BG_LUMINANCE_THRESHOLD) {
        pendingWrites.push([node, LIGHT_BG_TEXT_COLOR])
        continue
      }
      if (!parsed) continue

      const adjusted = adjustColorForBackground(parsed, nodeBg)
      if (!adjusted) continue

      pendingWrites.push([node, adjusted])
    }

    if (article.getAttribute(DARK_ARTICLE_ATTR) !== '1') {
      article.setAttribute(DARK_ARTICLE_ATTR, '1')
    }
    for (const [node, adjusted] of pendingWrites) {
      if (
        node.style.getPropertyValue('color') !== adjusted ||
        node.style.getPropertyPriority('color') !== 'important'
      ) {
        node.style.setProperty('color', adjusted, 'important')
      }
    }
  }

  const flushPendingWork = () => {
    rafId = 0
    const bgCache = new Map()
    if (fullRescanQueued) {
      fullRescanQueued = false
      pendingContainers.clear()
      for (const container of trackedContainers) {
        if (!container.isConnected) trackedContainers.delete(container)
      }
      const articles = document.querySelectorAll(ARTICLE_SELECTOR)
      for (const article of articles) {
        processArticle(article, bgCache)
      }
      return
    }

    const batch = Array.from(pendingContainers)
    pendingContainers.clear()
    for (const article of batch) {
      processArticle(article, bgCache)
    }
  }

  const scheduleFlush = () => {
    if (rafId) return
    if (typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(flushPendingWork)
    } else {
      rafId = setTimeout(flushPendingWork, 0)
    }
  }

  const queueFullRescan = () => {
    fullRescanQueued = true
    scheduleFlush()
  }

  const queueArticlesFromNode = (node) => {
    if (!node || node.nodeType !== 1) return
    if (typeof node.closest === 'function') {
      const parentArticle = node.closest(ARTICLE_SELECTOR)
      if (parentArticle) {
        pendingContainers.add(parentArticle)
        scheduleFlush()
        return
      }
    }
    if (typeof node.matches === 'function' && node.matches(ARTICLE_SELECTOR)) {
      pendingContainers.add(node)
      scheduleFlush()
      return
    }
    if (typeof node.querySelectorAll === 'function') {
      const nested = node.querySelectorAll(ARTICLE_SELECTOR)
      if (nested.length > 0) {
        for (const article of nested) pendingContainers.add(article)
        scheduleFlush()
      }
    }
  }

  const start = () => {
    const bgCache = new Map()
    const articles = document.querySelectorAll(ARTICLE_SELECTOR)
    for (const article of articles) {
      processArticle(article, bgCache)
    }

    if (typeof MutationObserver === 'function') {
      const domTarget = document.body || document.documentElement
      if (domTarget) {
        const domObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type !== 'childList') continue
            for (const added of mutation.addedNodes) {
              queueArticlesFromNode(added)
            }
          }
        })
        domObserver.observe(domTarget, { childList: true, subtree: true })
      }

      const themeObserver = new MutationObserver(() => {
        queueFullRescan()
      })
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'class', 'style'],
        })
      }
      if (document.body && document.body !== document.documentElement) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-theme', 'class', 'style'],
        })
      }
    }

    if (typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', queueFullRescan)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
