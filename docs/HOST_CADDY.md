# 已安装原生 Caddy 的 VPS：部署 wtox

此模式直接使用 VPS 上已由 systemd 管理的 Caddy，**不再启动第二个 Docker Caddy**，避免容器抢占 80/443。Docker 仅承载 Web API、SQLite 和原生 Toxcore。

```
Browser --HTTPS/WSS--> Host Caddy (:80/:443)
                            |
                   http://127.0.0.1:6066
                            |
                     Docker wtox-web
                            |
                  Original Tox network
```

## 1. 配置 wtox（私有仓库）

```bash
gh repo clone hiiidev/wtox    # 如果已经克隆，改为进入仓库后 git pull
cd wtox
test -f .env || cp .env.example .env
chmod 600 .env
nano .env
```

首次部署时设置独立随机的 `WTOX_MASTER_KEY`（32 字节，64 位 hex）。可用 `python3 -c 'import secrets; print(secrets.token_hex(32))'` 生成 master key。不要提交或泄露 `.env`。主密钥务必离线备份。

`SITE_DOMAIN` 对宿主机 Caddy 模式不是必需字段，但填入实际域名便于切换部署方案。

**升级旧版本时不要覆盖已存在的 `.env`，尤其不能更换 `WTOX_MASTER_KEY`。在重建容器前备份 `wtox_data` 数据卷。新版不再使用网站用户名和个人账号密码，改为下载/上传 `.tox` 配置创建或登录身份；旧登录 Cookie 尚有效时可在新页面导出原身份备份。**

## 本次 React 与离线队列升级

本次升级保留原生 Caddy 和宿主机 `127.0.0.1:6066` 端口。新增 React/Vite 前端构建阶段，需要 Docker 能访问 npm 包仓库；**不需要在宿主机额外运行 Node.js 进程**。

- 现在**所有文字发送默认进入 VPS 加密队列**。不再有浏览器/VPS 选择开关；即使关闭网页，服务器后台仍每约 3 秒检查待发消息，好友上线后通过 Toxcore 发送。
- 升级后遗留在浏览器加密 IndexedDB 的旧待发记录会在下次登录时迁入 VPS 队列。服务器暂存待发消息最多 7 天。
- 好友状态每 12 秒刷新；未领取消息和发送状态每 8 秒检查；手机从后台回到网页会立即同步。
- 「设置与备份」集中管理 Tox 昵称、状态消息、在线/离开/忙碌、身份导出、历史迁移与导入导出及注销。
- 发送中断的结果不确定时不会自动重试，避免消息被重复发送。
- 已有 `.env`、`WTOX_MASTER_KEY` 和 `wtox_data` 数据卷不能覆盖或删除。

**建议先执行构建检查，再替换运行容器：**

```bash
cd wtox
git pull
docker compose -f compose.host-caddy.yml build web
docker compose -f compose.host-caddy.yml up -d --no-build
curl -fsS http://127.0.0.1:6066/health
curl -fsS http://127.0.0.1:6066/health/ui
```

Docker 构建阶段会编译 React 静态文件并执行原生 Toxcore 自检。如果失败，不应跳过构建检查；请保留错误日志中的非敏感文本。

## 2. **只运行 wtox Web 容器**

```bash
docker compose -f compose.host-caddy.yml config -q
docker compose -f compose.host-caddy.yml up -d --build
docker compose -f compose.host-caddy.yml ps
curl -fsS http://127.0.0.1:6066/health
```

验证返回 `{"ok":true}` 后继续。原生 c-toxcore 在镜像构建过程中执行自检；目前构建及真实互通尚未经过 VPS 验收，如果失败不要跳过自检。

如果之前启动过 **Docker Caddy**，在项目目录中只停用该服务：

```bash
docker compose stop caddy
docker compose rm -f caddy
```

**不要运行 `docker compose down -v`**，那会删除用户的 SQLite 和 Tox 身份命名卷。不要停止服务器原生 Caddy。Docker 容器上的 6066 只绑定 `127.0.0.1`，不对公网开放。

如果宿主机 6066 已被占用，在 `compose.host-caddy.yml` 把前面的 `6066` 改成 `18080`，并将后文 Caddy 上游一并改为 `127.0.0.1:18080`。

## 3. 修改**宿主机原有 Caddyfile**

通常位置：`/etc/caddy/Caddyfile`。保留已有站点配置，在文件中增加一个子域名站点（这里举例 `tox.example.com`）：

```caddyfile
tox.example.com {
    encode zstd gzip
    request_body {
        max_size 16MB
    }
    reverse_proxy 127.0.0.1:6066
    header {
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "DENY"
        Permissions-Policy "camera=(self), microphone=(self), geolocation=()"
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
    }
}
```

此 `request_body` 指令需要 **Caddy 2.10 或更新版本**。请先确认
`caddy version`；如果版本过旧，先升级 Caddy 再应用该片段。
宿主机模式**不会**自动加载仓库根目录 `Caddyfile`。

`reverse_proxy` 原生支持 WebSocket Upgrade，**不用额外写 /ws 的代理规则**。如果域名对应的站点块已经存在，就在现有块内添加 `reverse_proxy`，不要再创建重复的域名块或覆盖其他网站路由。没有单独域名时建议新建子域名以避免现有网站路径冲突。

确认 DNS A/AAAA 记录指向正确 VPS，公网可达 80/443，然后：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

验证 HTTPS：

