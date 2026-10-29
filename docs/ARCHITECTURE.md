<!-- generated-by: gsd-doc-writer -->

# iPlay Architecture

## System Overview

iPlay ("沉浸式观影指南与推荐系统") is a Chinese immersive movie/TV recommendation web application with a "dark cinema" retro aesthetic. The system aggregates data from multiple public sources (TMDB, Douban, OMDb, Wikipedia, and resource sites) to provide personalized viewing recommendations. It follows a serverless, zero-cost architecture: a static frontend hosted on GitHub Pages paired with a Cloudflare Worker acting as a CORS-bypass proxy and data aggregator at the edge.

**Primary inputs:** User search queries (Chinese or English movie/TV titles or actor names).
**Primary outputs:** Aggregated detail pages with ratings, plot summaries, cast info, resource links, and a personalized rule-based recommendation score; actor queries also return grouped filmography results.

---

## High-Level Architecture

Source modules under `js/` are built by esbuild into one versioned ES module, `assets/app.min.js`. GitHub Pages serves this committed artifact alongside the generated stylesheet. CI rebuilds both and rejects drift; the browser no longer discovers eight source imports after downloading the entry module. Actor pagination appends new cards to existing TV/movie groups, preserving loaded images, listeners and DOM identity.

Actor cards use lazy responsive posters at w185/w342/w500 with grid-specific sizes; errors clear responsive candidates before showing the placeholder. Search fallbacks share at most 1,024 pure query/title scores within one request, while identity and ranking remain sensitive to the current intent. Resource parsing retains only adjacent URL occurrences and the bounded result map, including foreign URLs as password boundaries without a page-sized occurrence array.

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
|           ratings)    RT data)  plot)       WPZY)  ||
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
|  (TmdbAPI)    |     AbortController, 12s default
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

After search, the frontend either selects a high-confidence TMDB match or pauses on an explicit candidate picker when results are ambiguous. It renders search metadata immediately, then uses the detail response's canonical title, media type and year for Douban, Wiki, OMDb and resource queries. If details fail, normal search retains its candidate metadata and retry action; unconfirmed shared links wait for a successful detail retry. After details settle, resource scanning starts when its section approaches the viewport or the user requests it. Resource snapshots are keyed by the selected work and query identity; retries replace successful pages and retain temporarily failed pages, then reconcile duplicate share passwords from their page evidence:

Detail retries retain the active work's view model while rotating its request generation and abort signal. A matching canonical title/type/year preserves verified Wiki and Douban enrichment; changed metadata clears those values, while a changed IMDb ID clears the previous OMDb profile. New searches and navigation reset the retained detail state. Resource lists render six entries initially and expose every bounded API result on expansion.

```
User submits a search
        |
        v
+-------+-------+
|  js/match.js  |  -- ranks candidates and decides
|               |     whether the user must confirm
+-------+-------+
        |
        +--------+--------+--------+--------+
        |        |        |        |        |
        v        v        v        v        v
    TMDB     Douban    Wiki    OMDb     Resource
   Detail    Search   Summary  by IMDb  (deferred)
   API       +Detail   API     ID       Search
     |          ^        ^       ^
     +----------+--------+-------+---------+  -- use canonical detail metadata
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
|               |     2. Render poster + basic info (or fallback)
|               |     3. Render ratings (TMDB, Douban, IMDb, RT)
|               |     4. Render rule-based score + analysis
|               |     5. Render wiki summary + resource-ready states
|               |     6. Keep partial results visible and expose retry actions
+---------------+
```

### 3. Poster Resolution Flow

