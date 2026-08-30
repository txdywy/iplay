<!-- GSD-DOCS: API | mode=create | generated=2026-04-24 -->

# iPlay API 文档

iPlay 后端是一个部署在 Cloudflare Worker 上的 API 代理服务，负责聚合 TMDB、豆瓣、OMDb、夸克网盘和中文 Wikipedia 等多个数据源，为前端提供统一的接口。

---

## Base URL

```
https://iplayw.hackx64.eu.org
```

所有 API 路径均以 `/api` 为前缀。

---

## Authentication

前端调用本 API **无需认证**。Worker 会自动处理与上游数据源的认证：

| 数据源 | 认证方式 | 配置来源 |
|--------|----------|----------|
| TMDB | Bearer Token 或 API Key | `env.TMDB_ACCESS_TOKEN` / `env.TMDB_API_KEY` |
| OMDb | API Key | `env.OMDB_API_KEY`（可选功能，无内置 Key） |
| 豆瓣 / 夸克 / Wikipedia | 无需认证 | — |

> 如果你自行部署 Worker，请在 Cloudflare Dashboard 的 Worker Environment Variables 中配置上述密钥。

---

## 通用规范

- **请求方法**：所有端点仅支持 `GET` 和 `OPTIONS`（CORS 预检）。
- **响应格式**：统一返回 `application/json; charset=UTF-8`。
- **CORS**：默认允许 `https://iplay.hackx64.eu.org`、本地 Wrangler 地址和 `http://localhost:8080` / `http://127.0.0.1:8080`；其他 Origin 通过 `CORS_ALLOWED_ORIGINS` 配置。
- **超时**：前端普通请求默认超时为 **12000ms**，资源搜索和海报聚合为 **18000ms**，支持通过 `AbortController` 取消；Worker 对可回退的多上游接口设置约 **11000ms** 总预算，对资源和海报聚合设置约 **15000ms** 总预算。
- **参数限制**：搜索词与标题去除首尾空白后最长 100 个 Unicode 字符；ID、媒体类型、年份和 IMDb ID 会做格式校验。

### 通用错误响应格式

```json
{
  "error": "错误描述信息"
}
```

常见 HTTP 状态码：

| 状态码 | 含义 |
|--------|------|
| 400 | 缺少必要参数 |
| 404 | 资源未找到 |
| 405 | 请求方法不支持 |
| 429 | 同一客户端超过限流阈值；普通接口为每分钟 60 次，资源搜索为每分钟 10 次；响应包含 `Retry-After: 60` |
| 502 | 上游服务或所有资源提供方不可用 |
| 503 | 所需上游功能未配置（例如缺少 `OMDB_API_KEY`），或生产限流 binding 不可用 |
| 504 | 直连上游请求超时；聚合接口会按可用来源返回部分结果或 `502` |
| 500 | 上游服务异常或内部错误 |

---

## Endpoint Reference

### 1. TMDB 搜索

搜索电影和电视剧，返回 TMDB 多类型搜索结果。

```
GET /api/tmdb/search?q={query}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 是 | 搜索关键词 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/tmdb/search?q=流浪地球"
```

**Example Response：**

```json
{
  "page": 1,
  "totalResults": 2,
  "results": [
    {
      "id": 550988,
      "mediaType": "movie",
      "title": "流浪地球",
      "originalTitle": "The Wandering Earth",
      "year": "2019",
      "poster": "https://image.tmdb.org/t/p/w500/xxx.jpg",
      "backdrop": "https://image.tmdb.org/t/p/w780/yyy.jpg",
      "summary": "太阳即将毁灭，人类在地球表面建造出巨大的推进器...",
      "tmdbRating": 6.4,
      "tmdbVotes": 1205,
      "popularity": 45.2,
      "imdbId": null,
      "matchScore": 1,
      "matchConfidence": "high",
      "matchMethod": "title-exact"
    }
  ],
  "searchMeta": {
    "originalQuery": "流浪地球",
    "normalizedQuery": "流浪地球",
    "year": null,
    "season": null,
    "mediaType": null,
    "strategy": "direct",
    "confidence": "high",
    "matchScore": 1,
    "matchedBy": "title-exact",
    "attempts": 1
  }
}
```

