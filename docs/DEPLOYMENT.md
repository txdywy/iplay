<!-- GSD-DOCS: DEPLOYMENT | mode=create | generated=2026-04-24 -->

# 部署指南

iPlay 采用前端静态托管 + Cloudflare Worker 边缘代理的部署方式，目标是尽量保持零服务器维护成本。

---

## 部署概览

- **前端**：GitHub Pages 静态托管
- **后端**：Cloudflare Worker
- **前端构建**：生成并提交 `css/output.css` 与 `assets/app.min.js`，CI 检查重建结果一致
- **运行时密钥**：由 Cloudflare Worker Secrets 提供

---

## 后端部署：Cloudflare Worker

### Cloudflare Dashboard：管理运行时配置

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages**，创建一个 Worker。
3. 使用下方 Wrangler CLI 部署完整模块项目。`worker/_worker.js` 引用 `js/release.js`，不能只粘贴一个文件。
4. 到 **Settings → Variables** 配置 Secrets：
   - `TMDB_ACCESS_TOKEN`
   - `TMDB_API_KEY`（可选，作为备用）
   - `WPZY_COOKIE`（可选；wpzy.org 专用只读账号的登录 Cookie，配置前确认站点允许此用途）
   - `CORS_ALLOWED_ORIGINS`（可选；额外允许的前端 Origin，以英文逗号分隔）
   - `ENVIRONMENT=production`（必填；缺少生产限流 binding 时让 Worker fail closed）
5. 到 **Settings → Bindings** 配置两个 Rate Limiting bindings，名称分别为 `API_RATE_LIMITER`、`RESOURCE_RATE_LIMITER` 和 `QUARK_STATUS_RATE_LIMITER`，并与 `wrangler.toml` 中的 namespace ID 保持一致（第三个缺失时夸克有效性检查会共用资源扫描的额度）。
6. 保存运行时配置。
7. 如需与 `wrangler.toml` 保持一致，在 **Triggers** 中添加 `0 */6 * * *` Cron Trigger；它只用于缓存预热，不影响普通请求。

### 日常发布：Cloudflare Workers Builds

当前生产 Worker 已连接本仓库，生产分支为 `main`。功能分支推送触发预览构建；PR 的 CI 通过并合并到 `main` 后，Cloudflare Workers Builds 自动构建并部署生产 Worker，GitHub Pages 独立发布前端。两个部署都完成并通过 `test:live` 后才算发布完成。不要因 GitHub Actions 中没有自动 Worker 作业而重复手动部署。

`wrangler.toml` 声明 `keep_vars=true`，使 Workers Builds 的默认 `npx wrangler deploy` 同样保留 Dashboard 中额外配置的变量（例如 `CORS_ALLOWED_ORIGINS`、`CRON_REFRESH_TITLES`）。仓库 `[vars]` 声明的值仍以代码为准。仅给本机脚本加 `--keep-vars` 不能覆盖自动构建的默认命令；行为见 [Wrangler 部署说明](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)。

新建或自托管 Worker 时，需要在 Dashboard 的 **Settings → Build** 连接仓库并确认生产分支、构建命令和部署命令。分支行为见 [Cloudflare Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)。

### 首次配置或自动部署故障回退：Wrangler CLI

```bash
cd iplay
npm ci
npm run wrangler -- login
npm run wrangler -- secret put TMDB_ACCESS_TOKEN
npm run wrangler -- secret put TMDB_API_KEY
npm run wrangler -- secret put WPZY_COOKIE
npm run deploy:worker:dry-run
npm run deploy:worker -- --message "本次变更说明"
```

TMDB 两种凭据选择一种即可。生产环境请在部署配置中设置 `ENVIRONMENT=production`，并保留 `API_RATE_LIMITER` / `RESOURCE_RATE_LIMITER` 两个 binding；自托管前端还需在 Dashboard 设置 `CORS_ALLOWED_ORIGINS`，或在 `wrangler.toml` 的 `[vars]` 中配置允许的 Origin 后再部署。

手动回退使用本机 Wrangler OAuth，不把 Cloudflare API Token 放入仓库或 GitHub Actions。`deploy:worker:dry-run` 会在上传前验证 Worker 配置；`deploy:worker` 使用固定版本的 Wrangler 和 `--keep-vars` 发布，并保留 Cloudflare Dashboard 中已有的变量和密钥。

仓库通过 `package-lock.json` 锁定 Wrangler 与用于运行时测试的 Miniflare 版本；需要 Node.js >= 22.13.0，请使用 `npm ci` 重现发布依赖。可观测性配置采样 10% 日志和 1% 追踪，并通过 `redact_query_string=true` 隐藏 URL 查询参数；应用日志也会遮盖常见凭据参数。配置说明见 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/wrangler/configuration/#observability)。

