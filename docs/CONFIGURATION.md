<!-- generated-by: gsd-doc-writer -->

# Configuration

This document describes all configuration options for the iPlay project, covering Cloudflare Worker secrets, frontend settings, build tools, and runtime preference weights.

---

## Environment Variables

The Cloudflare Worker requires the following secrets (environment variables) to interact with external APIs. These are **not** stored in the repository and must be configured separately on the Cloudflare Dashboard or via the Wrangler CLI.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TMDB_ACCESS_TOKEN` | **Recommended** | — | TMDB v4 Read Access Token. Used as a Bearer token for authenticated requests to The Movie Database API. This is the preferred authentication method. |
| `TMDB_API_KEY` | Fallback | — | TMDB v3 API Key. Used as a fallback if `TMDB_ACCESS_TOKEN` is not set. Passed as a query parameter (`api_key`). |
| `OMDB_API_KEY` | Optional | — | Enables OMDb-backed IMDb ratings, Rotten Tomatoes scores, and poster metadata. No key is bundled; OMDb endpoints return `503` when it is unset. |
| `CORS_ALLOWED_ORIGINS` | Optional | — | Comma-separated additional frontend origins. At most 20 configured values are read. |
| `ENVIRONMENT` | Production required | — | Set to `production` in the deployed Worker. When production rate-limit bindings are missing, requests fail closed with `503` instead of using an isolate-local counter. |
| `REQUIRE_DISTRIBUTED_RATE_LIMIT` | Optional | `false` | Set to `true` to enforce the same fail-closed behavior in a non-production deployment. |

### Setting Secrets via Wrangler CLI

```bash
# Navigate to the project root
cd iplay

# Set TMDB v4 Access Token (recommended)
npm run wrangler -- secret put TMDB_ACCESS_TOKEN
# You will be prompted to paste your token

# Set TMDB v3 API Key (fallback)
npm run wrangler -- secret put TMDB_API_KEY

# Set OMDb API Key (optional)
npm run wrangler -- secret put OMDB_API_KEY

# Add self-hosted frontend origins when needed
npm run wrangler -- secret put CORS_ALLOWED_ORIGINS
```

### Setting Secrets via Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) and select your Worker.
2. Navigate to **Settings > Variables**.
3. Click **Add variable** under the **Secrets** section.
4. Enter the variable name (e.g., `TMDB_ACCESS_TOKEN`) and its value.
5. Click **Deploy** to apply the changes.

### Local Development Variables

For local testing with `npm run wrangler -- dev`, create a `.dev.vars` file in the project root:

```bash
TMDB_ACCESS_TOKEN=your_tmdb_v4_token_here
TMDB_API_KEY=your_tmdb_v3_key_here
OMDB_API_KEY=your_omdb_key_here
CORS_ALLOWED_ORIGINS=https://preview.example.com,http://localhost:4173
ENVIRONMENT=development
```

> **Note:** `.dev.vars` is already listed in `.gitignore` to prevent accidental commits of secrets.

---

## Wrangler Configuration

The Worker is configured via `wrangler.toml` in the project root.

```toml
name = "iplay"
main = "worker/_worker.js"
compatibility_date = "2024-04-23"

[[ratelimits]]
name = "API_RATE_LIMITER"
namespace_id = "1001"

[ratelimits.simple]
limit = 60
period = 60

[[ratelimits]]
name = "RESOURCE_RATE_LIMITER"
namespace_id = "1002"

