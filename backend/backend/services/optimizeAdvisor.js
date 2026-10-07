'use strict'

/**
 * 动态优化方案生成引擎
 *
 * 根据用户的征信分析数据，用纯规则引擎匹配个性化优化策略。
 * 不调用 AI — 所有阈值和策略均为确定性规则，可审计、可回归。
 *
 * 被 /api/optimize/plans 调用，响应格式与现有前端 optimize-plan.uvue 完全兼容。
 */

// ──────────────────────────────────────────────
// 方案库（方案模板 + 触发条件 + 优先级）
// ──────────────────────────────────────────────

/**
 * 每条规则：
 *   id            唯一标识
 *   priority      优先级（数字越小越靠前）
 *   condition     (analysis) => boolean  返回 true 时触发
 *   build         (analysis) => plan 对象
 */
const RULES = [
	// ─── 逾期问题（最优先） ───
	{
		id: 'overdue_repair',
		priority: 1,
		condition: (a) => {
			const ov = a.overdue_info || {}
			if (ov.has_overdue || (ov.total_overdue_months || 0) > 0) return true
			return false
		},
		build: (a) => {
			const ov = a.overdue_info || {}
			const months = ov.total_overdue_months || ov.details?.length || 0
			const has90 = ov.overdue_90_days || ov.details?.some((d) => /M[3-7]|连[3-7]|90/.test(String(d.level || d || '')))
			const severity = has90 ? '严重' : months >= 3 ? '中等' : '轻度'

			const steps = ['整理所有逾期账户清单，逐笔核对逾期金额与期数']
			if (has90) {
				steps.push('优先处理连续逾期 ≥90 天的账户：主动联系机构协商个性化还款计划')
				steps.push('如逾期原因有客观因素（如疾病/失业），可收集证明材料申请征信异议')
			} else {
				steps.push('立即结清当前逾期款项，部分机构在还清后可从"关注"调回"正常"')
				steps.push('设置自动还款，避免新增逾期记录')
			}
			steps.push('关注「征信异议申诉」入口，对错误记录提交纠正申请')
			steps.push('保持 6 个月以上按时还款，逾期负面影响会随时间递减')

			return {
				id: 'overdue_repair',
				title: '逾期记录修复',
				description: `检测到 ${months} 条逾期记录（${severity}），优先修复历史逾期，阻止信用继续恶化`,
				expected: months > 1
					? `修复完成后，预计 6-12 个月评分可回升 20-40 分（连续正常还款是关键）`
					: '及时处理本次逾期，6 个月内无新增逾期可稳定评分',
				difficulty: has90 ? '较难' : '适中',
				difficultyKey: has90 ? 'hard' : 'medium',
				emoji: '⚠️',
				steps
			}
		}
	},

	// ─── 查询过多 ───
	{
		id: 'query_cooldown',
		priority: 2,
		condition: (a) => {
			const q = a.query_analysis || {}
			const s = q.summary || {}
			const last3m = (s.last_3m && s.last_3m.total) || 0
			const last6m = (s.last_6m && s.last_6m.total) || 0
			return last3m >= 6 || last6m >= 12
		},
		build: (a) => {
			const q = a.query_analysis || {}
			const s = q.summary || {}
			const last1m = (s.last_1m && s.last_1m.total) || 0
			const last3m = (s.last_3m && s.last_3m.total) || 0

			return {
				id: 'query_cooldown',
				title: '征信查询冷却',
				description: `近 3 个月查询 ${last3m} 次（近 1 月 ${last1m} 次），查询记录过多会拉低评分`,
				expected: '进入 3-6 个月"查询冷却期"后，评分可回升 10-20 分',
				difficulty: '简单',
				difficultyKey: 'easy',
				emoji: '🔍',
				steps: [
					'暂停申请新的贷款/信用卡，避免产生新的"硬查询"记录',
					'关注"查询详情"中标记的"疑似放款"记录，确认是否为本人操作',
					'如存在未经授权的机构查询，可在异议申诉中提交纠正',
					`建议等待至少 ${last3m >= 10 ? '6' : '3'} 个月再申请新信贷产品`,
					'日常管理类查询（贷后管理/本人查询）不影响评分，无需担心'
				]
			}
		}
	},

	// ─── 高负债率 ───
	{
		id: 'debt_reduction',
		priority: 3,
		condition: (a) => {
			const cd = a.credit_debt || {}
			const ratio = Number(cd.debt_ratio || 0)
			return ratio > 0.6
		},
		build: (a) => {
			const cd = a.credit_debt || {}
			const ratio = Number(cd.debt_ratio || 0)
			const total = cd.total_debt || 0
			const loans = cd.credit_loans || {}
			const nonBank = loans.non_bank_amount || 0
			const severity = ratio > 0.85 ? '严重偏高' : ratio > 0.7 ? '偏高' : '略高'

			const steps = [`当前负债率 ${(ratio * 100).toFixed(0)}%（总负债 ${(total / 10000).toFixed(1)} 万），${severity}`]
			if (nonBank > 0) {
				steps.push(`优先偿还非银行机构贷款（余额约 ${(nonBank / 10000).toFixed(1)} 万），非银贷款利率通常更高`)
				steps.push('考虑将高息非银贷款置换为银行消费贷（如资质允许）')
			}
			steps.push('制定月度还款计划：优先还利率最高的债务（"雪崩法"）')
			steps.push('如有大额信用卡分期，提前结清可降低负债率计算基数')
			steps.push('目标：6 个月内将负债率降至 60% 以下')

			return {
				id: 'debt_reduction',
				title: '负债率优化',
				description: `当前负债率 ${(ratio * 100).toFixed(0)}%，${severity}，降低负债率是提升评分最有效的途径之一`,
				expected: ratio > 0.8
					? '负债率降至 60% 以下后，评分预计提升 25-40 分'
					: '负债率降至 50% 以下后，评分预计提升 15-25 分',
				difficulty: ratio > 0.8 ? '较难' : '适中',
				difficultyKey: ratio > 0.8 ? 'hard' : 'medium',
				emoji: '💰',
				steps
			}
		}
	},

	// ─── 信用卡使用率过高 ───
	{
		id: 'card_usage_optimize',
		priority: 4,
		condition: (a) => {
			const cd = a.credit_debt || {}
			const cards = cd.credit_cards || {}
			const rate = Number(cards.usage_rate || 0)
			return rate > 0.5
		},
		build: (a) => {
			const cd = a.credit_debt || {}
			const cards = cd.credit_cards || {}
			const rate = Number(cards.usage_rate || 0)
			const used = cards.total_used || 0
			const limit = cards.total_limit || 1

			return {
				id: 'card_usage_optimize',
				title: '信用卡使用率优化',
				description: `当前信用卡使用率 ${(rate * 100).toFixed(0)}%（已用 ${(used / 10000).toFixed(1)} 万 / 授信 ${(limit / 10000).toFixed(1)} 万），偏高`,
				expected: '使用率降至 30% 以下后，评分预计提升 10-20 分',
				difficulty: '适中',
				difficultyKey: 'medium',
				emoji: '💳',
				steps: [
					`目标使用率 ≤30%（即已用额度控制在 ${(limit * 0.3 / 10000).toFixed(1)} 万以内）`,
					'优先偿还已用额度最高的卡片，降低单卡使用率',
					'避免信用卡"以卡养卡"：套现还其他卡会被银行风控识别',
					rate > 0.7 ? '如有大额消费需求，考虑申请临时提额（不增加硬查询的前提下）' : null,
					'出账日前还款可降低"已用额度"在征信报告中的展示值',
					'长期目标：注销不常用的冗余卡片（保留 2-4 张常用即可）'
				].filter(Boolean)
			}
		}
	},

	// ─── 多头借贷 / 机构数过多 ───
	{
		id: 'account_consolidation',
		priority: 5,
		condition: (a) => {
			const loans = (a.loan_details || a.credit_debt?.credit_loans) || {}
			const bankCount = loans.bank_count || loans.subtotal_bank || 0
			const nonBankCount = loans.non_bank_count || loans.subtotal_non_bank || 0
			const cardCount = (a.credit_card_details || []).length
			return (bankCount + nonBankCount + cardCount) > 8
		},
		build: (a) => {
			const loans = (a.loan_details || a.credit_debt?.credit_loans) || {}
			const bankCount = loans.bank_count || loans.subtotal_bank || 0
			const nonBankCount = loans.non_bank_count || loans.subtotal_non_bank || 0
			const cardCount = (a.credit_card_details || []).length
			const total = bankCount + nonBankCount + cardCount

			return {
				id: 'account_consolidation',
				title: '账户精简优化',
				description: `当前共有约 ${total} 个信贷账户（银行 ${bankCount} + 非银 ${nonBankCount} + 信用卡 ${cardCount}），机构数偏多`,
				expected: '精简至 6 个以内后，评分预计提升 5-15 分',
				difficulty: '适中',
				difficultyKey: 'medium',
				emoji: '📋',
				steps: [
					'结清并注销余额为 0 的小额非银行贷款账户',
					'注销超过 1 年未使用的信用卡（优先注销额度最低的）',
					'将分散的小额贷款合并为一笔银行贷款（债务整合）',
					'保留最常用的 2-3 张信用卡 + 1-2 笔银行贷款即可'
				]
			}
		}
	},

	// ─── 无大问题（维护方案） ───
	{
		id: 'maintain',
		priority: 90,
		condition: () => true, // 兜底触达
		build: (a) => {
			const as = a.assessment || {}
			const score = as.score || (a.primary_rule_score && a.primary_rule_score.score) || 0

			return {
				id: 'maintain',
				title: '信用状态保持',
				description: score >= 75
					? '当前信用状态良好，继续保持现有习惯即可维持高评分'
					: '当前信用状态基本正常，持续良好习惯可稳步提升评分',
				expected: '持续 6-12 个月按时还款、控制查询频率，评分可保持稳定或小幅提升',
				difficulty: '简单',
				difficultyKey: 'easy',
				emoji: '✅',
				steps: [
					'保持所有账户按时足额还款，设置日历提醒',
					'每年自查 1-2 次征信报告，及时发现异常',
					'控制新增信贷申请频率（建议每年 ≤2 次）',
					'保持信用卡使用率在 30% 以下',
					'定期关注「我的报告」中的评分变化趋势'
				]
			}
		}
	}
]

