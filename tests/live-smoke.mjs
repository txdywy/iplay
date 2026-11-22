import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { URLSearchParams } from 'node:url';

// Explicit opt-in only: this performs public read-only requests, not mocked CI tests.
const site = process.env.LIVE_BASE_URL || 'https://iplay.hackx64.eu.org/';
const api = process.env.LIVE_API_BASE || 'https://iplayw.hackx64.eu.org';
const release = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
const results = [];

async function fetchLive(url, options = {}, timeoutMs = 20000) {
    return globalThis.fetch(url, { ...options, signal: globalThis.AbortSignal.timeout(timeoutMs) });
}

async function getApi(path, expectedStatus = 200, timeoutMs) {
    const response = await fetchLive(new URL(path, api), { headers: { Origin: new URL(site).origin } }, timeoutMs);
    if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `${path}: unexpected HTTP status`);
    assert.equal(response.headers.get('access-control-allow-origin'), new URL(site).origin, `${path}: CORS`);
    assert.equal(response.headers.get('x-iplay-version'), release, `${path}: deployed Worker version differs`);
    const data = await response.json();
    return { response, data };
}

const frontendModules = (await readdir(new URL('../js/', import.meta.url)))
    .filter(name => name.endsWith('.js')).sort().map(name => `js/${name}`);
const homepage = await fetchLive(new URL(site));
assert.equal(homepage.status, 200, 'unversioned homepage');
assert.equal(await homepage.text(), await readFile(new URL('../index.html', import.meta.url), 'utf8'), 'unversioned homepage: deployed entry differs');
results.push({ check: 'unversioned-homepage', status: 'exact-release-match' });
for (const path of ['index.html', 'assets/app.min.js', ...frontendModules, 'css/output.css', 'VERSION']) {
    const url = new URL(path, site);
    url.searchParams.set('v', release);
    const response = await fetchLive(url);
    assert.equal(response.status, 200, path);
    if (path === 'assets/app.min.js') assert.match(response.headers.get('content-type') || '', /\b(?:javascript|ecmascript)\b/i, 'production entry must have a JavaScript MIME type');
    assert.equal(await response.text(), await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), `${path}: deployed asset differs from local release`);
    results.push({ check: path, status: 'exact-release-match' });
}

for (const path of ['assets/cinema.webp', 'assets/cinema-small.webp']) {
    const response = await fetchLive(new URL(path, site));
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') || '', /^image\/webp\b/i, path);
    const deployed = new Uint8Array(await response.arrayBuffer());
    const local = await readFile(new URL(`../${path}`, import.meta.url));
    assert.ok(deployed.length === local.length && local.equals(deployed), `${path}: deployed artwork differs from local release`);
    results.push({ check: path, status: 'exact-release-match' });
}

for (const query of ['流浪地球', 'The Matrix', 'The Truman Show', 'The Truman Show 1998', 'The Truman Show 1998 movie']) {
    const { data } = await getApi(`/api/tmdb/search?q=${encodeURIComponent(query)}`);
    assert.ok(data.results?.length > 0, `${query}: no results`);
    assert.ok(data.searchMeta?.matchScore >= 0.72, `${query}: unreliable match`);
    if (query.startsWith('The Truman Show')) {
        assert.ok(data.results.some(item => item.id === 37165 && item.mediaType === 'movie'));
        assert.equal(data.searchMeta.mediaType, query.endsWith('movie') ? 'movie' : null, 'only type words outside the literal title may impose a type');
        if (query.includes('1998')) assert.equal(data.searchMeta.year, '1998');
    }
    results.push({ check: `search:${query}`, status: 'passed', count: data.results.length });
}

for (const [id, type] of [[603, 'movie'], [1399, 'tv']]) {
    const { data } = await getApi(`/api/tmdb/detail?id=${id}&type=${type}`);
    assert.equal(data.id, id);
    assert.equal(data.mediaType, type);
    assert.ok(data.title && data.summary && data.genres?.length);
    assert.ok(data.cast?.length > 0 && data.castDetails?.some(actor => actor.id > 0), `${type}:${id}: missing appended cast`);
    assert.match(data.imdbId || '', /^tt\d+$/, `${type}:${id}: missing appended external ID`);
    if (type === 'tv') assert.ok(data.seasons?.length && data.totalEpisodes > 0);
    results.push({ check: `detail:${type}:${id}`, status: 'passed', title: data.title });
    const posterParams = new URLSearchParams({ title: data.title, id: String(id), type });
    if (data.imdbId) posterParams.set('imdb', data.imdbId);
    const { data: selectedPoster } = await getApi(`/api/poster?${posterParams}`);
    assert.equal(selectedPoster.tmdbId, id);
    assert.equal(selectedPoster.mediaType, type);
    assert.equal(selectedPoster.poster, data.poster);
    results.push({ check: `selected-poster:${type}:${id}`, status: 'passed' });
}

const { data: person } = await getApi('/api/tmdb/person?id=31&q=Tom%20Hanks&limit=2');
assert.equal(person.person?.id, 31);
assert.equal(person.credits?.length, 2);
assert.ok(person.hasMore && person.totalResults > 2);
results.push({ check: 'selected-person-and-pagination', status: 'passed' });

