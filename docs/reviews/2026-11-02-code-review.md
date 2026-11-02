# Full project review — 2026-11-02

Baseline: `9fcb7cb` (v1.0.26). Follow-up: v1.0.27.

## Scope

Reviewed all Worker routes (validation, CORS, rate limiting, TMDB auth/redirect isolation, caching and coalescing, search intent and scoring, prefetch, person search, Douban, resource providers and Quark password pairing, posters, Wikipedia identity checks), the frontend search/detail/actor lifecycle, history restoration, URL and image sanitizing, the helper modules, build script and CI workflows.

## Findings and repairs

1. **Possessive titles were parsed as seasons.** `extractSearchSeason` accepted the `s` in `Ocean's 8` as a season marker, set a TV intent and dropped the exact movie match (0 results). A bare `s`/`season` marker must now not follow a letter, digit or apostrophe. `Friends s02` still parses as season 2.
2. **Fragment navigation reloaded the view.** Browsers fire `popstate` for `#fragment` navigation. The skip link re-ran `restoreUrlState`, aborting work, refetching the detail and, on the home page, clearing the search box. The handler now ignores history steps whose query string is unchanged.
3. **Restored actor links pushed history.** When `?actor=` without `person` resolved to a title, `handleSearch` dropped `historyMode` and pushed a detail entry during popstate restoration, so Back looped on the same link. The mode is now forwarded.

No other release-blocking defect was identified in the reviewed paths.

## Verification

- 267 Node tests, ESLint and the frontend production build.
- 41 browser smoke flows, including the new skip-link and restored-actor-link checks (each confirmed failing without its fix).
- 32 native workerd checks.
- `npm audit`: zero reported vulnerabilities.
