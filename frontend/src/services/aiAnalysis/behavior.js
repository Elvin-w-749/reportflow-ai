/**
 * aiAnalysis 内部：行为画像 + 债务演化推演
 *
 *   · analyzeBehavior：信贷行为标签体系（信用卡依赖/多头借贷/严重逾期 等）
 *   · simulateDebtEvolution：马尔可夫链状态转移（乐观/基准/悲观三场景）
 *   · buildEvolutionWarnings：基于基准场景的关键预警
 */

// ─────────────────────────────────────────────
// 行为画像分析（信贷行为标签体系）
// ─────────────────────────────────────────────
export const analyzeBehavior = (dim, aiResult = null) => {
	const tags    = []
	const details = []

	// 1. 信用卡依赖型：信用卡>5张 且 使用率>50%
	if (dim.creditCardCount > 5 && dim.cardUtilizationRate > 0.5) {
		tags.push('信用卡依赖型')
		details.push({
			tag:     '信用卡依赖型',
			feature: '高周转依赖，以卡养卡风险',
			advice:  '优先偿还信用卡余额，将使用率降至50%以下，减少循环利息损耗',
			level:   'warning'
		})
	}

	// 2. 多头借贷型：贷款账户>6个 且 近3月查询>5次
	if (dim.loanCount > 6 && dim.q3 > 5) {
		tags.push('多头借贷型')
		details.push({
			tag:     '多头借贷型',
			feature: '资金饥渴型，频繁申请信贷',
			advice:  '立即停止新增借贷申请，整合现有债务，暂停3-6个月新申请',
			level:   'danger'
		})
	}

	// 3. 高查询风险型：近1月查询>4次（强烈的资金需求信号）
	if (dim.q1 > 4) {
		tags.push('频繁查询型')
		details.push({
			tag:     '频繁查询型',
			feature: `近1个月查询${dim.q1}次，被银行识别为资金饥渴`,
			advice:  '立即停止所有信贷申请，等待3个月后查询记录自然稀释',
			level:   'danger'
		})
	}

	// 4. 高负债压缩型：负债率>70%
	if (dim.debtRatioExceeds70) {
		tags.push('高负债压缩型')
		details.push({
			tag:     '高负债压缩型',
			feature: `综合负债率${(dim.debtRatio * 100).toFixed(0)}%，超过银行风控红线`,
			advice:  '优先结清小额账户降低账户数，将信用卡利用率控制在50%以内',
			level:   'warning'
		})
	}

	// 5. 严重逾期型：M3+或连三累六
	if (dim.m3Count > 0 || dim.hasLianSan || dim.hasLeiLiu) {
		tags.push('严重逾期型')
		details.push({
			tag:     '严重逾期型',
			feature: dim.hasLianSan ? '存在连续逾期3期（连三）' : dim.hasLeiLiu ? '累计逾期6期（累六）' : `存在M3+严重逾期${dim.m3Count}个`,
			advice:  '立即联系贷款机构协商分期还款或债务重组，避免进入司法追偿',
			level:   'danger'
		})
	}

	// 6. 公共记录风险型
	if (dim.hasPublicRecord) {
		tags.push('公共记录风险')
		details.push({
			tag:     '公共记录风险',
			feature: '存在法院判决/强制执行/税务欠缴等公共记录',
			advice:  '优先处理公共记录涉及的债务，公共记录将导致绝大多数银行拒贷',
			level:   'danger'
		})
	}

	// 7. 信用空白型
	if (dim.totalAccountCount < 2 && dim.oldestAccountYears < 1) {
		tags.push('信用白户')
		details.push({
			tag:     '信用白户',
			feature: '信用记录极少，银行无法评估风险',
			advice:  '申请1-2张信用卡建立基础信用记录，按时全额还款6个月以上',
			level:   'info'
		})
	}

	// 8. 信用优质型（无任何风险标记）
	if (tags.length === 0 && !dim.hasOverdue && dim.debtRatio < 0.5 && dim.q1 <= 2) {
		tags.push('信用优质型')
		details.push({
			tag:     '信用优质型',
			feature: '无逾期、低负债、低查询，信用健康',
			advice:  '维持当前良好习惯，可适时申请低利率银行产品',
			level:   'good'
		})
	}

	// 隐性风险识别：消费金融多头（贷款账户多 + 单笔金额小）
	const hiddenRisks = []
	if (dim.loanCount > 10) {
		hiddenRisks.push({
			type:  '消费金融多头',
			desc:  `贷款账户数${dim.loanCount}个，疑似大量小额网贷/消费贷，实际负债率可能被低估`,
			level: 'warning'
		})
	}
	if (dim.q6 > 12) {
		hiddenRisks.push({
			type:  '密集查询轰炸',
			desc:  `近6个月查询${dim.q6}次，机构间信用风险已相互可见`,
			level: 'warning'
		})
	}

	// 结合 AI 的 risk_tags 补充
	const aiTags = aiResult?.risk_tags || []
	aiTags.forEach(t => {
		if (!tags.includes(t)) tags.push(t)
	})

	return { tags, details, hiddenRisks }
}

