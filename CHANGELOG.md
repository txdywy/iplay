# Changelog

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
