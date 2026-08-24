<!-- GSD-DOCS: TESTING | mode=create | generated=2026-04-24 -->

# 测试指南

本文档说明 iPlay 项目的测试策略，包括当前已有的测试覆盖、手动测试清单，以及推荐引入的自动化测试方案。

---

## 当前测试状态

iPlay 目前采用轻量级测试策略：

- **CI 测试命令**: `npm test` = `node --test && npm run lint && npm run build`
- **单元测试框架**: Node.js 内置测试运行器（无需 Jest / Vitest）
- **E2E 测试**: 未配置
- **代码检查**: ESLint（flat config，`eslint.config.mjs`）
- **覆盖率命令**: `npm run test:coverage`

> 现有 `tests/` 覆盖 API 客户端、推荐算法、夸克链接处理和 Worker 路由。下文提供手动回归清单以及继续扩展自动化测试的参考。

---

## 手动测试清单

### 前端功能测试

| 测试项 | 操作步骤 | 预期结果 |
|--------|----------|----------|
| 搜索功能 | 在首页搜索框输入"三体"并回车 | 显示搜索结果列表，包含海报、标题、评分 |
| 搜索结果排序 | 搜索"三体" | 结果优先按标题匹配置信度排序，再按 TMDB 评价数和热度排序 |
| 搜索输入增强 | 搜索带有“第二季 1080P”、年份或 IMDb `tt...` 的关键词 | 自动拆解季数/年份/类型，必要时使用定向 TMDB 查询或 IMDb 直查 |
| 详情展示 | 提交搜索 | 自动选择最佳 TMDB 匹配并逐步展示 TMDB / 豆瓣 / IMDb 评分、剧情简介与资源链接 |
| 推荐评分 | 查看搜索结果详情 | 显示 AI 推荐评分（0-100）和标签（天选好剧 / 值得一看 / 剧荒打发 / 极度劝退） |
| 夸克资源 | 查看资源区 | 分别显示 By669、WPZYS 和提取出的夸克分享链接（如有） |
| 空状态 | 搜索无结果关键词（如乱码） | 显示"未找到相关结果"提示 |
| 加载状态 | 搜索时观察页面 | 显示旋转加载动画和"Connecting to satellites"文字 |
| 错误状态 | 断网后搜索 | 显示错误提示框，包含"网络存在波动，请稍后重试" |
| 响应式布局 | 在移动端（< 768px）和桌面端分别打开 | 布局自适应，搜索框、海报网格、详情区域正常显示 |
| 海报加载 | 搜索热门剧集 | 海报图片正常加载，失败时有兜底处理 |

### 偏好权重测试

| 测试项 | 操作步骤 | 预期结果 |
|--------|----------|----------|
| 默认权重 | 首次查看搜索详情 | 喜剧 +2.5、恐怖 -3.0 等默认权重生效 |
| 自定义权重 | 在控制台执行 `localStorage.setItem('iplay_preference_weights', JSON.stringify({'喜剧': {score: 5.0, reason: '超爱'}}))` 后刷新 | 自定义权重覆盖默认值，喜剧评分大幅提升 |
| 致命缺陷 | 搜索包含"恐怖"标签的剧集 | 评分上限被限制在 59 分，显示"严重触及雷区" |

---

## 自动化测试

项目现有测试直接使用 `node:test` 与 `node:assert/strict`：

| 文件 | 主要覆盖 |
|------|----------|
| `tests/api.test.js` | API 客户端错误响应传播 |
| `tests/scorer.test.js` | 推荐评分输入归一化与边界值 |
| `tests/quark-copy.test.js` | 夸克分享链接和提取码复制文本 |
| `tests/quark-urls.test.js` | 夸克 URL、转义内容与提取码解析去重 |
| `tests/worker-api.test.js` | Worker 路由、参数校验、CORS、限流、缓存与资源提供方场景 |

```bash
npm test
npm run test:coverage
```

下面的 Vitest 示例仅用于团队未来需要 watch 模式或更丰富 mock API 时参考；当前项目不依赖 Vitest。

### 可选安装

```bash
npm install --save-dev vitest
```

在 `package.json` 中添加测试脚本：

```json
{
  "scripts": {
    "test:vitest": "vitest run",
    "test:watch": "vitest",
    "test:unit:vitest": "vitest run --reporter=verbose"
  }
}
```

