# 日志审计工具

本目录收纳 2026-08-03 主机审计过程中形成的 20 个只读 Node.js 工具。工具不修改日志，读取文件参数或标准输入并输出 JSON；`system/` 保存主机安全与系统服务分析器。

## 使用边界

- 要求 Node.js 20 或更高版本。
- 原始日志、审计输出和截图不得提交 Git；本地输出只写入已忽略的 `.output/`。
- 输出可能包含绝对路径、路由、服务名、消息模板和基础设施元数据，分享前必须人工复核并再次脱敏。
- `analyze_main_ai.js` 会聚合消息文本，`inspect_jsonish_logs.js` 只做有限的值归类，`analyze_crontab.js` 会保留重定向路径；不得把它们的结果视为可公开材料。
- `AUDIT_END` 可固定审计窗口结束时间；未设置时使用当前时间。

示例：

```powershell
Get-Content .\private\journal.jsonl |
  node .\ops\log-audit\system\analyze_journal.js

node .\ops\log-audit\analyze_pm2_logs.js `
  2026-08-01T00:00:00+08:00 .\private\pm2-error.log
```

工具来源目录在完成迁移验收后删除，仓库不保存任何原始服务器日志。
