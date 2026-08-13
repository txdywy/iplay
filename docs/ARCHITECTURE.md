<!-- generated-by: gsd-doc-writer -->

# iPlay Architecture

## System Overview

iPlay ("沉浸式观影指南与推荐系统") is a Chinese immersive movie/TV recommendation web application with a "dark cinema" retro aesthetic. The system aggregates data from multiple public sources (TMDB, Douban, OMDb, Wikipedia, and resource sites) to provide personalized viewing recommendations. It follows a serverless, zero-cost architecture: a static frontend hosted on GitHub Pages paired with a Cloudflare Worker acting as a CORS-bypass proxy and data aggregator at the edge.

**Primary inputs:** User search queries (Chinese or English movie/TV titles).  
**Primary outputs:** Aggregated detail pages with ratings, plot summaries, cast info, resource links, and a personalized AI recommendation score.

---

## High-Level Architecture

```
+---------------------------------------------------+
|                    GitHub Pages                    |
|  (Static Hosting - Zero Server Cost)              |
|                                                   |
|  +-------------+  +-------------+  +-------------+|
|  |  index.html |  |  js/main.js |  | css/output  ||
|  |  (SPA Shell)|  |  (UI/Logic) |  |  (Styles)   ||
|  +-------------+  +-------------+  +-------------+|
|         |                  |                      |
|         +------------------+                      |
|                   |                               |
|              fetch() calls                        |
|                   |                               |
+---------|---------|-------------------------------+
          |         |
          |    HTTPS /api/*
          |         |
+---------v---------|-------------------------------+
|         |         |      Cloudflare Worker         |
|         |         |  (Edge CDN - Global)           |
|         |         |                                |
|  +------v---------v------+                       |
|  |   worker/_worker.js   |  CORS proxy + data     |
|  |   (ES module)         |  aggregator + cache    |
|  +-----------+-----------+                       |
|              |                                    |
|  +-----------+-----------+-----------+----------+|
|  |           |           |           |          ||
|  v           v           v           v          ||
| TMDB      Douban      OMDb      Wikipedia  Resources||
| (Primary) (Chinese    (IMDb/    (Chinese   (By669 + ||
|           ratings)    RT data)  plot)       WPZYS)  ||
+---------------------------------------------------+
```

---

## Data Flow

### 1. Search Flow

```
User submits query from search form
        |
        v
+-------+-------+
|  js/main.js   |  -- Cancels any older request
+-------+-------+
        |
        v
+-------+-------+
|   js/api.js   |  -- fetchWithTimeout() to Worker
|  (TmdbAPI)    |     AbortController, 8s default
+-------+-------+
        |
        v
+-------+-------+
| Worker /api/  |
| tmdb/search   |  -- Calls TMDB zh-CN first,
|               |     falls back to en-US
+-------+-------+
        |
        +---> TMDB API (search/multi)
        |
        v
+-------+-------+
|  Worker cache |  -- caches.default, 24h TTL
|  + normalize  |
+-------+-------+
        |
        v
+-------+-------+
|  Frontend     |  -- Renders results list with
|  (main.js)    |     poster, title, year, rating
+---------------+
```

### 2. Detail Page Flow

After search, the frontend selects the best TMDB match, renders its core detail, then starts independent enrichment requests:

```
User submits a search
        |
        v
+-------+-------+
|  js/main.js   |  -- pickBestTmdbMatch() selects
|               |     optimal result
+-------+-------+
        |
        +--------+--------+--------+--------+
        |        |        |        |        |
        v        v        v        v        v
    TMDB     Douban    Wiki    Poster   Resource
   Detail    Detail   Summary   API      Search
   API       API      API               API
        |        |        |        |        |
        v        v        v        v        v
+-------+--------+--------+--------+--------+
|           Cloudflare Worker               |
|  - Validates parameters and applies timeout|
|  - Caches upstream responses independently |
|  - Returns one JSON response per endpoint  |
+-------------------------------------------+
        |
        v
+-------+-------+
|  js/main.js   |  -- Progressive rendering:
|               |     1. Show skeleton/loading
|               |     2. Render poster + basic info
|               |     3. Render ratings (TMDB, Douban, IMDb, RT)
|               |     4. Render AI score + analysis
|               |     5. Render wiki summary + resources
+---------------+
```