**实现说明：** Worker 会先以 `zh-CN` 进行多类型搜索，并对输入做 Unicode 规范化、季数/年份/发行组噪声拆解、媒体类型识别和标题变体生成。结果按匹配分数优先、评价数和热度次之排序；低置信度时会在总预算约 11 秒、最多 6 次 TMDB 请求内依次尝试 `en-US`、电影/电视剧定向搜索和年份过滤。输入为 IMDb `tt...` 时直接调用 TMDB `/find`；中文查询仍无可靠匹配时，最多从豆瓣建议接口提取 2 个别名再回查 TMDB。低于自动匹配阈值的候选不会返回给前端，避免把热门但不相关的条目误当成结果。

`matchScore` 范围为 `0-1`，综合标题精确/包含/编辑距离、年份和媒体类型；`matchConfidence` 为 `high`、`medium` 或 `low`。`searchMeta.strategy` 可为 `direct`、`normalized`、`typed`、`external-id` 或 `douban-alias`，便于诊断本次命中的路径。

---

### 2. TMDB 详情

获取指定电影或电视剧的详细信息，包含演职员表。

```
GET /api/tmdb/detail?id={id}&type={type}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | number | 是 | TMDB 媒体 ID |
| `type` | string | 否 | 指定类型：`movie` 或 `tv`；未指定时会自动尝试两种类型 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/tmdb/detail?id=550988&type=movie"
```

**Example Response：**

```json
{
  "id": 550988,
  "mediaType": "movie",
  "title": "流浪地球",
  "originalTitle": "The Wandering Earth",
  "year": "2019",
  "poster": "https://image.tmdb.org/t/p/w500/xxx.jpg",
  "backdrop": "https://image.tmdb.org/t/p/w780/yyy.jpg",
  "summary": "太阳即将毁灭，人类在地球表面建造出巨大的推进器...",
  "genres": ["科幻", "冒险", "灾难"],
  "runtime": 125,
  "status": "Released",
  "originalLanguage": "zh",
  "productionCompanies": ["中国电影股份有限公司", "北京文化"],
  "productionCountries": ["China"],
  "cast": ["吴京", "屈楚萧", "李光洁", "吴孟达"],
  "director": ["郭帆"],
  "writer": ["龚格尔", "严东旭"],
  "totalSeasons": null,
  "totalEpisodes": null,
  "seasons": [],
  "tmdbRating": 6.4,
  "tmdbVotes": 1205,
  "imdbId": "tt7605074",
  "popularity": 45.2
}
```

当 `mediaType` 为 `tv` 时，`totalSeasons` 和 `totalEpisodes` 分别表示总季数和总集数；`seasons` 会按季号升序返回每季信息。特别篇使用 `seasonNumber: 0`，尚未公布集数的季度会返回 `episodeCount: null`。

```json
{
  "totalSeasons": 3,
  "totalEpisodes": 20,
  "seasons": [
    { "seasonNumber": 0, "name": "Specials", "episodeCount": 2 },
    { "seasonNumber": 1, "name": "Season 1", "episodeCount": 10 },
    { "seasonNumber": 2, "name": "Season 2", "episodeCount": 8 },
    { "seasonNumber": 3, "name": "Season 3", "episodeCount": null }
  ]
}
```

---

### 3. 豆瓣搜索

通过豆瓣电影搜索接口获取搜索结果。

```
GET /api/douban/search?q={query}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 是 | 搜索关键词 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/douban/search?q=流浪地球"
```

**Example Response：**

```json
[
  {
    "title": "流浪地球",
    "original_title": "The Wandering Earth",
    "alt": "https://movie.douban.com/subject/26266893/",
    "id": "26266893",
    "year": "2019",
    "images": {
      "small": "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2545472803.webp"
    },
    "rating": {
      "average": "7.9"
    }
  }
]
```

> 返回格式为豆瓣原始接口格式，Worker 仅做代理和缓存。

---

### 4. 豆瓣详情

通过 HTML 抓取获取豆瓣电影详情页信息。

```
GET /api/douban/detail?id={id}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 豆瓣条目 ID |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/douban/detail?id=26266893"
```

**Example Response：**

