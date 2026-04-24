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
|  |   (886 lines, ES Mod) |  aggregator + cache    |
|  +-----------+-----------+                       |
|              |                                    |
|  +-----------+-----------+-----------+----------+|
|  |           |           |           |          ||
|  v           v           v           v          ||
| TMDB      Douban      OMDb      Wikipedia   By669||
| (Primary) (Chinese    (IMDb/    (Chinese    (Quark|
|           ratings)    RT data)  plot)      links)|
+---------------------------------------------------+
```

---

## Data Flow

### 1. Search Flow

```
User types query in search box
        |
        v
+-------+-------+
|  js/main.js   |  -- Debounced input, 300ms
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

When a user clicks a result, the frontend fires multiple concurrent requests to the Worker:

```
User clicks a search result
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
|  - Concurrent fetch with Promise.allSettled|
|  - Each upstream cached independently      |
|  - Aggregated response to frontend         |
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
| **UI Controller** | `js/main.js` (748 lines) | Search UI, debounced input handling, results rendering with progressive loading, detail modal with tabs (overview / cast / resources), preference settings modal, toast notifications. |
| **API Client** | `js/api.js` (110 lines) | API client with `fetchWithTimeout` (AbortController, 8s default timeout). Exports `TmdbAPI`, `DoubanAPI`, `WikiAPI`, `ResourceAPI`, `PosterAPI`. |
| **Scoring Engine** | `js/scorer.js` (119 lines) | Client-side recommendation algorithm. Genre preference weights loaded from `localStorage` (key `iplay_preference_weights`). Score = base (rating) + heat (votes/wiki) + preference (genre match). Fatal flaws (score <= -2.5 genres) cap at 59. |
| **Styles** | `css/input.css` / `css/output.css` | Tailwind CSS v4 with custom theme: `Noto Serif SC` + `Space Mono` fonts, cinema color palette (`cinema-900` through `cinema-100`), accent red and gold. |

### Backend Components (Cloudflare Worker)

| Component | File | Description |
|-----------|------|-------------|
| **Worker Entry** | `worker/_worker.js` (886 lines) | Cloudflare Worker fetch handler. Routes incoming requests to appropriate handlers. Manages CORS preflight responses. |
| **TMDB Handler** | `_worker.js` | Search (`/api/tmdb/search`) and detail (`/api/tmdb/detail`) endpoints. Supports v4 bearer token or v3 API key auth. Caches responses for 24h. |
| **Douban Handler** | `_worker.js` | Search (`/api/douban/search`) via `movie.douban.com/j/subject_suggest`, and detail (`/api/douban/detail`) via HTML scraping with `HTMLRewriter`. Caches for 24h. |
| **OMDb Handler** | `_worker.js` | Proxy for IMDb/Rotten Tomatoes data (`/api/omdb`). Supports search by title+year or by IMDb ID. Caches for 24h. |
| **Poster Handler** | `_worker.js` | Aggregates poster from TMDB (first) and OMDb (fallback). Falls back to Wikipedia English title lookup if both fail. |
| **Wiki Handler** | `_worker.js` | Chinese Wikipedia summary fetch (`/api/wiki/zh`) via REST API. Caches for 24h. |
| **Resource Handler** | `_worker.js` | Quark resource search (`/api/resource`) aggregating from `by669.org`. Extracts Quark netdisk URLs from resource pages with batch processing (5 concurrent). Caches for 12h. |

---

## API Design

### Worker Endpoints

All endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`).

| Method | Path | Query Params | Description |
|--------|------|--------------|-------------|
| `GET` | `/api/tmdb/search` | `q` (string) | Search TMDB for movies and TV shows. Tries zh-CN first, falls back to en-US. |
| `GET` | `/api/tmdb/detail` | `id` (number), `type` (movie/tv) | Fetch TMDB detail with credits and external IDs. Auto-detects type if wrong. |
| `GET` | `/api/douban/search` | `q` (string) | Search Douban via `subject_suggest` API. |
| `GET` | `/api/douban/detail` | `id` (string) | Scrape Douban detail page for rating, votes, genres, summary, IMDb ID. |
| `GET` | `/api/resource` | `q` (string) | Search resource site and extract Quark netdisk URLs. |
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
      "poster": "https://image.tmdb.org/t/p/w342/...",
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
  - `name = "iplay-worker"`
  - `main = "worker/_worker.js"`
  - `compatibility_date = "2024-04-23"`
- **Secrets:** Set via Cloudflare Dashboard or `wrangler secret put`:
  - `TMDB_ACCESS_TOKEN` (v4 bearer, preferred)
  - `TMDB_API_KEY` (v3 query param, fallback)
  - `OMDB_API_KEY` (optional, has hardcoded fallback)
- **Cache:** Uses Cloudflare Cache API (`caches.default`) with 24h TTL for most endpoints, 12h for resources
- **Cost:** $0 (within free tier limits)

### Build Pipeline

```
Developer pushes to main
        |
        v
+-------+-------+
|  npm test     |  -- lint + build
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
- **OMDb API key** has a hardcoded fallback (`80077e97`) in the Worker source for convenience, but can be overridden via `OMDB_API_KEY` secret.
- **No user authentication** -- iPlay is a fully anonymous, stateless application.

### CORS Handling

- Worker responds to `OPTIONS` preflight with permissive CORS headers (`Access-Control-Allow-Origin: *`).
- All JSON responses include CORS headers.
- This is intentional: the frontend is a static site that cannot make direct cross-origin requests to TMDB/Douban/OMDb.

### Rate Limiting and Caching

- Worker caches all upstream API responses using Cloudflare Cache API:
  - TMDB/Douban/OMDb/Wiki: 24 hours (`max-age=86400`)
  - Resources: 12 hours (`max-age=43200`)
- Cache keys use synthetic local URLs (e.g., `https://douban-search-cache.local/`) to avoid polluting external cache namespaces.
- No explicit rate limiting is implemented on the Worker itself; it relies on upstream APIs' own limits and Cloudflare's built-in DDoS protection.

### Data Privacy

- **No backend data persistence:** The Worker does not store user data, search history, or preferences.
- **Client-side preferences:** Genre preference weights are stored in `localStorage` (`iplay_preference_weights`) entirely in the user's browser.
- **No tracking:** No analytics, cookies, or third-party trackers are implemented.

### Upstream API Risks

- **Douban scraping** uses `HTMLRewriter` to parse HTML. If Douban changes their HTML structure, the detail scraper will break.
- **Resource site dependency:** The `/api/resource` endpoint depends on `by669.org` API availability and structure. If the site goes down or changes, resource search will fail.
- **OMDb fallback key:** The hardcoded fallback key may hit rate limits if the Worker receives heavy traffic.

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
│   ├── main.js             # UI controller (748 lines)
│   ├── api.js              # API client with timeout/abort
│   └── scorer.js           # Recommendation algorithm
├── worker/
│   └── _worker.js          # Cloudflare Worker (886 lines)
└── docs/
    └── ARCHITECTURE.md     # This document
```

### Rationale

- **Flat frontend structure:** No bundler or framework. Vanilla JS with ES Modules keeps the architecture minimal and zero-dependency for runtime.
- **Worker as a single file:** All backend logic in one file for easy copy-paste deployment into Cloudflare Dashboard. No build step required for the Worker.
- **Separation of concerns:** `api.js` isolates all network calls; `scorer.js` isolates the recommendation algorithm; `main.js` handles all DOM manipulation.
- **Tailwind CLI only:** No PostCSS or complex build pipeline. A single `npm run build` command generates the CSS.
