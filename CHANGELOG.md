# Changelog

## [1.0.43] - 2026-11-12

### Fixed

- A search with a season (`庆余年 第二季`) no longer waits up to 1.5 seconds for a detail prefetch the page cannot reuse; the lookup still warms the cache in the background.
- `第4部` is read as a season hint: the title is searched without it and the season applies to a series result. Films stay in the results, because the same words name a film in a franchise.

## [1.0.42] - 2026-11-12

### Changed

- Telegram: the synopsis and season messages have **↩ 详情卡片** and **🔍 夸克资源** buttons, so the card can be reopened without scrolling back.
- Telegram: the recommendation score on a card counts a Chinese Wikipedia article, as the page does. The card waits at most 2.5 seconds for that lookup.

## [1.0.41] - 2026-11-12

### Added

- Favorites: **☆ 收藏** on a title saves it in this browser (up to 30) and lists it under the search box.
- Quark links opened in this browser are marked 已打开过.
- **按评分排序** on an actor's works (`sort=rating` on `/api/tmdb/person`); works with fewer than 20 votes stay after the rated ones.
- A **↑ 再搜一部** button on long pages that returns to the search box.

### Changed

- Start the resource scan 1.5 seconds after the details are confirmed, without waiting for the lists to scroll into view.
- Show one synopsis: the TMDB overview is folded under 查看 TMDB 概述 when Chinese Wikipedia provides the synopsis, and hidden when it is the synopsis.
- On phones, shrink the masthead after a search and the poster on the detail page so the title and score start on the first screen.
- Use Chinese labels for the detail facts, the subtitle (`2023 · 剧集 · TMDB 106841`) and section headings.

## [1.0.40] - 2026-11-11

### Added

- A **夸克资源 ↓** button under the title that jumps to the resource lists and starts the scan.
- Recent searches under the search box, stored in this browser, with example titles before the first search and a 清除 button.
- Posters and TMDB ratings in the candidate picker.

### Changed

- Show the resource lists directly below the synopsis; the data dossier moves below them, and on desktop it no longer repeats the facts shown in the sidebar.
- Quark cards show the share address as written (it was displayed in upper case although share tokens are case-sensitive) and repeat the source post only when its title differs from the card.
- Number reposts that share a title (`同名帖 2/4`).
- When links were found, an incomplete scan is a small note below the lists instead of a warning above them.
- A search that finds nothing offers 修改关键词, which returns to the search box, instead of repeating the same search; the message no longer repeats its hint.
- Focus the search box on the desktop home page.
- Enlarge the preference buttons to a 44px touch target.

## [1.0.39] - 2026-11-10

### Fixed

- Telegram: a requested season is attached only to series, so "某片 第二季" no longer fails on movie results.
- Telegram: every state of the resource message keeps a rescan button, and a failed or interrupted scan becomes a retry instead of staying on "正在扫描".
- Telegram: in groups the bot ignores unknown commands and commands addressed to another bot, replies to the asking message and stays in its forum topic.
- Telegram: rate limits apply before any reply and a limited user gets no reply; only opening or rescanning resources counts against the scan limit, so paging no longer exhausts it.
- Telegram: Quark links and forum posts switch inside one message; long URLs can no longer cut the message markup; Telegram and runtime error text is not shown to users; a short `retry_after` is honored once.
- Search keeps a work whose title contains a type word: `truman show` finds The Truman Show instead of filtering it as "not a TV show". A separate type word (`The Truman Show 1998 TV`) still filters.
- Resource search accepts series threads that name a season after the title (`庆余年2 全36集`, `庆余年1-2季`, `鱿鱼游戏S03`, `庆余年Ⅱ`) and quality tags glued to the title (`长安的荔枝HDR`); numbered subtitles and movie sequels are still excluded.
- Resolutions and bitrates such as `1920x1080` are no longer read as release years.
- A missing season offers 查看全剧 and a missing entry says 条目不存在 without a retry that would repeat the same `404`.
- Search errors are shown in Chinese instead of the Worker's English messages.
- Allow the Cloudflare Web Analytics beacon in the Content Security Policy; it had been blocked since v1.0.34.

### Changed

