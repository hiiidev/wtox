# wtox

使用 **原版 Tox 网络**的自托管网页客户端。基于 native c-toxcore + Python/FastAPI + Docker + Caddy HTTPS/WSS。

> **开发状态：** 原生会话、好友和文字消息接口已有代码；Docker 真正构建成功及与 qTox / aTox 的双向互通仍需在 VPS 上验证。暂时只适合可信用户测试，不能视为生产安全版本。

## 登录方式：只用 Tox 身份

网站有两层访问控制：

1. **网站统一访问密码**（`WTOX_ACCESS_PASSWORD`，最少 6 个字符），用于阻止未获授权的人访问网站。
2. **Tox 配置文件是个人登录凭证**：**不再提供网站用户名、个人账号密码或注册表单。**

通过网站密码后：

- **创建新 Tox 身份**：服务器创建独立 Tox ID，浏览器立即下载含私钥的原始 `.tox` 备份，并建立登录会话。
- **使用 `.tox` 登录**：上传自己的原始 Tox Savedata。如果该私钥以前已登记，则进入原身份；否则首次导入并建立新身份。
- **公开 Tox ID 不能登录**：后端利用原生 Toxcore 恢复上传文件，取出私钥的哈希凭证，与服务器原存身份核对；仅比较 Tox ID 是不够的。
- **登录不会覆盖服务器上较新的 Savedata**，以免从旧备份登录时丢失已经更新的好友信息。
- 登录后使用 HttpOnly 的 `wtox_tox_session` 会话 Cookie；注销后需要重新上传 `.tox` 文件。
- 每个 Tox 公钥只属于一个服务器身份，不设固定账号数量（VPS 资源仍有限）。

**重要：`.tox` 文件就是身份私钥。谁拿到这个文件就可能登录为你。** 请单独加密备份，不要在聊天、截图、GitHub 或不受信任网页中传输。只支持原始 Savedata，不能直接使用 qTox/aTox 的其他加密或私有数据库格式。不要在两个 Toxcore 客户端同时运行同一个身份。

浏览器的聊天历史按 **Tox 公钥隔离**，使用**本浏览器自动生成、不可导出的 AES-256-GCM 设备密钥**加密保存至 IndexedDB。同一浏览器登录对应 Tox 身份后自动解锁，**不再单独设置历史口令**。旧版已经按口令加密的历史会保留，第一次升级时需输入旧口令完成一次性本地迁移。设备密钥不会上传 VPS，也不会把公开 Tox ID 直接当成密钥。**同一浏览器配置文件不提供不同 Tox 用户之间的强隔离**；共用设备建议使用不同浏览器用户配置文件。仅有 `.tox` 文件无法把另一台设备的本地历史自动带过来。VPS 使用 AES-256-GCM 加密保存原生 Tox Savedata 和短期消息队列（最长 7 天）；但 VPS 上运行的 Toxcore 能访问密钥及消息明文，此方案并非零知识。

## 好友、发送状态和移动端界面

- 好友列表来自原生 Toxcore，而非暂存在网页中的账号联系人表。添加、接受、删除好友时立即生成并加密保存更新后的 Tox Savedata；重启 wtox 时从其中恢复好友。
- 与好友通信需要 **双方接受关系且建立在线连接**。Toxcore 的错误码 `3` 表示好友未连接。新版界面显示每位好友的「离线 / TCP 在线 / UDP 在线」状态。
- 好友离线时，原版 c-toxcore **不支持直接把文字消息发送给对方**。目前不会伪造发送成功，也**尚未实现出站离线重试队列**；仅在当前页面内保留按好友分开的未发送草稿，刷新后草稿可能丢失。
- **消息状态**：原生 `tox_friend_send_message` 成功返回后显示「已发送」；收到对应好友的 `tox_callback_friend_read_receipt` 回执后升级为「已送达」，并加密更新本地 IndexedDB。**「已送达」是 Tox 客户端协议回执，不代表对方本人已读。** 未收到回执时保留「已发送」，不会伪造已送达状态。
- 回执和消息通过「好友公钥 + 本次原生会话 ID + 原生消息 ID」关联，避免不同好友或进程重启后 ID 重用导致串消息。回执也进入七天加密临时队列，在浏览器历史写入成功后才 ACK。该确认只针对本地历史，换浏览器未同步消息记录时无法还原其他设备上的状态。
- 浏览器界面改为通讯软件布局：桌面左侧搜索/联系人、右侧聊天；手机单栏先显示好友，点击后进入聊天，可返回列表。
- 浏览器历史使用按 Tox 身份区分的本地设备密钥自动加密。建议好友关系发生变化后，从「我的 Tox 身份」**重新下载最新 .tox 备份**；首次创建时下载的旧备份可能缺少后来添加的好友。

