# ADR-0001：双模型征信分析、证据权限与失败边界

- 状态：Accepted
- 决策日期：2026-08-17
- 决策范围：目标架构合同；阶段 0 不改变生产行为
- 关联 PRD：[`../product/PRD-DELTA-005-DUAL-MODEL-CREDIT-ANALYSIS.md`](../product/PRD-DELTA-005-DUAL-MODEL-CREDIT-ANALYSIS.md)
- 机器合同：[`../contracts/credit-analysis-phase0.contract.json`](../contracts/credit-analysis-phase0.contract.json)
- 机器合同 Schema：[`../contracts/credit-analysis-phase0.schema.json`](../contracts/credit-analysis-phase0.schema.json)
- OCR 契约：[`../contracts/OCR_STRUCTURED_V1.md`](../contracts/OCR_STRUCTURED_V1.md)
- 安全门禁：[`../security/CREDIT_ANALYSIS_PROVIDER_SECURITY.md`](../security/CREDIT_ANALYSIS_PROVIDER_SECURITY.md)

## 上下文

Evidence V7 已能对完整原生文字 PDF 建立文档清单、证据图、事实账本、确定性指标和发布门禁，但扫描 PDF/图片缺少可绑定的结构化证据。仓库内既有本地 OCR、RapidOCR 身份补救和 Moonshot/Kimi 代码无法提供一致的页、block、span、bbox、账户归属和供应商身份，因此不能通过简单回退形成权威扫描结果。

同时，全局 publication gate 只能给出完整成功或失败。允许局部核对必须先定义第三终态，并保证任何文档级不可信都不能借“部分结果”泄漏数字或绕过证据门禁。

## 决策

### 1. 模型与确定性组件

```text
完整原生文字 PDF
  -> MuPDF structured text
  -> DeepSeek 候选事实
  -> Evidence Binder
  -> Deterministic Rules

扫描 PDF / 图片
  -> MuPDF / Sharp 确定性渲染
  -> 智谱 glm-ocr layout_parsing 候选布局
  -> ocr-structured-v1
  -> DeepSeek 候选事实
  -> Evidence Binder
  -> Deterministic Rules
```

生产 OCR provider 唯一固定为 `zhipu-layout-parsing / glm-ocr`，事实提取模型唯一固定为 `deepseek / deepseek-v4-flash`。Tesseract、RapidOCR、Moonshot/Kimi 与客户端模型不属于目标生产候补。MuPDF、Sharp、Binder 和 Rules 是确定性组件，不计入“两模型”。

### 2. 权限分离

| 组件 | 可以做 | 不能做 |
|---|---|---|
| GLM-OCR | 返回 layout region、候选文本和 region bbox | accepted fact、账户归属自证、指标、评分 |
| `ocr-structured-v1` adapter | 校验、排序、清洗、拆 logical row/cell、形成稳定 span | 猜测缺失行、跨粗粒度 region 绑定、调用备用 OCR |
| DeepSeek | 从规范化文本提出候选事实 | 证明全文完整、证明证据归属、计算权威指标或评分 |
| Evidence Binder | 将候选绑定原页证据并给出五态事实 | 用模型置信度替代证据、把 unknown 变成 0 |
| Deterministic Rules | 在依赖闭合时计算指标、评分和决策输入 | 调用模型、填补未知事实 |

GLM 或 DeepSeek 的单独输出不得进入 accepted facts、权威派生结果或权威缓存。模型返回稳定、零温度、JSON mode、thinking disabled 或多次一致，都不扩大权限。

### 3. 输入路由

- 原生文字层满足完整性门禁时，GLM 调用次数必须为 0。
- 扫描 PDF/图片第一版所有页面统一走 GLM，不混合部分 native 和部分 OCR。
- 单页图片只以内存 data URI 发往固定 HTTPS endpoint；不生成公开 URL，不请求 crop image 或 layout visualization。
- 任一页缺失、页序冲突、结构响应非法或粗粒度多账户 region 无法确定性拆分时，在 DeepSeek 前 fail-closed。
- 自动重试只能重试同一 provider 的同一页，不能换模型或换 OCR provider。

### 4. 终态与门禁

目标任务终态固定为：

- `succeeded`：document hard gate 通过、execution/evidence artifact 完整，且事实、指标和决策依赖全部闭合；完整结果才可进入 authoritative cache。
- `review_required`：document hard gate 通过、execution 完成、evidence/review artifact integrity 完整，且仅字段/指标级存在 `unknown` 或 `conflict`；不擅自要求至少存在一个 accepted fact。只允许合同定义的独立 accepted fact 投影，禁止总分、总体风险、产品匹配、顾问建议和债务执行建议，且必须使用独立 review-only namespace。
- `failed`：document hard gate 失败/不可评估，或 execution/provider/schema 错误导致完整 review artifact 无法形成；不得展示任何分析数字，也不得缓存结果。

failed 的 `executionCompletion` 为 `any`：它既覆盖执行未完成，也覆盖执行完成后才发现 document identity、coverage、hash/hash-chain hard gate 失败的情况。

租户/文档身份、页数页序、全文覆盖、hash/hash-chain 和重放保护构成不可降级的 document hard gate。inactive/not_activated 计分仍未批准，任何依赖它的指标和决策保持 blocked。

阶段 0 只接受这个目标合同。当前生产仍没有 `review_required`；在任务协议、持久化、缓存、恢复和 UI 分阶段完成前，不能声明第三终态可用。

### 5. `ocr-structured-v1`

内部 schema 不直接保存 provider envelope。provider 的 `id`、`request_id`、`usage`、`layout_visualization`、crop URL 和原始 response body 都不进入证据合同。

