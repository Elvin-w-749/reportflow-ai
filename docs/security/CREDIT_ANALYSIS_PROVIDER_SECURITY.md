# 征信模型供应商：密钥、隐私与匿名金标安全门禁

## 状态

本文是阶段 0 的目标安全合同，不表示外部合规审批已经完成，也不启用任何 provider 调用。当前生产行为不变；GLM-OCR 在所有必需门禁闭合前必须保持未接入。

相关合同：

- [`../product/PRD-DELTA-005-DUAL-MODEL-CREDIT-ANALYSIS.md`](../product/PRD-DELTA-005-DUAL-MODEL-CREDIT-ANALYSIS.md)
- [`../architecture/ADR-0001-DUAL-MODEL-CREDIT-ANALYSIS.md`](../architecture/ADR-0001-DUAL-MODEL-CREDIT-ANALYSIS.md)
- [`../contracts/credit-analysis-phase0.contract.json`](../contracts/credit-analysis-phase0.contract.json)

## Provider secret 合同

| Provider | 唯一运行时变量 | Secret Manager 逻辑别名 | 可否作为其他 provider 兜底 |
|---|---|---|---:|
| 智谱 GLM-OCR | `ZHIPU_GLM_OCR_API_KEY` | `prod/sample-app/legacy-api/zhipu-glm-ocr` | 否 |
| DeepSeek | `DEEPSEEK_API_KEY` | `prod/sample-app/legacy-api/deepseek` | 否 |

逻辑别名不是 secret 值，可以进入文档；secret 的值、长度、前缀、指纹、版本 ID 和控制台截图不得进入仓库或日志。

### 注入方式

生产 secret 的权威来源固定为外部密钥管理服务：

1. 安全负责人在外部密钥管理服务中创建/轮换 secret version；部署人员不能读取明文，只能触发受控注入。
2. 发布身份使用最小权限，只能读取上述精确逻辑别名的 current approved version；禁止 list-all、跨环境和开发身份读取。
3. 部署启动器在服务端取值并直接注入 API 进程环境；不得放入 Git、`.env`、发布 tar、Web bundle、命令行参数、shell history、CI output、PM2 日志或公开 URL。
4. 非 secret 配置可以继续使用受控配置文件；provider secret 不能写入部署机上的应用配置文件（例如 `/opt/sample-app/config/ai-proxy.env`）或其他持久明文文件。
5. 应用只能读取自己的精确变量。DeepSeek client 不得读取 Kimi/Moonshot key，GLM client 不得读取 DeepSeek key。
6. health 只能输出 provider、model、contract version 和 `configured: true/false`；禁止长度、前缀、hash、fingerprint、secret alias/version 和错误原文。
7. rotation 使用新版本启动新进程、通过无业务数据的本地配置/健康门禁后撤销旧版本；任何失败回滚版本都不得恢复已泄露 key。

### 开发与 CI

- tracked `.env.example` 中 provider 值必须为空；开发者在本机未跟踪配置中自行注入。
- provider client 阶段只能使用 fake key 和 mock server，不得访问真实 endpoint。
- CI 不配置真实 provider secret；fork/PR job 必须无 provider secret 权限。
- secret scanning 对全部 tracked 文本运行；疑似 key、私钥、认证 URL 或生产 `.env` 使 repository-safety 失败。
- 前端不得获得 secret 值、可取值的 provider credential 配置或直连 provider 的授权路径。变量名可以出现在既有安全错误文案/测试中，但不得成为 Vite 环境值、浏览器 storage 值或客户端 provider header。

## 数据出域清单

征信报告包含个人身份、账户、借贷、查询和履约等个人敏感金融信息。“出域”指从本服务受控后端发送到外部受托处理者，不只指跨境。

| 流向 | 数据类别 | 目的 | 技术最小化 | 持久化/日志 |
|---|---|---|---|---|
| 后端 -> 智谱 | 单页扫描图，可能含全部个人敏感征信信息 | 生成 region 级 OCR 候选 | MuPDF/Sharp 200 DPI JPEG quality 92；内存 data URI；逐页；不请求 visualization/crop | 本服务不持久化请求 data URI 或 raw response；禁止 payload/OCR/bbox/request ID 日志 |
| 后端 -> DeepSeek | 原生或合格 OCR 规范化文本，可能含全部个人敏感征信信息 | 提取候选事实 | 非重叠有界分块；不发送原始文件、公开 URL 或无关 metadata | 不持久化单独模型候选缓存；禁止正文/response 日志 |