### Scorer 测试用例

创建 `js/scorer.test.js`：

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateRecommendationScore, getRecommendationLabel } from './scorer.js';

describe('calculateRecommendationScore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
  });

  it('高分 + 偏好类型 => 天选好剧 (>=85)', () => {
    const result = calculateRecommendationScore({
      rating: 9.2,
      votes: 500000,
      genres: ['喜剧', '剧情'],
      hasWiki: true,
      source: 'tmdb',
      summary: '一部非常好看的喜剧剧情片'
    });
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.report.pros).toContain('TMDB评分极高 (9.2)');
    expect(result.report.pros).toContain('符合喜剧偏好');
  });

  it('中等评分 + 中性类型 => 50-70 分', () => {
    const result = calculateRecommendationScore({
      rating: 7.5,
      votes: 20000,
      genres: ['剧情'],
      hasWiki: true,
      source: 'douban',
      summary: '一部普通的剧情片'
    });
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThanOrEqual(70);
  });

  it('低分 + 厌恶类型 => 极度劝退 (<50)', () => {
    const result = calculateRecommendationScore({
      rating: 5.0,
      votes: 1000,
      genres: ['恐怖', '血腥'],
      hasWiki: false,
      source: 'tmdb',
      summary: ''
    });
    expect(result.score).toBeLessThan(50);
    expect(result.report.cons).toContain('包含恐怖元素');
    expect(result.report.cons).toContain('可能含有血腥镜头');
  });

  it('无评分 + 无 Wiki + 无简介 => 扣分', () => {
    const result = calculateRecommendationScore({
      rating: 0,
      votes: 0,
      genres: [],
      hasWiki: false,
      source: 'tmdb',
      summary: ''
    });
    expect(result.score).toBeLessThanOrEqual(38); // 30 base + 0 heat + 10 pref - 2 penalty
  });

  it('致命缺陷 (恐怖 -3.0) => 上限 59', () => {
    const result = calculateRecommendationScore({
      rating: 9.5,
      votes: 1000000,
      genres: ['恐怖'],
      hasWiki: true,
      source: 'tmdb',
      summary: '一部高分的恐怖片'
    });
    expect(result.score).toBeLessThanOrEqual(59);
    expect(result.report.cons[0]).toBe('⚠️ 严重触及雷区 (包含你讨厌的元素)');
  });

  it('现象级爆款 => 热度分加成', () => {
    const result = calculateRecommendationScore({
      rating: 8.5,
      votes: 500000,
      genres: ['喜剧'],
      hasWiki: true,
      source: 'tmdb',
      summary: '一部爆款喜剧'
    });
    expect(result.report.pros).toContain('现象级爆款 (50w+人评价)');
  });
});

describe('getRecommendationLabel', () => {
  it('>=85 => 天选好剧', () => {
    expect(getRecommendationLabel(90).label).toBe('天选好剧 🌟');
  });
  it('70-84 => 值得一看', () => {
    expect(getRecommendationLabel(75).label).toBe('值得一看 👍');
  });
  it('50-69 => 剧荒打发', () => {
    expect(getRecommendationLabel(60).label).toBe('剧荒打发 👀');
  });
  it('<50 => 极度劝退', () => {
    expect(getRecommendationLabel(30).label).toBe('极度劝退 💣');
  });
});
```

### API 客户端测试（可选）

`js/api.js` 中的 API 函数可以通过 mock `fetch` 进行测试：

```javascript
import { describe, it, expect, vi } from 'vitest';
import { TmdbAPI, ResourceAPI } from './api.js';

describe('TmdbAPI', () => {
  it('search 发送正确的请求', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      })
    );

    await TmdbAPI.search('三体');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tmdb/search?q=%E4%B8%89%E4%BD%93'),
      expect.any(Object)
    );
  });
});
```

---

## Worker 测试

### 本地开发测试（wrangler dev）

Worker 代码位于 `worker/_worker.js`，使用 Cloudflare Workers 运行时 API。

```bash
# 安装 wrangler（如未安装）
npm install --save-dev wrangler

# 启动本地开发服务器
npm run wrangler -- dev worker/_worker.js
```

本地启动后，可通过以下方式测试各端点：

```bash
# TMDB 搜索
curl "http://localhost:8787/api/tmdb/search?q=三体"

