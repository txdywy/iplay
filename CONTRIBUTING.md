<!-- GSD-DOCS: CONTRIBUTING | mode=create | generated=2026-04-24 -->

# 参与贡献

感谢你对 iPlay 的兴趣！无论你是想修复 bug、添加新功能，还是改进文档，我们都欢迎你的参与。

## 如何贡献

1. **Fork 本仓库**：点击 GitHub 右上角的 Fork 按钮，将项目复制到你的账号下。
2. **克隆到本地**：
   ```bash
   git clone https://github.com/txdywy/iplay.git
   cd iplay
   ```
3. **创建功能分支**：
   ```bash
   git checkout -b feat/your-feature-name
   ```
4. **提交更改**：确保代码通过 lint 和 build 检查。
5. **发起 Pull Request**：描述清楚你的改动内容和动机。

## 开发环境搭建

### 前置要求

- **Node.js**：建议使用最新 LTS 版本
- **npm**：随 Node.js 一起安装
- **Python 3**：用于本地静态服务器预览
- **Wrangler CLI**（可选）：用于本地测试 Cloudflare Worker
  ```bash
  npm install -g wrangler
  ```

### 安装依赖

```bash
npm install
```

### 本地开发流程

1. **构建样式文件**：
   ```bash
   npm run build
   ```
   这会使用 Tailwind CSS CLI 生成 `css/output.css`。

2. **启动前端本地服务器**：
   ```bash
   python3 -m http.server 8080
   ```
   然后打开 `http://localhost:8080` 查看效果。

3. **启动 Worker 本地开发**（可选，需要测试后端接口时）：
   ```bash
   wrangler dev
   ```
   Worker 将在本地运行，默认地址为 `http://localhost:8787`。

4. **运行测试**：
   ```bash
   npm test
   ```
   这会依次执行 lint 和 build，确保代码质量。

## 代码风格规范

本项目使用 **ESLint** 进行代码检查，配置位于 `eslint.config.mjs`。

- 前端代码（`js/` 目录）使用 ES Modules (`import`/`export`)
- JavaScript 标准：ECMAScript 2022
- 全局变量已预定义（`document`, `window`, `fetch`, `caches` 等），无需额外声明

在提交前，请确保运行以下命令且没有报错：

```bash
npm run lint
```

## Pull Request 流程

1. **每个 PR 只解决一个问题**：避免在一个 PR 中混合多个不相关的改动。
2. **确保测试通过**：提交前运行 `npm test`，lint 和 build 必须全部通过。
3. **更新相关文档**：如果改动涉及使用方式或配置，请同步更新 README.md 或其他相关文档。
4. **清晰的提交信息**：使用简洁明了的提交信息，描述"做了什么"和"为什么"。
5. **关联 Issue**：如果 PR 解决了某个 Issue，请在描述中引用（如 `Fixes #123`）。

## 报告问题

如果你发现了 bug 或有新功能建议，请通过 [GitHub Issues](https://github.com/txdywy/iplay/issues) 提交。

提交 Issue 时，请尽量包含以下信息：

- **问题描述**：清晰描述你遇到的问题或建议
- **复现步骤**：如果是 bug，请提供具体的操作步骤
- **期望行为**：你期望发生什么
- **实际行为**：实际发生了什么
- **环境信息**：浏览器版本、操作系统等

## 行为准则

参与本项目即表示你同意以尊重、包容的态度对待所有贡献者。请保持友善和建设性的沟通。

## 急需帮助的领域

以下是我们特别欢迎贡献的方向：

### 1. 测试框架

目前项目仅通过 `npm run lint && npm run build` 做基础检查，缺少单元测试和集成测试。我们欢迎：

- 为 `js/scorer.js` 的推荐算法编写单元测试
- 为 Worker API 编写集成测试
- 引入合适的测试框架（如 Vitest、Jest）

### 2. 豆瓣爬虫稳定性

豆瓣页面结构经常变化，导致数据抓取不稳定。如果你能：

- 改进 `worker/_worker.js` 中的豆瓣解析逻辑
- 添加更健壮的容错处理和降级策略
- 优化反爬虫应对机制

### 3. 新的数据源

欢迎接入更多影视数据源，例如：

- 烂番茄（Rotten Tomatoes）评分
- Metacritic 评分
- 其他中文影视数据库
- 更多网盘资源站

### 4. UI/UX 改进

- 响应式布局优化（移动端体验）
- 加载状态和错误提示的交互改进
- 暗黑主题的进一步打磨
- 动画和过渡效果优化

### 5. 性能优化

- 前端资源懒加载和代码分割
- Worker 端的缓存策略优化（Cache API）
- 图片加载和压缩优化

### 6. 国际化

虽然当前以中文为主，但欢迎为后续多语言支持做架构准备。

## 项目结构速览

```
iplay/
├── index.html          # 主入口页面
├── css/
│   ├── input.css       # Tailwind 主题配置
│   └── output.css      # 构建产物（自动生成）
├── js/
│   ├── main.js         # 前端主逻辑
│   ├── api.js          # API 客户端
│   └── scorer.js       # 推荐算法
├── worker/
│   └── _worker.js      # Cloudflare Worker 后端
├── package.json        # npm 配置
├── wrangler.toml       # Worker 部署配置
└── eslint.config.mjs   # ESLint 配置
```

## 许可证

本项目采用 [ISC License](LICENSE) 开源协议。

---

再次感谢你的贡献！有任何问题，欢迎随时在 Issue 区提问。