// ─────────────────────────────────────────────
// 债务演化推演（马尔可夫链状态转移模型）
// 三种场景：乐观（主动还款）/ 基准（维持现状）/ 悲观（继续恶化）
// ─────────────────────────────────────────────
export const simulateDebtEvolution = (dim) => {
	// 状态：M0正常 / M1-M3逾期初期 / M3-M12催收期 / M12+不良
	const STATES = ['M0正常', 'M1-M3逾期初期', 'M3-M12催收期', 'M12+不良']

	// 根据当前维度判断初始状态
	let initState = 0
	if (dim.m3Count > 0 || dim.hasLianSan || dim.hasLeiLiu) initState = 2
	else if (dim.m2Count > 0) initState = 1
	else if (dim.m1Count > 0) initState = 1

	// 三种场景的状态转移矩阵
	const matrices = {
		optimistic: [
			[0.95, 0.04, 0.01, 0.00],  // M0→保持正常概率更高
			[0.50, 0.35, 0.12, 0.03],  // M1-M3→大概率恢复正常
			[0.15, 0.25, 0.45, 0.15],  // M3-M12→积极还款有改善
			[0.03, 0.05, 0.12, 0.80]
		],
		baseline: [
			[0.85, 0.10, 0.04, 0.01],
			[0.30, 0.40, 0.20, 0.10],
			[0.05, 0.15, 0.50, 0.30],
			[0.01, 0.02, 0.07, 0.90]
		],
		pessimistic: [
			[0.70, 0.20, 0.08, 0.02],  // M0→恶化概率更高
			[0.10, 0.35, 0.35, 0.20],  // M1-M3→难以恢复
			[0.02, 0.08, 0.40, 0.50],  // M3-M12→快速恶化
			[0.00, 0.01, 0.04, 0.95]
		]
	}

	// 模拟12个月后的状态分布 - 优化计算
	const simulate = (matrix, steps = 12) => {
		// 初始化状态向量
		let state = new Array(4).fill(0)
		state[initState] = 1.0

		// 矩阵乘法优化
		for (let t = 0; t < steps; t++) {
			const next = new Array(4).fill(0)
			for (let i = 0; i < 4; i++) {
				if (state[i] === 0) continue; // 跳过零值，减少计算
				for (let j = 0; j < 4; j++) {
					next[j] += state[i] * matrix[i][j]
				}
			}
			state = next
		}
		return {
			normal:     Math.round(state[0] * 100),
			earlyOverdue: Math.round(state[1] * 100),
			collection:   Math.round(state[2] * 100),
			badDebt:      Math.round(state[3] * 100)
		}
	}

	// 并行计算三种场景
	const opt  = simulate(matrices.optimistic)
	const base = simulate(matrices.baseline)
	const pess = simulate(matrices.pessimistic)

	// 场景概率分配（基于当前风险程度）
	let optProb = 30, baseProb = 50, pessProb = 20
	if (dim.isHighRisk) { optProb = 15; baseProb = 45; pessProb = 40 }
	else if (!dim.hasOverdue && dim.debtRatio < 0.3) { optProb = 50; baseProb = 40; pessProb = 10 }

	return {
		initialState: STATES[initState],
		scenarios: {
			optimistic: {
				label:       '乐观场景（主动还款/债务整合）',
				probability: optProb,
				result:      opt,
				description: `若积极还款，12个月后正常状态概率${opt.normal}%`
			},
			baseline: {
				label:       '基准场景（维持现状）',
				probability: baseProb,
				result:      base,
				description: `维持现状，12个月后正常状态概率${base.normal}%，进入不良概率${base.badDebt}%`
			},
			pessimistic: {
				label:       '悲观场景（继续恶化）',
				probability: pessProb,
				result:      pess,
				description: `若持续恶化，12个月后不良资产概率${pess.badDebt}%`
			}
		},
		// 关键预警
		warnings: buildEvolutionWarnings(dim, base)
	}
}

const buildEvolutionWarnings = (dim, baseResult) => {
	const warnings = []
	if (baseResult.badDebt > 20) warnings.push({ level: 'danger', msg: `基准场景下12个月后进入不良资产概率${baseResult.badDebt}%，需立即行动` })
	if (baseResult.collection > 30) warnings.push({ level: 'warning', msg: `约${baseResult.collection}%概率进入催收阶段，建议主动联系机构协商` })
	if (dim.debtRatioExceeds70 && dim.q1 > 2) warnings.push({ level: 'warning', msg: '高负债+频繁查询组合，新增资金来源渠道正在快速收窄' })
	return warnings
}
