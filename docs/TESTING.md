<!-- GSD-DOCS: TESTING | mode=create | generated=2026-04-24 -->

# 测试指南

本文档说明 iPlay 项目的测试策略，包括当前已有的测试覆盖、手动测试清单，以及推荐引入的自动化测试方案。

---

## 当前测试状态

iPlay 目前采用轻量级测试策略：

- **CI 测试命令**: `npm test` = `node --test && npm run lint && npm run build`
- **单元测试框架**: Node.js 内置测试运行器（无需 Jest / Vitest）
- **浏览器烟测**: `tests/browser-smoke.mjs`，通过 Chrome DevTools Protocol 覆盖关键页面行为
- **原生 Workers 验证**: `npm run test:runtime`，从真实 `wrangler.toml` 读取入口、变量、兼容日期/flags 和限流配置，实际运行 workerd、Cache API、HTMLRewriter 和限流 bindings；上游请求全部拦截，无需真实密钥。
- **CI 版本矩阵**: Node.js 22 / 24，生产打包和原生运行时检查在 Node.js 22 执行。
- **代码检查**: ESLint（flat config，`eslint.config.mjs`）
- **覆盖率命令**: `npm run test:coverage`
- **上线验证**: `npm run test:live`，显式请求生产站点，校验无版本参数的首页及带版本的 HTML、生产单文件入口、全部源码模块、CSS、VERSION 与本地逐字一致，以及 Worker 发布响应头、中英文/带年份片名搜索、电影/剧集 ID、人物分页、空身份参数拒绝与 CORS。可用 `LIVE_BASE_URL` / `LIVE_API_BASE` 指向其他部署。
- **可选数据源**: 上线验证会单独报告 OMDb、Wikipedia、资源服务的可用/部分失败状态；不能把这些上游的暂时失败当作核心服务成功，也不会将其混同为代码部署失败。

> 现有 `tests/` 覆盖 API 客户端、推荐算法、夸克链接处理和 Worker 路由。下文提供手动回归清单以及继续扩展自动化测试的参考。

---

## 手动测试清单

### 前端功能测试

| 测试项 | 操作步骤 | 预期结果 |
|--------|----------|----------|
| 搜索功能 | 在首页搜索框输入"三体"并回车 | 显示搜索结果列表，包含海报、标题、评分 |
| 演员搜索 | 在首页搜索框输入演员姓名并回车 | 显示该演员的电视剧 / 电影作品分组，作品卡片可打开影视详情 |
| 演员互跳 | 在影视详情的演员列表点击演员姓名 | 搜索框切换为该演员姓名并显示演员作品列表 |
| 搜索结果排序 | 搜索"三体" | 结果优先按标题匹配置信度排序，再按 TMDB 评价数和热度排序 |
| 搜索输入增强 | 搜索带有“第二季 1080P”、年份或 IMDb `tt...` 的关键词 | 自动拆解季数/年份/类型，必要时使用定向 TMDB 查询或 IMDb 直查 |
| 片名中的类型词 | 搜索 `The Truman Show 1998`、`The TV Set 2006`、`电影少女2018`，再附加独立类型词 | 保留完整片名与年份；只有片名外的类型指令限制媒体类型 |
| 详情展示 | 提交搜索 | 自动选择最佳 TMDB 匹配并逐步展示 TMDB / 豆瓣 / IMDb 评分、剧情简介与资源链接 |
| 推荐评分 | 查看搜索结果详情 | 显示基于评分、热度与题材权重的个性化指数（0-100）和标签，并注明并非 AI 预测 |
| 分享与重载 | 复制影视/同名演员分享链接后重新打开 | 影视补充查询使用确认后的真实片名；演员直接恢复已选人物 ID，不再次猜测同名人物 |
| 演员失败恢复 | 选定同名演员或打开其分享链接，模拟人物接口失败后重试 | 继续请求相同人物 ID，不重新按姓名匹配 |
| 分享类型校验 | 打开带 `type=book`、`type=` 或 `type=MOVIE` 的详情分享链接 | 前两者显示错误且不请求 API；大写合法类型归一化为 `movie` |
| 分享 ID 校验 | 打开含空、零、负数、混合字符或过长 `person` / `id` 的链接 | 显示错误且零 API 请求；缺省 `person` 的旧版演员链接仍能恢复 |
| 详情元数据更新 | 延迟详情响应，并返回与候选不同的片名和年份 | 候选立即显示；补充简介、评分和海报回退使用详情确认后的片名与年份 |
| 详情重试保留 | 首次详情失败但补充评分和简介成功，再次重试并模拟补充服务失败 | 等待和失败时保留旧资料；同身份恢复后仍保留，片名/年份或 IMDb ID 改变时清除对应旧资料 |
| 资源补全恢复 | 展开部分资源列表，模拟补全请求加载缓慢并失败 | 链接、复制密码及展开状态保留；补全按钮在请求期间禁用，失败后可继续重试 |
| 完整资源可达 | 返回 100 个分享、两组各 20 个来源，展开三个列表 | 首屏各显示 6 项，展开后全部可访问，第 100 个分享仍能复制密码 |
| 长资源标题与键盘 | 使用连续长文件名，在 390px 视口按 Enter 展开、Tab 前进、Space 收起 | 完整文字换行且页面不横向溢出；展开进入第一个新分享及复制按钮，收起回展开控件，滚动位置保留 |
| 夸克资源 | 查看资源区 | 分别显示 By669、WPZY 和提取出的夸克分享链接（如有） |
| 空状态 | 搜索无结果关键词（如乱码） | 显示"未找到相关结果"提示 |
| 加载状态 | 搜索时观察页面 | 显示旋转加载动画和“正在连接数据源”文字 |
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
| `tests/fresh-quality.test.js` | 带年份/发行标签的完整片名、最长片名与错误年份、空身份参数零上游请求、旧版缺省类型兼容 |
| `tests/resource-bounds.test.js` | 完整 token/URL 长度限制、12 个接近体积上限页面、来源元数据上限，以及内外缓存策略分离 |
| `tests/wiki-year-evidence.test.js` | 原作与修复/重映/获奖年份分离、独立地区发行年份、标题显式年份冲突 |
| `tests/worker-runtime-config.test.js` | 配置变更确实传入原生运行时，绑定名称/阈值/namespace、production 与变量保留政策退化被阻断 |
| `tests/resource-scheduling.test.js` | 慢页不阻塞队列续发、乱序返回保持密码证据和顺序、并发/数量/截止期限保持有界 |

