/**
 * aiAnalysis 内部：四维评分（v6/v7）
 *
 *   · scoreRepaymentRecord：还款记录（逾期）— 扣分阶梯为演示配置
 *   · applyOverdueTotalCap：严重逾期对页头综合分设硬上限
 *   · scoreFourDimensions：四维评分（信用历史/查询频率/账户结构/还款记录）
 *   · calculateTotalScore：加权综合分（权重见 FOUR_DIM_WEIGHTS）
 *   · normalizeAdvisoryScores：AI 四维兜底分归一化
 *
 * 说明：FOUR_DIM_WEIGHTS 的权威字面量仍保留在 services/aiAnalysis.js（门禁
 *       consistency:six-dim-weights-sync 以正则读取该文件文本做双端校验）；
 *       运行期从 creditAlgorithmCore 读取同源常量，避免加载公共门面时拉起 pipeline。
 *
 * ⚠️ 2026-06 重构：scoreFourDimensions 算法本身已从此文件移除，
 *    改为从 creditAlgorithmCore（单一真相源）导入并映射中文 key。
 *    修改评分公式时只需改 creditAlgorithmCore.js 一处。
 */

import { ScoreDimensions, dlog } from './constants.js'
import { FOUR_DIM_WEIGHTS } from '../creditAlgorithmCore.js'

// ─────────────────────────────────────────────
// v6/v7：评分核心函数 —— 从 creditAlgorithmCore（单一真相源）导入并重导出。
// 避免同一段扣分逻辑在多个文件中复制粘贴导致口径不一致。
// ─────────────────────────────────────────────
export {
	scoreRepaymentRecord,
	applyOverdueTotalCap
} from '../creditAlgorithmCore.js'

import { scoreFourDimensions as _scoreFourDimensionsCore } from '../creditAlgorithmCore.js'

/** 中文 key → 英文 key（供 calculateTotalScore 归一化） */
const ZH_TO_EN = {
	[ScoreDimensions.CREDIT_HISTORY]:    'credit_history',
	[ScoreDimensions.QUERY_FREQUENCY]:   'query_frequency',
	[ScoreDimensions.ACCOUNT_STRUCTURE]: 'account_structure',
	[ScoreDimensions.REPAYMENT_RECORD]:  'repayment_record'
}

// ─────────────────────────────────────────────
// 四维评分（v6/v7，单一真相源：creditAlgorithmCore.scoreFourDimensions）
//
//   算法仅在 creditAlgorithmCore.js 中维护；本函数是薄包装层：
//     1. 调用核心算法获取英文 key 结果
//     2. 映射为中文 key 供 pipeline / report / UI 消费
//     3. 保留 dlog 调试输出
// ─────────────────────────────────────────────
export const scoreFourDimensions = (dim) => {
	const four = _scoreFourDimensionsCore(dim)
	const scores = {
		[ScoreDimensions.CREDIT_HISTORY]:    four.credit_history,
		[ScoreDimensions.QUERY_FREQUENCY]:   four.query_frequency,
		[ScoreDimensions.ACCOUNT_STRUCTURE]: four.account_structure,
		[ScoreDimensions.REPAYMENT_RECORD]:  four.repayment_record
	}
	dlog('[aiAnalysis] 四维评分:', scores)
	return scores
}

// ─────────────────────────────────────────────
// 总分计算（加权平均；权重见 FOUR_DIM_WEIGHTS）
// 同时兼容中文 key 和英文 key 输入
// ─────────────────────────────────────────────
export const calculateTotalScore = (scores) => {
	let total = 0
	let weightSum = 0
	for (const [dim, score] of Object.entries(scores)) {
		// 优先英文 key 直配，否则查中文→英文映射表
		const en = FOUR_DIM_WEIGHTS[dim] != null ? dim : (ZH_TO_EN[dim] || null)
		const w = en ? (FOUR_DIM_WEIGHTS[en] || 0) : 0
		if (w <= 0) continue
		// 缺失/不可评维度（如白户无还款历史 → repayment_record=null）按 0 贡献计入，**不 re-normalize 抬分**。
		// 与后端 creditRuleEngine._buildScoreBreakdown 及 creditAlgorithmCore.composeFourDimTotal 严格对齐：
		// 三处都是「∑(value×weight)」直接求和（权重和=1），缺失维度不补权重、不除以 weightSum，
		// 否则白户时间轴综合分会被抬高约 1 倍、与主评分框架(assessment.score)自相矛盾。
		// weightSum 仅用于判断「是否至少一维可算」，不参与归一化。
		const num = Number(score)
		if (score == null || Number.isNaN(num)) continue
		total += num * w
		weightSum += w
	}
	if (weightSum <= 0) return 0
	return Math.round(total)
}

export const normalizeAdvisoryScores = (advisory) => {
	// v7：无保底分。缺失 → null（UI 显示「—」），不再垫 60/70
	const safe = (v) => {
		const n = typeof v === 'number' ? v : parseFloat(v)
		if (!isFinite(n) || isNaN(n)) return null
		return Math.max(0, Math.min(100, Math.round(n)))
	}
	// v5：仅保留四维；AI 给出的偿债能力/负债比例不再回填到结构化 scores
	return {
		[ScoreDimensions.CREDIT_HISTORY]:    safe(advisory?.['信用历史'] ?? advisory?.credit_history),
		[ScoreDimensions.QUERY_FREQUENCY]:   safe(advisory?.['查询频率'] ?? advisory?.query_frequency),
		[ScoreDimensions.ACCOUNT_STRUCTURE]: safe(advisory?.['账户结构'] ?? advisory?.account_structure),
		[ScoreDimensions.REPAYMENT_RECORD]:  safe(advisory?.['还款记录'] ?? advisory?.repayment_record)
	}
}
