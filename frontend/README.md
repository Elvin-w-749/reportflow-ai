# 分析报告工作台 Web 前端

这是全栈仓库中的旧版浏览器 Web 前端子项目，也是本项目唯一客户端。它只构建并发布到旧版 Web 空间，不包含 Android、iOS、原生 App、小程序、最新版后端、数据库、上传文件或任何密钥。

同一套页面覆盖宽屏桌面浏览器和窄屏手机浏览器，并保留微信内置浏览器兼容路径。移动端 Web 的响应式布局、触摸交互、安全区和文件上传仍属于发布门禁。

## 接口边界

- 浏览器构建的 API origin 由构建期环境变量 `RPT_PROXY_BASE`（值为完整 origin）指定；未设置时产物默认指向本机 `http://127.0.0.1:3200/legacy-api`，仓库不写死任何公网域名。
- 上传文件必须经旧版 /legacy-uploads 路径返回。

## 本地命令

- npm ci
- npm test
- npm run build:legacy
- npm run verify:build
- npm run package:legacy

build:legacy 会强制使用旧版 Web API 基址，并在构建后扫描产物。验证失败时不可发布。
package:legacy 只打包已验证的 dist 和无敏感信息的发布证明。

## 本地开发认证

前端伪登录默认关闭，并且只允许在 Vite 开发模式的回环地址启用。复制 `.env.example`
为 `.env.local` 后，仅可填写专用的本地模拟值；不要填写服务器账号的真实口令。
所有 `VITE_*` 值都可能出现在浏览器代码中，不能作为生产密钥使用。

## 发布原则

发布只允许写入旧版静态资源 release 目录，并通过 current 软链接原子切换。不得修改最新版进程、数据库、上传目录或其发布目录。
