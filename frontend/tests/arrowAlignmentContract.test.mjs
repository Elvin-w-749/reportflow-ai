import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8')

const collectFiles = (directory, extensions) => {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(path, extensions))
    else if (extensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

const relativePath = (path) => relative(repoRoot, path).replaceAll('\\', '/')
const templateOf = (source) => source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i)?.[1] ?? ''
const stylesOf = (source) => (
  [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n')
)

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const declarationsForClass = (source, className) => {
  const declarations = new Map()
  const classPattern = new RegExp(`\\.${escapeRegExp(className)}(?![\\w-])`)

  for (const match of stylesOf(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectors, body] = match
    if (!classPattern.test(selectors)) continue

    for (const declaration of body.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
      declarations.set(declaration[1].toLowerCase(), declaration[2].trim().toLowerCase())
    }
  }
  return declarations
}

const compactCssValue = (value = '') => value.replace(/\s+/g, '')
const isSquare = (declarations) => {
  const width = compactCssValue(declarations.get('width') ?? declarations.get('inline-size'))
  const height = compactCssValue(declarations.get('height') ?? declarations.get('block-size'))
  const aspectRatio = compactCssValue(declarations.get('aspect-ratio'))
  return (width !== '' && width === height) || aspectRatio === '1' || aspectRatio === '1/1'
}

const isFlexCentered = (declarations) => (
  ['flex', 'inline-flex'].includes(compactCssValue(declarations.get('display')))
  && compactCssValue(declarations.get('align-items')) === 'center'
  && compactCssValue(declarations.get('justify-content')) === 'center'
)

const isZeroSpacing = (value = '') => {
  const zero = /^0(?:[a-z%]+)?$/i
  const parts = value.trim().split(/\s+/)
  return parts.length >= 1 && parts.length <= 4 && parts.every((part) => zero.test(part))
}

const pageFiles = collectFiles(join(repoRoot, 'src', 'pages'), new Set(['.vue']))
const componentFiles = collectFiles(join(repoRoot, 'src', 'components'), new Set(['.vue']))
const templateFiles = [...pageFiles, ...componentFiles]
const sources = new Map(templateFiles.map((path) => [path, readFileSync(path, 'utf8')]))

describe('shared arrow alignment contract', () => {
  it('keeps RptBackButton square, centered, keyboard accessible, and glyph-free', () => {
    const source = read('src', 'components', 'RptBackButton.vue')
    const template = templateOf(source)
    const rootClasses = template.match(/<view\b[^>]*\bclass=["']([^"']+)["']/i)?.[1].split(/\s+/) ?? []
    const rootDeclarations = rootClasses.map((name) => declarationsForClass(source, name))
    const squareRule = rootDeclarations.find(isSquare)
    const centeredRule = rootDeclarations.find(isFlexCentered)
    const zeroPaddingRule = rootDeclarations.find((rules) => isZeroSpacing(rules.get('padding')))

    assert.ok(squareRule, 'RptBackButton root classes must provide equal width and height (or a 1:1 aspect ratio)')
    assert.ok(centeredRule, 'RptBackButton root classes must use flex alignment on both axes')
    assert.ok(zeroPaddingRule, 'RptBackButton root classes must reset padding to zero')
    assert.match(template, /\btabindex\s*=\s*["']0["']/i)
    assert.match(template, /@keydown\.enter(?:\.[\w-]+)*\s*=\s*["'][^"']+["']/i)
    assert.match(template, /@keydown\.space(?:\.[\w-]+)*\s*=\s*["'][^"']+["']/i)
    assert.match(template, /<RptChevron\b[^>]*\bdirection\s*=\s*["']left["']/i)
  })

  it('keeps RptChevron square, flex-centered, and implemented for all four directions', () => {
    const source = read('src', 'components', 'RptChevron.vue')
    const base = declarationsForClass(source, 'rpt-chevron')

    assert.ok(isSquare(base), 'RptChevron must retain a square root box')
    assert.ok(isFlexCentered(base), 'RptChevron must center its stroke on both flex axes')

    const transforms = new Set()
    for (const direction of ['left', 'right', 'up', 'down']) {
      assert.match(source, new RegExp(`['"]${direction}['"]`), `${direction} must remain an allowed direction`)
      const directionalRule = declarationsForClass(source, `rpt-chevron-${direction}`)
      const transform = directionalRule.get('transform') ?? ''
      assert.match(transform, /rotate\([^)]*\)/, `${direction} must define a rotation`)
      transforms.add(compactCssValue(transform))
    }
    assert.equal(transforms.size, 4, 'the four directions must not collapse to the same visual rotation')
  })

  it('does not use text navigation glyphs or the retired back icon class in templates', () => {
    // Home's ⇧ and ↑ are business pictograms, so they are intentionally absent from this navigation-only set.
    const bannedNavigationGlyph = /[‹›←→⌃⌄❮❯]/u
    const offenders = []

    for (const [path, source] of sources) {
      const template = templateOf(source)
      if (bannedNavigationGlyph.test(template) || /rpt-backbtn-icon/i.test(template)) {
        offenders.push(relativePath(path))
      }
    }

    assert.deepEqual(offenders, [], `replace navigation glyphs/classes in: ${offenders.join(', ')}`)
  })

  it('routes every page-level back action through RptBackButton', () => {
    const backPages = pageFiles.filter((path) => {
      const source = sources.get(path)
      const template = templateOf(source)
      return /\bsafeBack\s*\(/.test(source)
        || /@(?:click|tap)(?:\.[\w-]+)*\s*=\s*["'][^"']*\bgoBack\b[^"']*["']/i.test(template)
    })

    assert.ok(backPages.length > 0, 'expected to discover pages with back navigation')
    for (const path of backPages) {
      const source = sources.get(path)
      assert.match(
        templateOf(source),
        /<RptBackButton\b[^>]*@click\s*=\s*["']goBack["'][^>]*\/?>/i,
        `${relativePath(path)} must render the shared back button`
      )
      assert.match(
        source,
        /import\s+RptBackButton\s+from\s+['"][^'"]*RptBackButton\.vue['"]/,
        `${relativePath(path)} must import the shared back button`
      )
    }
  })

  it('gives real RptChevron consumer classes square boxes and centers wrapper hit areas', () => {
    const consumerFailures = []

    for (const [path, source] of sources) {
      if (relativePath(path) === 'src/components/RptChevron.vue') continue

      for (const tag of templateOf(source).matchAll(/<RptChevron\b[\s\S]*?>/gi)) {
        const className = tag[0].match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1]
        if (!className) continue

        for (const name of className.split(/\s+/).filter(Boolean)) {
          if (!isSquare(declarationsForClass(source, name))) {
            consumerFailures.push(`${relativePath(path)} .${name}`)
          }
        }
      }
    }

    assert.deepEqual(
      consumerFailures,
      [],
      `RptChevron consumer classes need a square size: ${consumerFailures.join(', ')}`
    )

    const centeredWrappers = [
      ['src/pages/message/Center.vue', 'client-inbox-chevron'],
      ['src/pages/report/Upload.vue', 'opt-arrow']
    ]
    for (const [path, className] of centeredWrappers) {
      const rules = declarationsForClass(read(...path.split('/')), className)
      assert.ok(isSquare(rules), `${path} .${className} must provide a square hit area`)
      assert.equal(rules.get('align-items'), 'center', `${path} .${className} must center vertically`)
      assert.equal(rules.get('justify-content'), 'center', `${path} .${className} must center horizontally`)
    }
  })
})
