<!-- GSD-DOCS: DEVELOPMENT | mode=create | generated=2026-04-24 -->

# 开发指南

本文档帮助你在本地开发 iPlay：启动静态前端、调试 Cloudflare Worker、以及理解各模块的职责边界。

---

## 开发环境

### 依赖要求

- Node.js >= 20.19.0（推荐 22 LTS）
- npm 9+
- Cloudflare 账号（调试 Worker 时需要）
- Wrangler CLI（建议通过 `npm run wrangler -- <command>` 使用仓库固定版本）

### 首次准备

```bash
cd iplay
npm install
npm run build
```

`npm run build` 会把 `css/input.css` 编译为 `css/output.css`，前端页面依赖这个生成文件显示完整样式。

---

## 项目结构

| 路径 | 作用 |
|------|------|
| `index.html` | 单页应用入口，负责承载整体布局与资源引用 |
| `js/main.js` | 前端主逻辑：搜索、渐进渲染、资源状态、偏好设置 |
| `js/api.js` | Worker API 客户端封装 |
| `js/quark.js` | 夸克链接与提取码复制文本格式化 |
| `js/scorer.js` | 推荐评分逻辑 |
| `css/input.css` | Tailwind CSS 输入文件 |
| `css/output.css` | 构建后的样式文件 |
| `worker/_worker.js` | Cloudflare Worker 代理与聚合层 |
| `tests/` | Node.js 内置测试运行器测试 |
| `wrangler.toml` | Worker 配置 |

---

## 前端开发

### 常见工作流

1. 修改 `index.html`、`js/main.js`、`js/api.js` 或 `js/scorer.js`
2. 运行 `npm run build` 重新生成样式
3. 在浏览器中刷新页面验证交互
4. 使用浏览器开发者工具查看网络请求与控制台日志

### 本地预览

```bash
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

### 前端调试重点

- 新搜索是否会取消仍在进行的旧请求
- 最佳匹配是否正确区分电影/剧集
- 详情区域是否先展示 TMDB 核心数据，再逐步填充补充来源
- 推荐分数是否随类型偏好变化
- API 请求失败时是否仍能保持页面可用

---

## 后端 Worker 开发

### 启动本地 Worker

```bash
npm run wrangler -- dev
```

Worker 会读取本地 `.dev.vars` 或 Cloudflare 账号里的密钥配置。

### Worker 代码位置

`worker/_worker.js` 是整个后端代理层的入口，路由和数据聚合逻辑都集中在这里。常见改动包括：

- TMDB 搜索与详情代理
- 豆瓣搜索与详情抓取
- OMDb 评分与海报回退
- Wikipedia 中文简介
- 夸克资源搜索

### 修改 Worker 后的验证

```bash
npm run wrangler -- dev
```

在本地访问 Worker 提供的接口，确认返回 JSON 结构和 CORS 头都正确。

---

## 构建系统

### 可用脚本

| 命令 | 作用 |
|------|------|
| `npm run build` | 构建 Tailwind CSS 输出文件 |
| `npm run lint` | 运行 ESLint |
| `npm run test:coverage` | 运行 Node.js 测试并生成覆盖率报告 |
| `npm test` | 依次运行 Node.js 测试、lint 和 build |

### 推荐顺序

```bash
npm test
```

测试、lint 和生产构建全部通过后，再继续提交或部署。

---

## 代码风格

- 前端使用原生 ES Modules，不引入框架运行时
- 逻辑尽量保持贴近调用处，减少不必要的抽象
- 状态更新优先走现有的 UI 入口函数，不要在多个地方重复操作 DOM
- Worker 端尽量让每个路由处理函数只负责一种数据源或一种聚合任务

---

## 调试建议

### 1. 网络请求异常

先检查 `js/api.js` 中的 `API_BASE` 是否指向你的 Worker 域名。
如果前端使用自定义域名，还要把完整 Origin 加入 Worker 的 `CORS_ALLOWED_ORIGINS`。

### 2. 样式丢失

先确认 `css/output.css` 是否已由 `npm run build` 生成。

### 3. Worker 返回 500

优先检查 Worker secrets 是否已配置：

- `TMDB_ACCESS_TOKEN`
- `TMDB_API_KEY`
- `OMDB_API_KEY`

### 4. 豆瓣详情失效

豆瓣详情依赖 HTML 结构，页面结构变化后抓取逻辑可能失效，需要重点回归测试。

---

## 添加新功能

### 新增前端功能

- 先定位入口：`js/main.js`
- 如果涉及数据请求，先在 `js/api.js` 增加封装
- 如果涉及排序或推荐逻辑，优先改 `js/scorer.js`

### 新增 Worker 接口

- 在 `worker/_worker.js` 增加路由处理
- 保持返回 JSON 结构一致
- 记得处理 CORS 头

### 建议的验证清单

- `npm test`
- `npm run wrangler -- dev`
- 浏览器手动验证关键路径

---

## 下一步

- 想了解系统分层，请看 [ARCHITECTURE.md](./ARCHITECTURE.md)
- 想查配置项，请看 [CONFIGURATION.md](./CONFIGURATION.md)
- 想看接口约定，请看 [API.md](./API.md)