```bash
npm test
npm run test:coverage
```

浏览器烟测不依赖额外 npm 包，但需要将脚本连接到隔离的 Chrome 页面，并先启动静态服务器：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
BROWSER_WS='ws://127.0.0.1:9224/devtools/page/<page-id>' npm run test:browser
```

烟测覆盖首屏搜索、资源区进入视口后的自动启动、资源失败重试与展开列表保留、所选演员 ID 的失败恢复、分享 ID 和媒体类型校验、详情片名/年份更新后的补充查询、旧搜索请求保护，以及不支持 `IntersectionObserver` 时的定时器回退。可直接运行 `npm run test:browser:ci` 自动启动隔离 Chrome 和本地静态服务器。

1.0.16 包含 38 条命名浏览器流程，覆盖全部资源可达、详情重试保留及恢复后的身份校验、长资源标题与真实键盘操作。测试拦截 API 并阻止 Google Fonts 请求，避免外部字体服务阻塞冷启动；这组检查验证应用行为，不代表已验证字体 CDN 或所有第三方服务。静态服务与 Chrome 调试端口准备检查对响应头和正文都设置实际截止期限。生产数据由 `test:live` 单独验证，可设置 `LIVE_REQUIRE_WPZY=1` 要求 WPZY 搜索成功且至少验证一个公开帖中的分享链接；资源响应另需确认对外 `no-store`。

1.0.17 继续执行上述 38 条流程，页面使用实际压缩产物；演员分页额外断言旧卡片未被替换、筛选和重试仍正确。CI 会重新生成 CSS 和单文件入口并检查无差异。

1.0.18 增至 40 条流程：新增已确认无海报时省去重复查询，以及演员图片响应式选择。图片检查覆盖多组视口/DPR及增大的默认字体、实际选中候选与布局宽度、404 后清除 srcset 并显示占位图、非 TMDB 图片和不适合作为 srcset 的 URL。无图检查同时验证 OMDb 失败或身份不匹配时仍调用备用流程。返回导航流程通过真实 Enter 激活页面，并等待 URL、history 状态和可见结果，避免隐藏旧标题导致假通过，以及 Chrome 裁剪未激活历史条目造成测试串扰。

### 可重复性能验证

```bash
PERF_OUTPUT=/tmp/iplay-mobile.json PERF_TRACE=/tmp/iplay-mobile-trace.json npm run test:performance
PERF_PROFILE=desktop PERF_OUTPUT=/tmp/iplay-desktop.json npm run test:performance
PERF_OUTPUT=/tmp/iplay-worker.json npm run test:performance:worker
PERF_OUTPUT=/tmp/iplay-search.json npm run test:performance:search
PERF_OUTPUT=/tmp/iplay-parser.json npm run test:performance:parser
PERF_OUTPUT=/tmp/iplay-parser-diff.json node tests/resource-parser-differential.mjs
```

浏览器基准使用固定 API、字体隔离、3 次冷缓存加载、288 张演员卡片、真实点击事件与 100 项资源展开。默认 390×844、300ms 延迟、96 KiB/s 下载、6 倍 CPU 降速；桌面为 1280×900、40ms、1536 KiB/s、原生 CPU。`SMOKE_SITE_ROOT` 可指向历史静态快照，复用相同测量脚本；不操作用户日常浏览器。追踪为 Chrome JSON，可导入 DevTools。

资源基准模拟 12 页，其中第 1/7 页各 600ms、其余 30ms，通过公开 Worker 路由验证结果顺序、12 页完成和并发不超过 6。所有性能数值均为实验室数据；单次 Event Timing 不是现场 INP。CI 验证功能和调度约束，不把硬件相关的绝对时延当作稳定门槛。

搜索基准默认以 `9a53377`（1.0.17）为基线，`PERF_BASE_REF` 可覆盖；它使用固定上游、15 轮交错运行与预热，核对完整响应和上游调用序列，并单独统计纯文本评分调用次数。解析基准通过公开资源路由读取普通页面及约 2MiB 的 200,000 外链页面；瞬时 heap delta 是 Node 进程样本，不是峰值内存或 workerd CPU。差分脚本仅在内存中的分析模块导出旧/新私有解析函数，以固定种子生成 30,000 页面、五种容量共 150,000 比较；不改变生产导出。

演员图片字节模型需要先下载三个公开 JPEG 变体（不提交海报图片）：

```bash
mkdir -p /tmp/iplay-image-fixture
for size in 185 342 500; do
  curl --fail --location --output "/tmp/iplay-image-fixture/w${size}.jpg" \
    "https://image.tmdb.org/t/p/w${size}/eMurN09rDC2qeEv3npkUbcJfIXN.jpg"