`wrangler.toml` 已声明 `ENVIRONMENT=production`，缺少分布式限流 binding 时拒绝请求；部署时保留两个 Rate Limiting bindings，不能依赖仅本地生效的隔离实例计数器。CI 的 Node 22 作业也会检查生产 Worker 打包。

### GitHub Actions（暂不自动部署 Worker）

`.github/workflows/deploy-worker.yml` 目前只保留手动触发入口，不会因 `main` 推送自动运行，且部署 job 仅允许 `refs/heads/main`，避免误从功能分支覆盖生产。这样可以避免仓库未配置 Cloudflare Secrets 时产生必然失败的部署任务。若未来切换到 GitHub Actions，需要配置以下仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### Worker 配置

`wrangler.toml` 的关键字段如下：

```toml
name = "iplay"
main = "worker/_worker.js"
compatibility_date = "2026-10-01"
```

---

## 前端部署：GitHub Pages

### 部署前准备

1. 打开 `js/api.js`，把 `API_BASE` 修改成你自己的 Worker 域名。

```javascript
const API_BASE = "https://your-worker.example.workers.dev";
```

2. 配置完成后再构建样式和 JavaScript：

```bash
npm run build
```

### 发布步骤

1. 将代码推送到 GitHub 仓库。
2. 在仓库 **Settings → Pages** 中选择 `main` 分支作为发布源。
3. 等待 GitHub Pages 完成部署。
4. 打开你的 Pages 地址验证页面是否能正常搜索和加载详情。

---

## 本地预览

### 静态前端预览

```bash
npm run build
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

### 本地 Worker 预览

```bash
npm run wrangler -- dev
```

如果你配置了 `.dev.vars`，本地 Worker 会使用这些密钥值。

---

## 环境变量

### Cloudflare Worker Secrets

| 名称 | 说明 |
|------|------|
| `TMDB_ACCESS_TOKEN` | TMDB v4 访问令牌，推荐优先配置 |
| `TMDB_API_KEY` | TMDB v3 API Key，作为备用 |
| `WPZY_COOKIE` | wpzy.org 的 `bbs_token` 与可选 `bbs_sid`，仅放在 Worker Secret；不可公开、写进前端或 GitHub |
| `QUARK_CHANNEL_SEARCH` | 设为 `1` 启用 Telegram 公开频道搜索，生产配置已启用。请求只发送搜索片名，无需 Telegram 凭据 |
| `QUARK_CHANNELS` | 可选，逗号分隔的公开频道用户名，覆盖默认的 6 个频道（`yunpanx`、`hdhhd21`、`yydf_hzl`、`Quark_Movies`、`bdbdndn11`、`baicaoZY`，按标题对得上且带夸克链接的帖子数排序选出）。最多 8 个，非法名称会被忽略 |
| `CORS_ALLOWED_ORIGINS` | 额外允许的前端 Origin，多个值用英文逗号分隔；线上域名与 localhost:8080 已默认允许 |

### 本地开发

`.dev.vars` 适合本地调试，不应提交到仓库：

```bash
TMDB_ACCESS_TOKEN=your_token
TMDB_API_KEY=your_key
```

### WPZY 登录态与续期

wpzy.org 当前对匿名搜索要求登录。浏览器登录不会自动传给线上 Worker；需要显式配置 `WPZY_COOKIE` Secret，格式为 `bbs_token=…; bbs_sid=…`。不要把真实值写入命令参数、文档、仓库、构建变量或日志；使用上述 Wrangler 交互输入，或受保护的标准输入。`.dev.vars` 与 `.dev.vars.*` 均已忽略。

建议使用获准的专用只读账号。iPlay 的资源查询会共用此账号，并向用户展示它能读取的资源结果；登录过期或站点风控需要维护者重新登录并更新 Secret。更换或撤销 Secret 会切换内部缓存作用域，避免复用旧账号缓存；资源响应及客户端请求均禁止浏览器 HTTP 缓存，保证下次查询到达当前 Worker。没有 Secret 时，Worker 匿名查询 WPZY，并继续查询 By669 和醉都音。

Worker 只向 `https://wpzy.org` 的搜索和帖子路径发送两个登录 Cookie，不向 `www.wpzy.org` 或其他来源发送，且不会转发浏览器提交的 Cookie。帖子链接统一为主域名并移除查询动作，每次搜索最多读取六个 WPZY 帖子。不自动回帖、开通会员、付费或绕过验证；需要回复/VIP 的帖子仍保留原帖入口，并显示限制提示。