```json
{
  "rating": 7.9,
  "votes": 2150000,
  "genres": ["科幻", "冒险", "灾难"],
  "summary": "近未来，科学家们发现太阳急速衰老膨胀...",
  "imdbId": "tt7605074"
}
```

> 使用 Cloudflare HTMLRewriter 实时解析豆瓣详情页，提取评分、类型、简介和 IMDb ID。

---

### 5. 资源搜索（夸克网盘）

搜索影视资源的夸克网盘分享链接。

```
GET /api/resource?q={query}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 是 | 搜索关键词 |
| `refresh` | `1` | 否 | 显式重试时绕过 Worker 的部分结果缓存，正常访问不需要设置 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/resource?q=流浪地球"
```

**Example Response：**

```json
{
  "resources": [
    {
      "title": "流浪地球 4K HDR 夸克网盘",
      "url": "https://by669.org/d/12345",
      "isQuark": true
    }
  ],
  "wpzysResources": [
    {
      "title": "流浪地球 4K 夸克资源",
      "url": "https://www.wpzys.org/thread-12345-1-1.html",
      "isQuark": true,
      "source": "wpzys"
    }
  ],
  "quarkUrls": [
    {
      "title": "流浪地球 4K HDR 夸克网盘",
      "url": "https://pan.quark.cn/s/xxxxxxx",
      "password": "a1B2",
      "sourceUrl": "https://by669.org/d/12345",
      "sourceTitle": "流浪地球 4K HDR 夸克网盘"
    }
  ]
}
```

**实现说明：** `resources` 与 `wpzysResources` 分别保存 By669 和 WPZYS 搜索结果；Worker 再以轮询方式从两个提供方选择最多 12 个详情页，避免单一来源占满详情抓取配额，汇总去重后的 `quarkUrls`。`password` 为可选字段，来源页没有可识别的提取码时不会返回。详情页每批并发 6 个请求，单页最多提取 25 个链接、整次请求最多返回 100 个链接，并受约 15 秒总预算与单次请求超时约束。一个提供方或任一详情页失败时仍返回可用结果并短暂缓存，同时返回 `partial: true` 和 `resourceMeta`（提供方状态、选中/尝试/失败页数）；两者都失败时返回 `502` 且不缓存。

---

### 6. OMDb 代理

代理 OMDb API，用于获取 IMDb 评分、烂番茄评分和海报等信息。

```
GET /api/omdb?imdb={imdbId}
GET /api/omdb?title={title}&year={year}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `imdb` | string | 条件必填 | IMDb ID（如 `tt7605074`），与 `title` 二选一；兼容旧参数 `i` |
| `title` | string | 条件必填 | 影片英文标题 |
| `year` | string | 否 | 发行年份 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/omdb?imdb=tt7605074"
curl "https://iplayw.hackx64.eu.org/api/omdb?title=The+Wandering+Earth&year=2019"
```

**Example Response：**

```json
{
  "omdb": true,
  "imdb": 6.0,
  "imdbVotes": "12,345",
  "rottenTomatoes": 70,
  "poster": "https://m.media-amazon.com/images/...jpg",
  "title": "The Wandering Earth",
  "year": "2019",
  "type": "movie",
  "rated": "PG-13",
  "released": "05 Feb 2019",
  "runtime": "125 min",
  "genres": ["Action", "Sci-Fi", "Adventure"],
  "director": "Frant Gwo",
  "writer": "Gong Geer, Yan Dongxu",
  "actors": "Jing Wu, Chuxiao Qu, Guangjie Li",
  "plot": "As the sun is dying out...",
  "language": "Mandarin, English, Russian",
  "country": "China",
  "awards": "3 wins & 8 nominations",
  "boxOffice": "$699,990,000",
  "production": "China Film Group Corporation",
  "metascore": 57,
  "imdbId": "tt7605074"
}
```

---

### 7. 海报获取

智能海报获取接口：优先从 TMDB 获取高清海报，失败时自动降级到 OMDb。若中文标题在 OMDb 未找到，还会尝试通过中文 Wikipedia 查找英文标题后再搜索 OMDb。

至少需要配置 TMDB 或 OMDb 中的一个来源；两者都未配置时返回 `503`。所有已配置来源健康时聚合结果缓存 24 小时；某个已配置来源临时失败但仍有可用结果时只缓存 15 分钟。若没有可用结果，接口保留上游的 `429`、`5xx` 或 `504` 状态，而不是误报为未找到。

