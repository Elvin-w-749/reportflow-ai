import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const read = (relPath) => readFileSync(join(root, relPath), 'utf8')

describe('legal document user access contract', () => {
  it('registers the Web legal document route', () => {
    const router = read('src/router/index.js')
    assert.match(router, /path:\s*['"]\/pages\/legal\/document['"]/, 'legal document route must be registered')
    assert.match(router, /@\/pages\/legal\/Document\.vue/, 'route must load the legal document page')
  })

  it('keeps login and register consent gates wired to the user agreement', () => {
    const login = read('src/pages/login/Login.vue')
    const register = read('src/pages/login/Register.vue')

    for (const source of [login, register]) {
      assert.match(source, /agreed\s*=\s*ref\(false\)/, 'auth entry must default to not agreed')
      assert.match(source, /!agreed\.value/, 'auth submit must block before consent')
      assert.match(source, /openLegal\('agreement'\)/, 'auth entry must link user agreement')
      assert.match(source, /\/pages\/legal\/document\?type=\$\{kind\}/, 'auth entry must navigate to legal document page')
    }
  })

  it('keeps profile menu and document page connected to the user agreement draft', () => {
    const profile = read('src/pages/profile/Profile.vue')
    const page = read('src/pages/legal/Document.vue')

    assert.match(profile, /openLegal\('agreement'\)/, 'profile must expose user agreement')
    assert.match(page, /USER_AGREEMENT\.md\?raw/, 'legal page must render user agreement draft')
  })
})
