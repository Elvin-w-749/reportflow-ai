// 本文件的评分权重与扣分阶梯为演示配置，不代表任何机构的真实授信规则。
/**
 * 征信分析算法核心 v3（分层流水线，与产品架构图一致）
 *
 * 输入层：PDF/图片 → 解析层（OCR/实体/正则）由 pdfParser + extractCreditInfoFromText 完成，本文件消费「结构化数据池」parsed。
 *
 * 算法层（本文件）：
 *   1. 时间锚点层 —— 查询与到期窗口固定使用报告日期，避免同一报告随上传日期漂移
 *   2. 机构/负债信号 —— classifyInstitution、classifyBankLoanTier、computeDebtStructure
 *      信用负债总额 = Σ贷款未结清余额 + Σ信用卡已用额度（与大额分期/高额度卡≥10万/普通卡分解一致）
 *   3. 负债计算引擎 —— computeDebtStructure + calculateUpcomingDue（6 个月到期窗）
 *   4. 查询统计引擎 —— analyzeQueryWindows（1/2/3/6/12/18 月 × 银行/非银）
 *   5. 状态与逾期摘要 —— analyzeOverdueSummary、countLendingInstitutions
 *   6. 风险评分卡 —— calculateIntegratedRiskScore（0–100）
 *   7. 报告组装 —— buildAlgorithmReport → narrative + JSON 块供客户端展示
 *
 * 与 aiAnalysis.enrichDimensions / merge 后的 dimensions 配合使用。
 */

import { getLiveTimeAnchor, parseCreditDate } from '../utils/beijingTime.js'
import { statusIndicatesOverdue } from '../utils/creditStatus.js'

export { getLiveTimeAnchor }

export const INSTITUTION_TYPE = {
	BANK: 'BANK',
	NON_BANK: 'NON_BANK',
	OTHER: 'OTHER'
}

export const BANK_KEYWORDS = {
	// 1. 开发性/政策性银行（3家）
	policy: ['国家开发银行', '中国进出口银行', '中国农业发展银行', '开发银行', '进出口银行', '农业发展银行'],

	// 2. 国有大型商业银行（6大行）
	stateOwned: ['中国工商银行', '中国农业银行', '中国银行', '中国建设银行', '交通银行', '中国邮政储蓄银行', '工商银行', '农业银行', '建设银行', '邮储银行', '邮储', '工行', '农行', '中行', '建行', '交行'],

	// 3. 全国性股份制商业银行（12家）
	jointStock: ['招商银行', '浦发银行', '中信银行', '中国光大银行', '华夏银行', '中国民生银行', '广发银行', '平安银行', '兴业银行', '浙商银行', '恒丰银行', '渤海银行', '招商', '浦发', '中信', '光大', '华夏', '民生', '广发', '平安', '兴业', '浙商', '恒丰', '渤海'],

	// 4. 城市商业银行（覆盖主要城商行 + 关键词）
	cityCommercial: ['北京银行', '上海银行', '江苏银行', '南京银行', '宁波银行', '杭州银行', '徽商银行', '广州银行', '盛京银行', '天津银行', '成都银行', '长沙银行', '重庆银行', '贵阳银行', '郑州银行', '西安银行', '青岛银行', '哈尔滨银行', '吉林银行', '大连银行', '锦州银行', '齐鲁银行', '东莞银行', '佛山银行', '厦门银行', '福州银行', '南昌银行', '苏州银行', '无锡银行', '江阴银行', '常熟银行', '张家港银行', '昆山银行', '吴江银行', '绍兴银行', '温州银行', '台州银行', '嘉兴银行', '湖州银行', '金华银行', '城商行', '城市商业银行'],

	// 5. 农村金融机构（农商行、农合行、农信社、村镇银行）
	rural: ['农村商业银行', '农村合作银行', '农村信用合作社', '农村信用社', '农信社', '农信', '农商行', '农商银行', '村镇银行', '农村资金互助社', '省联社', '省级农村信用社联合社', '联合社'],

	// 6. 民营银行（19家，全部持银行牌照）
	private: ['微众银行', '网商银行', '金城银行', '华瑞银行', '民商银行', '富民银行', '新网银行', '三湘银行', '中关村银行', '亿联银行', '众邦银行', '华通银行', '蓝海银行', '裕民银行', '新安银行', '振兴银行', '锡商银行', '客商银行', '民丰银行', '民营银行'],

	// 7. 住房储蓄银行
	housingSavings: ['中德住房储蓄银行', '住房储蓄银行'],

	// 8. 通用兜底
	general: ['银行', '储蓄银行']
};

// 合并为扁平匹配数组（按优先级排序：先具体后通用）
export const BANK_FLAT_KEYWORDS = [
	...BANK_KEYWORDS.policy,
	...BANK_KEYWORDS.stateOwned,
	...BANK_KEYWORDS.jointStock,
	...BANK_KEYWORDS.cityCommercial,
	...BANK_KEYWORDS.rural,
	...BANK_KEYWORDS.private,
	...BANK_KEYWORDS.housingSavings,
	...BANK_KEYWORDS.general
];

