# wTox

使用 **原版 Tox 网络**的自托管网页客户端。基于 native c-toxcore + Python/FastAPI + Docker + Caddy HTTPS/WSS。

> **开发状态：** 原生会话、好友和文字消息接口已有代码；Docker 真正构建成功及与 qTox / aTox 的双向互通仍需在 VPS 上验证。暂时只适合可信用户测试，不能视为生产安全版本。

## 登录方式：只用 Tox 身份

网站有两层访问控制：

1. **网站统一访问密码**（`WTOX_ACCESS_PASSWORD`，最少 6 个字符），用于阻止未获授权的人访问网站。
2. **Tox 配置文件是个人登录凭证**：**不再提供网站用户名、个人账号密码或注册表单。**

通过网站密码后：

- **创建新 Tox 身份**：输入非空备份密码（不设固定最少位数）后，服务器生成独立 Tox ID；浏览器立即下载采用标准 ToxEncryptSave 加密的 `.tox` 文件，并建立登录会话。备份密码不会保存在服务器，丢失密码将无法解密该份备份。
- **使用 `.tox` 登录**：可上传原始 Tox Savedata，也可上传兼容 ToxEncryptSave 的加密 `.tox`，后者需提供对应的备份密码。密码仅用于这次导入的文件解密，不成为网站登录密码；历史未加密备份仍可导入。如果该私钥已登记则进入原身份，否则首次导入。
- **公开 Tox ID 不能登录**：后端利用原生 Toxcore 恢复上传文件，取出私钥的哈希凭证，与服务器原存身份核对；仅比较 Tox ID 是不够的。
- **登录不会覆盖服务器上较新的 Savedata**，以免从旧备份登录时丢失已经更新的好友信息。
- 登录后使用 HttpOnly 的 `wtox_tox_session` 会话 Cookie；注销后需要重新上传 `.tox` 文件。
- 每个 Tox 公钥只属于一个服务器身份，不设固定账号数量（VPS 资源仍有限）。

**重要：`.tox` 文件含身份私钥。** 新创建及通过设置导出的备份使用标准 ToxEncryptSave 加密，请同时保管好加密备份和密码，切勿向他人分享。加密的 `.tox` 可与支持该标准的 Tox 客户端互通，但 **aTox/qTox 的应用专有数据库及聊天历史格式不等于 `.tox`**。不要同时在两个 Toxcore 客户端运行同一个身份。

浏览器的聊天历史按 **Tox 公钥隔离**，使用**本浏览器自动生成、不可导出的 AES-256-GCM 设备密钥**加密保存至 IndexedDB。同一浏览器登录对应 Tox 身份后自动解锁，**不再单独设置历史口令**。旧版已经按口令加密的历史会保留，第一次升级时需输入旧口令完成一次性本地迁移。设备密钥不会上传 VPS，也不会把公开 Tox ID 直接当成密钥。**同一浏览器配置文件不提供不同 Tox 用户之间的强隔离**；共用设备建议使用不同浏览器用户配置文件。仅有 `.tox` 文件无法把另一台设备的本地历史自动带过来。VPS 使用 AES-256-GCM 加密保存原生 Tox Savedata 和短期消息队列（最长 7 天）；但 VPS 上运行的 Toxcore 能访问密钥及消息明文，此方案并非零知识。

### 好友资料（桌面和手机）

- 点击聊天顶部或收到消息旁的好友头像，打开 **Ant Design 好友资料**：昵称、Toxcore 报告的 TCP/UDP 连接、在线/离开/忙碌、原生状态消息，以及可复制的好友标识。
- 只有当用户通过完整 **76 位 Tox ID** 添加好友时，wTox 才会在 AES-GCM 加密的账户数据中保存该原始完整 ID。通过好友请求接受的好友通常只能从 Toxcore 读取 **64 位公钥**，界面明确标为「好友公钥」并支持复制，不能虚构剩余的 NoSpam 和校验位。
- **桌面端** 使用 Ant Design Modal；**移动端（屏宽小于 768px）**使用从底部升起的 Drawer，包含安全区间距，可点按关闭。手机底部「设置」是独立设置页面，桌面设置继续使用弹窗。

