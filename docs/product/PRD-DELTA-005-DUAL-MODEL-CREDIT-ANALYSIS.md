# PRD-DELTA-005：双模型征信分析与待复核终态

## 文档控制

- 产品：分析报告工作台 Web
- 状态：approved（仅批准目标合同与后续分阶段实施；不代表已批准上线）
- 批准来源：用户于 2026-08-17 指示执行阶段 0
- 生效范围：`REQ-EVIDENCE-FIRST-CREDIT-ANALYSIS-V2`
- 基线提交：`abcdef1234567890abcdef1234567890abcdef12`
- 基线 Web release：`20260817-125147-evidence-v7-abcdef1-web`
- 基线 API release：`20260817-125147-evidence-v7-abcdef1-api`
- 机器可读合同：[`../contracts/credit-analysis-phase0.contract.json`](../contracts/credit-analysis-phase0.contract.json)
- 机器合同 Schema：[`../contracts/credit-analysis-phase0.schema.json`](../contracts/credit-analysis-phase0.schema.json)
- 架构决策：[`../architecture/ADR-0001-DUAL-MODEL-CREDIT-ANALYSIS.md`](../architecture/ADR-0001-DUAL-MODEL-CREDIT-ANALYSIS.md)

## 背景

当前生产仅对完整原生文字 PDF 形成 Evidence V7 权威结果。扫描 PDF、单图和多图在正式 Binder 前被 `OCR_STRUCTURED_EVIDENCE_UNAVAILABLE` 阻断；仓库中的 Tesseract、RapidOCR 和 Moonshot/Kimi 代码不是可发布的扫描征信证据链。当前终态仍是全有或全无，`review_required` 尚未实现。

本 delta 只冻结目标语义、供应商边界、状态协议、隐私和密钥门禁。阶段 0 不调用真实模型、不接入扫描路由、不实现部分投影、不删除旧代码、不部署，因此不得把本文档描述为“GLM-OCR 已上线”或“待复核已可用”。

## 产品决策

### REQ-DUAL-MODEL-PRODUCTION-CHAIN

- 生产 OCR 唯一供应商为智谱 `glm-ocr` 的 `layout_parsing` 接口。
- DeepSeek `deepseek-v4-flash` 是唯一事实提取模型。
- Tesseract、RapidOCR、Moonshot/Kimi 和客户端模型不得作为生产自动候补。
- MuPDF、Sharp、Evidence Binder 和 Deterministic Rules 不是模型，继续保留。
- 完整原生文字 PDF 只通过 MuPDF 读取，不调用 GLM-OCR。
- 扫描 PDF/图片第一版整份统一走 GLM-OCR，不允许同一文档静默混合 native text 和 OCR text。

### REQ-MODEL-AUTHORITY-BOUNDARY

- GLM-OCR 只产生页、region、布局文本和 bbox 候选源；它不能产生 accepted fact、负债、使用率、风险或评分。
- DeepSeek 只从规范化文本提出贷款、卡片和查询候选；零温度、JSON 输出或关闭 thinking 都不构成证据。
- Evidence Binder 是唯一能把候选升级为 `accepted / unknown / absent / not_applicable / conflict` 的组件。
- Deterministic Rules 是唯一能计算负债、使用率、查询窗口、评分和其他派生指标的组件，且不得调用模型。
- 模型 raw response 和候选不得形成任何跨请求/跨运行 cache，也不得单独进入权威事实或权威缓存；当前请求函数栈内的瞬时对象不称为 cache。关键事实没有原页和 block 引用时不得发布。

### REQ-THREE-TERMINAL-STATUSES

`queued` 和 `processing` 只是非终态。分析任务只有三个业务终态：

| 终态 | 前提 | 可见输出 | 缓存 |
|---|---|---|---|
| `succeeded` | document hard gate 通过，execution/evidence artifact 完整，事实、指标和决策依赖全部闭合 | 完整权威事实、指标、总分、风险、匹配和建议 | 仅可进入 authoritative cache |
| `review_required` | document hard gate 通过，execution 完成、evidence/review artifact integrity 完整，且仅字段或指标级未决；不要求至少存在一个 accepted fact | 仅合同允许的独立已核验事实、待核对字段和被阻断范围 | 只能进入独立 `review-only-v1` namespace；不得命中 authoritative cache |
| `failed` | document hard gate 失败/不可评估，或 execution/provider/schema 错误导致完整 review artifact 无法形成 | 不展示任何分析数字，只显示安全错误信息 | 不缓存结果 |

`review_required` 不是“低置信度成功”，不得显示或产生总分、总体风险等级、产品匹配、顾问建议、债务执行顺序或其他决策性结论。旧客户端也不得把它映射为 `succeeded` 或普通可重试失败。

### REQ-DOCUMENT-HARD-GATE

以下任一失败必须整单 `failed`，永远不能降级为 `review_required`：

- 用户、租户、任务、文档身份或 scope 不匹配；
- 页数、页序、全文覆盖不闭合；
- 文档哈希、证据哈希或哈希链校验失败；
- 跨文档、跨租户或跨版本重放；
- 无法证明输入和结果属于同一交付。

document hard gate 失败时，UI、API、缓存和恢复协议都不得保留任何分析数字。字段级 `unknown` 只能在 document hard gate 已通过后进入未来的 review-only 投影。

