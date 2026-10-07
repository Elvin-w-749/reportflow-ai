import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REPORT_EXPORT_FORMATS,
  buildReportPdfBlob,
  buildReportExportFilename,
  collectReportPdfCardBoundaries,
  drawReportflowWatermark,
  exportReportElement,
  planReportPdfSlices,
  resolveReportCaptureScale,
  resolveReportExportFormat,
  sanitizeReportExportBaseName
} from '../src/services/reportExport.js'

const createFakeCanvas = ({ width = 1200, height = 2400 } = {}) => {
  const calls = []
  const context = {
    globalAlpha: 1,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (...args) => calls.push(['translate', ...args]),
    rotate: (...args) => calls.push(['rotate', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    beginPath: () => calls.push(['beginPath']),
    roundRect: (...args) => calls.push(['roundRect', ...args]),
    rect: (...args) => calls.push(['rect', ...args]),
    fill: () => calls.push(['fill']),
    fillText: (...args) => calls.push(['fillText', ...args])
  }
  Object.defineProperty(context, 'globalCompositeOperation', {
    get: () => 'source-over',
    set: (value) => calls.push(['globalCompositeOperation', value])
  })
  const canvas = {
    width,
    height,
    calls,
    getContext: () => context,
    toDataURL: (mimeType = 'image/png') => `data:${mimeType};base64,report`,
    toBlob: (callback, mimeType) => callback(new Blob(['report'], { type: mimeType }))
  }
  return canvas
}

const compactPdfOptions = Object.freeze({
  pageWidthMm: 100,
  pageHeightMm: 130,
  marginMm: 10,
  headerMm: 10,
  footerMm: 10
})

const assertContiguousCoverage = (slices, canvasHeight, maximumSliceHeightPx) => {
  assert.equal(slices[0].offsetY, 0)
  slices.forEach((slice, index) => {
    assert.ok(slice.heightPx > 0)
    assert.ok(slice.heightPx <= maximumSliceHeightPx)
    if (index > 0) {
      const previous = slices[index - 1]
      assert.equal(slice.offsetY, previous.offsetY + previous.heightPx)
    }
  })
  const finalSlice = slices.at(-1)
  assert.equal(finalSlice.offsetY + finalSlice.heightPx, canvasHeight)
}

describe('report export service', () => {
  it('exposes PDF, PNG, and JPG in the requested order', () => {
    assert.deepEqual(REPORT_EXPORT_FORMATS.map((item) => item.key), ['pdf', 'png', 'jpg'])
    assert.equal(resolveReportExportFormat('jpeg').key, 'jpg')
    assert.throws(() => resolveReportExportFormat('webp'), /不支持/)
  })

  it('builds privacy-safe, filesystem-safe filenames', () => {
    assert.equal(sanitizeReportExportBaseName(' 分析报告工作台 / 报告:*? '), '分析报告工作台 - 报告')
    assert.equal(buildReportExportFilename('分析报告工作台-信用分析报告-2026-07-29', 'pdf'), '分析报告工作台-信用分析报告-2026-07-29.pdf')
    assert.equal(buildReportExportFilename('', 'jpeg'), '分析报告工作台-信用分析报告.jpg')
  })

  it('reduces capture scale before exceeding canvas side or pixel limits', () => {
    assert.equal(resolveReportCaptureScale(794, 5000, 2), 2)
    assert.ok(resolveReportCaptureScale(2000, 30000, 2) < 1)
    const scale = resolveReportCaptureScale(5000, 5000, 2)
    assert.ok(5000 * 5000 * scale * scale <= 16000000.01)
    assert.ok(30000 * resolveReportCaptureScale(800, 30000, 2) <= 16384)
    const extremeScale = resolveReportCaptureScale(794, 200000, 2)
    assert.ok(200000 * extremeScale <= 16384)
    assert.ok(794 * 200000 * extremeScale * extremeScale <= 16000000.01)
  })

  it('plans contiguous A4 slices that cover the complete report canvas', () => {
    const plan = planReportPdfSlices(1600, 12000)
    assert.ok(plan.slices.length > 1)
    assertContiguousCoverage(plan.slices, 12000, plan.maximumSliceHeightPx)
  })

  it('moves a card that crosses the page boundary wholly onto the next page', () => {
    const plan = planReportPdfSlices(800, 1650, {
      ...compactPdfOptions,
      cardBoundaries: [{ topPx: 850, bottomPx: 1450 }]
    })

    assert.equal(plan.maximumSliceHeightPx, 1000)
    assert.deepEqual(plan.slices.map(({ offsetY, heightPx }) => ({ offsetY, heightPx })), [
      { offsetY: 0, heightPx: 850 },
      { offsetY: 850, heightPx: 800 }
    ])
    assertContiguousCoverage(plan.slices, 1650, 1000)
  })

  it('rewinds across overlapping card boundaries instead of cutting either card', () => {
    const plan = planReportPdfSlices(800, 1500, {
      ...compactPdfOptions,
      cardBoundaries: [
        { topPx: 800, bottomPx: 1200 },
        { topPx: 700, bottomPx: 850 }
      ]
    })

    assert.equal(plan.slices[0].heightPx, 700)
    assert.equal(plan.slices[1].offsetY, 700)
    assertContiguousCoverage(plan.slices, 1500, 1000)
  })

  it('only splits an oversized card and still preserves nested cards at the split', () => {
    const plan = planReportPdfSlices(800, 2300, {
      ...compactPdfOptions,
      cardBoundaries: [
        { topPx: 100, bottomPx: 2300 },
        { topPx: 900, bottomPx: 1300 }
      ]
    })

    assert.deepEqual(plan.slices.map(({ offsetY, heightPx }) => ({ offsetY, heightPx })), [
      { offsetY: 0, heightPx: 900 },
      { offsetY: 900, heightPx: 1000 },
      { offsetY: 1900, heightPx: 400 }
    ])
    assertContiguousCoverage(plan.slices, 2300, 1000)
  })

  it('keeps small detail rows intact while an oversized parent card spans pages', () => {
    const makeNode = (className, top, bottom) => ({
      classList: [className],
      hasAttribute: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ top, bottom, left: 0, right: 800 })
    })
    const nodes = [
      makeNode('section-card', 100, 2500),
      makeNode('account-row', 900, 1100),
      makeNode('layout-row', 1200, 1300),
      makeNode('query-row', 1850, 2050)
    ]
    let defaultSelector = ''
    const element = {
      scrollWidth: 800,
      scrollHeight: 2600,
      scrollTop: 0,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 2600 }),
      querySelectorAll: (selector) => {
        defaultSelector = selector
        return nodes
      }
    }

    const cardBoundaries = collectReportPdfCardBoundaries(element, 800, 2600)
    assert.match(defaultSelector, /\.account-row/)
    assert.match(defaultSelector, /\.query-row/)
    assert.match(defaultSelector, /\.plan-row/)
    assert.doesNotMatch(defaultSelector, /\[class\*="-row"\]/)
    assert.deepEqual(cardBoundaries, [
      { topPx: 100, bottomPx: 2500 },
      { topPx: 900, bottomPx: 1100 },
      { topPx: 1850, bottomPx: 2050 }
    ])

    const plan = planReportPdfSlices(800, 2600, {
      ...compactPdfOptions,
      cardBoundaries
    })

    assert.deepEqual(plan.slices.map(({ offsetY, heightPx }) => ({ offsetY, heightPx })), [
      { offsetY: 0, heightPx: 900 },
      { offsetY: 900, heightPx: 950 },
      { offsetY: 1850, heightPx: 750 }
    ])
    assertContiguousCoverage(plan.slices, 2600, 1000)
  })

  it('does not cascade across one-pixel overlaps between adjacent sibling rows', () => {
    const siblingRows = Array.from({ length: 40 }, (_, index) => ({
      topPx: 100 + index * 100,
      bottomPx: 201 + index * 100
    }))
    const plan = planReportPdfSlices(800, 4200, {
      ...compactPdfOptions,
      cardBoundaries: [
        { topPx: 0, bottomPx: 4101 },
        ...siblingRows
      ]
    })

    assert.deepEqual(plan.slices.map(({ offsetY, heightPx }) => ({ offsetY, heightPx })), [
      { offsetY: 0, heightPx: 900 },
      { offsetY: 900, heightPx: 900 },
      { offsetY: 1800, heightPx: 900 },
      { offsetY: 2700, heightPx: 900 },
      { offsetY: 3600, heightPx: 600 }
    ])
    assert.ok(plan.slices.length <= 6)
    assertContiguousCoverage(plan.slices, 4200, 1000)

    const breaks = plan.slices.slice(0, -1).map((slice) => slice.offsetY + slice.heightPx)
    siblingRows.forEach((row) => {
      const cutsRowBeyondSharedBorder = breaks.some((breakY) => (
        breakY > row.topPx + 1 && breakY < row.bottomPx - 1
      ))
      assert.equal(cutsRowBeyondSharedBorder, false)
    })
  })

  it('maps rendered HTML card bounds into capture-canvas pixels and ignores excluded cards', () => {
    const makeNode = ({ classNames, rect, excluded = false }) => ({
      classList: classNames,
      hasAttribute: (name) => name === 'data-report-pdf-card' && classNames.includes('explicit-marker'),
      closest: (selector) => selector === '[data-report-export-exclude]' && excluded ? {} : null,
      getBoundingClientRect: () => rect
    })
    const nodes = [
      makeNode({ classNames: ['section-card'], rect: { top: 300, bottom: 600, left: 50, right: 450 } }),
      makeNode({ classNames: ['account-tag', 'card'], rect: { top: 610, bottom: 630, left: 300, right: 350 } }),
      makeNode({ classNames: ['hero-card'], rect: { top: 700, bottom: 800, left: 50, right: 450 }, excluded: true }),
      makeNode({ classNames: ['explicit-marker'], rect: { top: 850, bottom: 950, left: 50, right: 450 } })
    ]
    const element = {
      scrollWidth: 400,
      scrollHeight: 1000,
      scrollTop: 0,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ top: 100, left: 50, width: 400, height: 1000 }),
      querySelectorAll: () => nodes
    }

    assert.deepEqual(collectReportPdfCardBoundaries(element, 800, 2000), [
      { topPx: 400, bottomPx: 1000 },
      { topPx: 1500, bottomPx: 1700 }
    ])
  })

  it('plans PDF pages from the post-onclone layout after excluded nodes reflow', async () => {
    let cloneCardRect = { top: 570, bottom: 745, left: 10, right: 410 }
    let callerOncloneCalls = 0
    const liveCard = {
      classList: ['section-card'],
      hasAttribute: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ top: 650, bottom: 825, left: 10, right: 410 })
    }
    const cloneCard = {
      classList: ['section-card'],
      hasAttribute: () => false,
      closest: () => null,
      getBoundingClientRect: () => cloneCardRect
    }
    const element = {
      scrollWidth: 400,
      scrollHeight: 825,
      scrollTop: 0,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ top: 100, left: 10, width: 400, height: 825 }),
      querySelectorAll: () => [liveCard]
    }
    const clonedElement = {
      scrollWidth: 400,
      scrollHeight: 700,
      scrollTop: 0,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ top: 20, left: 10, width: 400, height: 700 }),
      querySelectorAll: () => [cloneCard]
    }
    const captureCanvas = createFakeCanvas({ width: 800, height: 1650 })
    const createdCanvases = []
    class FakePdf {
      addPage() {}
      addImage() {}
      setDrawColor() {}
      line() {}
      setTextColor() {}
      setFontSize() {}
      text() {}
      output() { return new Blob(['pdf'], { type: 'application/pdf' }) }
    }

    const result = await exportReportElement(element, {
      ...compactPdfOptions,
      format: 'pdf',
      preferredScale: 2,
      html2canvasImpl: async (_element, captureOptions) => {
        assert.equal(captureOptions.ignoreElements({
          hasAttribute: (name) => name === 'data-report-export-exclude'
        }), true)
        await captureOptions.onclone({}, clonedElement)
        return captureCanvas
      },
      onclone: async () => {
        callerOncloneCalls += 1
        cloneCardRect = { top: 445, bottom: 620, left: 10, right: 410 }
      },
      jsPDFImpl: FakePdf,
      createCanvas: (width, height) => {
        const canvas = createFakeCanvas({ width, height })
        createdCanvases.push(canvas)
        return canvas
      },
      downloadImpl: () => {}
    })

    assert.equal(callerOncloneCalls, 1)
    assert.equal(result.pageCount, 2)
    assert.deepEqual(createdCanvases.map(({ width, height }) => ({ width, height })), [
      { width: 720, height: 192 },
      { width: 800, height: 850 },
      { width: 800, height: 800 }
    ])
  })

  it('burns repeated rotated logo marks into the final image pixels', () => {
    const canvas = createFakeCanvas()
    const logo = { naturalWidth: 360, naturalHeight: 96 }
    drawReportflowWatermark(canvas, logo)
    assert.ok(canvas.calls.filter((call) => call[0] === 'drawImage').length >= 6)
    assert.ok(canvas.calls.some((call) => call[0] === 'rotate' && call[1] < 0))
    assert.ok(canvas.calls.some((call) => call[0] === 'globalCompositeOperation' && call[1] === 'multiply'))
  })

  it('keeps a square source logo complete and proportional in the PDF header', async () => {
    const sourceCanvas = createFakeCanvas({ width: 800, height: 600 })
    const createdCanvases = []
    const addedImages = []
    class FakePdf {
      addPage() {}
      addImage(...args) { addedImages.push(args) }
      setDrawColor() {}
      line() {}
      setTextColor() {}
      setFontSize() {}
      text() {}
      output() { return new Blob(['pdf'], { type: 'application/pdf' }) }
    }

    await buildReportPdfBlob(
      sourceCanvas,
      { naturalWidth: 1296, naturalHeight: 1280 },
      {
        jsPDFImpl: FakePdf,
        createCanvas: (width, height) => {
          const canvas = createFakeCanvas({ width, height })
          createdCanvases.push(canvas)
          return canvas
        }
      }
    )

    assert.deepEqual(
      { width: createdCanvases[0].width, height: createdCanvases[0].height },
      { width: 720, height: 711 }
    )
    const [logoImage] = addedImages
    assert.equal(logoImage[1], 'PNG')
    const logoWidthMm = logoImage[4]
    const logoHeightMm = logoImage[5]
    assert.ok(logoWidthMm < 45)
    assert.ok(logoHeightMm <= 12.6)
    assert.ok(Math.abs((logoHeightMm / logoWidthMm) - (1280 / 1296)) < 0.001)
  })

  it('captures, watermarks, encodes, and downloads PNG through injectable boundaries', async () => {
    const canvas = createFakeCanvas({ width: 900, height: 1800 })
    const downloads = []
    const result = await exportReportElement({}, {
      format: 'png',
      fileBaseName: '分析报告工作台报告',
      captureImpl: async () => canvas,
      downloadImpl: (blob, filename) => downloads.push({ blob, filename })
    })

    assert.equal(result.filename, '分析报告工作台报告.png')
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.pageCount, 1)
    assert.equal(downloads.length, 1)
    assert.equal(downloads[0].blob.type, 'image/png')
    assert.ok(canvas.calls.some((call) => call[0] === 'fillText' && call[1] === '分析报告工作台'))
  })
})
