import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('uni file picker compat', () => {
  it('maps browser PDF file selection into uni.chooseFile payloads', async () => {
    const env = installPickerDom()
    try {
      const { installUni } = await import('../src/compat/uni.js')
      const uni = installUni()
      const file = makeFile('credit-report.pdf', 2048, 'application/pdf')

      const resultPromise = new Promise((resolve, reject) => {
        uni.chooseFile({
          count: 1,
          extension: ['.pdf'],
          success: resolve,
          fail: reject
        })
      })

      assert.equal(env.input.type, 'file')
      assert.equal(env.input.accept, 'application/pdf,.pdf')
      assert.equal(env.appended.length, 1)

      env.input.files = [file]
      env.input.onchange()

      const result = await resultPromise
      assert.equal(result.tempFilePaths.length, 1)
      assert.equal(result.tempFiles[0].path, 'blob:credit-report.pdf')
      assert.equal(result.tempFiles[0].name, 'credit-report.pdf')
      assert.equal(result.tempFiles[0].size, 2048)
      assert.equal(result.tempFiles[0].type, 'application/pdf')
      assert.equal(result.tempFiles[0].file, file)
      assert.equal(env.createdUrls[0], file)
      assert.equal(env.removed.length, 1)
    } finally {
      env.restore()
    }
  })

  it('maps browser image selection into uni.chooseImage payloads', async () => {
    const env = installPickerDom()
    try {
      const { installUni } = await import('../src/compat/uni.js')
      const uni = installUni()
      const file = makeFile('report-shot.jpg', 4096, 'image/jpeg')

      const resultPromise = new Promise((resolve, reject) => {
        uni.chooseImage({
          count: 1,
          sourceType: ['album'],
          success: resolve,
          fail: reject
        })
      })

      assert.equal(env.input.type, 'file')
      assert.equal(env.input.accept, 'image/*')
      assert.equal(env.input.capture, undefined)
      assert.equal(env.input.multiple, undefined)

      env.input.files = [file]
      env.input.onchange()

      const result = await resultPromise
      assert.deepEqual(result.tempFilePaths, ['blob:report-shot.jpg'])
      assert.equal(result.tempFiles[0].name, 'report-shot.jpg')
      assert.equal(result.tempFiles[0].file, file)
    } finally {
      env.restore()
    }
  })

  it('enables browser multi image selection when count is greater than one', async () => {
    const env = installPickerDom()
    try {
      const { installUni } = await import('../src/compat/uni.js')
      const uni = installUni()
      const files = [
        makeFile('report-page-1.jpg', 4096, 'image/jpeg'),
        makeFile('report-page-2.jpg', 5120, 'image/jpeg')
      ]

      const resultPromise = new Promise((resolve, reject) => {
        uni.chooseImage({
          count: 30,
          sourceType: ['album'],
          success: resolve,
          fail: reject
        })
      })

      assert.equal(env.input.type, 'file')
      assert.equal(env.input.accept, 'image/*')
      assert.equal(env.input.multiple, true)

      env.input.files = files
      env.input.onchange()

      const result = await resultPromise
      assert.deepEqual(result.tempFilePaths, ['blob:report-page-1.jpg', 'blob:report-page-2.jpg'])
      assert.equal(result.tempFiles.length, 2)
      assert.equal(result.tempFiles[1].name, 'report-page-2.jpg')
      assert.equal(result.tempFiles[1].file, files[1])
    } finally {
      env.restore()
    }
  })

  it('uploads browser File or Blob objects without requiring a filePath', async () => {
    const previous = {
      FormData: globalThis.FormData,
      XMLHttpRequest: globalThis.XMLHttpRequest,
      fetch: globalThis.fetch
    }
    const appended = []
    let xhrInstance = null

    try {
      globalThis.FormData = class FakeFormData {
        append(...args) { appended.push(args) }
      }
      globalThis.XMLHttpRequest = class FakeXMLHttpRequest {
        constructor() {
          xhrInstance = this
          this.headers = {}
          this.status = 200
          this.responseText = '{"code":0,"data":{"ok":true}}'
        }
        open(method, url) {
          this.method = method
          this.url = url
        }
        setRequestHeader(key, value) { this.headers[key] = value }
        send(body) {
          this.body = body
          this.onload()
        }
      }
      globalThis.fetch = () => {
        throw new Error('uploadFile should not fetch an empty filePath when file is provided')
      }

      const { installUni } = await import('../src/compat/uni.js')
      const uni = installUni()
      const blob = new Blob(['credit-report'], { type: 'application/pdf' })
      Object.defineProperty(blob, 'name', { value: 'large-credit-report.pdf' })

      const result = await new Promise((resolve, reject) => {
        uni.uploadFile({
          url: '/api/analyze',
          file: blob,
          name: 'file',
          header: { Authorization: 'Bearer test-token' },
          success: resolve,
          fail: reject
        })
      })

      assert.equal(result.statusCode, 200)
      assert.equal(xhrInstance.method, 'POST')
      assert.equal(xhrInstance.url, '/api/analyze')
      assert.equal(xhrInstance.headers.Authorization, 'Bearer test-token')
      assert.equal(appended.length, 1)
      assert.deepEqual(appended[0], ['file', blob, 'large-credit-report.pdf'])
    } finally {
      globalThis.FormData = previous.FormData
      globalThis.XMLHttpRequest = previous.XMLHttpRequest
      globalThis.fetch = previous.fetch
    }
  })

  it('reports cancellation through fail and complete callbacks', async () => {
    const env = installPickerDom()
    try {
      const { installUni } = await import('../src/compat/uni.js')
      const uni = installUni()

      const calls = []
      await new Promise((resolve) => {
        uni.chooseFile({
          extension: ['pdf'],
          fail: (err) => calls.push(['fail', err]),
          complete: (err) => { calls.push(['complete', err]); resolve() }
        })
        env.input.files = []
        env.input.onchange()
      })

      assert.equal(calls.length, 2)
      assert.deepEqual(calls.map(([name]) => name), ['fail', 'complete'])
      assert.match(calls[0][1].errMsg, /chooseFile:fail cancel/)
      assert.match(calls[1][1].errMsg, /chooseFile:fail cancel/)
      assert.equal(env.removed.length, 1)
    } finally {
      env.restore()
    }
  })

	 it('reports real XHR upload progress and removes progress listeners', async () => {
		 const previous = {
			 FormData: globalThis.FormData,
			 XMLHttpRequest: globalThis.XMLHttpRequest,
			 fetch: globalThis.fetch
		 }
		 let xhrInstance = null
		 try {
			 globalThis.FormData = class FakeFormData { append() {} }
			 globalThis.XMLHttpRequest = class FakeXMLHttpRequest {
				 constructor() {
					 xhrInstance = this
					 this.upload = {}
					 this.status = 200
					 this.responseText = '{"code":0}'
				 }
				 open() {}
				 setRequestHeader() {}
				 send() {}
			 }
			 const { installUni } = await import('../src/compat/uni.js')
			 const uni = installUni()
			 const blob = new Blob(['credit-report'], { type: 'application/pdf' })
			 const progress = []
			 const listener = (event) => progress.push(event)
			 const completed = new Promise((resolve, reject) => {
				 const task = uni.uploadFile({ url: '/api/analyze', file: blob, success: resolve, fail: reject })
				 task.onProgressUpdate(listener)
				 xhrInstance.upload.onprogress({ lengthComputable: true, loaded: 25, total: 100 })
				 task.offProgressUpdate(listener)
				 xhrInstance.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 })
				 xhrInstance.onload()
			 })
			 await completed
			 assert.deepEqual(progress, [{ progress: 25, totalBytesSent: 25, totalBytesExpectedToSend: 100 }])
		 } finally {
			 globalThis.FormData = previous.FormData
			 globalThis.XMLHttpRequest = previous.XMLHttpRequest
			 globalThis.fetch = previous.fetch
		 }
	 })

	 it('aborts the underlying XHR and settles fail/complete exactly once', async () => {
		 const previous = {
			 FormData: globalThis.FormData,
			 XMLHttpRequest: globalThis.XMLHttpRequest,
			 fetch: globalThis.fetch
		 }
		 let xhrInstance = null
		 try {
			 globalThis.FormData = class FakeFormData { append() {} }
			 globalThis.XMLHttpRequest = class FakeXMLHttpRequest {
				 constructor() {
					 xhrInstance = this
					 this.upload = {}
				 }
				 open() {}
				 setRequestHeader() {}
				 send() {}
				 abort() {
					 this.abortCalls = (this.abortCalls || 0) + 1
					 if (this.onabort) this.onabort()
				 }
			 }
			 const { installUni } = await import('../src/compat/uni.js')
			 const uni = installUni()
			 const blob = new Blob(['credit-report'], { type: 'application/pdf' })
			 const calls = []
			 let settle
			 const completed = new Promise((resolve) => { settle = resolve })
			 const task = uni.uploadFile({
				 url: '/api/analyze',
				 file: blob,
				 success: (value) => calls.push(['success', value]),
				 fail: (error) => calls.push(['fail', error]),
				 complete: (value) => { calls.push(['complete', value]); settle() }
			 })
			 task.abort()
			 task.abort()
			 await completed
			 await Promise.resolve()
			 assert.equal(xhrInstance.abortCalls, 1)
			 assert.deepEqual(calls.map(([name]) => name), ['fail', 'complete'])
			 assert.equal(calls[0][1].code, 'UPLOAD_ABORTED')
		 } finally {
			 globalThis.FormData = previous.FormData
			 globalThis.XMLHttpRequest = previous.XMLHttpRequest
			 globalThis.fetch = previous.fetch
		 }
	 })

	 it('does not swallow localStorage quota errors', async () => {
		 const previous = globalThis.localStorage
		 const quota = new Error('quota exceeded')
		 quota.name = 'QuotaExceededError'
		 globalThis.localStorage = {
			 setItem() { throw quota },
			 getItem() { return null }
		 }
		 try {
			 const { installUni } = await import('../src/compat/uni.js')
			 const uni = installUni()
			 assert.throws(() => uni.setStorageSync('report_test', 'value'), (error) => error === quota)
		 } finally {
			 globalThis.localStorage = previous
		 }
	 })
})

