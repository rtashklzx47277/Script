// Run the same behavioral/performance contracts against both standalone scripts.
module.exports = ({ test, assert, boot, site }) => {
  const setup = () => {
    const env = boot()
    const youtube = site === 'YouTube'
    const history = env.api.getHistory(youtube ? 'channel:@host' : 'sample_channel')
    const make = (text, id = text) => env.message(youtube ? '@mod' : 'mod', text, youtube ? 'moderator' : 'Moderator', id)
    const state = { history, list: new env.Element(), empty: {}, count: {}, latest: {} }
    history.enabled = true
    env.api.setMounted(state)
    return { ...env, history, state, make }
  }

  test(`${site} updates: append and edit without walking unchanged history`, () => {
    const env = setup()
    const first = env.make('first')
    env.api.captureLine(first.line, env.history)
    for (let i = 0; i < 100; i++) env.api.captureLine(env.make(`old-${i}`).line, env.history)
    env.api.renderMessages(env.state)
    const oldView = env.state.list.firstChild
    env.history.follow = false
    env.state.list.scrollTop = 37
    // An incoming batch must not walk the history array again.
    env.history.messages[Symbol.iterator] = () => { throw Error('unexpected full history scan') }
    first.body.innerHTML = 'edited'
    first.body.textContent = 'edited'
    env.api.captureLine(first.line, env.history)
    const next = env.make('new')
    env.api.captureLine(next.line, env.history)
    assert.equal(env.state.list.firstChild, oldView, 'collection must not mutate the live list')
    env.api.scheduleMessageRender(env.state)
    env.api.scheduleMessageRender(env.state)
    assert.equal(env.frames.size, 1)
    env.flushFrames()
    assert.equal(env.state.count.textContent, '102 則')
    assert.notEqual(env.state.list.firstChild, oldView)
    assert.equal(env.state.list.firstChild.children.at(-1).textContent, 'edited')
    assert.equal(env.state.list.children.at(-1).children.at(-1).textContent, 'new')
    assert.equal(env.state.list.scrollTop, 37)
    delete env.history.messages[Symbol.iterator]
  })

  test(`${site} updates: deduplicate overlapping mutation records for the same native message`, () => {
    const env = setup()
    const message = env.make('hello')
    env.api.captureLine(message.line, env.history)
    let reads = 0
    Object.defineProperty(message.body, 'innerHTML', { get() { reads++; return 'hello' } })
    env.api.captureLine(message.line, env.history)
    const onePass = reads
    reads = 0
    const wrapper = new env.Element()
    wrapper.appendChild(message.line)
    assert.equal(env.api.captureMutations([
      { target: wrapper, addedNodes: [message.line] },
      { target: message.line, addedNodes: [message.body] },
      { target: { nodeType: 3, parentElement: message.body }, addedNodes: [] },
    ], env.history), false)
    assert.ok(onePass > 0)
    assert.equal(reads, onePass)
    assert.equal(env.history.messages.length, 1)
  })

  test(`${site} updates: keep collecting while hidden, flush once when visible, and cancel stale frames`, () => {
    const env = setup()
    env.api.renderMessages(env.state)
    const initial = env.make('before hiding')
    env.api.captureLine(initial.line, env.history)
    env.api.scheduleMessageRender(env.state)
    env.document.hidden = true
    env.api.handleMessageVisibility()
    assert.equal(env.frames.size, 0)
    const message = env.make('background message')
    env.api.captureMutations([{ target: message.line, addedNodes: [message.body] }], env.history)
    env.api.scheduleMessageRender(env.state)
    message.body.textContent = 'native node reused after capture'
    assert.equal(env.history.messages.length, 2)
    assert.equal(env.frames.size, 0)
    assert.equal(env.state.list.children.length, 0)
    env.document.hidden = false
    env.api.handleMessageVisibility()
    assert.equal(env.frames.size, 1)
    env.flushFrames()
    assert.equal(env.state.count.textContent, '2 則')
    assert.equal(env.state.list.children.at(-1).children.at(-1).textContent, 'background message')
    env.api.captureLine(env.make('queued at unmount').line, env.history)
    env.api.scheduleMessageRender(env.state)
    const stale = [...env.frames.values()][0]
    env.api.releaseMessageViews(env.state)
    env.api.setMounted(null)
    assert.equal(env.frames.size, 0)
    stale()
    assert.equal(env.state.list.children.length, 0)
  })

  test(`${site} updates: incremental eviction keeps counts correct and settings changes restore excluded history`, () => {
    const env = setup()
    for (let i = 0; i < 2000; i++) env.api.captureLine(env.make(`old-${i}`).line, env.history)
    env.api.renderMessages(env.state)
    const oldest = env.history.messages[0]
    for (let i = 0; i < 3; i++) env.api.captureLine(env.make(`new-${i}`).line, env.history)
    assert.equal(oldest.retained, false)
    assert.equal(env.state.list.children.length, 2000)
    env.api.renderMessages(env.state)
    assert.equal(env.state.list.children.length, 2000)
    assert.equal(env.state.count.textContent, '2000 則')
    assert.equal(env.history.dirty.size, 0)
    assert.equal(env.history.removed.size, 0)
    env.history.settings.excludedUsers = [site === 'YouTube' ? '@mod' : 'mod']
    env.api.renderMessages(env.state)
    assert.equal(env.state.count.textContent, '0 則')
    assert.equal(env.state.empty.hidden, false)
    env.history.settings.excludedUsers = []
    env.api.renderMessages(env.state)
    assert.equal(env.state.count.textContent, '2000 則')
    assert.equal(env.state.list.children.length, 2000)
  })

  test(`${site} updates: bounded queues retain the latest history while disabled or hidden`, () => {
    const env = setup()
    env.history.enabled = false
    for (let i = 0; i < 2005; i++) {
      env.api.captureLine(env.make(String(i)).line, env.history)
      env.api.scheduleMessageRender(env.state)
    }
    assert.equal(env.frames.size, 0)
    assert.equal(env.history.messages.length, 2000)
    assert.equal(env.history.dirty.size, 2000)
    assert.equal(env.history.removed.size, 0)
    assert.equal(env.state.list.children.length, 0)
    env.history.enabled = true
    env.api.renderMessages(env.state, true)
    assert.equal(env.state.list.firstChild.children.at(-1).textContent, '5')
    assert.equal(env.state.count.textContent, '2000 則')
    env.document.hidden = true
    for (let i = 0; i < 2005; i++) {
      env.api.captureLine(env.make(`background-${i}`).line, env.history)
      env.api.scheduleMessageRender(env.state)
    }
    assert.equal(env.frames.size, 0)
    assert.equal(env.history.dirty.size, 2000)
    assert.equal(env.history.removed.size, 2000)
    env.document.hidden = false
    env.api.handleMessageVisibility()
    env.flushFrames()
    assert.equal(env.history.removed.size, 0)
    assert.equal(env.state.list.children.length, 2000)
    assert.equal(env.state.list.firstChild.children.at(-1).textContent, 'background-5')
    assert.equal(env.state.count.textContent, '2000 則')
  })
}
