/**
 * 本地智能匹配引擎 v2.0
 *
 * 与登录后的服务端匹配接口共用 services/matchCore.js 的画像与打分逻辑，
 * 保证「同一用户、同一报告」在前端本地预览与登录后云端结果一致（在规则相同的前提下）。
 *
 * 算法输入优先级：
 *   dimensions + report + algorithmReport（v2 负债/查询/机构）+ compositeMeta
 */

import {
	buildUnifiedMatchProfile,
	explainMatchGaps,
	rankProductsByMatch,
	scoreProductsByMatch
} from './matchCore.js'
import {
	buildSupplementMaterialProfile,
	canMatchProductsWithSupplementProfile,
	enrichAnalysisWithSupplementMaterials
} from './supplementMaterialService.js'

/**
 * 内置产品库（覆盖各类用户场景）
 *
 * ⚠️ 单一数据源：shared/productLibrary.json
 *   前后端（services/matchEngine.js 与 ai-proxy/backend/services/productLibrary.js）
 *   均从此文件读取，改产品时只需改一处。
 */
import PRODUCT_LIBRARY from '@/shared/productLibrary.json'

// ─────────────────────────────────────────────
// 核心匹配函数
// ─────────────────────────────────────────────
/**
 * @param {Object} reportData - 征信分析结果（与云端 analysisResult 同构）
 */
export const localMatchProducts = (reportData, decisionTrust = null) => {
	if (!reportData) return []

	const enriched = enrichAnalysisWithSupplementMaterials(reportData)
	if (!canMatchProductsWithSupplementProfile(enriched.supplementProfile)) return []
	const profile = buildUnifiedMatchProfile({ analysisData: enriched.analysisData, decisionTrust })
	const result = rankProductsByMatch(PRODUCT_LIBRARY, profile, { minRate: 30, limit: 6 })
	return result
}

export const localMatchProductsWithDiagnostics = (reportData, decisionTrust = null) => {
	const supplementProfile = buildSupplementMaterialProfile()
	if (!reportData) {
		return {
			hasReport: false,
			products: [],
			profile: null,
			supplementProfile,
			explanation: {
				severity: 'empty',
				title: '先上传信用报告',
				summary: '上传后先查看征信问题；再确认三金、个税、学历和资产情况，系统会按真实条件匹配。',
				reasons: ['暂未读取到有效信用报告'],
				nextActions: ['上传信用报告', '有材料就上传，没有就选择暂无']
			},
			usedDefault: true
		}
	}

	const enriched = enrichAnalysisWithSupplementMaterials(reportData)
	const profile = buildUnifiedMatchProfile({ analysisData: enriched.analysisData, decisionTrust })
	const scoredProducts = scoreProductsByMatch(PRODUCT_LIBRARY, profile)
	if (!canMatchProductsWithSupplementProfile(enriched.supplementProfile)) {
		return {
			hasReport: true,
			products: [],
			profile,
			supplementProfile: enriched.supplementProfile,
			explanation: buildMaterialGateNotice(profile, enriched.supplementProfile, scoredProducts),
			usedDefault: false,
			productGateLocked: true
		}
	}
	const products = scoredProducts.filter((p) => p.isMatch === true && p.matchRate > 30).slice(0, 6)
	const explanation = products.length < 3 || (products[0] && products[0].matchRate < 60)
		? explainMatchGaps(profile, scoredProducts, products)
		: null

	return {
		hasReport: true,
		products,
		profile,
		supplementProfile: enriched.supplementProfile,
		explanation,
		usedDefault: false
	}
}

function addUnique(list, text) {
	if (!text || list.includes(text)) return
	list.push(text)
}

function buildMaterialGateNotice(profile, supplementProfile = {}, scoredProducts = []) {
	const reasons = []
	const nextActions = []
	if (profile.hasLianSan || profile.hasLeiLiu) addUnique(reasons, '存在连三或累六等严重逾期，先处理风险再申请更稳')
	else if (profile.hasOverdue) addUnique(reasons, '存在逾期记录，直接申请纯信用产品通过率会下降')
	if (profile.totalScore > 0 && profile.totalScore < 55) addUnique(reasons, '综合评分偏低，需要先养护征信')
	if (profile.debtRatioPct > 80) addUnique(reasons, '负债率偏高，建议先降低月供或优化负债结构')
	if (profile.q3Known === true && profile.q3 > 10) addUnique(reasons, '近 3 个月查询偏多，短期申请过密')
	if (profile.nonBankLoanRatioKnown === true && profile.nonBankLoanRatio > 0.4) addUnique(reasons, '非银贷款占比较高，银行系产品会更谨慎')
	if (!reasons.length) addUnique(reasons, '征信报告已读取，当前先展示问题与风险，不直接展示产品')
	const missing = Array.isArray(supplementProfile.productUnlockMissing) ? supplementProfile.productUnlockMissing : []
	if (missing.length) addUnique(nextActions, `请先确认${missing.join('、')}；有就上传，没有就选择暂无`)
	addUnique(nextActions, '确认材料情况后，系统会重新计算收入稳定性、资产背书和产品适配度')
	addUnique(nextActions, '材料未确认前，可先处理征信风险项，减少无效申请和新增查询')
	const bestRate = scoredProducts.length ? Number(scoredProducts[0].matchRate || 0) : 0
	return {
		severity: 'locked',
		title: '已读取征信问题，待确认材料情况',
		summary: `仅凭征信报告不能直接精准匹配产品。当前材料进度 ${supplementProfile.unlockProgressText || '0/4'}，确认材料有无后再开放方案${bestRate ? '和排序' : ''}。`,
		reasons: reasons.slice(0, 5),
		nextActions: nextActions.slice(0, 5),
		productGateLocked: true
	}
}

// ─────────────────────────────────────────────
// 默认推荐（无报告时）
// ─────────────────────────────────────────────
/**
 * 默认推荐条目（编码 + 展示匹配度）。
 *
 * 编码必须在 shared/productLibrary.json 里唯一命中。查不到时直接抛错，
 * 不再按数组下标取别的条目兜底 —— 兜底不会报错，但会把错误的产品当成
 * 默认推荐展示出来，是最难被发现的一类坏法。
 */
const DEFAULT_PRODUCT_ENTRIES = [
	{ id: 'rf_bank_007', matchRate: 82 },
	{ id: 'rf_bank_003', matchRate: 75 },
	{ id: 'rf_bank_005', matchRate: 68 },
	{ id: 'rf_cf_001', matchRate: 62 }
]

const getDefaultProducts = () => {
	const products = []
	const missing = []
	for (const { id, matchRate } of DEFAULT_PRODUCT_ENTRIES) {
		const product = PRODUCT_LIBRARY.find((p) => p.id === id)
		if (!product) {
			missing.push(id)
			continue
		}
		products.push({ ...product, matchRate })
	}
	if (missing.length) {
		throw new Error(`[matchEngine] 默认推荐的产品编码在产品库中不存在：${missing.join('、')}`)
	}
	return products
}

export default { localMatchProducts, localMatchProductsWithDiagnostics, getDefaultProducts }
