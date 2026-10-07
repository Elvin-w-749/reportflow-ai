/**
 * aiAnalysis 内部：时间轴推演 + 最终分析报告组装
 *
 *   · formatMoney：手写千分位（不依赖 toLocaleString，兼容缺 ICU 的 JS 引擎）
 *   · generateTimeline：6 个月信用恢复/恶化推演
 *   · generateReport：风控结论 + 改善建议 + 行为画像 + 演化推演 + 结果解释
 */

import { calculatePrimaryRuleScore } from '../creditAlgorithmCore.js'
import { getLiveTimeAnchor } from '../../utils/beijingTime.js'
import { calculateTotalScore, applyOverdueTotalCap } from './scoring.js'
import { isDimensionSparse } from './dimensions.js'

// ─────────────────────────────────────────────
// 工具：格式化金额（加千分位）
// ─────────────────────────────────────────────
// 手写千分位（至多保留 2 位小数，去尾随 0）。不依赖 toLocaleString：
// 部分 JS 引擎缺 ICU/locale 数据，toLocaleString('zh-CN', …) 可能退化或抛错。
const formatMoney = (num) => {
	if (!num && num !== 0) return '0'
	const n = Number(num)
	if (!Number.isFinite(n)) return '0'
	const neg = n < 0
	const fixed = Math.abs(n).toFixed(2).replace(/\.?0+$/, '')
	const parts = fixed.split('.')
	const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	return (neg ? '-' : '') + grouped + (parts[1] ? '.' + parts[1] : '')
}

// ─────────────────────────────────────────────
// 生成时间轴推演（6个月）
// ─────────────────────────────────────────────
export const generateTimeline = (scores, dim) => {
	const totalScore = applyOverdueTotalCap(calculateTotalScore(scores), dim)
	const timeline   = []
	const now        = getLiveTimeAnchor()

	timeline.push({
		month:  '当前',
		score:  totalScore,
		status: dim.isHighRisk ? 'warning' : 'good',
		events: buildCurrentEvents(dim)
	})

	for (let i = 1; i <= 6; i++) {
		const month  = new Date(now.getFullYear(), now.getMonth() + i, 1)
		const label  = `${month.getMonth() + 1}月`
		let   score  = totalScore
		let   status = 'good'
		const events = []

		// 逾期影响衰减：M1逾期影响约6个月，M3+约24个月
		if (dim.hasOverdue) {
			const decayMonths = dim.hasLianSan || dim.hasLeiLiu ? 24 : dim.m3Count > 0 ? 18 : 6
			if (i < decayMonths) {
				// 前期无明显恢复
				status = i <= 2 ? 'warning' : 'improving'
				events.push(i <= 2 ? '逾期影响仍持续' : '信用缓慢恢复中')
			} else {
				score += (i - decayMonths) * 2
				events.push('逾期影响逐步消除')
			}
		} else {
			score += i * 1.5  // 无逾期稳步提升
			events.push('信用稳步积累中')
		}

		// 添加具体建议
		if (i === 2 && dim.q1 > 3) events.push('建议暂停申请新信用')
		if (i === 3 && dim.debtRatioExceeds70) events.push('建议优先还款降负债率')
		if (i === 4 && dim.m1Count > 0) events.push('M1逾期记录满6个月可申请异议')

		timeline.push({
			month:  label,
			score:  Math.min(100, Math.round(score)),
			status,
			events
		})
	}

	return timeline
}

const buildCurrentEvents = (dim) => {
	const events = []
	if (dim.hasLianSan)        events.push('存在连续逾期3期，属高风险标记')
	if (dim.hasLeiLiu)         events.push('累计逾期6期，大部分银行产品受限')
	if (dim.m3Count > 0)       events.push('存在 M3+ 严重逾期，需立即处理')
	if (dim.m2Count > 0)       events.push('存在 M2 逾期，影响中高端产品准入')
	if (dim.m1Count > 0)       events.push('存在 M1 逾期，建议尽快还清')
	if (dim.debtRatioExceeds70) events.push('综合负债率超70%，建议降低负债')
	if (dim.q1 > 3)            events.push('近1月查询过多，建议停止新申请')
	if (dim.hasPublicRecord)   events.push('存在公共记录，严重影响信用')
	if (events.length === 0)   events.push('当前信用状况良好')
	return events
}