- Cache a complete resource scan with no Quark links for 30 minutes instead of 12 hours.
- `/telegram/setup` keeps pending messages unless called with `drop=1`.
- Link the committed touch and PNG icons, add a canonical URL and a share image.

## [1.0.38] - 2026-11-09

### Added

- A Telegram bot in the same Worker. Send a title or actor name, or use `/search` and `/actor`, to get the web page's flows as chat messages and inline buttons: candidate pickers, a detail card with poster, TMDB rating, iPlay recommendation score, cast and seasons, the actor's works with filters and paging, the full synopsis, and the Quark resource scan with paged links, one-tap password copy buttons, forum posts and rescans. Setup is in `docs/TELEGRAM.md`.
- `POST /telegram/webhook`, authenticated with a secret derived from `TELEGRAM_BOT_TOKEN`, and `GET /telegram/setup?token=…` to register the webhook and command menu. Each Telegram user is rate-limited like a web client; `TELEGRAM_ALLOWED_USERS` restricts the bot to listed user IDs.

### Changed

- Logs redact Telegram bot tokens in API paths.

## [1.0.37] - 2026-11-08

### Fixed

- Show toast messages such as "提取码已复制" again. Tailwind 4 positions the toast with the `translate` property, and the script moved `transform`, so the toast stayed below the viewport.
- Pressing Enter during a slow search starts the new query; the disabled search button blocked form submission. Repeating Enter for the query already running does not restart it.
- Replace the preference genres no data source returns (轻松, 职业, 血腥, 暴力, 悲剧) with 家庭, 动画 and 战争; split TMDB's `War & Politics`, `Sci-Fi & Fantasy` and `动作冒险`; and add Douban genres to the score once the Douban match is confirmed, so 灾难 and 战争 can apply.
- An emptied preference field keeps the default instead of saving 0, and a failed reset no longer reports success.
- Show "未找到第 N 季" only for a `404`; a timeout or outage on a season search says the details are temporarily unavailable.
- Before the detail request finishes, the resource lists say they are waiting rather than "nothing found".
- Move focus to the retry button when a failure hides the control that started the load, restore the actor list meta line after a failed page, count only the actor candidates shown, and replace raw JSON parse errors with a readable message.
- Scan Quark passwords in linear time. A "密码" label followed by a long whitespace run in a forum post backtracked quadratically: 200,000 spaces took 95 seconds of CPU.
- Decode HTML entities once, so `&amp;lt;` stays the text `&lt;`; decode entities in Douban genres and summaries.
- Key the Wikipedia cache on the request instead of the TMDB adjacent-year lookup, so a cache hit no longer waits up to 3 seconds on TMDB or misses when TMDB is slow.
- Report upstream `401`/`403` as `502` rather than the visitor's own authorization failure, and send `Retry-After` with `429` and `503`. Douban search blocks, throttling and challenge pages return `503`, which opens the page's Douban back-off.
- A forced resource refresh returns the cached result, marked `X-iPlay-Stale: 1`, when every provider fails.

### Changed

- Cache empty Douban suggestions for 1 hour instead of 24.
- Key poster results with a TMDB identity on the identity only (`poster-v7-cache.local`), so different title spellings share one entry.

## [1.0.36] - 2026-11-08

### Fixed

- Find Chinese Wikipedia articles stored under the bare name in another script, such as 《狂飙》 as `狂飆`; the summary still needs media type and year evidence.

### Changed

- Split the Worker into one module per data source (`tmdb.js`, `douban.js`, `resources.js`, `poster.js`, `wiki.js`) with shared infrastructure in `core.js`; `_worker.js` only routes requests. The deployed bundle is unchanged in behavior.

## [1.0.35] - 2026-11-08

### Fixed

- Accept an adjacent Wikipedia year only for a series that premiered in November–February, using the TMDB premiere date. v1.0.33 accepted any adjacent year and matched the 2018 live-action 《斗破苍穹》 to the January 2017 animation.
- Resolve standard Wikipedia article names only after the search candidates fail, one request at a time; the concurrent lookup was throttled and 《狂飙》 still had no summary. A `404` now reports whether the lookup succeeded.

## [1.0.34] - 2026-11-08

### Added