```
Frontend requests /api/poster?title=X&year=Y&id=ID&type=TYPE[&imdb=IMDB]
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
detail    ID/title lookup
   |         |
   v         v
TMDB    OMDb profile
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

For selected works, TMDB loads only the exact ID/type. Every OMDb profile must map back to that TMDB identity; a known IMDb ID never falls back to title/Wikipedia lookup. Verified metadata can be returned even without an image. The frontend rejects mismatched TMDB/IMDb responses and preserves already-confirmed metadata. Legacy title-only API clients retain title lookup behavior. Refresh retries bypass both browser HTTP cache and Worker cache.

When canonical TMDB details and a successful OMDb profile with that same confirmed IMDb ID both contain no usable poster, the frontend finishes enrichment without repeating `/api/poster`. Failed or unconfirmed OMDb lookups and actual image load errors still use the existing fallback and refresh behavior.

---

## Component Breakdown

### Frontend Components

| Component | File | Description |
|-----------|------|-------------|
| **SPA Shell** | `index.html` | Single-page application shell. Dark theme (`#0a0a0c`), Netflix-red accent (`#e50914`), static film-grain pattern, ambient glow radial gradient, typewriter cursor animation. Responsive layout with poster sidebar + content area. |
| **UI Controller** | `js/main.js` | Search form handling for titles and actors, grouped filmography cards, clickable cast names, candidate confirmation, progressive detail rendering, deferred resource loading, fallback/retry states, season facts, resource pagination, and toast notifications. |
| **API Client** | `js/api.js` | API client with `fetchWithTimeout` (AbortController, 12s default/OMDb timeout; 18s for resource and poster aggregation). Exports `TmdbAPI` (title, person, and detail search), `DoubanAPI`, `WikiAPI`, `OmdbAPI`, `ResourceAPI`, `PosterAPI`. |
| **Match Rules** | `js/match.js` | Normalizes title text, ranks TMDB candidates, and detects low-confidence or close-score results that require user confirmation. |
| **Season Formatter** | `js/seasons.js` | Formats total seasons/episodes and per-season episode counts, including specials and unknown counts. |
| **Quark Formatter** | `js/quark.js` | Formats share URLs and optional extraction passwords for clipboard copy. |
| **Scoring Engine** | `js/scorer.js` | Client-side recommendation algorithm. Genre preference weights loaded from `localStorage` (key `iplay_preference_weights`). Score = base (rating) + heat (votes/wiki) + preference (genre match). Fatal flaws (score <= -2.5 genres) cap at 59. |
| **Styles** | `css/input.css` / `css/output.css` | Tailwind CSS v4 with custom theme: `Noto Serif SC` + `Space Mono` fonts, cinema color palette (`cinema-900` through `cinema-100`), accent red and gold. |

### Backend Components (Cloudflare Worker)

| Component | File | Description |
|-----------|------|-------------|
| **Worker Entry** | `worker/_worker.js` | Cloudflare Worker fetch handler. Routes requests, validates methods and parameters, applies per-IP rate limiting, and manages origin-aware CORS responses. |
| **TMDB Handler** | `_worker.js` | Title search (`/api/tmdb/search`), actor filmography search (`/api/tmdb/person`), and detail (`/api/tmdb/detail`) endpoints. Supports v4 bearer token or v3 API key auth. Searches normalize query intent, score matches, and use bounded fallbacks; raw upstream responses are cached for 24h. |
| **Douban Handler** | `_worker.js` | Search (`/api/douban/search`) via `movie.douban.com/j/subject_suggest`, and detail (`/api/douban/detail`) via HTML scraping with `HTMLRewriter`. Caches for 24h. |
| **OMDb Handler** | `_worker.js` | Proxy for IMDb/Rotten Tomatoes data (`/api/omdb`). Supports search by title+year or by IMDb ID. Caches for 24h. |
| **Poster Handler** | `_worker.js` | Aggregates images and metadata bound to the selected TMDB ID/type. OMDb uses a known IMDb ID or a title lookup verified through TMDB external-ID mapping. Only unknown-IMDb title lookups may use Wikipedia's English title fallback. Total upstream work is bounded to about 15s; complete results cache for 24h; degraded results cache for 15 minutes. |
| **Wiki Handler** | `_worker.js` | Chinese Wikipedia summary fetch (`/api/wiki/zh`) via REST API. Caches for 24h. |
| **Resource Handler** | `_worker.js` | Quark resource search (`/api/resource`) aggregating By669 and WPZY. Keeps provider lists separate, fairly selects up to 12 detail pages across both providers, extracts and deduplicates at most 100 share URLs with bounded page/total work, and caches complete results for 12h. |

---

## API Design

### Worker Endpoints

All API endpoints return JSON. CORS headers echo an allowed request Origin and responses include `Vary: Origin`; the default allowlist covers the production frontend and local development, with `CORS_ALLOWED_ORIGINS` available for additional sites.