```
GET /api/poster?title={title}&year={year}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 是 | 影片标题（支持中文） |
| `year` | string | 否 | 发行年份，用于提高匹配准确度 |
| `refresh` | `1` | 否 | 海报加载失败后的重试会设置此参数，以绕过旧缓存 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/poster?title=流浪地球&year=2019"
```

**Example Response（TMDB 命中）：**

```json
{
  "poster": "https://image.tmdb.org/t/p/w500/xxx.jpg",
  "tmdbRating": 6.4,
  "tmdbVotes": 1205,
  "rottenTomatoes": null,
  "tmdb": true,
  "tmdbId": 550988,
  "mediaType": "movie",
  "omdb": {
    "omdb": true,
    "imdb": 6.0,
    "imdbVotes": "12,345",
    "rottenTomatoes": 70,
    "poster": "https://m.media-amazon.com/images/...jpg",
    "title": "The Wandering Earth",
    ...
  }
}
```

**Example Response（OMDb 兜底命中）：**

```json
{
  "omdb": true,
  "imdb": 6.0,
  "imdbVotes": "12,345",
  "rottenTomatoes": 70,
  "poster": "https://m.media-amazon.com/images/...jpg",
  "title": "The Wandering Earth",
  "year": "2019",
  ...
}
```

---

### 8. 中文 Wikipedia 摘要

获取中文 Wikipedia 页面摘要。

```
GET /api/wiki/zh?q={query}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 是 | 搜索关键词 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/wiki/zh?q=流浪地球"
```

**Example Response：**

```json
{
  "title": "流浪地球 (电影)",
  "extract": "《流浪地球》是一部2019年中国科幻电影...",
  "thumbnail": {
    "source": "https://upload.wikimedia.org/wikipedia/...",
    "width": 320,
    "height": 480
  }
}
```

---

## Rate Limits / Caching

Worker 通过 Cloudflare Rate Limiting bindings 按客户端 IP 限制请求：普通接口每 60 秒最多 60 个请求，资源搜索每 60 秒最多 10 个请求；未配置 binding 时仅在开发/测试环境回退到进程内计数器，已配置的 production binding 发生故障时会 fail closed 返回 `503`，避免退化为可被分布式绕过的单实例计数。预检请求不计入限流。被限流或限流服务不可用的响应带有 `Retry-After: 60`。

| 接口 | 缓存时长 | 缓存键 |
|------|----------|--------|
| `/api/tmdb/search` | 24h | TMDB 原始请求 URL |
| `/api/tmdb/detail` | 24h | TMDB 原始请求 URL |
| `/api/douban/search` | 24h | `douban-search-cache.local/?q={query}` |
| `/api/douban/detail` | 24h | `douban-detail-cache.local/?id={id}` |
| `/api/resource` | 完整结果 12h；提供方或详情页部分失败 15min | `resource-search-v5-cache.local/?q={query}` |
| `/api/omdb` | 24h | `omdb-cache.local/id/{imdbId}` 或 `omdb-cache.local/search/?t={title}&y={year}` |
| `/api/poster` | 完整聚合 24h；已配置来源部分失败 15min | `poster-v1-cache.local/?title={title}&year={year}&sources={sources}` |
| `/api/wiki/zh` | 24h | `wiki-zh-cache.local/?q={query}` |

> 缓存使用 Cloudflare Worker 的 `caches.default` API。缓存命中时直接返回，不向上游发起请求。

Worker 还配置了 6 小时一次的 Cloudflare Cron Trigger。定时任务会刷新 `CRON_REFRESH_TITLES` 中配置的标题缓存；未配置时默认刷新 `大叔再出招`，并绕过旧缓存重新写入 TMDB 搜索和详情缓存。

---

## 前端 API Client 参考

前端使用 `js/api.js` 中的模块与 Worker 通信。所有方法均支持 `options.signal` 传入 `AbortController.signal` 以取消请求。

### 前端搜索与恢复行为

`js/main.js` 使用 `js/match.js` 对 Worker 返回的候选进行二次判断：高置信度且分数明显领先的结果会直接加载详情；中低置信度或分数接近的结果会先展示最多 6 个候选，让用户确认标题、年份和媒体类型。

