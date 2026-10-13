# wTox v1 — 手动部署 Cloudflare 测试环境

仅在 `v1` 上配置测试部署，**不合并或修改 main，不替换原有 VPS**。
当前部署的是 Cloudflare API 基础层，**不是可用的 Tox 聊天应用**。

## 1. 配置 GitHub Secrets

打开 https://github.com/hiiidev/wtox/settings/secrets/actions ，
分别添加下面两个 Repository secrets：

- `CLOUDFLARE_API_TOKEN` — 在 Cloudflare 控制台创建最小权限、
  指定目标账号的 API Token；官方推荐 *Edit Cloudflare Workers* 模板。
- `CLOUDFLARE_ACCOUNT_ID` — 目标 Cloudflare Account ID。

**不要向 ChatGPT、Issues、仓库代码或工作流输入框提供 API Token。**
不要使用 Global API Key。

官方文档：
https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

## 2. 从 GitHub 网页手动启动

注意 GitHub 的限制：新的 workflow_dispatch 工作流必须存在于
默认分支，才能独立显示 Run workflow 按钮。为遵守本项目
“不修改 main”的要求，复用已在 main 存在的
`python-checks` 工作流作为手动入口：

1. 打开 https://github.com/hiiidev/wtox/actions/workflows/ci.yml
2. 点击右侧 **Run workflow**。
3. **Use workflow from** 选择 **v1**，不要选择 main。
4. 点击 **Run workflow**。Python/前端测试通过后，
   运行 `Manual deploy: Cloudflare v1 staging` 子工作流。
5. 在日志中查看实际 workers.dev URL，并访问
   `/api/v1/health`、`/api/v1/capabilities`。

**只要手动运行 v1 的 python-checks，就会同时尝试部署测试环境。**
日常 push / PR 自动 CI **不会触发部署**。不想部署时不要
在 v1 上手动运行该工作流。

## 3. 隔离和安全

- 部署配置：`cloudflare/wrangler.staging.jsonc`。
- 独立 Worker 名：`wtox-v1-staging`，与其他项目分离。
- 仅 workers.dev，**没有自定义域名 routes**，不改 DNS。
- SQLite-backed Durable Objects，兼容 Cloudflare Free。
- 暂时只有健康检查与功能状态接口可用。
- 身份、密文邮箱公网 API、TCP Relay、推送接口继续返回 HTTP 501。
- 不会上传或运行用户 .tox 私钥，不会导入旧 VPS 密钥及数据。
- CI 先执行类型检查、测试、Wrangler dry-run，再部署。

测试 Worker 有公开 workers.dev 地址，不能用于存储敏感数据。
实际聊天功能必须在设备认证、WASM 联网、E2EE 和原版 Tox
互通验收完成后另行开启。

## 4. 可选：本机 Wrangler 测试部署

```sh
cd cloudflare
npm install
npx wrangler login
npm run typecheck
npm test
npm run deploy:staging:dry-run
npm run deploy:staging
```

这里的命令只针对 staging 配置。
