# wTox 附件：原生 Tox + VPS 本地硬盘加密暂存

## 实际传输路径

- 发送：浏览器通过 HTTPS 上传给自有 VPS 的 Toxcore，VPS 通过原生 Tox 文件协议向在线好友发送。
- 接收：好友通过原生 Tox 文件协议发送给 VPS，只有浏览器点击接受后才接收；完成后由浏览器通过 HTTPS 下载。
- Toxcore 仍在 VPS，因此不等于浏览器设备直接到好友设备的端到端传输，也不能声称 VPS 无法访问明文。与 qTox/aTox 的原生文件协议兼容。
- 双方 Tox 必须在线才能传输，每文件最多 5 MiB，最多同时 4 个进行中的传输。

## 本地磁盘存储

- 在 `WTOX_DATA_DIR/tox-attachments/` 存储随机账户 ID 和附件 UUID 目录。
- 文件按 64 KiB 分块，每块使用 `WTOX_MASTER_KEY` 的 AES-256-GCM 随机 nonce 加密。文件名以单独的 AES-GCM 密文保存于 SQLite。
- 接收和上传的文件内容不长期保留成单个 Python `bytes` / `bytearray`；传输回调按块写入并按需解密读取。运行时的 Tox 及 HTTPS 处理仍会出现短暂明文。
- 完整接收的文件只有登录对应 Tox 身份后才可下载，支持服务器重启后使用原附件 ID 下载。
- 最长保存 7 天。过期立即拒绝下载，后台在启动时及每小时删除过期文件和索引，中断传输留下的临时目录也会在 7 天后清理。
- 浏览器另外可能按身份加密缓存已下载图片（IndexedDB，7 天）；此浏览器缓存与 VPS 磁盘暂存独立。

## 部署与旧 WebDAV 数据

新版**不再连接 WebDAV**，不需要 `WTOX_WEBDAV_URL`、`WTOX_WEBDAV_USERNAME` 或 `WTOX_WEBDAV_PASSWORD`。

旧版本已经归档在远端 WebDAV 的文件**不会自动迁移或远程删除**。请先从旧系统保存仍需要的附件，并自行到 WebDAV 服务端删除旧文件；否则它们仍可能占用远端空间。

升级时必须保留现有 `WTOX_MASTER_KEY` 和挂载 `WTOX_DATA_DIR` 的持久数据卷，避免无法读取已加密身份和附件。不要执行 `docker compose down -v`。

这里的 7 天规则是最长保留期限，不是保证 7 天内所有文件都可用：服务器故障、磁盘损坏和账户删除都可能使文件提前不可用。请及时下载重要附件。