// ─────────────────────────────────────────────
// 生成分析报告（风控结论，整合 AI 专业建议 + 行为画像 + 演化推演）
// ─────────────────────────────────────────────
export const generateReport = (scores, dim, aiResult = null, behaviorProfile = null, debtEvolution = null, algorithmReport = null) => {
		// v8：页头「总分」= 主评分框架（规则扣分制）
		const primaryRuleScore = calculatePrimaryRuleScore(dim)
		let totalScore = primaryRuleScore.score
	const mapZhRiskToEn = (lv) => {
		const s = String(lv || '').trim()
		if (s === '高') return 'high'
		if (s === '中') return 'medium'
		if (s === '低') return 'low'
		return null
	}
	const aiFirstMode = !!aiResult && isDimensionSparse(dim)
	const aiRiskLevel = (() => {
		const rl = String(aiResult?.risk_level || '').toLowerCase()
		if (rl === 'high' || rl === 'medium' || rl === 'low') return rl
		return null
	})()
	const aiTopRisk = Array.isArray(aiResult?.risk_tags) ? aiResult.risk_tags.slice(0, 3) : []
	const aiSuggestionText = String(aiResult?.suggestion || '').trim()

	// ── 风险等级与摘要：与 v5 一致，仅以 dimensions + 总分为准（避免模型语义与数值核心结论打架）
	let riskLevel, summary
	const hasSevereRisk = !!(dim.hasLianSan || dim.hasLeiLiu || dim.m3Count > 0 || dim.hasPublicRecord)
	if (hasSevereRisk) {
		riskLevel = 'high'
		summary   = '存在严重风险标记（连三累六/M3+逾期/公共记录），绝大多数银行产品不可申请'
	} else if (aiFirstMode && aiRiskLevel) {
		riskLevel = aiRiskLevel
		const riskTxt = aiTopRisk.length > 0 ? `AI识别风险点：${aiTopRisk.join('、')}` : 'AI已完成信用语义分析'
		summary = aiSuggestionText
			? `${riskTxt}。${aiSuggestionText.slice(0, 60)}`
			: `${riskTxt}。建议结合报告详情逐项优化后再申请产品。`
	} else if (algorithmReport?.integratedRisk) {
		riskLevel = mapZhRiskToEn(algorithmReport.integratedRisk.risk_level) || 'medium'
		const f = Array.isArray(algorithmReport.integratedRisk.factors) ? algorithmReport.integratedRisk.factors : []
		const factorText = f.length > 0 ? `风险因子：${f.join('、')}` : '已完成规则引擎风险评估'
		// 低置信度（数据稀疏）：integratedRisk.score 为 null，已回退到 calculateTotalScore；
		// 此时只展示来自四维评分的综合分，并提示数据不足
		if (algorithmReport.integratedRisk.score == null || algorithmReport.integratedRisk.confidence === 'low') {
				summary = `${factorText}。综合分 ${totalScore} 分（主评分框架）。`
		} else {
				summary = `${factorText}。综合风险分 ${totalScore} 分（主评分框架）。`
		}
	} else if (dim.m2Count > 0 || dim.debtRatioExceeds70 || totalScore < 65) {
		riskLevel = 'medium'
		summary   = '信用存在中等风险，可申请部分民间金融机构产品，银行类产品受限'
	} else if (dim.m1Count > 0 || dim.q1 > 3 || totalScore < 80) {
		riskLevel = 'medium-low'
		summary   = '信用状况基本正常，存在轻微瑕疵，可申请大部分银行产品'
	} else {
		riskLevel = 'low'
		summary   = '信用状况优质，可申请全品类银行产品，建议优先申请低利率白名单产品'
	}

	// ── 薄弱维度 ─────────────────────────────
	const weakPoints = Object.entries(scores)
		.filter(([, v]) => typeof v === 'number' && v < 70)
		.map(([k]) => k)

	// ── 改善建议（决策树触发 + AI 专业建议合并）
	const suggestions = []

	// 决策节点1：严重逾期 → 立即清偿
	if (dim.hasOverdue) {
		suggestions.push({
			title:    '立即清偿逾期款项',
			desc:     `当前逾期金额 ${formatMoney(dim.totalOverdueAmt)} 元，还清后逾期状态将在下期更新`,
			priority: 'high',
			effect:   '可在1-3个月内提升还款记录评分',
			trigger:  'overdue'
		})
	}

	// 决策节点2：高负债率 → 降负债
	if (dim.debtRatioExceeds70) {
		suggestions.push({
			title:    '降低综合负债率',
			desc:     `当前负债率 ${(dim.debtRatio * 100).toFixed(0)}%，建议优先还清信用卡，控制在70%以下`,
			priority: 'high',
			effect:   '负债率降至50%可显著提升匹配产品数量',
			trigger:  'high_debt'
		})
	}

	// 决策节点3：频繁查询 → 停止申请
	if (dim.q1 > 3) {
		suggestions.push({
			title:    '停止新增信用查询',
			desc:     `近1个月查询 ${dim.q1} 次，过多查询会被银行认为资金需求迫切`,
			priority: 'medium',
			effect:   '暂停申请3个月后，查询频率恢复正常区间',
			trigger:  'high_query'
		})
	}

	// 决策节点4：信用卡超限 → 降使用率
	if (dim.cardUtilizationRate > 0.5) {
		suggestions.push({
			title:    '降低信用卡使用率',
			desc:     `当前信用卡使用率 ${(dim.cardUtilizationRate * 100).toFixed(0)}%，建议控制在50%以下`,
			priority: 'medium',
			effect:   '降至30%以下可改善整体信用结构（信用卡使用率是综合负债画像的主要拉低项）',
			trigger:  'high_utilization'
		})
	}

	// 决策节点5：多头借贷 → 整合债务
	if (dim.loanCount > 6 && dim.q3 > 5) {
		suggestions.push({
			title:    '整合多头债务',
			desc:     `当前贷款账户${dim.loanCount}个，近3月查询${dim.q3}次，多头借贷特征明显`,
			priority: 'high',
			effect:   '债务整合后可减少查询次数，降低单月还款压力',
			trigger:  'multi_loan'
		})
	}

	if (algorithmReport?.integratedRisk?.factors?.length) {
		suggestions.push({
			title:    '负债与查询结构提示（算法 v3）',
			desc:     algorithmReport.integratedRisk.factors.join('；'),
			priority: 'medium',
			effect:   '结清小额非银贷款、控制信用卡使用率、暂停新增查询可改善综合评估',
			trigger:  'algo_v3'
		})
	}
	if (algorithmReport?.upcomingDue?.笔数 > 0) {
		suggestions.push({
			title: '近期到期债务预警',
			desc: `近六个月到期 ${algorithmReport.upcomingDue.笔数} 笔，合计 ${formatMoney(algorithmReport.upcomingDue.合计余额)} 元，请提前安排还款。`,
			priority: 'high',
			effect: '降低逾期概率，避免新增不良记录',
			trigger: 'upcoming_due'
		})
	}

	// 决策节点6：账户过少 → 建立信用
	if (dim.totalAccountCount < 2) {
		suggestions.push({
			title:    '适当增加信用账户',
			desc:     '仅有1个信用账户，建议申请1-2张信用卡建立多维信用记录',
			priority: 'low',
			effect:   '丰富账户结构有助于提升信用历史评分',
			trigger:  'thin_file'
		})
	}

	// AI 专业建议补充（不与本地建议重复时添加）
	if (aiResult?.suggestion && (!dim.hasOverdue || aiFirstMode) && !dim.debtRatioExceeds70) {
		suggestions.push({
			title:    'AI 专业建议',
			desc:     aiResult.suggestion,
			priority: 'medium',
			effect:   '',
			source:   'ai',
			trigger:  'ai_suggestion'
		})
	}

	// ── 深度诊断（核心风险点摘要）──────────────
	const keyFindings = []
	if (dim.loanCount > 10) keyFindings.push(`贷款账户${dim.loanCount}个，消费金融多头特征，实际负债率可能被低估`)
	if (dim.q6 > 12) keyFindings.push(`近半年查询${dim.q6}次（含贷款审批${dim.loanQueryCount}次），存在明显以贷养贷特征`)
	if (dim.cardUtilizationRate > 0.8) keyFindings.push(`信用卡使用率${(dim.cardUtilizationRate * 100).toFixed(0)}%，循环利息消耗大，实际还款压力高于账面`)
	if (dim.hasLianSan) keyFindings.push('连续3期逾期（连三），已触发银行核心风控红线')
	if (dim.hasLeiLiu) keyFindings.push('累计6期逾期（累六），大多数银行将永久拒绝申请')
	if (dim.hasPublicRecord) keyFindings.push('存在公共记录（法院/税务），属最高级风险标记')
	if (keyFindings.length === 0) keyFindings.push('未发现核心风险点，信用状况健康')

	// ── 结果解释功能 ───────────────────────────
	const generateExplanation = () => {
		// v5：四维评分解释（移除 偿债能力 / 负债比例）
		const dimensionExplanations = {
			'信用历史': {
				description: '评估您的信用历史长度和质量',
				scoreRange: {
					'85-100': '信用历史悠久且良好',
					'70-84': '信用历史较好，有一定积累',
					'50-69': '信用历史较短或存在瑕疵',
					'0-49': '信用历史严重不足或有重大问题'
				},
				factors: ['账龄长度', '账户数量', '还款记录']
			},
			'查询频率': {
				description: '评估您近期的信用查询频率',
				scoreRange: {
					'85-100': '查询频率低，信用需求稳定',
					'70-84': '查询频率适中，信用需求正常',
					'50-69': '查询频率较高，可能存在资金需求',
					'0-49': '查询频率过高，资金需求迫切'
				},
				factors: ['近6月>6次', '7/30天集中查询', '同日≥3次', '近1月/3月查询']
			},
			'账户结构': {
				description: '评估您的信用账户多样性和合理性',
				scoreRange: {
					'85-100': '账户结构合理，多样性良好',
					'70-84': '账户结构较好，有一定多样性',
					'50-69': '账户结构一般，多样性不足',
					'0-49': '账户结构不合理，多样性差'
				},
				factors: ['账户类型', '账户数量', '结清记录']
			},
			'还款记录': {
				description: '以逾期记录为核心（演示配置下的主要扣分维度）',
				scoreRange: {
					'85-100': '无逾期，还款表现优秀',
					'70-84': '偶有 M1 等轻微逾期',
					'50-69': '存在 M2 或多笔逾期',
					'0-49': 'M3+ / 连三累六等严重逾期'
				},
				factors: ['M1/M2/M3+', '逾期账户数', '最长逾期天数', '连三累六']
			}
		}

		// 风险等级解释
		const riskLevelExplanations = {
			high: {
				description: '高风险',
				explanation: '存在严重信用问题，如连三累六、M3+逾期或公共记录，绝大多数银行产品不可申请',
				recommendation: '建议立即处理逾期款项，改善信用记录，至少等待1-2年再申请金融产品'
			},
			medium: {
				description: '中等风险',
				explanation: '信用存在一定问题，如M2逾期、高负债率或低评分，银行产品受限',
				recommendation: '建议改善薄弱环节，如降低负债、减少查询，3-6个月后再申请'
			},
			'medium-low': {
				description: '中低风险',
				explanation: '信用状况基本正常，存在轻微瑕疵，可申请大部分银行产品',
				recommendation: '保持良好还款习惯，逐步改善薄弱环节'
			},
			low: {
				description: '低风险',
				explanation: '信用状况优质，无明显风险点，可申请全品类银行产品',
				recommendation: '维持良好信用习惯，可优先申请低利率产品'
			}
		}

		// 行为画像解释
		const behaviorExplanations = (tags) => {
			const explanations = []
			tags.forEach(tag => {
				switch (tag) {
					case '信用卡依赖型':
						explanations.push('您的信用卡使用频率高，存在以卡养卡的风险，建议控制信用卡使用率在50%以下')
						break
					case '多头借贷型':
						explanations.push('您的贷款账户较多且查询频繁，存在多头借贷风险，建议整合债务并暂停新申请')
						break
					case '频繁查询型':
						explanations.push('您近期查询频率过高，可能被银行视为资金需求迫切，建议暂停申请3个月')
						break
					case '高负债压缩型':
						explanations.push('您的负债率过高，已超过银行风控红线，建议优先还清部分债务降低负债率')
						break
					case '严重逾期型':
						explanations.push('您存在严重逾期记录，已触发银行核心风控，建议立即处理逾期并保持良好还款')
						break
					case '公共记录风险':
						explanations.push('您存在公共记录，严重影响信用评估，建议优先处理相关债务')
						break
					case '信用白户':
						explanations.push('您的信用记录较少，建议申请1-2张信用卡建立基础信用')
						break
					case '信用优质型':
						explanations.push('您的信用状况优质，建议维持良好习惯，可申请低利率产品')
						break
				}
			})
			return explanations
		}

		// 债务演化解释
		const debtEvolutionExplanation = (evolution) => {
			if (!evolution) return '暂无债务演化分析'
			const { initialState, scenarios } = evolution
			const explanations = []
			explanations.push(`当前债务状态：${initialState}`)
			explanations.push('未来12个月债务演化预测：')
			Object.entries(scenarios).forEach(([key, scenario]) => {
				explanations.push(`${scenario.label}：${scenario.description}（概率${scenario.probability}%）`)
			})
			return explanations
		}

		return {
			dimensionExplanations,
			riskLevelExplanation: riskLevelExplanations[riskLevel] || riskLevelExplanations.medium,
			behaviorExplanations: behaviorExplanations(behaviorProfile?.tags || []),
			debtEvolutionExplanation: debtEvolutionExplanation(debtEvolution),
			totalScoreExplanation: {
				description: '综合信用评分，反映整体信用状况',
				scoreRange: {
					'85-100': '信用优秀，可申请所有金融产品',
					'70-84': '信用良好，可申请大部分金融产品',
					'50-69': '信用一般，申请金融产品可能受限',
					'0-49': '信用较差，申请金融产品困难'
				},
				factors: ['信用历史', '查询频率', '账户结构', '还款记录']
			}
		}
	}

	const explanation = generateExplanation()

	return {
		totalScore,
		riskLevel,
		summary,
		weakPoints,
		suggestions,
		keyFindings,
		// 行为画像标签（v4.0新增）
		behaviorTags:    behaviorProfile?.tags || [],
		behaviorDetails: behaviorProfile?.details || [],
		hiddenRisks:     behaviorProfile?.hiddenRisks || [],
		// 债务演化推演（v4.0新增）
		debtEvolution:   debtEvolution || null,
		// AI 专属字段
		riskTags:    aiResult?.risk_tags || [],
		productAccessibility: aiResult?.product_accessibility || null,
		aiSuggestion: aiResult?.suggestion || '',
		strictAlgorithm: algorithmReport ? {
			reportBenchmarkDate: algorithmReport.reportBenchmarkDate,
			creditDebt: algorithmReport.creditDebt,
			upcomingDue: algorithmReport.upcomingDue,
			queryWindows: algorithmReport.queryWindows,
			overdueSummary: algorithmReport.overdueSummary,
			integratedRisk: algorithmReport.integratedRisk,
			narrative: algorithmReport.narrative
		} : null,
		// ── 四维评分快照（供 matchEngine、detail.uvue 直接读取）──
		// v5：移除偿债能力 / 负债比例；保留中英双键名
		// v7：无保底分。保留真实 0 分；缺失 → null（UI 显示「—」），不再垫 60/70
		scores: {
			credit_history:    scores?.['信用历史'] ?? null,
			query_frequency:   scores?.['查询频率'] ?? null,
			account_structure: scores?.['账户结构'] ?? null,
			repayment_record:  scores?.['还款记录'] ?? null,
			'信用历史': scores?.['信用历史'] ?? null,
			'查询频率': scores?.['查询频率'] ?? null,
			'账户结构': scores?.['账户结构'] ?? null,
			'还款记录': scores?.['还款记录'] ?? null,
		},
		// 维度详细数据（供产品匹配页使用）
		dimensionSnapshot: {
			debtRatioPct:   Math.round(dim.debtRatio * 100),
			overdueCount:   dim.overdueCount,
			maxOverdueDays: dim.maxOverdueDays,
			m1Count:        dim.m1Count,
			m2Count:        dim.m2Count,
			m3Count:        dim.m3Count,
			hasLianSan:     dim.hasLianSan,
			hasLeiLiu:      dim.hasLeiLiu,
			q1:             dim.q1,
			q3:             dim.q3,
			totalAccountCount: dim.totalAccountCount
		},
		// 结果解释功能（新增）
		explanation,
		algorithmReport: algorithmReport || null,
		integratedRiskScore: algorithmReport?.integratedRisk?.score ?? null,
		integratedRiskLevel: algorithmReport?.integratedRisk?.risk_level ?? null,
		debtNarrative: algorithmReport?.narrative || '',
		primaryRuleScore
	}
}