```bash
curl -I https://tox.example.com/
```

然后通过浏览器进入 `https://tox.example.com/`，正常情况会直接显示 .tox 身份创建／导入界面，无需网站入口密码。

## 4. 常用排查

```bash
sudo ss -lntp | grep -E ':(80|443|6066)\\b'
docker compose -f compose.host-caddy.yml logs --tail=100 web
sudo journalctl -u caddy -n 100 --no-pager
```

- 502 Bad Gateway：Web 容器未启动、主机 6066 映射错误、应用健康检查失败。
- TLS 证书申请失败：DNS 或公网 80/443 配置问题。
- Caddy reload 报错：先修复配置，不要重启所有现有站点。
- 好友长期离线：检查 `WTOX_BOOTSTRAP` 和 VPS 出站 UDP/TCP；Caddy 只代理浏览器连接，不代理原版 Tox UDP。

## WebSocket 一直重连、但消息还能收发

此时网页的 `GET /api/friends`、`GET /api/pending` 等 HTTP 轮询仍在工作，**不等于 `wss://域名/ws` 握手成功**。新版前端连续失败后会显示「轮询中」、逐步降低重连频率（最长约 60 秒），不会弹出反复的连接提示。实时事件可能比 WebSocket 正常时延迟。

按顺序检查，不需要清理 Cookie、IndexedDB 或 Tox 身份：

1. 浏览器开发者工具 → Network → WS → `/ws`。正常状态是 **HTTP 101 Switching Protocols**；如果是 403，检查鉴权和 Origin；404/400 常见于代理路径或升级头，502/503 则先查上游。浏览器 WebSocket JavaScript API 本身不能读取失败握手的详细 HTTP 响应。
2. 登录后请求 `/api/me` 能返回 200 说明普通 HTTP 的 Tox 身份 Cookie 有效，但**不能据此证明 WebSocket 的 Origin/Host 或反向代理 Upgrade 已配置正确**。
3. 在 VPS 上检查（不要将密码、Cookie 或完整令牌发到聊天中）：

```bash
docker compose -f compose.host-caddy.yml logs --tail=200 web | grep -E 'wTox /ws upgrade denied|WebSocket| /ws'
sudo journalctl -u caddy -n 120 --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile
```

后端拒绝握手时只记录原因类别：
- `site_access_required`：网站入口 Cookie 未通过检查；
- `tox_session_missing_or_expired`：Tox 会话不存在或已过期；
- `origin_host_mismatch`：浏览器发来的 Origin 与应用收到的 Host 不一致，需要检查代理是否保留**公网域名 Host**、URL 的 HTTPS、以及是否存在多层代理。
- **没有上述日志且 Network 返回非 101**：重点检查请求是否实际到达了 wTox 的 `/ws` 路由，尤其是 Caddy、CDN、WAF 对 WebSocket Upgrade 的处理。

宿主机 Caddy 一般只需 `reverse_proxy 127.0.0.1:6066`，本身会自动处理 WebSocket。不要将 `/ws` 改写到其他路径，也不要为了排除错误关闭 WebSocket 的网站门禁、Tox 会话验证或 Origin 检查。若使用 CDN，确认该服务允许 WebSocket 并正确转发 Host/Upgrade。

## 安全与数据

wtox 首页无需网站入口密码；个人资料、好友、消息和附件 API 均需要 Tox 身份会话。不要通过公网 `http://VPS-IP:6066` 暴露应用。VPS 中的 Toxcore 仍能访问身份私钥和收发明文，不是零知识服务器。

用户 2–3 人时只需这一个 VPS。纯浏览器 WASM 暂不开展。

## React 页面空白 / CSS 404 排查（2026-10 修复）

如果 `docker compose ... ps` 显示 **healthy** 且 `/health` 返回 `{"ok":true}`，但浏览器下载 `/assets/index-*.js` 得到 `{"detail":"Not Found"}`，不是 Caddy 的 6066 端口问题。此前后端误把 `/assets` 映射到 `/app/frontend`，正确目录应是 **`/app/frontend/assets`**，已修复。

```bash
cd /opt/wtox
git pull
docker compose -f compose.host-caddy.yml build web
docker compose -f compose.host-caddy.yml up -d --no-build
curl -fsS http://127.0.0.1:6066/health
curl -fsS http://127.0.0.1:6066/health/ui
docker compose -f compose.host-caddy.yml exec -T web sh -c 'ls -l /app/frontend/assets'
```

确认实际打包出来的哈希文件 URL 返回 200：

```bash
JS=$(docker compose -f compose.host-caddy.yml exec -T web sh -c \
  "find /app/frontend/assets -maxdepth 1 -name '*.js' -print -quit" | tr -d '\r')
curl -I "http://127.0.0.1:6066/assets/$(basename "$JS")"
```

正常应返回 HTTP 200，`content-type` 为 JavaScript；`/health/ui` 也应显示 `"ok":true`。注意 Vite 每次构建的文件名可能不同，**不要写死旧的哈希文件名**。若成功后浏览器仍加载旧内容，使用强制刷新或清除当前网站的 HTTP 缓存（不要清除站点数据/IndexedDB，以免丢失加密聊天历史）。

GitHub Actions 的 Python API 单元测试不再开启生产 FastAPI 生命周期，避免启动无限运行的 Tox 离线队列。CI 按测试模块分开运行，单模块 90 秒后会打印卡住时的线程栈，而不是一直挂着。
