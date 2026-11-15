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
  vm.runInNewContext(pixivSource, { window: { location }, URL })
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
  ['empty authority rejected', '?https://', '', 'unchanged'],
  ['missing hostname rejected', '?https://:8080', '', 'unchanged'],
  ['control character rejected', '?https://example.test/\n', '', 'unchanged'],
  ['malformed encoding rejected', '?https%3A%2F%2Fexample%ZZ', '', 'unchanged'],
  ['empty target rejected', '', '#something', 'unchanged'],
]

for (const [name, search, hash, expected] of jumpCases) {
  test(`Pixiv: ${name}`, () => assert.equal(jump(search, hash), expected))
}

test('Pixiv: prefers location.replace when available', () => {
  let replaced = 'unchanged'
  const location = {
    search: '?https://example.test/page',
    hash: '',
    href: 'unchanged',
    replace(next) { replaced = next },
  }
  vm.runInNewContext(pixivSource, { window: { location }, URL })
  assert.equal(replaced, 'https://example.test/page')
  assert.equal(location.href, 'unchanged')
})

function collectRepoTextFiles(dir = repoRoot) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'Script-Private' || entry.name === 'node_modules') continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...collectRepoTextFiles(fullPath))
    else if (/\.(js|cjs|html|md)$|^\.(gitattributes|gitignore)$/.test(entry.name)) results.push(fullPath)
  }
  return results
}

test('Repo hygiene: userscripts declare @namespace, no ponytail comments remain, README matches behavior, and files use LF', () => {
  const files = collectRepoTextFiles()
  const userscripts = files.filter(file => file.endsWith('.user.js'))
  assert.ok(userscripts.length >= 10)
  for (const script of userscripts) {
    const content = fs.readFileSync(script, 'utf8')
    assert.match(content, /^\/\/ @namespace\s+https:\/\/tampermonkey\.net\/$/m, path.basename(script))
  }

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    assert.equal(content.includes('\r\n'), false, `expected LF-only line endings in ${path.relative(repoRoot, file)}`)
    if (file.endsWith('.user.js') || file.endsWith('.cjs') || file.endsWith('.html')) {
      assert.equal(content.includes('pony' + 'tail:'), false, `unexpected comment tag in ${path.relative(repoRoot, file)}`)
    }
  }

  const readme = readScript('README.md')
  assert.equal(readme.includes('超級貼圖' + '尚未納入紀錄'), false)
})
