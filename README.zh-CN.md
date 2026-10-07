[English](README.md) | 简体中文

# reportflow-ai · 分析报告工作台

一个本地优先（offline-first）的全栈工作台：把上传的证件与资料包转化为结构化、有证据
支撑的分析报告。文档在本地完成光学字符识别（OCR），交由可插拔的大语言模型（LLM）
提供方分析，与产品库进行匹配，最终导出为可分享的报告。

> ⚠️ **本仓库内的全部业务数据均为虚构。**
> 机构名称、产品名称、额度利率、测试账号与示例报告文本均为**虚构示例**，
> 仅用于技术演示与自动化测试，**不含任何真实机构产品、真实客户数据或真实风控模型**。
> 请勿将本项目的输出用于任何实际授信、融资或信用决策。

---

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [测试与校验](#测试与校验)
- [领域模型说明](#领域模型说明)
- [安全姿态](#安全姿态)
- [文档](#文档)
- [许可证](#许可证)

---

## 功能概览

1. **上传** — 证件、征信报告与补充材料以 PDF、图片或多部分表单上传的形式提交。浏览器
   会保留一份本地草稿存储，刷新页面也不会丢失进行中的工作。
2. **识别** — 原生文本 PDF 直接抽取文字；扫描件走本地 OCR 链路。结构化 OCR 输出必须
   先通过一份冻结的 JSON Schema 合同校验，才能作为证据使用。
3. **多模型分析** — 解析得到的事实会发送给一个或多个 LLM 提供方，并归一化为统一的
   证据模型。每个上屏的数字都必须能追溯到文档内的证据；当证据缺失或互相冲突时，
   流水线会返回 `review_required`，而不是凭空编造一个分数。
4. **匹配** — 确定性的打分引擎（`matchCore`）用本地产品库的条目对照分析画像排序。
   同一个引擎同时在浏览器（即时预览）和服务端（登录后的结果）运行，两边结果一致。
5. **报告与导出** — 结果渲染为多章节报告页面，并可导出为 PDF / 图片。客户、顾问、
   客服与管理员视图是同一个 Web 应用按权限裁剪的呈现——没有原生或小程序客户端。

### 非目标

- 不做移动 App、小程序或原生打包。浏览器是唯一客户端：一套响应式构建同时服务桌面与
  手机浏览器，并保留微信内置浏览器的兼容路径（发版前仍需真机回归）。
- 不捆绑任何客户数据、生产配置、模型权重或发布二进制。
- 没有真实金融产品目录——随仓库附带的产品库是合成的演示数据。

---

## 技术栈

| 层 | 选择 |
|---|---|
| 前端 | Vue 3 + Vite、Vue Router（哈希路由）、Vant + Naive UI、html2canvas + jsPDF 导出 |
| 后端 | Node.js Express API、JWT 认证、multer 上传、pino 日志、express-rate-limit |
| 存储 | 经由 `better-sqlite3` 的 SQLite（单文件、WAL 预写日志）；本地 JSON / 资源目录 |
| 解析 | `mupdf` / `pdf-parse` 抽取原生文本，可插拔 OCR 后端（tesseract CLI、本地 RapidOCR worker、远程 OCR API） |
| 模型 | 提供方无关的 LLM 客户端（`DEEPSEEK_*`、远程 OCR `ZHIPU_GLM_OCR_*`、可选视觉提供方） |
| 合同 | JSON Schema draft-2020-12 + Ajv 8，由 CI 校验 |
| 测试 | 两侧均使用 Node 内置的 `node:test` 运行器；不需要浏览器测试运行器 |
| 运行时 | **Node.js >= 20.9**（推荐 22），多包结构，未使用 npm workspaces |

---

## 仓库结构

```text
frontend/          Vue 3 + Vite Web 应用（桌面 + 移动浏览器）
  src/             页面、服务层、共享数据
  scripts/         Web 产物的构建 / 打包 / 门禁脚本
  tests/           node:test 合同与单元测试
backend/           Express + SQLite API（默认 http://127.0.0.1:3200）
  backend/         路由、服务、数据库层
  src/shared/      产品库，逐字节镜像到前端
  ocr/             可选的 Python RapidOCR 运行时（模型文件绝不入库）
  tests/           API、合同与确定性测试
docs/              PRD、ADR、机器合同、安全说明
scripts/           仓库级安全与合同校验
ops/               本地运行辅助工具与只读日志分析工具
tests/             跨层一致性测试
```

---

## 快速开始

环境要求：Node.js `>= 20.9`、npm，以及足以容纳本地 SQLite 文件的磁盘空间。**不需要
域名、TLS 证书、云账号或公网 IP**——下面所有步骤都在 `localhost` 上运行。

```bash
# 1. 为两个应用安装依赖
npm run install:all

# 2. 生成本地 env 文件（两者都在 git 忽略清单里）
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
#    backend/.env 必须填入真实的本地值：JWT_SECRET 与 ANALYSIS_CACHE_SECRET
#    没有可用默认值；frontend/.env.local 保持出厂内容即可

# 3. 先启动 API（默认 http://127.0.0.1:3200）
npm run dev:backend

# 4. 另开一个终端，启动前端（默认 http://127.0.0.1:5173）
npm run dev:frontend
```

打开 <http://127.0.0.1:5173>。Vite 开发服务器会把 `/api` 代理到后端，浏览器因此从不
需要绝对的生产环境基地址。真实的 `.env` 文件、机密、客户报告、数据库、上传文件与
OCR 模型绝不能提交入库。

当默认端点与本机上已有的服务冲突时，可以这样覆盖（后端已经绑定 `127.0.0.1:3200`，
开发代理也已指向它）：

```bash
# 后端
HOST=127.0.0.1 PORT=3200 npm run dev:backend

# 前端开发代理目标（仅允许 localhost / 127.0.0.1 / ::1）
RPT_LOCAL_API_ORIGIN=http://127.0.0.1:3200 npm run dev:frontend
```

`RPT_*` 与 `VITE_*` 输入会同时从 shell 环境变量和 `.env` 文件（`.env`、`.env.local`、
`.env.<mode>`）读取，因为 `vite.config.js` 通过 Vite 的 `loadEnv` 按 `VITE_`/`RPT_`
前缀加载它们。同名的 shell 变量优先于 `.env` 条目。

### 生产构建（仍然只在本地）

```bash
npm run build:frontend     # 产出 frontend/dist
npm run verify:repository  # 字节级一致性门禁
```

前端构建从 `RPT_PROXY_BASE` 读取 API 基地址，它取一个完整的 origin（来自 shell 环境
或 `.env*` 文件）。未设置时，构建产物默认指向本机 API
`http://127.0.0.1:3200/legacy-api`，并且构建过程会打印一条一次性警告——该地址只有在
构建机上才能解析，所以在通过反向代理对外发布之前，请先设置你自己的 origin。仓库里
不写入任何公开主机地址。

### 可选集成

所有与外部世界交互的部分都是可选项：

- **LLM 分析** — 设置 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_CHAT_URL` /
  `DEEPSEEK_TEXT_MODEL`）。没有密钥时，上传与解析仍然可用；分析步骤会报告一个配置
  错误，而不是给出一个假结果。
- **OCR** — `OCR_PROVIDER` 选择后端。本地 tesseract 需要 `tesseract` 可执行文件；
  RapidOCR 路径需要你自己的模型文件（绝不入库，仅在隔离的部署环境内做校验和验证——
  CI 绝不下载模型）。
- **短信登录验证码** — `SMS_PROVIDER=dev` 会把验证码打印到服务端控制台。该模式**仅
  用于本地开发，绝不能用于生产**；请改为配置真实的服务方。

---

## 环境变量

下表标注 **必填** 的项**没有默认值**：在你提供它们之前，进程会拒绝启动（或该功能
保持禁用）。绝不要提交填好的 `.env`。

### 后端

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` 会启用失败关闭（fail-closed）的安全门禁 |
| `HOST` / `PORT` | `127.0.0.1` / `3200` | 本地绑定地址 |
| `JWT_SECRET` | **必填** | 没有隐式回退；生产启动时若没有非默认值即失败 |
| `ANALYSIS_CACHE_SECRET` | **必填** | >= 32 个 UTF-8 字节；为作用域/内容身份计算 HMAC，并加密规范化结果 |
| `ANALYSIS_KEY_SECRET` | 可选 | 内容身份的替代密钥材料，设置后取代 `ANALYSIS_CACHE_SECRET` |
| `ANALYSIS_STATIC_TENANT_ID` | `local-legacy-api` | 缓存命名空间的非机密租户标签 |
| `DATA_DIR` / `LOG_DIR` | `./data-local` / 内置 | 运行时请放在代码检出目录之外 |
| `ALLOWED_ORIGINS` | 仅 localhost 来源 | 逗号分隔、精确匹配的 CORS 允许列表；部署时加上你自己的来源 |
| `DEV_ANALYZE_BEARER` | 开发 Bearer 路径**必填** | 分析端点使用的仅限本地的令牌 |
| `SMS_PROVIDER` | `dev` | `dev` 会把验证码打印到控制台并大声警告；其他取值经由各自的 `SMS_*` 键选择已配置的服务方 |
| `DEEPSEEK_API_KEY` | 空 | 模型访问，仅限服务端 |
| `DEEPSEEK_CHAT_URL`, `DEEPSEEK_TEXT_MODEL`, `DEEPSEEK_INPUT_MAX_CHARS`, `DEEPSEEK_OUTPUT_MAX_TOKENS`, `REQUEST_TIMEOUT_MS` | 见 `backend/.env.example` | 长报告的分块/超时调优 |
| `ZHIPU_GLM_OCR_API_KEY` | 空 | 远程 OCR 可选项；仅限服务端 |
| `OCR_PROVIDER`, `TESSERACT_BIN`, `TESSERACT_LANG`, `RAPIDOCR_*`, `SCANNED_PDF_*` | 见 `backend/.env.example` | 解析/扫描两条流水线的选项 |
| `CREDIT_ANALYSIS_PIPELINE_VERSION`, `CREDIT_PROMPT_VERSION`, `CREDIT_SCHEMA_VERSION`, `CREDIT_RULE_VERSION`, `CREDIT_OCR_VERSION` | 固定于 `backend/.env.example` | 有意地升版——版本每变一次，缓存的答案就会失效 |
| `ENABLE_FIXED_TEST_ACCOUNTS` | 生产环境关闭 | 合成演示账号的开关 |
| `ALLOW_EMPTY_STORE_BOOTSTRAP` | 未设置 | 用于创建全新空库的一次性逃生阀；用完立即移除 |
| `PRODUCT_LIBRARY_PATH` | 共享文件 | 指向其他路径即可换上你自己的演示产品目录 |
| `JSON_BODY_LIMIT`, `PDF_UPLOAD_MAX_MB`, `IMAGE_UPLOAD_MAX_MB` | 保守默认值 | 请求大小限制 |
| `AI_RATE_LIMIT_PER_HOUR`, `AUTH_RATE_LIMIT_PER_15MIN`, `GLOBAL_RATE_LIMIT_PER_MIN`, `MATCH_RATE_LIMIT_PER_MIN`, `LOG_RATE_LIMIT_PER_MIN` | 保守默认值 | 按路由的速率限制 |
| `RPT_RELEASE_ID`, `RPT_GIT_COMMIT` | 未设置 | **后端**部署身份（由 `backend/server.js` 与签名的分析事件日志读取）；仅在 `NODE_ENV=production` 时要求成对提供 |

### 前端（`RPT_*` 构建输入与 `VITE_*` 值会进入浏览器——绝不要把机密放在这里）

两种前缀都从 shell 环境变量**以及**经 Vite `loadEnv` 读取的 `.env` / `.env.local` /
`.env.<mode>` 获取；已存在的 shell 变量优先。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RPT_LOCAL_API_ORIGIN` | `http://127.0.0.1:3200` | 开发代理目标；必须是不带凭据的 localhost http(s) 来源 |
| `RPT_PROXY_BASE` | 未设置 | 构建期 API origin；未设置时构建产物默认指向上面的本机 API，且生产构建会打印一条一次性警告 |
| `LEGACY_RELEASE_ID` | 未设置 | 由 `frontend/scripts/package-legacy-web-release.mjs` 消费的发布标签（仅打包用，不是 Vite 输入） |
| `VITE_ENABLE_LOCAL_DEV_AUTH` | `false` | 启用仅限本地的测试登录辅助，只允许在 Vite 开发模式的回环地址上使用 |
| `VITE_LOCAL_DEV_TEST_PASSWORD`, `VITE_LOCAL_DEV_SMS_CODE` | 空 | 除非在本地调试，否则必须保持为空；绝不要复用真实凭据 |

---

## 测试与校验

```bash
npm test                            # 完整门禁：仓库校验 + 合同 + 前端 + 后端
npm run verify:repository           # 安全扫描、入库文件数量预算、产品库哈希一致性
npm run verify:phase0-contracts     # 机器合同 blob 校验
npm run test:frontend               # 路由检查 + node:test 合同/单元测试
npm run test:backend:deterministic  # 确定性、缓存、隔离、安全阻断测试
npm run test:backend:legacy         # OCR / 归属权 / 服务身份子集
npm run test:backend:full           # backend/tests 下的全部测试（最慢）
npm run build:frontend              # 生产构建产物 + 构建合同检查
```

给贡献者的说明：

- 确定性测试套件**不需要网络**，也**不需要 API 密钥**；它们使用内存中的画像与合成的
  产品库。
- 测试夹具使用明显无效的手机号与 `示例…` / `example.com` 标识。如果某个测试需要机构
  或产品名称，请编一个虚构的——绝不要用真实的。
- 发布说明必须引用在该提交上实测得到的测试数量；绝不要把历史失败基线延续到新版本。
- 当 `shared/productLibrary.json` 在前端与后端的两份拷贝出现漂移时，
  `scripts/verify-repository.mjs` 会失败（见下一节）。

---

## 领域模型说明

- **产品库**（`backend/src/shared/productLibrary.json`，在
  `frontend/src/shared/productLibrary.json` 逐字节镜像）：共 56 个条目，横跨 23 家
  虚构机构。每个条目携带 `id`、`name`、`institution`、`institutionType`、
  `serviceArea`、`category`、`rateText`、`amountText`、`termText`、三个 `tags`、
  `sourceUrl`、`sourceNote` 与一个 `rules` 对象（`minScore`、`maxDebtRatio`、
  `maxQueryCount`、`maxNonBankRatio`、`maxInstitutions`、`allowLianSan`、
  `allowOverdue`，外加可选的偏好/要求标志）。较新的条目还带有 `parentInstitution`、
  `eligibilityText` 与 `requiredMaterials`。
  所有费率/额度/期限字符串都是刻意统一的占位符（`示例…（虚构演示值）`），且每个
  `sourceUrl` 都指向 `https://example.com/...`。
  产品编码形如 `rf_bank_001`、`rf_cf_003`、`rf_card_001`、`rf_bank_s01_001`。
  `matchEngine.js` 按编码查找默认推荐，所以如果你给条目重新编码，请在同一个提交里
  更新那些字面量。
- **证据优先的分析**：数字只能经由规范化证据链到达界面。证据缺失或冲突时产出
  `unknown` / `review_required`，而不是被静默插值出来的值。
- **角色**：`user`、`advisor`、`service`、`publisher` 与 `admin`（另有 `super`
  管理级别）是同一个 Web 应用的权限视图，不是彼此独立的客户端。

---

## 安全姿态

- 机密只从进程环境读取；没有任何东西被打进构建产物。
- `NODE_ENV=production` 下，当 `JWT_SECRET`、`ANALYSIS_CACHE_SECRET`、固定测试账号
  开关或空库引导看起来不对时，启动即失败关闭。见
  `backend/tests/deploymentSecurityBlockers.test.js`。
- 原始报告文本、身份号码、手机号、文件名与服务方响应绝不写入日志、错误信封或缓存键。
- 上传文件与生成的报告存放在源码树之外，并已加入 git 忽略清单。
- 在把它接入任何真实业务流程之前，请先阅读 `docs/security/`，并针对你部署的领域
  自行做法务/合规评审。

---

## 文档

- `docs/PRD.md` — 产品需求与验收标准
- `docs/architecture/` — ADR-0001，双模型信贷分析决策
- `docs/MILESTONES.md` — 项目里程碑与架构决策记录
- `docs/MILESTONES.en.md` — 里程碑记录的英文版
- `docs/contracts/` — 机器可读的 phase-0 与 OCR 合同及其 Schema
- `docs/product/` — PRD 增量
- `docs/security/` — 提供方安全门禁与数据导出评审清单
- `frontend/docs/` — 面向用户的协议文本与 Web API 边界
- `ops/` — 本地运行辅助工具与只读日志分析工具

---

## 许可证

MIT — 见 `LICENSE`。