- A **调整推荐偏好** panel to change genre weights (-5 to 5), re-score the current title and reset to defaults.
- A Content Security Policy that limits scripts to the site, network requests to the Worker and fonts to Google Fonts.

### Fixed

- Resolve standard Chinese Wikipedia article names with variant conversion and redirects in one request. 《狂飙》 is stored as `狂飆 (電視劇)`, which the summary endpoint did not find from the simplified name.
- Scan distinct resource titles before reposts with identical titles.
- Stored preference keys such as `__proto__` no longer reach the weight object's prototype.
- The scheduled refresh no longer refreshes a built-in title; it only runs for `CRON_REFRESH_TITLES`.

### Changed

- Update ESLint to 10.14, Tailwind CSS to 4.3.5 and Wrangler to 4.158.0, and the Worker compatibility date to 2026-10-01.

## [1.0.33] - 2026-11-08

### Fixed

- Stop waiting on Douban detail pages that Douban blocks for Worker requests. A 403, 429 or challenge page now returns `503` with `Retry-After` and opens a 30 minute circuit for every subject; the page skips Douban for the same period and keeps the TMDB rating.
- Find Chinese Wikipedia summaries the search ranking omits by trying standard article names such as `狂飙 (电视剧)`, and accept an adjacent premiere year for series (《繁花》 premiered on 2023-12-27; Wikipedia lists 2024).
- Identify Wikipedia requests with an `iPlay/{version}` User-Agent and contact URL as Wikimedia requires, and request simplified Chinese text.
- Match resource posts that use the work's TMDB original or regional titles (「哪吒2」, 「哪吒之魔童鬧海」, 「Ne Zha 2」), ignore punctuation and spacing inside names, and accept an adjacent year for movies.

## [1.0.32] - 2026-11-07

### Fixed

- Keep only resource posts whose title names the selected work at a title boundary. Searching "狂飙" no longer returns 《公路狂飙》, 《F1：狂飙飞车》, 《GT赛车：极速狂飙》 or WPZY posts that merely mention the word; sequels such as "流浪地球2" are excluded as well.
- Search By669, WPZY and 醉都音 by title only and verify the year locally. A year-qualified By669 search took 7–11 seconds and exceeded the 5 second provider timeout, so By669 was reported as failed for most selected works; WPZY rejected nearly every title because the query included the year.
- Accept year ranges such as "（2019-2023年）" for movies, and later season years or no year for series whose threads list the latest season.
- Match WPZY titles without the spaces its keyword highlighting inserts, and 醉都音 headings split by inline markup.

## [1.0.31] - 2026-11-07

### Fixed

- Only collect Quark shares listed under the matched work heading in 醉都音 collection posts, so other works in the same post are no longer attributed to the search.
- Match 醉都音 work headings that contain inline markup such as `<strong>`.
- Accept a requested release year from the post title or the matched work section when a collection heading omits it; share tokens no longer count as year evidence.
- Stop 醉都音 posts, whose bodies arrive with the search response, from consuming the 12 fetched detail-page slots, and keep their evidence when the scan deadline expires.
- Send the same browser User-Agent to 醉都音 as to the other resource providers.

## [1.0.30] - 2026-11-07

### Added

- Search the 醉都音 public film and TV index for Quark shares and show the original posts alongside By669 resources.
- Use the `动画片` and `动画版` suffixes to find animated works with the same title as live-action adaptations.

## [1.0.29] - 2026-11-07

### Fixed

- Smooth recommendation scores at the 7.0 rating boundary.
- Reject Wikipedia summaries when either the description or extracted introduction identifies a different media type.
- Keep resource searches scoped to the selected TMDB identity and release year, and preserve complete cached results when a refresh is partial.
- Reject poster matches whose IMDb ID conflicts with the selected work.
- Validate requested TV seasons against TMDB detail and preserve the season in shared URLs.

### Tests

- Add regressions for score continuity, media-type conflicts, resource identity and refresh caching, poster identity, and requested seasons.

## [1.0.28] - 2026-11-02

### Fixed

- Recognize season markers attached directly to Chinese titles, and let an exact whole-title match override a season-like title prefix.
- Preserve a pending poster fallback when a browser repeats the primary image error during detail repaint.
- Restore history entries with identical URLs by tracking their entry identity while continuing to ignore fragment-only navigation.
- Parse Quark shares wrapped in ASCII parentheses or square brackets.
- Merge password evidence for globally retained shares across page sampling limits and keep that evidence in page snapshots.