[ratelimits.simple]
limit = 10
period = 60
```

| Field | Value | Description |
|-------|-------|-------------|
| `name` | `iplay` | The name of the Worker as it appears in the Cloudflare Dashboard. |
| `main` | `worker/_worker.js` | Entry point for the Worker script. |
| `compatibility_date` | `2024-04-23` | Cloudflare Workers runtime compatibility date. Determines which runtime APIs are available. |
| `API_RATE_LIMITER` | `60 / 60s` | Cloudflare Rate Limiting binding for ordinary API routes. The namespace ID is `1001`. |
| `RESOURCE_RATE_LIMITER` | `10 / 60s` | Cloudflare Rate Limiting binding for `/api/resource`, whose upstream fan-out is more expensive. The namespace ID is `1002`. |

The Worker calls the Cloudflare Rate Limiting bindings when they are available. A process-local limiter remains only as a development/test fallback when bindings are absent. Set `ENVIRONMENT=production` for deployed Workers; if a production binding is malformed or unavailable, requests fail closed with `503` instead of silently falling back to a per-isolate counter. The fallback is not a substitute for the account-wide production counters.

### Deploying the Worker

```bash
npm run wrangler -- deploy
```

This command reads `wrangler.toml` and deploys the Worker to Cloudflare's edge network.

---

## Frontend Configuration

### API Base URL

The frontend selects its Worker base URL in `js/api.js`: localhost pages use the local Wrangler server, while other hosts use the production Worker.

```javascript
const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://iplayw.hackx64.eu.org';
```

**When self-hosting, you must change this value to your own Worker domain.**

#### Steps to Update

1. Open `js/api.js`.
2. Locate the `API_BASE` declaration:
   ```javascript
   const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
       ? 'http://localhost:8787'
       : 'https://iplayw.hackx64.eu.org';
   ```
3. Replace the URL with your deployed Worker URL (e.g., `https://your-worker.your-subdomain.workers.dev`).
4. Save the file and rebuild the frontend if necessary.

> **Important:** The Worker allows `https://iplay.hackx64.eu.org`, local Wrangler origins, and `http://localhost:8080` / `http://127.0.0.1:8080` by default. Add other static-host origins through `CORS_ALLOWED_ORIGINS`; responses vary on `Origin` rather than using a wildcard.

---

## Build Configuration

### Tailwind CSS

iPlay uses Tailwind CSS v4 for styling. The build pipeline compiles a custom input file into the production stylesheet.

| Setting | Value |
|---------|-------|
| Input file | `css/input.css` |
| Output file | `css/output.css` |
| Build command | `npx @tailwindcss/cli -i ./css/input.css -o ./css/output.css` |
| Minified build | `npm run build` (adds `--minify`) |

#### Custom Theme Tokens

The input file (`css/input.css`) defines project-specific design tokens:

```css
@theme {
  --font-serif: "Noto Serif SC", serif;
  --font-mono: "Space Mono", monospace;

  --color-cinema-900: #0a0a0c;
  --color-cinema-800: #141417;
  --color-cinema-700: #1e1e24;
  --color-cinema-400: #a3a3a8;
  --color-cinema-100: #e0e0e0;

  --color-accent-red: #e50914;
  --color-accent-gold: #ffd700;
}
```

#### Running the Build

```bash
# Development (unminified)
npx @tailwindcss/cli -i ./css/input.css -o ./css/output.css

# Production (minified)
npm run build
```

### ESLint

Code quality is enforced with ESLint using the flat config format (`eslint.config.mjs`).

| Setting | Value |
|---------|-------|
| Config file | `eslint.config.mjs` |
| Run command | `npm run lint` |
| ECMAScript version | 2022 |
| Source type | module |

#### Global Variables

The ESLint config pre-defines browser and Worker runtime globals to avoid false positives:

- Browser: `document`, `window`, `console`, `fetch`, `AbortController`, `localStorage`, etc.
- Worker: `caches`, `URL`, `Response`, `Request`, `Headers`, `HTMLRewriter`

#### Running the Linter

```bash
npm run lint
```

---

## Runtime / Browser Configuration

### Preference Weights

The recommendation scoring algorithm in `js/scorer.js` uses a set of genre-based preference weights. These weights influence how movies and TV shows are ranked based on their genres.

#### Default Weights

