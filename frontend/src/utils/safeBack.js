/**
 * Unified back navigation for pages that may be opened directly, from a tab,
 * from a message, or after a browser refresh where the history stack is empty.
 */
import safeSwitchTab from './safeSwitchTab.js'

const TAB_PAGES = new Set([
  '/pages/home/home',
  '/pages/match/index',
  '/pages/message/center',
  '/pages/profile/profile'
])

export function normalizePageUrl(url) {
  const raw = String(url || '/pages/home/home').trim() || '/pages/home/home'
  return raw.startsWith('/') ? raw : `/${raw}`
}

export function pagePathOf(url) {
  return normalizePageUrl(url).split('?')[0].split('#')[0]
}

export function isTabPage(url) {
  return TAB_PAGES.has(pagePathOf(url))
}

export function hasBackStack() {
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (Array.isArray(pages) && pages.length > 1) return true
  } catch (e) { /* ignore */ }
  try {
    if (typeof window !== 'undefined' && window.history && window.history.length > 1) return true
  } catch (e) { /* ignore */ }
  return false
}

export function openFallback(url = '/pages/home/home') {
  const target = normalizePageUrl(url)
  if (isTabPage(target)) {
    safeSwitchTab(target)
    return
  }
  uni.redirectTo({
    url: target,
    fail: () => {
      uni.reLaunch({
        url: target,
        fail: () => safeSwitchTab('/pages/home/home')
      })
    }
  })
}

export function safeBack(options = {}) {
  const opts = typeof options === 'string' ? { fallback: options } : (options || {})
  const fallback = opts.fallback || '/pages/home/home'
  const delta = opts.delta || 1
  if (!opts.forceFallback && hasBackStack()) {
    uni.navigateBack({ delta, fail: () => openFallback(fallback) })
    return
  }
  openFallback(fallback)
}

export default safeBack