两条流向都只能由服务器发起，传输固定 HTTPS。浏览器不能直连 provider，扫描页不能生成签名 URL、公网临时 URL 或 provider file upload 资源。

## 生产隐私与供应商准入门禁

以下所有必选项都必须有受控证据和负责人签字；任一未完成时 GLM 扫描能力保持关闭：

- [ ] 产品告知明确列出智谱与 DeepSeek、处理目的、数据种类、处理方式、处理地域、保存期限和用户权利。
- [ ] 对个人敏感信息取得符合法律/产品要求的单独、充分、可审计授权；拒绝授权时不调用 provider，且不伪装为解析成功。
- [ ] 供应商 DPA/委托处理条款明确目的限制、最小必要、保密、访问控制、分包方、事件通知、协助响应用户权利和终止删除。
- [ ] 法务确认智谱与 DeepSeek 的实际处理/存储地域、跨境状态和分包方；如发生跨境，完成单独告知、同意及适用评估/备案后才能启用。
- [ ] 供应商书面确认输入、输出、日志和备份的 retention/deletion SLA，以及是否用于训练、改进或人工审查；不满足最小必要即阻断。
- [ ] 隐私政策、上传授权页、撤回授权、删除请求和投诉渠道更新完成并版本化留证。
- [ ] 安全评估覆盖 TLS、账号/MFA、外部密钥管理服务/IAM、密钥轮换、访问审计、供应商异常、数据泄漏和事件响应演练。
- [ ] 明确本服务 spool、任务库、权威缓存、review-only cache 和备份各自的保留/删除周期；不得用 provider 默认期限替代本方政策。
- [ ] 禁止列表通过 PII sentinel 测试：文件名、原文、姓名、证件、卡号、机构、金额、日期、bbox、provider response/request ID 和 secret 均为 0 泄漏。
- [ ] 产品、隐私/法务、安全和运维四方批准灰度；批准记录不进入公开仓库。

智谱公开服务协议/隐私政策只能作为审查输入，不能自动视为本方已满足告知授权或 DPA。审查时至少核对：

