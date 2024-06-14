// ==UserScript==
// @name         Youtube RealTime PlayBack
// @version      0.1.0
// @description  Youtube RealTime PlayBack
// @author       Derek
// @match        *://www.youtube.com/*
// @run-at       document-start
// @noframes
// ==/UserScript==

const isObject = (value) => value != null && typeof value === "object"

const {
  get: getter,
  set: setter,
} = Object.getOwnPropertyDescriptor(Object.prototype, "playerResponse") ?? {
  set(value) { this[Symbol.for("YoutubeOptimizer")] = value },
  get() { return this[Symbol.for("YoutubeOptimizer")] }
}

Object.defineProperty(Object.prototype, "playerResponse", {
  set(value) {
    if (isObject(value)) {
      const { videoDetails } = value
      if (isObject(videoDetails)) {
        videoDetails.isLiveDvrEnabled = true
      }
    }
    setter.call(this, value)
  },
  get() {
    return getter.call(this)
  },
  configurable: true,
})