| Method | Path | Query Params | Description |
|--------|------|--------------|-------------|
| `GET` | `/api/tmdb/search` | `q` (string) | Search TMDB for movies and TV shows. Normalizes title intent, ranks by match confidence, and uses bounded fallback queries. |
| `GET` | `/api/tmdb/person` | `q` (string), `id`, `offset`, `limit`, `mediaType` | Match an actor name or load a selected person; returns paginated movie / TV cast credits, counts, and match metadata. |
| `GET` | `/api/tmdb/detail` | `id` (number), `type` (movie/tv) | Fetch TMDB detail with credits, external IDs, and normalized per-season episode counts for TV; retries the alternate valid type only after a `404`. |
| `GET` | `/api/douban/search` | `q` (string) | Search Douban via `subject_suggest` API. |
| `GET` | `/api/douban/detail` | `id` (string) | Scrape Douban detail page for rating, votes, genres, summary, IMDb ID. |
| `GET` | `/api/resource` | `q` (string) | Search By669 and WPZY, then extract and deduplicate Quark netdisk URLs. |
| `GET` | `/api/omdb` | `title` (string), `year` (string) OR `imdb` (string) | OMDb proxy for IMDb/Rotten Tomatoes ratings and metadata. |
| `GET` | `/api/poster` | `title`, optional `year`, paired `id` / `type`, optional `imdb`, `refresh=1` | Exact selected-work poster and verified OMDb metadata; legacy title-only fallback. |
| `GET` | `/api/wiki/zh` | `q` (string), optional `type` / `year` | Related Chinese Wikipedia summary with media/year validation. |

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
      "poster": "https://image.tmdb.org/t/p/w500/...",
      "backdrop": "https://image.tmdb.org/t/p/w780/...",
      "summary": "...",
      "tmdbRating": 8.5,
      "tmdbVotes": 12345,
      "popularity": 123.45,
      "imdbId": null,
      "matchScore": 1,
      "matchConfidence": "high",
      "matchMethod": "title-exact"
    }
  ],
  "searchMeta": {
    "originalQuery": "...",
    "normalizedQuery": "...",
    "strategy": "direct",
    "confidence": "high",
    "matchScore": 1,
    "matchedBy": "title-exact",
    "attempts": 1
  }
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
    { "title": "...", "url": "https://wpzy.org/thread-...htm", "isQuark": true }
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
Feature branch / PR
        |
        v
CI: npm ci + tests/lint/build (Node 22/24)
    strict Worker bundle + native runtime + Chrome smoke
        |
        v
Merge to main
        |
        +--> GitHub Pages: frontend
        |
        +--> Cloudflare Workers Builds: production Worker
        |
        v
Wait for both deployments, then run test:live

Manual fallback: npm run deploy:worker (Wrangler with --keep-vars)
```

---

## Security Considerations

### API Keys and Secrets

- **TMDB credentials** stored as Cloudflare Worker secrets (`TMDB_ACCESS_TOKEN` or `TMDB_API_KEY`). Never exposed to frontend.
- **OMDb API key** is optional and stored only as a Cloudflare Worker secret. No key is bundled; OMDb-specific requests return `503` when it is absent.
- **No user authentication** -- iPlay is a fully anonymous, stateless application.

### CORS Handling

- Worker responds to `OPTIONS` with `GET, OPTIONS` and echoes `Access-Control-Allow-Origin` only for allowed origins.
- The built-in allowlist includes `https://iplay.hackx64.eu.org`, local Wrangler origins, and localhost/127.0.0.1 on ports 4173 and 8080. Deployments can add up to 20 comma-separated origins with `CORS_ALLOWED_ORIGINS`.
- Responses include `Vary: Origin` to keep shared caches origin-safe.

### Rate Limiting and Caching

- Worker caches all upstream API responses using Cloudflare Cache API:
  - TMDB/Douban/OMDb/Wiki: 24 hours (`max-age=86400`)
  - Complete resources: 12 hours (`max-age=43200`); provider/detail-page partial results: 15 minutes
  - Complete poster aggregation: 24 hours; configured-source partial results: 15 minutes