### Tests

- Cover Chinese season suffixes, literal season-like film titles, ASCII-wrapped shares, cross-page password conflicts, repeated image failures, and same-URL history restoration.

## [1.0.27] - 2026-11-02

### Fixed

- Stop reading the possessive in titles such as "Ocean's 8" as a season marker, which filtered the film out of TMDB search.
- Ignore fragment-only history steps (the skip link and its Back step) instead of reloading the current detail or clearing the search box.
- Keep the history mode when a restored shared actor link resolves to a title, so Back no longer re-pushes the same entry.

### Tests

- Add regressions for possessive titles, fragment navigation and restored actor links that resolve to titles.

## [1.0.26] - 2026-11-01

### Fixed

- Require an exact same-year title or original-title match before attaching a Douban rating to a confirmed work.
- Parse Quark links wrapped in Chinese punctuation and keep foreign-provider extraction codes away from nearby Quark shares.
- Allow canonical titles up to 300 Unicode characters in enrichment endpoints while retaining the 100-character TMDB search limit.
- Reconcile all selected resource pages before applying the 100-link response cap so password conflicts do not depend on response timing.
- Reload saved genre preferences during each score calculation and omit zero-weight genres from avoidance warnings.

### Documentation

- Rebuild frontend assets after changing `API_BASE` in the deployment guides.

### Tests

- Add regressions for exact Douban identity, long canonical titles, Chinese-wrapped shares, provider-code isolation, preference updates and resource response ordering.

## [1.0.25] - 2026-11-01

### Fixed

- Clear exhausted poster state and show an unavailable message when the fallback image also fails, rather than leaving a successful recovery notice.
- Keep the search scoring benchmark comparable to its historical baseline by disabling follow-up prefetch only in the instrumented benchmark module. Production prefetch remains covered independently.

### Tests

- Add browser coverage for primary and fallback image failures, including a terminal status and no retry loop.

## [1.0.24] - 2026-11-01

### Removed

- Remove OMDb endpoints, client requests, API-key configuration, external rating panels and poster fallback. TMDB remains the poster and detail provider; keep IMDb IDs supplied by TMDB for work identity checks.
- Update active documentation and tests, while retaining historical release/review records.

## [1.0.23] - 2026-10-31

### Security

- Override the ESLint toolchain's transitive minimatch to 11.0.1, the patched version for GHSA-g3hv-75wg-m249. Keep the existing ESLint version and Node 22/24 CI matrix.

### Fixed

- Reject Quark source paths containing literal or encoded dot segments before URL normalization can rewrite them into another share.
- Validate TMDB detail titles against the requested media type, and use movie/TV-specific title, original-title and date fields throughout search, details and poster selection. A same-number ID from the other media type no longer passes detail validation or enters its cache.
- Invalidate older resource and poster aggregates after these identity corrections.
- Decode HTML numeric entities as complete Unicode code points so supplementary Chinese characters and emoji do not corrupt resource titles or hide matching WPZY results.

## [1.0.22] - 2026-10-30

### Fixed

- Try the next verified Chinese Wikipedia result when an earlier same-title page is missing, belongs to another work, or has the wrong year. Prefer candidates with an explicit matching year and stop on provider failures under the existing shared deadline.
- Preserve the IMDb ID attached to a Douban rating and clear that rating if a detail retry confirms a different IMDb identity, even when title and year are unchanged.
- Validate complete Quark share paths before returning links. Extra path segments and encoded slashes no longer get truncated into a different share URL.
- Show how many source posts were scanned when the fixed detail-page cap leaves additional original posts unscanned.

### Verification

- Add Worker and browser regressions for candidate fallback, identity changes, malformed share paths and unscanned source status.
- Bump the Wiki cache namespace to v6 and resource cache namespace to v13 so prior cached results do not hide corrected selection and link parsing.

## [1.0.21] - 2026-10-30

### Security

- Reject TMDB redirects before following them, preventing bearer credentials from reaching redirect destinations under the configured Workers compatibility target. Native workerd checks assert that no redirected request is sent.

