# 本地运行资产

源码仓库不保存 `.env`、SQLite、上传文件、日志或 OCR 模型。运行数据必须放在仓库之外，由使用者自行选择稳定目录并保管；本仓库不记录任何具体机器上的路径。

`backup-sqlite.mjs` 使用 SQLite 在线备份 API 捕获 WAL 中尚未合并到主文件的事务，目标文件必须不存在：

```powershell
node .\ops\runtime\backup-sqlite.mjs `
  <源数据库绝对路径> `
  <备份目标数据库绝对路径>
```

迁移后让 `backend/.env` 的 `DATA_DIR` 和 `LOG_DIR` 指向仓库外的稳定目录。秘密值必须由你自己配置，不得打印、写入命令行、提交 Git 或复制到发布制品。
