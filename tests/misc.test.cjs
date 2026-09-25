const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repoRoot = path.resolve(__dirname, '..')
const readScript = file => fs.readFileSync(path.join(repoRoot, file), 'utf8')
const hasScript = file => fs.existsSync(path.join(repoRoot, file))
const pixivSource = readScript('pixiv.user.js')
const pawFile = 'Other/pawOptimizer.js'

function jump(search, hash = '') {
  const location = { search, hash, href: 'unchanged' }
  vm.runInNewContext(pixivSource, { window: { location } })
  return location.href
}

const jumpCases = [
  ['raw HTTPS', '?https://example.test/page', '', 'https://example.test/page'],
  ['raw query encoding', '?https://example.test/?a=x%26y&b=z', '', 'https://example.test/?a=x%26y&b=z'],
  ['raw fragment', '?https://example.test/page', '#section', 'https://example.test/page#section'],
  ['raw encoded hash', '?https://example.test/x%23a', '#b', 'https://example.test/x%23a#b'],
  ['fully encoded URL', '?https%3A%2F%2Fexample.test%2Fp%3Fq%3Da%2526b%23z', '', 'https://example.test/p?q=a%26b#z'],
  ['encoded fragment takes precedence', '?https%3A%2F%2Fexample.test%2Fp%23inner', '#outer', 'https://example.test/p#inner'],
  ['encoded URL with external fragment', '?https%3A%2F%2Fexample.test%2Fp', '#outer', 'https://example.test/p#outer'],
  ['HTTP', '?http://example.test', '', 'http://example.test'],
  ['uppercase scheme', '?HTTPS://example.test', '', 'HTTPS://example.test'],
  ['JavaScript scheme rejected', '?javascript:alert(1)', '', 'unchanged'],
  ['encoded JavaScript scheme rejected', '?javascript%3Aalert%281%29', '', 'unchanged'],
  ['data scheme rejected', '?data:text/html,hi', '', 'unchanged'],
  ['file scheme rejected', '?file:///c:/file', '', 'unchanged'],
  ['protocol relative URL rejected', '?//example.test', '', 'unchanged'],
  ['malformed encoding rejected', '?https%3A%2F%2Fexample%ZZ', '', 'unchanged'],
  ['empty target rejected', '', '#something', 'unchanged'],
]

for (const [name, search, hash, expected] of jumpCases) {
  test(`Pixiv: ${name}`, () => assert.equal(jump(search, hash), expected))
}

// A small DOM fixture for the selectors and events used by these scripts.
// Mutation delivery is explicit, allowing replacement timing to be tested.
class Element {
  constructor(tag = 'div', classes = '') {
    this.tag = tag
    this.classes = classes.split(' ')
    this.children = []
    this.parent = null
    this.dataset = {}
    this.attrs = {}
    this.events = {}
    this.src = ''
    this.href = ''
    this.isContentEditable = false
    this.focused = false
    this.appendCalls = 0
  }

  appendChild(node) {
    this.appendCalls++
    if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
    this.children.push(node)
    node.parent = this
    return node
  }

  get innerHTML() { return '' }
  set innerHTML(value) {
    this.children.forEach(child => { child.parent = null })
    this.children = []
  }

  matches(selector) {
    if (selector === 'input, textarea, select, [role="textbox"]') {
      return ['input', 'textarea', 'select'].includes(this.tag) || this.attrs.role === 'textbox'
    }
    if (selector === '.post__thumbnail') return this.classes.includes('post__thumbnail')
    if (selector === '.post__thumbnail a.fileThumb') {
      return this.tag === 'a' && this.classes.includes('fileThumb') && !!this.parent?.closest('.post__thumbnail')
    }
    if (selector === 'aside ul') return this.tag === 'ul' && !!this.parent?.closest('aside')
    return this.tag === selector
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (node.matches(selector)) return node
    }
    return null
  }

  contains(node) {
    for (; node; node = node.parent) {
      if (node === this) return true
    }
    return false
  }

  querySelectorAll(selector) {
    const found = []
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  getElementsByTagName(tag) { return this.querySelectorAll(tag) }
  getAttribute(name) { return this.attrs[name] ?? null }
  setAttribute(name, value) { this.attrs[name] = value }
  removeAttribute(name) { delete this.attrs[name] }
  addEventListener(type, handler) { (this.events[type] ??= new Set()).add(handler) }
  removeEventListener(type, handler) { this.events[type]?.delete(handler) }
  dispatch(type, event = {}) {
    for (const handler of this.events[type] || []) handler(event)
  }
  focus() { this.focused = true }
  scrollIntoView() {}
}