**发送仍提示好友离线时：** 先确认对方 qTox/aTox 已接受好友请求并处于在线状态，然后检查 wtox 顶部的 Tox 网络状态是否在线。网站 HTTPS 连通并不代表底层 Tox DHT 已连通；若长时间离线，检查 `WTOX_BOOTSTRAP` 和 VPS 出站 UDP/TCP 网络。

## 聊天记录迁移（qTox / aTox）与附件

- **wtox JSON**：导出本浏览器当前 Tox 身份的文字历史，在另一台设备导入同一 Tox 身份后的浏览器中恢复。它与 `.tox` 身份备份是两个不同文件。
- **qTox TXT**：按所选好友导出或导入 qTox 原生的制表符格式 `日期<TAB>时间<TAB>发送者<TAB>消息`。导入时填写 qTox 导出文件中自己的显示昵称，才能识别消息方向。支持正文含多行文本。qTox 的历史数据库/SQLCipher 文件不在支持范围。
- **aTox**：已确认 aTox 0.8.0 发布了聊天历史导出，但不同导出文件字段结构尚未实测，因此**尚不能保证原生 aTox 导出文件可直接导入**。如果其导出文件符合 qTox 的四列制表符格式可以按 qTox TXT 导入；否则会明确提示不支持。需要实际脱敏样本来补充解析适配。
- 所有历史的导入/导出发生在**浏览器本地**，不会自动上传 VPS 或重新发给 Tox 好友。当前导出为 **明文 JSON/TXT**，请加密保管。重复导入相同记录按内容、时间及好友等字段去重。只处理文字历史，不包含已传输附件或加密数据库。
- **附件收发（实验版）**：使用原生 `tox_file_send`、分块及接收控制，与原版 Tox 文件传输协议对接。单个文件 1 字节至 5 MiB，最多 4 个同时活动的传输。发送双方必须在线；接收方需要手动接受；下载时通过已验证的 HTTPS 登录会话取回临时内存数据。
- 附件数据只在 VPS 内存中临时保存（最多约 15 分钟），不会当作历史文件长期保存，不支持文件断点续传和 VPS 重启恢复。不能保证对方客户端会自动接受文件。
- **实测状态**：Python/JavaScript 接口与测试代码已提交，尚需用真实 qTox/aTox 验证实际文件收发和导出文件兼容性。

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
- `POST /api/tox/create` — 新建原生 Tox 身份，响应下载 `.tox`，写入安全登录 Cookie
- `POST /api/tox/login` — 上传原始 `.tox` 登录或首次导入
- `GET /api/me`、`GET /api/profile/status` — 当前 Tox 身份
- `GET /api/profile/export` — 下载此身份最新备份
- `GET /api/legacy/export` — **仅旧 Cookie 尚未过期时**的一次性迁移辅助导出
- `POST /api/logout` — 退出 Tox 身份
- `GET/POST/DELETE /api/friends`、`POST /api/messages` — 好友及文字消息
- `GET /api/files`、`POST /api/files/send`、`POST /api/files/{id}/accept` / `reject`、`GET /api/files/{id}/download` — 原生 Tox 附件收发
- `GET /api/pending`、`POST /api/ack`、`WS /ws` — 短期消息暂存与实时收发

**旧的 `POST /api/register` 和 `POST /api/login` 已移除。** HTTPS 仅保护浏览器到 VPS 的连接，VPS 上运行的 Toxcore 仍需被你信任。
