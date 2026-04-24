# 🎬 iPlay - 沉浸式观影指南与推荐系统

> 一个懂你的追剧神器：偏好分析 · TMDB 主数据 · 夸克资源直达

iPlay 是一款拥有独特“暗黑电影院”复古美学的前端应用，结合个人观影偏好算法与互联网公开数据（TMDB、豆瓣、Wikipedia 剧情、夸克网盘资源），为你生成个性化的剧集推荐指数。

![iPlay 截图演示](https://via.placeholder.com/800x400/0a0a0c/e50914?text=iPlay+Cinematic+Experience)

## ✨ 核心亮点

- 🍿 **沉浸式美学 UI**：电影胶片噪点、泛光环境特效、打字机光标，极致的暗黑复古感
- 🧠 **私人定制推荐算法**：不仅看豆瓣客观评分，更结合你的主观类型偏好（喜爱喜剧/melo，拒接血腥/悲剧）以及全网热度，得出专属“iPlay 推荐指数”
- ⚡️ **全无感破墙架构**：使用 Cloudflare Worker 完美绕过浏览器 CORS 跨域限制，实时抓取 TMDB、豆瓣和资源站数据
- 📦 **真正的 Serverless**：前端纯静态托管于 GitHub Pages，零服务器运维成本

## 🏗 技术栈与架构设计

本项目采用极致轻量级的“前后端分离 Serverless”架构：

### Frontend (前端)
- **核心框架**：HTML5 + Vanilla JavaScript (ES Modules)
- **视觉样式**：Tailwind CSS CLI
- **部署平台**：[GitHub Pages](https://pages.github.com/)
- **特点**：前端结构轻量，样式通过本地 Tailwind CLI 生成

### Backend (后端代理抓取层)
- **运行环境**：[Cloudflare Workers](https://workers.cloudflare.com/)
- **核心逻辑**：TMDB 优先，豆瓣 / OMDb / Wikipedia 作为补充来源，Worker 统一做数据聚合和跨域代理
- **特性**：全球 CDN 边缘节点计算，处理跨域(CORS)和数据聚合

## 🚀 部署属于你自己的 iPlay

### 1. 部署后端 (Cloudflare Worker)
1. 登录 Cloudflare Dashboard，进入 **Workers & Pages** -> 创建 Worker。
2. 将本项目中 `worker/_worker.js` 文件的内容复制粘贴到 Worker 的代码编辑器中并保存部署。
3. 在 Worker 的 **Settings** -> **Variables** 中配置：
   - `TMDB_ACCESS_TOKEN`：TMDB v4 Read Access Token（推荐）
   - 或 `TMDB_API_KEY`：TMDB v3 API Key（二选一）
   - `OMDB_API_KEY`：可选，填你自己的 OMDb key；不填则使用仓库内默认值
4. 记录下部署成功后的 Worker 域名（例如：`https://iplay-api.yourname.workers.dev`）。
5. 如果使用 Cloudflare CLI，也可以执行：
   ```bash
   wrangler secret put TMDB_ACCESS_TOKEN
   wrangler secret put OMDB_API_KEY
   ```
   然后按提示粘贴对应的密钥值。

### 2. 部署前端 (GitHub Pages)
1. Fork 本仓库。
2. 修改 `js/api.js` 文件第一行，将 `API_BASE` 指向你刚刚部署的 Worker 域名：
   ```javascript
   const API_BASE = "https://iplay-api.yourname.workers.dev";
   ```
3. 提交修改并推送到 GitHub。
4. 在 GitHub 仓库的 **Settings** -> **Pages** 中，选择 `main` 分支作为 Source 进行部署即可。

### 3. 本地预览与验证
1. 安装依赖并生成样式：
   ```bash
   npm install
   npm run build
   ```
2. 启动一个静态服务器，例如：
   ```bash
   python3 -m http.server 8080
   ```
3. 打开 `http://localhost:8080`，搜索一个中文片名、一个中文剧集名和一个英文片名。
4. 确认 TMDB 结果优先展示，IMDb / Rotten Tomatoes 作为外部评分补充，Douban 仅在需要时补缺。

## 🛠 自定义你的打分算法
如果你想修改类型偏好的权重，请打开 `js/scorer.js`，修改 `PREFERENCE_WEIGHTS` 常量：

```javascript
const PREFERENCE_WEIGHTS = {
    // 根据你的喜好随意调整
    '喜剧': 1.5,
    '爱情': 1.2,
    '恐怖': -2.0, // 不喜欢的类型扣分
    // ...
};
```

## 📜 协议
MIT License
