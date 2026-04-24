<!-- generated-by: gsd-doc-writer -->

# iPlay 快速上手指南

本文档面向首次接触 iPlay 项目的开发者，帮助你在本地完成环境搭建、构建运行和基础验证。预计耗时 10-15 分钟。

---

## 前置条件

在开始之前，请确保你的环境满足以下要求：

| 项目 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | >= 18.0.0 | 用于构建 Tailwind CSS 和运行 ESLint |
| npm | >= 9.0.0 | 随 Node.js 一同安装 |
| Cloudflare 账号 | — | 部署 Worker 代理服务所需 |
| TMDB 账号 + API Token | — | 在 [TMDB 设置页](https://www.themoviedb.org/settings/api) 申请 v4 Read Access Token |
| (可选) OMDb API Key | — | 用于获取 IMDb / Rotten Tomatoes 评分；不填则使用内置默认值 |
| (可选) GitHub 账号 | — | 如需使用 GitHub Pages 部署前端 |

> **提示**：如果你只想在本地预览而不部署 Worker，可以暂时跳过 Cloudflare 和 TMDB 相关步骤，使用项目中的默认 API 地址（但可能受限于公开服务的速率限制）。

---

## 逐步搭建

### 1. 克隆仓库

```bash
git clone https://github.com/txdywy/iplay.git
cd iplay
```

### 2. 安装依赖

```bash
npm install
```

这会安装 Tailwind CSS CLI 和 ESLint 等开发依赖。

### 3. 构建样式文件

```bash
npm run build
```

此命令使用 Tailwind CSS CLI 将 `css/input.css` 编译为 `css/output.css`。构建成功后，你会看到 `css/output.css` 文件已生成（或更新）。

### 4. 配置 Worker 密钥（后端代理）

iPlay 使用 Cloudflare Worker 作为后端代理，用于绕过浏览器 CORS 限制并聚合 TMDB、豆瓣等数据。

#### 方式 A：使用 Wrangler CLI（推荐）

确保你已安装 Wrangler 并登录：

```bash
npx wrangler login
```

然后设置密钥：

```bash
# 设置 TMDB v4 Access Token（推荐，认证方式更稳定）
npx wrangler secret put TMDB_ACCESS_TOKEN

# 可选：设置 OMDb API Key（获取 IMDb / Rotten Tomatoes 评分）
npx wrangler secret put OMDB_API_KEY
```

按提示粘贴对应的密钥值即可。

#### 方式 B：通过 Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages** -> 选择你的 Worker（或创建新 Worker）
3. 在 **Settings** -> **Variables** 中添加以下变量：
   - `TMDB_ACCESS_TOKEN`：你的 TMDB v4 Read Access Token
   - `OMDB_API_KEY`（可选）：你的 OMDb API Key

### 5. 部署 Worker

```bash
npx wrangler deploy
```

部署成功后，记录下 Worker 的域名，例如：

```
https://iplay-worker.your-account.workers.dev
```

### 6. 更新前端 API 地址

打开 `js/api.js`，将第 5 行的 `API_BASE` 修改为你的 Worker 域名：

```javascript
const API_BASE = "https://iplay-worker.your-account.workers.dev";
```

### 7. 本地预览

在项目根目录启动一个本地静态服务器：

```bash
python3 -m http.server 8080
```

然后在浏览器中打开 http://localhost:8080 即可访问。

#### 替代方式：使用 GitHub Pages 部署

1. Fork 本仓库到你的 GitHub 账号
2. 修改 `js/api.js` 中的 `API_BASE` 并提交
3. 在仓库 **Settings** -> **Pages** 中，选择 `main` 分支作为 Source 进行部署

---

## 快速验证

完成上述步骤后，请按以下方式验证系统是否正常工作：

1. **打开应用**：访问 http://localhost:8080（或你的 GitHub Pages 地址）
2. **搜索中文电影**：在搜索框输入一部中文电影名称（如 "流浪地球"），确认：
   - 结果列表中出现 TMDB 数据
   - 详情弹窗展示剧情简介、演员表
   - 底部显示夸克资源链接
3. **搜索英文电影**：输入一部英文电影名称（如 "Inception"），确认 TMDB 结果优先展示
4. **搜索剧集**：输入一部电视剧名称（如 "三体"），确认类型识别正确
5. **检查评分来源**：在详情页中，确认：
   - TMDB 评分和豆瓣评分均正常显示
   - IMDb / Rotten Tomatoes 评分正常显示（如配置了 OMDb Key）

如果以上验证均通过，说明你的 iPlay 实例已成功运行。

---

## 常见问题排查

### 搜索无结果 / 结果为空

- **检查 Worker 是否部署成功**：直接访问 `https://your-worker.workers.dev/api/tmdb/search?q=流浪地球`，看是否返回 JSON 数据
- **检查 TMDB Token 是否配置正确**：在 Cloudflare Dashboard 的 Worker Variables 中确认 `TMDB_ACCESS_TOKEN` 已设置
- **检查 API_BASE 是否正确**：确认 `js/api.js` 中的 `API_BASE` 指向了你的 Worker 域名，且末尾无斜杠

### CORS 跨域错误

- 确保前端页面是通过 `http://localhost:8080`（或 HTTPS 的 GitHub Pages）访问，而非直接打开 `file://` 协议的 HTML 文件
- 检查 Worker 代码中是否包含 CORS 响应头（`Access-Control-Allow-Origin: *`）

### `npm run build` 失败

- **Node.js 版本过低**：确保 Node.js >= 18.0.0，运行 `node --version` 检查
- **依赖未安装**：先运行 `npm install`
- **Tailwind CSS 未找到**：检查 `node_modules/.bin/tailwindcss` 是否存在，如不存在请重新安装依赖

### Worker 部署失败

- **未登录 Wrangler**：运行 `npx wrangler login` 完成登录
- **账户权限不足**：确认你的 Cloudflare 账户已启用 Workers 功能
- **配置文件错误**：检查 `wrangler.toml` 中的 `name` 和 `main` 字段是否正确指向 `worker/_worker.js`

### 详情页评分不显示

- **OMDb Key 未配置**：iPlay 使用 OMDb 获取 IMDb 和 Rotten Tomatoes 评分。如不配置，会回退到内置默认值，但可能触发速率限制
- **TMDB 数据缺失**：部分冷门影片可能在 TMDB 中无评分数据，此时会显示 "—"

---

## 下一步

- 了解系统架构设计，请参阅 [ARCHITECTURE.md](./ARCHITECTURE.md)
- 查看所有配置项说明，请参阅 [CONFIGURATION.md](./CONFIGURATION.md)
- 自定义推荐算法权重，请编辑 `js/scorer.js` 中的 `PREFERENCE_WEIGHTS` 常量
