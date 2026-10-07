# 征信分析阶段 0：状态、错误、预算、缓存与回滚合同

## 合同来源与当前能力

机器可读来源为 [`credit-analysis-phase0.contract.json`](credit-analysis-phase0.contract.json)。`scripts/verify-phase0-contracts.mjs` 对机器结构、状态码闭集、错误映射、schema 条件和负例逐项执行 mutation tests；本文用于人工审查，不是可任选的第二份配置。

阶段 0 只冻结目标合同。当前生产基线 `abcdef1` 仍只对完整原生文字 PDF 提供 Evidence V7 权威链；扫描输入仍被阻断，`review_required` 未实现。本文不改变 runtime、路由、provider 调用或任务行为。

## 状态矩阵

| Document hard gate | 执行与 artifact 完整性 | 未决范围 | 目标终态 | 输出与缓存 |
|---|---|---|---|---|
| pass | execution complete、evidence artifact complete | 全部依赖 closed | `succeeded` | 完整权威结果；仅此状态可进 authoritative cache |
| pass | execution complete、evidence/review artifact integrity complete | 仅字段或指标未决 | `review_required` | 仅合同允许的独立 accepted facts；禁止总分、风险、匹配、建议；只可进独立 `review-only-v1`；不要求至少存在 1 个 accepted fact |
| fail/not-evaluable，或 provider/execution/schema 错误 | 无法形成完整 review artifact | 任意 | `failed` | 不展示任何分析数字；不进结果缓存 |

`failed.executionCompletion=any`：failed 既可能来自执行未完成/provider error，也可能在执行完成后由 document identity、coverage、hash/hash-chain hard gate 拒绝；不得把“代码已运行完”误写为可进入 review。

DocumentManifest、tenant/owner、job/document identity、页数页序、全文覆盖、hash/hash-chain、跨文档/跨版本重放属于不可降级 hard gate。`inactive / not_activated` 计分仍未批准，所有依赖它的指标和决策继续 blocked。

事实状态闭集固定为 `accepted / unknown / absent / not_applicable / conflict`；只有来源明确证明的 0 才是 0。

## 两类尝试预算必须分开

### GLM page attempt

| 参数 | 值 |
|---|---:|
| 单位 | 单个已渲染 page |
| Render | 200 DPI、JPEG quality 92、每页 `< 9 MiB` |
| 并发 | production/default 3；代码硬上限 4 |
| Connect timeout | 15,000 ms |
| 单次 attempt timeout | 120,000 ms |
| OCR stage deadline | 420,000 ms |
| Max attempts/page | 2（含首次，最多额外 1 次） |
| 自动重试 | 网络失败、408、429、500、502、503、504 |
| backoff | 普通 1,000 ms；429 尊重 `Retry-After`，上限 30,000 ms |

等待、backoff、response 读取和 normalizer 都计入 420 秒；OCR stage 又计入完整分析 900 秒。任何 deadline/取消都中止排队与在途页。两次总尝试绝不能写成“重试两次”。

### DeepSeek request/chunk attempt

阶段 0 不改变 DeepSeek runtime，冻结标识为 `existing-verified-runtime-v1`：

| 参数 | 当前已验证行为 |
|---|---|
| 单位 | 每个完整 request 或每个非重叠 chunk request；不是 page |
| 总尝试 | `DEEPSEEK_MAX_ATTEMPTS` 默认 3，现有边界 1..5 |
| 专用 connect/attempt timeout | 当前没有独立 timer，不虚构数值 |
| 当前后台 deadline/cancellation | `currentDeepSeekDeadlineEnforced=false`、`backgroundCancellationGuarantee=false`；worker/call 没有 signal/timer，只受底层 transport 行为 |
| 目标预算 | `targetFullAnalysisDeadlineMs=900000`，这是后续实现门禁，不是当前后台取消保证 |
| 自动重试 | 网络/流中断、429、任意 500..599 |
| 不自动重试 | 400..428、430..499 |
| backoff | 失败 attempt 序号 × 800 ms，即默认额外等待 800 ms、1,600 ms |
| chunk 并发 | 默认 3，现有上限 4 |

浏览器/HTTP server 的 900 秒 request window 不会自动取消已转入后台 worker 的 DeepSeek call。后续必须单独实现并测试后台 AbortSignal/timer，才能把 900 秒描述为执行 deadline。若增加专用 timeout 或改变 attempts/backoff，也必须单独版本化；不能把 GLM page budget 复制给 DeepSeek。

## HTTP 400..599 闭合映射

所有 provider HTTP 400..599 必须由 explicit entry 或 `4xxDefault / 5xxDefault` 命中，禁止落到未分类错误。

### GLM-OCR

| HTTP | code | 同 job 自动尝试 |
|---|---|---:|
| 400 | `GLM_OCR_BAD_REQUEST` | 否 |
| 401 | `GLM_OCR_AUTH_FAILED` | 否 |
| 403 | `GLM_OCR_FORBIDDEN` | 否 |
| 408 | `GLM_OCR_HTTP_408` | 是 |
| 413 | `GLM_OCR_INPUT_TOO_LARGE` | 否 |
| 429 | `GLM_OCR_RATE_LIMITED` | 是 |
| 500/502/503/504 | `GLM_OCR_PROVIDER_UNAVAILABLE` | 是 |
| 其他 4xx | `GLM_OCR_CLIENT_ERROR` | 否 |
| 其他 5xx | `GLM_OCR_PROVIDER_ERROR` | 否；允许新 job 重试 |

