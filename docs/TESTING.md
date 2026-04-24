<!-- GSD-DOCS: TESTING | mode=create | generated=2026-04-24 -->

# 测试指南

本文档说明 iPlay 项目的测试策略，包括当前已有的测试覆盖、手动测试清单，以及推荐引入的自动化测试方案。

---

## 当前测试状态

iPlay 目前采用轻量级测试策略：

- **CI 测试命令**: `npm test` = `npm run lint && npm run build`
- **单元测试框架**: 未配置（无 Jest / Vitest / Mocha）
- **E2E 测试**: 未配置
- **代码检查**: ESLint（flat config，`eslint.config.mjs`）

> 当前测试覆盖以静态分析和构建验证为主，核心业务逻辑（如 `scorer.js` 的推荐算法）缺乏自动化单元测试。下文提供手动测试清单和推荐的自动化测试接入方案。

---

## 手动测试清单

### 前端功能测试

| 测试项 | 操作步骤 | 预期结果 |
|--------|----------|----------|
| 搜索功能 | 在首页搜索框输入"三体"并回车 | 显示搜索结果列表，包含海报、标题、评分 |
| 搜索结果排序 | 搜索"三体" | 结果按 TMDB 评价数和热度排序 |
| 详情弹窗 | 点击任意搜索结果 | 弹出详情模态框，展示 TMDB / 豆瓣 / IMDb 评分、剧情简介、资源链接 |
| 推荐评分 | 打开详情弹窗 | 显示 AI 推荐评分（0-100）和标签（天选好剧 / 值得一看 / 剧荒打发 / 极度劝退） |
| 夸克资源 | 在详情弹窗查看资源区 | 显示夸克网盘链接（如有） |
| 空状态 | 搜索无结果关键词（如乱码） | 显示"未找到相关结果"提示 |
| 加载状态 | 搜索时观察页面 | 显示旋转加载动画和"Connecting to satellites"文字 |
| 错误状态 | 断网后搜索 | 显示错误提示框，包含"网络存在波动，请稍后重试" |
| 响应式布局 | 在移动端（< 768px）和桌面端分别打开 | 布局自适应，搜索框、海报网格、详情弹窗正常显示 |
| 海报加载 | 搜索热门剧集 | 海报图片正常加载，失败时有兜底处理 |

### 偏好权重测试

| 测试项 | 操作步骤 | 预期结果 |
|--------|----------|----------|
| 默认权重 | 首次打开详情弹窗 | 喜剧 +2.5、恐怖 -3.0 等默认权重生效 |
| 自定义权重 | 在控制台执行 `localStorage.setItem('iplay_preference_weights', JSON.stringify({'喜剧': {score: 5.0, reason: '超爱'}}))` 后刷新 | 自定义权重覆盖默认值，喜剧评分大幅提升 |
| 致命缺陷 | 搜索包含"恐怖"标签的剧集 | 评分上限被限制在 59 分，显示"严重触及雷区" |

---

## 单元测试指南（推荐）

`js/scorer.js` 中的 `calculateRecommendationScore(data)` 是纯函数，非常适合单元测试。建议引入 **Vitest** 作为测试框架（零配置、ESM 原生支持、速度快）。

### 推荐安装

```bash
npm install --save-dev vitest
```

在 `package.json` 中添加测试脚本：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --reporter=verbose"
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
npx wrangler dev worker/_worker.js
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

> 注意：Worker 中有默认的 OMDb API Key（`80077e97`），但生产环境建议配置自己的 Key。

### 缓存测试

Worker 使用 `caches.default` 进行响应缓存。测试时注意观察：

- 首次请求：从上游 API 获取，响应时间较长
- 重复请求：从缓存读取，响应时间显著缩短
- 缓存 TTL：TMDB / 豆瓣 / OMDb / Wiki 为 86400 秒（1天），资源搜索为 43200 秒（12小时）

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
- **详情弹窗打开**: 点击结果后，弹窗应在 500ms 内出现
- **内存泄漏**: 反复打开/关闭详情弹窗，观察内存占用是否持续增长

### 网络异常测试

| 场景 | 操作 | 预期行为 |
|------|------|----------|
| 慢网 | Chrome DevTools Network Throttling 3G | 显示加载状态，请求可完成 |
| 断网 | 断开网络后搜索 | 显示错误状态，不崩溃 |
| 超时 | 模拟 API 响应 > 8s | 请求超时，显示错误提示 |
| 请求取消 | 快速输入多个字符 | 旧请求被 AbortController 取消，仅展示最新结果 |

---

## CI/CD 测试

当前项目无 GitHub Actions 工作流。建议添加 `.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run lint
      - run: npm run build

  # 引入 Vitest 后取消注释：
  # unit-test:
  #   runs-on: ubuntu-latest
  #   steps:
  #     - uses: actions/checkout@v4
  #     - uses: actions/setup-node@v4
  ＃      with:
  ＃        node-version: '20'
  ＃    - run: npm ci
  ＃    - run: npm run test:unit
```

---

## 测试改进路线图

1. **短期（当前）**
   - 使用本文档的手动测试清单进行回归测试
   - 确保 `npm test`（lint + build）在每次提交前通过

2. **中期（推荐）**
   - 引入 Vitest，为 `js/scorer.js` 添加完整单元测试
   - 为 `js/api.js` 添加 mock fetch 测试
   - 配置 GitHub Actions CI 工作流

3. **长期（可选）**
   - 引入 Playwright 或 Cypress 进行 E2E 测试
   - 为 Worker 添加集成测试（使用 Miniflare）
   - 添加性能基准测试和 Lighthouse CI

---

## 相关文档

- [架构文档](./ARCHITECTURE.md) — 了解系统组件和数据流
- [配置文档](./CONFIGURATION.md) — 环境变量和部署配置