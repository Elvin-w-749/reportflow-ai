import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { hasBackStack, isTabPage, normalizePageUrl, pagePathOf, safeBack } from '../src/utils/safeBack.js'

afterEach(() => {
  delete globalThis.uni
  delete globalThis.getCurrentPages
  delete globalThis.window
})

describe('safeBack navigation helper', () => {
  test('normalizes page urls and detects tab pages', () => {
    assert.equal(normalizePageUrl('pages/home/home'), '/pages/home/home')
    assert.equal(pagePathOf('/pages/report/detail?id=1'), '/pages/report/detail')
    assert.equal(isTabPage('/pages/profile/profile'), true)
    assert.equal(isTabPage('/pages/report/detail'), false)
  })

  test('uses browser-compatible navigateBack when a page stack exists', () => {
    const calls = []
    globalThis.getCurrentPages = () => [{ route: 'home' }, { route: 'detail' }]
    globalThis.uni = {
      navigateBack: ({ delta }) => calls.push(['navigateBack', delta])
    }

    assert.equal(hasBackStack(), true)
    safeBack('/pages/home/home')
    assert.deepEqual(calls, [['navigateBack', 1]])
  })

  test('falls back to tab switching when there is no back stack', () => {
    const calls = []
    globalThis.getCurrentPages = () => []
    globalThis.window = { history: { length: 1 } }
    globalThis.uni = {
      switchTab: ({ url }) => calls.push(['switchTab', url])
    }

    safeBack('/pages/profile/profile')
    assert.deepEqual(calls, [['switchTab', '/pages/profile/profile']])
  })

  test('falls back to redirect for non-tab pages', () => {
    const calls = []
    globalThis.getCurrentPages = () => []
    globalThis.window = { history: { length: 1 } }
    globalThis.uni = {
      redirectTo: ({ url }) => calls.push(['redirectTo', url]),
      reLaunch: ({ url }) => calls.push(['reLaunch', url]),
      switchTab: ({ url }) => calls.push(['switchTab', url])
    }

    safeBack('/pages/login/index')
    assert.deepEqual(calls, [['redirectTo', '/pages/login/index']])
  })
})