const { data: invalid, response: invalidResponse } = await getApi('/api/tmdb/detail?id=invalid&type=tv', 400);
assert.ok(invalid.error);
assert.equal(invalidResponse.headers.get('cache-control'), 'no-store');
const denied = await fetchLive(new URL('/not-found', api), { headers: { Origin: 'https://unapproved.example' } });
assert.equal(denied.status, 404);
assert.equal(denied.headers.get('access-control-allow-origin'), null);
results.push({ check: 'invalid-input-and-cors-denial', status: 'passed' });

for (const path of ['/api/tmdb/detail?id=603&type=', '/api/tmdb/person?id=&q=Tom%20Hanks']) {
    const { response, data } = await getApi(path, 400);
    assert.ok(data.error);
    assert.equal(response.headers.get('cache-control'), 'no-store');
}
results.push({ check: 'explicit-blank-identities-fail-closed', status: 'passed' });

for (const path of ['/api/omdb?imdb=tt0133093', '/api/omdb?title=Test']) {
    const { response, data } = await getApi(path, 404);
    assert.ok(data.error);
    assert.equal(response.headers.get('cache-control'), 'no-store');
}
results.push({ check: 'retired-omdb-routes', status: 'passed' });

// These services are optional. Report their real availability without confusing
// an upstream outage with a failed release of the main TMDB functionality.
for (const path of ['/api/wiki/zh?q=流浪地球&type=movie&year=2019', '/api/resource?q=流浪地球']) {
    const { response, data } = await getApi(path, null);
    assert.ok(data && typeof data === 'object');
    if (path.startsWith('/api/resource') && process.env.LIVE_REQUIRE_WPZY === '1') {
        assert.equal(response.status, 200, 'WPZY resource API unavailable');
        assert.equal(data.resourceMeta?.providers?.wpzys, 'ok', 'WPZY login/search was not verified');
        assert.ok(data.wpzysResources?.length > 0, 'WPZY returned no matching resource cards');
        assert.ok(data.wpzysResources.every(item => new URL(item.url).origin === 'https://wpzy.org'));
        assert.ok(data.quarkUrls?.some(item => item.sourceUrl?.startsWith('https://wpzy.org/thread-')), 'No directly readable WPZY share links were verified');
        results.push({check:'authenticated-wpzy-upstream',status:'passed',threads:data.wpzysResources.length,restrictedPages:data.resourceMeta.restrictedPages});
    }
    if (response.ok) {

        if (path.startsWith('/api/wiki')) assert.ok(typeof data.extract === 'string');
        if (path.startsWith('/api/resource')) {
            assert.ok(Array.isArray(data.quarkUrls) && data.resourceMeta);
            assert.equal(response.headers.get('cache-control'), 'no-store', 'resource responses must not reuse revoked provider access in browser caches');
        }
    } else {
        assert.ok([404, 429, 502, 503, 504].includes(response.status) && data.error);
    }
    results.push({ check: path, status: response.ok ? (data.partial ? 'partial' : 'available') : 'provider-unavailable', http: response.status });
}

const probeId = randomBytes(6).toString('hex');
const cacheMiss = await getApi('/api/resource/cache?q=release-check-' + probeId, 410);
assert.ok(cacheMiss.data.error);
assert.equal(cacheMiss.response.headers.get('cache-control'), 'no-store');
results.push({ check: 'resource-cache-miss', status: 'passed' });
// Quark's share endpoint has a long latency tail from the edge (0.5 s to over
// 4.5 s in the same minute), and a slow answer is correctly reported as
// unknown. Ask about a fresh nonexistent share up to three times; the answer
// that is accepted must still be a definitive one.
let quarkId = probeId;
let quark;
for (let attempt = 1; attempt <= 3; attempt += 1) {
    quarkId = attempt === 1 ? probeId : randomBytes(6).toString('hex');
    quark = await getApi('/api/resource/quark-status?id=' + quarkId, 200);
    if (quark.data.unavailable?.[quarkId]) break;
}
assert.equal(quark.response.headers.get('cache-control'), 'no-store');
assert.ok(['missing', 'invalid', 'deleted'].includes(quark.data.unavailable?.[quarkId]), 'Quark must confirm the generated nonexistent share');
assert.deepEqual(quark.data.unknown, []);
assert.deepEqual(quark.data.available, []);
assert.deepEqual(quark.data.passcodeRequired, []);
results.push({ check: 'quark-confirmed-missing-share', status: 'passed' });

if (process.env.LIVE_REQUIRE_PANSOUSUO === '1') {
    const params = new URLSearchParams({ q: '流浪地球', id: '550988', type: 'movie', year: '2019', refresh: '1' });
    const { data } = await getApi('/api/resource/aggregate?' + params, 200, 45000);
    const index = data.meta?.providers?.pansousuo;
    assert.equal(index?.status, 'ok', '盘搜索 must answer the production Worker');
    assert.ok(index.found > 0, '盘搜索 must return candidates for the probe title');
    assert.ok(Array.isArray(data.results));
    results.push({ check: 'pansousuo-index', status: 'passed', candidates: index.found,
        displayed: data.results.filter(item => item.source === 'index:pansousuo').length });
}

console.log(JSON.stringify({ liveSmoke: 'passed', release, site, api, results }, null, 2));
