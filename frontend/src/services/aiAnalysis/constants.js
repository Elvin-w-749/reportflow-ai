/**
 * aiAnalysis 内部共享：调试开关 + 枚举常量
 *
 * 本模块为 services/aiAnalysis.js 拆分后的叶子模块（无内部依赖），
 * 供 dimensions / scoring / behavior / report / pipeline 复用。
 */

/**
 * 调试日志开关：生产构建中关闭以避免敏感数据泄露，开发版本默认输出便于联调。
 * 通过 Vite define 注入 __RPT_PROD__；未注入时视为开发态。
 */
// eslint-disable-next-line no-undef
const __AI_DEBUG__ = typeof __RPT_PROD__ !== 'undefined' ? !__RPT_PROD__ : true

export const dlog = (...args) => { if (__AI_DEBUG__) console.log(...args) }

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────
export const AnalysisStatus = {
	PENDING:           'pending',
	FILE_PARSING:      'file_parsing',
	OCR_PROCESSING:    'ocr_processing',
	EXTRACTING:        'extracting',
	DIMENSION_CALC:    'dimension_calc',
	SCORING:           'scoring',
	COMPLETED:         'completed',
	ERROR:             'error'
}

/**
 * 评分维度（v5：四维制；移除 偿债能力 / 负债比例）
 * REPAYMENT_ABILITY / DEBT_RATIO 保留为枚举占位以兼容历史调用方，
 * 但 scoreFourDimensions 不再输出它们，calculateTotalScore 也不再参与加权。
 */
export const ScoreDimensions = {
	CREDIT_HISTORY:    '信用历史',
	QUERY_FREQUENCY:   '查询频率',
	ACCOUNT_STRUCTURE: '账户结构',
	REPAYMENT_RECORD:  '还款记录',
	REPAYMENT_ABILITY: '偿债能力',
	DEBT_RATIO:        '负债比例'
}
