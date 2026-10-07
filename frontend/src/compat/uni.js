/**
 * 旧版浏览器 API 兼容垫片
 *
 * 目标：让原 services/config/utils 中的 uni.* 调用无需改动即可在 Vue 3 浏览器环境运行。
 * 仅实现本项目实际用到的子集。
 */
import {
  showToast,
  hideToast,
  showLoading,
  hideLoading,
  showModal,
  showActionSheet
} from './overlay.js'
import { buildWindowInfo, resolveSafeAreaInsets } from './safeArea.js'

let _router = null
export function setRouter(router) {
  _router = router
}

// 本地选择文件登记表：blobURL -> File，供 getFileInfo / uploadFile 复用
const _fileRegistry = new Map()

// ── uni 路径(/pages/xxx/yyy) -> vue-router 路径 映射 ──
function uniUrlToRoute(url) {
  const raw = String(url || '')
  const [path, query] = raw.split('?')
  const clean = path.replace(/^\//, '').replace(/\.(uvue|vue)$/, '')
  return { path: '/' + clean, query: parseQuery(query) }
}

function parseQuery(qs) {
  const out = {}
  if (!qs) return out
  qs.split('&').forEach((kv) => {
    const [k, v] = kv.split('=')
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '')
  })
  return out
}

// ── 存储 ──
const storage = {
  getStorageSync(key) {
    try {
      const v = localStorage.getItem(key)
      if (v == null) return ''
      try { return JSON.parse(v) } catch { return v }
    } catch { return '' }
  },
  setStorageSync(key, value) {
    // 保持旧版同步存储契约：写入失败必须同步抛出。
    // 特别是 Safari / 微信 WebView 的 QuotaExceededError、SecurityError，
    // 如果在这里吞掉，上层会误以为征信报告已经保存并跳转到不存在的详情。
    const v = typeof value === 'string' ? value : JSON.stringify(value)
    localStorage.setItem(key, v)
  },
  removeStorageSync(key) {
    try { localStorage.removeItem(key) } catch (e) { /* ignore */ }
  },
  clearStorageSync() {
    try { localStorage.clear() } catch (e) { /* ignore */ }
  },
  getStorageInfoSync() {
    const keys = []
    try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)) } catch (e) {}
    return { keys, currentSize: 0, limitSize: 5120 }
  }
}