export const NON_BANK_KEYWORDS = {
	// 1. 持牌消费金融公司（31家，名称关键词）
	consumerFinance: [
		'消费金融', '中银消费', '北银消费', '招联消费', '兴业消费', '马上消费', '捷信消费',
		'平安消费', '杭银消费', '苏银凯基', '锦程消费', '海尔消费', '湖北消费', '苏宁消费',
		'晋商消费', '华融消费', '长银消费', '长银五八', '蒙商消费', '哈银消费', '尚诚消费',
		'金美信消费', '中信消费', '小米消费', '阳光消费', '蚂蚁消费', '建信消费', '宁银消费',
		'唯品富邦消费', '重庆蚂蚁消费金融'
	],

	// 2. 汽车金融公司（25家）
	autoFinance: [
		'汽车金融', '上汽通用汽车金融', '大众汽车金融', '丰田汽车金融', '福特汽车金融',
		'奔驰汽车金融', '宝马汽车金融', '东风日产汽车金融', '北京现代汽车金融', '奇瑞徽银汽车金融',
		'比亚迪汽车金融', '三一汽车金融', '瑞福德汽车金融', '长安汽车金融', '长城滨银汽车金融',
		'东正汽车金融', '广汽汇理汽车金融', '华晨东亚汽车金融', '豪沃汽车金融', '吉致汽车金融',
		'裕隆汽车金融', '斯泰兰蒂斯汽车金融', '蔚来汽车金融'
	],

	// 3. 信托公司（68家，关键词覆盖）
	trust: ['信托', '中信信托', '平安信托', '中融信托', '重庆信托', '华润信托', '五矿信托', '建信信托'],

	// 4. 金融租赁公司（银行系/非银系，持牌）— 注意与融资租赁区分
	financialLeasing: [
		'金融租赁', '工银金融租赁', '交银金融租赁', '招银金融租赁', '建信金融租赁',
		'民生金融租赁', '华夏金融租赁', '光大金融租赁', '兴业金融租赁', '浦银金融租赁',
		'农银金融租赁', '昆仑金融租赁', '国兴金融租赁', '江苏金融租赁', '河北金融租赁'
	],

	// 5. 企业集团财务公司（约250家）
	financeCompany: [
		'财务公司', '电力财务', '华能财务', '中油财务', '中石化财务', '中海油财务',
		'宝钢财务', '海尔财务', '美的财务', '格力财务', '上汽财务', '东风财务', '一汽财务',
		'兵器财务', '航空财务', '航天财务', '中化财务', '五矿财务', '中粮财务'
	],

	// 6. 金融资产管理公司（全国性5家 + 地方AMC）
	amc: [
		'资产管理', '中国华融', '中国长城', '中国东方', '中国信达', '中国银河资产',
		'浙商资产', '江苏资产', '粤财资产', '上海国资经营'
	],

	// 7. 小额贷款公司（含网络小贷）
	microLoan: ['小额贷款', '小贷', '网络小贷', '互联网小贷'],

	// 8. 融资租赁公司（非持牌金融租赁，地方监管）
	leasing: ['融资租赁'],

	// 9. 融资担保公司
	guarantee: ['融资担保', '担保公司'],

	// 10. 典当行
	pawn: ['典当', '典当行'],

	// 11. 商业保理
	factoring: ['商业保理', '保理公司'],

	// 12. 地方金融组织（补充）
	localFinance: ['地方资产管理', '区域性股权市场', '农民专业合作社'],

	// 13. 互联网平台/助贷/联合贷（国内）
	internetPlatform: [
		'京东', '度小满', '有钱花', '360借条', '360小贷', '美团', '美团小贷', '美团生活费',
		'滴滴', '滴水贷', '字节跳动', '放心借', '携程', '拿去花', '借去花', '乐信', '分期乐',
		'趣店', '来分期', '玖富', '拍拍贷', '信也科技', '宜人', '宜人贷', '陆金所', '翼支付',
		'甜橙借钱', '微博借钱', '搜狗借钱', '苏宁', '任性付', '国美', '国美易卡', '平安普惠',
		'微粒贷', '借呗', '花呗', '网商贷', '京东白条', '京东金条'
	],

	// 14. 其他非银
	other: ['消金', '盛际']
};

// 合并为扁平匹配数组
export const NON_BANK_FLAT_KEYWORDS = Object.values(NON_BANK_KEYWORDS).flat();

const LOAN_TYPE_RULES = {
	HOUSING: ['购房', '住房', '公积金', '商用房', '商住', '房贷', '按揭'],
	BUSINESS: ['经营', '经营性贷款', '企业贷款', '经营贷'],
	CAR: ['汽车', '购车', '车辆', '车贷'],
	CONSUMER: ['消费', '其他个人消费', '消费贷', '现金分期']
}