// ──────────────────────────────────────────────
// 引擎入口
// ──────────────────────────────────────────────

/**
 * 从用户最新报告的分析数据生成个性化优化方案列表。
 *
 * @param {object|null} analysis — 报告中的 AI 分析结果（已存入 store.reports[].analysisResult）
 * @returns {Array<object>} 优化方案列表（按优先级排序），analysis 为空时返回通用引导
 */
function generatePlans(analysis) {
	if (!analysis || typeof analysis !== 'object') {
		// 无报告数据：返回通用引导方案
		return [{
			id: 'guide',
			title: '上传征信报告获取专属方案',
			description: '上传您的个人征信报告后，系统将结合您的实际信用状况生成定制化优化路径',
			expected: '获得个性化方案后，按优先级逐步执行即可提升综合评分',
			difficulty: '简单',
			difficultyKey: 'easy',
			emoji: '📄',
			steps: ['上传个人征信报告（PDF 或截图）', '等待 AI 深度分析完成', '查看为您定制的优化方案与执行步骤']
		}]
	}

	// 触发匹配的规则，按优先级排序
	const matched = RULES
		.filter((rule) => {
			try {
				return rule.condition(analysis)
			} catch {
				return false
			}
		})
		.sort((a, b) => a.priority - b.priority)
		.map((rule) => {
			try {
				return rule.build(analysis)
			} catch {
				return null
			}
		})
		.filter(Boolean)

	// 至少保证一条方案（兜底是 maintain）
	return matched.length > 0 ? matched : [RULES.find((r) => r.id === 'maintain').build(analysis)]
}

module.exports = { generatePlans, RULES }