function pawEnvironment(url = 'https://pawchive.st/post/1', setup = () => {}) {
  const document = new Element('document')
  const observers = []
  const timers = []
  setup(document)
  const location = { href: url }
  const window = new Element('window')
  const calls = []
  const history = {}
  for (const method of ['pushState', 'replaceState']) {
    history[method] = function (...args) {
      calls.push([method, this, args])
      if (args[2]) location.href = new URL(args[2], location.href).href
      return 'native'
    }
  }
  class MutationObserver {
    constructor(handler) {
      this.handler = handler
      this.active = false
      observers.push(this)
    }
    observe() { this.active = true }
    disconnect() { this.active = false }
  }
  vm.runInNewContext(readScript(pawFile), {
    document, window, location, history, HTMLElement: Element, MutationObserver,
    GM_addStyle() {},
    setTimeout(handler) { timers.push(handler); return timers.length },
    clearTimeout(id) { timers[id - 1] = () => {} },
  })
  return {
    document, observers, timers, location, history, window, calls,
    mutate(nodes, target = nodes[0]?.parent || document) {
      for (const observer of observers.filter(item => item.active)) {
        observer.handler([{ type: 'childList', target, addedNodes: nodes, removedNodes: [] }])
      }
    },
    key(key = 'ArrowDown', target = document) {
      let prevented = false
      document.dispatch('keydown', { key, target, preventDefault() { prevented = true } })
      return prevented
    },
  }
}

function photo(parent, id) {
  const thumbnail = parent.appendChild(new Element('div', 'post__thumbnail'))
  const anchor = thumbnail.appendChild(new Element('a', 'fileThumb'))
  anchor.href = `https://files.test/${id}.jpg?f=name.jpg`
  const image = anchor.appendChild(new Element('img'))
  image.src = `https://files.test/thumb-${id}.jpg`
  image.attrs['data-src'] = image.src
  return { thumbnail, anchor, image }
}

function sidebar(parent, ids) {
  const aside = parent.appendChild(new Element('aside'))
  const list = aside.appendChild(new Element('ul'))
  for (const id of ids) {
    const item = list.appendChild(new Element('li'))
    const anchor = item.appendChild(new Element('a'))
    anchor.attrs.href = id
  }
  return { aside, list }
}

const listOrder = list => list.children.map(item => item.querySelector('a').getAttribute('href')).join(',')
const pawTest = (name, run) => test(`PAW: ${name}`, { skip: !hasScript(pawFile) }, run)

pawTest('initial image upgrades once and removes lazy source', () => {
  let item
  const env = pawEnvironment(undefined, document => { item = photo(document, 'a') })
  assert.equal(item.image.src, 'https://files.test/a.jpg')
  assert.equal(item.image.getAttribute('data-src'), null)
  env.mutate([item.image])
  assert.equal(item.image.events.error.size, 1)
})

for (const addedRoot of ['thumbnail', 'anchor', 'image']) {
  pawTest(`new ${addedRoot} upgrades its image`, () => {
    const env = pawEnvironment()
    const item = photo(env.document, addedRoot)
    env.mutate([item[addedRoot]])
    assert.equal(item.image.src, `https://files.test/${addedRoot}.jpg`)
  })
}

pawTest('nested wrapper upgrades images and text nodes are harmless', () => {
  const env = pawEnvironment()
  const wrapper = env.document.appendChild(new Element())
  const item = photo(wrapper, 'wrapped')
  env.mutate([wrapper, {}])
  assert.equal(item.image.src, 'https://files.test/wrapped.jpg')
})

pawTest('two failed retries fall back to thumbnail without retrying forever', () => {
  let item
  const env = pawEnvironment(undefined, document => { item = photo(document, 'retry') })
  for (let attempt = 1; attempt <= 2; attempt++) {
    item.image.dispatch('error')
    env.timers.shift()()
    assert.equal(item.image.src, `https://files.test/retry.jpg?retry=${attempt}`)
  }
  item.image.dispatch('error')
  assert.equal(item.image.src, 'https://files.test/thumb-retry.jpg')
  item.image.dispatch('error')
  assert.equal(env.timers.length, 0)
})

pawTest('editable key targets retain native keyboard behavior', () => {
  let item
  const env = pawEnvironment(undefined, document => { item = photo(document, 'keys') })
  assert.equal(env.key('ArrowDown', new Element('input')), false)
  assert.equal(item.thumbnail.focused, false)
  assert.equal(env.key(), true)
  assert.equal(item.thumbnail.focused, true)
})

pawTest('history hooks preserve native calls and clear old observers and listeners', () => {
  const env = pawEnvironment(undefined, document => photo(document, 'route'))
  const firstObserver = env.observers[0]
  assert.equal(env.history.pushState({}, '', '/post/2'), 'native')
  assert.equal(firstObserver.active, false)
  assert.equal(env.document.events.keydown.size, 1)
  assert.equal(env.history.replaceState({}, '', '/post/3'), 'native')
  assert.equal(env.document.events.keydown.size, 1)
  assert.equal(env.calls.length, 2)
  assert.equal(env.calls[0][1], env.history)
  env.history.pushState({}, '', '/other')
  assert.equal(env.document.events.keydown.size, 0)
  assert.equal(env.observers.filter(observer => observer.active).length, 0)
  env.location.href = 'https://pawchive.st/post/4'
  env.window.dispatch('popstate')
  assert.equal(env.document.events.keydown.size, 1)
})

