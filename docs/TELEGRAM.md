# Telegram Bot

iPlay 的 Telegram bot 运行在同一个 Cloudflare Worker 里，提供和网页相同的搜索、详情、演员作品与夸克资源扫描功能。它直接调用 Worker 已有的处理函数，与网页共用缓存、搜索规则和限流，不需要额外的服务器。

## 功能

| 操作 | 说明 |
|------|------|
| 直接发送文字（私聊） | 搜索影视或演员。高置信度结果直接显示详情卡片，同名或低置信度结果显示候选按钮；演员名显示出演作品 |
| `/search 繁花 第二季` | 同上，可带年份、季数；群聊中只响应命令 |
| `/actor 胡歌` | 按演员查看全部作品，支持 全部 / 电影 / 剧集 筛选和翻页 |
| `/help`、`/start` | 使用说明和示例按钮 |
| 详情卡片 | 海报、TMDB 评分、类型、iPlay 推荐指数（默认偏好，与网页一样计入中文维基收录）、导演、主演、季集信息和简介 |
| 🔍 夸克资源 | 扫描 By669、WPZY、醉都音，列出夸克分享链接、提取码和来源帖子，每页 6 条；📋 按钮一键复制提取码 |
| 🔄 重新扫描 | 绕过缓存重新扫描；所有来源都失败时保留之前的结果并提示 |
| 📄 资源帖 | 查看没有直接提取到链接的论坛资源帖 |
| 📖 完整简介 | 优先中文 Wikipedia，否则 TMDB 简介 |
| 🗂 分季 | 各季集数，点击某季查看该季详情 |
| 👤 演员按钮 | 从详情卡片跳到演员作品列表 |
| 🌐 网页打开 | 在 iPlay 网页中打开同一条目 |

## 配置步骤

### 1. 在 BotFather 创建 bot

1. 在 Telegram 中打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示设置名称和用户名。
2. 复制 BotFather 返回的 token，格式类似 `123456789:AAH...`。**token 等同于 bot 的密码，不要提交到仓库或公开发送。**

### 2. 把 token 配置为 Worker 的 Secret

任选一种方式：

- **Cloudflare 控制台**：Workers & Pages → `iplay` → Settings → Variables and Secrets → Add → 类型选 **Secret**，名称 `TELEGRAM_BOT_TOKEN`，值为 token → Deploy。
- **Wrangler CLI**：`npm run wrangler -- secret put TELEGRAM_BOT_TOKEN`，按提示粘贴 token。

`wrangler.toml` 设置了 `keep_vars = true`，后续代码部署不会清除这个 Secret。

### 3. 注册 webhook

在浏览器中打开（把 `<TOKEN>` 换成你的 bot token）：

```text
https://iplayw.hackx64.eu.org/telegram/setup?token=<TOKEN>
```

成功时返回：

```json
{ "ok": true, "bot": "@your_bot", "webhook": "https://iplayw.hackx64.eu.org/telegram/webhook", "pendingUpdates": 0, "access": "public" }
```

该地址会调用 Telegram 的 `setWebhook`（附带校验密钥）并设置命令菜单；加上 `&drop=1` 会丢弃注册前积压的消息。只需执行一次；更换 token 或 Worker 域名后再执行一次即可。完成后在 Telegram 中给 bot 发送 `/start`。

### 4. （可选）限制可用用户

默认任何人都可以使用 bot，每个 Telegram 用户单独限流（普通操作每分钟 60 次，资源扫描每分钟 10 次，与网页接口相同的 Cloudflare 限流规则）。

如果只想自己或少数人使用，添加变量 `TELEGRAM_ALLOWED_USERS`，值为逗号分隔的 Telegram 用户 ID，例如 `12345678,87654321`。不在列表中的用户发消息时，bot 会回复他们的用户 ID，方便你把 ID 加入列表。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 启用 bot 时必需 | BotFather 提供的 token。未配置时 `/telegram/*` 路由返回 `404` / `503`，网页功能不受影响 |
| `TELEGRAM_ALLOWED_USERS` | 可选 | 逗号分隔的用户 ID 白名单；为空时公开使用 |
| `TELEGRAM_WEBHOOK_SECRET` | 可选 | 自定义 webhook 校验密钥（16–256 位字母、数字、`_`、`-`）。默认由 token 派生，修改后需重新执行第 3 步 |

## 路由

| 路由 | 说明 |
|------|------|
| `POST /telegram/webhook` | Telegram 推送更新。必须带正确的 `X-Telegram-Bot-Api-Secret-Token`，否则返回 `401`。Worker 立即返回 `200`，在 `waitUntil` 中处理并回复，避免 Telegram 因超时重发 |
| `GET /telegram/setup?token=<TOKEN>` | 校验 token 后注册 webhook 和命令菜单。token 错误返回 `401` |

## 安全说明

- webhook 只接受带校验密钥的请求；密钥默认是 `SHA-256("iplay-telegram-webhook:" + token)`，只有 Worker 和 Telegram 知道。
- 日志会把 Telegram API 路径中的 token 替换为 `[REDACTED]`；Worker 的可观测性配置也会隐藏查询字符串。
- 所有消息使用 HTML 格式并转义标题、简介等外部文本；链接只输出 `http(s)` 地址。
- 资源扫描结果来自公开论坛，bot 只展示链接，不下载或转存文件。

## 排查

| 现象 | 处理 |
|------|------|
| setup 返回 `TELEGRAM_BOT_TOKEN is not configured` | Secret 名称或值有误，或配置后尚未 Deploy |
| setup 返回 `401` | URL 中的 token 与 Secret 不一致 |
| bot 不回复 | 重新打开 setup 地址，查看返回的 `webhook` 与 `pendingUpdates`；在 Cloudflare Workers 日志中搜索 `telegram_` 事件 |
| 回复“仅对授权用户开放” | 把回复中的用户 ID 加入 `TELEGRAM_ALLOWED_USERS` |
| 回复“操作太频繁” | 每分钟最多 10 次资源扫描，稍后再试 |