网络、连接超时、页超时分别使用 `GLM_OCR_NETWORK_ERROR / GLM_OCR_CONNECT_TIMEOUT / GLM_OCR_PAGE_TIMEOUT`。配置、schema、coverage、reading-order、record-membership 和 stage-deadline 使用机器合同中的独立 code。

### DeepSeek

| HTTP | code | 沿用当前同 request/chunk 自动尝试 |
|---|---|---:|
| 400 | `DEEPSEEK_BAD_REQUEST` | 否 |
| 401 | `DEEPSEEK_AUTH_FAILED` | 否 |
| 403 | `DEEPSEEK_FORBIDDEN` | 否 |
| 408/409/425 | `DEEPSEEK_HTTP_408 / _409 / _425` | 否；允许新 job 重试 |
| 413 | `DEEPSEEK_INPUT_TOO_LARGE` | 否 |
| 422 | `DEEPSEEK_CONTEXT_LIMIT` | 否 |
| 429 | `DEEPSEEK_RATE_LIMITED` | 是 |
| 任意 5xx | `DEEPSEEK_PROVIDER_UNAVAILABLE` | 是 |
| 其他 4xx | `DEEPSEEK_CLIENT_ERROR` | 否 |

此外完整定义 `DEEPSEEK_NOT_CONFIGURED / NETWORK_ERROR / TIMEOUT / RESPONSE_INVALID / OUTPUT_TRUNCATED`。阶段 0 只冻结将来安全映射，不修改当前 `ANALYSIS_*` runtime code；接入时必须逐项适配并保持现有已验证 retry 行为。

## 公共 task error class 与安全消息

每个机器合同 error 都固定映射到现有公共 task class，终态均为 `failed`：

| task error class | retryable | 使用范围 |
|---|---:|---|
| `upstream_transient` | 是 | rate limit、可恢复 provider 状态、输出截断 |
| `transport_transient` | 是 | 网络、连接/流/阶段 timeout |
| `evidence_permanent` | 否 | coverage、record membership、reading order、publication gate |
| `schema_permanent` | 否 | provider/模型响应 schema 非法 |
| `input_permanent` | 否 | 输入格式/大小/context limit |
| `configuration_permanent` | 否 | key、权限、provider client 4xx 配置错误 |
| `internal_permanent` | 否 | 预留给既有内部闭集，不由 provider raw code产生 |

阶段 0 provider/evidence code 不得落到 `unknown_permanent`。公开消息只能选择机器合同的 9 个 `publicMessageKey`；不得使用 provider 原始 message。安全 envelope 只允许闭集 `code / class / stage / retryable / safeMessageKey`，后续 supportRef 阶段再增加无业务含义的 `serverTime / supportRef`。

禁止出现在响应、异常、日志或诊断中的内容包括 header、key、Cookie、data URI、文件名/路径、正文/OCR 文本、姓名、证件/卡号、机构、金额、日期、bbox、provider body、provider ID/request ID、文档/结果 hash 和自由 `extra/details/meta`。

## raw/candidate cache 边界

- GLM raw response、data URI、layout visualization、provider identifiers 和 DeepSeek raw output 禁止任何跨请求或跨运行 cache。
- GLM normalized candidate 与 DeepSeek candidate facts 同样禁止跨请求/跨运行 cache。
- 单个当前请求函数栈中的瞬时对象不是 cache；不得跨 job、跨 process 或跨 restart 复用。
- 只有完成 Binder/Rules/PublicationGate 的 `succeeded` 权威结果可进 authoritative cache。
- `review_required` 后续只能进独立 `review-only-v1` namespace，禁止与 authoritative 交叉命中。
- failed 不进结果 cache；跨 tenant、document 或 version 复用全部禁止。

## 回滚

机器合同 `fallbackToLegacyOcrAllowed=false`。阶段 0 可通过回退本阶段文档/CI commit 撤销。后续 GLM 扫描回滚只能关闭扫描能力并返回明确 unavailable，不能切回 Tesseract、RapidOCR、Moonshot/Kimi；review 回滚不能把 review payload 映射为 succeeded。

## 可执行负例

Repository-safety 先使用锁定版本 Ajv `8.20.0` 的 draft-2020-12 实现编译 [`credit-analysis-phase0.schema.json`](credit-analysis-phase0.schema.json) 与 [`ocr-structured-v1.schema.json`](ocr-structured-v1.schema.json)，再验证正/负实例。CI 同时对 source routing、hard gate、每个 cache boolean、health、provider review、错误闭集/映射、HTTP defaults、预算、schema required/condition/security 和 OCR 语义逐项突变；手写校验只补充 JSON Schema 无法表达的 span/coverage、跨字段映射和确定性排序。只有 Ajv 基线、schema 负例和语义负例全部通过，本合同检查才成功。