### 3. Poster Resolution Flow

```
Frontend requests /api/poster?title=X&year=Y
        |
        v
+-------+-------+
|    Worker     |  -- Concurrent fetch:
|               |     tryTmdbForPoster() + tryOmdbForPoster()
+-------+-------+
        |
   +----+----+
   |         |
   v         v
TMDB      OMDb
search    search
   |         |
   v         v
TMDB    OMDb poster
poster  found?
found?      |
   |    +----+----+
   |    |         |
   |    v         v
   |  Return   Try Wikipedia
   |  OMDb     English title
   |  data     lookup
   |              |
   |              v
   |           Retry OMDb
   |           with en title
   |              |
   +------+------+
          |
          v
   Return aggregated
   poster + ratings
```

---

## Component Breakdown

### Frontend Components

| Component | File | Description |
|-----------|------|-------------|
| **SPA Shell** | `index.html` | Single-page application shell. Dark theme (`#0a0a0c`), Netflix-red accent (`#e50914`), film grain SVG overlay, ambient glow radial gradient, typewriter cursor animation. Responsive layout with poster sidebar + content area. |
| **UI Controller** | `js/main.js` | Search form handling, best-match selection, progressive detail rendering, preference settings, resource states, and toast notifications. |
| **API Client** | `js/api.js` | API client with `fetchWithTimeout` (AbortController, 8s default timeout; 20s for resource search). Exports `TmdbAPI`, `DoubanAPI`, `WikiAPI`, `ResourceAPI`, `PosterAPI`. |
| **Quark Formatter** | `js/quark.js` | Formats share URLs and optional extraction passwords for clipboard copy. |
| **Scoring Engine** | `js/scorer.js` | Client-side recommendation algorithm. Genre preference weights loaded from `localStorage` (key `iplay_preference_weights`). Score = base (rating) + heat (votes/wiki) + preference (genre match). Fatal flaws (score <= -2.5 genres) cap at 59. |
| **Styles** | `css/input.css` / `css/output.css` | Tailwind CSS v4 with custom theme: `Noto Serif SC` + `Space Mono` fonts, cinema color palette (`cinema-900` through `cinema-100`), accent red and gold. |

### Backend Components (Cloudflare Worker)

| Component | File | Description |
|-----------|------|-------------|
| **Worker Entry** | `worker/_worker.js` | Cloudflare Worker fetch handler. Routes requests, validates methods and parameters, applies per-IP rate limiting, and manages origin-aware CORS responses. |
| **TMDB Handler** | `_worker.js` | Search (`/api/tmdb/search`) and detail (`/api/tmdb/detail`) endpoints. Supports v4 bearer token or v3 API key auth. Caches responses for 24h. |
| **Douban Handler** | `_worker.js` | Search (`/api/douban/search`) via `movie.douban.com/j/subject_suggest`, and detail (`/api/douban/detail`) via HTML scraping with `HTMLRewriter`. Caches for 24h. |
| **OMDb Handler** | `_worker.js` | Proxy for IMDb/Rotten Tomatoes data (`/api/omdb`). Supports search by title+year or by IMDb ID. Caches for 24h. |
| **Poster Handler** | `_worker.js` | Aggregates poster data from configured TMDB and OMDb sources. When no TMDB poster exists and direct OMDb title lookup misses, it can use Wikipedia to discover an English title. Complete results cache for 24h; degraded results cache for 15 minutes. |
| **Wiki Handler** | `_worker.js` | Chinese Wikipedia summary fetch (`/api/wiki/zh`) via REST API. Caches for 24h. |
| **Resource Handler** | `_worker.js` | Quark resource search (`/api/resource`) aggregating By669 and WPZYS. Keeps provider lists separate, extracts and deduplicates share URLs from up to 12 detail pages in batches of 6, and caches complete results for 12h. |

---

## API Design

### Worker Endpoints

All API endpoints return JSON. CORS headers echo an allowed request Origin and responses include `Vary: Origin`; the default allowlist covers the production frontend and local development, with `CORS_ALLOWED_ORIGINS` available for additional sites.