pawTest('initial and delayed sidebar entries are sorted', () => {
  let initial
  pawEnvironment('https://pawchive.st/discord', document => { initial = sidebar(document, ['a', 'c', 'b']) })
  assert.equal(listOrder(initial.list), 'c,b,a')
  const env = pawEnvironment('https://pawchive.st/discord')
  const delayed = sidebar(env.document, ['b', 'a', 'c'])
  env.mutate([delayed.aside])
  assert.equal(listOrder(delayed.list), 'c,b,a')
})

pawTest('keyboard navigation tolerates a shrinking thumbnail collection', () => {
  const items = []
  const env = pawEnvironment(undefined, document => {
    for (let index = 0; index < 3; index++) items.push(photo(document, index))
  })
  env.key()
  env.key()
  env.key()
  env.document.innerHTML = ''
  env.document.appendChild(items[0].thumbnail)
  items[0].thumbnail.focused = false
  assert.doesNotThrow(() => env.key())
  assert.equal(items[0].thumbnail.focused, true)
})

pawTest('sidebar replaced after history navigation is sorted', () => {
  const env = pawEnvironment('https://pawchive.st/discord/1', document => sidebar(document, ['a', 'c', 'b']))
  env.history.pushState({}, '', '/discord/2')
  env.document.innerHTML = ''
  const replacement = sidebar(env.document, ['a', 'c', 'b'])
  env.mutate([replacement.aside])
  assert.equal(listOrder(replacement.list), 'c,b,a')
})

pawTest('an empty thumbnail collection keeps native keys and resets selection', () => {
  const env = pawEnvironment(undefined, document => {
    photo(document, 'a')
    photo(document, 'b')
  })
  env.key()
  env.key()
  env.document.innerHTML = ''
  assert.equal(env.key(), false)
  const first = photo(env.document, 'c')
  photo(env.document, 'd')
  env.key()
  assert.equal(first.thumbnail.focused, true)
})

pawTest('later sidebar batches are sorted and observer feedback does not rewrite the list', () => {
  let initial
  const env = pawEnvironment('https://pawchive.st/discord', document => {
    initial = sidebar(document, ['a', 'c'])
  })
  const item = initial.list.appendChild(new Element('li'))
  item.appendChild(new Element('a')).attrs.href = 'b'
  env.mutate([item])
  assert.equal(listOrder(initial.list), 'c,b,a')
  const appendCalls = initial.list.appendCalls
  env.mutate([...initial.list.children], initial.list)
  assert.equal(initial.list.appendCalls, appendCalls)
  const unrelated = env.document.appendChild(new Element())
  env.mutate([unrelated])
  assert.equal(initial.list.appendCalls, appendCalls)
  env.history.pushState({}, '', '/other')
  assert.equal(env.observers.filter(observer => observer.active).length, 0)
})

pawTest('sidebar sorting preserves nested entries and other child nodes', () => {
  let initial
  let nested
  let decoration
  pawEnvironment('https://pawchive.st/discord', document => {
    initial = sidebar(document, ['a', 'c', 'b'])
    const nestedList = initial.list.children[0].appendChild(new Element('ul'))
    nested = nestedList.appendChild(new Element('li'))
    nested.appendChild(new Element('a')).attrs.href = 'nested'
    decoration = initial.list.appendChild(new Element('span'))
  })
  assert.equal(initial.list.children.length, 4)
  assert.equal(nested.parent.tag, 'ul')
  assert.notEqual(nested.parent, initial.list)
  assert.equal(decoration.parent, initial.list)
  assert.equal(initial.list.children.filter(item => item.matches('li')).map(item => item.querySelector('a').attrs.href).join(','), 'c,b,a')
})

test('NHT: injects blacklist hiding style', { skip: !hasScript('Other/nhtOptimizer.js') }, () => {
  const styles = []
  vm.runInNewContext(readScript('Other/nhtOptimizer.js'), { GM_addStyle: css => styles.push(css) })
  assert.equal(styles.length, 1)
  assert.match(styles[0], /\.blacklisted\s*\{\s*display:\s*none\s*!important/)
})

test('EXHT: injects layout styles and ArrowDown opens gallery', { skip: !hasScript('Other/exhtOptimizer.js') }, () => {
  const styles = []
  let keyHandler
  let clicks = 0
  vm.runInNewContext(readScript('Other/exhtOptimizer.js'), {
    GM_addStyle: css => styles.push(css),
    document: {
      addEventListener(type, handler) { assert.equal(type, 'keydown'); keyHandler = handler },
      querySelector(selector) { assert.equal(selector, '#i5 a'); return { click() { clicks++ } } },
    },
  })
  keyHandler({ key: 'ArrowUp' })
  assert.equal(clicks, 0)
  keyHandler({ key: 'ArrowDown' })
  assert.equal(clicks, 1)
  assert.equal(styles.length, 1)
  assert.match(styles[0], /#i3 img/)
})
