# Changelog

## [1.0.6] - 2026-09-30

### Fixed

- Wrong-year exact TMDB titles now require confirmation; unrelated or wrong-year Douban suggestions cannot become trusted search aliases.
- OMDb validates primary and fallback title/year matches and exact IMDb identities before use or caching. Supplemental Douban ratings cannot override a different known IMDb identity.
- Wikipedia summaries reject unrelated titles, non-media pages, disambiguation and incompatible adaptations; type/year-aware misses preserve TMDB text.
- Request coalescing is isolated to each Workers execution context, avoiding cross-request Response-stream and credential reuse.
- Already-aborted API calls do not fetch; late responses cannot bypass cancellation or timeouts.
- Cast clicks reuse the selected person ID; ambiguous actor matches remain selectable, and rapid credit filters cannot be overwritten by stale requests.
- Missing cinema palette tokens now generate working filter colors. Release-versioned entry points and module imports prevent new/old frontend code mixing.

### Added

- Shared release metadata, visible frontend version and `X-iPlay-Version` Worker response headers.
- Native workerd regression checks for real rate-limit bindings, cache/concurrent streams, HTMLRewriter and production fail-closed behavior.
- Browser coverage for actor identity, medium-confidence confirmation and filter races; live validation now compares HTML and every frontend module.
- Sampled Workers logs/traces with URL query-string redaction and credential-safe structured application logs.

### Changed

- Publishing tools are lockfile-pinned to Wrangler 4.144.0 and its matching Miniflare runtime; development now requires Node.js 22+, with CI on 22 and 24.
- Updated official GitHub Actions to immutable release SHAs and patched vulnerable `brace-expansion`; dependency audit reports no known vulnerabilities at release verification.
- OMDb, poster and Wikipedia cache namespaces exclude pre-validation entries; deployment documentation uses complete-module Wrangler publishing.

## [1.0.5] - 2026-09-27

### Fixed

- Rating cards now remain truly hidden when their source has no usable rating, including in Tailwind's layered CSS.
- Explicit TMDB media types never fall back to unrelated same-number IDs, and malformed/mismatched detail identities are rejected before caching.
- Deep links resolve canonical title/year/type before supplementary searches; selected same-name actor identities survive reloads and history navigation.
- Unrelated poster/Douban matches and OMDb year fallback to different remakes are rejected.
- Year suffix normalization no longer consumes the preceding title character (e.g. 三体2023).
- TV runtimes use episode data; assistant directors no longer appear as directors.
- Resource detail challenge/empty pages report partial failures rather than falsely complete scans.
- Douban rating, vote and genre extraction preserves streaming text chunks; duplicate and prototype-like genres cannot corrupt recommendation scores.
- TMDB overview retains its own source text instead of being replaced by Wikipedia after detail refresh.

### Added

- Copy-share controls for media and actor views, keyboard skip navigation, and a JavaScript-disabled notice.
- Production smoke validation (`npm run test:live`) checks deployed frontend bytes, real API identities, CORS and recoverable optional-provider failures.

### Changed

- Recommendation UI explicitly describes its rule-based score instead of claiming an AI prediction.
- Production fail-closed rate limiting is declared in Wrangler configuration; cache namespaces changed where old data could violate the new contracts.
- Browser regression coverage includes actual computed visibility, canonical deep links, sharing, actor reloads, desktop layout and reduced motion.

## [1.0.4.2] - 2026-09-23

### Fixed

- Late actor search responses can no longer replace a newer search result.
- Exact actor matches with no credits now show an empty filmography instead of a misleading not-found error.
- Douban challenge and empty detail pages are rejected instead of cached as valid data.

### Changed

- Douban summary extraction now uses the HTMLRewriter selector's scoped text callback directly.

## [1.0.4.1] - 2026-09-21

### Changed

- Upstream TMDB, Douban, Wikipedia, OMDb, and resource payloads now receive stricter validation, normalization, and input bounds before use or caching.
- Poster rendering now accepts only safe HTTP(S) or bounded raster data URLs.

### Fixed

- Actor candidate selection no longer allows a slower stale response to replace the latest choice.
- Failed actor filters can be retried without retaining stale credits or pagination state.
- Request timeouts remain distinguishable from simultaneous caller cancellation.
- Returning to the initial history entry now clears the previous search input.

## [1.0.4.0] - 2026-09-18

### Added

- Added same-name actor candidate selection, TV / movie filters, paginated filmography loading, and browser history restoration for actor and detail views.

### Changed

- Actor filmographies now return the complete normalized credit set through bounded pages instead of silently truncating at 200 entries.
- Title searches skip the actor endpoint when a reliable title match is already available, reducing unnecessary upstream requests.

### Fixed

- Actor endpoint failures are surfaced as recoverable UI errors instead of being silently treated as title-search misses.
- Cast actor controls now meet the mobile touch-target baseline.

## [1.0.3.0] - 2026-09-17

### Added

- Actor-name searches now list the actor's TV and movie credits, with each work linking to its full detail view.
- Cast names in detail views are now searchable, enabling direct navigation from one actor to another.

### Changed

- TMDB actor credits are normalized, deduplicated, and exposed through a dedicated person-search API with recoverable fallback behavior.

## [1.0.2.0] - 2026-08-30

### Added

- Added an isolated Chrome smoke runner and CI job covering progressive details, retry recovery, stale-search cancellation, poster fallback, and mobile layout.

### Changed

- Search results now render immediately while TMDB details, metadata, and resources fill in asynchronously.
- The Worker now coalesces identical upstream requests and reports partial resource results for transparent recovery.

### Fixed

- Resource and poster retries now bypass stale cached data.
- Production Workers fail closed when distributed rate-limit bindings are unavailable.
- Poster fallback and child-request cancellation prevent broken images and stale responses from replacing current results.

## [1.0.1.0] - 2026-08-28

### Added

- Search results now fill in IMDb / OMDb details by confirmed IMDb ID, with a title-based fallback when the ID is unavailable.
- Resource scanning can start automatically as the resource section enters the viewport, or manually from an explicit action.
- Added a repeatable Chrome DevTools Protocol browser smoke test for loading, retry, stale-search, and compatibility paths.

### Changed

- The first detail view renders independently from resource aggregation, with clearer progress, completion, and recovery states.
- TMDB posters use the `w500` rendition for a faster initial image load, while backdrops retain `w780` quality.
- Replaced the external icon-font dependency with inline SVG icons and made web fonts non-render-blocking.

### Fixed

- OMDb provider application failures and malformed responses now keep their meaningful error status instead of appearing as missing titles.
- Existing TMDB posters are preserved when OMDb data arrives, avoiding unnecessary image replacement and layout movement.
- Mobile interactive controls meet the 44px touch target baseline, and dynamic resource updates are announced accessibly.
