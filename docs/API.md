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
| OMDb | API Key | `env.OMDB_API_KEY`（兜底值：`80077e97`） |
| 豆瓣 / 夸克 / Wikipedia | 无需认证 | — |

> 如果你自行部署 Worker，请在 Cloudflare Dashboard 的 Worker Environment Variables 中配置上述密钥。

---

## 通用规范

- **请求方法**：所有端点仅支持 `GET` 和 `OPTIONS`（CORS 预检）。
- **响应格式**：统一返回 `application/json; charset=UTF-8`。
- **CORS**：已全局开启 `Access-Control-Allow-Origin: *`。
- **超时**：前端默认请求超时为 **8000ms**，支持通过 `AbortController` 取消。

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
| 500 | 上游服务异常或内部错误 |

---

## Endpoint Reference

### 1. TMDB 搜索

搜索电影和电视剧，返回 TMDB 多类型搜索结果。

```
GET /api/tmdb/search?q={query}&page={page}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 是 | 搜索关键词 |
| `page` | number | 否 | 页码，默认 1 |

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
      "poster": "https://image.tmdb.org/t/p/w342/xxx.jpg",
      "backdrop": "https://image.tmdb.org/t/p/w780/yyy.jpg",
      "summary": "太阳即将毁灭，人类在地球表面建造出巨大的推进器...",
      "tmdbRating": 6.4,
      "tmdbVotes": 1205,
      "popularity": 45.2,
      "imdbId": null
    }
  ]
}
```

**实现说明：** Worker 会先以 `zh-CN` 语言搜索，若无有效结果则自动降级到 `en-US`。结果按 `tmdbVotes` 降序排列，去重后返回。

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
  "tmdbRating": 6.4,
  "tmdbVotes": 1205,
  "imdbId": "tt7605074",
  "popularity": 45.2
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
  "quarkUrls": [
    {
      "title": "流浪地球 4K HDR 夸克网盘",
      "url": "https://pan.quark.cn/s/xxxxxxx",
      "sourceUrl": "https://by669.org/d/12345",
      "sourceTitle": "流浪地球 4K HDR 夸克网盘"
    }
  ]
}
```

**实现说明：** Worker 从 by669.org 搜索讨论帖，提取包含夸克网盘链接的帖子，并进一步抓取帖子详情页获取实际分享链接。最多抓取前 10 个结果，批量并发 5 个请求。

---

### 6. OMDb 代理

代理 OMDb API，用于获取 IMDb 评分、烂番茄评分和海报等信息。

```
GET /api/omdb?i={imdbId}
GET /api/omdb?title={title}&year={year}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `i` | string | 条件必填 | IMDb ID（如 `tt7605074`），与 `title` 二选一 |
| `title` | string | 条件必填 | 影片英文标题 |
| `year` | string | 否 | 发行年份 |

**Example Request：**

```bash
curl "https://iplayw.hackx64.eu.org/api/omdb?i=tt7605074"
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

```
GET /api/poster?title={title}&year={year}
```

**Query Parameters：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 是 | 影片标题（支持中文） |
| `year` | string | 否 | 发行年份，用于提高匹配准确度 |

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

Worker 对所有上游 API 响应进行了缓存，前端调用不受上游 rate limit 直接影响。

| 接口 | 缓存时长 | 缓存键 |
|------|----------|--------|
| `/api/tmdb/search` | 24h | TMDB 原始请求 URL |
| `/api/tmdb/detail` | 24h | TMDB 原始请求 URL |
| `/api/douban/search` | 24h | `douban-search-cache.local/?q={query}` |
| `/api/douban/detail` | 24h | `douban-detail-cache.local/?id={id}` |
| `/api/resource` | 12h | `resource-search-cache.local/?q={query}` |
| `/api/omdb` | 24h | `omdb-cache.local/id/{imdbId}` 或 `omdb-cache.local/search/?t={title}&y={year}` |
| `/api/poster` | 24h（依赖 TMDB/OMDb 子缓存） | — |
| `/api/wiki/zh` | 24h | `wiki-zh-cache.local/?q={query}` |

> 缓存使用 Cloudflare Worker 的 `caches.default` API。缓存命中时直接返回，不向上游发起请求。

---

## 前端 API Client 参考

前端使用 `js/api.js` 中的模块与 Worker 通信。所有方法均支持 `options.signal` 传入 `AbortController.signal` 以取消请求。

### 通用配置

| 配置项 | 值 |
|--------|-----|
| `API_BASE` | `https://iplayw.hackx64.eu.org` |
| 默认超时 | `8000ms` |

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
| `search` | `(query, options = {})` | `{ page, totalResults, results[] }` |
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

### `ResourceAPI`

```javascript
import { ResourceAPI } from './api.js';

const { resources, quarkUrls } = await ResourceAPI.search('流浪地球');
// 失败时返回 { resources: [], quarkUrls: [] }
```

| 方法 | 签名 | 返回值 |
|------|------|--------|
| `search` | `(query, options = {})` | `{ resources[], quarkUrls[] }` |

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
   - `OMDB_API_KEY`（可选，有兜底值）

详见 [DEPLOYMENT.md](DEPLOYMENT.md) 和 [CONFIGURATION.md](CONFIGURATION.md)。
