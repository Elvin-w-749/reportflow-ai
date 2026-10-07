/**
 * 旧版 Web 页面生命周期：把历史页面钩子映射到 Vue 3 与 Vue Router。
 *
 * 当前未启用 keep-alive，路由切换时页面重新挂载，因此
 * onShow ≈ onLoad ≈ onMounted；onHide ≈ onUnmounted。
 */
import { onMounted, onActivated, onUnmounted, onDeactivated } from 'vue'
import { useRoute } from 'vue-router'

export function onLoad(cb) {
  onMounted(() => {
    let query = {}
    try { query = { ...(useRoute().query || {}) } } catch (e) {}
    cb && cb(query)
  })
}

export function onShow(cb) {
  onMounted(() => { cb && cb() })
  try { onActivated(() => { cb && cb() }) } catch (e) {}
  if (typeof document !== 'undefined') {
    const handler = () => { if (!document.hidden) cb && cb() }
    document.addEventListener('visibilitychange', handler)
    try {
      onUnmounted(() => document.removeEventListener('visibilitychange', handler))
    } catch (e) {}
  }
}

export function onReady(cb) {
  onMounted(() => { cb && cb() })
}

export function onHide(cb) {
  try { onDeactivated(() => { cb && cb() }) } catch (e) {}
  onUnmounted(() => { cb && cb() })
}

export function onUnload(cb) {
  onUnmounted(() => { cb && cb() })
}

export default {
  onLoad, onShow, onReady, onHide, onUnload
}
