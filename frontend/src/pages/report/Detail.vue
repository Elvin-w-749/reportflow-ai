<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">信用报告分析</text>
      <view class="nav-actions">
        <text class="nav-action muted" @click="goReportManage">管理</text>
        <text class="nav-action" @click="goUpload">重传</text>
      </view>
    </view>

    <scroll-view class="scroll-body" scroll-y :scroll-into-view="scrollAnchor" :scroll-top="mainScrollTop" scroll-with-animation @scroll="handleMainScroll">
      <view v-if="missingDetail" class="empty missing-detail">
        <text class="empty-title">报告需要重新上传</text>
        <text class="empty-sub">{{ missingDetailText }}</text>
        <view class="missing-meta">
          <text class="missing-meta-text">{{ missingDetailMeta }}</text>
        </view>
        <view class="empty-btn" @click="goUpload"><text class="empty-btn-text">重新上传</text></view>
        <view class="empty-link" @click="goReportManage"><text class="empty-link-text">返回报告管理</text></view>
      </view>

      <view v-else-if="!hasReport" class="empty">
        <text class="empty-title">{{ emptyReportTitle }}</text>
        <text class="empty-sub">{{ emptyReportText }}</text>
        <view class="empty-btn" @click="requestedReportMissing ? goReportManage() : goUpload()">
          <text class="empty-btn-text">{{ requestedReportMissing ? '返回报告管理' : '去上传' }}</text>
        </view>
        <view v-if="requestedReportMissing" class="empty-link" @click="goUpload">
          <text class="empty-link-text">重新上传报告</text>
        </view>
      </view>

      <view
        v-else
        ref="reportExportRoot"
        class="wrap rpt-content-narrow"
        :class="{ 'report-export-mode': exportMode }"
        data-report-export-root
      >
        <view id="sec-profile" class="hero-card">
          <view class="hero-head">
            <view class="avatar">
              <text class="avatar-text">{{ nameInitial }}</text>
            </view>
            <view class="hero-user">
              <text class="hero-name">{{ displayName }}</text>
								<text class="hero-meta">{{ reportType }} · 报告日 {{ displayReportDate }}</text>
								<text v-if="uploadDate" class="hero-meta">上传 {{ uploadDate }}</text>
            </view>
            <view class="risk-badge" :style="{ background: riskMeta.bgColor }">
              <text class="risk-badge-text" :style="{ color: riskMeta.textColor }">{{ riskMeta.riskLabel }}</text>
            </view>
          </view>

          <view class="hero-main">
            <view class="score-ring" :style="{ borderColor: scoreColor }">
              <text class="score-num" :style="{ color: scoreColor }">{{ totalScoreText }}</text>
              <text v-if="hasTrustedScore" class="score-unit">分</text>
            </view>
            <view class="score-copy">
              <text class="score-kicker">{{ SCORE_COPY.reportTotal.label }}</text>
              <text class="score-title">{{ riskMeta.creditLabel }}</text>
              <text class="score-sub">{{ scoreHeadline }}</text>
              <view class="mini-tags">
                <view v-for="item in basicBadges" :key="item" class="mini-tag">
                  <text class="mini-tag-text">{{ item }}</text>
                </view>
              </view>
            </view>
          </view>

          <view v-if="scoreBasis" class="hero-score-basis">
            <view class="hero-score-basis-toggle" @click="scoreBasisExpanded = !scoreBasisExpanded">
              <view class="hero-score-basis-title-wrap">
                <text class="hero-score-basis-title">{{ scoreBasisQuestion }}</text>
                <text class="hero-score-basis-tag">{{ scoreBasis.tag }}</text>
              </view>
              <view class="hero-score-basis-action">
                <text class="hero-score-basis-action-text">{{ scoreBasisExpanded ? '收起' : '查看依据' }}</text>
                <RptChevron
                  class="report-inline-chevron"
                  :class="{ 'report-inline-chevron-open': scoreBasisExpanded }"
                  direction="down"
                  aria-hidden="true"
                />
              </view>
            </view>
            <view v-if="scoreBasisExpanded || exportMode" class="hero-score-basis-panel">
              <text class="hero-score-basis-desc">{{ scoreBasis.desc }}</text>
              <text v-if="scoreBasis.formulaWarning" class="hero-score-basis-warning">{{ scoreBasis.formulaWarning }}</text>
              <view class="hero-score-basis-grid">
                <view v-for="item in scoreBasis.rows" :key="`hero_${item.key}`" class="hero-score-basis-cell">
                  <text class="hero-score-basis-value">{{ item.value }}</text>
                  <text class="hero-score-basis-label">{{ item.label }}</text>
                </view>
              </view>
              <view v-if="scoreBasis.dimensions.length" class="hero-score-dimensions">
                <text class="hero-score-dimensions-title">{{ scoreBasis.dimensionTitle }}</text>
                <view v-for="item in scoreBasis.dimensions" :key="`hero_dim_${item.key}`" class="hero-score-dimension">
                  <text class="hero-score-dimension-label">{{ item.label }}</text>
                  <text class="hero-score-dimension-value">{{ item.value }}</text>
                </view>
              </view>
              <view v-if="scoreBasis.rules.length" class="hero-score-rules">
                <text class="hero-score-rules-title">本次命中依据</text>
                <view v-for="item in scoreBasis.rules" :key="`hero_rule_${item.key}`" class="hero-score-rule">
                  <text class="hero-score-rule-label">{{ item.label }}</text>
                  <text class="hero-score-rule-value">{{ item.value }}</text>
                </view>
                <text v-if="scoreBasis.ruleNote" class="hero-score-rule-note">{{ scoreBasis.ruleNote }}</text>
              </view>
            </view>
          </view>

          <view class="hero-stats">
            <view class="hero-stat">
								<text class="hero-stat-value">{{ trustedAccountCount == null ? '—' : trustedAccountCount }}</text>
              <text class="hero-stat-label">信贷账户</text>
            </view>
            <view class="hero-stat">
              <text class="hero-stat-value" :class="{ danger: overdueCount != null && overdueCount > 0 }">{{ overdueCount == null ? '—' : overdueCount }}</text>
              <text class="hero-stat-label">逾期账户</text>
            </view>
            <view class="hero-stat">
              <text class="hero-stat-value" :class="{ warn: query6mCount != null && query6mCount > 8 }">{{ query6mCount == null ? '—' : query6mCount }}</text>
              <text class="hero-stat-label">近6月查询</text>
            </view>
          </view>
        </view>

        <view class="anchor-scroll" data-report-export-exclude>
          <view class="anchor-row">
            <view
              v-for="item in navSections"
              :key="item.id"
              class="anchor-chip"
              :class="{ 'anchor-chip-active': activeAnchor === item.id }"
              hover-class="anchor-chip-press"
              @tap.stop="scrollTo(item.id)"
              @click.stop="scrollTo(item.id)"
            >
              <text class="anchor-chip-text" :class="{ 'anchor-chip-text-active': activeAnchor === item.id }">{{ item.label }}</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile') && sourceNotice" class="source-notice" :class="sourceNotice.className">
          <view class="source-notice-main">
            <text class="source-notice-title">{{ sourceNotice.title }}</text>
            <text class="source-notice-sub">{{ sourceNotice.subtitle }}</text>
          </view>
          <text class="source-notice-tag">{{ sourceNotice.tag }}</text>
        </view>

        <view v-if="sectionVisible('sec-profile') && messageDetailNotice" class="message-detail-card" data-report-export-exclude>
          <view class="message-detail-head">
            <view class="message-detail-main">
              <text class="message-detail-title">{{ messageDetailNotice.title }}</text>
              <text class="message-detail-sub">{{ messageDetailNotice.subtitle }}</text>
            </view>
            <text class="message-detail-tag">{{ messageDetailNotice.tag }}</text>
          </view>
          <view class="message-detail-actions">
            <view class="message-detail-primary" @click="goMessageCenter">
              <text class="message-detail-primary-text">返回消息</text>
            </view>
            <view class="message-detail-ghost" :class="{ done: messageHandled }" @click="markMessageHandled">
              <text class="message-detail-ghost-text" :class="{ done: messageHandled }">{{ messageHandled ? '已完成' : '标记完成' }}</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile') && manageContextNotice" class="manage-context-card" data-report-export-exclude>
          <view class="manage-context-head">
            <view class="manage-context-main">
              <text class="manage-context-title">{{ manageContextNotice.title }}</text>
              <text class="manage-context-sub">{{ manageContextNotice.subtitle }}</text>
            </view>
            <text class="manage-context-tag">{{ manageContextNotice.tag }}</text>
          </view>
          <view class="manage-context-actions">
            <view class="manage-context-btn" :class="{ disabled: !manageContextNotice.prevId }" @click="openContextReport('prev')">
              <text class="manage-context-btn-text" :class="{ disabled: !manageContextNotice.prevId }">上一份</text>
            </view>
            <view class="manage-context-btn" :class="{ disabled: !manageContextNotice.nextId }" @click="openContextReport('next')">
              <text class="manage-context-btn-text" :class="{ disabled: !manageContextNotice.nextId }">下一份</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile') && dataCompleteness" class="completeness-card">
          <view class="notice-card completeness-head" @click="completenessExpanded = !completenessExpanded">
            <view class="notice-main">
              <text class="notice-title">数据完整度 {{ dataCompleteness.grade }}</text>
              <text class="notice-sub">{{ dataCompleteness.summary }}</text>
              <text v-if="dataCompleteness.coverageText" class="notice-hint">{{ dataCompleteness.coverageText }}</text>
            </view>
            <view class="notice-side">
              <text class="notice-score" :style="{ color: dataCompleteness.color }">{{ dataCompleteness.scoreText }}</text>
              <text class="notice-toggle">{{ completenessExpanded ? '收起' : '明细' }}</text>
            </view>
          </view>
          <view v-if="completenessExpanded || exportMode" class="completeness-panel">
            <view v-if="dataCompleteness.rows.length" class="completeness-list">
              <view v-for="row in dataCompleteness.rows" :key="row.key" class="completeness-row">
                <text class="completeness-mark" :class="{ ok: row.present, miss: !row.present }">{{ row.present ? '✓' : '!' }}</text>
                <view class="completeness-row-main">
                  <view class="completeness-row-title-wrap">
                    <text class="completeness-row-title">{{ row.label }}</text>
                    <text v-if="row.critical" class="completeness-row-tag">关键</text>
                  </view>
                  <text class="completeness-row-detail">{{ row.detail }}</text>
                </view>
              </view>
            </view>
            <view v-if="dataCompleteness.notes.length" class="completeness-notes">
              <text class="completeness-notes-title">完整性提示</text>
              <text v-for="note in dataCompleteness.notes" :key="note" class="completeness-note">· {{ note }}</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile') && reportInterpretation" class="interpretation-card">
          <view class="interpretation-head">
            <view class="interpretation-title-wrap">
              <text class="interpretation-kicker">历史解析存档</text>
              <text class="interpretation-title">{{ reportInterpretation.title }}</text>
            </view>
            <text class="interpretation-tag">仅供核对</text>
          </view>
          <text class="interpretation-headline">{{ reportInterpretation.headline }}</text>
          <view class="interpretation-grid">
            <view v-for="item in interpretationMetrics" :key="item.key" class="interpretation-cell">
              <text class="interpretation-value" :class="{ warn: item.warn }">{{ item.value }}</text>
              <text class="interpretation-label">{{ item.label }}</text>
              <text v-if="item.sub" class="interpretation-sub">{{ item.sub }}</text>
            </view>
          </view>
          <view v-if="interpretationPoints.length" class="interpretation-points">
            <view v-for="item in interpretationPoints" :key="item.key" class="interpretation-point">
              <view class="interpretation-dot" :class="item.levelClass"></view>
              <view class="interpretation-point-main">
                <text class="interpretation-point-title">{{ item.title }}</text>
                <text class="interpretation-point-detail">{{ item.detail }}</text>
              </view>
            </view>
          </view>
          <view v-if="interpretationActions.length" class="interpretation-actions">
            <text v-for="item in interpretationActions" :key="item" class="interpretation-action">· {{ item }}</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-risk')" id="sec-risk" class="section-card">
          <view class="section-head">
            <view>
              <text class="section-title">风险摘要</text>
              <text class="section-sub">历史规则线索，仅供核对；主决策以服务端已验证字段为准</text>
            </view>
							<text class="section-count">{{ riskSummary.total == null ? '待核对' : `${riskSummary.total} 项` }}</text>
          </view>
          <view class="risk-select-wrap" data-report-export-exclude>
            <view class="risk-select" @click="riskDropdownOpen = !riskDropdownOpen">
              <view class="risk-select-main">
                <view class="risk-select-dot" :class="`risk-select-dot-${selectedRiskBucket.key}`"></view>
                <view>
                  <text class="risk-select-label">{{ selectedRiskBucket.label }}</text>
									<text class="risk-select-hint">当前分类 {{ selectedRiskBucket.count == null ? '待核对' : `${selectedRiskBucket.count} 项` }}</text>
                </view>
              </view>
              <view class="risk-select-action">
                <text class="risk-select-action-text">切换</text>
                <RptChevron
                  class="report-inline-chevron"
                  :class="{ 'report-inline-chevron-open': riskDropdownOpen }"
                  direction="down"
                  aria-hidden="true"
                />
              </view>
            </view>
            <view v-if="riskDropdownOpen" class="risk-select-menu">
              <view
                v-for="item in riskBucketOptions"
                :key="item.key"
                class="risk-select-option"
                :class="{ active: selectedRiskBucket.key === item.key }"
                @click.stop="selectRiskBucket(item.key)"
              >
                <view class="risk-select-dot" :class="`risk-select-dot-${item.key}`"></view>
                <text class="risk-select-option-label">{{ item.label }}</text>
								<text class="risk-select-option-count">{{ item.count == null ? '待核对' : `${item.count} 项` }}</text>
                <text v-if="selectedRiskBucket.key === item.key" class="risk-select-check">✓</text>
              </view>
            </view>
          </view>
          <view class="risk-filter-panel">
            <view class="risk-filter-head">
              <text class="risk-filter-title">{{ activeRiskTitle }}</text>
              <text class="risk-filter-count">{{ filteredRiskHits.length }} 条明细</text>
            </view>
            <view v-if="filteredRiskHits.length">
              <view v-for="hit in shownRiskBucketHits" :key="hit.key" class="risk-filter-row hit-card" :class="hitCardClass(hit.bucket)">
                <view class="hit-head">
                  <text class="hit-level">{{ hit.level }}</text>
                  <text class="hit-title">{{ hit.title }}</text>
                </view>
                <text class="hit-detail">{{ hit.detail }}</text>
                <text v-if="hit.ruleName" class="hit-rule">规则编号 · {{ hit.ruleName }}</text>
              </view>
              <view v-if="riskBucketRemaining > 0" class="more-btn risk-more-btn" @click="riskHitLimit += 8">
                <text class="more-btn-text">查看更多（剩余 {{ riskBucketRemaining }}）</text>
              </view>
            </view>
            <view v-else class="soft-empty">
              <text class="soft-empty-text">{{ riskEmptyText }}</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile')" class="snapshot-card">
          <view class="section-head compact">
            <view>
              <text class="section-title">信用画像综览</text>
              <text class="section-sub">来自信用账户、负债与查询记录</text>
            </view>
          </view>
          <view class="profile-grid">
            <view v-for="item in profileOverviewCells" :key="item.key" class="profile-cell">
              <text class="profile-value" :class="{ warn: item.warn }">{{ item.value }}</text>
              <text class="profile-label">{{ item.label }}</text>
              <text v-if="item.sub" class="profile-sub">{{ item.sub }}</text>
            </view>
          </view>
          <view v-if="profileOverviewNotice" class="profile-notice">
            <text class="profile-notice-text">{{ profileOverviewNotice }}</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile')" class="conversion-card" data-report-export-exclude>
          <view class="conversion-copy">
            <text class="conversion-kicker">下一步建议</text>
            <text class="conversion-title">{{ conversionTitle }}</text>
            <text class="conversion-sub">{{ conversionSubtitle }}</text>
          </view>
          <view class="conversion-btn" @click="runPrimaryAction">
            <text class="conversion-btn-text">{{ conversionButtonText }}</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile')" class="quick-actions-card" data-report-export-exclude>
          <view class="quick-action" @click="runPrimaryAction">
            <text class="quick-icon">配</text>
            <text class="quick-title">智能匹配</text>
            <text class="quick-sub">确认材料后看产品</text>
          </view>
          <view class="quick-action" @click="goAdvisor">
            <text class="quick-icon blue">顾</text>
            <text class="quick-title">咨询顾问</text>
            <text class="quick-sub">确认修复路径</text>
          </view>
          <view class="quick-action" @click="goDebtManage">
            <text class="quick-icon green">债</text>
            <text class="quick-title">债务管理</text>
            <text class="quick-sub">拆解还款压力</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-score')" id="sec-score" class="section-card">
          <view class="section-head">
            <view>
              <text class="section-title">四维评分</text>
              <text class="section-sub">分数越高，当前维度越稳健</text>
            </view>
          </view>
          <view v-if="scoreBasis" class="score-basis-panel">
            <view class="score-basis-head">
              <view class="score-basis-main">
                <text class="score-basis-title">{{ scoreBasis.title }}</text>
                <text class="score-basis-desc">{{ scoreBasis.desc }}</text>
              </view>
              <text class="score-basis-tag">{{ scoreBasis.tag }}</text>
            </view>
            <view class="score-basis-grid">
              <view v-for="item in scoreBasis.rows" :key="item.key" class="score-basis-cell">
                <text class="score-basis-value">{{ item.value }}</text>
                <text class="score-basis-label">{{ item.label }}</text>
              </view>
            </view>
          </view>
          <view v-for="d in dims" :key="d.key" class="dim-row">
            <view class="dim-name-wrap">
              <text class="dim-name">{{ d.zh }}</text>
              <text class="dim-hint">{{ d.hint }}</text>
            </view>
            <view class="dim-bar-bg">
              <view class="dim-bar" :style="{ width: barWidth(d.value), background: getScoreColor(d.value) }"></view>
            </view>
            <text class="dim-val">{{ d.value == null ? '—' : d.value }}</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-debt')" id="sec-debt" class="section-card">
          <view class="section-head">
            <view>
              <text class="section-title">负债结构</text>
              <text class="section-sub">{{ debtStructureHint }}</text>
            </view>
          </view>
					<view v-if="debtSegments.length" class="debt-list">
            <view
              v-for="item in debtSegments"
              :key="item.key"
              class="debt-row-card"
              :class="{ review: item.review, active: activeDebtSegment && activeDebtSegment.key === item.key }"
              @click="selectDebtSegment(item.key)"
            >
              <view class="debt-row-top">
                <view class="debt-cell-head">
                  <view class="debt-color" :style="{ background: item.color }"></view>
                  <text class="debt-name">{{ item.name }}</text>
                </view>
                <text class="debt-share">{{ item.percentText }}</text>
              </view>
              <view class="debt-bar-bg">
								<view class="debt-bar" :style="{ width: (item.percent == null ? 0 : item.percent) + '%', background: item.color }"></view>
              </view>
              <view class="debt-row-bottom">
								<text class="debt-amount">{{ moneyOrZeroText(item.amount, item.amountKnown) }}</text>
                <text class="debt-count">{{ debtCountText(item) }}</text>
              </view>
              <text v-if="item.note" class="debt-note">{{ item.note }}</text>
            </view>
          </view>
					<view v-else class="soft-empty">
						<text class="soft-empty-text">债务结构待核对；缺失余额不会按 0 元处理。</text>
					</view>
          <view v-if="debtSegmentSummary" class="debt-insight-card">
            <view class="debt-insight-main">
              <text class="debt-insight-title">{{ debtSegmentSummary.title }}</text>
              <text class="debt-insight-desc">{{ debtSegmentSummary.desc }}</text>
            </view>
            <view class="debt-insight-btn" @click="activeDebtSegment && activeDebtSegment.key === 'card' ? scrollTo('sec-accounts') : goDebtManage()">
              <text class="debt-insight-btn-text">{{ debtSegmentSummary.action }}</text>
            </view>
          </view>
          <view v-if="debtStructureNotice" class="debt-calibration">
            <view class="debt-calibration-main">
              <text class="debt-calibration-title">{{ debtStructureNotice.title }}</text>
              <text class="debt-calibration-desc">{{ debtStructureNotice.desc }}</text>
            </view>
            <text class="debt-calibration-tag">{{ debtStructureNotice.tag }}</text>
          </view>
          <view v-if="overdueRows.length" class="sub-panel">
            <view class="sub-head">
              <text class="sub-title">逾期与异常记录</text>
              <text class="sub-count">{{ overdueRows.length }} 条</text>
            </view>
            <view v-for="row in overdueRows" :key="row.key" class="overdue-row">
              <view class="overdue-main">
                <text class="overdue-bank">{{ row.institution }}</text>
                <text class="overdue-desc">{{ row.desc }}</text>
              </view>
              <text class="overdue-days">{{ row.daysText }}</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-query')" id="sec-query" class="section-card">
          <view class="section-head">
            <view>
              <text class="section-title">查询记录</text>
              <text class="section-sub">重点关注审批类硬查询密度</text>
            </view>
          </view>
          <view class="query-matrix">
            <view
              v-for="row in queryMatrix"
              :key="row.key"
              class="query-cell"
              :class="{ active: activeQueryWindow === row.key }"
              @click="setQueryWindow(row.key)"
            >
              <text class="query-value" :class="{ warn: row.known && row.total > row.warnAt }">{{ row.known ? row.total : '—' }}</text>
              <text class="query-label">{{ row.label }}</text>
              <text class="query-sub">{{ queryBreakdownText(row) }}</text>
            </view>
          </view>
          <view v-if="queryDetailNotice" class="query-notice">
            <text class="query-notice-text">{{ queryDetailNotice }}</text>
          </view>
          <scroll-view v-if="queryTrendRows.length" class="query-trend-scroll" scroll-x>
            <view class="query-trend-row">
              <view v-for="item in queryTrendRows" :key="item.key" class="query-trend-cell">
                <view class="query-trend-bars">
                  <view class="query-trend-bar bank" :style="{ height: item.bankHeight }"></view>
                  <view class="query-trend-bar nonbank" :style="{ height: item.nonBankHeight }"></view>
                </view>
                <text class="query-trend-total">{{ item.total }}</text>
                <text class="query-trend-month">{{ item.label }}</text>
              </view>
            </view>
          </scroll-view>
          <view v-if="queryInstitutionHighlights.length" class="query-highlight-panel">
            <view v-for="item in queryInstitutionHighlights" :key="item.key" class="query-highlight-row">
              <view class="query-highlight-main">
                <text class="query-highlight-org">{{ item.org }}</text>
                <text class="query-highlight-sub">{{ item.kindText }} · {{ item.reasonsText }}</text>
              </view>
              <text class="query-highlight-count">{{ item.count }} 次</text>
            </view>
          </view>
          <view v-if="queryFilterOptions.length > 1" class="filter-row query-filter-row" data-report-export-exclude>
            <view
              v-for="item in queryFilterOptions"
              :key="item.key"
              class="filter-chip"
              :class="{ active: queryKindFilter === item.key }"
              @click="setQueryKindFilter(item.key)"
            >
              <text class="filter-chip-text" :class="{ active: queryKindFilter === item.key }">{{ item.label }} {{ item.count }}</text>
            </view>
          </view>
          <view v-if="queryRows.length" class="query-list">
            <view class="sub-head">
              <text class="sub-title">{{ selectedQueryWindowLabel }}审批查询机构</text>
              <text class="sub-count">{{ queryRows.length }}/{{ queryRowsTotal }} 条</text>
            </view>
            <view v-for="row in queryRows" :key="row.key" class="query-row">
              <text class="query-date">{{ row.date }}</text>
              <view class="query-main">
                <view class="query-title-row">
                  <text class="query-org">{{ row.org }}</text>
                  <text class="query-kind" :class="{ nonbank: row.kind === 'nonBank' }">{{ row.kindText }}</text>
                </view>
                <text class="query-reason">{{ row.reason }}</text>
              </view>
            </view>
            <view v-if="queryRowsTotal > queryRowLimit" class="more-btn query-more-btn" @click="queryRowLimit += queryPageStep">
              <text class="more-btn-text">{{ queryMoreText }}</text>
            </view>
          </view>
          <view v-else class="soft-empty query-empty">
            <text class="soft-empty-text">{{ queryEmptyText }}</text>
          </view>
          <view v-if="selfQueryRowsTotal" class="self-query">
            <text class="self-query-text">{{ selectedQueryWindowLabel }}本人查询 {{ selfQueryRowsTotal }} 次，通常不计入审批类硬查询压力。</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-accounts')" id="sec-accounts" class="report-tab-stack">
          <view v-if="publicRecordRows.length || guaranteeRows.length" id="sec-extra" class="section-card">
            <view class="section-head">
              <view>
                <text class="section-title">公共与担保记录</text>
                <text class="section-sub">法院、行政、担保等补充信息</text>
              </view>
            </view>
            <view v-for="row in publicRecordRows" :key="row.key" class="plain-row">
              <view class="plain-main">
                <text class="plain-title">{{ row.title }}</text>
                <text class="plain-sub">{{ row.desc }}</text>
              </view>
              <text class="plain-tag">{{ row.status }}</text>
            </view>
            <view v-for="row in guaranteeRows" :key="row.key" class="plain-row">
              <view class="plain-main">
                <text class="plain-title">{{ row.title }}</text>
                <text class="plain-sub">{{ row.desc }}</text>
              </view>
              <text class="plain-tag">{{ row.amount }}</text>
            </view>
          </view>

          <view class="section-card">
            <view class="section-head">
              <view>
                <text class="section-title">账户明细</text>
								<text class="section-sub">活跃 {{ accountSummary.activeKnown ? accountSummary.active : '待核对' }} · 结清 {{ accountSummary.activeKnown ? accountSummary.settled : '待核对' }} · 异常 {{ accountSummary.abnormalKnown ? accountSummary.abnormal : '待核对' }}</text>
              </view>
              <text class="section-count">{{ filteredAccounts.length }}/{{ accounts.length }}</text>
            </view>
            <view v-if="accounts.length" class="account-summary-grid">
              <view class="account-summary-cell">
                <text class="account-summary-value">{{ accountPrimaryBalanceText }}</text>
                <text class="account-summary-label">活跃余额</text>
              </view>
              <view class="account-summary-cell">
                <text class="account-summary-value">{{ accountUsageMetricText }}</text>
                <text class="account-summary-label">{{ accountUsageMetricLabel }}</text>
              </view>
              <view class="account-summary-cell">
                <text class="account-summary-value">{{ accountLimitValueText }}</text>
                <text class="account-summary-label">活跃授信</text>
              </view>
            </view>
            <view v-if="accountVolumeNotice" class="account-notice">
              <text class="account-notice-text">{{ accountVolumeNotice }}</text>
            </view>
            <view class="filter-row account-filter-row" data-report-export-exclude>
              <view
                v-for="item in accountFilterOptions"
                :key="item.key"
                class="filter-chip"
                :class="{ active: accountFilter === item.key }"
                @click="setAccountFilter(item.key)"
              >
                <text class="filter-chip-text" :class="{ active: accountFilter === item.key }">{{ item.label }} {{ item.count }}</text>
              </view>
            </view>
            <view v-if="shownAccounts.length">
              <view v-for="a in shownAccounts" :key="a.key" class="account-row" :class="{ bad: a.abnormal, attention: !a.abnormal && (a.highUsage || a.largeBalance) }">
                <view class="account-main">
                  <view class="account-title-row">
                    <text class="account-name">{{ a.institution }}</text>
                    <text class="account-tag" :class="{ loan: a.isLoan, card: !a.isLoan }">{{ a.categoryText }}</text>
                    <text class="account-kind">{{ a.institutionKindText }}</text>
                    <text v-if="a.highUsage" class="account-alert">高使用率</text>
                    <text v-else-if="a.largeBalance" class="account-alert muted">大额余额</text>
                  </view>
                  <text class="account-type">{{ a.product }} · {{ a.openDate }}</text>
                  <text class="account-meta">{{ a.detailText }}</text>
                </view>
                <view class="account-right">
										<text class="account-amount">{{ moneyOrZeroText(a.balance, a.balanceKnown) }}</text>
                  <text class="account-status" :class="{ bad: a.abnormal, settled: a.settled }">{{ a.statusText }}</text>
                </view>
              </view>
              <view v-if="filteredAccounts.length > accountLimit" class="more-btn" @click="accountLimit += accountPageStep">
                <text class="more-btn-text">{{ accountMoreText }}</text>
              </view>
            </view>
            <view v-else class="soft-empty">
              <text class="soft-empty-text">{{ accountEmptyText }}</text>
            </view>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile')" id="sec-plan" class="section-card">
          <view class="section-head">
            <view>
              <text class="section-title">优化行动清单</text>
              <text class="section-sub">仅展示当前报告由服务端逐字段验证的行动项</text>
            </view>
          </view>
          <view v-if="improvementPlan.length">
            <view v-for="(item, index) in improvementPlan" :key="item.key" class="plan-row">
              <view class="plan-index" :class="planClass(item.priority)">
                <text class="plan-index-text">{{ index + 1 }}</text>
              </view>
              <view class="plan-main">
                <text class="plan-title">{{ item.title }}</text>
                <text class="plan-desc">{{ item.desc }}</text>
                <text v-if="item.effect" class="plan-effect">{{ item.effect }}</text>
              </view>
            </view>
          </view>
          <view v-else class="soft-empty">
            <text class="soft-empty-text">暂无已验证行动项，可重新分析或咨询顾问核对。</text>
          </view>
        </view>

        <view v-if="sectionVisible('sec-profile') && aiSuggestion" class="section-card">
          <view class="section-head compact">
            <view>
              <text class="section-title">智能分析建议</text>
            </view>
          </view>
          <text class="ai-sug">{{ aiSuggestion }}</text>
        </view>

        <view v-if="sectionVisible('sec-profile')" class="disclaimer">
          <text class="disclaimer-text">分析结果基于上传报告生成，仅供参考；实际授信与审批以金融机构结果为准。请勿在公共设备长期保留信用报告。</text>
        </view>
        <view class="bottom-safe"></view>
      </view>
    </scroll-view>

    <view v-if="hasReport && !missingDetail" class="footer">
      <view class="footer-actions rpt-content-narrow">
        <view
          class="footer-export"
          :class="{ 'footer-export-disabled': exporting }"
          role="button"
          tabindex="0"
          :aria-disabled="exporting"
          @click="chooseReportExport"
          @keydown.enter.prevent="chooseReportExport"
          @keydown.space.prevent="chooseReportExport"
        >
          <text class="footer-export-text">{{ exporting ? '生成中…' : '下载报告' }}</text>
        </view>
        <view
          class="footer-primary"
          role="button"
          tabindex="0"
          :aria-label="conversionButtonText"
          @click="runPrimaryAction"
          @keydown.enter.prevent="runPrimaryAction"
          @keydown.space.prevent="runPrimaryAction"
        >
          <text class="footer-primary-text">{{ conversionButtonText }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, nextTick, getCurrentInstance } from 'vue'
