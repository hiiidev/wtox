# wtox 附件：当前实现和推荐的离线加密存储方案

## 目前可以做到的事

- **原生 Tox 附件**：发送者浏览器 → HTTPS → **wtox VPS Toxcore** → Tox 网络 → qTox / aTox 好友。反向方向亦然。原生 c-toxcore 运行于 VPS，所以这条通道**无法绕过 VPS**。
- 收发需双方在线，接收须用户确认。每个文件最多 5 MiB，最多 4 个活动传输。
- React 界面在聊天中显示文件气泡、接收/拒绝/下载与进度。PNG、JPEG、WebP、GIF 在本轮收到且暂存有效时直接以浏览器内存 URL 预览；不会执行脚本或信任 SVG 图片。
- 当前 VPS 在内存保留附件数据约 15 分钟，不存文件到数据库或磁盘；浏览器历史仅持久化附件**元数据**，并非附件本体。重启或到期后不能保证继续下载。
- **离线文字接收**已经存在：VPS Toxcore 始终在线时，收到的文字 AES-GCM 加密进入服务器 7 天待领队列；浏览器以后打开会补领。**离线二进制附件收取**尚未实现。

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