- [智谱服务协议](https://docs.bigmodel.cn/cn/terms/service-agreement)
- [智谱隐私政策](https://docs.bigmodel.cn/cn/terms/privacy-policy)
- [智谱 GLM-OCR](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-ocr)

DeepSeek 公开政策明确说明：面向开发者下游应用终端用户数据的个人信息处理规则不由该公开政策覆盖，开发者作为处理活动的控制者/负责人应向终端用户另行披露。因而公开政策不得被表述为已覆盖本征信下游场景；其敏感个人信息提示也必须单独评估。在 DeepSeek 以书面 DPA/企业条款明确允许本征信用途、目的限制、训练退出、留存删除和事件责任之前，不得推断已获准发送征信数据。该问题同时是当前原生文字 PDF 链路的既有合规风险，阶段 0 不通过修改 runtime 掩盖它：

- [DeepSeek 隐私政策（中文）](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)
- [DeepSeek Open Platform Terms of Service](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
- [DeepSeek Privacy Policy（英文）](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)

如果供应商书面确认不能处理征信敏感信息，必须停止相关生产调用并重新走产品/架构/合规决策；不得在阶段 0 擅自选择备用模型。

## 匿名金标集准入标准

### 数据权利与隔离

- 每份报告必须有覆盖测试、匿名化、外部模型处理和规定期限保存的授权或其他经法务确认的处理基础。
- 原始报告只能在独立受控区处理；不得进入 Git、开发者桌面共享目录、普通工单、CI、provider 日志或 release artifact。
- 准入后的匿名集至少包含 30 份报告、合计至少 300 页；每份使用无业务含义随机 `sampleRef`，不能使用用户 ID、报告 ID、文件名或内容 hash 作为公开标识。
- 金标 registry、加密样本和访问审计存放在批准的数据仓库；源码只保存合成 fixture 和无内容的 schema/统计。
- 只给执行金标验证的最小人员/服务短期访问，启用 MFA、审批、下载限制和逐次审计。

### 去标识化暂存与匿名准入

- 原始报告到候选样本的替换阶段只是“去标识化暂存”。只要仍存在可逆映射、映射密钥、原始备份或可合理复原路径，该数据继续按个人敏感信息管理，不能称为匿名金标，也不能按匿名数据降低授权/访问控制。
- 姓名、证件号、手机号、住址、邮箱、账号、完整卡号、查询主体和自由备注全部替换；替换值在同份报告内保持引用一致。
- 卡尾、日期、金额、币种和机构类型等待测字段使用格式保持的独立随机化/偏移；所有派生关系和金标同步更新，不能保留真实值来换取测试方便。
- 机构名称替换为同类型合成机构，仍保留 bank/non-bank/unknown 金标语义。
- 图片层、隐藏文字层、metadata、缩略图、批注、附件和 OCR 缓存都执行相同清理；只改可见文字不算匿名化。
- 两名独立审核者分别执行自动扫描和人工复核。准入“匿名金标”前必须不可逆销毁全部映射、密钥、工作副本和可恢复备份，并由另一审核者验证无法关联到具体个人；销毁后才允许将候选状态改为 anonymous-admitted。
- 若因复核/删除义务必须保留可逆映射，该集合只能命名为“去标识化验证集”，继续按个人敏感信息处理，不计入匿名金标准入数量。

### 标注与覆盖

- 每个关键事实标注 `sampleRef / pageNumber / source block or logical row / field type / typed value / currency / record membership / expected fact state`。
- 两名标注员独立标注，分歧由第三人裁决；未裁决样本不得进入通过率分母。
- 样本至少覆盖：原生/扫描判别、单图/多图、旋转/倾斜/低对比度、印章/水印、20 页长报告、跨页段落、复杂/合并单元格、多账户表、重复机构、混合币种、明确 0、unknown/absent/conflict、inactive/not_activated 和查询明细。
- 至少 10 份含多账户或多查询 logical table，至少 10 份含混合币种/共享额度边界，至少 5 份为恰好 20 页的性能样本；类别可以重叠。
- 冻结 manifest 记录匿名样本版本、annotation schema/version、adapter/render/parser/Binder/Rules 版本和批准人；不记录原文或真实业务标识。

### 准出红线

- 关键金额、日期、币种、受控尾号和账户归属 exact match：100%。
- 账户行和查询行漏行：0。
- 跨记录错误绑定：0。
- 无证据 accepted 关键事实和错误权威发布：0。
- `unknown / absent / not_applicable / conflict / explicit zero` 相互误转：0。
- 同一冻结输入连续 5 次 manifest/evidence/fact/metric hash 一致。
- 性能 cohort 至少 5 份不同的 20 页样本；每份先做 1 次不计入的 warm-up，再做 5 次 fresh measured run，合计至少 25 次有效观测。OCR 与完整分析 p95 使用 nearest-rank：对 N 个值升序后取第 `ceil(0.95 × N)` 个；N 不得少于 25。20 页 OCR p95 不超过 180 秒；对应完整分析每次不超过 900 秒，并记录同一硬件、并发和版本条件。
- 原文、身份、provider raw response、bbox 日志和凭据泄漏：0。

任一红线未通过就不能进入生产。若 GLM region 粒度不足或 table parser 不能稳定证明记录归属，应继续使用同一 provider 做经过单独设计的关键 region 裁图二次识别；不得引入备用 OCR provider，也不得降低红线。

### 删除与退出

- 每个样本在 registry 中有 owner、目的、批准日期、到期日和删除状态；到期、撤回授权或目的结束时删除样本、标注、中间图和可恢复副本。
- 删除必须覆盖工作副本、临时目录、notebook、对象存储版本和备份到期策略，并生成不含业务数据的删除证明。
- 供应商退出或合同终止时撤销账号/key、验证 provider 侧删除、关闭网络允许列表，并保留仅含安全状态的审计记录。