done
IMAGE_FIXTURE_DIR=/tmp/iplay-image-fixture PERF_OUTPUT=/tmp/iplay-images.json npm run test:performance:images
```

该模型在 Chrome 拦截器中发送真实 JPEG 字节，分别检查移动 DPR 1/2/3 与桌面 DPR 1/2，记录当前选中的位图、卡片宽度、请求数与缓存状态。三张卡共享一张图，避免把请求去重误计成收益；输入文件的尺寸和 SHA-256 均记录。`fulfilledBodyBytes` 为模型实际发送的 JPEG 载荷，独立于 CDP 的 `encodedDataLength`（拦截响应可能为 0），不代表公网 CDN 时延或所有海报的压缩比例。

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
- Worker 内部缓存 TTL：TMDB / 豆瓣 / OMDb / Wiki 与完整海报聚合为 86400 秒（1天），完整资源搜索为 43200 秒（12小时）
- 资源搜索使用 `resource-search-v12-cache.local` 命名空间并包含内部登录态指纹；更换或撤销 WPZY Secret 不复用旧 Worker 缓存。页面状态与独立分享证据支持跨次重试；提供方或详情页失败时的部分结果只缓存 900 秒（15 分钟）
- 资源响应在 miss/hit/refresh 时对浏览器均为 `no-store`，同时检查内部缓存副本仍保留 43200/900 秒；客户端默认也绕过历史 HTTP 缓存，不能只检查显式重试。
- `tests/wpzy-access.test.js` 覆盖站点 Cookie 白名单、同源与跨提供方跳转、登录失效、回复/VIP 限制、别名归一化、只读路径和账号缓存隔离；测试使用虚构 Cookie，不需要真实登录态
- 海报聚合使用 `poster-v4-cache.local` 命名空间；已配置来源部分失败时的可用结果只缓存 900 秒
- OMDb 使用 `omdb-v3-cache.local`；Wiki 使用 `wiki-zh-v5-cache.local`，并将媒体类型和年份纳入缓存键。前端资源和 Wiki 请求携带发布版本，隔离旧浏览器缓存。
- `tests/review-regressions.test.js` 验证缺失/畸形人物作品、媒体演职员与外部 ID 数据不写入缓存、旧缓存重取及 Wikipedia 首句年份冲突；`test:runtime` 在真实 workerd 中验证这些失败不会阻止上游恢复。

---

## 前端测试清单

### 浏览器兼容性

| 浏览器 | 目标版本 | 测试重点 |
|--------|----------|----------|
| Chrome | 111+ | 隔离 Chrome 自动回归覆盖功能与移动/桌面布局 |
| Safari | 16.4+ | iOS、Backdrop Filter，需真实设备人工验证 |
| Firefox | 128+ | Fetch API、AbortController，需人工验证 |
| Edge | 111+ | Chromium 内核，需人工验证 |

目标版本依据 [Tailwind CSS v4 浏览器要求](https://tailwindcss.com/docs/compatibility#browser-support)，不代表已在每个最低版本完成测试。CI 使用安装的 Chrome 执行自动回归；Safari、Firefox 与 Edge 的验证状态需在实际测试后记录。

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
| 超时 | 模拟 API 响应 > 12s | 请求超时，显示错误提示 |
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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: git diff --exit-code -- css/output.css assets/app.min.js
      - run: npm run deploy:worker:dry-run
      - run: npm run test:runtime
      - uses: browser-actions/setup-chrome@v1
      - run: npm run test:browser:ci
```

浏览器冒烟脚本会启动隔离的无头 Chrome 和本地静态服务器，覆盖渐进详情、详情重试、资源部分成功恢复、连续搜索取消、海报失败兜底及旧环境定时回退。

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
   - 扩大现有 Miniflare/workerd 集成场景，持续覆盖缓存和上游恢复
   - 添加性能基准测试和 Lighthouse CI

---

## 相关文档

- [架构文档](./ARCHITECTURE.md) — 了解系统组件和数据流
- [配置文档](./CONFIGURATION.md) — 环境变量和部署配置
