# 分析报告工作台 API

该子项目只维护 `/legacy-api` 命名空间对应的后端 API。基线来自旧服务当前不可变 release，运行端口默认为 `3200`；部署 origin 不写死在仓库里，由前端构建期的 `RPT_PROXY_BASE` 指定。

边界：

- 不包含 `.env`、密钥、数据库、上传文件、日志或用户报告。
- 不读写最新版 API 的端口 `3000`、发布目录、数据库或上传目录。
- 发布目标只能位于 `/opt/sample-app`，并使用新 release + 原子切换 + 可回滚流程。
- DeepSeek 只负责文本结构化分析；扫描 PDF 的 OCR 必须先形成可验证的报告归属证据。

## 确定性分析约束

- PDF、单图、多图和文本分析都会在 OCR/AI 前生成：
  `租户范围 + 有序文件内容 + OCR/提示词/Schema/模型/规则版本` 的 HMAC 分析键。
- 同一分析键只执行一次；成功的标准结果使用 AES-256-GCM 加密后保存，数据库不保存
  PDF、OCR 原文、裸文件哈希、用户 ID 或访问令牌。
- 生产环境必须配置至少 32 字节的 `ANALYSIS_CACHE_SECRET`（或
  `ANALYSIS_KEY_SECRET`）及稳定的 `ANALYSIS_STATIC_TENANT_ID`，否则拒绝启动。
  主 Bearer 与轮换期 fallback Bearer 必须共用该租户范围。
- 生产环境不会在缺少 `db.sqlite`/旧 `db.json` 时自动创建空业务库；这通常意味着
  `DATA_DIR` 配错或持久卷未挂载，服务会 fail-closed。只有确认初始化全新存储时，才可
  单次设置 `ALLOW_EMPTY_STORE_BOOTSTRAP=true`，建库成功后必须立即移除该开关。
- 本地开发未配置强密钥时仅使用进程内有界缓存（默认 128 条、24 小时）；
  进程重启和多个 Node/PM2 worker 之间不复用，这是明确的开发边界。
- 持久标准结果默认不自动过期；提示词、Schema、OCR、模型或规则改变时通过提升对应
  版本自然生成新键。若合规留存策略要求到期，可设置
  `ANALYSIS_PERSISTENT_CACHE_TTL_MS`。
- 模型固定采用零温度、关闭 thinking 和 JSON Output。普通报告使用一次事实抽取；长报告按
  不重叠页段执行确定性分块事实抽取，严格合并全部明细后只运行一次规则、风险和评分计算。
  任一分块 `finish_reason` 不是 `stop`、JSON/Schema 不完整、身份事实冲突或明细计数不一致时，
  请求直接失败，不会缩短到 12k、修补截断 JSON、评分或写入成功缓存。
- DeepSeek-V4-Flash 单次边界默认为 `DEEPSEEK_INPUT_MAX_CHARS=240000`、
  `DEEPSEEK_OUTPUT_MAX_TOKENS=131072`；报告硬上限为 `CREDIT_DOCUMENT_MAX_CHARS=1000000`。
  OCR 报告达到 8 页或文本达到 60000 字符后，默认按最多 3 页/40000 字符分块，最多 3 块并发，
  每块输出上限 32768 tokens。以上配置和分块策略都进入 analysisKey，变更后不会误复用旧结果。
  数组行只输出有原文依据的非空字段，禁止复述原文和冗长 notes。
- 文字层 PDF 会保留确定性页码边界。机构查询表若已由原文序号完整核验，模型输入中会移除该大表，
  分析后再逐行恢复；既避免长查询表拖垮模型输出，也不会让模型重新计算查询次数。
- 首轮若独立声明某明细总数大于实际输出数，服务端只对该类别执行一次定向完整抽取。
  补全结果必须恰好等于首轮独立声明的总数，否则仍失败；不会下调 total、丢弃多余行或
  为了通过校验而伪造明细。
- 查询窗口和所有时间派生值只以报告日期为锚点；AI 仅提取原始事实，使用率、负债、
  查询、风险和评分只由确定性规则引擎产生。
- 成功响应包含 `analysis` 和 `data.analysis_meta`，提供 `analysisKey`、`resultHash`、
  实际版本、权威标记及缓存边界；本轮新增的确定性分析日志不记录这些键、原文或个人信息。

部署前安全门禁（本发布已落实并由 `tests/deploymentSecurityBlockers.test.js` 覆盖）：

- 账号注销流程按用户 scope 级联删除 `analysis_results` 与 `analysis_jobs`；
- 历史客户端日志上报路由执行服务端递归脱敏与字段白名单；
- Moonshot/视觉上游异常不把响应正文拼入错误对象或持久日志。

常用验证：

```powershell
npm ci --no-audit --no-fund
npm test
node --test --test-reporter=spec tests/analysisCoordinator.test.js tests/deterministicCreditAnalysis.test.js tests/modelDeterminismContract.test.js tests/serverDeterminismContract.test.js
npm run test:legacy-api
```

全量 `npm test` 与仓库级确定性门禁必须在发布候选上重新运行；发布说明只记录该候选
的实际结果，不沿用来源快照中的历史失败数量。

扫描 PDF 按页渲染并仅保留有限数量的在途 PNG，避免长报告把全部页面/base64 同时放入 Node 堆。
扫描件首页归属字段采用两级本地 OCR：原有 Tesseract 负责全页，RapidOCR 仅在首页已识别出完整身份证但缺少姓名时运行。二级结果必须同时包含姓名和校验码有效的完整身份证，并与首页原 OCR 的 18 位号码完全一致；否则在调用 DeepSeek 前停止。

RapidOCR 运行时必须位于旧版隔离目录，并显式配置：

- `RAPIDOCR_IDENTITY_ENABLED=true`
- `RAPIDOCR_PYTHON`
- `RAPIDOCR_DET_MODEL`
- `RAPIDOCR_CLS_MODEL`
- `RAPIDOCR_REC_MODEL`

模型哈希内置于 Node/Python 审核代码，并与仓库固定路径 `ocr/models.sha256` 双向核对；环境变量不能替换信任清单。请求处理期间禁止联网下载模型。Python 依赖锁定位于 `ocr/requirements.lock.txt`。

`ocr/requirements.lock.txt` 固定 Linux CPython 3.10 的 wheel 版本与 SHA-256。部署时只允许从旧版隔离 wheelhouse 执行 `pip install --no-index --require-hashes`，随后运行 `pip check`；禁止在服务器在线解析或下载依赖。

真实报告仅允许在隔离临时目录中进行一次性验证，日志与审计产物不得包含文件名、原文、姓名、证件号、手机号、令牌或模型原始响应。
