# Changelog

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