## React 界面、原生 Tox 资料和 VPS 离线消息

- 品牌及网页标题统一为 **wTox**；前端采用 React、Ant Design、Ant Design X，保留原生 c-toxcore/FastAPI 后端、既有 Tox 身份、6066 端口和宿主机 Caddy。
- **文字消息全部通过 VPS 加密队列发送，不再有浏览器/VPS 队列切换开关。** 发送后显示「正在发送」；后台任务每约 3 秒检查，好友已连接时交给 Toxcore，显示「已发送」；收到对方客户端 Tox 回执显示「已送达」（不代表真人已读）。关掉网页不会停止 VPS 队列。
- 每个 Tox 身份最多等待 250 条消息，7 天后仍未发送的消息过期；服务器队列正文使用 AES-GCM 加密。若服务器在发送途中崩溃、无法确认结果，记录为「发送结果待确认」，不会盲目重发。升级时原浏览器 `queued_local` 消息在下次登录后迁入服务器队列。
- **修改昵称、状态消息与状态**：点击当前身份头像打开独立资料弹窗，可修改 Tox 原生的昵称（最多 128 UTF-8 字节）、状态消息（最多 1007 字节）以及在线/离开/忙碌，并立即保存到加密的 .tox 身份配置。登录后读取现有配置，不重建身份。
- **在线状态和消息补领**：好友列表每 12 秒刷新，浏览器每 8 秒领取未确认消息和回执；WebSocket 自动重连，手机网页恢复前台会立即同步。
- **离线收文字**：浏览器关闭期间，只要 VPS 的 Toxcore 持续在线，收到的文字加密暂存在服务器待领队列，最多保留 7 天。附件仍由双方在线进行原生 Tox 文件传输；可选 WebDAV 仅用于接收后加密归档，并非 Tox 协议的离线附件传输。
- 保留原本浏览器 IndexedDB 的加密历史和旧版口令迁移（只在需要时提示）。设置页面不再显示重复的「已自动解锁」技术说明。

**正在使用的 VPS 升级提示：** 保留 `.env`、`WTOX_MASTER_KEY` 和 Docker 数据卷，先备份再构建。宿主机 Caddy 继续反代 `127.0.0.1:6066`，不需更改端口。

## 好友、发送状态和移动端界面

- 好友列表来自原生 Toxcore，而非暂存在网页中的账号联系人表。添加、接受、删除好友时立即生成并加密保存更新后的 Tox Savedata；重启 wtox 时从其中恢复好友。
- 与好友通信需要 **双方接受关系且建立在线连接**。Toxcore 的错误码 `3` 表示好友未连接。新版界面显示每位好友的「离线 / TCP 在线 / UDP 在线」状态。
- 好友离线时，原版 c-toxcore **不支持直接发给对方**。wTox 会自动把所有文字消息加密入 VPS 队列，由服务器等待好友上线。
- **消息状态**：原生 `tox_friend_send_message` 成功返回后显示「已发送」；收到对应好友的 `tox_callback_friend_read_receipt` 回执后升级为「已送达」，并加密更新本地 IndexedDB。**「已送达」是 Tox 客户端协议回执，不代表对方本人已读。** 未收到回执时保留「已发送」，不会伪造已送达状态。
- 回执和消息通过「好友公钥 + 本次原生会话 ID + 原生消息 ID」关联，避免不同好友或进程重启后 ID 重用导致串消息。回执也进入七天加密临时队列，在浏览器历史写入成功后才 ACK。该确认只针对本地历史，换浏览器未同步消息记录时无法还原其他设备上的状态。
- 浏览器界面改为通讯软件布局：桌面左侧搜索/联系人、右侧聊天；手机单栏先显示好友，点击后进入聊天，可返回列表。
- 浏览器历史使用按 Tox 身份区分的本地设备密钥自动加密。建议好友关系发生变化后，从「我的 Tox 身份」**重新下载最新 .tox 备份**；首次创建时下载的旧备份可能缺少后来添加的好友。