### Fixed

- Preserve TMDB HTTP errors even when gateways return HTML or empty bodies, so authentication failures, rate limits and outages stop fallbacks, and legacy untyped details can still recover from a movie `404` to the matching TV namespace.
- Validate embedded TMDB detail identities and person payloads before caching them. Explicit `no-store`, `reload` and `no-cache` requests bypass and invalidate memory entries.
- Discard fallback posters after details establish a conflicting IMDb identity; retain usable images when the identity is unchanged.
- Verify direct OMDb profiles against the requested IMDb ID before applying ratings or posters, matching the existing poster-endpoint identity checks.

### Verification

- Add Node, native workerd and browser regressions for these failures, including valid empty/ambiguous prefetch results, refresh invalidation, redirected credentials and poster recovery. Update deployment-tool documentation to the already locked Wrangler 4.155.0.

## [1.0.20] - 2026-10-29

### Performance

- A search response now carries the TMDB answer the page requests next, so the page skips one browser-to-Worker round trip (about 0.45–0.55s per request on the measured link). A confident title that opens directly embeds its detail; a weak, absent or actor-preferred title embeds the default actor lookup, including the ambiguous-name picker (`张译`). The Worker waits at most 1.5s within the search deadline. A slower lookup keeps running to warm the edge cache, and failed or degraded follow-ups are never embedded.
- Pages stop calling `/api/omdb` for the rest of the session once the Worker answers `OMDb API not configured`. Before, every detail view sent one request that could not succeed.

### Security

- Update wrangler 4.149.0 → 4.155.0 and the matching miniflare 5.20261023.2-beta. This removes the high-severity undici advisories (GHSA-4qv8-2p9j-2685 and seven related) and the moderate miniflare/wrangler advisories from the development and deploy toolchain. `npm audit` reports 0 vulnerabilities; all installed packages with attestations verify.

### Verification

- Add Worker tests for detail and person embedding, confirmation-gap exclusion, failed, slow and degraded follow-ups, and upstream stop signals. Add client tests for single-identity reuse, copy isolation, malformed payloads and abort handling, and a browser flow that proves neither the detail nor the person request is sent. Call-budget tests now count title searches separately from the follow-up that replaces the page's request.
- Local CPU measurement with a 231 KB actor payload: the combined search and embedded person use 2.5 ms at p50 and 4.6 ms at p90, against a 0.8 ms search and a 2.0 ms person request measured separately.

## [1.0.19] - 2026-10-29

### Fixed

- Searching an actor's exact name opens the actor's filmography instead of a documentary or compilation that merely contains the name. Production examples: `周星驰` opened `周星驰合集`, `梁朝伟` opened `这一刻，梁朝伟对你说`, and `斯嘉丽·约翰逊` matched `Chris Grace: As Scarlett Johansson` through a Douban alias. The Worker reports `searchMeta.exactPerson` from the people TMDB multi-search already returns; an exact title still wins, and directors keep the previous behavior.
- Chinese actor names with no exact title stop after one TMDB request instead of running en-US, typed and Douban alias fallbacks (`张译`: three sequential attempts and ~2.9s Worker time before the person lookup could start). Latin names keep the en-US pass that can find an exact English title.

### Performance

- The API preconnect now uses `crossorigin`. The frontend's anonymous CORS requests could not reuse the previous credentialed connection, so the first API call paid a full TCP/TLS handshake (about 0.6s on a measured high-latency link).
- Complete TMDB search, person and detail responses allow 5-minute browser caching on release-tagged URLs. Back/forward navigation reuses them instead of repeating round trips; failed and degraded responses remain `no-store`.

### Verification

- Add Worker regressions for actor intent, fallback suppression, Latin-name preservation, non-actor exclusion and cache headers, plus a browser flow for actor-versus-title routing. The new Worker tests fail against 1.0.18.

## [1.0.18] - 2026-10-20

### Performance

