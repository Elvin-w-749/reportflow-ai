import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const testDir = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(testDir, '..')
const repoRoot = resolve(webRoot, '..')

const read = (path) => readFileSync(path, 'utf8')

const trackedFiles = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8'
}).split('\0')
  .filter(Boolean)
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => existsSync(resolve(repoRoot, path)))

describe('browser Web is the only client surface', () => {
  it('does not track native platform trees, install packages, or APK provenance', () => {
    const files = trackedFiles()
    const forbidden = files.filter((path) => (
      /^(?:(?:web|frontend)\/)?(?:android|ios|miniprogram|harmony|ohos)(?:\/|$)/i.test(path) ||
      /\.(?:apk|aab|ipa)$/i.test(path) ||
      /^(?:web|frontend)\/provenance\/APK_/i.test(path)
    ))

    assert.deepEqual(forbidden, [])
    assert.equal(existsSync(resolve(webRoot, 'provenance', 'APK_BASELINE.json')), false)
  })

  it('has no native or mini-program runtime dependency', () => {
    const pkg = JSON.parse(read(resolve(webRoot, 'package.json')))
    const dependencyNames = Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.optionalDependencies || {})
    })
    const forbiddenDependency = /(?:capacitor|cordova|react-native|^expo$|@dcloudio\/uni-app|uni-push)/i

    assert.deepEqual(dependencyNames.filter((name) => forbiddenDependency.test(name)), [])
    assert.doesNotMatch(read(resolve(webRoot, 'package-lock.json')), /node_modules\/@capacitor\//i)
  })

  it('keeps production source free of native and mini-program branches', () => {
    const sourceFiles = trackedFiles().filter((path) => (
      (/^(?:web|frontend)\/src\//.test(path) || /^(?:web|frontend)\/vite\.config\.js$/.test(path)) &&
      /\.(?:js|mjs|cjs|ts|vue)$/.test(path)
    ))
    const source = sourceFiles.map((path) => read(resolve(repoRoot, path))).join('\n')

    assert.doesNotMatch(source, /@capacitor\/|registerPlugin|RptFilePicker|@dcloudio\/uni-app/i)
    assert.doesNotMatch(source, /miniapp-subscribe|app-push|requestSubscribeMessage|getPushClientId|uni-push/i)
  })

  it('advertises a browser-only service without active App or mini-program launch copy', () => {
    const official = read(resolve(webRoot, 'src', 'pages', 'official', 'Official.vue'))
    const readme = read(resolve(webRoot, 'README.md'))

    assert.match(readme, /唯一客户端/)
    assert.doesNotMatch(official, /准备上线小程序|小程序服务支持页|小程序二维码|小程序审核资料/)
  })
})