import { onLoad, onShow, onUnload } from '@/compat/web-lifecycle.js'
import { getReportAnalysisDate, getReportAsync, getLatestReportAsync, getReportDateDisplayMeta, getReportUploadDate, hasMeaningfulAnalysisData, normalizeReportData, REPORT_SYNC_UPDATED_EVENT } from '@/services/reportStorage.js'
import { saveMessageActionReceiptRemote } from '@/services/profileService.js'
import { readMessageCenterViewState, saveMessageActionReceipt, saveMessageCenterViewState, syncMessageActionReceipt } from '@/services/messageCenter.js'
import { getRiskMeta, getScoreColor, normalizeRiskLevel } from '@/config/riskLevel.js'
import {
  ACTION_KEYS,
  ACTION_THRESHOLDS,
  resolveActionKey,
  resolveHighRiskMetric,
  resolveOverdueAccountMetric,
  resolveQuery6mMetric
} from '@/services/actionPolicy.js'
import { saveMatchReportContext } from '@/services/reportMatchContext.js'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import safeBack from '@/utils/safeBack.js'
import { SCORE_COPY } from '@/utils/scorePresentation.js'
import { resolveV6ScoreDetails } from '@/services/scoreV6.js'
import { resolveDecisionAccountCount, resolveDecisionTotalDebt, resolveEvidenceBackedDebtRatio } from '@/services/decisionMetrics.js'
import { decisionReportIdOf, trustedDecisionValue } from '@/services/decisionTrust.js'
import { REPORT_EXPORT_FORMATS, exportReportElement } from '@/services/reportExport.js'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'
import {
  num as aggNum,
  groupThousands,
	buildGuaranteeRowsForDetail,
  buildDebtStructureSegments,
  aggregateQueryItemsByMonth,
  classifyQueryItemBank,
  filterAccountsForDetail,
  filterBankQueries12m,
  filterQueryInstitutionDetailsLive,
  filterSelfQueriesInLiveWindow,
  fmtQueryRowDate,
  normalizeAccountForDetail,
  normalizeRiskHitsForDetail,
  summarizeAccountsForDetail,
  summarizeQueriesByWindows,
  summarizeRiskHitsByBucket
} from '@/utils/reportDetailAggregates.js'
import { strictFiniteNumberOrNull, strictNonNegativeNumberOrNull } from '@/utils/strictNumber.js'

const DETAIL_CONTEXT_KEY = 'report_manage_detail_context'
const DETAIL_CONTEXT_TTL_MS = 30 * 60 * 1000
const pageInstance = getCurrentInstance()

const hasReport = ref(false)
const missingDetail = ref(false)
const missingReport = ref(null)
const requestedReportMissing = ref(false)
const currentReport = ref(null)
const reportType = ref('信用报告')
const uploadDate = ref('')
const raw = ref(null)
const norm = ref(null)
const reportDecisionTrust = computed(() => currentReport.value?.decisionTrust || null)
const decisionReportId = computed(() => decisionReportIdOf(currentReport.value))
const activeAnchor = ref('sec-profile')
const scrollAnchor = ref('sec-profile')
const mainScrollTop = ref(0)
const currentScrollTop = ref(0)
const lastAnchorTap = ref({ id: '', at: 0 })
const accountLimit = ref(8)
const lastQuery = ref({})
const currentReportId = ref('')
const reportManageContext = ref(null)
const messageRouteContext = ref(null)
const messageHandled = ref(false)
const messageLandedRecorded = ref(false)
const completenessExpanded = ref(false)
const scoreBasisExpanded = ref(false)
const activeRiskBucket = ref('')
const riskDropdownOpen = ref(false)
const riskHitLimit = ref(8)
const activeDebtKey = ref('')
const activeQueryWindow = ref('6m')
const queryRowLimit = ref(8)
const queryKindFilter = ref('all')
const accountFilter = ref('all')
const reportExportRoot = ref(null)
const exportMode = ref(false)
const exporting = ref(false)
const REPORT_SECTION_ALIASES = Object.freeze({
  'sec-profile': 'sec-profile',
  profile: 'sec-profile',
  overview: 'sec-profile',
  summary: 'sec-profile',
  'sec-risk': 'sec-risk',
  risk: 'sec-risk',
  overdue: 'sec-risk',
  'sec-score': 'sec-score',
  score: 'sec-score',
  rating: 'sec-score',
  'sec-debt': 'sec-debt',
  debt: 'sec-debt',
  liability: 'sec-debt',
  'sec-query': 'sec-query',
  query: 'sec-query',
  inquiries: 'sec-query',
  'sec-accounts': 'sec-accounts',
  accounts: 'sec-accounts',
  account: 'sec-accounts'
})
const ACCOUNT_FILTER_KEYS = new Set(['all', 'active', 'loan', 'card', 'abnormal', 'highUsage', 'largeBalance', 'nonbank', 'settled'])
const QUERY_WINDOW_KEYS = new Set(['1m', '3m', '6m', '12m'])

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v)
const obj = (v) => (isPlainObject(v) ? v : {})
const firstObj = (...values) => values.map(obj).find((item) => Object.keys(item).length > 0) || {}
const mergeCompatObjects = (fallbackValue, preferredValue) => {
  const fallback = obj(fallbackValue)
  const preferred = obj(preferredValue)
  const merged = { ...fallback }
  Object.entries(preferred).forEach(([key, value]) => {
    const previous = merged[key]
    if (isPlainObject(value) && isPlainObject(previous)) {
      merged[key] = mergeCompatObjects(previous, value)
      return
    }
    if (Array.isArray(value) && value.length === 0 && Array.isArray(previous) && previous.length > 0) return
    if (isPlainObject(value) && Object.keys(value).length === 0 && isPlainObject(previous) && Object.keys(previous).length > 0) return
    if ((value === '' || value == null) && previous !== '' && previous != null) return
    merged[key] = value
  })
  return merged
}
const arr = (v) => (Array.isArray(v) ? v : [])
const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '')
const queryText = (value) => String((Array.isArray(value) ? value[0] : value) || '')
const parseStoredState = (value) => {
  if (!value) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (e) { return null }
  }
  return value && typeof value === 'object' ? value : null
}
const isMessageRoute = computed(() => !!lastQuery.value && lastQuery.value.from === 'message')
const routeMessageId = computed(() => queryText(lastQuery.value && lastQuery.value.messageId))
const routeFocus = computed(() => queryText(lastQuery.value && lastQuery.value.focus))
const routeReportId = computed(() => queryText(lastQuery.value && first(lastQuery.value.reportId, lastQuery.value.id)))
const normalizeContextItems = (items) => arr(items)
  .filter((item) => item && item.id)
  .map((item) => ({
    id: String(item.id),
    title: first(item.title, '历史信用报告'),
    dateText: first(item.dateText, ''),
    sourceText: first(item.sourceText, ''),
    scoreText: first(item.scoreText, '--'),
    syncText: first(item.syncText, ''),
    assetSource: first(item.assetSource, 'local')
  }))