**发送仍提示好友离线时：** 先确认对方 qTox/aTox 已接受好友请求并处于在线状态，然后检查 wtox 顶部的 Tox 网络状态是否在线。网站 HTTPS 连通并不代表底层 Tox DHT 已连通；若长时间离线，检查 `WTOX_BOOTSTRAP` 和 VPS 出站 UDP/TCP 网络。

## 聊天窗口与布局

- 消息显示区域使用居中最大宽度，不再在超宽桌面窗口里把双方消息挤在一侧。右侧发送消息右对齐，左侧好友消息带头像；页面仍以 Ant Design Token 为颜色来源。
- `Sender` 左侧回形针支持选文件和粘贴附件；选中后通过 `Sender.Header` 显示 Ant Design X `FileCard`，确认发送后立即在聊天记录中出现附件气泡。已下载图片在文件卡片上方使用 Ant Design `Image` 预览，点击可打开图片查看器。
- 桌面和手机聊天区独立滚动，滚动条颜色跟随浅色／深色主题，空闲时隐藏、滚动时短暂显示；输入栏在底部，手机包含安全区间距。
- 设置页用 Ant Design Card 分组，去除重复技术说明；本人资料弹窗简化成 ID 与原生设置表单，保存成功后自动关闭；手机底部独立设置页不再显示额外的大头像卡片。

## 聊天记录与附件

- **wTox JSON**：支持导出与导入本地文字聊天记录；换设备可手动迁移。这是 wTox 自己的格式，不是 .tox 身份配置文件。
- **aTox**：aTox v0.8.0 已加入聊天历史导出功能，但目前未验证其实际导出字段和是否支持反向导入；不把 wTox JSON 误称为 aTox 原生格式。待取得可公开的脱敏 aTox 导出样本后，可另外实现正确转换。
- 已移除旧版 qTox TXT 专用导入和导出入口。所有导出记录仍是**明文**，必须自行加密保管；不会自动发给好友。
- **附件**：Toxcore 原生文件收发需双方在线；文件请求、进度、图片预览在 Ant Design X 聊天气泡中显示；附件按钮使用 Sender 的前缀和预览面板，已发送附件立即写入加密本地历史。图片下载后可使用 AES-256-GCM 加密缓存在当前浏览器 IndexedDB，7 天后清理。
- **WebDAV 可选归档**：接收完成后将附件 AES-GCM 加密上传到你自己的 HTTPS WebDAV，服务端每小时清理超过 7 天的归档，并拒绝下载已过期文件。未配置 WebDAV 时继续使用临时内存附件。
- 设置中可选择「跟随系统／浅色／深色」，首次默认跟随操作系统设置；桌面右键或移动端长按消息可删除**本机历史记录**，不会撤回对方已有的消息。

## 可选 WebDAV 附件归档（服务器定时清理）

只有当 VPS 的 `.env` 配置 `WTOX_WEBDAV_URL`、`WTOX_WEBDAV_USERNAME`、`WTOX_WEBDAV_PASSWORD` 后才会启用。要求 HTTPS 和提前建好的专用 WebDAV 目录。示例见 `.env.example` 与 [附件存储设计](docs/ATTACHMENTS.md)。

- WebDAV 收到的始终是用 **WTOX_MASTER_KEY** 加密的附件密文；真实文件名另用 AES-GCM 加密保存在 VPS SQLite 中，远端路径只包含内部 Tox 账户 UUID 和附件 UUID。
- 服务器每小时执行过期清理，保留期 **7 天**；即使远端 DELETE 失败，过期文件也立即拒绝通过 wtox 下载，并会在下次清理重试。
- 归档异步进行：刚接收完成的文件先在 VPS 内存可下载，WebDAV 上传成功后才能作为归档读取。若上传失败，仍维持现有内存模式并记录日志，不会谎报归档成功。
- WebDAV 凭据只放 VPS `.env`，不能输入到网页或提交 GitHub。**不要改动现有 WTOX_MASTER_KEY**，否则已经归档的文件无法解密。

## 已装原生 Caddy 的 VPS（你的部署方式）

