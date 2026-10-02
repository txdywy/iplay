import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URLSearchParams } from 'node:url';

// Explicit opt-in only: this performs public read-only requests, not mocked CI tests.
const site = process.env.LIVE_BASE_URL || 'https://iplay.hackx64.eu.org/';
const api = process.env.LIVE_API_BASE || 'https://iplayw.hackx64.eu.org';
const release = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
const results = [];

async function fetchLive(url, options = {}) {
    return globalThis.fetch(url, { ...options, signal: globalThis.AbortSignal.timeout(20000) });
}

async function getApi(path, expectedStatus = 200) {
    const response = await fetchLive(new URL(path, api), { headers: { Origin: new URL(site).origin } });
    assert.equal(response.status, expectedStatus, `${path}: unexpected HTTP status`);
    assert.equal(response.headers.get('access-control-allow-origin'), new URL(site).origin, `${path}: CORS`);
    assert.equal(response.headers.get('x-iplay-version'), release, `${path}: deployed Worker version differs`);
    const data = await response.json();
    return { response, data };
}

for (const path of ['index.html', 'js/main.js', 'js/api.js', 'js/match.js', 'js/scorer.js', 'js/format.js', 'js/quark.js', 'js/seasons.js', 'js/release.js', 'css/output.css', 'VERSION']) {
    const url = new URL(path, site);
    url.searchParams.set('release', release);
    const response = await fetchLive(url);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), `${path}: deployed asset differs from local release`);
    results.push({ check: path, status: 'exact-release-match' });
}

for (const query of ['流浪地球', 'The Matrix', 'The Truman Show']) {
    const { data } = await getApi(`/api/tmdb/search?q=${encodeURIComponent(query)}`);
    assert.ok(data.results?.length > 0, `${query}: no results`);
    assert.ok(data.searchMeta?.matchScore >= 0.72, `${query}: unreliable match`);
    if (query === 'The Truman Show') {
        assert.ok(data.results.some(item => item.id === 37165 && item.mediaType === 'movie'));
        assert.equal(data.searchMeta.mediaType, null, 'literal Show must not impose a TV filter');
    }
    results.push({ check: `search:${query}`, status: 'passed', count: data.results.length });
}

for (const [id, type] of [[603, 'movie'], [1399, 'tv']]) {
    const { data } = await getApi(`/api/tmdb/detail?id=${id}&type=${type}`);
    assert.equal(data.id, id);
    assert.equal(data.mediaType, type);
    assert.ok(data.title && data.summary && data.genres?.length);
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

// These services are optional. Report their real availability without confusing
// an upstream outage with a failed release of the main TMDB functionality.
for (const path of ['/api/omdb?imdb=tt0133093', '/api/wiki/zh?q=流浪地球&type=movie&year=2019', '/api/resource?q=流浪地球']) {
    const response = await fetchLive(new URL(path, api));
    const data = await response.json();
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
        if (path.startsWith('/api/omdb')) assert.equal(data.imdbId, 'tt0133093');
        if (path.startsWith('/api/wiki')) assert.ok(typeof data.extract === 'string');
        if (path.startsWith('/api/resource')) assert.ok(Array.isArray(data.quarkUrls) && data.resourceMeta);
    } else {
        assert.ok([404, 429, 502, 503, 504].includes(response.status) && data.error);
    }
    results.push({ check: path, status: response.ok ? (data.partial ? 'partial' : 'available') : 'provider-unavailable', http: response.status });
}

console.log(JSON.stringify({ liveSmoke: 'passed', release, site, api, results }, null, 2));