| Method | Path | Query Params | Description |
|--------|------|--------------|-------------|
| `GET` | `/api/tmdb/search` | `q` (string) | Search TMDB for movies and TV shows. Tries zh-CN first, falls back to en-US. |
| `GET` | `/api/tmdb/detail` | `id` (number), `type` (movie/tv) | Fetch TMDB detail with credits and external IDs; retries the alternate valid type only after a `404`. |
| `GET` | `/api/douban/search` | `q` (string) | Search Douban via `subject_suggest` API. |
| `GET` | `/api/douban/detail` | `id` (string) | Scrape Douban detail page for rating, votes, genres, summary, IMDb ID. |
| `GET` | `/api/resource` | `q` (string) | Search By669 and WPZYS, then extract and deduplicate Quark netdisk URLs. |
| `GET` | `/api/omdb` | `title` (string), `year` (string) OR `imdb` (string) | OMDb proxy for IMDb/Rotten Tomatoes ratings and metadata. |
| `GET` | `/api/poster` | `title` (string), `year` (string) | Poster fetch with TMDB first, OMDb fallback, Wikipedia title fallback. |
| `GET` | `/api/wiki/zh` | `q` (string) | Chinese Wikipedia summary via REST API. |

### Response Formats

**TMDB Search Response:**
```json
{
  "page": 1,
  "totalResults": 42,
  "results": [
    {
      "id": 12345,
      "mediaType": "movie",
      "title": "...",
      "originalTitle": "...",
      "year": "2024",
      "poster": "https://image.tmdb.org/t/p/w780/...",
      "backdrop": "https://image.tmdb.org/t/p/w780/...",
      "summary": "...",
      "tmdbRating": 8.5,
      "tmdbVotes": 12345,
      "popularity": 123.45,
      "imdbId": null
    }
  ]
}
```

**Douban Detail Response:**
```json
{
  "rating": 8.7,
  "votes": 250000,
  "genres": ["剧情", "喜剧"],
  "summary": "剧情简介...",
  "imdbId": "tt1234567"
}
```

**OMDb/Profile Response:**
```json
{
  "omdb": true,
  "imdb": 8.5,
  "imdbVotes": "1,234,567",
  "rottenTomatoes": 95,
  "poster": "https://...",
  "title": "...",
  "year": "2024",
  "type": "movie",
  "genres": ["Drama", "Comedy"],
  "director": "...",
  "plot": "..."
}
```

**Resource Search Response:**
```json
{
  "resources": [
    { "title": "...", "url": "https://by669.org/d/...", "isQuark": true }
  ],
  "wpzysResources": [
    { "title": "...", "url": "https://www.wpzys.org/thread-...htm", "isQuark": true }
  ],
  "quarkUrls": [
    { "title": "...", "url": "https://pan.quark.cn/...", "sourceUrl": "...", "sourceTitle": "..." }
  ]
}
```

---

## Deployment Architecture

### Frontend (GitHub Pages)

- **Platform:** GitHub Pages (static hosting)
- **Build:** `npm run build` generates `css/output.css` from `css/input.css` via Tailwind CSS CLI
- **Entry:** `index.html` (single-page app)
- **Assets:** `js/*.js`, `css/output.css`, favicons, icons
- **CNAME:** Custom domain configured via `CNAME` file
- **Cost:** $0

### Backend (Cloudflare Worker)

- **Platform:** Cloudflare Workers (edge compute)
- **Config:** `wrangler.toml`
  - `name = "iplay"`
  - `main = "worker/_worker.js"`
  - `compatibility_date = "2024-04-23"`
- **Secrets:** Set via Cloudflare Dashboard or `npm run wrangler -- secret put`:
  - `TMDB_ACCESS_TOKEN` (v4 bearer, preferred)
  - `TMDB_API_KEY` (v3 query param, fallback)
  - `OMDB_API_KEY` (optional; no bundled key)
  - `CORS_ALLOWED_ORIGINS` (optional comma-separated extra frontend origins)
- **Cache:** Uses Cloudflare Cache API (`caches.default`) with 24h TTL for most complete responses, 12h for complete resources, and 15-minute TTLs for degraded resource/poster results
- **Cost:** $0 (within free tier limits)

### Build Pipeline