// ── 网络：request ──
function appendRequestQuery(url, data) {
  if (data == null || data === '') return String(url || '')
  const pairs = []
  const append = (key, value) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((item) => append(key, item))
      return
    }
    const normalized = typeof value === 'object' ? JSON.stringify(value) : String(value)
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(normalized)}`)
  }
  if (typeof data === 'string') {
    const raw = data.replace(/^[?&]/, '')
    if (raw) pairs.push(raw)
  } else if (typeof data === 'object') {
    Object.keys(data).forEach((key) => append(key, data[key]))
  }
  if (!pairs.length) return String(url || '')
  const rawUrl = String(url || '')
  const hashIndex = rawUrl.indexOf('#')
  const base = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl
  const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : ''
  const separator = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'
  return `${base}${separator}${pairs.join('&')}${hash}`
}

function request(opts = {}) {
  const { url, method = 'GET', data, header = {}, timeout = 60000, success, fail, complete } = opts
  const xhr = new XMLHttpRequest()
  try {
    const normalizedMethod = String(method).toUpperCase()
    const requestUrl = normalizedMethod === 'GET' || normalizedMethod === 'HEAD'
      ? appendRequestQuery(url, data)
      : url
    xhr.open(normalizedMethod, requestUrl, true)
    xhr.timeout = timeout
    Object.keys(header || {}).forEach((k) => {
      try { xhr.setRequestHeader(k, header[k]) } catch (e) {}
    })
    xhr.onload = () => {
      let parsed = xhr.responseText
      try { parsed = JSON.parse(xhr.responseText) } catch (e) { /* keep string */ }
      const res = { statusCode: xhr.status, data: parsed, header: {} }
      if (typeof success === 'function') success(res)
      if (typeof complete === 'function') complete(res)
    }
    xhr.onerror = () => {
      const err = { errMsg: 'request:fail' }
      if (typeof fail === 'function') fail(err)
      if (typeof complete === 'function') complete(err)
    }
    xhr.ontimeout = () => {
      const err = { errMsg: 'request:fail timeout' }
      if (typeof fail === 'function') fail(err)
      if (typeof complete === 'function') complete(err)
    }
    let body = null
    if (data != null && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
      body = typeof data === 'string' ? data : JSON.stringify(data)
    }
    xhr.send(body)
  } catch (e) {
    const err = { errMsg: 'request:fail ' + (e && e.message) }
    if (typeof fail === 'function') fail(err)
    if (typeof complete === 'function') complete(err)
  }
  return xhr
}

// ── 网络：uploadFile（multipart） ──
function uploadFile(opts = {}) {
  const { url, filePath, file = null, name = 'file', header = {}, formData = {}, timeout = 600000, success, fail, complete } = opts
  let xhr = null
  let fetchController = null
  let settled = false
  let aborted = false
  const progressListeners = new Set()

  const normalizedError = (code, errMsg, extra = {}) => ({
    code,
    errMsg,
    statusCode: 0,
    ...extra
  })
  const finish = (kind, payload) => {
    if (settled) return
    settled = true
    if (kind === 'success') {
      if (typeof success === 'function') success(payload)
    } else if (typeof fail === 'function') {
      fail(payload)
    }
    if (typeof complete === 'function') complete(payload)
  }
  const emitProgress = (event) => {
    if (!event || event.lengthComputable !== true || !(Number(event.total) > 0)) return
    const total = Number(event.total)
    const loaded = Math.max(0, Math.min(total, Number(event.loaded) || 0))
    const payload = {
      progress: Math.max(0, Math.min(100, Math.round((loaded / total) * 100))),
      totalBytesSent: loaded,
      totalBytesExpectedToSend: total
    }
    progressListeners.forEach((listener) => {
      try { listener(payload) } catch (e) { /* 监听器异常不得打断上传 */ }
    })
  }

  const run = async () => {
    const hasBlob = typeof Blob !== 'undefined'
    let fileBlob = hasBlob && file instanceof Blob
      ? file
      : hasBlob && filePath instanceof Blob
        ? filePath
        : _fileRegistry.get(filePath)
    if (!fileBlob) {
      fetchController = typeof AbortController !== 'undefined' ? new AbortController() : null
      const r = await fetch(filePath, fetchController ? { signal: fetchController.signal } : undefined)
      fileBlob = await r.blob()
    }
    if (aborted) throw normalizedError('UPLOAD_ABORTED', 'uploadFile:fail abort', { aborted: true })
    const fd = new FormData()
    const filename = (fileBlob && fileBlob.name) || guessName(filePath, fileBlob)
    fd.append(name, fileBlob, filename)
    Object.keys(formData || {}).forEach((k) => fd.append(k, formData[k]))
    return await new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest()
      xhr.open('POST', url, true)
      xhr.timeout = timeout
      Object.keys(header || {}).forEach((k) => {
        // 不要手动设置 Content-Type，交给浏览器带 boundary
        if (String(k).toLowerCase() === 'content-type') return
        try { xhr.setRequestHeader(k, header[k]) } catch (e) {}
      })
      if (xhr.upload) xhr.upload.onprogress = emitProgress
      xhr.onload = () => {
        const statusCode = Number(xhr.status) || 0
        if (statusCode === 0) {
          reject(normalizedError('UPLOAD_NETWORK_ERROR', 'uploadFile:fail network'))
          return
        }
        resolve({ statusCode, data: xhr.responseText })
      }
      xhr.onerror = () => reject(normalizedError('UPLOAD_NETWORK_ERROR', 'uploadFile:fail network'))
      xhr.ontimeout = () => reject(normalizedError('UPLOAD_TIMEOUT', 'uploadFile:fail timeout', { timedOut: true }))
      xhr.onabort = () => reject(normalizedError('UPLOAD_ABORTED', 'uploadFile:fail abort', { aborted: true }))
      if (aborted) {
        xhr.abort()
        return
      }
      xhr.send(fd)
    })
  }
  run().then(
    (res) => finish('success', res),
    (err) => {
      if (err && err.code === 'UPLOAD_ABORTED') {
        finish('fail', err)
        return
      }
      if (aborted || (err && err.name === 'AbortError')) {
        finish('fail', normalizedError('UPLOAD_ABORTED', 'uploadFile:fail abort', { aborted: true }))
        return
      }
      if (err && (err.code === 'UPLOAD_NETWORK_ERROR' || err.code === 'UPLOAD_TIMEOUT')) {
        finish('fail', err)
        return
      }
      finish('fail', normalizedError('UPLOAD_NETWORK_ERROR', `uploadFile:fail ${err && err.message ? err.message : 'network'}`))
    }
  )
  return {
    abort() {
      if (settled || aborted) return
      aborted = true
      try { if (fetchController) fetchController.abort() } catch (e) {}
      try { if (xhr) xhr.abort() } catch (e) {}
      // abort 可能发生在异步取得 Blob 之前，此时还没有 XHR 事件负责收口。
      finish('fail', normalizedError('UPLOAD_ABORTED', 'uploadFile:fail abort', { aborted: true }))
    },
    onProgressUpdate(listener) {
      if (typeof listener === 'function') progressListeners.add(listener)
    },
    offProgressUpdate(listener) {
      if (typeof listener === 'function') progressListeners.delete(listener)
      else progressListeners.clear()
    }
  }
}

function guessName(filePath, blob) {
  const fromPath = String(filePath || '').split('/').pop() || ''
  if (fromPath && /\.[a-z0-9]+$/i.test(fromPath)) return fromPath
  const type = (blob && blob.type) || ''
  if (/pdf/i.test(type)) return 'file.pdf'
  if (/png/i.test(type)) return 'image.png'
  return 'image.jpg'
}

function downloadFile(opts = {}) {
  const { url, success, fail, complete } = opts
  fetch(url).then((r) => r.blob()).then((blob) => {
    const tempFilePath = URL.createObjectURL(blob)
    _fileRegistry.set(tempFilePath, blob)
    const res = { statusCode: 200, tempFilePath }
    if (success) success(res); if (complete) complete(res)
  }).catch((e) => {
    const err = { errMsg: 'downloadFile:fail ' + (e && e.message) }
    if (fail) fail(err); if (complete) complete(err)
  })
}

// ── 媒体选择 ──
function pickViaInput({ accept, capture, multiple = false }) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept || '*/*'
    if (capture) input.capture = capture
    if (multiple) input.multiple = true
    input.style.position = 'fixed'
    input.style.left = '0'
    input.style.top = '0'
    input.style.width = '1px'
    input.style.height = '1px'
    input.style.opacity = '0'
    input.style.pointerEvents = 'none'
    let settled = false
    let cleanupTimer = null
    input.onchange = () => {
      settled = true
      const files = Array.from(input.files || [])
      cleanup()
      if (!files.length) { reject(new Error('cancel')); return }
      const mapped = files.map((f) => {
        const blobUrl = URL.createObjectURL(f)
        _fileRegistry.set(blobUrl, f)
        return { path: blobUrl, size: f.size, name: f.name, type: f.type, file: f }
      })
      resolve(mapped)
    }
    const cleanup = () => {
      if (cleanupTimer) window.clearTimeout(cleanupTimer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      try { document.body.removeChild(input) } catch (e) {}
    }
    const onFocus = () => {
      cleanupTimer = window.setTimeout(() => {
        const files = Array.from(input.files || [])
        if (!settled && !files.length) {
          settled = true
          cleanup()
          reject(new Error('cancel'))
        }
      }, 1200)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

function chooseImage(opts = {}) {
  const sourceType = opts.sourceType || ['album', 'camera']
  const capture = sourceType.length === 1 && sourceType[0] === 'camera' ? 'environment' : undefined
  const count = Math.max(1, Number(opts.count || 1))
  pickViaInput({ accept: 'image/*', capture, multiple: count > 1 }).then(
    (files) => {
      const picked = files.slice(0, count)
      const res = {
        tempFilePaths: picked.map((f) => f.path),
        tempFiles: picked.map((f) => ({ path: f.path, size: f.size, name: f.name, type: f.type, file: f.file }))
      }
      if (opts.success) opts.success(res)
      if (opts.complete) opts.complete(res)
    },
    () => {
      const err = { errMsg: 'chooseImage:fail cancel' }
      if (opts.fail) opts.fail(err)
      if (opts.complete) opts.complete(err)
    }
  )
}

function chooseFile(opts = {}) {
  const exts = Array.isArray(opts.extension) ? opts.extension : []
  const accept = exts.length
    ? exts.map((e) => normalizeAcceptExtension(e)).join(',')
    : '*/*'
  const picker = pickViaInput({ accept, multiple: false })
  picker.then(
    (files) => {
      const res = {
        tempFilePaths: files.map((f) => f.path),
        tempFiles: files.map((f) => ({ path: f.path, size: f.size, name: f.name, type: f.type, file: f.file }))
      }
      if (opts.success) opts.success(res)
      if (opts.complete) opts.complete(res)
    },
    (e) => {
      const err = { errMsg: 'chooseFile:fail ' + ((e && e.message) || 'cancel') }
      if (opts.fail) opts.fail(err)
      if (opts.complete) opts.complete(err)
    }
  )
}

function normalizeAcceptExtension(ext) {
  const normalized = String(ext || '').trim().toLowerCase()
  const dotted = normalized.startsWith('.') ? normalized : '.' + normalized
  if (dotted === '.pdf') return 'application/pdf,.pdf'
  return dotted
}

function getFileInfo(opts = {}) {
  const { filePath, success, fail, complete } = opts
  const f = filePath && typeof Blob !== 'undefined' && filePath instanceof Blob
    ? filePath
    : _fileRegistry.get(filePath)
  if (f) {
    const res = { size: f.size }
    if (success) success(res); if (complete) complete(res)
    return
  }
  fetch(filePath).then((r) => r.blob()).then((b) => {
    const res = { size: b.size }
    if (success) success(res); if (complete) complete(res)
  }).catch((e) => {
    const err = { errMsg: 'getFileInfo:fail' }
    if (fail) fail(err); if (complete) complete(err)
  })
}

// ── 文件系统/编码 ──
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// ── 设备信息 ──
function getWindowInfoSync() {
  const win = typeof window !== 'undefined' ? window : {}
  const nav = typeof navigator !== 'undefined' ? navigator : {}
  const screen = win.screen || {}
  return buildWindowInfo({
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    visualViewportHeight: win.visualViewport && win.visualViewport.height,
    screenWidth: screen.width,
    screenHeight: screen.height,
    userAgent: nav.userAgent,
    safeAreaInsets: resolveSafeAreaInsets(win.document || globalThis.document)
  })
}

function getSystemInfoSync() {
  return getWindowInfoSync()
}

function makePhoneCall(opts = {}) {
  try { window.location.href = 'tel:' + (opts.phoneNumber || '') } catch (e) {}
  if (opts.success) opts.success({})
  if (opts.complete) opts.complete({})
}

function setClipboardData(opts = {}) {
  const data = String(opts.data || '')
  const done = () => { if (opts.success) opts.success({}); if (opts.complete) opts.complete({}); showToast('已复制') }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(data).then(done, done)
  } else { done() }
}

// ── 导航 ──
function navigateTo(opts = {}) {
  if (!_router) return
  const { path, query } = uniUrlToRoute(opts.url)
  _router.push({ path, query }).then(
    () => { if (opts.success) opts.success({}); if (opts.complete) opts.complete({}) },
    (e) => { if (opts.fail) opts.fail({ errMsg: 'navigateTo:fail ' + (e && e.message) }); if (opts.complete) opts.complete({}) }
  )
}
function redirectTo(opts = {}) {
  if (!_router) return
  const { path, query } = uniUrlToRoute(opts.url)
  _router.replace({ path, query }).then(() => { opts.success && opts.success({}) }, () => { opts.fail && opts.fail({}) })
}
function reLaunch(opts = {}) { redirectTo(opts) }
function switchTab(opts = {}) {
  if (!_router) return
  const { path } = uniUrlToRoute(opts.url)
  _router.push({ path }).then(() => { opts.success && opts.success({}) }, () => { opts.fail && opts.fail({}) })
}
function navigateBack(opts = {}) {
  if (!_router) return
  _router.back()
  if (opts.success) opts.success({})
}

// ── 其它（多为 no-op 或简化） ──
function setNavigationBarTitle(opts = {}) {
  try { if (opts.title) document.title = opts.title } catch (e) {}
}
function getCurrentPages() {
  try {
    const path = _router ? _router.currentRoute.value.path : '/'
    return [{ route: path.replace(/^\//, ''), __route__: path }]
  } catch { return [] }
}

// ── 简单事件总线（$emit/$on/$off） ──
const _bus = {}
function $on(name, cb) { (_bus[name] = _bus[name] || []).push(cb) }
function $off(name, cb) {
  if (!_bus[name]) return
  _bus[name] = _bus[name].filter((f) => f !== cb)
}
function $emit(name, ...args) { (_bus[name] || []).forEach((f) => { try { f(...args) } catch (e) {} }) }

const uni = {
  ...storage,
  request,
  uploadFile,
  downloadFile,
  chooseImage,
  chooseFile,
  getFileInfo,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  getSystemInfoSync,
  getWindowInfoSync,
  makePhoneCall,
  setClipboardData,
  showToast,
  hideToast,
  showLoading,
  hideLoading,
  showModal,
  showActionSheet,
  navigateTo,
  redirectTo,
  reLaunch,
  switchTab,
  navigateBack,
  setNavigationBarTitle,
  getCurrentPages,
  $on,
  $off,
  $emit
}

export function installUni() {
  if (typeof window !== 'undefined') {
    window.uni = uni
    if (typeof window.getCurrentPages !== 'function') window.getCurrentPages = getCurrentPages
  }
  if (typeof globalThis !== 'undefined') globalThis.uni = uni
  return uni
}

export default uni
