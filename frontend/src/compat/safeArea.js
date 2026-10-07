const ZERO_SAFE_AREA = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })

export function readCssPixelValue(value) {
  const n = Number.parseFloat(String(value || '').replace('px', ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

export function normalizeSafeAreaInsets(insets = {}) {
  return {
    top: readCssPixelValue(insets.top),
    right: readCssPixelValue(insets.right),
    bottom: readCssPixelValue(insets.bottom),
    left: readCssPixelValue(insets.left)
  }
}

export function inferPlatform(userAgent = '') {
  const ua = String(userAgent || '')
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  return 'web'
}

export function buildWindowInfo({
  innerWidth = 375,
  innerHeight = 667,
  screenWidth,
  screenHeight,
  visualViewportHeight,
  userAgent = '',
  safeAreaInsets = ZERO_SAFE_AREA
} = {}) {
  const w = Math.round(Number(innerWidth) || 375)
  const h = Math.round(Number(visualViewportHeight || innerHeight) || 667)
  const sw = Math.round(Number(screenWidth || w) || w)
  const sh = Math.round(Number(screenHeight || h) || h)
  const safe = normalizeSafeAreaInsets(safeAreaInsets)
  return {
    uniPlatform: 'web',
    platform: inferPlatform(userAgent),
    screenWidth: sw,
    screenHeight: sh,
    windowWidth: w,
    windowHeight: h,
    statusBarHeight: safe.top,
    safeAreaInsets: safe,
    safeArea: {
      left: safe.left,
      right: Math.max(0, w - safe.right),
      top: safe.top,
      bottom: Math.max(0, h - safe.bottom),
      width: Math.max(0, w - safe.left - safe.right),
      height: Math.max(0, h - safe.top - safe.bottom)
    }
  }
}

export function resolveSafeAreaInsets(doc = globalThis.document) {
  if (!doc || !doc.body || typeof doc.createElement !== 'function') {
    return { ...ZERO_SAFE_AREA }
  }
  const envInsets = measureSafeAreaInsets(doc, 'env')
  if (hasAnyInset(envInsets)) return envInsets
  return measureSafeAreaInsets(doc, 'constant')
}

function hasAnyInset(insets) {
  return !!(insets.top || insets.right || insets.bottom || insets.left)
}

function measureSafeAreaInsets(doc, syntax) {
  const el = doc.createElement('div')
  const win = doc.defaultView || globalThis.window
  const fallback = syntax === 'env' ? ', 0px' : ''
  el.style.cssText = [
    'position:fixed',
    'visibility:hidden',
    'pointer-events:none',
    'z-index:-1',
    'left:0',
    'top:0',
    `padding-top:${syntax}(safe-area-inset-top${fallback})`,
    `padding-right:${syntax}(safe-area-inset-right${fallback})`,
    `padding-bottom:${syntax}(safe-area-inset-bottom${fallback})`,
    `padding-left:${syntax}(safe-area-inset-left${fallback})`
  ].join(';')
  doc.body.appendChild(el)
  try {
    const style = win && typeof win.getComputedStyle === 'function'
      ? win.getComputedStyle(el)
      : el.style
    return normalizeSafeAreaInsets({
      top: style.paddingTop,
      right: style.paddingRight,
      bottom: style.paddingBottom,
      left: style.paddingLeft
    })
  } finally {
    try { doc.body.removeChild(el) } catch (e) {}
  }
}