```
Developer pushes to main
        |
        v
+-------+-------+
|  npm test     |  -- Node tests + lint + build
|  (package.json)|
+-------+-------+
        |
        v
+-------+-------+
|  GitHub Pages |  -- Auto-deploys static files
|  (frontend)   |
+---------------+

Worker deploy (manual or via Wrangler CLI):
+-------+-------+
| wrangler    |  -- Deploys worker/_worker.js
| deploy      |     to Cloudflare edge
+---------------+
```

---

## Security Considerations

### API Keys and Secrets

- **TMDB credentials** stored as Cloudflare Worker secrets (`TMDB_ACCESS_TOKEN` or `TMDB_API_KEY`). Never exposed to frontend.
- **OMDb API key** is optional and stored only as a Cloudflare Worker secret. No key is bundled; OMDb-specific requests return `503` when it is absent.
- **No user authentication** -- iPlay is a fully anonymous, stateless application.

### CORS Handling

- Worker responds to `OPTIONS` with `GET, OPTIONS` and echoes `Access-Control-Allow-Origin` only for allowed origins.
- The built-in allowlist includes `https://iplay.hackx64.eu.org`, local Wrangler origins, and localhost/127.0.0.1 on port 8080. Deployments can add up to 20 comma-separated origins with `CORS_ALLOWED_ORIGINS`.
- Responses include `Vary: Origin` to keep shared caches origin-safe.

### Rate Limiting and Caching

- Worker caches all upstream API responses using Cloudflare Cache API:
  - TMDB/Douban/OMDb/Wiki: 24 hours (`max-age=86400`)
  - Complete resources: 12 hours (`max-age=43200`); provider/detail-page partial results: 15 minutes
  - Complete poster aggregation: 24 hours; configured-source partial results: 15 minutes
- Cache keys use synthetic local URLs (for example `https://douban-search-cache.local/`, `https://resource-search-v5-cache.local/`, and `https://poster-v1-cache.local/`) to avoid polluting external cache namespaces.
- The Worker limits each client IP to 60 requests per 60-second window and bounds its in-memory limiter map; `OPTIONS` preflight does not consume quota.

### Data Privacy

- **No backend data persistence:** The Worker does not store user data, search history, or preferences.
- **Client-side preferences:** Genre preference weights are stored in `localStorage` (`iplay_preference_weights`) entirely in the user's browser.
- **No tracking:** No analytics, cookies, or third-party trackers are implemented.

### Upstream API Risks

- **Douban scraping** uses `HTMLRewriter` to parse HTML. If Douban changes their HTML structure, the detail scraper will break.
- **Resource site dependency:** The `/api/resource` endpoint depends on By669 and WPZYS availability and markup. One provider may fail without hiding the other's results; if both fail the endpoint returns `502`.
- **OMDb configuration:** Without `OMDB_API_KEY`, OMDb enrichment is intentionally unavailable while TMDB and other sources continue to work.

---

## Directory Structure

```
iplay/
├── index.html              # SPA shell (dark cinema UI)
├── package.json            # npm scripts: lint, test, build
├── wrangler.toml           # Cloudflare Worker configuration
├── eslint.config.mjs       # ESLint config (ES2022, module globals)
├── CNAME                   # Custom domain for GitHub Pages
├── css/
│   ├── input.css           # Tailwind CSS v4 theme config
│   └── output.css          # Generated production stylesheet
├── js/
│   ├── main.js             # UI controller
│   ├── api.js              # API client with timeout/abort
│   ├── quark.js            # Quark copy formatter
│   └── scorer.js           # Recommendation algorithm
├── worker/
│   └── _worker.js          # Cloudflare Worker
├── tests/                  # Node.js unit and Worker route tests
└── docs/
    └── ARCHITECTURE.md     # This document
```

### Rationale

- **Flat frontend structure:** No bundler or framework. Vanilla JS with ES Modules keeps the architecture minimal and zero-dependency for runtime.
- **Worker as a single file:** All backend logic in one file for easy copy-paste deployment into Cloudflare Dashboard. No build step required for the Worker.
- **Separation of concerns:** `api.js` isolates all network calls; `scorer.js` isolates the recommendation algorithm; `main.js` handles all DOM manipulation.
- **Tailwind CLI only:** No PostCSS or complex build pipeline. A single `npm run build` command generates the CSS.
