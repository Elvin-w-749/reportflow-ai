export const FAST_PDF_OWNERSHIP_EVIDENCE_MISSING = 'OCR_OWNERSHIP_EVIDENCE_MISSING'

const meaningfulText = (value) => {
	const text = String(value == null ? '' : value).replace(/\s+/g, '').trim()
	if (!text || /^(?:未知|未识别|无|暂无|N\/?A|null|undefined|-+)$/i.test(text)) return ''
	return text
}

const identityLast4 = (basicInfo = {}) => {
	const candidates = [
		basicInfo.idLast4,
		basicInfo.id_last4,
		basicInfo.idCard,
		basicInfo.id_card
	]
	for (const value of candidates) {
		const normalized = String(value == null ? '' : value).replace(/[^\dXx]/g, '').toUpperCase()
		if (normalized.length >= 4) return normalized.slice(-4)
	}
	return ''
}

export const missingFastPdfOwnershipEvidence = (analysis = {}) => {
	const basicInfo = analysis && typeof analysis.basicInfo === 'object' && analysis.basicInfo
		? analysis.basicInfo
		: {}
	const missing = []
	if (!meaningfulText(basicInfo.name)) missing.push('name')
	if (!identityLast4(basicInfo)) missing.push('identity')
	return missing
}

export const assertFastPdfOwnershipEvidence = (analysis = {}) => {
	const missingEvidence = missingFastPdfOwnershipEvidence(analysis)
	if (!missingEvidence.length) return analysis

	const error = new Error('分析服务未完整返回报告归属识别结果')
	error.code = FAST_PDF_OWNERSHIP_EVIDENCE_MISSING
	error.missingEvidence = missingEvidence
	throw error
}

export const isFastPdfOwnershipEvidenceFailure = (error) =>
	String(error && error.code || '').toUpperCase() === FAST_PDF_OWNERSHIP_EVIDENCE_MISSING

export default {
	FAST_PDF_OWNERSHIP_EVIDENCE_MISSING,
	missingFastPdfOwnershipEvidence,
	assertFastPdfOwnershipEvidence,
	isFastPdfOwnershipEvidenceFailure
}