const readReportManageContext = () => {
  try {
    const rawContext = uni.getStorageSync(DETAIL_CONTEXT_KEY)
    const context = parseStoredState(rawContext)
    if (!context || !context.savedAt || Date.now() - context.savedAt > DETAIL_CONTEXT_TTL_MS) return null
    return { ...context, items: normalizeContextItems(context.items) }
  } catch (e) { return null }
}
const refreshReportManageContext = () => {
  reportManageContext.value = readReportManageContext()
}
const numberOrNull = (v) => {
	return strictFiniteNumberOrNull(v)
}
const handleMainScroll = (event) => {
  const top = numberOrNull(event && event.detail && event.detail.scrollTop)
  if (top != null) currentScrollTop.value = top
}
const completenessBool = (value, fallback = false) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  const s = String(value == null ? '' : value).trim().toLowerCase()
  if (!s) return fallback
  if (/^(true|yes|y|1|ok|pass|present|covered)$/i.test(s) || /已识别|已覆盖|完整|存在|通过/.test(s)) return true
  if (/^(false|no|n|0|missing|miss|none|fail)$/i.test(s) || /未识别|缺失|缺少|无数据|失败|不完整/.test(s)) return false
  return fallback
}
const toPct = (v) => {
  const n = numberOrNull(v)
  if (n == null) return 0
  if (n > 0 && n <= 1) return Math.round(n * 100)
  return Math.max(0, Math.round(n))
}
const limitPct = (v) => Math.max(0, Math.min(100, Math.round(aggNum(v, 0))))
const textOrDash = (v) => first(v, '—')
const cleanDisplayName = (value) => {
  let s = String(value || '').replace(/\s+/g, '').trim()
  if (!s) return ''
  s = s.replace(/^姓名[:：]?/, '')
  s = s.split(/证件类型|证件号码|身份证|证件|出生|婚姻|手机|电话|报告/)[0]
  s = s.replace(/[0-9Xx]{4,}/g, '')
  const match = s.match(/[\u4e00-\u9fa5·]{2,8}/)
  return match ? match[0].slice(0, 4) : ''
}

const cv2 = computed(() => {
  const ad = obj(raw.value)
  return mergeCompatObjects(
    mergeCompatObjects(
      mergeCompatObjects(ad.cv2, ad.credit_report_v2),
      ad.credit_report_full
    ),
    ad.creditReportV2
  )
})
const frontendPayload = computed(() => {
	const ad = obj(raw.value)
	return mergeCompatObjects(ad.frontend_payload, ad.frontendPayload)
})
const scoreResolution = computed(() => resolveV6ScoreDetails(raw.value, reportDecisionTrust.value, decisionReportId.value))
const basicInfo = computed(() => {
  const ad = obj(raw.value)
  const c = cv2.value
  const fp = frontendPayload.value
  return {
    ...obj(c.basic_info),
    ...obj(c.basicInfo),
    ...obj(ad.basic_info),
    ...obj(ad.basicInfo),
    ...obj(fp.basic_info),
    ...obj(fp.basicInfo)
  }
})
const dimensions = computed(() => {
  const ad = obj(raw.value)
  return firstObj(
    scoreResolution.value.dimensions,
    ad.dimensions,
    ad.dimensionSnapshot,
    ad.report?.dimensions,
    ad.report?.dimensionSnapshot,
    frontendPayload.value.dimensions,
    frontendPayload.value.dimensionSnapshot
  )
})
const algorithmReport = computed(() => firstObj(raw.value && raw.value.algorithmReport, norm.value && norm.value.algorithmReport))
const strictAlgorithm = computed(() => firstObj(raw.value && raw.value.strictAlgorithm, norm.value && norm.value.strictAlgorithm))
const creditDebt = computed(() => {
  const ad = obj(raw.value)
  const c = cv2.value
  const fp = frontendPayload.value
  const ar = algorithmReport.value
  const strict = strictAlgorithm.value
  return firstObj(
    c.credit_debt,
    c.creditDebt,
    ad.credit_debt,
    ad.creditDebt,
    fp.credit_debt,
    fp.creditDebt,
    fp.credit,
    ar.creditDebt,
    strict.creditDebt
  )
})

const resolvedTotalScore = computed(() => {
  const score = scoreResolution.value.score
  return typeof score === 'number' && Number.isFinite(score) ? Math.round(score) : null
})
const hasTrustedScore = computed(() => (
  resolvedTotalScore.value != null &&
  scoreResolution.value.auditable === true &&
  scoreResolution.value.decisionEligible === true
))
const archivalScore = computed(() => (!hasTrustedScore.value ? resolvedTotalScore.value : null))
const totalScore = computed(() => (hasTrustedScore.value ? resolvedTotalScore.value : null))
const totalScoreText = computed(() => hasTrustedScore.value ? String(totalScore.value) : '—')
const scoreBasisQuestion = computed(() => {
  if (hasTrustedScore.value) return `为什么是 ${totalScore.value} 分？`
  return archivalScore.value != null ? '为什么未采用历史评分？' : '为什么暂未评分？'
})
const trustedRiskLevel = computed(() => {
  const value = trustedDecisionValue(reportDecisionTrust.value, 'riskLevel', 'riskLevel', decisionReportId.value)
  return normalizeRiskLevel(typeof value === 'string' ? value : 'unknown')
})
const hasTrustedRiskLevel = computed(() => trustedRiskLevel.value !== 'unknown')
const riskMeta = computed(() => getRiskMeta(trustedRiskLevel.value))
const scoreColor = computed(() => getScoreColor(totalScore.value))
const aiSuggestion = computed(() => {
  const advice = trustedDecisionValue(reportDecisionTrust.value, 'advice', 'advice', decisionReportId.value)
  return typeof advice === 'string' ? advice.trim() : ''
})

const displayName = computed(() => {
  const bi = basicInfo.value
  const candidates = [bi.name, bi.customer_name, bi.customerName, bi.user_name, bi.clientName]
  for (const item of candidates) {
    const cleaned = cleanDisplayName(item)
    if (cleaned) return cleaned
  }
  return '报告用户'
})
const nameInitial = computed(() => String(displayName.value || '报').trim().slice(0, 1) || '报')
const displayReportDate = computed(() => {
	const date = getReportAnalysisDate(currentReport.value || { analysisData: raw.value })
	return date || '待核对'
})
const queryAnchorDate = computed(() => displayReportDate.value && displayReportDate.value !== '待核对' ? displayReportDate.value : null)
const sourceNotice = computed(() => {
  if (!hasReport.value || missingDetail.value) return null
  const r = currentReport.value || {}
  const meta = obj(r.syncMeta)
  const restored = meta.restoreSource === 'cloud' || meta.restoredAt || r.restoreSource === 'cloud'
  if (restored) {
    return {
      title: '云端已恢复',
      subtitle: '这份报告已从云端恢复到本机，可继续查看完整信用画像。',
      tag: '本机+云端',
      className: 'source-restored'
    }
  }
  const cloudId = first(r.cloudReportId, meta.cloudReportId, meta.remoteId, r.remoteId)
  const cloudSynced = cloudId || r.syncStatus === 'synced' || meta.status === 'synced'
  if (cloudSynced) {
    return {
      title: '云端已同步',
      subtitle: '报告摘要已同步，老师端/监控端可读取这份信用报告资产。',
      tag: '云端',
      className: 'source-cloud'
    }
  }
  const syncStatus = first(r.syncStatus, meta.status)
  if (syncStatus === 'syncing') {
    return {
      title: '正在同步到云端',
      subtitle: '报告已完成分析，正在写入旧版独立云端资产池。',
      tag: '同步中',
      className: 'source-syncing'
    }
  }
  if (syncStatus === 'failed') {
    return {
      title: '云端同步待重试',
      subtitle: '本机报告仍可查看；进入报告管理可重新同步。',
      tag: '待同步',
      className: 'source-failed'
    }
  }
  return {
    title: '本机报告',
    subtitle: '当前详情来自本机缓存。保持登录后可同步到云端资产池。',
    tag: '本机',
    className: 'source-local'
  }
})
const manageContextItems = computed(() => normalizeContextItems(reportManageContext.value && reportManageContext.value.items))
const manageContextIndex = computed(() => manageContextItems.value.findIndex((item) => item.id === String(currentReportId.value || '')))
const currentManageContextItem = computed(() => manageContextIndex.value >= 0 ? manageContextItems.value[manageContextIndex.value] : null)
const prevManageContextItem = computed(() => manageContextIndex.value > 0 ? manageContextItems.value[manageContextIndex.value - 1] : null)
const nextManageContextItem = computed(() => manageContextIndex.value >= 0 && manageContextIndex.value < manageContextItems.value.length - 1 ? manageContextItems.value[manageContextIndex.value + 1] : null)
const manageContextNotice = computed(() => {
  if (!hasReport.value || missingDetail.value || !lastQuery.value || lastQuery.value.from !== 'manage') return null
  const items = manageContextItems.value
  if (!items.length) return null
  const context = reportManageContext.value || {}
  const indexText = manageContextIndex.value >= 0 ? `第 ${manageContextIndex.value + 1}/${items.length} 份` : `共 ${items.length} 份`
  const parts = [
    context.filterLabel ? `${context.filterLabel}筛选` : '',
    context.searchKeyword ? `搜索「${context.searchKeyword}」` : '',
    context.sortLabel ? `${context.sortLabel}排序` : ''
  ].filter(Boolean)
  const current = currentManageContextItem.value
  return {
    title: `来自信用报告管理 · ${indexText}`,
    subtitle: parts.length ? parts.join(' · ') : '保持管理页筛选状态，返回后可继续查看历史资产。',
    tag: current && current.scoreText && current.scoreText !== '--' ? `综合分 ${current.scoreText}` : first(current && current.dateText, '历史报告'),
    prevId: prevManageContextItem.value && prevManageContextItem.value.id,
    nextId: nextManageContextItem.value && nextManageContextItem.value.id
  }
})
const messageDetailNotice = computed(() => {
  if (!hasReport.value || missingDetail.value || !isMessageRoute.value) return null
  const state = messageRouteContext.value || {}
  const title = state.sourceTitle || '信用报告消息'
  const reportLabel = first(currentReport.value && currentReport.value.fileName, reportType.value, '信用报告')
  const reportText = currentReportId.value ? `报告 ${currentReportId.value}` : ''
  const statusText = messageHandled.value ? '已记录处理完成' : '已记录进入详情'
  return {
    title: `来自消息 · ${title}`,
    subtitle: [reportLabel, reportText, statusText].filter(Boolean).join(' · '),
    tag: messageHandled.value ? '已处理' : '消息定位'
  }
})
const missingDetailText = computed(() => {
  const name = missingReport.value && missingReport.value.fileName ? `「${missingReport.value.fileName}」` : '这份报告'
  return `${name}已有上传记录，但完整分析数据缺失。请重新上传最新信用报告，系统会重新生成信用画像。`
})
const missingDetailMeta = computed(() => {
  const r = missingReport.value || {}
  const type = r.reportType || '信用报告'
	const dateMeta = getReportDateDisplayMeta(r)
	const scoreValue = strictNonNegativeNumberOrNull(r._score)
	const score = scoreValue != null && scoreValue <= 100 ? ` · 摘要分 ${scoreValue}` : ''
	return `${type} · ${dateMeta.reportDateText} · ${dateMeta.uploadDateText}${score}`
})
const emptyReportTitle = computed(() => requestedReportMissing.value ? '指定报告不可用' : '暂无报告')
const emptyReportText = computed(() => requestedReportMissing.value
  ? '未找到链接指定的报告。为避免展示或下载其他客户的报告，系统不会自动切换到最新报告。'
  : '上传信用报告后，这里将展示完整的信用分析结果。')
const basicBadges = computed(() => {
  const bi = basicInfo.value
  const idRaw = String(first(bi.id_last4, bi.idLast4, bi.id_card, bi.idCard, '') || '').replace(/[^\dXx]/g, '')
  const idTail = idRaw.length > 4 ? idRaw.slice(-4) : idRaw
  const badges = []
  if (bi.age) badges.push(`${bi.age}岁`)
  if (bi.gender) badges.push(String(bi.gender))
  if (idTail) badges.push(`证件尾号 ${idTail}`)
  if (badges.length === 0) badges.push('基础信息待补全')
  return badges
})
const scoreHeadline = computed(() => {
  if (!hasTrustedScore.value) {
    return archivalScore.value != null
      ? '已保留历史评分，但缺少可核对依据，不用于风险、匹配或建议。'
      : '当前报告缺少可核对的评分依据，建议重新分析后再判断。'
  }
  if (!hasTrustedRiskLevel.value) {
    return '综合评分已生成，但整体风险等级仍待核对，不应仅凭分数判断信用状态。'
  }
  if (totalScore.value >= 75) return '整体信用状态较稳，可以优先关注额度与成本。'
  if (totalScore.value >= 51) return '信用基础可用，建议优化查询和负债结构。'
  if (totalScore.value >= 26) return '存在明显压力项，申请前建议先做修复。'
  return '当前风险较高，优先处理逾期、异常和高频查询。'
})

// 旧版 report_interpretation 没有逐字段服务端证据标记，不能因评分可信而整体解锁。
// 在服务端提供专用 decision flag 前，失败关闭，避免历史模型结论重新进入风险或行动链。
const reportInterpretation = computed(() => null)
const interpretationMetrics = computed(() => [])
const interpretationPoints = computed(() => [])
const interpretationActions = computed(() => [])

const dims = computed(() => {
  const s = {
    ...obj(norm.value && norm.value.scores),
    ...obj(scoreResolution.value && scoreResolution.value.four)
  }
  const d = dimensions.value
  const defs = [
    { key: 'repayment_record', zh: '还款记录', hint: '逾期、呆账、状态异常' },
    { key: 'credit_history', zh: '信用历史', hint: '账户年限与稳定性' },
    { key: 'account_structure', zh: '账户结构', hint: '贷款、信用卡与机构分布' },
    { key: 'query_frequency', zh: '查询频率', hint: '审批查询次数与密度' }
  ]
  return defs.map((item) => ({
    ...item,
    value: numberOrNull(first(s[item.key], s[item.zh], d[item.key], d[item.zh]))
  }))
})

const readableDimCount = computed(() => dims.value.filter((item) => item.value != null).length)
const primaryObservedText = (code, metricsValue) => {
  const metrics = obj(metricsValue)
  if (/^ACC_/.test(code)) {
    const value = numberOrNull(first(metrics.totalAccounts, metrics.totalAccountCount))
    return value == null ? '' : `实际 ${Math.round(value)} 个`
  }
  if (/^NONBANK_/.test(code)) {
    const value = numberOrNull(first(metrics.activeNonBankLoanCount, metrics.nonBankLoanCount))
    return value == null ? '' : `实际 ${Math.round(value)} 笔`
  }
  if (/^CARD_UTIL_/.test(code)) {
    const value = numberOrNull(first(metrics.cardUsageRate, metrics.cardUtilizationRate))
    if (value == null) return ''
    const pct = value > 0 && value <= 1 ? value * 100 : value
    return `实际 ${Math.round(pct)}%`
  }
  if (code === 'CARD_BIG_INSTALLMENT') {
    const value = numberOrNull(first(metrics.bigInstallmentTotal, metrics.largeInstallment))
    return value == null || value <= 0 ? '已识别' : `实际 ${Math.round(value)} 笔`
  }
  if (/^Q6_/.test(code)) {
    const value = numberOrNull(first(metrics.q6, metrics.query6m))
    return value == null ? '' : `实际 ${Math.round(value)} 次`
  }
  if (code === 'SAME_DAY_QUERY_GT_3') return '已触发'
  return ''
}
const primaryRuleRows = (result, prefix) => arr(result && result.deductions).slice(0, 6).map((item, index) => {
  const deduction = obj(item)
  const count = Math.max(1, Math.round(aggNum(deduction.count, 1)))
  const points = Math.max(0, aggNum(deduction.points, 0) * count)
  const observed = primaryObservedText(String(deduction.code || ''), result && result.metrics)
  return {
    key: `${prefix}_${index}_${first(deduction.code, deduction.label, index)}`,
    label: [first(deduction.label, deduction.code, '评分规则扣分'), observed].filter(Boolean).join(' · '),
    value: points > 0 ? `-${Math.round(points)}分` : '已命中'
  }
})
const overdueRuleRows = (result) => {
  const bucketLabels = { within6m: '半年内', within12m: '6–12个月', older: '12个月以上' }
  return arr(result && result.deductions).slice(0, 6).map((item, index) => {
    const deduction = obj(item)
    const count = Math.max(1, Math.round(aggNum(deduction.count, 1)))
    const points = Math.max(0, aggNum(deduction.points, 0) * count)
    const label = [
      deduction.bank,
      deduction.level ? `${deduction.level}${count > 1 ? ` × ${count}` : ''}` : '',
      bucketLabels[deduction.bucket] || deduction.bucket
    ].filter(Boolean).join(' · ') || '逾期专项规则'
    return {
      key: `overdue_${index}_${first(deduction.bank, deduction.level, index)}`,
      label,
      value: `-${Math.round(points)}分`
    }
  })
}
const scoreBasis = computed(() => {
  if (!hasReport.value || missingDetail.value) return null
  const dimensionRows = dims.value
    .filter((item) => item.value != null)
    .map((item) => ({ key: item.key, label: item.zh, value: `${Math.round(item.value)}分` }))
  const resolution = scoreResolution.value
  const source = String(resolution.source || 'unavailable')
  const isFourDimensionSource = source.startsWith('four-dimension')
  const dimensionTitle = isFourDimensionSource ? '四维评分（当前兜底构成）' : '四维诊断（不参与当前总分）'
  if (!hasTrustedScore.value) {
    const hasArchivedScore = archivalScore.value != null
    const legacyStored = source === 'assessment-stored' || source === 'legacy-explicit'
    return {
      title: SCORE_COPY.reportTotal.sourceTitle,
      tag: hasArchivedScore ? '历史分待核对' : '暂无可信评分',
      desc: hasArchivedScore
        ? `${legacyStored ? '旧版报告' : '当前报告'}保存了 ${archivalScore.value} 分，但没有完整、可复算的规则输入与扣分链。该数值仅作为历史档案保留，不参与风险等级、产品匹配或行动建议。`
        : '当前报告没有可核对的评分结果或有效评分维度。系统不会把空维度当作 100 分，也不会把缺失分数显示成 0 分；请重新分析完整报告。',
      rows: [
        { key: 'score', label: SCORE_COPY.reportTotal.label, value: '—' },
        ...(hasArchivedScore ? [{ key: 'archival-score', label: '历史存档分（不用于决策）', value: `${archivalScore.value}分` }] : []),
        { key: 'dims', label: SCORE_COPY.reportTotal.fourDimensionLabel, value: `${readableDimCount.value}/4项可读` }
      ],
      dimensions: dimensionRows,
      dimensionTitle,
      rules: [],
      ruleNote: '',
      formulaWarning: ''
    }
  }
  const result = obj(resolution.result)
  let ruleRows = []
  let tag = SCORE_COPY.reportTotal.legacyLabel
  let desc = '当前综合分来自旧版报告保存的最终结果，原报告没有保留可还原的逐项扣分链；四维评分仅用于解释强弱项。'
  let formulaWarning = ''
  let ruleNote = ''
  const rows = []

  if (source === 'owner-api-decision-score') {
    const base = numberOrNull(first(result.baseScore, result.base_score))
    const deduction = numberOrNull(first(result.totalDeduction, result.total_deduction))
    tag = '服务端证据口径'
    desc = '综合分来自当前登录用户的服务端报告详情，并已通过证据发布门禁；本地历史字段不作为该分数的信任来源。'
    ruleRows = primaryRuleRows(result, 'owner-primary')
    if (base != null) rows.push({ key: 'owner-primary-base', label: '主评分基准', value: `${Math.round(base)}分` })
    if (deduction != null) rows.push({ key: 'owner-primary-deduction', label: '规则合计扣分', value: `-${Math.round(deduction)}分` })
    if (ruleRows.length) rows.push({ key: 'owner-primary', label: '服务端主评分输出', value: `${totalScore.value}分` })
  } else if (source === 'overdue-special') {
    const base = numberOrNull(result.base)
    const deduction = numberOrNull(first(result.totalDeduction, result.total_deduction))
    const expected = base == null || deduction == null ? null : Math.max(0, Math.min(100, Math.round(base - deduction)))
    tag = SCORE_COPY.reportTotal.overduePriorityLabel
    desc = base == null || deduction == null
      ? '发现逾期信号，综合分采用逾期专项规则，覆盖主评分框架和四维加权。'
      : `发现逾期信号，按下限保护公式 max(0, ${Math.round(base)} - ${Math.round(deduction)}) = ${totalScore.value} 分，覆盖主评分框架和四维加权。`
    ruleRows = overdueRuleRows(result)
    const totalRules = arr(result.deductions).length
    if (totalRules > ruleRows.length) ruleNote = `仅展示 ${ruleRows.length}/${totalRules} 条，合计扣分已包含其余命中记录。`
    if (expected != null && expected !== totalScore.value) {
      formulaWarning = `评分结果与扣分公式不一致：按已保存依据应为 ${expected} 分，当前展示 ${totalScore.value} 分，请重新分析核对。`
    }
    if (base != null) rows.push({ key: 'base', label: '规则基准分', value: `${Math.round(base)}分` })
    if (deduction != null) rows.push({ key: 'overdue', label: '逾期专项扣分', value: `-${Math.round(deduction)}分` })
    if (resolution.asOf) rows.push({ key: 'as-of', label: '评分时点', value: String(resolution.asOf).slice(0, 10) })
  } else if (source === 'authoritative-primary-rule' || source === 'primary-rule-stored' || source === 'primary-rule-local') {
    const base = numberOrNull(first(result.baseScore, result.base_score))
    const deduction = numberOrNull(first(result.totalDeduction, result.total_deduction))
    const expected = base == null || deduction == null ? null : Math.max(0, Math.min(100, Math.round(base - deduction)))
    const visibleDeduction = arr(result.deductions).reduce((sum, item) => {
      const row = obj(item)
      return sum + Math.max(0, aggNum(row.points, 0)) * Math.max(1, Math.round(aggNum(row.count, 1)))
    }, 0)
    tag = SCORE_COPY.reportTotal.primaryRuleLabel
    desc = source === 'primary-rule-local'
      ? '报告未保存主评分结果，系统按本报告中可核对的旧版维度执行主评分规则复算；四维诊断仅解释强弱项。'
      : (source === 'authoritative-primary-rule'
          ? '综合分来自通过证据与发布门禁的确定性主评分结果；四维诊断仅解释强弱项。'
          : '未发现触发逾期专项优先的信号，综合分采用具备完整规则输入与扣分链的主评分结果；四维诊断仅解释强弱项。')
    ruleRows = primaryRuleRows(result, source === 'primary-rule-local' ? 'primary-local' : 'primary')
    const totalRules = arr(result.deductions).length
    if (totalRules > ruleRows.length) ruleNote = `仅展示 ${ruleRows.length}/${totalRules} 条，规则合计扣分包含其余命中项。`
    const warnings = []
    if (expected != null && expected !== totalScore.value) warnings.push(`按“基准分－合计扣分”应为 ${expected} 分`)
    if (deduction != null && arr(result.deductions).length > 0 && Math.round(visibleDeduction) !== Math.round(deduction)) {
      warnings.push(`逐项扣分合计 ${Math.round(visibleDeduction)} 分，与保存的合计 ${Math.round(deduction)} 分不一致`)
    }
    if (warnings.length) formulaWarning = `${warnings.join('；')}。当前保留原报告分数，请重新分析核对。`
    if (base != null) rows.push({ key: 'primary-base', label: '主评分基准', value: `${Math.round(base)}分` })
    if (deduction != null) rows.push({ key: 'primary-deduction', label: '规则合计扣分', value: `-${Math.round(deduction)}分` })
    rows.push({ key: 'primary', label: source === 'primary-rule-local' ? '主评分规则复算' : '主评分输出', value: `${totalScore.value}分` })
  } else if (source === 'assessment-stored') {
    tag = '报告评估分'
    desc = '当前综合分来自旧版服务端保存的评估结果；原报告未保留完整逐项扣分链，四维诊断仅用于解释强弱项。'
    rows.push({ key: 'assessment', label: '评估输出', value: `${totalScore.value}分` })
  } else if (isFourDimensionSource) {
    tag = SCORE_COPY.reportTotal.fourDimensionLabel
    desc = '当前报告没有可核对的主评分扣分链，综合分采用报告四维评分的加权兼容结果；下方四项即本次兜底构成。'
  }
  rows.push({ key: 'score', label: SCORE_COPY.reportTotal.label, value: `${totalScore.value}分` })
  rows.push(
    { key: 'risk', label: SCORE_COPY.reportTotal.riskLevelLabel, value: riskMeta.value.riskLabel || '待评估' },
    { key: 'dims', label: SCORE_COPY.reportTotal.fourDimensionLabel, value: `${readableDimCount.value}/4项可读` }
  )
  return {
    title: SCORE_COPY.reportTotal.sourceTitle,
    tag,
    desc,
    rows,
    dimensions: dimensionRows,
    dimensionTitle,
    rules: ruleRows,
    ruleNote,
    formulaWarning
  }
})

