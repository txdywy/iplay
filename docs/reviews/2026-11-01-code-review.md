# Full project review — 2026-11-01

Baseline: `ffed77a` (v1.0.24). Follow-up: v1.0.25.

## Scope

Reviewed frontend search/detail lifecycle, cancellation and retries, canonical work identity, history restoration, rendering and external links, poster recovery, supplementary ratings, resource snapshot/password merging, preference scoring and formatting. Reviewed Worker routes, validation, credential handling, redirects, body/time limits, context-owned coalescing, cache scope, rate limiting, cron refresh, build artifacts and CI configuration.

## Findings and repairs

1. **Poster recovery notice remained successful after the fallback image failed.** A new browser scenario reproduced the incorrect “已找到备用海报” message after the placeholder appeared. The terminal branch now reports “暂无可用海报”. Unusable fallback results also clear the view model's poster URL/source. The regression checks the final notice, non-busy state and absence of repeated lookups.
2. **Search scoring benchmark counted speculative follow-up requests as title search attempts.** The historical baseline predates prefetch. The benchmark now disables prefetch only in its loaded source fixture and documents this measurement boundary. It still asserts six TMDB searches, one Douban alias request, identical responses/request sequences and fewer score calculations. Actual prefetch behavior remains enabled and independently tested.

No additional release-blocking defect was identified in the reviewed paths. This is evidence from code inspection and controlled tests, not a guarantee for every external-provider response or device.

## Verification

- 258 Node tests, ESLint, frontend production build.
- 41 browser smoke flows (390×844 and 1280×900), no uncaught application exceptions.
- 32 native workerd checks, including credential isolation, context ownership, cache behavior, HTMLRewriter and production rate-limit failure handling.
- Worker resource scheduling and near-limit parser benchmarks passed.
- Search benchmark: six title lookups and one alias lookup; identical output and requests; score calculations reduced from 4,241 to 121 versus the historical baseline.
- Image-byte benchmark passed five viewport/DPR scenarios; the smoke suite additionally covers responsive image sizing and broken-image cleanup.
- Mobile browser lab profile: 300 ms latency, 96 KiB/s download, 6× CPU slowdown; three cold runs and actor/resource interaction scenarios passed. Fonts and APIs are controlled fixtures, so these are not production Core Web Vitals.
- `npm audit`: zero reported vulnerabilities in the installed lockfile graph.

Live provider availability is independent of these mocked and native tests. The release is additionally checked against deployed static assets, Worker version, TMDB search/detail/posters, retired routes and optional-provider responses.
