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

首次部署时设置强随机网站入口密码 `WTOX_ACCESS_PASSWORD`（最少 6 个字符，但建议使用更长的随机密码）和独立随机的 `WTOX_MASTER_KEY`（32 字节，64 位 hex）。可用 `python3 -c 'import secrets; print(secrets.token_hex(32))'` 生成 master key。不要提交或泄露 `.env`。主密钥务必离线备份。

`SITE_DOMAIN` 对宿主机 Caddy 模式不是必需字段，但填入实际域名便于切换部署方案。

**升级旧版本时不要覆盖已存在的 `.env`，尤其不能更换 `WTOX_MASTER_KEY`。在重建容器前备份 `wtox_data` 数据卷。新版不再使用网站用户名和个人账号密码，改为下载/上传 `.tox` 配置创建或登录身份；旧登录 Cookie 尚有效时可在新页面导出原身份备份。**

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
    reverse_proxy 127.0.0.1:6066
    header {
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
}
```

`reverse_proxy` 原生支持 WebSocket Upgrade，**不用额外写 /ws 的代理规则**。如果域名对应的站点块已经存在，就在现有块内添加 `reverse_proxy`，不要再创建重复的域名块或覆盖其他网站路由。没有单独域名时建议新建子域名以避免现有网站路径冲突。

确认 DNS A/AAAA 记录指向正确 VPS，公网可达 80/443，然后：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

验证 HTTPS：

```bash
curl -I https://tox.example.com/gate
```

然后通过浏览器进入 `https://tox.example.com/`，正常情况会先提示输入网站统一访问密码。

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

## 安全与数据

wtox 的 `/health` 不需要网站密码，所以只暴露没有凭据的健康状态；登录入口以及业务 API 由后端验证统一访问密码和个人登录态。不要通过公网 `http://VPS-IP:6066` 暴露应用。VPS 中的 Toxcore 仍能访问身份私钥和收发明文，不是零知识服务器。

用户 2–3 人时只需这一个 VPS。纯浏览器 WASM 暂不开展。