具体配置见 [宿主机原生 Caddy 部署文档](docs/HOST_CADDY.md)。Docker 只运行 wtox，使用本机端口 **6066**；Caddy 负责外部 443 HTTPS/WSS。

**升级既有安装时：不要复制示例文件覆盖正在使用的 `.env`，也不要删 Docker 卷。** 确保现有 `WTOX_MASTER_KEY` 不变，否则旧身份无法解密。

```bash
cd wtox
git pull
docker compose -f compose.host-caddy.yml up -d --build
curl -fsS http://127.0.0.1:6066/health
```

Caddy 对应的站点配置：

```caddyfile
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:6066
}
```

将域名改成你自己的。**不需要对公网开放 6066。** 已有 Caddy 的服务器不要运行默认带另一个 Caddy 的 `docker compose up`。

没有安装原生 Caddy 的 VPS 仍可使用默认 `compose.yml` 中的 Docker Caddy 方案。

## 从旧“用户名/密码”版本升级

旧的 `accounts`、`sessions` 和消息表不会自动被删除，因此以前加密保存在服务器的 Tox 身份、好友及未领取消息可以继续使用。

- **已有 `.tox` 备份**：部署新版后直接上传，进入原来的身份（按 Tox 公钥匹配）。
- **还没有备份但浏览器仍持有未过期的旧 `wtox_session` Cookie**：新版登录页底部有“以前用网站账号登录过？”→“下载旧登录会话中的 .tox 备份”。下载后使用新入口上传。
- **旧登录会话已过期且没有 `.tox` 备份**：不要删 SQLite 数据库或主密钥；需要由服务器管理员安全地离线恢复，而不是重新注册一个同名账号。新版本不接受旧用户名密码登录。
- 以前按网站用户名命名的浏览器本地 IndexedDB 历史不会被删除，**但不会自动映射到新的 Tox 公钥历史库**。在实现本地历史迁移前不要清除浏览器站点数据。

强烈建议先对 `wtox_data` 命名卷及 `.env` 主密钥分别做安全备份。**不要运行 `docker compose down -v`。**

## 基础要求

建议 Ubuntu 24.04 LTS，1 vCPU / 2 GB RAM / 20 GB SSD（尚未实测容量上限），Docker Compose、可用域名和 Caddy。站点 HTTPS 需要 80/443，Tox 网络需要出站 UDP/TCP。

- [VPS 部署和真实客户端验收](docs/DEPLOY.md)
- [当前进度](docs/MILESTONES.md)
- [浏览器原生 WASM 研究：暂缓](docs/BROWSER_ONLY.md)

### API 概览

- `POST /api/gate/login` — 网站统一访问密码
- `POST /api/tox/create` — JSON 包含 `password`，下载原生 ToxEncryptSave 加密的 `.tox`，写入安全登录 Cookie
- `POST /api/tox/login` — 上传原始 `.tox` 登录或首次导入；加密备份采用前置 UTF-8 密码字节、以 `X-Tox-Password-Bytes` 标注字节数的二进制请求体
- `GET /api/me`、`GET /api/profile/status` — 当前 Tox 身份
- `POST /api/profile/export/encrypted` — JSON 包含 `password`，下载最新身份的标准加密 `.tox` 备份（推荐）。
- `GET /api/profile/export` — 旧版兼容的原始未加密备份 API，仅限已登录身份；前端不再使用
- `GET /api/legacy/export` — **仅旧 Cookie 尚未过期时**的一次性迁移辅助导出
- `POST /api/logout` — 退出 Tox 身份
- `GET/POST/DELETE /api/friends`、`POST /api/messages` — 好友及文字消息
- `GET /api/files`、`POST /api/files/send`、`POST /api/files/{id}/accept` / `reject`、`GET /api/files/{id}/download` — 原生 Tox 附件收发
- `GET /api/pending`、`POST /api/ack`、`WS /ws` — 短期消息暂存与实时收发

**旧的 `POST /api/register` 和 `POST /api/login` 已移除。** HTTPS 仅保护浏览器到 VPS 的连接，VPS 上运行的 Toxcore 仍需被你信任。
