/**
 * AI 征信分析引擎 v5.0（混合核心）+ 征信算法核心 v3（分层流水线）—— 公共门面
 *
 * 2026-05 拆分：本文件从 1600+ 行拆为 services/aiAnalysis/ 下的内聚子模块，
 * 对外签名（analyzeCreditReport / getAnalysisResult / AnalysisStatus /
 * ScoreDimensions / FOUR_DIM_WEIGHTS / default）保持完全不变。
 *
 *   services/aiAnalysis/
 *     ├─ constants.js   调试开关 + AnalysisStatus / ScoreDimensions
 *     ├─ dimensions.js  20+ 维度计算 + AI/正则融合（merge / fuse / visionAI / 稀疏判定）
 *     ├─ scoring.js     四维评分 + 加权综合分 + AI 兜底分归一化
 *     ├─ behavior.js    行为画像 + 马尔可夫债务演化
 *     ├─ report.js      时间轴推演 + 最终报告组装
 *     └─ pipeline.js    主流程编排（analyzeCreditReport）
 *
 * v5.0 策略 ——「确定性数值核心 + AI 语义层」：主数值默认来自正则结构化 +
 * enrichDimensions（与 creditAlgorithmCore.buildAlgorithmReport 同源），AI 仅做
 * 语义解读与弱信号数值救援；四维评分仅基于最终 dimensions 的 scoreFourDimensions。
 *
 * 四维评分维度（展示层）：信用历史 / 查询频率 / 账户结构 / 还款记录
 */

import { analyzeCreditReport, resumeCreditAnalysisJob } from './aiAnalysis/pipeline.js'
import { AnalysisStatus, ScoreDimensions } from './aiAnalysis/constants.js'

export { analyzeCreditReport, resumeCreditAnalysisJob } from './aiAnalysis/pipeline.js'
export { AnalysisStatus, ScoreDimensions } from './aiAnalysis/constants.js'

/**
 * 加权综合分权重（四维；总和 = 1，演示配置，不代表任何机构的真实授信规则）
 *
 * ⚠️ 必须与 ai-proxy/creditRuleEngine.js 的 FOUR_DIM_WEIGHTS 完全一致；
 *    strict-gate 的 consistency:six-dim-weights-sync 会以正则读取**本文件**做不变量校验，
 *    因此该字面量必须物理保留在 services/aiAnalysis.js（scoring.js 在运行期引用其值）。
 */
export const FOUR_DIM_WEIGHTS = {
	repayment_record:  0.33,
	credit_history:    0.27,
	account_structure: 0.24,
	query_frequency:   0.16
}

export default {
	analyzeCreditReport,
	resumeCreditAnalysisJob,
	AnalysisStatus,
	ScoreDimensions
}