const barWidth = (v) => {
  const n = numberOrNull(v)
  if (n == null) return '0%'
  return limitPct(n) + '%'
}

const accounts = computed(() => arr(norm.value && norm.value.creditAccounts).map(normalizeAccountForDetail))
const accountSummary = computed(() => summarizeAccountsForDetail(accounts.value))
const accountCountDecision = computed(() => resolveDecisionAccountCount(raw.value, reportDecisionTrust.value, decisionReportId.value))
const trustedAccountCount = computed(() => accountCountDecision.value.known ? accountCountDecision.value.value : null)
const accountPrimaryBalanceText = computed(() => moneyOrZeroText(accountSummary.value.activeBalance, accountSummary.value.activeBalanceKnown))
const accountUsageMetricText = computed(() => accountSummary.value.cardLimit != null && accountSummary.value.cardLimit > 0
	? cardUsageText.value
	: moneyOrZeroText(accountSummary.value.totalMonthly, accountSummary.value.totalMonthlyKnown))
const accountUsageMetricLabel = computed(() => accountSummary.value.cardLimit > 0 ? '信用卡使用率（证据口径）' : '历史估算月供')
const accountLimitValueText = computed(() => moneyOrZeroText(accountSummary.value.activeLimit, accountSummary.value.activeLimitKnown))
const accountVolumeNotice = computed(() => {
  const summary = accountSummary.value
  if (!summary.total) return ''
  if (summary.cardInferredSharedGroupCount > 0) return `历史卡片明细存在 ${summary.cardInferredSharedGroupCount} 组疑似重复关系；未按同机构或同开户日自动合并，待服务端显式共享关系核对。`
  if (summary.cardForeignCurrencyAccountCount > 0) return '历史明细含外币账户；主使用率仅采用服务端人民币确定性口径。'
  if (summary.total >= 80) return `账户 ${summary.total} 条较多，已优先展示异常、活跃和大额账户，可用筛选快速定位。`
  if (summary.highUsage > 0) return `历史卡片明细中有 ${summary.highUsage} 项达到高占用阈值，仅供核对，不参与主使用率判断。`
  if (summary.largeBalance > 0) return `历史账户明细中有 ${summary.largeBalance} 笔大额余额，仅供核对。`
  if (summary.nonbank > 0) return `历史明细暂分出非银机构 ${summary.nonbank} 条，机构分类以服务端核验结果为准。`
  return ''
})
const overdueDecisionMetric = computed(() => resolveOverdueAccountMetric(raw.value, reportDecisionTrust.value, decisionReportId.value))
const overdueCount = computed(() => overdueDecisionMetric.value.known ? overdueDecisionMetric.value.value : null)
const loanAccounts = computed(() => accounts.value.filter((a) => a.isLoan))
const cardAccounts = computed(() => accounts.value.filter((a) => !a.isLoan))
const accountFilterOptions = computed(() => [
  { key: 'all', label: '全部', count: accountSummary.value.total },
  { key: 'active', label: '活跃', count: accountSummary.value.active },
  { key: 'loan', label: '贷款', count: accountSummary.value.loan },
  { key: 'card', label: '信用卡', count: accountSummary.value.card },
  { key: 'abnormal', label: '异常', count: accountSummary.value.abnormal },
  { key: 'highUsage', label: '高使用率', count: accountSummary.value.highUsage },
  { key: 'largeBalance', label: '大额余额', count: accountSummary.value.largeBalance },
  { key: 'nonbank', label: '非银', count: accountSummary.value.nonbank },
  { key: 'settled', label: '结清', count: accountSummary.value.settled }
].filter((item) => item.key === 'all' || item.count > 0))
const filteredAccounts = computed(() => (
  exportMode.value
    ? accounts.value
    : filterAccountsForDetail(accounts.value, accountFilter.value)
))
const accountPageStep = computed(() => (filteredAccounts.value.length >= 80 ? 25 : 10))
const shownAccounts = computed(() => filteredAccounts.value.slice(0, accountLimit.value))
const accountMoreText = computed(() => {
  const remaining = Math.max(0, filteredAccounts.value.length - accountLimit.value)
  const next = Math.min(accountPageStep.value, remaining)
  return remaining > next ? `继续加载 ${next} 条（剩余 ${remaining}）` : `查看剩余 ${remaining} 条`
})
const accountEmptyText = computed(() => accountFilter.value === 'all' ? '暂无可展示的账户明细。' : '当前筛选暂无账户，可切换到“全部”查看。')
const setAccountFilter = (key) => {
  accountFilter.value = key
  accountLimit.value = 8
}
const institutionCount = computed(() => {
  const set = new Set(accounts.value.map((a) => String(a.institution || '').trim()).filter(Boolean))
  return set.size
})
const activeInstitutionCount = computed(() => {
	if (!accountSummary.value.activeKnown) return null
  const set = new Set(accounts.value
		.filter((a) => a.active === true)
    .map((a) => String(a.institution || '').trim())
    .filter(Boolean))
  return set.size
})

const accountDebtTotal = computed(() => accountSummary.value.totalBalanceKnown ? accountSummary.value.totalBalance : null)
const archivalDebtTotal = computed(() => {
  const cd = creditDebt.value
	return numberOrNull(first(cd.total_debt, cd.totalDebt, dimensions.value.totalDebt, dimensions.value.total_debt, accountDebtTotal.value))
})
const totalDebt = computed(() => {
	const resolved = resolveDecisionTotalDebt(raw.value, reportDecisionTrust.value, decisionReportId.value)
	return resolved.known ? resolved.value : null
})
const totalDebtText = computed(() => totalDebt.value == null ? '—' : moneyOrZeroText(totalDebt.value, true))
const debtRatioDecision = computed(() => resolveEvidenceBackedDebtRatio(raw.value, reportDecisionTrust.value, decisionReportId.value))
// Phase 0 fail-closed switch: the existing metric is totalDebt/totalLine, but
// the denominator has not completed the evidence contract. Even an older
// owner projection that exposes debtRatio must remain presentation-only.
const DEBT_RATIO_DECISION_ENABLED = false
const hasEvidenceBackedDebtRatio = computed(() => (
  DEBT_RATIO_DECISION_ENABLED && debtRatioDecision.value.decisionEligible === true
))
const debtRatioRaw = computed(() => {
  const cd = creditDebt.value
  const explicitUtilization = firstObj(cd.credit_limit_utilization, cd.creditLimitUtilization)
  return numberOrNull(first(
    explicitUtilization.value,
    explicitUtilization.ratio,
    explicitUtilization.rate,
    cd.credit_limit_utilization,
    cd.creditLimitUtilization,
    cd.debt_ratio,
    cd.debtRatio,
    cd.debt_ratio_pct,
    cd.debtRatioPct,
    dimensions.value.creditLimitUtilization,
    dimensions.value.credit_limit_utilization,
    dimensions.value.debtRatio,
    dimensions.value.debt_ratio
  ))
})
const debtRatioPct = computed(() => (
  hasEvidenceBackedDebtRatio.value && debtRatioDecision.value.value != null
    ? toPct(debtRatioDecision.value.value)
    : null
))
const debtRatioText = computed(() => {
  if (debtRatioPct.value != null) return `${debtRatioPct.value}%`
  return debtRatioRaw.value != null ? '待核对' : '不可计算'
})
const debtRatioLabel = computed(() => (hasEvidenceBackedDebtRatio.value ? '授信占用率' : '授信占用率（待核对）'))
const debtRatioSub = computed(() => {
  if (hasEvidenceBackedDebtRatio.value) return '证据化授信口径'
  return debtRatioRaw.value != null
    ? '口径为总负债/授信额度；分母证据待闭合，不参与风险或决策'
    : '缺少可核对的授信口径'
})
const trustedSharedCreditGroupCount = computed(() => numberOrNull(
  trustedDecisionValue(reportDecisionTrust.value, 'sharedCreditGroupCount', 'sharedCreditGroupCount', decisionReportId.value)
))
const cardUsagePct = computed(() => {
  const trustedPct = numberOrNull(trustedDecisionValue(reportDecisionTrust.value, 'cardUtilizationPct', 'cardUtilizationPct', decisionReportId.value))
  if (trustedPct != null && trustedPct >= 0) return Math.round(trustedPct)
  const trustedRate = numberOrNull(trustedDecisionValue(reportDecisionTrust.value, 'cardUtilizationRate', 'cardUtilizationRate', decisionReportId.value))
  if (trustedRate != null && trustedRate >= 0) return Math.round(trustedRate <= 1 ? trustedRate * 100 : trustedRate)
  return null
})
const cardUsageText = computed(() => (cardUsagePct.value == null ? '—' : `${cardUsagePct.value}%`))

const queryItemsFlat = computed(() => {
  const ad = obj(raw.value)
  const qr = obj(ad.queryRecords || ad.query_records)
  const qa = obj(cv2.value.query_analysis || cv2.value.queryAnalysis)
  const sources = [
    qr.details,
    qr.queryItems,
    qr.items,
    qa.query_details,
    qa.queryDetails,
    qa.self_queries,
    qa.selfQueries,
    ad.queryDetails,
    ad.query_items
  ]
  const map = new Map()
  sources.forEach((source) => {
    arr(source).forEach((row, index) => {
      const r = obj(row)
      const date = first(r.date, r.query_date, r.queryDate, r.time, '')
      const org = first(r.org, r.institution, r.bank, r.query_org, r.queryOrg, '')
      const reason = first(r.reason, r.query_reason, r.purpose, '')
      const key = `${date}|${org}|${reason}|${index}`
      if (!map.has(key)) map.set(key, r)
    })
  })
  return [...map.values()]
})
const queryWindowSummary = computed(() => (
  queryAnchorDate.value
    ? summarizeQueriesByWindows(queryItemsFlat.value, queryAnchorDate.value)
    : {}
))
const queryMatrix = computed(() => {
  const ad = obj(raw.value)
  const qr = obj(ad.queryRecords || ad.query_records)
  const qa = obj(cv2.value.query_analysis || cv2.value.queryAnalysis)
  const qs = obj(qa.summary)
  const windows = obj(qr.windowSummaries || qr.window_summaries)
  const fallback = {
    '1m': first(windows.last_1m, windows['1m'], qs.last_1m, qr.recent1Month, qr.recent_1m, qs.recent_1_month),
    '3m': first(windows.last_3m, windows['3m'], qs.last_3m, qr.recent3Month, qr.recent_3m, qs.recent_3_month),
    '6m': first(windows.last_6m, windows['6m'], qs.last_6m, qr.recent6Month, qr.recent_6m, qs.recent_6_month, norm.value && norm.value.queryCount),
    '12m': first(windows.last_12m, windows['12m'], qs.last_12m, qr.recent12Month, qr.recent_12m, qs.recent_12_month)
  }
  const defs = [
    { key: '1m', flag: 'query1mCount', label: '近1月', warnAt: 2 },
    { key: '3m', flag: 'query3mCount', label: '近3月', warnAt: 4 },
    { key: '6m', flag: 'query6mCount', label: '近6月', warnAt: ACTION_THRESHOLDS.QUERY6M_ADVISOR },
    { key: '12m', flag: 'query12mCount', label: '近12月', warnAt: 12 }
  ]
  return defs.map((item) => {
    const anchored = queryWindowSummary.value[item.key] || {}
    const trustedTotal = numberOrNull(trustedDecisionValue(reportDecisionTrust.value, item.flag, item.flag, decisionReportId.value))
    const rawServer = fallback[item.key]
    const server = rawServer && typeof rawServer === 'object'
      ? {
          total: aggNum(first(rawServer.total, rawServer.count), 0),
          bank: numberOrNull(first(rawServer.bank, rawServer.bank_count)),
          nonBank: numberOrNull(first(rawServer.non_bank, rawServer.nonBank, rawServer.non_bank_count)),
          unknown: aggNum(first(rawServer.unknown, rawServer.unknown_count), 0),
          breakdownAvailable: rawServer.breakdownAvailable !== false && rawServer.breakdown_available !== false
        }
      : { total: aggNum(rawServer, 0), bank: null, nonBank: null, unknown: aggNum(rawServer, 0), breakdownAvailable: false }
    const archivalSource = anchored.total > 0 ? anchored : server
    const source = trustedTotal != null
      ? { total: trustedTotal, bank: null, nonBank: null, unknown: trustedTotal, breakdownAvailable: false }
      : { total: null, bank: null, nonBank: null, unknown: null, breakdownAvailable: false }
    const bank = numberOrNull(source.bank)
    const nonBank = numberOrNull(source.nonBank)
    const breakdownAvailable = source.breakdownAvailable !== false && bank != null && nonBank != null
    return {
      ...item,
      known: trustedTotal != null,
      total: trustedTotal != null ? Math.max(0, Math.round(trustedTotal)) : null,
      archivalTotal: Math.max(0, Math.round(aggNum(archivalSource.total, 0))),
      bank: breakdownAvailable ? Math.max(0, Math.round(bank)) : null,
      nonBank: breakdownAvailable ? Math.max(0, Math.round(nonBank)) : null,
      unknown: Math.max(0, Math.round(aggNum(source.unknown, breakdownAvailable ? 0 : source.total))),
      breakdownAvailable
    }
  })
})
const queryBreakdownText = (row) => {
  if (!row || row.known !== true) return '历史明细仅供核对'
  if (!row || row.breakdownAvailable === false) return `机构分类待核对${row && row.unknown > 0 ? ` ${row.unknown}` : ''}`
  const unknown = Math.max(0, Math.round(aggNum(row.unknown, 0)))
  return `银行 ${row.bank} · 非银 ${row.nonBank}${unknown > 0 ? ` · 未分类 ${unknown}` : ''}`
}
const query6mCount = computed(() => {
  const row = queryMatrix.value.find((item) => item.key === '6m')
  return row?.known === true ? row.total : null
})
const profileOverviewCells = computed(() => {
  const sixMonth = queryMatrix.value.find((item) => item.key === '6m') || { bank: null, nonBank: null, breakdownAvailable: false }
  const summary = accountSummary.value
  return [
    {
      key: 'currentDebt',
      value: totalDebtText.value,
      label: '当前负债',
      sub: totalDebt.value == null
		? `历史账户合计 ${moneyOrZeroText(archivalDebtTotal.value, archivalDebtTotal.value != null)}，仅供核对`
		: `服务端证据口径 · 活跃账户 ${summary.activeKnown ? `${summary.active} 个` : '待核对'}`,
      warn: totalDebt.value != null && totalDebt.value > 0 && debtRatioPct.value != null && debtRatioPct.value > 70
    },
    {
      key: 'debtRatio',
      value: debtRatioText.value,
      label: debtRatioLabel.value,
      sub: debtRatioSub.value,
      warn: debtRatioPct.value != null && debtRatioPct.value > 70
    },
    {
      key: 'cardUsage',
      value: cardUsageText.value,
      label: '信用卡使用率',
      sub: trustedSharedCreditGroupCount.value == null
        ? '历史卡片明细仅供核对'
        : `服务端确定性口径 · 共享额度 ${Math.max(0, Math.round(trustedSharedCreditGroupCount.value))} 组`,
      warn: cardUsagePct.value != null && cardUsagePct.value > 70
    },
    {
      key: 'query6m',
      value: query6mCount.value == null ? '—' : String(query6mCount.value),
      label: '近6月审批查询',
      sub: queryBreakdownText(sixMonth),
      warn: query6mCount.value != null && query6mCount.value > ACTION_THRESHOLDS.QUERY6M_ADVISOR
    },
    {
      key: 'activeAccounts',
		value: summary.activeKnown ? String(summary.active) : '—',
      label: '历史活跃账户',
		sub: summary.activeKnown ? `历史解析 · 已结清 ${summary.settled}，仅供核对` : '账户状态待核对',
      warn: false
    },
    {
      key: 'activeInstitutions',
		value: activeInstitutionCount.value == null ? '—' : String(activeInstitutionCount.value),
      label: '历史活跃授信机构',
		sub: activeInstitutionCount.value == null ? '账户状态待核对' : `历史解析 · 机构 ${institutionCount.value}，仅供核对`,
      warn: false
    }
  ]
})
const profileOverviewNotice = computed(() => {
  const summary = accountSummary.value
  const tips = []
	if (summary.activeKnown && summary.settled > 0 && summary.settled >= summary.active) tips.push(`已结清账户 ${summary.settled} 个，画像优先展示当前活跃口径。`)
  if (query6mCount.value != null && query6mCount.value > ACTION_THRESHOLDS.QUERY6M_ADVISOR) tips.push(`近6月审批查询 ${query6mCount.value} 次，需要结合下方查询记录确认集中申请情况。`)
  if (summary.highUsage > 0) tips.push(`历史卡片明细有 ${summary.highUsage} 项达到高占用阈值，仅供核对。`)
  return tips.slice(0, 2).join(' ')
})
const queryWindowMonths = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 }
const queryPageStep = 20
const selectedQueryWindow = computed(() => queryMatrix.value.find((item) => item.key === activeQueryWindow.value) || queryMatrix.value.find((item) => item.key === '6m') || queryMatrix.value[0])
const selectedQueryWindowLabel = computed(() => selectedQueryWindow.value ? selectedQueryWindow.value.label : '近6月')
const selectedQueryWindowTotal = computed(() => selectedQueryWindow.value?.known === true
  ? Math.max(0, Math.round(aggNum(selectedQueryWindow.value.total, 0)))
  : null)
