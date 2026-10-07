import { strictFiniteNumberOrNull } from '../utils/strictNumber.js'

/**
 * 征信风险等级统一配置（全站单一事实来源）
 *
 * 枚举值（与服务层 / 后端 report.riskLevel 一致）：
 *   low / medium-low / medium / high
 *
 * 提供两套语境标签，避免各页文案口径不一致：
 *   - creditLabel：信用维度，用于「概览/评分」类展示（首页、我的、匹配评分面板）
 *   - riskLabel  ：风险维度，用于「风险/列表」类展示（我的报告列表、报告详情风险等级、上传结果标签）
 *
 * 颜色为全站统一色值，请勿在页面内再硬编码等级色值。
 */

export const RISK_LEVEL_META = {
	low: {
		creditLabel: '信用优秀',
		riskLabel: '低风险',
		color: '#22C55E',
		textColor: '#16A34A',
		bgColor: '#F0FDF4',
		hint: '建议维持',
		matchTop: 'Top 5%'
	},
	'medium-low': {
		creditLabel: '信用良好',
		riskLabel: '中低风险',
		color: '#3B82F6',
		textColor: '#2563EB',
		bgColor: '#EFF6FF',
		hint: '继续保持',
		matchTop: 'Top 20%'
	},
	medium: {
		creditLabel: '信用一般',
		riskLabel: '中风险',
		color: '#F59E0B',
		textColor: '#D97706',
		bgColor: '#FFFBEB',
		hint: '建议持续优化',
		matchTop: 'Top 50%'
	},
	high: {
		creditLabel: '需要改善',
		riskLabel: '高风险',
		color: '#EF4444',
		textColor: '#DC2626',
		bgColor: '#FEF2F2',
		hint: '建议优先处理',
		matchTop: 'Top 80%'
	}
}

export const RISK_LEVEL_UNKNOWN = {
	creditLabel: '待评估',
	riskLabel: '待评估',
	color: '#9CA3AF',
	textColor: '#9CA3AF',
	bgColor: '#F3F4F6',
	hint: '上传报告后评估',
	matchTop: '--'
}

const FALLBACK = RISK_LEVEL_META.medium

export function normalizeRiskLevel(lv) {
	if (lv === 'low' || lv === 'medium-low' || lv === 'medium' || lv === 'high') return lv
	return 'unknown'
}

export function getRiskMeta(lv) {
	if (normalizeRiskLevel(lv) === 'unknown') return RISK_LEVEL_UNKNOWN
	return RISK_LEVEL_META[lv] || FALLBACK
}

/**
 * 风险等级只由已经通过可审计门禁的最终分数确定。调用方必须先验证
 * decisionEligible；旧报告保存的 riskLevel 不再单独进入展示或决策。
 */
export function riskLevelFromDecisionScore(score) {
	const n = strictFiniteNumberOrNull(score)
	if (n == null || n < 0 || n > 100) return 'unknown'
	if (n < 60) return 'high'
	if (n < 80) return 'medium'
	return 'low'
}

export function resolveDisplayRiskLevel(_lv, score, _scoreSource = '') {
	return riskLevelFromDecisionScore(score)
}

/**
 * 综合评分配色（全站统一，单一事实来源）：
 *   < 50      → 红色  #F43F5E
 *   50-70     → 黄色  #F5B400
 *   > 70      → 蓝色  #0A7BF5
 *   无评分/无效 → 灰色（待评估）
 * @param {number|string|null|undefined} score 0-100 综合分
 */
export function getScoreColor(score) {
	if (score == null) return RISK_LEVEL_UNKNOWN.color
	const n = strictFiniteNumberOrNull(score)
	if (n == null || n < 0 || n > 100) return RISK_LEVEL_UNKNOWN.color
	if (n < 50) return '#F43F5E'
	if (n <= 70) return '#F5B400'
	return '#0A7BF5'
}

export function getCreditLabel(lv) { return getRiskMeta(lv).creditLabel }
export function getRiskLabel(lv) { return getRiskMeta(lv).riskLabel }
export function getRiskColor(lv) { return getRiskMeta(lv).color }
export function getRiskTextColor(lv) { return getRiskMeta(lv).textColor }
export function getRiskBgColor(lv) { return getRiskMeta(lv).bgColor }
export function getRiskHint(lv) { return getRiskMeta(lv).hint }
export function getMatchTop(lv) { return getRiskMeta(lv).matchTop }

export default {
	RISK_LEVEL_META,
	RISK_LEVEL_UNKNOWN,
	normalizeRiskLevel,
	riskLevelFromDecisionScore,
	resolveDisplayRiskLevel,
	getRiskMeta,
	getScoreColor,
	getCreditLabel,
	getRiskLabel,
	getRiskColor,
	getRiskTextColor,
	getRiskBgColor,
	getRiskHint,
	getMatchTop
}