# TMDB 详情
curl "http://localhost:8787/api/tmdb/detail?id=123&type=tv"

# 豆瓣搜索
curl "http://localhost:8787/api/douban/search?q=三体"

# 豆瓣详情
curl "http://localhost:8787/api/douban/detail?id=34874646"

# 资源搜索
curl "http://localhost:8787/api/resource?q=三体"

# 海报搜索
curl "http://localhost:8787/api/poster?title=三体&year=2023"

# Wikipedia 中文摘要
curl "http://localhost:8787/api/wiki/zh?q=三体"

# OMDb 查询
curl "http://localhost:8787/api/omdb?imdb=tt20242042"
```

### 环境变量配置

Worker 测试需要以下环境变量（可在 `.dev.vars` 中配置）：

```bash
TMDB_ACCESS_TOKEN=your_tmdb_access_token
# 或
TMDB_API_KEY=your_tmdb_api_key
OMDB_API_KEY=your_omdb_api_key
```

> `OMDB_API_KEY` 是可选功能配置，但项目不内置 Key；未配置时 OMDb 接口返回 `503`，其他数据源仍可使用。

### 缓存测试

Worker 使用 `caches.default` 进行响应缓存。测试时注意观察：

- 首次请求：从上游 API 获取，响应时间较长
- 重复请求：从缓存读取，响应时间显著缩短
- 缓存 TTL：TMDB / 豆瓣 / OMDb / Wiki 与完整海报聚合为 86400 秒（1天），完整资源搜索为 43200 秒（12小时）
- 资源搜索使用 `resource-search-v5-cache.local` 命名空间；提供方或详情页失败时的部分结果只缓存 900 秒（15 分钟）
- 海报聚合使用 `poster-v1-cache.local` 命名空间；已配置来源部分失败时的可用结果只缓存 900 秒

---

## 前端测试清单

### 浏览器兼容性

| 浏览器 | 最低版本 | 测试重点 |
|--------|----------|----------|
| Chrome | 90+ | 主要开发浏览器，功能完整性 |
| Safari | 14+ | iOS 移动端、Backdrop Filter |
| Firefox | 88+ | Fetch API、AbortController |
| Edge | 90+ | Chromium 内核，与 Chrome 一致 |

### 性能测试

- **首次内容绘制（FCP）**: 打开首页，应在 1.5s 内看到搜索框
- **搜索响应时间**: 输入关键词后，首屏结果应在 3s 内返回
- **详情首屏展示**: 提交搜索后，TMDB 核心详情应在数据返回后立即出现
- **内存泄漏**: 反复提交不同搜索，观察内存占用是否持续增长

### 网络异常测试

| 场景 | 操作 | 预期行为 |
|------|------|----------|
| 慢网 | Chrome DevTools Network Throttling 3G | 显示加载状态，请求可完成 |
| 断网 | 断开网络后搜索 | 显示错误状态，不崩溃 |
| 超时 | 模拟 API 响应 > 8s | 请求超时，显示错误提示 |
| 请求取消 | 连续快速提交不同搜索 | 旧请求被 AbortController 取消，仅展示最新结果 |

---

## CI/CD 测试

项目通过 `.github/workflows/ci.yml` 在 `main` 推送和面向 `main` 的 Pull Request 上运行验证：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: git diff --exit-code -- css/output.css
```

---

## 测试改进路线图

1. **短期（当前）**
   - 使用本文档的手动测试清单进行回归测试
   - 确保 `npm test`（Node.js 测试 + lint + build）在每次提交前通过

2. **中期（推荐）**
   - 扩充 `js/scorer.js` 和 `js/api.js` 的边界测试
   - 增加资源提供方、缓存和超时的 Worker 回归场景
   - 持续维护 GitHub Actions CI

3. **长期（可选）**
   - 引入 Playwright 或 Cypress 进行 E2E 测试
   - 为 Worker 添加集成测试（使用 Miniflare）
   - 添加性能基准测试和 Lighthouse CI

---

## 相关文档

- [架构文档](./ARCHITECTURE.md) — 了解系统组件和数据流
- [配置文档](./CONFIGURATION.md) — 环境变量和部署配置
