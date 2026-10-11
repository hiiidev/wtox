# VPS 部署和互通验收（wtox）

**如果 VPS 已经有原生 Caddy，请优先看 [原生 Caddy 专用部署方案](HOST_CADDY.md)，不要执行本页默认带 Docker Caddy 的 `docker compose up`。**

> **状态提示：** 代码已包含原生 Toxcore 会话与 WebSocket/聊天接口，但尚未在干净 VPS 上验证 Docker 构建及 qTox/aTox 双向聊天。请先当作测试实例，**不要直接开放给不受信任的用户**。

## 1. VPS

推荐 Ubuntu 24.04 LTS、1 vCPU、2GB RAM、20GB SSD。为 Caddy 开放入站 TCP 80/443。SSH 的 TCP 22 建议限制为你的管理 IP 或通过已有安全的远程访问方式进入 VPS。Toxcore 使用出站 UDP/TCP；默认无需公网暴露本应用的 6066 端口。

在 VPS 安装 Docker Engine 和 Docker Compose 插件，确认：

```sh
docker --version
docker compose version
```

## 2. 从私有仓库获取代码

使用你自己授权的 GitHub SSH deploy key 或其他安全的克隆方式：

```sh
git clone git@github.com:hiiidev/wtox.git
cd wtox
cp .env.example .env
chmod 600 .env
```

`.env` 里的 **SITE_DOMAIN** 填域名，**WTOX_ACCESS_PASSWORD** 设置独立的随机强密码（最少 6 个字符，但建议使用更长的随机密码）。**WTOX_MASTER_KEY** 为 32 字节随机值的 hex 表示：

```sh
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

注意：两者都不能提交 GitHub、发在聊天里或记录在公开日志中。请单独保存主密钥的离线备份，遗失后无法恢复加密保存的 Tox 私钥。

## 3. 构建验证

```sh
docker compose config -q
docker compose build web
```

`Dockerfile` 的构建过程包含 `python -m backend.tox_smoke`，验证原生 Tox 身份创建、原始 Savedata 恢复、回调注册、离线事件循环、好友列表接口及关闭时持久化。如果构建失败，保留构建日志中的**错误文本**供排查（不要包含任何 `.env` 密码），不要跳过检查。

## 4. 测试部署

```sh
docker compose up -d
docker compose ps
docker compose logs --tail=100 web caddy
```

将 SITE_DOMAIN 指向 VPS，打开 `https://你的域名/`。应该先看到**网站统一访问密码**页面，随后可以创建独立个人账号，再创建或导入原始 `.tox` 配置文件。

如果服务器无法取得自动 HTTPS 证书，请检查域名 A/AAAA 记录、80/443 入站和 Caddy 日志。

## 5. 手工互通验收

1. 在网站创建 **用户 A**，生成并备份新的 Tox ID。
2. 用 qTox（或 aTox 的**另一个**身份）添加用户 A，网站解锁浏览器本地历史后，检查好友请求是否出现。
3. 网站接受好友请求，确认双方都能变为在线。
4. 网站发送「你好，来自 wtox」，检查 qTox/aTox 能接收。
5. qTox/aTox 回发消息，检查网站显示且加密存入 IndexedDB。
6. 关闭浏览器但保持 VPS 运行，使用另一客户端发消息；随后重新打开网页、解锁历史，确认临时消息可以领取并从服务器队列删除。
7. 创建 **用户 B**，验证账号隔离、不同 Tox ID、不可读取 A 的身份备份。
8. `docker compose restart web`，验证 A、B 的 Tox ID、好友列表仍能恢复。

同一 Tox ID **不能同时在 aTox 和 wtox 两个独立 Toxcore 实例上运行**，否则可能出现在线状态和消息问题。只导入原始 Tox Savedata，不支持直接导入加密客户端数据库、聊天历史等其他格式。

## 6. 备份及安全

- Docker 命名卷 `wtox_data` 保存 SQLite 数据库、Tox Savedata 密文及临时消息。务必定期做加密备份，并验证恢复流程。
- 只保存数据库是不够的：必须与 `WTOX_MASTER_KEY` 配套保存，**密钥与备份分开存放**。
- 浏览器 IndexedDB 是本地聊天记录的唯一长期副本；清理浏览器站点数据可能丢失历史。历史导出功能仍待开发。
- 不要使用 `docker compose down -v`，因为这会删除命名卷中的身份数据。
- 本项目没有针对公网用户开放的正式安全审计；目前建议仅供 2–3 名信任用户测试。

## 7. 故障排查

| 表现 | 排查 |
|---|---|
| HTTP/HTTPS 无法访问 | DNS、80/443 防火墙、Caddy 日志 |
| Tox 显示离线 | WTOX_BOOTSTRAP 节点是否有效、VPS 出站 UDP/TCP、Tox 日志 |
| 导入 .tox 失败 | 文件是否为原始 Tox Savedata，非客户端数据库或加密容器 |
| 好友在线但发消息报错 | 对方是否添加/接受请求、是否正常连接 Tox 网络 |
| 刷新网页后无历史 | 是否在**相同浏览器**解锁了正确本地历史口令 |
| 容器启动失败 | `docker compose logs --tail=200 web`（分享前检查敏感信息） |

## SSH

当前 GitHub 连接只用于读取/写入私有仓库。本聊天环境没有可用的 SSH 远程执行连接，**无法直接登录你的 VPS 或在 VPS 上替你运行命令**。在 VPS 上操作使用你自己的 SSH 客户端，不要将服务器密码、私钥或完整 `.env` 粘贴到聊天里。