const setQueryWindow = (key) => {
  activeQueryWindow.value = key
  queryRowLimit.value = 8
  queryKindFilter.value = 'all'
}
const queryDetailSource = computed(() => {
  const monthsBack = queryWindowMonths[activeQueryWindow.value] || 6
  const primary = filterQueryInstitutionDetailsLive(queryItemsFlat.value, { monthsBack, anchorDate: queryAnchorDate.value })
  if (primary.length) return primary
  return activeQueryWindow.value === '12m' ? filterBankQueries12m(queryItemsFlat.value, queryAnchorDate.value) : []
})
const queryTrendRows = computed(() => {
  const monthsBack = queryWindowMonths[activeQueryWindow.value] || 6
  const rows = aggregateQueryItemsByMonth(queryItemsFlat.value, monthsBack, queryAnchorDate.value)
    .map((item) => ({ ...item, total: Math.max(0, Math.round(aggNum(item.bank, 0) + aggNum(item.nonBank, 0) + aggNum(item.unknown, 0))) }))
  const maxTotal = Math.max(...rows.map((item) => item.total), 0)
  if (maxTotal <= 0) return []
  return rows.map((item) => {
    const bank = Math.max(0, Math.round(aggNum(item.bank, 0)))
    const nonBank = Math.max(0, Math.round(aggNum(item.nonBank, 0)))
    const scale = (value) => (value > 0 ? `${Math.max(6, Math.round((value / maxTotal) * 42))}px` : '0px')
    return {
      key: `trend_${item.month}`,
      label: String(item.month || '').slice(5) || item.month,
      total: item.total,
      bankHeight: scale(bank),
      nonBankHeight: scale(nonBank)
    }
  })
})
const queryFilterOptions = computed(() => {
  const counts = { all: queryDetailSource.value.length, bank: 0, nonBank: 0, unknown: 0 }
  queryDetailSource.value.forEach((row) => {
    const kind = classifyQueryItemBank(row)
    if (kind === 'bank') counts.bank += 1
    if (kind === 'nonBank') counts.nonBank += 1
    if (kind === 'unknown') counts.unknown += 1
  })
  return [
    { key: 'all', label: '全部', count: counts.all },
    { key: 'bank', label: '银行', count: counts.bank },
    { key: 'nonBank', label: '非银', count: counts.nonBank },
    { key: 'unknown', label: '未分类', count: counts.unknown }
  ].filter((item) => item.key === 'all' || item.count > 0)
})
const setQueryKindFilter = (key) => {
  if (!queryFilterOptions.value.some((item) => item.key === key)) return
  queryKindFilter.value = key
  queryRowLimit.value = 8
}
const filteredQueryDetailSource = computed(() => {
  if (queryKindFilter.value === 'all') return queryDetailSource.value
  return queryDetailSource.value.filter((row) => classifyQueryItemBank(row) === queryKindFilter.value)
})
const queryRowsTotal = computed(() => filteredQueryDetailSource.value.length)
const queryRows = computed(() => filteredQueryDetailSource.value.slice(0, queryRowLimit.value).map((row, index) => {
  const kind = classifyQueryItemBank(row)
  return {
    key: `q_${activeQueryWindow.value}_${queryKindFilter.value}_${index}_${fmtQueryRowDate(row)}_${first(row.org, row.institution, row.bank, row.query_org, row.queryOrg, '')}`,
    date: fmtQueryRowDate(row),
    org: textOrDash(first(row.org, row.institution, row.bank, row.query_org, row.queryOrg)),
    reason: textOrDash(first(row.reason, row.query_reason, row.purpose)),
    kind,
    kindText: kind === 'bank' ? '银行' : (kind === 'nonBank' ? '非银' : '未分类')
  }
}))
const queryInstitutionHighlights = computed(() => {
  const map = new Map()
  queryDetailSource.value.forEach((row) => {
    const org = String(first(row.org, row.institution, row.bank, row.query_org, row.queryOrg, '未知机构')).trim() || '未知机构'
    const kind = classifyQueryItemBank(row)
    const reason = String(first(row.reason, row.query_reason, row.purpose, '审批查询')).trim() || '审批查询'
    const current = map.get(org) || { org, count: 0, bank: 0, nonBank: 0, unknown: 0, reasons: new Set() }
    current.count += 1
    if (kind === 'bank') current.bank += 1
    if (kind === 'nonBank') current.nonBank += 1
    if (kind === 'unknown') current.unknown += 1
    current.reasons.add(reason)
    map.set(org, current)
  })
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.org.localeCompare(b.org, 'zh-Hans-CN'))
    .slice(0, 3)
    .map((item, index) => ({
      key: `query_org_${index}_${item.org}`,
      org: item.org,
      count: item.count,
      kindText: item.unknown > 0
        ? (item.bank > 0 || item.nonBank > 0 ? '含未分类机构' : '未分类')
        : (item.bank > 0 && item.nonBank > 0 ? '混合机构' : (item.bank > 0 ? '银行' : '非银')),
      reasonsText: [...item.reasons].slice(0, 2).join(' / ') || '审批查询'
    }))
})
const queryMoreText = computed(() => {
  const remaining = Math.max(0, queryRowsTotal.value - queryRowLimit.value)
  const next = Math.min(queryPageStep, remaining)
  return remaining > next ? `继续加载 ${next} 条（剩余 ${remaining}）` : `查看剩余 ${remaining} 条`
})
const selfQueryRowsTotal = computed(() => filterSelfQueriesInLiveWindow(queryItemsFlat.value, queryWindowMonths[activeQueryWindow.value] || 6, queryAnchorDate.value).length)
const queryDetailNotice = computed(() => {
  const total = selectedQueryWindowTotal.value
  const details = queryDetailSource.value.length
  if (total == null) return `${selectedQueryWindowLabel.value}汇总尚未通过当前报告的服务端证据校验；下方历史解析明细仅供核对。`
  if (total > 0 && details === 0) return `${selectedQueryWindowLabel.value}汇总显示 ${total} 次审批查询，但原始解析未拆出机构明细。`
  if (total > details) return `${selectedQueryWindowLabel.value}汇总 ${total} 次，当前可核对机构明细 ${details} 条。`
  if (details >= 80) return `${selectedQueryWindowLabel.value}机构明细 ${details} 条，已按时间倒序分批展开。`
  return ''
})
const queryEmptyText = computed(() => {
  if (queryKindFilter.value !== 'all' && queryDetailSource.value.length > 0) return '当前筛选暂无记录，可切换到“全部”查看。'
  if (selectedQueryWindowTotal.value == null) return `${selectedQueryWindowLabel.value}汇总待服务端证据确认，当前没有可核对的历史机构明细。`
  if (selectedQueryWindowTotal.value > 0) return `${selectedQueryWindowLabel.value}有审批查询汇总，但暂无可展示的机构明细。`
  return `${selectedQueryWindowLabel.value}已验证为暂无审批类硬查询记录。`
})

const riskHits = computed(() => {
  const ad = obj(raw.value)
  const c = cv2.value
  const fp = frontendPayload.value
  const sources = [
    obj(c.risk_analysis || c.riskAnalysis).risk_hits,
    obj(c.risk_analysis || c.riskAnalysis).riskHits,
    fp.risk_cards,
    fp.riskCards,
    obj(fp.tables).risk_hits,
    ad.riskHits,
    ad.risk_hits,
    obj(ad.algorithmReport).riskHits
  ]
  const merged = []
  sources.forEach((source) => arr(source).forEach((item) => merged.push(item)))
  if (!merged.length && norm.value && Array.isArray(norm.value.riskTags)) {
    norm.value.riskTags.forEach((tag) => merged.push({ title: tag, detail: '系统识别到该风险标签，建议结合账户明细核对。', level: '提示', severity: 2 }))
  }
  return normalizeRiskHitsForDetail(merged)
})
const riskHitSummary = computed(() => summarizeRiskHitsByBucket(riskHits.value))
const riskSummary = computed(() => {
	if (riskHitSummary.value.total > 0) return { ...riskHitSummary.value, known: true }
  const fp = frontendPayload.value
  const rs = obj(fp.risk_summary || fp.riskSummary)
	const total = numberOrNull(rs.total)
	if (total != null && total >= 0) {
    return {
			high: numberOrNull(rs.high) == null ? null : Math.round(numberOrNull(rs.high)),
			warn: numberOrNull(rs.warn) == null ? null : Math.round(numberOrNull(rs.warn)),
			info: numberOrNull(rs.info) == null ? null : Math.round(numberOrNull(rs.info)),
			total: Math.round(total),
			known: true
    }
  }
	return { high: null, warn: null, info: null, total: null, known: false }
})
const riskBucketOptions = computed(() => [
  { key: 'high', label: '高风险', count: riskSummary.value.high },
  { key: 'warn', label: '警告', count: riskSummary.value.warn },
  { key: 'info', label: '提示', count: riskSummary.value.info }
])
const selectedRiskBucket = computed(() => (
  riskBucketOptions.value.find((item) => item.key === activeRiskBucket.value) ||
	riskBucketOptions.value.find((item) => item.count != null && item.count > 0) ||
  riskBucketOptions.value[0]
))
const activeRiskTitle = computed(() => (
  exportMode.value ? '全部风险明细' : `${selectedRiskBucket.value.label}明细`
))
const filteredRiskHits = computed(() => {
  if (exportMode.value) {
    return [...riskHits.value].sort((a, b) => b.severity - a.severity)
  }
  const bucket = selectedRiskBucket.value.key
  return [...riskHits.value]
    .filter((hit) => hit.bucket === bucket)
    .sort((a, b) => b.severity - a.severity)
})
const shownRiskBucketHits = computed(() => filteredRiskHits.value.slice(0, riskHitLimit.value))
const riskBucketRemaining = computed(() => Math.max(0, filteredRiskHits.value.length - shownRiskBucketHits.value.length))
const riskEmptyText = computed(() => {
	if (riskSummary.value.known !== true) return '风险信息待核对，当前没有可展示的已核验风险明细。'
  if (exportMode.value) {
    return riskSummary.value.total > 0
      ? '报告包含风险汇总，但没有可展开的逐条明细。'
		: '报告风险汇总为 0；仍需结合服务端风险等级核对。'
  }
  return selectedRiskBucket.value.count > 0
    ? '这一类有汇总计数，但原报告没有可展开的逐条明细。'
		: '这一类汇总为 0；不代表其他风险信息已完整识别。'
})
const selectRiskBucket = (bucket) => {
  if (!riskBucketOptions.value.some((item) => item.key === bucket)) return
  activeRiskBucket.value = bucket
  riskHitLimit.value = 8
  riskDropdownOpen.value = false
}

const hitCardClass = (bucket) => ({ 'hit-card-high': bucket === 'high', 'hit-card-warn': bucket === 'warn', 'hit-card-info': bucket === 'info' })

const dataCompleteness = computed(() => {
  const ad = obj(raw.value)
  const fp = frontendPayload.value
  const c = cv2.value
  const rawDc = obj(ad.dataCompleteness || ad.data_completeness || fp.data_completeness || fp.dataCompleteness || c.data_completeness || c.dataCompleteness)
  if (!Object.keys(rawDc).length) return null
  const score = numberOrNull(first(rawDc.score, rawDc.coverage, rawDc.rate, rawDc.percent))
  const grade = String(first(rawDc.grade, rawDc.level, score == null ? '—' : score >= 85 ? 'A' : score >= 70 ? 'B' : 'C'))
  const missing = arr(rawDc.missing_fields || rawDc.missingFields || rawDc.missing).filter(Boolean).map((item) => String(item))
  const warnings = arr(rawDc.warnings || rawDc.tips || rawDc.notes).filter(Boolean).map((item) => String(item))
  const summary = first(rawDc.summary, rawDc.desc, missing.length ? `缺少 ${missing.slice(0, 3).join('、')}` : warnings[0], '报告关键字段可用于深度分析。')
  const scoreText = score == null ? '—' : (score > 1 ? `${Math.round(score)}%` : `${Math.round(score * 100)}%`)
  let color = '#DC2626'
  if (/^A/i.test(grade)) color = '#086CEA'
  else if (/^B/i.test(grade)) color = '#D97706'

  const moduleCoverage = obj(rawDc.module_coverage || rawDc.moduleCoverage || rawDc.fields || rawDc.fieldCoverage)
  const rawModules = arr(rawDc.modules || rawDc.moduleList || rawDc.items || rawDc.checks)
  const moduleSource = rawModules.length
    ? rawModules
    : Object.keys(moduleCoverage).map((key) => ({ key, label: key, present: moduleCoverage[key], detail: moduleCoverage[key] }))
  const rows = moduleSource.slice(0, 12).map((item, index) => {
    const r = obj(item)
    const rawPresent = first(r.present, r.exists, r.covered, r.ok, r.status, r.value, r.detail)
    const present = completenessBool(rawPresent, true)
    return {
      key: `dc_${index}_${first(r.key, r.label, r.name, index)}`,
      label: first(r.label, r.name, r.title, r.key, `模块 ${index + 1}`),
      present,
      critical: completenessBool(first(r.critical, r.required, r.isCritical), false),
      detail: first(r.detail, r.desc, r.description, r.statusText, present ? '已识别，可参与分析。' : '暂未识别，建议上传更完整报告。')
    }
  }).filter((row) => row.label)
  if (!rows.length && missing.length) {
    missing.slice(0, 8).forEach((item, index) => {
      rows.push({ key: `dc_missing_${index}`, label: item, present: false, critical: true, detail: '当前报告未识别到该字段，相关结论会降低置信度。' })
    })
  }

  const criticalPresent = numberOrNull(first(rawDc.critical_present, rawDc.criticalPresent))
  const criticalTotal = numberOrNull(first(rawDc.critical_total, rawDc.criticalTotal))
  const presentCount = numberOrNull(first(rawDc.present_count, rawDc.presentCount))
  const totalCount = numberOrNull(first(rawDc.total_count, rawDc.totalCount))
  const coverageParts = []
  if (criticalPresent != null && criticalTotal != null) coverageParts.push(`${criticalPresent}/${criticalTotal} 关键模块覆盖`)
  if (presentCount != null && totalCount != null) coverageParts.push(`${presentCount}/${totalCount} 总模块覆盖`)
  if (!coverageParts.length && rows.length) coverageParts.push(`${rows.filter((row) => row.present).length}/${rows.length} 明细项可用`)
  return { grade, summary, scoreText, color, rows, notes: warnings, coverageText: coverageParts.join(' · ') }
})
const debtSegments = computed(() => buildDebtStructureSegments({
  algorithmReport: algorithmReport.value,
  strictAlgorithm: strictAlgorithm.value,
  creditDebt: creditDebt.value,
  creditReportV2: cv2.value,
  accounts: accounts.value
}))
const debtStructureMeta = computed(() => debtSegments.value && debtSegments.value.meta ? debtSegments.value.meta : {})
const activeDebtSegment = computed(() => {
  if (!debtSegments.value.length) return null
  return debtSegments.value.find((item) => item.key === activeDebtKey.value) || debtSegments.value.find((item) => item.amount > 0) || debtSegments.value[0]
})
const debtSegmentSummary = computed(() => {
  const item = activeDebtSegment.value
  if (!item) return null
  const actionMap = {
    bank: '历史银行账户结构，需结合原报告核对月供与剩余期数。',
    nonbank: '历史非银分类，需结合账户明细核对机构与余额。',
    other: '机构分类不明确，需结合账户明细人工核对。',
    card: '历史卡片结构仅供核对；主使用率采用服务端证据口径。',
    'loan-review': '报告总表与账户明细存在差额，需先确认来源。'
  }
  return {
    title: `${item.name} · ${item.percentText}`,
    desc: item.note || actionMap[item.key] || '建议结合账户明细核对金额与状态。',
    action: item.key === 'card' ? '查看账户' : '核对债务'
  }
})
const selectDebtSegment = (key) => { activeDebtKey.value = key }
const debtStructureNotice = computed(() => {
  const meta = debtStructureMeta.value
  const adjustment = aggNum(meta.adjustmentAmount, 0)
  if (adjustment <= 1) return null
  return {
    title: '结构校准',
    desc: `${moneyText(adjustment)} 与机构/账户明细暂未完全匹配，已归入待核对贷款；总负债仍按报告总额计算。`,
    tag: '需核对'
  }
})
const debtStructureHint = computed(() => {
	if (totalDebt.value === 0) return '服务端已核验当前负债为 0'
	if (!debtSegments.value.length) return '余额或账户状态待核对，未按 0 元聚合'
  if (debtStructureNotice.value) return '报告总额与明细存在差额，已归入待核对贷款'
  if (debtRatioPct.value != null && debtRatioPct.value > 70) return `${debtRatioLabel.value}偏高，建议优先压降高成本与短期负债`
  if (cardUsagePct.value != null && cardUsagePct.value > 70) return '信用卡使用率偏高，建议先降低循环使用'
	if (loanAccounts.value.length + cardAccounts.value.length === 0) return '账户数据待核对'
  return '历史结构明细仅供核对，不用于自动生成处理顺序'
})