/** @param {string} name */
export function classifyInstitution(name) {
	if (!name || typeof name !== 'string') return 'OTHER';

	const normalized = name.toLowerCase().replace(/\s+/g, '');

	// 特殊排除：中国人民银行（不是商业银行，是央行/查询机构）
	if (normalized.includes('中国人民银行') || normalized.includes('人民银行')) {
		return 'CENTRAL_BANK'; // 单独标记，不纳入银行统计
	}

	const hit = (keywords) =>
		keywords.some(kw => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')));

	// 1. 含「银行」二字的一律按商业银行处理（人行已在上方单独排除）。
	//    国内持牌非银机构（消金/信托/小贷/租赁/担保/财务公司/汽车金融等）名称均不含「银行」，
	//    因此该判定：① 纠正「平安普惠 / 中信信托 / 兴业消费 / 苏宁消金」被短品牌词（平安/中信/兴业/苏宁）误判为银行；
	//    ② 同时保护「苏宁银行 / 网商银行」等民营银行不被 internetPlatform 短词（苏宁）误判为非银。
	if (normalized.includes('银行')) {
		return INSTITUTION_TYPE.BANK;
	}

	// 2. 非银类匹配优先：非银关键词多为具体全称（如「兴业消费金融」「中信信托」），
	//    先匹配可避免被银行短品牌词（兴业/中信）抢占。
	const nonBankSubTypes = [
		NON_BANK_KEYWORDS.consumerFinance,
		NON_BANK_KEYWORDS.autoFinance,
		NON_BANK_KEYWORDS.trust,
		NON_BANK_KEYWORDS.financialLeasing,
		NON_BANK_KEYWORDS.financeCompany,
		NON_BANK_KEYWORDS.amc,
		NON_BANK_KEYWORDS.microLoan,
		NON_BANK_KEYWORDS.leasing,
		NON_BANK_KEYWORDS.guarantee,
		NON_BANK_KEYWORDS.pawn,
		NON_BANK_KEYWORDS.factoring,
		NON_BANK_KEYWORDS.localFinance,
		NON_BANK_KEYWORDS.internetPlatform,
		NON_BANK_KEYWORDS.other
	];
	for (const keywords of nonBankSubTypes) {
		if (hit(keywords)) return INSTITUTION_TYPE.NON_BANK;
	}

	// 3. 银行品牌兜底（无「银行」字样但确为银行的少见简称，如「招商」「浦发」）。
	const bankSubTypes = [
		BANK_KEYWORDS.policy,
		BANK_KEYWORDS.stateOwned,
		BANK_KEYWORDS.jointStock,
		BANK_KEYWORDS.cityCommercial,
		BANK_KEYWORDS.rural,
		BANK_KEYWORDS.private,
		BANK_KEYWORDS.housingSavings,
		BANK_KEYWORDS.general
	];
	for (const keywords of bankSubTypes) {
		if (hit(keywords)) return INSTITUTION_TYPE.BANK;
	}

	// 4. 兜底
	return INSTITUTION_TYPE.OTHER;
}

/**
 * 银行贷款细类（架构图：政策 / 国有大行 / 股份制 / 城农商）
 * 仅当 classifyInstitution === BANK 时有意义；按关键词顺序匹配，未命中归「其他商业银行」
 * @param {string} name
 * @returns {'政策性银行'|'国有大型商业银行'|'全国性股份制银行'|'城商行及农商'|'其他商业银行'}
 */
export function classifyBankLoanTier(name) {
	const normalized = String(name || '').toLowerCase().replace(/\s+/g, '');

	if (BANK_KEYWORDS.policy.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '政策性银行'
	if (BANK_KEYWORDS.stateOwned.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '国有大型商业银行'
	if (BANK_KEYWORDS.jointStock.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '全国性股份制银行'
	if (BANK_KEYWORDS.cityCommercial.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '城商行及农商'
	if (BANK_KEYWORDS.rural.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '城商行及农商'
	if (BANK_KEYWORDS.private.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '其他商业银行'
	if (BANK_KEYWORDS.housingSavings.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')))) return '其他商业银行'

	return '其他商业银行'
}

/** @param {string} description */
export function classifyLoanType(description) {
	const desc = String(description || '')
	for (const [loanType, keywords] of Object.entries(LOAN_TYPE_RULES)) {
		if (keywords.some((kw) => desc.includes(kw))) return loanType
	}
	return 'CONSUMER'
}

/**
 * 信用卡大额专项分期识别（基于账户段原文）
 * @param {string} segmentText
 */
export function extractBigInstallmentInfo(segmentText) {
	const detailText = String(segmentText || '')
	const indicators = ['大额专项分期', '未出单的大额', '专项分期余额']
	const isBig = indicators.some((ind) => detailText.includes(ind))
	let installmentAmount = 0
	const patterns = [
		/大额专项分期余额[：:\s]*([\d,]+(?:\.\d+)?)\s*元?/,
		/未出单的大额专项分期[：:\s]*([\d,]+(?:\.\d+)?)/,
		/专项分期余额[：:\s]*([\d,]+(?:\.\d+)?)\s*元?/
	]
	for (const re of patterns) {
		const m = detailText.match(re)
		if (m) {
			installmentAmount = parseFloat(String(m[1]).replace(/,/g, '')) || 0
			if (installmentAmount > 0) break
		}
	}
	return { is_big_installment: isBig, installment_amount: installmentAmount }
}

function normalizeDateInline(raw) {
	if (!raw) return ''
	const compact = String(raw).replace(/\s/g, '')
	const m = compact.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/)
	if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
	return ''
}

/**
 * @param {{ reportDate?: string }} basicInfo
 * @param {string} [rawText]
 */
export function parseReportDate(basicInfo, rawText = '') {
	let d = basicInfo?.reportDate || ''
	if (!d && rawText) {
		const m1 = rawText.match(/报告时间[：:\s]*(\d{4}-\d{2}-\d{2})/)
		if (m1) d = m1[1]
	}
	if (!d && rawText) {
		const m2 = rawText.match(/报告生成时间[：:\s]*(\d{4}-\d{2}-\d{2})/)
		if (m2) d = m2[1]
	}
	if (!d && rawText) {
		const m3 = rawText.match(/查询日期[：:\s]*([\d年\s月日]+)/)
		if (m3) d = normalizeDateInline(m3[1])
	}
	const t = d ? new Date(d).getTime() : NaN
	if (!isNaN(t)) return new Date(t)
	return getLiveTimeAnchor()
}

/** @deprecated 使用 parseCreditDate(s).getTime() 替代，统一日期解析入口 */
function parseDateToTime(s) {
	const d = parseCreditDate(s)
	return d ? d.getTime() : NaN
}

/**
 * @param {Array<{ bank?: string, endDate?: string, balance?: number }>} loans
 * @param {Date} [anchorEnd] 可选；省略时使用现实时间。仅测试传入固定锚点。
 * @param {number} [months]
 */
export function calculateUpcomingDue(loans, anchorEnd, months = 6) {
	const base = anchorEnd instanceof Date ? anchorEnd : getLiveTimeAnchor()
	const target = new Date(base.getFullYear(), base.getMonth() + months, base.getDate())
	const baseT = base.getTime()
	const targetT = target.getTime()
	const upcoming = []
	for (const loan of loans || []) {
		const due = loan.endDate
		const dueT = parseDateToTime(due)
		if (isNaN(dueT)) continue
		if (dueT > baseT && dueT <= targetT) {
			upcoming.push({ 机构: loan.bank || '', 到期日: due, 余额: loan.balance || 0 })
		}
	}
	return {
		笔数: upcoming.length,
		合计余额: upcoming.reduce((s, x) => s + (x.余额 || 0), 0),
		明细: upcoming
	}
}

/**
 * 从查询明细汇总近 1/3/6/12 月总次数（窗口锚定 getLiveTimeAnchor / 联网北京时间）
 * @param {Array<{ date: string, institution: string, reason?: string }>} queryItems
 * @param {Date} [anchorEnd] 仅测试/审计传入固定锚点；生产勿传
 */
export function queryCountsFromItems(queryItems, anchorEnd) {
	const w = analyzeQueryWindows(queryItems, anchorEnd)
	return {
		q1: w['近一个月']?.总次数 ?? 0,
		q3: w['近三个月']?.总次数 ?? 0,
		q6: w['近六个月']?.总次数 ?? 0,
		q12: w['近十二个月']?.总次数 ?? 0,
		windows: w
	}
}

// ─────────────────────────────────────────────
// 四维评分（权重与扣分阶梯为演示配置）
//
// ⚠️ 必须与 services/aiAnalysis.scoreFourDimensions / scoreRepaymentRecord 完全一致。
//    服务端缺四维真实分时，serverAnalyzeMapper 用本地 dimensions 经此复算，
//    取代旧的「统一兜底 60」（会让综合分恒等于 60）。
// ─────────────────────────────────────────────

/**
 * 安全非负计数：把非数字字符串 / NaN / Infinity / 负值统一归 0。
 * 防止 `d.xxx || 0` 让 "abc"→NaN 向下传播，或负计数反向「加分」。
 */
const cnt = (x) => {
	const n = typeof x === 'number' ? x : Number(x)
	return Number.isFinite(n) && n > 0 ? n : 0
}

/** 还款记录（逾期）评分 —— 扣分阶梯为演示配置 */
export function scoreRepaymentRecord(dim) {
	const d = dim || {}
	let s = 100
	const m1 = cnt(d.m1Count)
	const m2 = cnt(d.m2Count)
	const m3 = cnt(d.m3Count)
	const overdueCnt = cnt(d.overdueCount)

	if (overdueCnt > 0) s -= 3
	s -= m1 * 9
	s -= m2 * 24
	s -= m3 * 42

	const maxDays = cnt(d.maxOverdueDays)
	if (maxDays > 90) s -= 21
	else if (maxDays > 60) s -= 9
	else if (maxDays > 30) s -= 3

	if (d.hasLianSan) s -= 24
	if (d.hasLeiLiu)  s -= 45
	if (overdueCnt > 1) s -= Math.min(21, (overdueCnt - 1) * 9)
	if (d.hasPublicRecord) s -= 9

	return Math.max(0, Math.min(100, Math.round(s)))
}

/**
 * 四维评分（英文 key 口径）。与 aiAnalysis.scoreFourDimensions 输出等价。
 * @returns {{ credit_history:number, query_frequency:number, account_structure:number, repayment_record:number }}
 */
export function scoreFourDimensions(dim) {
	const d = dim || {}

	// 信用历史（v7：0 分起累加，无保底；账龄为核心）
	let creditHistory = 0
	creditHistory += Math.min(36, cnt(d.oldestAccountYears) * 6)
	creditHistory += Math.min(20, cnt(d.avgAccountYears) * 4)
	creditHistory += Math.min(20, cnt(d.activeAccountCount) * 5)
	creditHistory += Math.min(24, cnt(d.settledAccountCount) * 6)
	if (d.hasPublicRecord) creditHistory -= 33
	creditHistory = Math.max(0, Math.min(100, creditHistory))

	// 查询频率（100 起扣，可至 0）
	let queryScore = 100
	queryScore -= Math.max(0, cnt(d.q1) - 2) * 9
	queryScore -= Math.max(0, cnt(d.q3) - 4) * 3
	queryScore -= Math.max(0, cnt(d.q12) - 8) * 3
	if (cnt(d.q6) > 6) queryScore -= 21
	if (cnt(d.q6) > 10) queryScore -= 27
	if (d.has30dConcentrated) queryScore -= 3
	if (d.has7dConcentrated)  queryScore -= 9
	if (cnt(d.sameDayInquiryDayCount) > 0) {
		queryScore -= Math.min(24, cnt(d.sameDayInquiryDayCount) * 9)
	}
	queryScore = Math.max(0, Math.min(100, queryScore))

	// 账户结构（v7：0 分起累加，去除基础分 60；白户=0）
	let accountScore = 0
	if (cnt(d.creditCardCount) > 0) accountScore += 15
	if (cnt(d.loanCount) > 0)       accountScore += 15
	if (cnt(d.creditCardCount) > 0 && cnt(d.loanCount) > 0) accountScore += 10
	if (cnt(d.settledAccountCount) > 0) accountScore += 15
	const ac = cnt(d.activeAccountCount)
	if (ac >= 2 && ac <= 6)       accountScore += 25
	else if (ac === 1)            accountScore += 12
	else if (ac >= 7 && ac <= 10) accountScore += 15
	else if (ac > 10)             accountScore += 5
	const tc = cnt(d.totalAccountCount)
	if (tc >= 3 && tc <= 8)       accountScore += 20
	else if (tc >= 1 && tc <= 2)  accountScore += 8
	else if (tc >= 9 && tc <= 12) accountScore += 10
	accountScore = Math.max(0, Math.min(100, accountScore))

	// 还款记录可评性（v7 无保底）：无任何账户且无逾期信号 → 无还款历史可评 → null，
	// 不再默认满分 100（避免空/稀疏报告的综合分被无依据地抬高）。
	const hasRepayData =
		(d.totalAccountCount || 0) > 0 || (d.overdueCount || 0) > 0 ||
		(d.m1Count || 0) > 0 || (d.m2Count || 0) > 0 || (d.m3Count || 0) > 0 ||
		d.hasLianSan || d.hasLeiLiu
	const repay = hasRepayData ? Math.round(scoreRepaymentRecord(d)) : null

	return {
		credit_history:    Math.round(creditHistory),
		query_frequency:   Math.round(queryScore),
		account_structure: Math.round(accountScore),
		repayment_record:  repay
	}
}

/**
 * 主评分框架（100 分扣减制 · 扣分阶梯为演示配置）
 *
 * ⚠️ 必须与 ai-proxy/creditRuleEngine.js 的 calculatePrimaryRuleScore 规则集保持一一对应。
 *    strict-gate consistency:primary-score-unified 以确定性样本验证双端输出一致。
 *
 * 规则口径（取最高命中，不累计）：
 *   账户数分档：>50:-48  >30:-36  >15:-24  >6:-9  >3:-3
 *   非银贷款集中度：≥10:-33  ≥5:-21
 *   信用卡使用率：>90%:-27  >70%:-9  >50%:-3
 *   大额分期：-24
 *   近6月查询：>12:-27  >6:-9  >3:-3
 *   同日查询>3次：-21
 */
export function calculatePrimaryRuleScore(dim) {
	const d = dim || {}
	const deductions = []

	// 账户数分档（从高到低匹配，命中即停止）
	const totalAccounts = cnt(d.totalAccountCount)
	if (totalAccounts > 50) deductions.push({ code: 'ACC_GT_50', label: '账户数超过50个', points: 48 })
	else if (totalAccounts > 30) deductions.push({ code: 'ACC_GT_30', label: '账户数超过30个', points: 36 })
	else if (totalAccounts > 15) deductions.push({ code: 'ACC_GT_15', label: '账户数超过15个', points: 24 })
	else if (totalAccounts > 6) deductions.push({ code: 'ACC_GT_6', label: '账户数超过6个', points: 9 })
	else if (totalAccounts > 3) deductions.push({ code: 'ACC_GT_3', label: '账户数超过3个', points: 3 })

	// 非银贷款集中度（多头借贷风险）
	const nonBankCnt = cnt(d.nonBankLoanCount)
	if (nonBankCnt >= 10) deductions.push({ code: 'NONBANK_GE_10', label: '非银贷款达到10笔', points: 33 })
	else if (nonBankCnt >= 5) deductions.push({ code: 'NONBANK_GE_5', label: '非银贷款达到5笔', points: 21 })

	// 信用卡使用率（取最高命中，不累计）
	const usageRate = cnt(d.cardUtilizationRate)
	if (usageRate > 0.9) deductions.push({ code: 'CARD_UTIL_GT_90', label: '信用卡使用率超过90%', points: 27 })
	else if (usageRate > 0.7) deductions.push({ code: 'CARD_UTIL_GT_70', label: '信用卡使用率超过70%', points: 9 })
	else if (usageRate > 0.5) deductions.push({ code: 'CARD_UTIL_GT_50', label: '信用卡使用率超过50%', points: 3 })

	if (d.hasBigInstallment) {
		deductions.push({ code: 'CARD_BIG_INSTALLMENT', label: '信用卡存在大额分期', points: 24 })
	}

	// 近6月查询（取最高命中，不累计）
	const q6 = cnt(d.q6)
	if (q6 > 12) deductions.push({ code: 'Q6_GT_12', label: '近6个月查询超过12次', points: 27 })
	else if (q6 > 6) deductions.push({ code: 'Q6_GT_6', label: '近6个月查询超过6次', points: 9 })
	else if (q6 > 3) deductions.push({ code: 'Q6_GT_3', label: '近6个月查询超过3次', points: 3 })

	// 同日查询>3次
	if (cnt(d.sameDayInquiryDayCount) > 0) {
		deductions.push({ code: 'SAME_DAY_QUERY_GT_3', label: '同一天查询超过3次', points: 21 })
	}

	const totalDeduction = deductions.reduce((sum, x) => sum + (x.points || 0), 0)
	const score = Math.max(0, Math.min(100, 100 - totalDeduction))

	return {
		score,
		baseScore: 100,
		totalDeduction,
		deductions
	}
}

/** 四维加权（与 aiAnalysis.FOUR_DIM_WEIGHTS / creditRuleEngine 同值；演示配置，权重之和 = 1） */
export const FOUR_DIM_WEIGHTS = {
	repayment_record:  0.33,
	credit_history:    0.27,
	account_structure: 0.24,
	query_frequency:   0.16
}

/** 严重逾期对综合分设硬上限（与 aiAnalysis.applyOverdueTotalCap 一致；上限档位为演示配置） */
export function applyOverdueTotalCap(total, dim) {
	if (!dim || typeof total !== 'number' || !isFinite(total)) return total
	let cap = 100
	if (dim.hasLeiLiu) cap = 27
	else if (dim.hasLianSan) cap = 33
	else if (cnt(dim.m3Count) > 0) cap = 39
	else if (cnt(dim.m2Count) > 0) cap = 45
	else if (cnt(dim.m1Count) > 0 || cnt(dim.overdueCount) > 0) cap = 48
	return Math.min(Math.round(total), cap)
}

/** 四维 → 加权综合分（含逾期上限）。four 用英文 key。 */
export function composeFourDimTotal(four, dim) {
	const f = four || {}
	// 防御 NaN/Infinity：仅有限数字参与加权
	const safe = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0
	let t = 0
	t += safe(f.repayment_record)  * FOUR_DIM_WEIGHTS.repayment_record
	t += safe(f.credit_history)    * FOUR_DIM_WEIGHTS.credit_history
	t += safe(f.account_structure) * FOUR_DIM_WEIGHTS.account_structure
	t += safe(f.query_frequency)   * FOUR_DIM_WEIGHTS.query_frequency
	return applyOverdueTotalCap(Math.round(t), dim)
}

/**
 * 查询次数分窗口 + 银行/非银（机构名规则分类）
 * @param {Array<{ date: string, institution: string, reason?: string }>} queryItems
 * @param {Date} [anchorEnd] 可选；省略时使用现实时间
 */
export function analyzeQueryWindows(queryItems, anchorEnd) {
	const end = anchorEnd instanceof Date ? anchorEnd : getLiveTimeAnchor()
	const endT = end.getTime()
	const isEffectiveQuery = (q) => {
		const reason = String(q?.reason || q?.query_reason || q?.purpose || '').trim()
		if (/本人|自查|自助|贷后管理/.test(reason)) return false
		return /贷款审批|信用卡审批|贷记卡审批|担保资格审查|担保审查|保前审查|审批/.test(reason)
	}
	const windows = {
		近一个月: 30,
		近二个月: 60,
		近三个月: 90,
		近六个月: 180,
		近十二个月: 365,
		近十八个月: 545
	}
	// 机构名多源兼容：部分数据只填 org / query_org，缺 institution 会被误判为 OTHER → 银行/非银计数偏低
	const instOf = (q) => classifyInstitution(q?.institution || q?.org || q?.query_org || '')
	const result = {}
	for (const [period, days] of Object.entries(windows)) {
		const startT = endT - days * 24 * 60 * 60 * 1000
		const periodQueries = (queryItems || []).filter((q) => {
			const qt = parseDateToTime(q.date)
			return isEffectiveQuery(q) && !isNaN(qt) && qt >= startT && qt <= endT
		})
		const bank = periodQueries.filter((q) => instOf(q) === INSTITUTION_TYPE.BANK).length
		const nonBank = periodQueries.filter((q) => instOf(q) === INSTITUTION_TYPE.NON_BANK).length
		result[period] = { 总次数: periodQueries.length, 银行: bank, 非银: nonBank }
	}
	return result
}

/**
 * @param {Array<object>} creditAccounts
 */
export function analyzeOverdueSummary(creditAccounts) {
	const overdueAccounts = (creditAccounts || []).filter((acc) => (
		acc?.isOverdue === true ||
		Number(acc?.overdueDays ?? acc?.overdue_days) > 0 ||
		statusIndicatesOverdue(acc?.status)
	))
	let totalOverdueMonths = 0
	for (const acc of overdueAccounts) {
		const matrix = acc.repayMatrix || []
		totalOverdueMonths += matrix.filter((s) => /^[1-7]$/.test(String(s || '').trim())).length
	}
	const currentOverdue = overdueAccounts.filter((acc) => statusIndicatesOverdue(acc.status)).length
	return {
		近5年逾期笔数: overdueAccounts.length,
		累计逾期月数: totalOverdueMonths > 0 ? totalOverdueMonths : null,
		累计逾期月数说明: totalOverdueMonths > 0 ? null : '需详版确认',
		当前逾期账户: currentOverdue
	}
}

const HIGH_CARD_LIMIT = 100000

/**
 * @param {object} parsed
 * @param {object|null} dimensions enrichDimensions 合并后结果
 */
export function computeDebtStructure(parsed, dimensions = null) {
	const accounts = (parsed.creditAccounts || []).filter((a) => !a.isSettled)
	const loans = accounts.filter((a) => a.isLoan)
	const cards = accounts.filter((a) => !a.isLoan)

	let bankLoan = 0
	const bankLoanNames = []
	let nonBankLoan = 0
	const nonBankLoanNames = []
	let otherLoan = 0
	const otherLoanNames = []
	const bankLoanByTier = {
		政策性银行: 0,
		国有大型商业银行: 0,
		全国性股份制银行: 0,
		城商行及农商: 0,
		其他商业银行: 0
	}

	for (const L of loans) {
		const cat = L.institutionCategory || classifyInstitution(L.bank)
		const bal = L.balance || 0
		if (cat === INSTITUTION_TYPE.BANK) {
			bankLoan += bal
			bankLoanNames.push(L.bank)
			const tier = classifyBankLoanTier(L.bank)
			bankLoanByTier[tier] = (bankLoanByTier[tier] || 0) + bal
		} else if (cat === INSTITUTION_TYPE.NON_BANK) {
			nonBankLoan += bal
			nonBankLoanNames.push(L.bank)
		} else {
			// OTHER：未命中银行/非银关键词的机构（可能是关键词库未覆盖的银行或新型机构）。
			// 不盲目归入非银，单独统计；nonBankLoanRatio 计算时仍保守计入（兼容旧口径）。
			otherLoan += bal
			otherLoanNames.push(L.bank)
		}
	}

	let bigInstallmentTotal = 0
	let bigInstallmentCount = 0
	for (const c of cards) {
		const amt = c.bigInstallmentAmount || 0
		if (c.hasBigInstallment || amt > 0) {
			bigInstallmentTotal += amt
			bigInstallmentCount += 1
		}
	}

	let highUsed = 0
	let highCount = 0
	let lowUsed = 0
	let lowCount = 0
	for (const c of cards) {
		const lim = c.limit || 0
		const used = c.balance || 0
		if (lim >= HIGH_CARD_LIMIT) {
			highUsed += used
			highCount += 1
		} else if (lim > 0 || used > 0) {
			lowUsed += used
			lowCount += 1
		}
	}

	const totalLoanBal = loans.reduce((s, a) => s + (a.balance || 0), 0)
	const totalCardUsed = cards.reduce((s, a) => s + (a.balance || 0), 0)
	const computedTotal = totalLoanBal + totalCardUsed

	const loanTotal = dimensions?.totalLoanBalance != null ? dimensions.totalLoanBalance : totalLoanBal
	const cardTotal = dimensions?.usedCardLimit != null ? dimensions.usedCardLimit : totalCardUsed
	const totalDebt = dimensions?.totalDebt != null && dimensions.totalDebt > 0 ? dimensions.totalDebt : computedTotal

	const byType = { HOUSING: 0, BUSINESS: 0, CAR: 0, CONSUMER: 0 }
	for (const L of loans) {
		const lt = L.loanTypeCategory || classifyLoanType(L.accountType)
		if (byType[lt] != null) byType[lt] += L.balance || 0
		else byType.CONSUMER += L.balance || 0
	}

	return {
		totalCreditDebt: totalDebt,
		loanTotal,
		cardTotal,
		/** 架构图：银行贷款 = 政策 / 国有 / 股份制 / 城农商 / 其他 */
		bankLoanByTier: { ...bankLoanByTier },
		bankLoan: {
			amount: bankLoan,
			count: bankLoanNames.length,
			names: [...new Set(bankLoanNames)]
		},
		nonBankLoan: {
			amount: nonBankLoan,
			count: nonBankLoanNames.length,
			names: [...new Set(nonBankLoanNames)]
		},
		/** 未识别机构（既不匹配银行也不匹配非银关键词）。单独统计避免错误归入非银，
		 *  但 nonBankLoanRatio 计算时将其保守计入（兼容旧口径，避免低估风险）。 */
		otherLoan: {
			amount: otherLoan,
			count: otherLoanNames.length,
			names: [...new Set(otherLoanNames)]
		},
		bigInstallment: { amount: bigInstallmentTotal, count: bigInstallmentCount },
		highLimitCards: { amount: highUsed, count: highCount },
		normalCards: { amount: lowUsed, count: lowCount },
		otherLiabilities: {
			住房贷: byType.HOUSING,
			经营贷: byType.BUSINESS,
			车贷: byType.CAR,
			消费及其他: byType.CONSUMER
		},
		/** 非银贷款比例（含未识别机构，保守口径）。仅明确银行：bankLoan / totalLoanBal。 */
		nonBankLoanRatio: totalLoanBal > 0 ? (nonBankLoan + otherLoan) / totalLoanBal : 0
	}
}

export function countLendingInstitutions(parsed) {
	const active = (parsed.creditAccounts || []).filter((a) => !a.isSettled && (a.balance || 0) > 0)
	return new Set(active.map((a) => a.bank).filter(Boolean)).size
}

/**
 * 综合风险评分 0–100，越低风险越高（业务增值展示用）
 *
 * 数据稀疏处理（v3.1，修复 H1）：当全部输入信号（负债 / 卡限额 / 卡使用 / 查询 / 机构数 / 非银额）均为 0
 * 时，返回 { score: null, risk_level: '未知', factors: ['数据不足'], confidence: 'low' }。
 * 上层（aiAnalysis.generateReport）已支持 strictRiskScore==null 时回退到 calculateTotalScore，
 * 避免出现「无数据却展示 100 分」的误导。
 */
export function calculateIntegratedRiskScore(reportData) {
	const totalDebt = reportData.总信用负债 ?? reportData.totalCreditDebt ?? 0
	const used = reportData.信用卡已使用 ?? reportData.cardUsed ?? 0
	const totalLim = reportData.信用卡总额度 ?? reportData.cardLimitTotal ?? 0
	const recentQ = reportData.近三个月查询总次数 ?? reportData.q3 ?? 0
	const institutions = reportData.放贷机构数 ?? 0
	const nonBankAmt = reportData.非银行贷款 ?? reportData.nonBankLoan ?? 0
	const signals = totalDebt + used + totalLim + recentQ + institutions + nonBankAmt
	if (!(signals > 0)) {
		return {
			score: null,
			risk_level: '未知',
			factors: ['数据不足，无法计算综合风险分'],
			confidence: 'low'
		}
	}

	let score = 100
	const factors = []
	if (totalDebt > 500000) {
		score -= 15
		factors.push('负债规模较大')
	}
	const usageRate = totalLim > 0 ? used / totalLim : 0
	if (usageRate > 0.8) {
		score -= 20
		factors.push('信用卡使用率过高')
	} else if (usageRate > 0.5) {
		score -= 10
	}
	if (recentQ > 10) {
		score -= 15
		factors.push('近期查询过于频繁')
	}
	if (institutions > 8) {
		score -= 10
		factors.push('多头借贷风险')
	}
	const nonBankRatio = totalDebt > 0 ? nonBankAmt / totalDebt : 0
	if (nonBankRatio > 0.5) {
		score -= 10
		factors.push('非银机构占比较高')
	}
	return {
		score: Math.max(0, score),
		risk_level: score < 60 ? '高' : score < 80 ? '中' : '低',
		factors,
		confidence: 'normal'
	}
}

function formatMoneyNum(n) {
	if (n == null || isNaN(n)) return '0'
	// 手写整数千分位（输出与 Math.round(n).toLocaleString('zh-CN') 等价）：
	// 不依赖 ICU/locale 数据，避免在缺 Intl 的 JS 引擎上退化或抛错。
	const v = Math.round(n)
	const neg = v < 0
	const grouped = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	return neg ? '-' + grouped : grouped
}

/**
 * 生成报告用叙事块
 */
export function buildDebtNarrative(debt, upcoming, nonBankWarnRatio = 0.45) {
	const lines = []
	lines.push(`一、信用负债：${formatMoneyNum(debt.totalCreditDebt)} 元`)
	lines.push(`├─ 贷款：${formatMoneyNum(debt.loanTotal)} 元`)
	lines.push(`└─ 信用卡：${formatMoneyNum(debt.cardTotal)} 元`)
	lines.push('')
	lines.push('其中：')
	const warn = debt.nonBankLoanRatio >= nonBankWarnRatio ? ' ⚠️ 非银占比较高' : ''
	lines.push(`1. 银行贷款 ${formatMoneyNum(debt.bankLoan.amount)} 元（${debt.bankLoan.count} 笔）`)
	const bt = debt.bankLoanByTier
	if (bt && typeof bt === 'object') {
		lines.push(
			`   ├ 政策/国有/股份/城农商：政策${formatMoneyNum(bt.政策性银行)} · 国有${formatMoneyNum(bt.国有大型商业银行)} · 股份${formatMoneyNum(bt.全国性股份制银行)} · 城农商${formatMoneyNum(bt.城商行及农商)} · 其他${formatMoneyNum(bt.其他商业银行)}`
		)
	}
	lines.push(`2. 非银行贷款 ${formatMoneyNum(debt.nonBankLoan.amount)} 元（${debt.nonBankLoan.count} 笔）${warn}`)
	lines.push(`3. 大额专项分期 ${formatMoneyNum(debt.bigInstallment.amount)} 元（${debt.bigInstallment.count} 张）`)
	lines.push(`4. 授信≥10万信用卡已用 ${formatMoneyNum(debt.highLimitCards.amount)} 元（${debt.highLimitCards.count} 张）`)
	lines.push(`5. 授信10万以下信用卡已用 ${formatMoneyNum(debt.normalCards.amount)} 元（${debt.normalCards.count} 张）`)
	lines.push('')
	lines.push(`近六个月到期：${upcoming.笔数} 笔，合计余额 ${formatMoneyNum(upcoming.合计余额)} 元`)
	return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// 流水线阶段函数（与架构图：负债引擎 / 查询引擎 / 风险评分卡 / 报告组装 对齐）
// ═══════════════════════════════════════════════════════════════════════════

function pipelineExtractQueryItems(parsed) {
	return parsed.queryRecords?.queryItems || parsed.queryRecords?.details || []
}

function pipelineResolveCardLimitTotal(parsed, dimensions) {
	if (dimensions?.cardUtilizationRate > 0) {
		return dimensions.usedCardLimit / dimensions.cardUtilizationRate
	}
	return (parsed.creditAccounts || [])
		.filter((a) => !a.isLoan && !a.isSettled)
		.reduce((s, a) => s + (a.limit || 0), 0)
}

/** 负债计算引擎：结构分解 + 近 6 个月到期预警（锚定报告日期） */
function pipelineRunDebtEngine(parsed, dimensions, anchorDate) {
	const debt = computeDebtStructure(parsed, dimensions)
	const loans = (parsed.creditAccounts || []).filter((a) => !a.isSettled && a.isLoan)
	const upcoming = calculateUpcomingDue(loans, anchorDate)
	return { debt, upcoming }
}

/** 查询统计引擎：相对报告日期的固定窗口 */
function pipelineRunQueryEngine(queryItems, anchorDate) {
	return analyzeQueryWindows(queryItems, anchorDate)
}

/** 风险评分卡：综合分 0–100 */
function pipelineRunRiskScorecard(debt, dimensions, queryWindows, institutionCount, cardLimitTotal) {
	return calculateIntegratedRiskScore({
		总信用负债: debt.totalCreditDebt,
		totalCreditDebt: debt.totalCreditDebt,
		信用卡已使用: debt.cardTotal,
		cardUsed: debt.cardTotal,
		信用卡总额度: cardLimitTotal,
		cardLimitTotal,
		近三个月查询总次数: queryWindows['近三个月']?.总次数 ?? dimensions?.q3 ?? 0,
		q3: dimensions?.q3,
		放贷机构数: institutionCount,
		非银行贷款: debt.nonBankLoan.amount,
		nonBankLoan: debt.nonBankLoan.amount
	})
}

/**
 * @param {object} parsed
 * @param {object|null} dimensions
 * @param {string} [rawText]
 */
export function buildAlgorithmReport(parsed, dimensions = null, rawText = '') {
	const reportDate = parseReportDate(parsed.basicInfo, rawText)
	const queryItems = pipelineExtractQueryItems(parsed)
	const { debt, upcoming } = pipelineRunDebtEngine(parsed, dimensions, reportDate)
	const queriesByWindow = pipelineRunQueryEngine(queryItems, reportDate)
	const analysisAnchorDate = reportDate.toISOString().slice(0, 10)
	const overdueSummary = analyzeOverdueSummary(parsed.creditAccounts || [])
	const institutionCount = countLendingInstitutions(parsed)
	const cardLimitTotal = pipelineResolveCardLimitTotal(parsed, dimensions)
	const integrated = pipelineRunRiskScorecard(debt, dimensions, queriesByWindow, institutionCount, cardLimitTotal)
	const narrative = buildDebtNarrative(debt, upcoming)

	return {
		version: 'v3',
		reportBenchmarkDate: analysisAnchorDate,
		liveTimeBenchmarkAt: analysisAnchorDate,
		queryBenchmarkLiveAt: analysisAnchorDate,
		creditDebt: {
			total: debt.totalCreditDebt,
			loan: debt.loanTotal,
			card: debt.cardTotal
		},
		breakdown: debt,
		upcomingDue: upcoming,
		queryWindows: queriesByWindow,
		overdueSummary,
		integratedRisk: integrated,
		narrative,
		institutionCount,
		pipeline: {
			schema: 'credit-deterministic-v3',
			stages: ['time_anchor', 'debt_engine', 'query_engine', 'overdue_institution', 'risk_scorecard', 'assembly'],
			formulaCreditDebt: 'Σ贷款未结清余额 + Σ信用卡已用额度'
		}
	}
}

/** OCR 后处理常用正则（供扩展模块引用） */
export const OCR_FIELD_PATTERNS = {
	name: /姓名[：:]\s*([\u4e00-\u9fa5]{2,4})/,
	idCard: /证件号码[：:]\s*(\d{17}[\dXx])/,
	reportDate: /报告时间[：:]\s*(\d{4}-\d{2}-\d{2})/,
	creditCardCount: /信用卡.*账户数.*?(\d+)/,
	loanCount: /贷款.*其他.*?(\d+)/,
	bigInstallment: /大额专项分期余额[：:]?\s*([\d,]+)/
}
