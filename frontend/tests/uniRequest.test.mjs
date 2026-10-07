import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installUni } from '../src/compat/uni.js'

const withFakeXhr = (run) => {
  const previous = globalThis.XMLHttpRequest
  const calls = []
  class FakeXmlHttpRequest {
    open(method, url, async) {
      this.method = method
      this.url = url
      this.async = async
      calls.push(this)
    }
    setRequestHeader() {}
    send(body) { this.body = body }
  }
  globalThis.XMLHttpRequest = FakeXmlHttpRequest
  try {
    run(installUni(), calls)
  } finally {
    if (previous === undefined) delete globalThis.XMLHttpRequest
    else globalThis.XMLHttpRequest = previous
  }
}

describe('uni request web compat', () => {
  it('serializes GET data into the request URL without losing existing query or hash', () => {
    withFakeXhr((uni, calls) => {
      uni.request({
        url: '/api/profile/debt-summary?source=legacy#result',
        method: 'GET',
        data: {
          reportId: 'local report/A',
          tag: ['first', 'second'],
          ignored: null
        }
      })

      assert.equal(calls.length, 1)
      assert.equal(
        calls[0].url,
        '/api/profile/debt-summary?source=legacy&reportId=local%20report%2FA&tag=first&tag=second#result'
      )
      assert.equal(calls[0].body, null)
    })
  })

  it('keeps non-GET data in the JSON request body', () => {
    withFakeXhr((uni, calls) => {
      uni.request({
        url: '/api/profile/debt-execution-record',
        method: 'POST',
        data: { reportId: 'report-a' }
      })

      assert.equal(calls[0].url, '/api/profile/debt-execution-record')
      assert.equal(calls[0].body, JSON.stringify({ reportId: 'report-a' }))
    })
  })
})