搜索结果会先于详情接口出现，详情接口失败时页面会保留 TMDB 搜索候选中的基础信息，并在结果顶部显示“重试详情”；现代浏览器中的资源聚合默认延后到资源区接近视口或用户主动点击后执行，不支持 IntersectionObserver 的旧环境才使用空闲回调或定时回退。资源接口返回部分成功时，三个资源列表会保留可用内容，并显示“重试补全资源”；完全失败时三个资源列表各自显示可重试状态。资源列表首屏最多渲染 6 项，用户可展开到接口返回上限，减少移动端首屏高度和无效 DOM。

剧集详情会在 TMDB facts 和数据档案中展示总季数、总集数以及每季集数。季数数据由 Worker 归一化后交给 `js/seasons.js` 格式化，未知集数会明确显示为“待定”。

### 通用配置

| 配置项 | 值 |
|--------|-----|
| `API_BASE` | `https://iplayw.hackx64.eu.org` |
| 默认超时 | `12000ms` |

### `TmdbAPI`

```javascript
import { TmdbAPI } from './api.js';

// 搜索
const results = await TmdbAPI.search('流浪地球');

// 详情
const detail = await TmdbAPI.getDetail(550988, 'movie');
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `search` | `(query, options = {})` | `{ page, totalResults, results[], searchMeta }` |
| `getDetail` | `(id, type, options = {})` | 详情对象 |

### `DoubanAPI`

```javascript
import { DoubanAPI } from './api.js';

const results = await DoubanAPI.search('流浪地球');
const detail = await DoubanAPI.getDetail('26266893');
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `search` | `(query, options = {})` | 豆瓣原始搜索结果数组 |
| `getDetail` | `(id, options = {})` | `{ rating, votes, genres[], summary, imdbId }` |

### `WikiAPI`

```javascript
import { WikiAPI } from './api.js';

const summary = await WikiAPI.getSummary('流浪地球');
// 失败时返回 null，不会抛错
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `getSummary` | `(query, options = {})` | `{ title, extract, thumbnail }` 或 `null` |

### `OmdbAPI`

```javascript
import { OmdbAPI } from './api.js';

const profile = await OmdbAPI.getById('tt7605074');
// 网络或上游失败时返回 null；调用方可继续使用 TMDB 数据
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `getById` | `(imdbId, options = {})` | OMDb 详情对象 或 `null` |
| `search` | `(title, year, options = {})` | OMDb 详情对象 或 `null` |

### `ResourceAPI`

```javascript
import { ResourceAPI } from './api.js';

const { resources, wpzysResources, quarkUrls } = await ResourceAPI.search('流浪地球');
// HTTP 或网络失败时会抛出异常
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `search` | `(query, options = {})` | `{ resources[], wpzysResources[], quarkUrls[] }` |

### `PosterAPI`

```javascript
import { PosterAPI } from './api.js';

const poster = await PosterAPI.getPoster('流浪地球', '2019');
// 失败时返回 null
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `getPoster` | `(title, year, options = {})` | 海报对象 或 `null` |

### 取消请求示例

```javascript
const controller = new AbortController();

// 5 秒后自动取消
setTimeout(() => controller.abort(), 5000);

try {
  const results = await TmdbAPI.search('流浪地球', { signal: controller.signal });
} catch (e) {
  if (e.name === 'AbortError') {
    console.log('请求已取消');
  }
}
```

---

## 部署与配置

Worker 源码位于 `worker/_worker.js`。自行部署时：

1. 在 Cloudflare Dashboard 创建新的 Worker
2. 上传 `worker/_worker.js`
3. 在 Worker Settings > Variables 中添加环境变量：
   - `TMDB_ACCESS_TOKEN`（推荐）或 `TMDB_API_KEY`
   - `OMDB_API_KEY`（可选；无内置 Key，未配置时 OMDb 功能返回 `503`）
   - `CORS_ALLOWED_ORIGINS`（可选，额外前端 Origin 的逗号分隔列表）

详见 [DEPLOYMENT.md](DEPLOYMENT.md) 和 [CONFIGURATION.md](CONFIGURATION.md)。
