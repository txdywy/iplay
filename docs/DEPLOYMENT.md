<!-- GSD-DOCS: DEPLOYMENT | mode=create | generated=2026-04-24 -->

# 部署指南

iPlay 采用前端静态托管 + Cloudflare Worker 边缘代理的部署方式，目标是尽量保持零服务器维护成本。

---

## 部署概览

- **前端**：GitHub Pages 静态托管
- **后端**：Cloudflare Worker
- **样式构建**：本地使用 Tailwind CSS CLI 生成 `css/output.css`
- **运行时密钥**：由 Cloudflare Worker Secrets 提供

<!-- VERIFY: GitHub Pages 是否是当前线上前端托管方式，需要结合实际仓库发布流程确认。 -->
<!-- VERIFY: Cloudflare Worker 是否仍使用免费层部署策略，需要结合实际账户与配额确认。 -->

---

## 后端部署：Cloudflare Worker

### 方式一：Cloudflare Dashboard

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages**，创建一个 Worker。
3. 将 `worker/_worker.js` 的内容粘贴到编辑器中并保存。
4. 到 **Settings → Variables** 配置 Secrets：
   - `TMDB_ACCESS_TOKEN`
   - `TMDB_API_KEY`（可选，作为备用）
   - `OMDB_API_KEY`（可选）
5. 保存并部署。

### 方式二：Wrangler CLI

```bash
cd /Users/yiwei/iplay
npx wrangler login
npx wrangler secret put TMDB_ACCESS_TOKEN
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put OMDB_API_KEY
npx wrangler deploy
```

### Worker 配置

`wrangler.toml` 的关键字段如下：

```toml
name = "iplay-worker"
main = "worker/_worker.js"
compatibility_date = "2024-04-23"
```

---

## 前端部署：GitHub Pages

### 部署前准备

1. 先构建样式：

```bash
npm run build
```

2. 打开 `js/api.js`，把 `API_BASE` 修改成你自己的 Worker 域名。

```javascript
const API_BASE = "https://your-worker.example.workers.dev";
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
npx wrangler dev
```

如果你配置了 `.dev.vars`，本地 Worker 会使用这些密钥值。

---

## 环境变量

### Cloudflare Worker Secrets

| 名称 | 说明 |
|------|------|
| `TMDB_ACCESS_TOKEN` | TMDB v4 访问令牌，推荐优先配置 |
| `TMDB_API_KEY` | TMDB v3 API Key，作为备用 |
| `OMDB_API_KEY` | OMDb API Key，可选 |

### 本地开发

`.dev.vars` 适合本地调试，不应提交到仓库：

```bash
TMDB_ACCESS_TOKEN=your_token
TMDB_API_KEY=your_key
OMDB_API_KEY=your_omdb_key
```

---

## 部署后验证

部署完成后，建议检查下面这些路径：

- 前端首页可以正常打开
- 搜索输入后能返回结果
- 详情弹窗能展示评分、简介、演员与资源链接
- Worker 接口返回 JSON，且没有跨域错误
- 海报和评分源在不同影片上都能回退到可用来源

---

## 故障排查

### 页面空白

- 先确认 `css/output.css` 已生成
- 再确认 `API_BASE` 指向正确的 Worker 域名

### Worker 部署失败

- 检查 `npx wrangler login` 是否完成
- 检查 `wrangler.toml` 中的 `main` 是否仍指向 `worker/_worker.js`
- 检查密钥是否已配置

### 请求返回 500

- 多半是 TMDB 或 OMDb 的密钥没有配置成功
- 先看 Worker 日志，再逐个验证 Secrets

### 线上页面能打开但无数据

- 通常是前端的 `API_BASE` 没有切到你的 Worker 地址
- 也可能是 Worker 部署成功，但密钥没传到线上环境

---

## 发布建议

- 前端变更先跑 `npm run lint && npm run build`
- Worker 变更先跑 `npx wrangler dev`
- 生产环境更新后，先验证一个中文片名，再验证一个英文片名