### REQ-INACTIVE-SCORING-BOUNDARY

`inactive / not_activated` 账户的计分口径仍未获产品批准。本 delta 不选择计入或排除：只要它影响评分或决策依赖，相关指标、总分、风险、匹配和建议继续 blocked。以后改变该口径必须单独 PRD delta、代码 PR、金标验证和 release；不得借 OCR 或 partial-review 上线顺带改变。

### REQ-FACT-STATE-TRUTHFULNESS

| 事实状态 | 用户语义 | 是否聚合/评分 |
|---|---|---|
| `accepted` | 已核验值 | 只在全部依赖闭合时参与 |
| `absent` | 明确无或报告未记载 | 按获批规则处理，不等于 unknown |
| `unknown` | 待核对或未识别完整 | 否 |
| `not_applicable` | 不适用 | 否 |
| `conflict` | 存在冲突，待复核 | 否 |

只有来源明确证明数值为 0 才能显示 `0 / ¥0`。任何兼容层不得把 `unknown`、null 或空串转成 0、无、正常、暂无风险或暂无债务；报告日期缺失时不得回退为上传时间。

### REQ-PROVIDER-DATA-BOUNDARY

| 接收方 | 允许发送 | 目的 | 禁止发送/保存 |
|---|---|---|---|
| 智谱 GLM-OCR | 扫描页在服务器内存生成的 JPEG data URI；其中可能含个人敏感征信信息 | 生成布局 OCR 候选 | 公网图片 URL、客户端直传 key、日志中的 data URI/正文/bbox/响应体/request ID、layout visualization、crop image |
| DeepSeek | 由完整原生文字层或合格 `ocr-structured-v1` 形成的规范化文本；其中可能含个人敏感征信信息 | 提取候选事实 | 原始文件、公网 URL、日志中的正文/响应体、模型自证 accepted |

在向任一供应商发送个人敏感金融信息前，必须完成明确告知和单独/充分授权、供应商数据处理和留存删除审查、处理地域与分包方审查、安全事件条款、用户撤回和删除流程。任何一项生产门禁未闭合时，扫描分析不得启用；不能通过切换供应商绕过。

## 验收标准

- AC-P0-001：目标合同只列一个生产 OCR provider（智谱 `glm-ocr layout_parsing`）和一个事实提取模型（DeepSeek），自动候补列表为空。
- AC-P0-002：PRD、ADR 和机器合同对 `succeeded / review_required / failed` 的前提、输出和缓存资格一致。
- AC-P0-003：GLM、DeepSeek、Binder 和 Rules 的权限互斥；模型没有 accepted fact、派生指标或评分权限。
- AC-P0-004：document hard gate 永不产生 review-only 或数字；inactive 口径继续 blocked。
- AC-P0-005：智谱与 DeepSeek 的数据类别、目的、授权、留存删除和禁止日志范围可独立审查。
- AC-P0-006：只定义 `ZHIPU_GLM_OCR_API_KEY` 与 `DEEPSEEK_API_KEY` 两个 provider secret；前端、Git、制品、命令行和日志均不得持有实际值，也不得跨 provider 兜底。
- AC-P0-007：错误协议分别冻结 GLM page 与 DeepSeek request/chunk：GLM 每页最多 2 次总尝试及 15/120/420 秒 page/stage 预算，目标 full-analysis budget 为 900 秒；DeepSeek 沿用现有默认 3 次、1..5 边界、网络/429/5xx 和 `800 × attempt` 行为，不虚构 page timeout，也不把当前 HTTP request window 表述为后台 deadline/cancellation 保证。
- AC-P0-008：`ocr-structured-v1` 对页序、span、bbox、region、logical table row/cell、阅读顺序和内容上限有确定性约束；粗粒度多账户 region 无法拆分时 fail-closed。
- AC-P0-009：匿名金标只有在授权、匿名化、双人标注、受控存储和删除期限全部通过后才能准入；原始报告与 provider 响应不得进入 Git 或 CI 制品。
- AC-P0-010：阶段 0 diff 不包含运行时代码、正式路由、OCR client/adapter、partial-review 实现、旧 OCR 删除或部署变更。
- AC-P0-011：repository-safety、frontend、backend 三项 GitHub Actions 全绿后停止，等待下一阶段授权。

## 阶段 0 非范围

- 不调用真实 GLM 或 DeepSeek API；
- 不实现 GLM HTTP client 或解析 provider response；
- 不修改 PDF、单图、多图正式路由；
- 不实现 `review_required` API、持久化、缓存、恢复或 UI；
- 不删除 Tesseract、RapidOCR、Moonshot/Kimi 代码或配置；
- 不改变评分、Binder、规则、缓存或错误运行行为；
- 不部署、不灰度、不执行真实报告业务验证。

## 上线前外部批准

以下项目不是代码合并可以替代的批准：供应商合同与 DPA、DeepSeek 对征信敏感信息处理用途的书面许可、个人信息处理告知和授权文案、数据处理地域及分包方、留存/删除 SLA、安全事件通知、匿名金标数据授权，以及 provider key 的控制台轮换与撤销记录。相关证据必须存放在受控合规系统，不进入源码仓库。若任一供应商不允许该数据/用途，必须停止调用并重新走产品与架构决策，不能擅自启用备用模型。
