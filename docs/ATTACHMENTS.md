# wtox 附件：当前实现和推荐的离线加密存储方案

## 目前可以做到的事

- **原生 Tox 附件**：发送者浏览器 → HTTPS → **wtox VPS Toxcore** → Tox 网络 → qTox / aTox 好友。反向方向亦然。原生 c-toxcore 运行于 VPS，所以这条通道**无法绕过 VPS**。
- 收发需双方在线，接收须用户确认。每个文件最多 5 MiB，最多 4 个活动传输。
- Ant Design X 界面在聊天中显示文件气泡、接收/拒绝/下载与进度。PNG、JPEG、WebP、GIF 在下载后会使用当前 Tox 身份专属的不可导出 AES-GCM 设备密钥加密缓存到浏览器 IndexedDB，7 天后自动清理；SVG 不作为图片直接预览。
- 未配置 WebDAV 时，VPS 在内存保留附件本体约 15 分钟；浏览器历史保存加密元数据，已下载图片额外可在本浏览器缓存 7 天。配置 HTTPS WebDAV 后，接收完成的文件会在后台加密归档到 WebDAV，最长保存 7 天，到期每小时清理；运行时明文会经过 VPS Toxcore。
- **离线文字接收**已经存在：VPS Toxcore 始终在线时，收到的文字 AES-GCM 加密进入服务器 7 天待领队列；浏览器以后打开会补领。**离线二进制附件收取**尚未实现。

## 可选的 WebDAV 加密归档（已提供基础实现）

你可以使用 Nextcloud、坚果云等支持标准 WebDAV PUT/GET/DELETE 的服务，在 VPS 的 `.env` 增加：

```env
WTOX_WEBDAV_URL=https://dav.example.com/path/to/existing/wtox-folder/
WTOX_WEBDAV_USERNAME=your-webdav-account
WTOX_WEBDAV_PASSWORD=your-app-password
```

**必须事先创建独立的 WebDAV 文件夹，使用 HTTPS，并确保服务支持 PUT、GET、DELETE。** 建议使用权限受限的专用应用密码。WebDAV 配置错误会导致服务启动时明确报错；不设置这些变量则继续使用内存附件模式。

接收完成后，wtox 后台将文件用现有 `WTOX_MASTER_KEY` 派生的 AES-GCM 配置加密上传，WebDAV 无法直接看到原始文件内容或文件名。真实文件名以 AES-GCM 保存到 VPS SQLite，远端路径使用随机内部标识。未过期时，内存附件消失后可以从 WebDAV 读取密文、在 VPS 验证 AES-GCM 后下载。

后台每 1 小时检查过期记录，**归档时间超过 7 天后删除 WebDAV 远程密文与数据库索引**。即使 WebDAV 暂时故障，过期记录也会被拒绝下载，且清理会反复重试。远程删除属于尽力而为，WebDAV 提供商备份与快照的保留期仍由提供商决定。

**限制：** 目前是接收完成后由 VPS 异步归档，不是浏览器直传；不能绕过 VPS 的 Tox 数据通道。也不意味着支持 qTox/aTox 离线附件协议，原生文件收发双方仍需在线。

## 浏览器直连临时对象存储（未来可选附件模式）

建议优先选支持 S3 API 的 **Cloudflare R2**，也可选 AWS S3、Backblaze B2、Supabase Storage。设计目标是**加密文件不经过 wtox VPS 带宽**，而不是宣称不经过服务端 Toxcore。

建议流程：

1. 发送者浏览器用 WebCrypto 随机生成每文件唯一 **AES-256-GCM 密钥与 nonce**，在浏览器内加密文件，文件名等敏感元数据也应加密。不要把 Tox ID、用户密码当成加密密钥。
2. VPS 或受信任的 Worker **仅签发短期、单对象的 PUT URL**，不得把 R2/S3 管理密钥给浏览器。浏览器使用 CORS 许可，直接把**密文** PUT 至对象存储；VPS 不转发文件本体。
3. 发送者通过原有 Tox 消息通道把版本化加密附件描述（对象 ID、短期下载方式、密钥、nonce、SHA-256、大小、失效时间）送给收件人。Tox 加密保护这一小段消息。
4. 收件人浏览器以短期 GET URL 下载密文，在本地验证 SHA-256 并 AES-GCM 解密，然后以 Blob URL 预览/下载；不自动执行文件。
5. 对象存储设置 **7 天生命周期自动删除**和按身份/总容量配额，避免免费 API 滥用与匿名永久托管。**签名链接到期与对象真正删除是两件事**。页面应清晰标示失效时间；想长期保存的用户需自行下载/导出加密备份。

**兼容性限制**：qTox/aTox 可以收到普通 Tox 文本链接，但不能自动识别 wtox 私有的加密附件 JSON 协议，也无法用此机制原生接收“qTox 文件传输”回调。若希望原生 qTox/aTox 附件无缝兼容，仍须使用现有 Tox 文件传输路径。

**隐私限制**：对象存储只拿到密文；然而当前 Tox 消息由 VPS 上的原生 Toxcore 处理，因此 VPS 在运行时能够读取用于解密的消息内容，**不能称为对 VPS 的真正零知识附件传输**。要做到此目标，需要把完整 Tox 协议及密钥留在浏览器/客户端（例如以后实现独立 browser Toxcore/WASM）。

## 当前状态

第三方临时附件存储**仅是设计方案，本仓库目前没有启用 R2/S3 上传 API**，也没有索取或存入任何存储厂商凭证。实现前应先确定供应商、预算和生命周期，随后增加签名 URL、最小权限、配额、限速和 E2E 文件完整性验证。

官方参考：
- Cloudflare R2 S3 预签名 URL： https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 自动删除规则： https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- R2 CORS： https://developers.cloudflare.com/r2/buckets/cors/
- AWS S3 预签名 URL： https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
- Supabase Storage 签名上传： https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl
