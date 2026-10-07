import { resolveV6TotalFromAnalysis } from './scoreV6.js'

const objectValue = (value) =>
	value && typeof value === 'object' && !Array.isArray(value) ? value : {}

const hasOwnAny = (value, keys) => {
	const source = objectValue(value)
	return keys.some((key) => Object.prototype.hasOwnProperty.call(source, key))
}

const hasNonBlankValue = (value, keys) => {
	const source = objectValue(value)
	return keys.some((key) => {
		const item = source[key]
		return item !== undefined && item !== null && String(item).trim() !== ''
	})
}

const hasRows = (values) => values.some((value) => Array.isArray(value) && value.length > 0)

/**
 * 判断一份 analysisData 是否包含可展示的真实分析证据。
 * 仅有 report/dimensions 空壳、默认快照或流水线版本号不算成功分析。
 */
export const hasMeaningfulAnalysisData = (analysisData) => {
	if (!analysisData || typeof analysisData !== 'object' || Array.isArray(analysisData)) return false
	if (resolveV6TotalFromAnalysis(analysisData) != null) return true

	const report = objectValue(analysisData.report)
	const ai = objectValue(analysisData.aiInsight)
	const kimi = objectValue(analysisData.kimiInsight)
	const cv2Candidates = [
		analysisData.cv2,
		analysisData.creditReportV2,
		analysisData.credit_report_v2,
		analysisData.credit_report_full
	].map(objectValue)
	const frontendCandidates = [
		analysisData.frontendPayload,
		analysisData.frontend_payload
	].map(objectValue)

	if (hasRows([
		analysisData.accounts,
		analysisData.creditAccounts,
		report.creditAccounts,
		analysisData.overdueRecords,
		report.overdueRecords,
		analysisData.queryItems,
		analysisData.queryRecords?.queryItems,
		report.queryRecords?.queryItems,
		ai.credit_accounts,
		kimi.credit_accounts,
		...cv2Candidates.flatMap((cv2) => [
			cv2.credit_card_details,
			cv2.loan_details?.bank_loans,
			cv2.loan_details?.non_bank_loans,
			cv2.overdueRecords,
			cv2.overdue_records,
			cv2.overdue_info?.records,
			cv2.overdue_info?.details
		]),
		...frontendCandidates.flatMap((frontend) => [
			frontend.accounts,
			frontend.overdueRecords,
			frontend.overdue_records
		])
	])) return true

	const basicInfoCandidates = [
		analysisData.basicInfo,
		analysisData.basic_info,
		report.basicInfo,
		report.basic_info,
		...cv2Candidates.flatMap((cv2) => [cv2.basicInfo, cv2.basic_info]),
		...frontendCandidates.flatMap((frontend) => [frontend.basicInfo, frontend.basic_info])
	]
	if (basicInfoCandidates.some((info) => hasNonBlankValue(info, [
		'name', 'real_name', 'customer_name', 'idCard', 'id_card', 'id_last4',
		'reportDate', 'report_date', 'report_time'
	]))) return true

	const dimensionKeys = [
		'totalAccountCount', 'activeAccountCount', 'creditCardCount', 'loanCount',
		'nonBankLoanCount', 'totalDebt', 'totalLoanBalance', 'totalCreditLine',
		'usedCardLimit', 'cardUtilizationRate', 'q1', 'q3', 'q6', 'q12',
		'overdueCount', 'm1Count', 'm2Count', 'm3Count'
	]
	if ([
		analysisData.dimensions,
		report.dimensions,
		...cv2Candidates.map((cv2) => cv2.dimensions),
		...frontendCandidates.map((frontend) => frontend.dimensions)
	].some((dimensions) => hasOwnAny(dimensions, dimensionKeys))) return true

	if ([
		analysisData.debt_summary,
		analysisData.overdue_summary,
		analysisData.query_records,
		analysisData.account_overview,
		analysisData.credit_debt,
		ai.debt_summary,
		kimi.debt_summary
	].some((value) => Object.keys(objectValue(value)).length > 0)) return true

	if (hasRows([
		report.suggestions,
		report.riskTags,
		report.keyFindings,
		analysisData.suggestions,
		analysisData.riskTags,
		analysisData.risk_tags
	])) return true

	const summary = String(
		report.summary ||
		analysisData.summary ||
		analysisData.suggestion ||
		ai.summary ||
		kimi.summary ||
		''
	).trim()
	return !!summary && ![
		'暂无有效分析摘要',
		'服务端已返回分析数据',
		'信用报告已读取并完成结构化分析'
	].includes(summary)
}

export default { hasMeaningfulAnalysisData }