Cloudflare Workers Builds 已连接此仓库：main 推送运行 Wrangler 生产部署，其他分支仅上传预览版本。GitHub Actions 的 Worker 部署任务仍是手动入口，两者不是同一条流水线。登录 Cookie 是运行时 Secret，无需放入 GitHub Secrets 或公开构建变量。

---

## 部署后验证

部署完成后，建议检查下面这些路径：

- 前端首页可以正常打开
- 搜索输入后能返回结果
- 详情弹窗能展示评分、简介、演员与资源链接
- Worker 接口返回 JSON，且没有跨域错误
- 配置 WPZY 登录态后运行 `LIVE_REQUIRE_WPZY=1 npm run test:live`，必须验证 WPZY 搜索成功并提取到该源的公开链接；受限帖子可以正常报告部分结果
- 海报和评分源在不同影片上都能回退到可用来源

---

## 故障排查

### 页面空白

- 先确认 `css/output.css` 已生成
- 再确认 `API_BASE` 指向正确的 Worker 域名

### Worker 部署失败

- 检查 `npm run wrangler -- login` 是否完成
- 检查 `wrangler.toml` 中的 `main` 是否仍指向 `worker/_worker.js`
- 检查密钥是否已配置

### 请求返回 5xx

- 先看 Worker 日志，再逐个验证 Secrets

### 线上页面能打开但无数据

- 通常是前端的 `API_BASE` 没有切到你的 Worker 地址
- 也可能是 Worker 部署成功，但密钥没传到线上环境

---

## 发布建议

- 前端或 Worker 变更先跑 `npm test`（Node.js 测试 + lint + 生产构建）
- Worker 变更还要跑 `npm run test:runtime`，验证真实 workerd 的生产 bindings、并发响应流、缓存、HTMLRewriter 和限流。
- 合并前跑 `npm run test:browser:ci`，覆盖手机、桌面、实际评分显隐、分享恢复和降级重试。
- Worker 变更先跑 `npm run wrangler -- dev`
- 生产环境更新后，先验证一个中文片名，再验证一个英文片名
- 发布时同步更新 `VERSION`、`package.json` / lockfile、`js/release.js`、`index.html` 和 `js/` 中的 `?v=`，再运行 `npm run build` 生成对应版本的单文件入口；版本契约测试与 CI 产物检查共同防止新旧文件混用。
- GitHub Pages 和 Worker 均部署完成后运行 `npm run test:live`；只有 HTML、`assets/app.min.js`、全部源码模块、CSS、VERSION 与本地发布逐字相同，Worker 的 `X-iPlay-Version` 一致且核心 API 校验成功，才算本次发布验证完成。可选数据源可用性会单独报告。


## 自建 PanSou（让聚合搜索稳定）

「聚合搜索」默认使用 PanSou 的公共演示实例 `so.252035.xyz`。它由社区维护、所有人共用，经常过载：2026-11-22 实测，从 Worker 发出的 5 次请求全部超时，直连时也有一半请求卡满 30 秒或返回 400。iPlay 已经做了这些处理：

- 两个来源并行请求，谁先成功用谁。
- 源头失败后 90 秒内直接提示「暂时不可用」，不让每个访客干等。
- 失败不影响其他来源的结果。

要稳定可用，需要自己部署一个实例。PanSou 是开源项目（<https://github.com/fish2018/pansou>），提供 Docker 镜像：

```sh
# 纯 API 版，默认监听 8888 端口
docker run -d --name pansou --restart unless-stopped -p 8888:8888 ghcr.io/fish2018/pansou:latest
```

1. 在任意有公网的服务器或容器平台上运行上面的镜像。频道、插件、代理等选项见项目 README 的环境变量说明。
2. 通过 HTTPS 对外提供服务，例如反向代理或 Cloudflare Tunnel。Worker 只接受 `https` 地址。
3. 在 Worker 的变量中设置 `PANSOU_API_URL=https://你的域名`，然后重新部署。缓存键包含这个地址，切换后会立即使用新实例。
4. 用 `curl "https://你的域名/api/search?kw=繁花&cloud_types=quark&res=merge"` 确认能返回 `merged_by_type.quark`。

`PANSOU_API_URL=off` 仅关闭 PanSou。生产配置同时启用了独立的盘搜索开放索引（`PANSOUSUO_SEARCH=1`），会沿用同一套夸克核验流程。设置 `AGGREGATE_SEARCH=0` 可关闭整个聚合模块。