| Genre | Score | Reason |
|-------|-------|--------|
| 喜剧 (Comedy) | +2.5 | 符合喜剧偏好 |
| 轻松 (Light) | +2.0 | 基调轻松减压 |
| 爱情 (Romance) | +1.5 | 包含浪漫/Melo元素 |
| 剧情 (Drama) | +1.0 | 剧情导向 |
| 职业 (Career) | +1.5 | 职场背景设定 |
| 恐怖 (Horror) | -3.0 | 包含恐怖元素 |
| 血腥 (Gore) | -3.0 | 可能含有血腥镜头 |
| 暴力 (Violence) | -2.5 | 存在暴力情节 |
| 惊悚 (Thriller) | -2.0 | 惊悚刺激氛围 |
| 犯罪 (Crime) | -1.0 | 犯罪题材 |
| 悲剧 (Tragedy) | -3.0 | 剧情致郁/苦大仇深 |
| 灾难 (Disaster) | -1.5 | 环境压抑 |

#### Customizing via localStorage

Users can override the default weights by setting a custom JSON object in the browser's `localStorage`:

```javascript
// Open browser DevTools Console and run:
const myWeights = {
    '喜剧': { score: 3.0, reason: '超级喜欢喜剧' },
    '恐怖': { score: -5.0, reason: '极度恐惧恐怖片' }
};
localStorage.setItem('iplay_preference_weights', JSON.stringify(myWeights));
```

**Behavior:**
- The custom weights are **merged** with defaults (custom values take precedence).
- Changes take effect immediately on the next recommendation calculation.
- To reset to defaults, remove the key:
  ```javascript
  localStorage.removeItem('iplay_preference_weights');
  ```

#### Scoring Formula

The final recommendation score (0-100) is computed as:

1. **Base Score** (0-55): Derived from the rating (TMDB or Douban).
2. **Heat Score** (0-20): Bonus for popularity (vote count) and Wikipedia presence.
3. **Preference Score** (0-20): Adjusted based on matching genres against the weights.
4. **Fatal Flaw Penalty**: If any genre has a score <= -2.5, the total score is capped at 59 and multiplied by 0.7.

---

## Required vs Optional Settings

| Setting | Required? | Failure Mode if Missing |
|---------|-----------|------------------------|
| `TMDB_ACCESS_TOKEN` or `TMDB_API_KEY` | **Yes** | Direct TMDB search/detail requests return `503` when both are missing. Poster aggregation can still fall back to OMDb when `OMDB_API_KEY` is configured; if neither poster source is configured, it returns `503`. |
| `OMDB_API_KEY` | No | OMDb-backed ratings and metadata are unavailable; direct OMDb requests return `503`. |
| `API_BASE` (frontend) | **Yes** | Frontend cannot communicate with the Worker; all API requests fail. |
| Tailwind build | **Yes** | Frontend renders without styles if `css/output.css` is missing or stale. |

---

## Per-Environment Overrides

iPlay does not use separate `.env.*` files. Environment-specific behavior is handled as follows:

| Environment | How to Configure |
|-------------|------------------|
| **Development** | Use `.dev.vars` for local Worker secrets. Run `npm run wrangler -- dev` to start a local dev server. |
| **Production** | Set secrets via Cloudflare Dashboard or `npm run wrangler -- secret put`. Deploy with `npm run wrangler -- deploy`. |
| **Frontend** | The frontend is static; environment-specific changes require editing `js/api.js` and rebuilding. |

### Recommended Workflow

1. **Local development:**
   ```bash
   # Terminal 1: Start the Worker locally
   npm run wrangler -- dev

   # Terminal 2: Build CSS in watch mode (if supported by your setup)
   npx @tailwindcss/cli -i ./css/input.css -o ./css/output.css --watch
   ```

2. **Deploy to production:**
   ```bash
   npm test           # Run Node.js tests, lint, and the minified CSS build
   npm run wrangler -- deploy    # Deploy Worker
   # Then push frontend files to GitHub Pages (or your static host)
   ```