const overdueRows = computed(() => {
  const ad = obj(raw.value)
  const c = cv2.value
  const fromRaw = arr(ad.overdueRecords || ad.overdue_records || obj(c.overdue_info).records)
  const fromAccounts = accounts.value.filter((item) => item.overdue).map((item) => ({
    institution: item.institution,
    desc: `${item.product} · ${item.statusText}`,
    days: item.overdueDays
  }))
  const rows = (fromRaw.length ? fromRaw : fromAccounts).slice(0, 6)
  return rows.map((row, index) => {
    const r = obj(row)
    const days = Math.max(0, Math.round(aggNum(first(r.days, r.overdue_days, r.overdueDays), 0)))
    return {
      key: `od_${index}`,
      institution: first(r.institution, r.bank, r.org, r.name, '未知机构'),
      desc: first(r.desc, r.detail, r.status, r.type, '逾期或异常记录'),
      daysText: days > 0 ? `${days}天` : '异常'
    }
  })
})

const improvementPlan = computed(() => {
  const source = arr(trustedDecisionValue(
    reportDecisionTrust.value,
    'suggestions',
    'suggestions',
    decisionReportId.value
  ))
  return source.slice(0, 8).map((item, index) => {
    if (typeof item === 'string') {
      return { key: `plan_${index}`, title: item, desc: '建议在 1-3 个月内执行并持续观察。', effect: '', priority: index < 2 ? 'high' : 'medium' }
    }
    const r = obj(item)
    return {
      key: `plan_${index}_${first(r.title, r.name, '')}`,
      title: first(r.title, r.name, r.action, r.suggestion, '优化建议'),
      desc: first(r.desc, r.detail, r.content, r.reason, r.text, '建议结合账户明细制定执行计划。'),
      effect: first(r.effect, r.expected_effect, r.expectedEffect, r.impact, ''),
      priority: String(first(r.priority, r.level, index < 2 ? 'high' : 'medium')).toLowerCase()
    }
  })
})
const planClass = (priority) => ({ 'plan-high': /high|高|urgent/.test(priority), 'plan-medium': /medium|中/.test(priority), 'plan-low': /low|低/.test(priority) })

const publicRecordRows = computed(() => {
  const ad = obj(raw.value)
  const c = cv2.value
  const source = arr(obj(c.public_records || c.publicRecords).items || ad.publicRecords || ad.public_records)
  return source.slice(0, 5).map((item, index) => {
    const r = obj(item)
    return {
      key: `pub_${index}`,
      title: first(r.type, r.title, r.category, '公共记录'),
      desc: first(r.detail, r.desc, r.content, r.org, '请结合原始报告核对。'),
      status: first(r.status, r.result, '记录')
    }
  })
})
const guaranteeRows = computed(() => {
  const c = cv2.value
  const od = obj(c.other_debts || c.otherDebts)
  const source = arr(obj(c.guarantee_records || c.guaranteeRecords).items || od.guarantee || od.guarantees)
	return buildGuaranteeRowsForDetail(source)
})

const navSections = computed(() => [
  { id: 'sec-profile', label: '总览', show: true },
  { id: 'sec-risk', label: '风险', show: true },
  { id: 'sec-score', label: '评分', show: true },
  { id: 'sec-debt', label: '负债', show: true },
  { id: 'sec-query', label: '查询', show: true },
  { id: 'sec-accounts', label: '账户', show: true }
].filter((item) => item.show))
const sectionVisible = (id) => exportMode.value || activeAnchor.value === 'sec-profile' || activeAnchor.value === id

const anchorScrollLeft = computed(() => {
  const index = navSections.value.findIndex((item) => item.id === activeAnchor.value)
  if (index <= 0) return 0
  return Math.max(0, index * 66 - 18)
})

const actionKey = computed(() => {
  if (hasReport.value && !hasTrustedScore.value) return ACTION_KEYS.UPLOAD
  const highRiskMetric = resolveHighRiskMetric(raw.value, reportDecisionTrust.value, decisionReportId.value)
  const overdueMetric = resolveOverdueAccountMetric(raw.value, reportDecisionTrust.value, decisionReportId.value)
  const queryMetric = resolveQuery6mMetric(raw.value, reportDecisionTrust.value, decisionReportId.value)
  return resolveActionKey({
    hasReport: hasReport.value,
    score: totalScore.value,
    highRiskCount: highRiskMetric.value ?? 0,
    overdueAccountCount: overdueMetric.value ?? 0,
    query6mCount: queryMetric.value ?? 0,
    scoreKnown: hasTrustedScore.value,
    highRiskKnown: highRiskMetric.known,
    overdueKnown: overdueMetric.known,
    queryKnown: queryMetric.known
  })
})
const conversionTitle = computed(() => {
  if (actionKey.value === ACTION_KEYS.RISK_FIX) return '先修复关键风险点'
  if (actionKey.value === ACTION_KEYS.ADVISOR) return '先做一次人工校准'
  if (actionKey.value === ACTION_KEYS.MATCH) return '先确认材料再看产品'
  return hasReport.value ? '重新上传并完成分析' : '先上传信用报告'
})
const conversionSubtitle = computed(() => {
  if (actionKey.value === ACTION_KEYS.RISK_FIX) return '检测到高风险或逾期信号，先处理可减少被拒与新增查询。'
  if (actionKey.value === ACTION_KEYS.ADVISOR) return '当前分数或查询密度需要顾问确认，避免盲目申请。'
  if (actionKey.value === ACTION_KEYS.MATCH) return '当前基础较稳，先确认三金、个税、学历和资产情况，再进行产品匹配。'
  return hasReport.value ? '当前报告缺少可信评分依据，请上传清晰完整报告重新分析。' : '上传报告后可生成完整分析。'
})
const conversionButtonText = computed(() => {
  if (actionKey.value === ACTION_KEYS.RISK_FIX || actionKey.value === ACTION_KEYS.ADVISOR) return '咨询顾问'
  if (actionKey.value === ACTION_KEYS.MATCH) return '查看匹配要求'
  return hasReport.value ? '重新上传分析' : '上传报告'
})

function moneyText(value) {
	const n = strictNonNegativeNumberOrNull(value)
  if (n == null || Math.abs(n) < 0.5) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 10000) return `${sign}¥ ${(abs / 10000).toFixed(abs >= 100000 ? 0 : 1)}万`
  return `${sign}¥ ${groupThousands(abs)}`
}
function moneyOrZeroText(value, known = false) {
	const n = strictNonNegativeNumberOrNull(value)
  if (n == null) return '—'
  if (Math.abs(n) < 0.5) return known ? '¥ 0' : '—'
  return moneyText(n)
}

function debtCountText(item) {
	if (!item) return '账户数待核对'
  if (item.countLabel) return item.countLabel
	if (item.countKnown !== true) return '账户数待核对'
  if (item.count > 0) return `${item.count} 个账户`
  if (item.review) return '机构待核对'
	return '0 个账户'
}

const createPageSelectorQuery = () => {
  const query = uni.createSelectorQuery()
  const proxy = pageInstance && pageInstance.proxy
  return proxy && typeof query.in === 'function' ? query.in(proxy) : query
}
const scrollDomToAnchor = (id) => {
  try {
    if (typeof document === 'undefined') return false
    const target = document.getElementById(id)
    if (!target || typeof target.scrollIntoView !== 'function') return false
    target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' })
    return true
  } catch (e) {
    return false
  }
}
const nudgeScrollToAnchor = (id) => {
  try {
    const query = createPageSelectorQuery()
    query.select(`#${id}`).boundingClientRect()
    query.select('.scroll-body').boundingClientRect()
    query.exec((res = []) => {
      const targetTop = numberOrNull(res[0] && res[0].top)
      const scrollerTop = numberOrNull(res[1] && res[1].top) || 0
      if (targetTop == null) return
      const delta = targetTop - scrollerTop - 8
      if (Math.abs(delta) < 4) return
      const nextTop = Math.max(0, currentScrollTop.value + delta)
      mainScrollTop.value = Math.abs(nextTop - mainScrollTop.value) < 1 ? nextTop + 0.5 : nextTop
    })
  } catch (e) { /* selector fallback best effort */ }
}
const scrollTo = async (id) => {
  if (!navSections.value.some((item) => item.id === id)) return
  const now = Date.now()
  if (lastAnchorTap.value.id === id && now - lastAnchorTap.value.at < 150) return
  lastAnchorTap.value = { id, at: now }
  activeAnchor.value = id
  scrollAnchor.value = ''
  await nextTick()
  scrollAnchor.value = id
  setTimeout(() => scrollDomToAnchor(id), 40)
  setTimeout(() => nudgeScrollToAnchor(id), 180)
  setTimeout(() => {
    if (!scrollDomToAnchor(id)) nudgeScrollToAnchor(id)
  }, 420)
}
const normalizeReportSection = (value) => REPORT_SECTION_ALIASES[queryText(value).trim()] || 'sec-profile'
const applyRouteSelection = (query = {}) => {
  const section = normalizeReportSection(first(query.section, query.tab))
  const requestedAccountFilter = queryText(query.accountFilter).trim()
  const requestedQueryWindow = queryText(query.queryWindow).trim()
  if (ACCOUNT_FILTER_KEYS.has(requestedAccountFilter)) accountFilter.value = requestedAccountFilter
  if (QUERY_WINDOW_KEYS.has(requestedQueryWindow)) activeQueryWindow.value = requestedQueryWindow
  activeAnchor.value = section
  scrollAnchor.value = section === 'sec-profile' ? 'sec-profile' : ''
  if (section === 'sec-profile') return
  nextTick(() => {
    scrollAnchor.value = section
    setTimeout(() => scrollDomToAnchor(section), 40)
    setTimeout(() => nudgeScrollToAnchor(section), 180)
  })
}
const hasBackStack = () => {
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (Array.isArray(pages) && pages.length > 1) return true
  } catch (e) { /* ignore */ }
  try { return typeof window !== 'undefined' && window.history && window.history.length > 1 } catch (e) { return false }
}
const goHome = () => safeSwitchTab('/pages/home/home')
const goMessageCenter = () => safeSwitchTab('/pages/message/center')
const refreshMessageRouteContext = () => {
  if (!isMessageRoute.value) {
    messageRouteContext.value = null
    messageHandled.value = false
    messageLandedRecorded.value = false
    return
  }
  const state = readMessageCenterViewState()
  const messageId = routeMessageId.value || state.sourceMessageId || ''
  messageRouteContext.value = {
    ...state,
    sourceMessageId: messageId,
    sourceFocus: routeFocus.value || state.sourceFocus || 'report',
    reportId: currentReportId.value || routeReportId.value || state.reportId || ''
  }
}
const syncReportMessageReceipt = (receipt) => {
  if (receipt) syncMessageActionReceipt(receipt, saveMessageActionReceiptRemote).catch(() => {})
}
const saveReportMessageReceipt = (stage) => {
  const state = messageRouteContext.value || readMessageCenterViewState()
  const messageId = routeMessageId.value || state.sourceMessageId || ''
  if (!messageId) return null
  const reportId = currentReportId.value || routeReportId.value || state.reportId || ''
  const focus = routeFocus.value || state.sourceFocus || 'report-detail'
  const receipt = saveMessageActionReceipt({
    id: messageId,
    category: state.sourceCategory || 'system',
    title: state.sourceTitle || '信用报告消息',
    reportId,
    actionUrl: state.actionUrl || ''
  }, { stage, page: '/pages/report/detail', focus, reportId, at: new Date().toISOString() })
  saveMessageCenterViewState({
    sourceMessageId: messageId,
    sourceTitle: state.sourceTitle || '信用报告消息',
    sourceCategory: state.sourceCategory || 'system',
    sourceDebt: !!state.sourceDebt,
    sourceFocus: focus,
    reportId,
    actionUrl: state.actionUrl || '',
    returnedAt: ''
  })
  return receipt
}
const markMessageLanded = () => {
  if (!isMessageRoute.value || messageLandedRecorded.value) return
  const receipt = saveReportMessageReceipt('landed')
  if (!receipt) return
  messageLandedRecorded.value = true
  syncReportMessageReceipt(receipt)
}
const markMessageHandled = () => {
  if (!isMessageRoute.value) return
  const receipt = saveReportMessageReceipt('handled')
  if (!receipt) {
    uni.showToast({ title: '缺少消息来源，暂无法记录', icon: 'none' })
    return
  }
  messageHandled.value = true
  syncReportMessageReceipt(receipt)
  uni.showToast({ title: '已记录处理完成', icon: 'none' })
}
const currentMessageContext = (focus = '') => {
  if (!isMessageRoute.value) return null
  const state = messageRouteContext.value || readMessageCenterViewState()
  const messageId = routeMessageId.value || state.sourceMessageId || ''
  if (!messageId) return null
  return {
    messageId,
    sourceMessageId: messageId,
    sourceTitle: state.sourceTitle || '信用报告消息',
    sourceCategory: state.sourceCategory || 'system',
    sourceFocus: focus || routeFocus.value || state.sourceFocus || 'report',
    reportId: currentReportId.value || routeReportId.value || state.reportId || '',
    actionUrl: state.actionUrl || ''
  }
}
const messageRouteQuery = (focus = '') => {
  const context = currentMessageContext(focus)
  if (!context) return []
  return [
    'from=message',
    `messageId=${encodeURIComponent(context.messageId)}`,
    context.reportId ? `reportId=${encodeURIComponent(context.reportId)}` : '',
    context.sourceFocus ? `focus=${encodeURIComponent(context.sourceFocus)}` : ''
  ].filter(Boolean)
}
const goBack = () => {
  if (isMessageRoute.value) { goMessageCenter(); return }
  if (lastQuery.value && lastQuery.value.from === 'manage') { safeBack('/pages/report/manage'); return }
  if (lastQuery.value && lastQuery.value.from === 'debt') { safeBack('/pages/profile/debt-manage'); return }
  if (lastQuery.value && lastQuery.value.from === 'advisor') { safeBack('/pages/profile/advisor'); return }
  safeBack('/pages/home/home')
}
const openReportManage = () => uni.navigateTo({ url: '/pages/report/manage', fail: () => { uni.showToast({ title: '无法打开报告管理页', icon: 'none' }) } })
const goReportManage = () => {
  if (lastQuery.value && lastQuery.value.from === 'manage' && hasBackStack()) {
    uni.navigateBack({ fail: openReportManage })
    return
  }
  openReportManage()
}
const goUpload = () => uni.navigateTo({ url: '/pages/report/upload', fail: () => { uni.showToast({ title: '无法打开上传页', icon: 'none' }) } })
const waitForExportFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => resolve())
    return
  }
  setTimeout(resolve, 16)
})
const waitForExportLayout = async () => {
  await nextTick()
  try {
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) await document.fonts.ready
  } catch (e) { /* font readiness is best effort */ }
  await waitForExportFrame()
  await waitForExportFrame()
}
const resolveReportExportRoot = () => {
  const target = reportExportRoot.value
  if (!target) return null
  return target.$el || target
}
const restoreReportExportState = async (snapshot) => {
  exportMode.value = false
  activeAnchor.value = snapshot.activeAnchor
  scrollAnchor.value = snapshot.scrollAnchor
  mainScrollTop.value = snapshot.mainScrollTop
  currentScrollTop.value = snapshot.currentScrollTop
  accountLimit.value = snapshot.accountLimit
  riskHitLimit.value = snapshot.riskHitLimit
  queryRowLimit.value = snapshot.queryRowLimit
  activeQueryWindow.value = snapshot.activeQueryWindow
  queryKindFilter.value = snapshot.queryKindFilter
  accountFilter.value = snapshot.accountFilter
  riskDropdownOpen.value = snapshot.riskDropdownOpen
  completenessExpanded.value = snapshot.completenessExpanded
  scoreBasisExpanded.value = snapshot.scoreBasisExpanded
  await nextTick()
}
const runReportExport = async (format) => {
  if (exporting.value || !hasReport.value || missingDetail.value) return
  const requestedId = requestedReportIdOf(lastQuery.value)
  const activeId = String(currentReportId.value || (currentReport.value && currentReport.value.id) || '')
  if (requestedId && activeId !== requestedId) {
    uni.showToast({ title: '报告归属校验失败，请返回报告管理重新打开', icon: 'none' })
    return
  }
  if (typeof document === 'undefined') {
    uni.showToast({ title: '当前设备暂不支持报告下载', icon: 'none' })
    return
  }

  const snapshot = {
    activeAnchor: activeAnchor.value,
    scrollAnchor: scrollAnchor.value,
    mainScrollTop: mainScrollTop.value,
    currentScrollTop: currentScrollTop.value,
    accountLimit: accountLimit.value,
    riskHitLimit: riskHitLimit.value,
    queryRowLimit: queryRowLimit.value,
    activeQueryWindow: activeQueryWindow.value,
    queryKindFilter: queryKindFilter.value,
    accountFilter: accountFilter.value,
    riskDropdownOpen: riskDropdownOpen.value,
    completenessExpanded: completenessExpanded.value,
    scoreBasisExpanded: scoreBasisExpanded.value
  }
  const selected = REPORT_EXPORT_FORMATS.find((item) => item.key === format)
  let exported = null
  let exportError = null

  exporting.value = true
  uni.showLoading({ title: '正在生成完整报告', mask: true })
  try {
    activeAnchor.value = 'sec-profile'
    scrollAnchor.value = ''
    mainScrollTop.value = 0
    currentScrollTop.value = 0
    exportMode.value = true
    activeQueryWindow.value = '12m'
    queryKindFilter.value = 'all'
    accountFilter.value = 'all'
    riskDropdownOpen.value = false
    completenessExpanded.value = true
    scoreBasisExpanded.value = true
    accountLimit.value = Math.max(accountLimit.value, filteredAccounts.value.length)
    riskHitLimit.value = Math.max(riskHitLimit.value, filteredRiskHits.value.length)
    queryRowLimit.value = Math.max(queryRowLimit.value, filteredQueryDetailSource.value.length)
    await waitForExportLayout()

    const root = resolveReportExportRoot()
    if (!root || typeof root.getBoundingClientRect !== 'function') throw new Error('未找到可导出的报告内容')
    const safeDate = String(displayReportDate.value || '').replace(/[^\d-]/g, '')
    exported = await exportReportElement(root, {
      format,
      fileBaseName: `分析报告工作台-信用分析报告${safeDate ? `-${safeDate}` : ''}`,
      // 标识由 reportExport.js 以纯文字绘制，显式传 null 表示不使用图片 Logo
      logoUrl: null
    })
  } catch (e) {
    exportError = e
  } finally {
    await restoreReportExportState(snapshot)
    exporting.value = false
    uni.hideLoading()
  }

  if (exportError) {
    uni.showToast({ title: exportError.message || '报告生成失败，请重试', icon: 'none' })
    return
  }
  uni.showToast({ title: `${selected ? selected.label : '报告'}已下载`, icon: 'none' })
  return exported
}
const chooseReportExport = () => {
  if (exporting.value) return
  const sheetRequest = uni.showActionSheet({
    title: '下载完整报告',
    itemList: REPORT_EXPORT_FORMATS.map((item) => item.label),
    success: ({ tapIndex }) => {
      const selected = REPORT_EXPORT_FORMATS[Number(tapIndex)]
      if (selected) runReportExport(selected.key)
    }
  })
  if (sheetRequest && typeof sheetRequest.catch === 'function') {
    sheetRequest.catch(() => { /* closing the format picker is not an error */ })
  }
}
const goAdvisor = () => {
  const query = messageRouteQuery('advisor')
  const suffix = query.length ? `?${query.join('&')}` : ''
  uni.navigateTo({ url: `/pages/profile/advisor${suffix}`, fail: () => { uni.showToast({ title: '功能即将上线', icon: 'none' }) } })
}
const goDebtManage = () => {
  const query = isMessageRoute.value ? messageRouteQuery('debt-manage') : []
  if (!query.length && currentReportId.value) {
    query.push(`reportId=${encodeURIComponent(currentReportId.value)}`)
    query.push('from=detail')
  }
  const suffix = query.length ? `?${query.join('&')}` : ''
  uni.navigateTo({ url: `/pages/profile/debt-manage${suffix}`, fail: () => { uni.showToast({ title: '无法打开债务管理页', icon: 'none' }) } })
}
const goMatch = () => {
  if (currentReport.value && currentReportId.value) {
    saveMatchReportContext(currentReport.value, isMessageRoute.value ? 'message-detail' : 'detail', { messageContext: currentMessageContext('match') })
  }
  safeSwitchTab('/pages/match/index')
}
const runPrimaryAction = () => {
  if (actionKey.value === ACTION_KEYS.MATCH) { goMatch(); return }
  if (actionKey.value === ACTION_KEYS.UPLOAD) { goUpload(); return }
  goAdvisor()
}
const openContextReport = (direction) => {
  const target = direction === 'prev' ? prevManageContextItem.value : nextManageContextItem.value
  if (!target || !target.id) {
    uni.showToast({ title: direction === 'prev' ? '已经是第一份' : '已经是最后一份', icon: 'none' })
    return
  }
  const nextQuery = { id: target.id, from: 'manage' }
  lastQuery.value = nextQuery
  activeAnchor.value = 'sec-profile'
  scrollAnchor.value = 'sec-profile'
  mainScrollTop.value = 0
  currentScrollTop.value = 0
  accountLimit.value = 8
  void load(nextQuery)
  uni.showToast({ title: direction === 'prev' ? '已切到上一份' : '已切到下一份', icon: 'none' })
}