- Cache keys use synthetic local URLs (for example `https://douban-search-cache.local/`, `https://resource-search-v12-cache.local/`, and `https://poster-v4-cache.local/`) to avoid polluting external cache namespaces. Poster keys include selected TMDB ID/type and IMDb ID. OMDb and typed Wikipedia summaries use `omdb-v3-cache.local` and `wiki-zh-v5-cache.local` to exclude old inaccurate entries. Explicit resource/poster retries bypass browser HTTP caching; resource and Wiki client requests carry the release version to isolate browser caches.
- Complete TMDB search, person and detail responses allow 5-minute browser caching (`public, max-age=300`) on release-tagged client URLs, so history navigation does not repeat high-latency round trips. Errors and degraded searches (a failed attempt, a failed Douban alias lookup or a deadline-skipped fallback) stay `no-store`.
- A search response embeds the page's next TMDB answer in `prefetched`. A title the page opens directly carries its detail; a missing, weak or actor-preferred title carries the default person lookup. The Worker mirrors the routing rules of `js/main.js` and `js/match.js`. A wrong prediction only leaves the payload unused. Follow-ups wait at most 1.5s within the search deadline, keep running through `waitUntil` to warm the edge cache, and are omitted when they fail or degrade. `js/api.js` serves only the identical request from memory, for 5 minutes and as independent copies.
- Search reports `searchMeta.exactPerson` when an acting person's name equals the whole query. The frontend then prefers the actor over works that merely contain the name; an exact title still wins. Chinese queries with such a person and no exact title stop after the first TMDB request.
- Resource responses and all client resource requests use `no-store` for browser HTTP caching, while scoped internal Cache API copies retain their 12-hour/15-minute TTLs. Source URLs are capped at 2048 characters and share tokens at 128; the serialized resource response has a 2 MiB UTF-8 budget. Limits reject whole invalid addresses rather than returning truncated tokens.
- Media payloads requested with credits and external IDs must include cast/crew arrays and an external-ID object before caching. Person payloads requested with combined credits must include a cast array. Malformed cached payloads are evicted and refetched; genuinely empty arrays remain valid. Wikipedia checks known years in both title/description and the opening sentence before replacing the selected work's overview.
- Resource completion keeps existing links and expanded lists usable during loading and after failure. Selected-actor retries retain the person ID, and shared detail links reject invalid explicit media types before issuing API requests.
- The Worker limits each client IP to 60 requests per 60-second window and bounds its in-memory limiter map; `OPTIONS` preflight does not consume quota. Deployed Workers set `ENVIRONMENT=production`, require distributed rate-limit bindings, and fail closed with `503` if those bindings are unavailable.

### Data Privacy

- **No backend data persistence:** The Worker does not store user data, search history, or preferences.
- **Client-side preferences:** Genre preference weights are stored in `localStorage` (`iplay_preference_weights`) entirely in the user's browser.
- **No tracking:** No analytics, cookies, or third-party trackers are implemented.

### Upstream API Risks

- **Douban scraping** uses `HTMLRewriter` to parse HTML. If Douban changes their HTML structure, the detail scraper will break.
- **Resource site dependency:** The `/api/resource` endpoint depends on By669 and WPZY availability and markup. One provider may fail without hiding the other's results; if both fail the endpoint returns `502`.
- **WPZY account boundary:** Optional `WPZY_COOKIE` is a runtime Secret, limited to exact-host HTTPS read-only search/thread requests. Only `bbs_token` and `bbs_sid` are forwarded. The response keeps the historical `wpzysResources` contract, canonicalizes forum URLs, and does not read gated reply/VIP links. The v9 cache and request-coalescing keys include an internal SHA-256 login-state fingerprint; secret replacement/revocation cannot reuse previous-account resource entries. At most six WPZY detail pages are selected per search. Login failures and restricted posts have explicit metadata and recoverable frontend notices. HTTP 200 maintenance detail pages are incomplete scans, not healthy empty results.
- **OMDb configuration:** Without `OMDB_API_KEY`, OMDb enrichment is intentionally unavailable while TMDB and other sources continue to work. After the first `OMDb API not configured` answer, the page skips OMDb requests for the rest of the session.

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
