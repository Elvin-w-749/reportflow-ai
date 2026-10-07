export const SCORE_COPY = Object.freeze({
  reportTotal: {
    label: '综合分',
    summaryLabel: '综合分',
    sourceTitle: '综合分来源',
    overduePriorityLabel: '逾期专项优先',
    primaryRuleLabel: '主评分框架',
    fourDimensionLabel: '四维评分',
    legacyLabel: '历史兼容字段',
    riskLevelLabel: '风险等级',
    hint: '信用报告主评分，由结构化报告、逾期专项规则和四维评分共同决定'
  },
  matchRate: {
    label: '匹配度',
    maxLabel: '最高匹配度',
    hint: '产品规则与当前信用画像的排序分，不是信用报告综合分'
  },
  debtPriority: {
    label: '处理优先级',
    sectionTitle: '处理优先级分层',
    sortNote: '按处理优先级排序',
    hint: '单笔债务处理顺序分，不是信用报告综合分'
  }
})

const hasDisplayValue = (value) => value !== undefined && value !== null && value !== ''

export const reportScoreText = (value) => hasDisplayValue(value)
  ? `${SCORE_COPY.reportTotal.label} ${value}`
  : ''

export const matchRateText = (value) => hasDisplayValue(value)
  ? `${value}%匹配`
  : ''

export const matchRateLabel = (value) => hasDisplayValue(value)
  ? `${SCORE_COPY.matchRate.label} ${value}%`
  : ''
