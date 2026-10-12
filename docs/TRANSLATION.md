# wTox 按需消息翻译

wTox 的聊天消息保存在 Tox / 浏览器加密历史中。只有用户主动点击
「翻译」时，当前选中的**一条文字消息的明文**才会被发送至 wTox 后端，
然后由后端请求 Google Translate。其他消息、附件、Tox 私钥和聊天历史
不会作为翻译请求的一部分上传。

## 使用方式

- 设置 → **消息翻译** → **默认翻译语言**。初始值为「跟随浏览器」。
- 在聊天中点击消息时间旁的翻译图标，或桌面右键消息选择「翻译」。
- 译文出现在原始消息下方，再次点击收起/展开。同一页面内复用译文，
  不会自动翻译其他消息或写入聊天历史。
- 不建议将任何敏感信息提交给第三方翻译服务。译文可能不准确。

## 后端

前端仅调用当前 wTox 域名下的登录保护接口：

`POST /api/translate`，JSON 格式：
`{"text":"Hello","target":"zh-CN"}`。

接口限制文本 1–1000 字符，每个登录身份每分钟最多 20 次请求，并执行
同源请求检查；Google 请求超时后返回友好的失败提示。响应不由浏览器
或 HTTP 共享缓存存储。译文只放在当前页面内存中，不存入服务器数据库。

默认服务端调用：
`https://translate.googleapis.com/translate_a/single`
并通过 `sl=auto` 自动识别原始语言。该端点是 **Google 网页翻译的非正式
接口，而非带 SLA 的 Google Cloud Translation 正式 API**；可能受到区域
限制、频率限制或供应商调整影响。用户请求失败时原消息不受影响。

如果所在服务器无法直接访问 Google，可由部署管理员通过已受信任的
HTTPS 转发服务配置：

`WTOX_TRANSLATE_UPSTREAM=https://your-trusted-translation-proxy.example`

该服务必须向上游转发 `POST /translate_a/single`，保留普通
语言参数查询串，并将消息明文放在 `application/x-www-form-urlencoded`
请求体的 `q` 字段中；不得把 `q` 复制到 URL 或访问日志。
注意 Google 网页翻译非正式接口未承诺长期支持 POST，部署时需验证，
如上游拒绝 POST 则翻译请求会失败，不会自动降级为暴露 URL 的 GET。
代理应返回与 Google 网页翻译兼容的 JSON。推荐参考
[RipperTs/proxy_tutorial_for_translation](https://github.com/RipperTs/proxy_tutorial_for_translation)
配置只允许必要 Google 路径的转发。

**安全注意：** 仅能由服务器管理员通过环境变量设置转发目标；浏览器
用户不能选择任意上游 URL。请确保 HTTPS 代理可信，并禁用包含消息
文本的请求体或 URL 的访问日志。不要记录原始 POST body。
无需暴露通用代理给互联网。

部署仍使用现有的 `docker compose -f compose.yml up -d --build`，
不要删除 Docker 数据卷、.env 或更换 WTOX_MASTER_KEY。