function makeFile(name, size, type) {
  return { name, size, type }
}

function installPickerDom() {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    URL: globalThis.URL
  }
  const env = {
    appended: [],
    removed: [],
    createdUrls: [],
    input: null,
    restore() {
      globalThis.document = previous.document
      globalThis.window = previous.window
      globalThis.URL = previous.URL
    }
  }
  const listeners = new Map()
  const win = {
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name) { listeners.delete(name) },
    setTimeout(fn) { fn(); return 1 },
    clearTimeout() {}
  }
  const doc = {
    body: {
      appendChild(el) { env.appended.push(el); env.input = el },
      removeChild(el) { env.removed.push(el) }
    },
    createElement(tag) {
      if (tag === 'input') {
        return {
          style: {},
          files: [],
          click() {},
          onchange: null
        }
      }
      return {
        style: {},
        childNodes: [],
        content: { firstChild: null },
        set innerHTML(value) { this._innerHTML = value },
        get innerHTML() { return this._innerHTML || '' },
        appendChild() {},
        removeChild() {}
      }
    },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name) { listeners.delete(name) }
  }
  globalThis.window = win
  globalThis.document = doc
  globalThis.URL = {
    createObjectURL(file) {
      env.createdUrls.push(file)
      return `blob:${file.name}`
    }
  }
  return env
}