const resetInteractiveState = () => {
  accountLimit.value = 8
  riskHitLimit.value = 8
  activeRiskBucket.value = ''
  riskDropdownOpen.value = false
  activeDebtKey.value = ''
  activeQueryWindow.value = '6m'
  queryRowLimit.value = 8
  queryKindFilter.value = 'all'
  accountFilter.value = 'all'
  scoreBasisExpanded.value = false
  activeAnchor.value = 'sec-profile'
  scrollAnchor.value = 'sec-profile'
  mainScrollTop.value = 0
  currentScrollTop.value = 0
}

const handleReportSyncUpdated = async (payload = {}) => {
  const changedId = String(payload.reportId || '')
  const activeId = String(currentReportId.value || routeReportId.value || '')
  if (!changedId || !activeId || changedId !== activeId) return
  const refreshed = await getReportAsync(changedId)
  if (refreshed) currentReport.value = refreshed
}

const requestedReportIdOf = (query = {}) => queryText(first(query && query.id, query && query.reportId)).trim()
let reportLoadRevision = 0
const load = async (query) => {
	const revision = ++reportLoadRevision
  const id = requestedReportIdOf(query)
  const report = id ? await getReportAsync(id) : await getLatestReportAsync()
	if (revision !== reportLoadRevision) return
  if (!report) {
    hasReport.value = false
    missingDetail.value = false
    missingReport.value = null
    requestedReportMissing.value = Boolean(id)
    currentReport.value = null
    currentReportId.value = ''
    raw.value = null
    norm.value = null
		uploadDate.value = ''
    return
  }
  if (!hasMeaningfulAnalysisData(report.analysisData)) {
    hasReport.value = false
    missingDetail.value = true
    missingReport.value = report
    requestedReportMissing.value = false
    currentReport.value = report
    currentReportId.value = String(report.id || id || '')
    raw.value = null
    norm.value = null
    reportType.value = report.reportType || '信用报告'
		uploadDate.value = getReportUploadDate(report)
    return
  }
  hasReport.value = true
  missingDetail.value = false
  missingReport.value = null
  requestedReportMissing.value = false
  currentReport.value = report
  currentReportId.value = String(report.id || id || '')
  raw.value = report.analysisData
  norm.value = normalizeReportData(report.analysisData, report.decisionTrust || null, decisionReportIdOf(report))
  resetInteractiveState()
  reportType.value = report.reportType || report.analysisData.reportFormat?.source || '信用报告'
	uploadDate.value = getReportUploadDate(report)
  applyRouteSelection(query || {})
}

onLoad((query) => {
  if (typeof uni !== 'undefined' && typeof uni.$off === 'function') uni.$off(REPORT_SYNC_UPDATED_EVENT, handleReportSyncUpdated)
  if (typeof uni !== 'undefined' && typeof uni.$on === 'function') uni.$on(REPORT_SYNC_UPDATED_EVENT, handleReportSyncUpdated)
  lastQuery.value = query || {}
  messageHandled.value = false
  messageLandedRecorded.value = false
  refreshReportManageContext()
  void load(lastQuery.value)
  refreshMessageRouteContext()
  markMessageLanded()
})

