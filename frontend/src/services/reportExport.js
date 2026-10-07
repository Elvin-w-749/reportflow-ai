const FORMAT_DEFINITIONS = [
  { key: 'pdf', label: 'PDF 文档', extension: 'pdf', mimeType: 'application/pdf' },
  { key: 'png', label: 'PNG 长图', extension: 'png', mimeType: 'image/png' },
  { key: 'jpg', label: 'JPG 长图', extension: 'jpg', mimeType: 'image/jpeg' }
]

export const REPORT_EXPORT_FORMATS = Object.freeze(FORMAT_DEFINITIONS.map((item) => Object.freeze({ ...item })))

const MAX_CAPTURE_SIDE = 16384
const MAX_CAPTURE_PIXELS = 16000000
const DEFAULT_CAPTURE_SCALE = 2
const PDF_PAGE_WIDTH_MM = 210
const PDF_PAGE_HEIGHT_MM = 297
const PDF_MARGIN_MM = 8
const PDF_HEADER_MM = 15
const PDF_FOOTER_MM = 8
const FALLBACK_LOGO_HEIGHT_RATIO = 96 / 360
const MIN_LOGO_HEIGHT_RATIO = 0.1
const MAX_LOGO_HEIGHT_RATIO = 4
const PDF_REWOUND_BREAK_TOLERANCE_PX = 1
const PDF_BREAK_AVOID_ITEM_CLASSES = Object.freeze([
  'account-row',
  'query-row',
  'overdue-row',
  'plain-row',
  'plan-row',
  'query-highlight-row',
  'completeness-row',
  'dim-row'
])
const PDF_BREAK_AVOID_ITEM_CLASS_SET = new Set(PDF_BREAK_AVOID_ITEM_CLASSES)
const DEFAULT_PDF_CARD_SELECTOR = [
  '[data-report-pdf-card]',
  '[class*="-card"]',
  ...PDF_BREAK_AVOID_ITEM_CLASSES.map((className) => `.${className}`)
].join(', ')
const capturedPdfCardBoundaries = new WeakMap()

const finitePositive = (value, fallback = 1) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export function resolveReportCaptureScale(width, height, preferredScale = DEFAULT_CAPTURE_SCALE) {
  const safeWidth = finitePositive(width)
  const safeHeight = finitePositive(height)
  const preferred = Math.max(0.5, finitePositive(preferredScale, DEFAULT_CAPTURE_SCALE))
  const sideScale = Math.min(MAX_CAPTURE_SIDE / safeWidth, MAX_CAPTURE_SIDE / safeHeight)
  const pixelScale = Math.sqrt(MAX_CAPTURE_PIXELS / (safeWidth * safeHeight))
  const bounded = Math.min(preferred, sideScale, pixelScale)
  const roundedDown = Math.floor(bounded * 1000000) / 1000000
  return roundedDown > 0 ? roundedDown : bounded
}

export function sanitizeReportExportBaseName(value = '') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '')
    .slice(0, 96)
  return cleaned || '分析报告工作台-信用分析报告'
}

export function resolveReportExportFormat(format = '') {
  const normalized = String(format || '').trim().toLowerCase()
  const key = normalized === 'jpeg' ? 'jpg' : normalized
  const found = REPORT_EXPORT_FORMATS.find((item) => item.key === key)
  if (!found) throw new Error('不支持的报告导出格式')
  return found
}

export function buildReportExportFilename(fileBaseName, format) {
  const definition = resolveReportExportFormat(format)
  return `${sanitizeReportExportBaseName(fileBaseName)}.${definition.extension}`
}

const createBrowserCanvas = (width, height, documentRef = typeof document !== 'undefined' ? document : null) => {
  if (!documentRef || typeof documentRef.createElement !== 'function') throw new Error('当前环境无法创建报告画布')
  const canvas = documentRef.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  return canvas
}

const nextImageFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => resolve())
    return
  }
  setTimeout(resolve, 16)
})