- Reuse pure query/title text scores across search fallbacks in a request-owned cache of at most 1,024 pairs. Re-evaluate identity, year, media type and ranking on every pass; keep the existing upstream budget and result order.
- Select actor-card posters from TMDB w185/w342/w500 variants using the actual grid breakpoints and device pixel ratio. Keep lazy loading, non-TMDB sources and placeholder recovery after responsive image errors.
- Scan resource URL boundaries with an iterator instead of retaining every foreign URL and duplicate share. Preserve leading/trailing password pairing, conflict resolution and evidence arriving after the result cap.
- Skip the redundant poster lookup when canonical TMDB details and a successful matching OMDb profile have both confirmed no image. Provider failures, unconfirmed identities and failed image loads retain the existing fallback.

### Verification

- Add public-route search and parser benchmarks, deterministic old/new parser comparison, five image-density byte models and regressions for intent changes, cache capacity, late password evidence and image fallbacks.
- Extend native workerd checks for repeated search scoring and near-limit foreign-link pages; browser regressions execute the generated production entry.

## [1.0.17] - 2026-10-18

### Performance

- Bundle and minify the frontend into one versioned ES module with locked esbuild 0.28.2, eliminating the eight-import discovery waterfall. Source modules remain editable; CI verifies committed JavaScript and CSS match a clean build.
- Append actor filmography pages to existing groups instead of rebuilding every card. Loaded image state, listeners and card identity survive pagination; a newly introduced TV group retains its position before movies.
- Refill resource detail requests as connections become available, with a maximum of six concurrent reads and twelve selected pages. Reconcile results in source order and retain password conflict, page evidence, result-cap and deadline behavior.

### Verification

- Add reproducible mobile/desktop browser benchmarks with optional Chrome traces, fixed-upstream Worker measurements, scheduler regressions and native workerd queue checks.
- Browser regressions execute the actual production bundle and verify card preservation. Live release validation checks the generated entry as well as source modules.

## [1.0.16] - 2026-10-16

### Fixed

- Reject oversized resource URLs and share tokens without returning shortened identifiers, bound aggregate JSON to 2 MiB, and replace the resource cache namespace. A native Workers reproduction fell from 45.6 MB to 2.2 KB while preserving source entries.
- Keep resource results in the credential-scoped Worker cache while prohibiting browser HTTP caching on all reads, so changed or revoked server access is consulted on the next request.
- Wrap long resource filenames and source titles within mobile cards. Keyboard expansion reaches the first new share and its password control; collapse restores the expansion control without jumping to the list end.
- Wiki work-year validation distinguishes original release dates from restoration, rerelease and award years, validates explicit title years independently, and keeps genuine regional release years supported. A new cache namespace excludes prior mismatches.

### Improved

- Native Workers tests consume the actual Wrangler entry point, compatibility target, variables and rate-limit bindings; configuration policy regressions fail before runtime startup.
- HTTP and Chrome readiness checks bound stalled response headers and bodies, release unused bodies and detect early process exits. The optional manual production deployment job only runs on main.
- Add resource-size, cache-isolation, year-evidence, long-title and real keyboard regressions, plus production checks for resource `no-store` headers.

## [1.0.15] - 2026-10-16

### Fixed

- Year-qualified titles keep media words belonging to their actual names, including `The Truman Show 1998`, `The TV Set 2006` and `电影少女2018`. Explicit years and external type hints still constrain matches; stripped shorter names cannot silently become exact aliases for unrelated works.
- Explicit empty person IDs, detail types and IMDb IDs return validation errors before upstream requests. API clients preserve those parameters for validation; genuinely omitted legacy detail types remain supported.
- Resource expansion exposes all returned sources and up to 100 reconciled Quark shares, removing hidden 12-source and 50-share truncation while retaining six initial entries.
- Detail retries retain loaded enrichment during pending and failed refreshes. Successful recovery clears stale title/year-based data and mismatched IMDb profiles when canonical identity changes.
- Automatic Workers Builds deployments preserve optional Dashboard variables through `keep_vars=true`, matching the manual CLI fallback.

### Added

- Public API, real workerd and browser regressions for literal title boundaries, fail-closed identity validation, complete resource visibility and enrichment retention across failed and successful retries.
- Production smoke checks compare the unversioned homepage with the release, verify year-qualified literal searches and reject explicit empty identities. Isolated browser tests block external font requests to keep cold startup deterministic.
- A fresh audit record and synchronized API, architecture, testing and deployment documentation.

