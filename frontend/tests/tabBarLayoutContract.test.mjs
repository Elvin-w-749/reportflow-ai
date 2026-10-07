import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('primary navigation stays at the bottom on phone and desktop widths', async () => {
  const tabBar = await read('../src/components/TabBar.vue')
  const globalStyles = await read('../src/styles/global.css')

  assert.match(tabBar, /bottom:\s*calc\(8px \+ var\(--rpt-safe-bottom\)\)/)
  assert.match(tabBar, /left:\s*12px/)
  assert.match(tabBar, /right:\s*12px/)
  assert.match(tabBar, /flex-direction:\s*row/)
  assert.doesNotMatch(tabBar, /\.tabbar\s*\{[^}]*bottom:\s*auto/)
  assert.doesNotMatch(tabBar, /\.tabbar\s*\{[^}]*flex-direction:\s*column/)
  assert.doesNotMatch(globalStyles, /--rpt-desktop-rail/)
})

test('primary navigation keeps the four expected user entries', async () => {
  const tabConfig = await read('../src/config/tabbar.js')

  for (const label of ['首页', '匹配', '消息', '我的']) {
    assert.match(tabConfig, new RegExp(`text:\\s*['"]${label}['"]`))
  }
})
