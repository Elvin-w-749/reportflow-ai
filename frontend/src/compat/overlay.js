/**
 * 全局 UI 覆盖层：委托给 Vant 4 命令式 API
 *
 * 函数签名与 uni 兼容 API 完全一致（参数对象字段、默认值、回调/返回语义）。
 * uni.js 内部 import 这些函数并挂载到 window.uni，此处改动不影响 uni.js 绑定。
 *
 * 注：Vant 4 不提供 showActionSheet 函数式 API，actionSheet 仍使用 reactive state + UniOverlay.vue 渲染。
 */
import {
  showToast as vantShowToast,
  showLoadingToast as vantShowLoadingToast,
  showSuccessToast as vantShowSuccessToast,
  closeToast as vantCloseToast,
  showConfirmDialog as vantShowConfirmDialog,
  showDialog as vantShowDialog
} from 'vant'

import { reactive } from 'vue'

// overlayState 保留导出：actionSheet 仍由 UniOverlay.vue 渲染。
export const overlayState = reactive({
  toast: { visible: false, title: '', icon: 'none' },
  loading: { visible: false, title: '' },
  modal: null,
  actionSheet: null
})

let _loadingInstance = null

export function showToast(opts = {}) {
  const title = typeof opts === 'string' ? opts : (opts.title || '')
  const duration = (opts && opts.duration) || 1500
  const icon = (opts && opts.icon) || 'none'

  overlayState.toast = { visible: true, title, icon }

  if (icon === 'success') {
    vantShowSuccessToast({ message: title, duration, forbidClick: false })
  } else {
    vantShowToast({ message: title, duration, type: icon === 'loading' ? 'loading' : undefined, forbidClick: false })
  }
}

export function hideToast() {
  overlayState.toast.visible = false
  vantCloseToast()
}

export function showLoading(opts = {}) {
  const title = (opts && opts.title) || '加载中...'
  overlayState.loading = { visible: true, title }
  _loadingInstance = vantShowLoadingToast({
    message: title,
    forbidClick: true,
    duration: 0
  })
}

export function hideLoading() {
  overlayState.loading.visible = false
  vantCloseToast()
  _loadingInstance = null
}

export function showModal(opts = {}) {
  return new Promise((resolve) => {
    const title = opts.title || '提示'
    const content = opts.content || ''
    const showCancel = opts.showCancel !== false
    const cancelText = opts.cancelText || '取消'
    const confirmText = opts.confirmText || '确定'

    overlayState.modal = { title, content, showCancel, cancelText, confirmText, resolve: null }

    if (showCancel) {
      vantShowConfirmDialog({
        title,
        message: content,
        confirmButtonText: confirmText,
        cancelButtonText: cancelText,
        allowHtml: false
      }).then(() => {
        const result = { confirm: true, cancel: false }
        overlayState.modal = null
        if (typeof opts.success === 'function') opts.success(result)
        if (typeof opts.complete === 'function') opts.complete(result)
        resolve(result)
      }).catch(() => {
        const result = { confirm: false, cancel: true }
        overlayState.modal = null
        if (typeof opts.success === 'function') opts.success(result)
        if (typeof opts.complete === 'function') opts.complete(result)
        resolve(result)
      })
    } else {
      vantShowDialog({
        title,
        message: content,
        confirmButtonText: confirmText,
        showCancelButton: false,
        allowHtml: false
      }).then(() => {
        const result = { confirm: true, cancel: false }
        overlayState.modal = null
        if (typeof opts.success === 'function') opts.success(result)
        if (typeof opts.complete === 'function') opts.complete(result)
        resolve(result)
      }).catch(() => {
        const result = { confirm: false, cancel: false }
        overlayState.modal = null
        if (typeof opts.success === 'function') opts.success(result)
        if (typeof opts.complete === 'function') opts.complete(result)
        resolve(result)
      })
    }
  })
}

/**
 * showActionSheet：Vant 4 无函数式 showActionSheet，保留原 reactive state 实现，
 * 由 UniOverlay.vue 渲染。
 */
export function showActionSheet(opts = {}) {
  return new Promise((resolve, reject) => {
    overlayState.actionSheet = {
      itemList: Array.isArray(opts.itemList) ? opts.itemList : [],
      resolve: (tapIndex) => {
        overlayState.actionSheet = null
        if (tapIndex < 0) {
          if (typeof opts.fail === 'function') opts.fail({ errMsg: 'showActionSheet:fail cancel' })
          if (typeof opts.complete === 'function') opts.complete({ errMsg: 'showActionSheet:fail cancel' })
          reject(new Error('cancel'))
          return
        }
        const res = { tapIndex }
        if (typeof opts.success === 'function') opts.success(res)
        if (typeof opts.complete === 'function') opts.complete(res)
        resolve(res)
      }
    }
  })
}
