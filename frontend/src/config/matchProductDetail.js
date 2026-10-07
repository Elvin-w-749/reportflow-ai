/**
 * 产品详情页模板配置（单一事实来源）
 *
 * match/detail.uvue 中的 features / steps / conditions 均从此处读取，
 * 避免硬编码散落在页面内。后续可迁移至后端 productLibrary 的每产品字段。
 *
 * 匹配规则：
 *   1. 若产品自身携带 features/steps/conditions 字段，优先使用产品数据
 *   2. 否则按 product.category 匹配对应模板
 *   3. 无匹配则使用 'default' 模板
 */

/** 产品亮点（按品类） */
export const FEATURES_BY_CATEGORY = {
	debt_relief: [
		{ sym: '减', name: '债务减免', desc: '专业协商团队为你争取减免' },
		{ sym: '合', name: '多笔合并', desc: '多笔小额贷款合并为单笔' },
		{ sym: '降', name: '降低月供', desc: '拉长期限，降低月供压力' },
		{ sym: '安', name: '安全保障', desc: '合规机构，银行级数据加密' },
	],
	credit_loan: [
		{ sym: '快', name: '极速审批', desc: '最快3分钟出结果' },
		{ sym: '低', name: '低息优惠', desc: '行业领先年化利率' },
		{ sym: '活', name: '灵活还款', desc: '随时提前还款免违约金' },
		{ sym: '安', name: '安全保障', desc: '银行级加密，数据隔离' },
	],
	mortgage: [
		{ sym: '稳', name: '额度充足', desc: '最高可达房产估值70%' },
		{ sym: '长', name: '期限灵活', desc: '最长30年，月供轻松' },
		{ sym: '惠', name: '利率优惠', desc: 'LPR基准，享政策红利' },
		{ sym: '安', name: '银行直营', desc: '国有大行，资金安全可靠' },
	],
	default: [
		{ sym: '快', name: '极速审批', desc: '最快3分钟出结果' },
		{ sym: '低', name: '低息优惠', desc: '行业领先年化利率' },
		{ sym: '活', name: '灵活还款', desc: '随时提前还款免违约金' },
		{ sym: '安', name: '安全保障', desc: '银行级加密，数据隔离' },
	],
}

/** 申请条件（按品类） */
export const CONDITIONS_BY_CATEGORY = {
	debt_relief: [
		{ text: '年龄 22-60 周岁，具有完全民事行为能力', note: '需本人确认', status: 'unknown' },
		{ text: '有稳定收入来源或还款意愿', note: '需提供收入证明', status: 'unknown' },
		{ text: '信用当前无未结清的恶意逾期', note: '', status: 'unknown' },
		{ text: '提供有效身份证明及债务凭证', note: '需本人确认', status: 'unknown' },
	],
	credit_loan: [
		{ text: '年龄 22-55 周岁，具有完全民事行为能力', note: '需本人确认', status: 'unknown' },
		{ text: '有稳定工作及月收入来源', note: '需提供收入证明', status: 'unknown' },
		{ text: '信用近两年无连三累六逾期', note: '', status: 'unknown' },
		{ text: '提供有效身份证明及收入证明', note: '需本人确认', status: 'unknown' },
	],
	default: [
		{ text: '年龄 22-55 周岁，具有完全民事行为能力', note: '需本人确认', status: 'unknown' },
		{ text: '有稳定工作及月收入来源', note: '需提供收入证明', status: 'unknown' },
		{ text: '信用近两年无连三累六逾期', note: '', status: 'unknown' },
		{ text: '提供有效身份证明及收入证明', note: '需本人确认', status: 'unknown' },
	],
}

/** 申请流程步骤（按品类） */
export const STEPS_BY_CATEGORY = {
	debt_relief: [
		{ title: '提交咨询',  desc: '在线填写债务基本信息与需求',     time: '约 5 分钟' },
		{ title: '方案评估',  desc: '专业团队分析债务结构，定制方案',  time: '1-2 个工作日' },
		{ title: '协商谈判',  desc: '与债权人沟通争取最优条件',       time: '3-10 个工作日' },
		{ title: '签署协议',  desc: '确认重组方案并签署法律文件',     time: '约 15 分钟' },
		{ title: '执行管理',  desc: '按新方案还款，持续跟踪优化',     time: '持续服务' },
	],
	default: [
		{ title: '提交申请',  desc: '在线填写基本信息，上传信用报告截图', time: '约 5 分钟' },
		{ title: '资料审核',  desc: '系统自动核验材料真实性',         time: '约 10 分钟' },
		{ title: '信用评估',  desc: '银行风控模型评估申请资质',       time: '1-3 个工作日' },
		{ title: '签署合同',  desc: '审批通过后完成电子合同签署',     time: '约 5 分钟' },
		{ title: '放款到账',  desc: '合同生效后资金快速到账',         time: '最快当日' },
	],
}

/**
 * 推断产品品类（优先用 product.category，否则从 tags/name 推断）
 */
export function inferCategory(product) {
	if (!product) return 'default'
	if (product.category) return product.category
	const tags = Array.isArray(product.tags) ? product.tags.map(t => String(t)) : []
	const name = String(product.name || product.productName || '')
	const all = [...tags, name].join(' ')
	if (/债务|重组|协商|减免|逾期|优化/.test(all)) return 'debt_relief'
	if (/抵押|房贷|按揭|房产/.test(all)) return 'mortgage'
	return 'credit_loan'
}

/**
 * 获取完整的产品详情模板（条件 + 亮点 + 流程）
 */
export function getProductDetailTemplate(product) {
	const cat = inferCategory(product)
	return {
		features: (product && product.features) || FEATURES_BY_CATEGORY[cat] || FEATURES_BY_CATEGORY.default,
		conditions: (product && product.conditions) || CONDITIONS_BY_CATEGORY[cat] || CONDITIONS_BY_CATEGORY.default,
		steps: (product && product.steps) || STEPS_BY_CATEGORY[cat] || STEPS_BY_CATEGORY.default,
	}
}

export default { FEATURES_BY_CATEGORY, CONDITIONS_BY_CATEGORY, STEPS_BY_CATEGORY, inferCategory, getProductDetailTemplate }