内部 block 使用页内 `charStart/charEnd`、region 级 `bbox`、稳定 reading order 和来源 ordinal。region bbox 只能声明“来自这个布局区域”，不能声明字符、金额 token 或 table cell 有独立 polygon。HTML/Markdown table 必须由无网络、无脚本的确定性 parser 拆成 logical row/cell；无法证明多账户记录归属时返回 `OCR_RECORD_MEMBERSHIP_UNPROVEN`，而不是把整张表交给 DeepSeek 选择归属。

结构 schema 通过不等于证据接受。只有完整性、Binder 和 publication gate 后续全部通过，事实才可能成为 authoritative。

### 6. 错误、重试与预算

- 只有网络错误、连接/页超时、HTTP 408、429、500、502、503、504 可在同一 job 自动重试。
- 400、401、403、413/文件超限、schema invalid、页覆盖不一致、阅读顺序冲突和记录归属不明不自动重试。
- `maxAttemptsPerPage=2` 表示包含首次请求在内最多 2 次总尝试，即最多额外尝试 1 次，不是“重试两次”。
- 默认和生产页并发为 3，代码硬上限为 4；生产门禁仍必须锁定 3。
- connect timeout 15 秒、page timeout 120 秒、OCR stage deadline 420 秒、完整分析 deadline 900 秒；等待与 backoff 都计入上层 deadline，deadline 取消全部在途页。
- 安全错误只公开闭集 code/class/stage/retry 语义；header、key、data URI、response body、OCR 文本、bbox 和 provider request ID 永不进入错误或日志。

上述 attempt/timeout 是未来 GLM page client 的目标预算。DeepSeek 独立冻结为 `existing-verified-runtime-v1`：每个 request/chunk 默认最多 3 次总尝试（现有配置边界 1..5），网络/流中断、429 和任意 5xx 自动重试，退避为失败 attempt 序号乘 800 ms；当前 call/worker 没有独立 connect/attempt timer 或 AbortSignal，只受底层 transport 行为，`currentDeepSeekDeadlineEnforced=false`、`backgroundCancellationGuarantee=false`。900 秒只是目标 full-analysis budget/现有请求窗口，不是后台执行取消保证；后续必须单独实现并测试。阶段 0 不虚构 DeepSeek page budget，也不改变既有 runtime。

目标 provider/evidence error 必须逐项映射到现有 `upstream_transient / transport_transient / evidence_permanent / schema_permanent / input_permanent / configuration_permanent / internal_permanent` 闭集、安全 public message 和 `failed` 终态；不得落入 `unknown_permanent`。

### 7. 缓存

- provider 原始响应和 GLM/DeepSeek 单独候选禁止任何跨请求或跨运行 cache；当前请求函数栈中的瞬时对象不是 cache。
- 只有 `succeeded` 完整权威结果可进入 authoritative cache。
- `review_required` 在后续实现时使用独立 `review-only-v1` namespace、版本和读取权限，禁止与 authoritative cache 交叉命中。
- `failed` 不缓存结果。
- 未来分析身份必须包含 GLM provider/model/endpoint identity、adapter、render、reading order、table parser 和 schema 版本；跨租户、跨文档、跨版本复用始终禁止。

### 8. 数据出域与密钥

扫描页发送给智谱、规范化征信文本发送给 DeepSeek，均属于把个人敏感金融信息发送给外部受托处理者。调用前必须完成用户告知授权、DPA/供应商安全、处理地域、分包方、留存删除和事件通知审查。未闭合时功能保持关闭。

provider secret 只允许 `ZHIPU_GLM_OCR_API_KEY` 和 `DEEPSEEK_API_KEY`，由外部密钥管理服务向服务端进程环境注入。前端、Git、构建制品、命令行参数、日志和 health 不得获得实际值；health 只能给 provider/model/version 和 `configured` 布尔值。两种凭据不能互相兜底。

## 被否决的方案

### 保留多个 OCR 自动候补

同一文件会因 provider 顺序、配置或瞬时错误产生不同证据身份，且使缓存、错误、隐私和回滚不可审计，因此否决。

### 直接采用 GLM region JSON 或拼接文本

provider schema 与内部证据耦合，region 粒度不能证明 table cell/账户归属，纯文本又丢失页、span 和 bbox，因此否决。

### 允许模型为自己的候选“盖章”

这会形成模型自证循环，不能证明输入覆盖或金额归属，因此否决。

### 放宽 document hard gate 以输出部分结果

身份、页数或 hash 不可信时，任何局部数字都可能属于错误用户或错误文档，因此否决。

### 在 OCR 上线时顺带决定 inactive 计分

这会混合模型接入与业务评分语义，无法独立验证和回滚，因此否决。

## 后果

- 扫描链路需要额外的 provider client、严格 normalizer、table parser、Binder 接入和金标验证，交付成本增加。
- 粗粒度布局或复杂表格可能导致更多明确失败/待复核，但不会产生伪精确权威结果。
- 两个外部 provider 都处理敏感信息，产品告知、合同和安全评估成为生产硬门禁。
- 原生文字 PDF 不承担 OCR 成本和延迟。
- 任何阶段都可以独立回滚；回滚 GLM 扫描能力时返回明确不可用错误，不恢复旧 OCR 自动候补。

## 分阶段与回滚边界

阶段 0 仅文档/安全示例配置/CI 合同，可通过回退本阶段 commit 完整撤销。后续 client、adapter、Binder、金标、任务协议、review-only、UI、事件和生产清理分别使用独立 PR/release。功能回滚只能关闭本阶段新增能力：不得自动切回 Tesseract、RapidOCR 或 Moonshot/Kimi，也不得让 review artifact 进入 authoritative cache。