const loadLogoImage = async (logoUrl, ImageCtor = typeof Image !== 'undefined' ? Image : null) => {
  if (!logoUrl || !ImageCtor) return null
  const image = new ImageCtor()
  image.decoding = 'async'
  image.crossOrigin = 'anonymous'
  const loaded = new Promise((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('标识图加载失败'))
  })
  image.src = logoUrl
  const result = await loaded
  if (typeof result.decode === 'function') {
    try { await result.decode() } catch (e) { /* onload already proved the image is usable */ }
  }
  return result
}

const drawFallbackLogo = (context, x, y, width, alpha = 1) => {
  const height = width * FALLBACK_LOGO_HEIGHT_RATIO
  const markSize = height * 0.82
  const markY = y + (height - markSize) / 2
  context.save()
  context.globalAlpha = alpha
  context.fillStyle = '#086CEA'
  context.beginPath()
  if (typeof context.roundRect === 'function') context.roundRect(x, markY, markSize, markSize, markSize * 0.22)
  else context.rect(x, markY, markSize, markSize)
  context.fill()
  context.fillStyle = '#FFFFFF'
  context.font = `900 ${Math.round(markSize * 0.58)}px "PingFang SC", "Microsoft YaHei", sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText('报', x + markSize / 2, markY + markSize / 2)
  context.fillStyle = '#071B3D'
  context.font = `900 ${Math.round(height * 0.24)}px "PingFang SC", "Microsoft YaHei", sans-serif`
  context.textAlign = 'left'
  context.fillText('分析报告工作台', x + markSize * 1.28, y + height * 0.43)
  context.fillStyle = '#52627A'
  context.font = `700 ${Math.round(height * 0.17)}px "PingFang SC", "Microsoft YaHei", sans-serif`
  context.fillText('信用材料协同系统', x + markSize * 1.3, y + height * 0.72)
  context.restore()
  return height
}

const resolveLogoHeightRatio = (logo) => {
  if (!logo) return FALLBACK_LOGO_HEIGHT_RATIO
  const naturalWidth = finitePositive(logo.naturalWidth || logo.width, 360)
  const naturalHeight = finitePositive(logo.naturalHeight || logo.height, 96)
  return Math.min(
    MAX_LOGO_HEIGHT_RATIO,
    Math.max(MIN_LOGO_HEIGHT_RATIO, naturalHeight / naturalWidth)
  )
}

const drawLogo = (context, logo, x, y, width, alpha = 1) => {
  if (!logo) return drawFallbackLogo(context, x, y, width, alpha)
  const height = width * resolveLogoHeightRatio(logo)
  context.save()
  context.globalAlpha = alpha
  context.drawImage(logo, x, y, width, height)
  context.restore()
  return height
}

export function drawReportflowWatermark(canvas, logo = null, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('报告画布不可用')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('报告画布初始化失败')
  const width = finitePositive(canvas.width)
  const height = finitePositive(canvas.height)
  const markWidth = Math.max(190, Math.min(440, width * 0.26))
  const markHeight = markWidth * resolveLogoHeightRatio(logo)
  const xStep = Math.max(markWidth * 1.55, width * 0.46)
  const yStep = Math.max(markHeight * 3.2, width * 0.32)
  const opacity = Number.isFinite(Number(options.opacity)) ? Number(options.opacity) : 0.075
  let row = 0

  for (let y = markHeight * 1.4; y < height + markHeight; y += yStep) {
    const offset = row % 2 ? xStep * 0.48 : 0
    for (let x = -markWidth + offset; x < width + markWidth; x += xStep) {
      context.save()
      context.translate(x + markWidth / 2, y + markHeight / 2)
      context.rotate(-26 * Math.PI / 180)
      if (logo) context.globalCompositeOperation = 'multiply'
      drawLogo(context, logo, -markWidth / 2, -markHeight / 2, markWidth, opacity)
      context.restore()
    }
    row += 1
  }
  return canvas
}

const normalizePdfCardBoundaries = (boundaries, canvasHeight) => {
  if (!Array.isArray(boundaries)) return []
  const normalized = []
  const seen = new Set()

  boundaries.forEach((boundary) => {
    if (!boundary || typeof boundary !== 'object') return
    const rawTop = Number(boundary.topPx ?? boundary.top ?? boundary.offsetY)
    const rawBottom = Number(
      boundary.bottomPx ??
      boundary.bottom ??
      (Number.isFinite(rawTop) ? rawTop + Number(boundary.heightPx ?? boundary.height) : NaN)
    )
    if (!Number.isFinite(rawTop) || !Number.isFinite(rawBottom)) return
    const topPx = Math.max(0, Math.min(canvasHeight, Math.floor(rawTop)))
    const bottomPx = Math.max(0, Math.min(canvasHeight, Math.ceil(rawBottom)))
    if (bottomPx <= topPx) return
    const key = `${topPx}:${bottomPx}`
    if (seen.has(key)) return
    seen.add(key)
    normalized.push({ topPx, bottomPx })
  })

  return normalized.sort((left, right) => left.topPx - right.topPx || right.bottomPx - left.bottomPx)
}

const rewindPdfBreakBeforeCards = (offsetY, proposedEndY, maximumSliceHeightPx, cardBoundaries) => {
  let breakY = proposedEndY

  // Rewind repeatedly because overlapping or nested cards can reveal an earlier
  // boundary after the first card is moved to the next page.
  for (let pass = 0; pass < cardBoundaries.length; pass += 1) {
    let earlierTop = breakY
    cardBoundaries.forEach((card) => {
      const cardHeight = card.bottomPx - card.topPx
      const crossesBreak = card.topPx < breakY && card.bottomPx > breakY
      const canFitOnOnePage = cardHeight <= maximumSliceHeightPx
      const isRoundingOverlapAtRewoundBreak = breakY < proposedEndY &&
        card.bottomPx - breakY <= PDF_REWOUND_BREAK_TOLERANCE_PX
      if (
        crossesBreak &&
        !isRoundingOverlapAtRewoundBreak &&
        canFitOnOnePage &&
        card.topPx > offsetY
      ) {
        earlierTop = Math.min(earlierTop, card.topPx)
      }
    })
    if (earlierTop >= breakY) break
    breakY = earlierTop
  }

  return breakY
}

const collectReportPdfCardBoundariesForLayout = (
  element,
  canvasWidth,
  canvasHeight,
  options = {},
  captureSize = null
) => {
  if (!element || typeof element.getBoundingClientRect !== 'function' || typeof element.querySelectorAll !== 'function') return []
  const rootRect = element.getBoundingClientRect()
  const measuredWidth = Math.max(1, Math.ceil(Math.max(Number(rootRect.width) || 0, Number(element.scrollWidth) || 0)))
  const measuredHeight = Math.max(1, Math.ceil(Math.max(Number(rootRect.height) || 0, Number(element.scrollHeight) || 0)))
  const captureWidth = finitePositive(captureSize?.width, measuredWidth)
  const captureHeight = finitePositive(captureSize?.height, measuredHeight)
  const scaleX = finitePositive(canvasWidth) / captureWidth
  const scaleY = finitePositive(canvasHeight) / captureHeight
  const selector = typeof options.pdfCardSelector === 'string' && options.pdfCardSelector.trim()
    ? options.pdfCardSelector.trim()
    : DEFAULT_PDF_CARD_SELECTOR
  const usesCustomSelector = selector !== DEFAULT_PDF_CARD_SELECTOR
  const rootTop = Number(rootRect.top) || 0
  const rootLeft = Number(rootRect.left) || 0
  const scrollTop = Number(element.scrollTop) || 0
  const scrollLeft = Number(element.scrollLeft) || 0
  const boundaries = []

  Array.from(element.querySelectorAll(selector)).forEach((node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return
    if (typeof node.closest === 'function' && node.closest('[data-report-export-exclude]')) return
    if (!usesCustomSelector) {
      const explicitlyMarked = typeof node.hasAttribute === 'function' && node.hasAttribute('data-report-pdf-card')
      const classNames = node.classList ? Array.from(node.classList) : String(node.className || '').split(/\s+/)
      const protectedByClass = classNames.some((className) => (
        /-card$/.test(className) || PDF_BREAK_AVOID_ITEM_CLASS_SET.has(className)
      ))
      if (!explicitlyMarked && !protectedByClass) return
    }
    const rect = node.getBoundingClientRect()
    const top = Number(rect.top)
    const bottom = Number(rect.bottom)
    const left = Number(rect.left)
    const right = Number(rect.right)
    if (![top, bottom].every(Number.isFinite) || bottom <= top) return
    if ([left, right].every(Number.isFinite) && right <= left) return

    const topPx = (top - rootTop + scrollTop) * scaleY
    const bottomPx = (bottom - rootTop + scrollTop) * scaleY
    const leftPx = (left - rootLeft + scrollLeft) * scaleX
    const rightPx = (right - rootLeft + scrollLeft) * scaleX
    if (rightPx <= 0 || leftPx >= finitePositive(canvasWidth)) return
    boundaries.push({ topPx, bottomPx })
  })

  return normalizePdfCardBoundaries(boundaries, finitePositive(canvasHeight))
}

export function collectReportPdfCardBoundaries(element, canvasWidth, canvasHeight, options = {}) {
  return collectReportPdfCardBoundariesForLayout(element, canvasWidth, canvasHeight, options)
}

export function planReportPdfSlices(canvasWidth, canvasHeight, options = {}) {
  const width = finitePositive(canvasWidth)
  const height = Math.max(1, Math.ceil(finitePositive(canvasHeight)))
  const pageWidthMm = finitePositive(options.pageWidthMm, PDF_PAGE_WIDTH_MM)
  const pageHeightMm = finitePositive(options.pageHeightMm, PDF_PAGE_HEIGHT_MM)
  const marginMm = finitePositive(options.marginMm, PDF_MARGIN_MM)
  const headerMm = finitePositive(options.headerMm, PDF_HEADER_MM)
  const footerMm = finitePositive(options.footerMm, PDF_FOOTER_MM)
  const contentWidthMm = pageWidthMm - marginMm * 2
  const contentHeightMm = pageHeightMm - marginMm - headerMm - footerMm
  const pixelsPerMm = width / contentWidthMm
  const maximumSliceHeightPx = Math.max(1, Math.floor(contentHeightMm * pixelsPerMm))
  const cardBoundaries = normalizePdfCardBoundaries(options.cardBoundaries, height)
  const slices = []
  let offsetY = 0

  while (offsetY < height) {
    const proposedEndY = Math.min(height, offsetY + maximumSliceHeightPx)
    const endY = proposedEndY < height
      ? rewindPdfBreakBeforeCards(offsetY, proposedEndY, maximumSliceHeightPx, cardBoundaries)
      : proposedEndY
    const heightPx = Math.max(1, endY - offsetY)
    slices.push({
      offsetY,
      heightPx,
      imageHeightMm: heightPx / pixelsPerMm
    })
    offsetY += heightPx
  }

  return {
    pageWidthMm,
    pageHeightMm,
    marginMm,
    headerMm,
    footerMm,
    contentWidthMm,
    contentHeightMm,
    maximumSliceHeightPx,
    slices
  }
}

export async function captureReportElement(element, options = {}) {
  if (!element || typeof element.getBoundingClientRect !== 'function') throw new Error('未找到可导出的报告内容')
  const rect = element.getBoundingClientRect()
  const width = Math.max(1, Math.ceil(Math.max(rect.width, element.scrollWidth || 0)))
  const height = Math.max(1, Math.ceil(Math.max(rect.height, element.scrollHeight || 0)))
  const scale = resolveReportCaptureScale(width, height, options.preferredScale || DEFAULT_CAPTURE_SCALE)
  const html2canvasImpl = options.html2canvasImpl || (await import('html2canvas')).default
  if (typeof html2canvasImpl !== 'function') throw new Error('报告截图组件加载失败')
  const expectedCanvasWidth = Math.max(1, Math.floor(width * scale))
  const expectedCanvasHeight = Math.max(1, Math.floor(height * scale))
  const shouldCollectPdfCards = String(options.format || '').trim().toLowerCase() === 'pdf' &&
    !Array.isArray(options.cardBoundaries)
  const callerOnclone = typeof options.onclone === 'function' ? options.onclone : null
  const callerIgnoreElements = typeof options.ignoreElements === 'function' ? options.ignoreElements : null
  let clonedCardBoundaries = null

  try {
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) await document.fonts.ready
  } catch (e) { /* continue with available fonts */ }
  await nextImageFrame()

  const canvas = await html2canvasImpl(element, {
    backgroundColor: options.backgroundColor || '#F5F8FE',
    scale,
    width,
    height,
    windowWidth: Math.max(width, typeof document !== 'undefined' ? document.documentElement.clientWidth : width),
    windowHeight: Math.max(height, typeof document !== 'undefined' ? document.documentElement.clientHeight : height),
    useCORS: true,
    allowTaint: false,
    imageTimeout: 15000,
    logging: false,
    removeContainer: true,
    ignoreElements: (node) => {
      const excludedFromReport = !!(
        node &&
        typeof node.hasAttribute === 'function' &&
        node.hasAttribute('data-report-export-exclude')
      )
      return excludedFromReport || !!(callerIgnoreElements && callerIgnoreElements(node))
    },
    onclone: async (clonedDocument, clonedElement) => {
      if (callerOnclone) await callerOnclone(clonedDocument, clonedElement)
      if (!shouldCollectPdfCards) return
      clonedCardBoundaries = collectReportPdfCardBoundariesForLayout(
        clonedElement,
        expectedCanvasWidth,
        expectedCanvasHeight,
        options,
        { width, height }
      )
    }
  })

  if (clonedCardBoundaries && canvas && (typeof canvas === 'object' || typeof canvas === 'function')) {
    const scaleY = finitePositive(canvas.height) / expectedCanvasHeight
    const boundaries = clonedCardBoundaries.map((boundary) => ({
      topPx: boundary.topPx * scaleY,
      bottomPx: boundary.bottomPx * scaleY
    }))
    capturedPdfCardBoundaries.set(canvas, normalizePdfCardBoundaries(boundaries, finitePositive(canvas.height)))
  }

  return canvas
}

const canvasToBlob = (canvas, mimeType, quality) => new Promise((resolve, reject) => {
  if (!canvas || typeof canvas.toBlob !== 'function') {
    reject(new Error('当前浏览器无法生成下载文件'))
    return
  }
  canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new Error('报告文件编码失败'))
  }, mimeType, quality)
})

const createOpaqueCanvas = (source, createCanvas = createBrowserCanvas) => {
  const canvas = createCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('JPG 画布初始化失败')
  context.fillStyle = '#FFFFFF'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0)
  return canvas
}

const createPdfLogoData = (logo, createCanvas = createBrowserCanvas) => {
  const heightRatio = resolveLogoHeightRatio(logo)
  const canvas = createCanvas(720, Math.max(1, Math.round(720 * heightRatio)))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('PDF Logo 画布初始化失败')
  context.clearRect(0, 0, canvas.width, canvas.height)
  drawLogo(context, logo, 0, 0, canvas.width, 0.86)
  return {
    data: canvas.toDataURL('image/png'),
    heightRatio
  }
}

export async function buildReportPdfBlob(canvas, logo = null, options = {}) {
  if (!canvas || !canvas.width || !canvas.height) throw new Error('报告画布内容为空')
  const jsPDFImpl = options.jsPDFImpl || (await import('jspdf')).jsPDF
  if (typeof jsPDFImpl !== 'function') throw new Error('PDF 组件加载失败')
  const createCanvas = options.createCanvas || createBrowserCanvas
  const plan = planReportPdfSlices(canvas.width, canvas.height, options)
  const pdf = new jsPDFImpl({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
    putOnlyUsedFonts: true
  })
  const logoAsset = createPdfLogoData(logo, createCanvas)

  plan.slices.forEach((slice, index) => {
    if (index > 0) pdf.addPage('a4', 'portrait')
    const pageCanvas = createCanvas(canvas.width, slice.heightPx)
    const context = pageCanvas.getContext('2d')
    if (!context) throw new Error('PDF 分页画布初始化失败')
    context.fillStyle = '#FFFFFF'
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    context.drawImage(
      canvas,
      0,
      slice.offsetY,
      canvas.width,
      slice.heightPx,
      0,
      0,
      pageCanvas.width,
      pageCanvas.height
    )
    const pageData = pageCanvas.toDataURL('image/jpeg', 0.92)
    const maximumLogoWidthMm = 45
    const maximumLogoHeightMm = Math.max(1, plan.headerMm - 2.4)
    const logoWidthMm = Math.min(maximumLogoWidthMm, maximumLogoHeightMm / logoAsset.heightRatio)
    const logoHeightMm = logoWidthMm * logoAsset.heightRatio
    const logoY = Math.max(1.2, (plan.headerMm - logoHeightMm) / 2)
    pdf.addImage(
      logoAsset.data,
      'PNG',
      plan.pageWidthMm - plan.marginMm - logoWidthMm,
      logoY,
      logoWidthMm,
      logoHeightMm,
      undefined,
      'FAST'
    )
    pdf.addImage(pageData, 'JPEG', plan.marginMm, plan.headerMm, plan.contentWidthMm, slice.imageHeightMm, undefined, 'FAST')
    pdf.setDrawColor(219, 234, 254)
    pdf.line(plan.marginMm, plan.pageHeightMm - plan.footerMm, plan.pageWidthMm - plan.marginMm, plan.pageHeightMm - plan.footerMm)
    pdf.setTextColor(82, 98, 122)
    pdf.setFontSize(8)
    pdf.text(`Page ${index + 1} / ${plan.slices.length}`, plan.pageWidthMm - plan.marginMm, plan.pageHeightMm - 3.5, { align: 'right' })
  })

  return {
    blob: pdf.output('blob'),
    pageCount: plan.slices.length
  }
}

export function triggerReportDownload(blob, filename, options = {}) {
  const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null)
  const urlRef = options.urlRef || (typeof URL !== 'undefined' ? URL : null)
  if (!blob || !documentRef || !urlRef || typeof urlRef.createObjectURL !== 'function') {
    throw new Error('当前环境无法下载报告文件')
  }
  const objectUrl = urlRef.createObjectURL(blob)
  const anchor = documentRef.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  documentRef.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => urlRef.revokeObjectURL(objectUrl), 1200)
}

export async function exportReportElement(element, options = {}) {
  const definition = resolveReportExportFormat(options.format)
  const filename = buildReportExportFilename(options.fileBaseName, definition.key)
  const captureImpl = options.captureImpl || captureReportElement
  const captured = await captureImpl(element, options)
  let logo = null
  try {
    logo = await loadLogoImage(options.logoUrl, options.ImageCtor)
  } catch (e) {
    // The vector asset is preferred, but the built-in brand lockup still
    // guarantees that every completed export contains a visible Logo.
    logo = null
  }
  drawReportflowWatermark(captured, logo, options.watermark)

  let blob
  let pageCount = 1
  if (definition.key === 'pdf') {
    const clonedCardBoundaries = capturedPdfCardBoundaries.get(captured)
    const cardBoundaries = Array.isArray(options.cardBoundaries)
      ? options.cardBoundaries
      : Array.isArray(clonedCardBoundaries)
        ? clonedCardBoundaries
        : collectReportPdfCardBoundaries(element, captured.width, captured.height, options)
    const pdfResult = await buildReportPdfBlob(captured, logo, { ...options, cardBoundaries })
    blob = pdfResult.blob
    pageCount = pdfResult.pageCount
  } else if (definition.key === 'jpg') {
    const opaque = createOpaqueCanvas(captured, options.createCanvas || createBrowserCanvas)
    blob = await canvasToBlob(opaque, definition.mimeType, 0.92)
  } else {
    blob = await canvasToBlob(captured, definition.mimeType)
  }

  const downloadImpl = options.downloadImpl || triggerReportDownload
  downloadImpl(blob, filename, options)
  return {
    filename,
    mimeType: definition.mimeType,
    pageCount,
    width: captured.width,
    height: captured.height,
    blob
  }
}

export default {
  REPORT_EXPORT_FORMATS,
  resolveReportCaptureScale,
  sanitizeReportExportBaseName,
  resolveReportExportFormat,
  buildReportExportFilename,
  drawReportflowWatermark,
  collectReportPdfCardBoundaries,
  planReportPdfSlices,
  captureReportElement,
  buildReportPdfBlob,
  triggerReportDownload,
  exportReportElement
}
