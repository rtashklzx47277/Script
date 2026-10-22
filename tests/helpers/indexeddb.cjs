// Small asynchronous IndexedDB test double. Transactions execute in order,
// and requests added by onsuccess callbacks keep their transaction alive.
module.exports = () => {
  const records = new Map()
  let upgraded = false
  let tail = Promise.resolve()
  const factory = { records, failWrites: false }
  const key = value => JSON.stringify(value)
  const transaction = mode => {
    let active = false
    let ended = false
    let pending = 0
    let release
    const waiting = []
    const tx = {}
    const finish = () => {
      if (!ended && active && pending === 0) {
        ended = true
        tx.oncomplete?.()
        release()
      }
    }
    const request = (operation, existing) => {
      const result = existing || {}
      pending++
      const execute = () => queueMicrotask(() => {
        if (ended) return
        try {
          result.result = operation()
          result.onsuccess?.()
        } catch (error) {
          result.error = tx.error = error
          result.onerror?.()
          ended = true
          tx.onerror?.()
          release()
          return
        }
        pending--
        queueMicrotask(finish)
      })
      if (active) execute()
      else waiting.push(execute)
      return result
    }
    const store = {
      get: id => request(() => structuredClone(records.get(key(id)))),
      put(value) {
        const snapshot = structuredClone(value)
        return request(() => {
          if (mode !== 'readwrite' || factory.failWrites) throw new Error('QuotaExceededError')
          records.set(key([snapshot.scope, snapshot.storageId]), snapshot)
        })
      },
      index(name) {
        return {
          getAll: scope => request(() => [...records.values()].filter(record => record[name] === scope).map(record => structuredClone(record))),
          openCursor() {
            const result = {}
            let values
            let index = 0
            const next = () => request(() => {
              values ||= [...records.values()].sort((a, b) => a[name] - b[name])
              const value = values[index++]
              return value ? { value: structuredClone(value),
                delete: () => request(() => records.delete(key([value.scope, value.storageId]))),
                continue: next } : null
            }, result)
            return next()
          },
        }
      },
    }
    tx.objectStore = () => store
    tail = tail.then(() => new Promise(resolve => {
      release = resolve
      active = true
      for (const execute of waiting) execute()
      queueMicrotask(finish)
    }))
    return tx
  }
  const database = {
    createObjectStore: () => ({ createIndex() {} }), transaction: (_, mode) => transaction(mode), close() {},
  }
  factory.open = () => {
    const request = {}
    queueMicrotask(() => {
      request.result = database
      if (!upgraded) { upgraded = true; request.onupgradeneeded?.() }
      request.onsuccess?.()
    })
    return request
  }
  return factory
}
