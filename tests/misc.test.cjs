const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repoRoot = path.resolve(__dirname, '..')
const readScript = file => fs.readFileSync(path.join(repoRoot, file), 'utf8')
const pixivSource = readScript('pixiv.user.js')

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
