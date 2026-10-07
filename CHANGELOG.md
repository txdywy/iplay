# Changelog

## [1.0.11] - 2026-10-07

### Fixed

- Quark passwords stay associated with their share across consecutive links, leading/following labels, rendered line breaks and HTML formatting. Other providers' URLs and explicit labels, separate cards and footers are pairing boundaries; Baidu extraction codes no longer leak into Quark shares.
- URL-bound passwords take priority over nearby prose during same-page and cross-page deduplication, with provenance from the winning source. Equal-confidence disagreements, including conflicting URL parameters, omit the password rather than choosing by page order. Overlong tokens are not truncated into plausible codes.
- Duplicate markup and other providers' passwords no longer consume the unique-link/password scan limits. Resource v10 and release-tagged browser requests exclude cached incorrect URL/password associations. Case-insensitive schemes/hosts preserve the actual share token.

### Added

- Public resource API regressions for password pairing, foreign-provider isolation, formatting, row/line boundaries, conflict handling, limits and unchanged response fields; native Workers and browser checks verify the same associations and password-only copy behavior.

## [1.0.10] - 2026-10-02

### Fixed

- Literal TMDB title matches take precedence over type/year words inferred from a title, so titles such as The Truman Show, The TV Set and 电影少女 are not discarded by an incorrect media-type filter.
- Poster and OMDb enrichment stay bound to the selected TMDB ID and media type. Known IMDb IDs use exact lookups; all identified OMDb profiles must map back to the selected TMDB work. Mismatched frontend responses cannot replace confirmed metadata or images, and verified profiles remain usable without a poster.
- Resource and broken-poster retries bypass the browser HTTP cache as well as Worker caches, including repeated retries of the same URL.
- HTTP 200 maintenance/unavailable resource detail pages retain their source cards, count as incomplete scans and use the 15-minute recovery cache. Normal resource posts discussing maintenance remain readable. Resource v9 and poster v4 cache namespaces exclude earlier false successes and identity-free poster entries.
- Actor filters keep the unfiltered TV + movie total in the “全部” count and accessible label instead of displaying the currently filtered total.

### Added

- Public-route regressions for literal titles, selected poster/IMDb identity, verified metadata without images, invalid identity parameters and both resource providers' detail maintenance pages.
- Browser checks for mismatched TMDB/IMDb poster responses, identity-verified title enrichment, fresh repeated retries and stable actor filter totals; native Workers checks for literal-title recognition, identity-isolated poster caches and partial detail maintenance scans.
- Live release checks for The Truman Show and exact selected movie/TV posters, alongside byte-for-byte static release matching.
- Isolated browser startup waits up to 60 seconds for healthy cold CI Chrome, checks process exit immediately and bounds each debug request, avoiding false failures before page tests begin.

## [1.0.9] - 2026-10-02

### Fixed

- Resource completion retries remain functional after retrying TMDB details; retained results are rebound to the current request ID and abort signal.
- HTML tag cleanup and WPZY result-item scanning avoid repeated full-page scans on malformed input; incomplete result markup is rejected as an upstream failure.
- HTTP 200 WPZY maintenance, soft-block and unknown pages are no longer cached as healthy empty searches. Recognized empty results remain valid; a v8 resource cache namespace excludes earlier false successes.
- API error responses only expose application-controlled messages, never raw transport/provider diagnostics. Provider HTTP statuses remain intact and structured logs redact Bearer/Basic credentials as well as API keys and login cookies.
- Native rate-limit verification accounts for wall-clock window rollover using bounded fresh-key attempts, while still requiring the configured quota and a real HTTP 429.

### Added

- Browser regression for resource completion after detail retry, malformed-HTML performance checks, safe-error fault injection across API routes, and deterministic rollover/negative rate-limit tests.
- A credential-free empty-search fixture verified against WPZY's current page structure; native Workers checks cover maintenance, valid empty searches and safe provider-error responses.

## [1.0.8] - 2026-10-01

### Fixed

- Migrated the unavailable WPZYS upstream to wpzy.org while preserving the `wpzysResources` API collection and source identifiers.
- Login redirects and HTTP 200 login pages are reported as provider failures instead of successful empty results. Posts requiring replies or membership retain their source cards without extracting gated links.
- Resource cache and request coalescing are isolated by a SHA-256 fingerprint of the normalized server login state in a new v7 cache namespace.

### Added

- Optional `WPZY_COOKIE` Worker Secret for a dedicated, authorized read-only account; only site login cookies are sent to the exact HTTPS host, never to www aliases, other providers, responses, logs or frontend code.
- Read-only path validation, cross-provider redirect blocking, canonical forum links, and a maximum of six WPZY detail pages per search.
- Regression coverage for authenticated search/detail requests, expired logins, restricted posts, cookie validation, redirect isolation and credential-sensitive caches; browser and native workerd checks cover the new access states.

### Changed

- Forum labels now identify WPZY. Partial-scan notices distinguish login maintenance, site access restrictions and temporary outages; reply/VIP-only results do not encourage ineffective retries.
- Deployment and API documentation explain secret renewal, sharing scope, access limitations and the preserved API contract; version metadata and frontend module URLs are synchronized.

## [1.0.7] - 2026-10-01

### Fixed

- Actor results now complete their live loading announcement consistently after cast-ID navigation, candidate confirmation, name search and history restoration. Successful views report loaded/total counts instead of retaining a stale "loading" message.

### Changed

- Added browser regression assertions for cast navigation and ambiguous/medium-confidence actor confirmation; synchronized release metadata and cache-busted module imports for the patch publication.

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
