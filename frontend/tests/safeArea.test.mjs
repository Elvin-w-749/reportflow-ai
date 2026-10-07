import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWindowInfo,
  inferPlatform,
  normalizeSafeAreaInsets,
  readCssPixelValue,
  resolveSafeAreaInsets
} from '../src/compat/safeArea.js'

describe('safeArea compat helpers', () => {
  it('normalizes CSS pixel values into non-negative integers', () => {
    assert.equal(readCssPixelValue('34px'), 34)
    assert.equal(readCssPixelValue('20.6px'), 21)
    assert.equal(readCssPixelValue('-2px'), 0)
    assert.equal(readCssPixelValue('env(safe-area-inset-top)'), 0)
    assert.deepEqual(normalizeSafeAreaInsets({ top: '44px', right: 0, bottom: '34.4px' }), {
      top: 44,
      right: 0,
      bottom: 34,
      left: 0
    })
  })

  it('infers the expected mobile platform from user agents', () => {
    assert.equal(inferPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios')
    assert.equal(inferPlatform('Mozilla/5.0 (Linux; Android 15; Pixel)'), 'android')
    assert.equal(inferPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'web')
  })

  it('builds window information with visual viewport and safe area dimensions', () => {
    const info = buildWindowInfo({
      innerWidth: 390,
      innerHeight: 844,
      visualViewportHeight: 760,
      screenWidth: 390,
      screenHeight: 844,
      userAgent: 'iPhone',
      safeAreaInsets: { top: '47px', bottom: '34px', left: 0, right: 0 }
    })

    assert.equal(info.platform, 'ios')
    assert.equal(info.windowHeight, 760)
    assert.equal(info.statusBarHeight, 47)
    assert.deepEqual(info.safeAreaInsets, { top: 47, right: 0, bottom: 34, left: 0 })
    assert.deepEqual(info.safeArea, {
      left: 0,
      right: 390,
      top: 47,
      bottom: 726,
      width: 390,
      height: 679
    })
  })

  it('resolves env safe-area values from a DOM probe', () => {
    const doc = createProbeDocument((cssText) => {
      if (cssText.includes('env(')) {
        return { paddingTop: '44px', paddingRight: '0px', paddingBottom: '34px', paddingLeft: '0px' }
      }
      return { paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' }
    })

    assert.deepEqual(resolveSafeAreaInsets(doc), { top: 44, right: 0, bottom: 34, left: 0 })
    assert.equal(doc.appendCount, 1)
    assert.equal(doc.removeCount, 1)
  })

  it('falls back to legacy constant safe-area syntax when env is empty', () => {
    const doc = createProbeDocument((cssText) => {
      if (cssText.includes('constant(')) {
        return { paddingTop: '20px', paddingRight: '0px', paddingBottom: '21px', paddingLeft: '0px' }
      }
      return { paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' }
    })

    assert.deepEqual(resolveSafeAreaInsets(doc), { top: 20, right: 0, bottom: 21, left: 0 })
    assert.equal(doc.appendCount, 2)
    assert.equal(doc.removeCount, 2)
  })
})

function createProbeDocument(resolveStyle) {
  const doc = {
    appendCount: 0,
    removeCount: 0,
    body: {
      appendChild(el) { doc.appendCount += 1; doc.current = el },
      removeChild(el) { doc.removeCount += 1; if (doc.current === el) doc.current = null }
    },
    defaultView: {
      getComputedStyle(el) { return resolveStyle(el.style.cssText || '') }
    },
    createElement() { return { style: { cssText: '' } } }
  }
  return doc
}