## [1.0.14] - 2026-10-13

### Fixed

- Partial HTTP 200 resource retries reconcile independent page snapshots: temporarily failed pages retain links, successful pages replace stale evidence, and restricted or expired-login pages drop old shares. Password conflicts and URL-bound priority survive alternating provider failures; displayed shares remain capped at 100.
- Resource queries wait for TMDB details to settle and include the canonical title, year and selected identity in their state key. Corrected detail retries cannot reuse resources from an older title.
- Canonical detail posters replace candidate images; repainting the same failed image no longer cancels a pending verified fallback. Failed URLs are tracked to avoid repeating broken-image loops.
- Wikipedia separates article names from media and release-year evidence, preserving films with novel/comic words or years in their titles while rejecting wrong adaptations, disambiguation and remake years.
- Recommendation scoring uses a compatible own-property check while retaining protection against inherited genre keys.

### Added

- Executable resource-state regressions, browser race/retry checks and Worker/runtime coverage for page evidence and Wikipedia identity boundaries.
- Live release validation discovers all frontend modules and checks version/CORS on optional API responses. Source-only Node coverage and browser support documentation now state their actual verification scope.
- Tailwind scans only production HTML/JavaScript, keeping test fixtures and review documents out of generated styles.
- A comprehensive review record and synchronized API, architecture and deployment instructions. Resource v11 and Wiki v4 cache namespaces exclude earlier response contracts.

## [1.0.13] - 2026-10-11

### Fixed

- Explicit invalid or empty person/media IDs in share links fail before any API request; malformed person links cannot fall back to a different same-name actor. Legacy name-only actor links remain supported.
- Douban, Wikipedia and OMDb enrichment use the canonical title, media type and year after TMDB details finish. Search metadata remains immediately visible, and an early old-title synopsis can no longer survive a corrected detail response.
- TMDB media details require the requested credits cast/crew arrays and external-ID object before caching; incomplete cached entries are evicted and refetched, while valid empty fields remain supported.
- Updated the matched Wrangler/Miniflare toolchain to 4.149.0 / 5.20261006.1-alpha (sharp 0.35.5) and source-map-js to 1.2.2 to resolve the two underlying security advisories reported across four development dependencies.

### Added

- Browser regressions for share ID validation and canonical enrichment; API and native workerd checks for incomplete media details and cache recovery.
- A dated review record, corrected development/deployment instructions and an immutable commit pin for the CI Chrome installer.

## [1.0.12] - 2026-10-08

### Fixed

- Resource completion preserves usable links, password-copy controls and expanded lists during pending and failed retries; retry buttons remain disabled until the request completes.
- Selected actor and actor-share recovery retries retain the exact person ID and history behavior instead of repeating an ambiguous name search.
- Shared detail links reject invalid explicit media types before any API request and normalize valid type values.
- TMDB person payloads require the requested combined-credit cast array before caching; incomplete cached entries are evicted and refetched, while valid empty filmographies remain supported.
- Wikipedia checks opening-sentence years as well as title/description years. Wiki v3 Worker caches and release-tagged client requests exclude earlier incorrect summaries.

### Added

- Regression tests for actor payload validation/cache repair and Wiki remake-year mismatches, native workerd recovery checks, and browser coverage for resource preservation and selected/shared actor retries.
- A dated code-review record and updated API, architecture and testing documentation.

## [1.0.11] - 2026-10-07

### Fixed

- Quark passwords stay associated with their share across consecutive links, leading/following labels, rendered line breaks and HTML formatting. Other providers' URLs and explicit labels, separate cards and footers are pairing boundaries; Baidu extraction codes no longer leak into Quark shares.
- URL-bound passwords take priority over nearby prose during same-page and cross-page deduplication, with provenance from the winning source. Equal-confidence disagreements, including conflicting URL parameters, omit the password rather than choosing by page order. Overlong tokens are not truncated into plausible codes.
- Duplicate markup and other providers' passwords no longer consume the unique-link/password scan limits. Reaching the total link cap still reconciles duplicate passwords from already-fetched pages. Resource v10 and release-tagged browser requests exclude cached incorrect URL/password associations. Case-insensitive schemes/hosts preserve the actual share token.

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