onUnload(() => {
  if (typeof uni !== 'undefined' && typeof uni.$off === 'function') uni.$off(REPORT_SYNC_UPDATED_EVENT, handleReportSyncUpdated)
})
onShow(() => {
  refreshReportManageContext()
  if (hasReport.value || missingDetail.value || lastQuery.value) void load(lastQuery.value)
  refreshMessageRouteContext()
  markMessageLanded()
})
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; padding-bottom: calc(72px + var(--rpt-safe-bottom)); }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #111827; }
.nav-actions { width: 92px; flex-direction: row; align-items: center; justify-content: flex-end; }
.nav-action { margin-left: 12px; text-align: right; font-size: 13px; font-weight: 800; color: #086CEA; }
.nav-action.muted { color: #64748B; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 14px 14px 0; }
.wrap.report-export-mode {
  width: 794px !important;
  max-width: none !important;
  padding: 24px 24px 0;
  background: #F5F8FE;
}
.wrap.report-export-mode .bottom-safe { display: none; }

.empty { align-items: center; padding: 80px 24px; }
.empty-title { font-size: 18px; font-weight: 800; color: #111827; }
.empty-sub { margin-top: 10px; font-size: 13px; color: #9CA3AF; text-align: center; line-height: 1.6; }
.empty-btn { margin-top: 24px; background: #086CEA; border-radius: 8px; padding: 12px 40px; box-shadow: 0 10px 22px rgba(8,108,234,0.14); }
.empty-btn-text { color: #fff; font-size: 15px; font-weight: 800; }
.missing-detail { padding-top: 64px; }
.missing-meta { margin-top: 14px; background: #F8FAFC; border: 1px solid #EEF0F4; border-radius: 8px; padding: 9px 12px; }
.missing-meta-text { font-size: 12px; color: #64748B; text-align: center; }
.empty-link { margin-top: 14px; padding: 8px 16px; }
.empty-link-text { color: #086CEA; font-size: 13px; font-weight: 800; }

.hero-card,
.section-card,
.snapshot-card,
.quick-actions-card,
.conversion-card,
.source-notice,
	.manage-context-card,
	.message-detail-card,
	.interpretation-card,
	.notice-card,
	.completeness-card { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; margin-bottom: 12px; }

.hero-card { padding: 17px; }
.hero-head { flex-direction: row; align-items: center; }
.avatar { width: 42px; height: 42px; border-radius: 21px; background: #EAF3FF; align-items: center; justify-content: center; border: 1px solid #BFDBFE; }
.avatar-text { color: #086CEA; font-size: 18px; font-weight: 900; }
.hero-user { flex: 1; margin-left: 10px; }
.hero-name { font-size: 17px; color: #111827; font-weight: 900; }
.hero-meta { margin-top: 3px; color: #9CA3AF; font-size: 12px; }
.risk-badge { border-radius: 8px; padding: 5px 9px; }
.risk-badge-text { font-size: 12px; font-weight: 900; }
.hero-main { flex-direction: row; align-items: center; margin-top: 18px; }
.score-ring { width: 98px; height: 98px; border-radius: 49px; border-width: 7px; border-style: solid; align-items: center; justify-content: center; flex-direction: row; margin-right: 16px; }
.score-num { font-size: 34px; font-weight: 900; }
.score-unit { font-size: 13px; color: #9CA3AF; margin-top: 12px; margin-left: 2px; }
.score-copy { flex: 1; }
.score-kicker { font-size: 12px; color: #6B7280; font-weight: 700; margin-bottom: 4px; }
.score-title { font-size: 18px; color: #111827; font-weight: 900; }
.score-sub { margin-top: 7px; font-size: 13px; color: #4B5563; line-height: 1.55; }
.mini-tags { flex-direction: row; flex-wrap: wrap; margin-top: 10px; }
.mini-tag { background: #F8FAFC; border-radius: 8px; padding: 5px 8px; margin-right: 6px; margin-bottom: 6px; }
.mini-tag-text { font-size: 11px; color: #64748B; font-weight: 700; }
.hero-score-basis { margin-top: 14px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; overflow: hidden; }
.hero-score-basis-toggle { min-height: 44px; padding: 10px 11px; flex-direction: row; align-items: center; }
.hero-score-basis-title-wrap { flex: 1; min-width: 0; flex-direction: row; align-items: center; flex-wrap: wrap; }
.hero-score-basis-title { font-size: 13px; color: #111827; font-weight: 900; }
.hero-score-basis-tag { margin-left: 7px; padding: 2px 6px; border-radius: 6px; background: #EAF3FF; color: #086CEA; font-size: 10px; font-weight: 900; }
.hero-score-basis-action,
.risk-select-action {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  color: #086CEA;
}
.hero-score-basis-action { margin-left: 8px; }
.hero-score-basis-action-text,
.risk-select-action-text { font-size: 11px; line-height: 1; font-weight: 900; }
.report-inline-chevron {
  width: 16px;
  height: 16px;
  margin-left: 6px;
  transform-origin: center;
  transition: transform .18s ease;
}
.report-inline-chevron-open { transform: rotate(180deg); }
.hero-score-basis-panel { padding: 0 11px 11px; border-top: 1px dashed #D7E3F1; }
.hero-score-basis-desc { padding-top: 10px; font-size: 12px; color: #4B5563; line-height: 1.55; }
.hero-score-basis-warning { margin-top: 8px; padding: 7px 8px; border-radius: 6px; background: #FFF7ED; color: #C2410C; font-size: 11px; line-height: 1.5; font-weight: 700; }
.hero-score-basis-grid { margin-top: 9px; flex-direction: row; flex-wrap: wrap; margin-left: -3px; margin-right: -3px; }
.hero-score-basis-cell { width: 50%; padding: 5px 3px; }
.hero-score-basis-value { font-size: 14px; color: #111827; font-weight: 900; }
.hero-score-basis-label { margin-top: 2px; font-size: 10px; color: #7A8699; }
.hero-score-dimensions { margin-top: 7px; padding-top: 7px; border-top: 1px solid #E9EEF5; }
.hero-score-dimensions-title,
.hero-score-rules-title { margin-bottom: 4px; font-size: 10px; color: #7A8699; font-weight: 900; }
.hero-score-dimension { min-height: 26px; flex-direction: row; align-items: center; justify-content: space-between; }
.hero-score-dimension-label { font-size: 11px; color: #64748B; }
.hero-score-dimension-value { font-size: 11px; color: #111827; font-weight: 900; }
.hero-score-rules { margin-top: 7px; padding-top: 7px; border-top: 1px solid #E9EEF5; }
.hero-score-rule { min-height: 28px; flex-direction: row; align-items: center; justify-content: space-between; }
.hero-score-rule-label { flex: 1; min-width: 0; margin-right: 10px; font-size: 11px; color: #4B5563; line-height: 1.4; }
.hero-score-rule-value { font-size: 11px; color: #DC2626; font-weight: 900; }
.hero-score-rule-note { margin-top: 5px; font-size: 10px; color: #7A8699; line-height: 1.45; }
.hero-stats { flex-direction: row; margin-top: 16px; padding-top: 14px; border-top: 1px solid #F3F4F6; }
.hero-stat { flex: 1; align-items: center; }
.hero-stat-value { font-size: 21px; color: #111827; font-weight: 900; }
.hero-stat-value.danger { color: #DC2626; }
.hero-stat-value.warn { color: #D97706; }
.hero-stat-label { margin-top: 4px; font-size: 11px; color: #9CA3AF; }

.anchor-scroll { margin: -2px -14px 12px; white-space: nowrap; overflow: visible; }
.anchor-row { width: 100%; box-sizing: border-box; flex-direction: row; align-items: center; padding: 2px 14px 4px; }
.anchor-chip { flex: 1; min-width: 0; height: 36px; border-radius: 8px; background: #fff; border: 1px solid #E5E7EB; margin-right: 6px; align-items: center; justify-content: center; }
.anchor-chip:last-child { margin-right: 0; }
.anchor-chip-active { background: #086CEA; border-color: #086CEA; box-shadow: 0 8px 18px rgba(8,108,234,0.12); }
.anchor-chip-press { opacity: 0.78; transform: scale(0.98); }
.anchor-chip-text { font-size: 13px; line-height: 36px; color: #4B5563; font-weight: 900; text-align: center; }
.anchor-chip-text-active { color: #fff; }

.source-notice { padding: 12px 13px; flex-direction: row; align-items: center; }
.source-restored { border-color: #BBF7D0; background: #F0FDF4; }
.source-cloud { border-color: #BFDBFE; background: #EFF6FF; }
.source-syncing { border-color: #BFDBFE; background: #EFF6FF; }
.source-failed { border-color: #FDE68A; background: #FFFBEB; }
.source-local { border-color: #E5E7EB; background: #F8FAFC; }
.source-notice-main { flex: 1; margin-right: 10px; }
.source-notice-title { font-size: 14px; color: #111827; font-weight: 900; }
.source-notice-sub { margin-top: 4px; font-size: 12px; color: #64748B; line-height: 1.45; }
.source-notice-tag { font-size: 12px; color: #374151; font-weight: 900; background: rgba(255,255,255,0.72); border-radius: 8px; padding: 5px 8px; }

.manage-context-card { padding: 12px 13px; }
.manage-context-head { flex-direction: row; align-items: center; }
.manage-context-main { flex: 1; margin-right: 10px; }
.manage-context-title { font-size: 14px; color: #111827; font-weight: 900; }
.manage-context-sub { margin-top: 4px; font-size: 12px; color: #64748B; line-height: 1.45; }
.manage-context-tag { font-size: 12px; color: #086CEA; font-weight: 900; background: #EAF3FF; border-radius: 8px; padding: 5px 8px; }
.manage-context-actions { flex-direction: row; margin-top: 10px; }
.manage-context-btn { flex: 1; height: 34px; border-radius: 8px; background: #111827; align-items: center; justify-content: center; margin-right: 8px; }
.manage-context-btn:last-child { margin-right: 0; }
.manage-context-btn.disabled { background: #F8FAFC; border: 1px solid #E5E7EB; }
.manage-context-btn-text { font-size: 12px; color: #fff; font-weight: 900; }
.manage-context-btn-text.disabled { color: #9CA3AF; }

.message-detail-card { padding: 12px 13px; background: #111827; border-color: #111827; }
.message-detail-head { flex-direction: row; align-items: center; }
.message-detail-main { flex: 1; margin-right: 10px; }
.message-detail-title { font-size: 14px; color: #fff; font-weight: 900; }
.message-detail-sub { margin-top: 4px; font-size: 12px; color: #CBD5E1; line-height: 1.45; }
.message-detail-tag { font-size: 12px; color: #FDE68A; font-weight: 900; background: rgba(255,255,255,0.08); border-radius: 8px; padding: 5px 8px; }
.message-detail-actions { flex-direction: row; margin-top: 10px; }
.message-detail-primary,
.message-detail-ghost { flex: 1; height: 34px; border-radius: 8px; align-items: center; justify-content: center; }
.message-detail-primary { background: #fff; margin-right: 8px; }
.message-detail-ghost { border: 1px solid rgba(255,255,255,0.24); }
.message-detail-ghost.done { border-color: rgba(134,239,172,0.65); background: rgba(22,163,74,0.16); }
.message-detail-primary-text { font-size: 12px; color: #111827; font-weight: 900; }
.message-detail-ghost-text { font-size: 12px; color: #fff; font-weight: 900; }
.message-detail-ghost-text.done { color: #BBF7D0; }

.notice-card { padding: 14px; flex-direction: row; align-items: center; }
.notice-main { flex: 1; margin-right: 10px; }
.notice-title { font-size: 14px; color: #111827; font-weight: 900; }
.notice-sub { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.notice-hint { margin-top: 5px; font-size: 11px; color: #9CA3AF; line-height: 1.35; }
.notice-side { align-items: flex-end; }
.notice-score { font-size: 18px; font-weight: 900; }
.notice-toggle { margin-top: 5px; font-size: 11px; color: #086CEA; font-weight: 900; }
.completeness-card { overflow: hidden; }
.completeness-head { margin: 0; border: 0; }
.completeness-panel { padding: 0 14px 14px; border-top: 1px dashed #DCEBFF; }
.completeness-row { flex-direction: row; align-items: flex-start; padding: 11px 0; border-bottom: 1px solid #F7F8FA; }
.completeness-row:last-child { border-bottom: 0; }
.completeness-mark { width: 22px; height: 22px; border-radius: 11px; text-align: center; line-height: 22px; font-size: 12px; font-weight: 900; margin-right: 10px; color: #fff; }
.completeness-mark.ok { background: #16A34A; }
.completeness-mark.miss { background: #D97706; }
.completeness-row-main { flex: 1; }
.completeness-row-title-wrap { flex-direction: row; align-items: center; }
.completeness-row-title { flex: 1; font-size: 13px; color: #111827; font-weight: 900; }
.completeness-row-tag { font-size: 10px; color: #086CEA; background: #EAF3FF; border-radius: 6px; padding: 2px 6px; margin-left: 8px; font-weight: 900; }
.completeness-row-detail { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.completeness-notes { margin-top: 10px; padding: 10px; background: #FFFBEB; border-radius: 8px; }
	.completeness-notes-title { font-size: 12px; color: #92400E; font-weight: 900; }
	.completeness-note { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.45; }

	.interpretation-card { padding: 15px; border-color: #DCEBFF; background: #FBFDFF; }
	.interpretation-head { flex-direction: row; align-items: center; }
	.interpretation-title-wrap { flex: 1; margin-right: 10px; }
	.interpretation-kicker { font-size: 11px; color: #086CEA; font-weight: 900; }
	.interpretation-title { margin-top: 4px; font-size: 16px; color: #111827; font-weight: 900; }
	.interpretation-tag { font-size: 11px; color: #086CEA; font-weight: 900; background: #EAF3FF; border-radius: 8px; padding: 5px 8px; }
	.interpretation-headline { margin-top: 10px; font-size: 13px; color: #374151; line-height: 1.55; }
	.interpretation-grid { flex-direction: row; flex-wrap: wrap; margin-top: 10px; margin-left: -4px; margin-right: -4px; }
	.interpretation-cell { width: 50%; padding: 7px 4px; }
	.interpretation-value { font-size: 17px; color: #111827; font-weight: 900; }
	.interpretation-value.warn { color: #D97706; }
	.interpretation-label { margin-top: 3px; font-size: 11px; color: #6B7280; font-weight: 800; }
	.interpretation-sub { margin-top: 3px; font-size: 10px; color: #9CA3AF; line-height: 1.35; }
	.interpretation-points { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #DCEBFF; }
	.interpretation-point { flex-direction: row; align-items: flex-start; padding: 7px 0; }
	.interpretation-dot { width: 8px; height: 8px; border-radius: 4px; margin-top: 5px; margin-right: 9px; }
	.interpretation-dot.high { background: #DC2626; }
	.interpretation-dot.warn { background: #D97706; }
	.interpretation-dot.info { background: #16A34A; }
	.interpretation-point-main { flex: 1; }
	.interpretation-point-title { font-size: 13px; color: #111827; font-weight: 900; }
	.interpretation-point-detail { margin-top: 3px; font-size: 12px; color: #64748B; line-height: 1.45; }
	.interpretation-actions { margin-top: 8px; padding: 9px 10px; border-radius: 8px; background: #F8FAFC; }
	.interpretation-action { font-size: 12px; color: #4B5563; line-height: 1.55; }

	.section-card,
.snapshot-card { padding: 15px; }
.section-head { flex-direction: row; align-items: flex-start; justify-content: space-between; margin-bottom: 13px; }
.section-head.compact { margin-bottom: 10px; }
.section-title { font-size: 16px; color: #111827; font-weight: 900; }
.section-sub { margin-top: 3px; font-size: 12px; color: #9CA3AF; }
.section-count { font-size: 12px; color: #64748B; font-weight: 800; background: #F8FAFC; border-radius: 8px; padding: 5px 8px; }

.risk-select-wrap { position: relative; }
.risk-select { min-height: 52px; border-radius: 8px; padding: 9px 11px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; }
.risk-select-main { flex: 1; min-width: 0; flex-direction: row; align-items: center; }
.risk-select-dot { width: 10px; height: 10px; border-radius: 5px; margin-right: 9px; flex-shrink: 0; }
.risk-select-dot-high { background: #DC2626; }
.risk-select-dot-warn { background: #D97706; }
.risk-select-dot-info { background: #16A34A; }
.risk-select-label { font-size: 14px; color: #111827; font-weight: 900; }
.risk-select-hint { margin-top: 2px; font-size: 10px; color: #7A8699; }
.risk-select-action { margin-left: 10px; }
.risk-select-menu { margin-top: 6px; border-radius: 8px; background: #fff; border: 1px solid #DCE6F2; padding: 4px; box-shadow: 0 12px 28px rgba(15,42,87,0.10); }
.risk-select-option { min-height: 40px; border-radius: 7px; padding: 8px 9px; flex-direction: row; align-items: center; }
.risk-select-option.active { background: #EFF6FF; }
.risk-select-option-label { flex: 1; font-size: 12px; color: #374151; font-weight: 900; }
.risk-select-option-count { font-size: 11px; color: #64748B; }
.risk-select-check { margin-left: 8px; font-size: 12px; color: #086CEA; font-weight: 900; }
.risk-filter-panel { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #DCEBFF; }
.risk-filter-head { flex-direction: row; align-items: center; margin-bottom: 8px; }
.risk-filter-title { flex: 1; font-size: 13px; color: #111827; font-weight: 900; }
.risk-filter-count { font-size: 11px; color: #64748B; font-weight: 800; }
.risk-filter-row { margin-bottom: 8px; }
.risk-filter-row:last-child { margin-bottom: 0; }
.filter-row { flex-direction: row; flex-wrap: wrap; margin-bottom: 10px; }
.risk-more-btn { padding-top: 4px; padding-bottom: 6px; }
.filter-chip { min-height: 32px; border-radius: 8px; padding: 7px 10px; margin-right: 8px; margin-bottom: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; align-items: center; justify-content: center; }
.filter-chip.active { background: #086CEA; border-color: #086CEA; box-shadow: 0 8px 18px rgba(8,108,234,0.10); }
.filter-chip-text { font-size: 12px; color: #4B5563; font-weight: 900; }
.filter-chip-text.active { color: #fff; }
.account-filter-row { margin-bottom: 2px; }
.account-filter-row .filter-chip { margin-bottom: 6px; }
.account-summary-grid { flex-direction: row; margin-bottom: 10px; padding: 9px 8px; border-radius: 8px; background: #F8FAFC; border: 1px solid #EEF0F4; }
.account-summary-cell { flex: 1; padding: 2px 4px; }
.account-summary-value { font-size: 14px; color: #111827; font-weight: 900; }
.account-summary-label { margin-top: 3px; font-size: 10px; color: #9CA3AF; }
.account-notice { margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; }
.account-notice-text { font-size: 11px; color: #92400E; line-height: 1.45; }
.profile-grid,
.query-matrix { flex-direction: row; flex-wrap: wrap; }
.profile-cell { width: 50%; padding: 8px 4px 10px; }
.profile-value { font-size: 18px; color: #111827; font-weight: 900; }
.profile-value.warn { color: #D97706; }
.profile-label { margin-top: 4px; font-size: 12px; color: #9CA3AF; }
.profile-sub { margin-top: 3px; font-size: 10px; color: #64748B; line-height: 1.35; }
.profile-notice { margin-top: 6px; padding: 9px 10px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; }
.profile-notice-text { font-size: 11px; color: #92400E; line-height: 1.45; }

.conversion-card { padding: 15px; flex-direction: row; align-items: center; }
.conversion-copy { flex: 1; margin-right: 12px; }
.conversion-kicker { font-size: 11px; color: #086CEA; font-weight: 900; }
.conversion-title { margin-top: 5px; font-size: 16px; color: #111827; font-weight: 900; }
.conversion-sub { margin-top: 5px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.conversion-btn { background: #086CEA; border-radius: 8px; padding: 10px 16px; box-shadow: 0 10px 22px rgba(8,108,234,0.14); }
.conversion-btn-text { color: #fff; font-size: 13px; font-weight: 900; }

.quick-actions-card { padding: 12px 8px; flex-direction: row; }
.quick-action { flex: 1; align-items: center; padding: 4px 3px; }
.quick-icon { width: 30px; height: 30px; border-radius: 8px; background: #EAF3FF; color: #086CEA; font-size: 13px; font-weight: 900; text-align: center; line-height: 30px; border: 1px solid #BFDBFE; }
.quick-icon.blue { background: #F8FAFC; color: #374151; border: 1px solid #E5E7EB; }
.quick-icon.green { background: #F0FDF4; color: #16A34A; }
.quick-title { margin-top: 7px; font-size: 13px; color: #111827; font-weight: 900; }
.quick-sub { margin-top: 2px; font-size: 10px; color: #9CA3AF; text-align: center; }

.score-basis-panel { margin-bottom: 10px; padding: 11px 12px; border-radius: 8px; background: #F8FAFC; border: 1px solid #EEF0F4; }
.score-basis-head { flex-direction: row; align-items: flex-start; }
.score-basis-main { flex: 1; padding-right: 10px; }
.score-basis-title { font-size: 13px; color: #111827; font-weight: 900; }
.score-basis-desc { margin-top: 4px; font-size: 11px; color: #6B7280; line-height: 1.45; }
.score-basis-tag { font-size: 11px; color: #086CEA; font-weight: 900; background: #EAF3FF; border-radius: 8px; padding: 4px 7px; }
.score-basis-grid { flex-direction: row; margin-top: 10px; }
.score-basis-cell { flex: 1; padding-right: 8px; }
.score-basis-value { font-size: 14px; color: #111827; font-weight: 900; }
.score-basis-label { margin-top: 2px; font-size: 10px; color: #9CA3AF; }
.dim-row { flex-direction: row; align-items: center; padding: 9px 0; border-top: 1px solid #F7F8FA; }
.dim-row:first-of-type,
.score-basis-panel + .dim-row { border-top: 0; }
.dim-name-wrap { width: 86px; }
.dim-name { font-size: 13px; color: #111827; font-weight: 900; }
.dim-hint { margin-top: 2px; font-size: 10px; color: #A3A8B0; }
.dim-bar-bg { flex: 1; height: 8px; border-radius: 4px; background: #F1F3F6; margin: 0 10px; overflow: hidden; }
.dim-bar { height: 8px; border-radius: 4px; }
.dim-val { width: 34px; text-align: right; font-size: 13px; font-weight: 900; color: #111827; }

.hit-card { border-radius: 8px; padding: 12px; margin-bottom: 9px; border: 1px solid #F3F4F6; }
.hit-card-high { background: #FEF2F2; border-color: #FECACA; }
.hit-card-warn { background: #FFFBEB; border-color: #FDE68A; }
.hit-card-info { background: #F8FAFC; }
.hit-head { flex-direction: row; align-items: center; }
.hit-level { font-size: 11px; font-weight: 900; color: #C62828; background: #fff; border-radius: 6px; padding: 3px 6px; margin-right: 8px; }
.hit-title { flex: 1; font-size: 14px; color: #111827; font-weight: 900; }
.hit-detail { margin-top: 8px; font-size: 12px; color: #4B5563; line-height: 1.55; }
.hit-rule { margin-top: 6px; font-size: 10px; color: #9CA3AF; }

.query-cell { width: 50%; padding: 8px 5px; border: 1px solid transparent; border-radius: 8px; }
.query-cell.active { background: #EAF3FF; border-color: #BFDBFE; }
.query-cell.active .query-label { color: #086CEA; }
.query-cell.active .query-sub { color: #1D4ED8; }
.debt-list { margin-top: 2px; }
.debt-row-card { padding: 10px 0; border-top: 1px solid #F3F4F6; }
.debt-row-card:first-child { border-top: 0; padding-top: 2px; }
.debt-row-card.review { background: #F8FAFC; border-radius: 8px; padding: 10px; margin-top: 8px; border-top: 0; }
.debt-row-card.active { background: #FFF7F7; border: 1px solid #F3D6D6; border-radius: 8px; padding: 10px; margin-top: 8px; }
.debt-row-card:first-child.active { padding-top: 10px; margin-top: 0; }
.debt-row-card.review.active { background: #F8FAFC; border-color: #CBD5E1; }
.debt-insight-card { margin-top: 10px; padding: 11px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; }
.debt-insight-main { flex: 1; margin-right: 10px; }
.debt-insight-title { font-size: 13px; color: #111827; font-weight: 900; }
.debt-insight-desc { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 1.45; }
.debt-insight-btn { border-radius: 8px; background: #111827; padding: 8px 10px; align-items: center; justify-content: center; }
.debt-insight-btn-text { font-size: 12px; color: #fff; font-weight: 900; }
.debt-row-top,
.debt-row-bottom { flex-direction: row; align-items: center; justify-content: space-between; }
.debt-cell-head { flex: 1; flex-direction: row; align-items: center; margin-right: 10px; }
.debt-color { width: 8px; height: 8px; border-radius: 4px; margin-right: 7px; }
.debt-name { font-size: 13px; color: #374151; font-weight: 900; }
.debt-share { font-size: 12px; color: #111827; font-weight: 900; }
.debt-bar-bg { height: 7px; border-radius: 4px; background: #F1F5F9; margin: 8px 0; overflow: hidden; }
.debt-bar { height: 7px; border-radius: 4px; }
.debt-amount { font-size: 16px; color: #111827; font-weight: 900; }
.debt-count { font-size: 11px; color: #9CA3AF; }
.debt-note { margin-top: 6px; font-size: 11px; color: #64748B; line-height: 1.45; }
.debt-calibration { margin-top: 8px; padding: 10px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; flex-direction: row; align-items: center; }
.debt-calibration-main { flex: 1; margin-right: 10px; }
.debt-calibration-title { font-size: 12px; color: #92400E; font-weight: 900; }
.debt-calibration-desc { margin-top: 4px; font-size: 11px; color: #92400E; line-height: 1.45; }
.debt-calibration-tag { font-size: 11px; color: #92400E; font-weight: 900; background: #FEF3C7; border-radius: 8px; padding: 4px 7px; }
.sub-panel { margin-top: 10px; padding-top: 10px; border-top: 1px solid #F3F4F6; }
.sub-head { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.sub-title { font-size: 13px; color: #111827; font-weight: 900; }
.sub-count { font-size: 11px; color: #9CA3AF; }
.overdue-row,
.query-row,
.account-row,
.plain-row { flex-direction: row; align-items: center; padding: 10px 0; border-top: 1px solid #F7F8FA; }
.overdue-main,
.query-main,
.account-main,
.plain-main { flex: 1; margin-right: 10px; }
.overdue-bank,
.query-org,
.account-name,
.plain-title { font-size: 13px; color: #111827; font-weight: 900; }
.overdue-desc,
.query-reason,
.account-type,
.plain-sub { margin-top: 3px; font-size: 11px; color: #9CA3AF; line-height: 1.4; }
.overdue-days { font-size: 12px; color: #DC2626; font-weight: 900; }

.query-value { font-size: 22px; color: #111827; font-weight: 900; }
.query-value.warn { color: #D97706; }
.query-cell.active .query-value { color: #086CEA; }
.query-label { margin-top: 3px; font-size: 12px; color: #4B5563; font-weight: 800; }
.query-sub { margin-top: 3px; font-size: 10px; color: #9CA3AF; }
.query-list { margin-top: 10px; padding-top: 10px; border-top: 1px solid #F3F4F6; }
.query-notice { margin-top: 10px; padding: 9px 10px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; }
.query-notice-text { font-size: 11px; color: #92400E; line-height: 1.45; }
.query-trend-scroll { margin-top: 10px; white-space: nowrap; }
.query-trend-row { flex-direction: row; align-items: flex-end; padding: 9px 0 2px; }
.query-trend-cell { width: 48px; margin-right: 8px; align-items: center; }
.query-trend-bars { height: 46px; width: 22px; flex-direction: row; align-items: flex-end; justify-content: center; }
.query-trend-bar { width: 9px; border-radius: 5px 5px 2px 2px; margin: 0 1px; }
.query-trend-bar.bank { background: #086CEA; }
.query-trend-bar.nonbank { background: #D97706; }
.query-trend-total { margin-top: 3px; font-size: 11px; color: #111827; font-weight: 900; }
.query-trend-month { margin-top: 2px; font-size: 10px; color: #9CA3AF; }
.query-highlight-panel { margin-top: 10px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; padding: 4px 10px; }
.query-highlight-row { flex-direction: row; align-items: center; padding: 8px 0; border-top: 1px solid #EEF0F4; }
.query-highlight-row:first-child { border-top: 0; }
.query-highlight-main { flex: 1; margin-right: 8px; }
.query-highlight-org { font-size: 12px; color: #111827; font-weight: 900; }
.query-highlight-sub { margin-top: 3px; font-size: 10px; color: #64748B; line-height: 1.35; }
.query-highlight-count { font-size: 12px; color: #086CEA; font-weight: 900; }
.query-filter-row { margin-top: 10px; margin-bottom: 0; }
.query-date { width: 78px; font-size: 12px; color: #64748B; font-weight: 800; }
.query-title-row { flex-direction: row; align-items: center; flex-wrap: wrap; }
.query-kind { margin-left: 7px; font-size: 10px; font-weight: 900; color: #166534; background: #F0FDF4; border-radius: 6px; padding: 2px 5px; }
.query-kind.nonbank { color: #92400E; background: #FEF3C7; }
.query-empty { margin-top: 10px; }
.query-more-btn { padding-top: 6px; padding-bottom: 4px; }
.self-query { margin-top: 8px; background: #F8FAFC; border-radius: 8px; padding: 9px 10px; }
.self-query-text { font-size: 12px; color: #64748B; line-height: 1.45; }

.plain-tag { font-size: 12px; color: #64748B; background: #F8FAFC; border-radius: 8px; padding: 5px 8px; font-weight: 800; }
.account-row.bad { background: #FFF7F7; border-radius: 8px; padding-left: 8px; padding-right: 8px; border-top-color: #FEE2E2; }
.account-row.attention { background: #FFFBEB; border-radius: 8px; padding-left: 8px; padding-right: 8px; border-top-color: #FDE68A; }
.account-title-row { flex-direction: row; align-items: center; flex-wrap: wrap; }
.account-tag { margin-left: 7px; font-size: 10px; font-weight: 900; border-radius: 6px; padding: 2px 5px; color: #64748B; background: #F1F5F9; }
.account-tag.loan { color: #086CEA; background: #EAF3FF; }
.account-tag.card { color: #166534; background: #F0FDF4; }
.account-kind { margin-left: 5px; font-size: 10px; font-weight: 800; border-radius: 6px; padding: 2px 5px; color: #64748B; background: #F8FAFC; border: 1px solid #E5E7EB; }
.account-alert { margin-left: 5px; font-size: 10px; font-weight: 900; border-radius: 6px; padding: 2px 5px; color: #92400E; background: #FEF3C7; }
.account-alert.muted { color: #7C2D12; background: #FFEDD5; }
.account-meta { margin-top: 3px; font-size: 11px; color: #64748B; line-height: 1.4; }
.account-right { align-items: flex-end; }
.account-amount { font-size: 14px; color: #111827; font-weight: 900; }
.account-status { margin-top: 3px; font-size: 11px; color: #16A34A; font-weight: 800; }
.account-status.bad { color: #DC2626; }
.account-status.settled { color: #64748B; }
.more-btn { align-items: center; padding-top: 12px; }
.more-btn-text { font-size: 13px; color: #086CEA; font-weight: 800; }

.plan-row { flex-direction: row; align-items: flex-start; padding: 11px 0; border-top: 1px solid #F7F8FA; }
.plan-row:first-of-type { border-top: 0; }
.plan-index { width: 24px; height: 24px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; margin-right: 10px; }
.plan-high { background: #FEF2F2; }
.plan-medium { background: #FFFBEB; }
.plan-low { background: #F0FDF4; }
.plan-index-text { font-size: 12px; color: #111827; font-weight: 900; }
.plan-main { flex: 1; }
.plan-title { font-size: 14px; color: #111827; font-weight: 900; }
.plan-desc { margin-top: 5px; font-size: 12px; color: #4B5563; line-height: 1.55; }
.plan-effect { margin-top: 5px; font-size: 11px; color: #086CEA; font-weight: 800; }
.ai-sug { font-size: 13px; color: #374151; line-height: 1.7; }
.soft-empty { background: #F8FAFC; border-radius: 8px; padding: 12px; }
.soft-empty-text { font-size: 12px; color: #64748B; line-height: 1.5; }

.disclaimer { padding: 4px 2px 12px; }
.disclaimer-text { font-size: 11px; color: #A3A8B0; line-height: 1.6; }
.bottom-safe { height: 78px; }

.footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 0 calc(10px + var(--rpt-safe-bottom)); background: rgba(255,255,255,0.97); border-top: 1px solid #EEF0F4; }
.footer-actions { padding: 0 14px; flex-direction: row; align-items: center; gap: 10px; }
.footer-export { width: auto; flex: 3 1 0; min-width: 112px; height: 44px; border-radius: 8px; background: #FFFFFF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; }
.footer-export-disabled { opacity: 0.58; }
.footer-export-text { color: #086CEA; font-size: 14px; font-weight: 900; }
.footer-primary { flex: 7 1 0; min-width: 0; height: 44px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; box-shadow: 0 10px 22px rgba(8,108,234,0.14); }
.footer-primary-text { color: #fff; font-size: 15px; font-weight: 900; }
</style>
