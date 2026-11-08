import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { mergeResourceState } from '../js/resources.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';
import { tmdbDetail } from './fixtures/tmdb.js';

function mockUpstreams(t, fetcher) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const writes = [];
    globalThis.fetch = fetcher;
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    t.after(() => Object.assign(globalThis, previous));
    return { waitUntil(promise) { writes.push(promise); }, writes };
}

function request(path) {
    return new Request(`https://worker.test${path}`, {
        headers: { 'cf-connecting-ip': encodeURIComponent(path) }
    });
}

test('TMDB non-JSON errors preserve stop statuses without retries or diagnostic leakage', async t => {
    t.mock.method(console, 'error', () => {});
    const calls = [];
    let status = 429;
    const ctx = mockUpstreams(t, async url => {
        calls.push(new URL(url).pathname);
        return new Response('Gateway failed: ?api_key=private-key', { status });
    });
    for (status of [401, 403, 429, 503, 504]) {
        calls.length = 0;
        const response = await worker.fetch(request(`/api/tmdb/search?q=Gateway${status}`), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(calls, ['/3/search/multi'], 'an upstream stop applies even when its body is not JSON');
        assert.ok(!(await response.text()).includes('private-key'));
    }
    assert.equal(ctx.writes.length, 0);
});

test('a non-JSON TMDB 404 preserves explicit identity and legacy type recovery', async t => {
    const calls = [];
    const ctx = mockUpstreams(t, async url => {
        const path = new URL(url).pathname;
        calls.push(path);
        return path === '/3/tv/42'
            ? Response.json(tmdbDetail({ id: 42, name: 'Recovered Series' }))
            : new Response('<h1>Not Found</h1>', { status: 404 });
    });
    const explicit = await worker.fetch(request('/api/tmdb/detail?id=42&type=movie'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(explicit.status, 404);
    assert.deepEqual(calls, ['/3/movie/42']);
    calls.length = 0;
    const legacy = await worker.fetch(request('/api/tmdb/detail?id=42'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).mediaType, 'tv');
    assert.deepEqual(calls, ['/3/movie/42', '/3/tv/42']);
});

test('TMDB details confirm requested seasons and reject absent or invalid seasons', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        assert.equal(url.pathname, '/3/tv/42');
        return Response.json(tmdbDetail({
            id: 42,
            name: 'Friends',
            number_of_seasons: 2,
            seasons: [
                { season_number: 1, episode_count: 24 },
                { season_number: 2, episode_count: 24 }
            ]
        }));
    });
    const existing = await worker.fetch(request('/api/tmdb/detail?id=42&type=tv&season=2'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(existing.status, 200);
    const absent = await worker.fetch(request('/api/tmdb/detail?id=42&type=tv&season=99'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(absent.status, 404);
    assert.match((await absent.json()).error, /第 99 季/);
    const invalid = await worker.fetch(request('/api/tmdb/detail?id=42&type=tv&season=100'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(invalid.status, 400);
});

test('TMDB redirects never forward bearer credentials or trust redirected payloads', async t => {
    const forwarded = [];
    let discarded = false;
    const ctx = mockUpstreams(t, async (_url, options) => {
        // Match the configured Workers runtime: automatic redirects forward
        // Authorization across origins unless the caller handles them manually.
        if (options.redirect !== 'manual') {
            forwarded.push(options.headers.Authorization);
            return Response.json(tmdbDetail({ id: 45, title: 'Untrusted Redirect' }));
        }
        return new Response(new globalThis.ReadableStream({
            cancel() { discarded = true; }
        }), { status: 302, headers: { Location: 'https://untrusted.example/credentials' } });
    });
    const response = await worker.fetch(request('/api/tmdb/detail?id=45&type=movie'), { TMDB_ACCESS_TOKEN: 'test-bearer' }, ctx);
    assert.equal(response.status, 502);
    assert.deepEqual(forwarded, []);
    assert.equal(discarded, true, 'discarding a redirect releases its unused body');
    assert.equal(ctx.writes.length, 0);
    assert.deepEqual(await response.json(), { error: 'TMDB unavailable' });
});

test('unexpected upstream exceptions do not expose request URLs or credentials to API clients', async t => {
    const ctx = mockUpstreams(t, async url => { throw new Error(`Fetch failed for ${url}; Authorization: Bearer private-bearer; bbs_token=private-cookie`); });
    const response = await worker.fetch(request('/api/poster?title=Review'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(data, { error: 'Upstream service unavailable' });
    assert.ok(!JSON.stringify(data).includes('private-'));
    assert.equal(ctx.writes.length, 0);
});

test('all API failure paths hide raw diagnostics while logs redact authentication fragments', async t => {
    const logs = [];
    t.mock.method(console, 'error', message => logs.push(String(message)));
    t.mock.method(console, 'warn', message => logs.push(String(message)));
    const ctx = mockUpstreams(t, async url => {
        const error = new Error(`Fetch failed for ${url}; Authorization: Bearer private-bearer; bbs_token=private-cookie; bbs_sid=private-sid; ?api_key=private-key&apikey=private-omdb-key`);
        error.status = 302; // An upstream exception must not turn an error into a successful/redirect response.
        throw error;
    });
    const env = { TMDB_API_KEY: 'private-key', OMDB_API_KEY: 'private-omdb-key', WPZY_COOKIE: 'bbs_token=private-cookie' };
    for (const path of [
        '/api/tmdb/search?q=Review', '/api/tmdb/search?q=tt1234567',
        '/api/tmdb/person?id=31&q=Review', '/api/tmdb/detail?id=42&type=movie',
        '/api/douban/search?q=Review', '/api/douban/detail?id=42', '/api/poster?title=Review',
        '/api/wiki/zh?q=Review', '/api/resource?q=Review'
    ]) {
        const response = await worker.fetch(request(path), env, ctx);
        const body = await response.text();
        assert.equal(response.status, 502, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
        assert.ok(!body.includes('private-') && !body.includes('Fetch failed') && !body.includes('https://'), path);
    }
    assert.ok(logs.length > 0);
    assert.ok(logs.every(log => !log.includes('private-')));
    assert.ok(logs.some(log => log.includes('[REDACTED]')));
    assert.equal(ctx.writes.length, 0);
});

test('the outer Worker failure boundary also hides raw exceptions', async t => {
    t.mock.method(console, 'error', () => {});
    const env = { get WPZY_COOKIE() { throw new Error('Secret lookup failed: bbs_token=private-cookie'); } };
    const response = await worker.fetch(request('/api/resource?q=Outer'), env, { waitUntil() {} });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
});

test('explicit media types never fall back to an unrelated same-id title', async t => {
    const paths = [];
    const ctx = mockUpstreams(t, async url => {
        paths.push(new URL(url).pathname);
        return Response.json({ status_message: 'Not found' }, { status: 404 });
    });
    const response = await worker.fetch(request('/api/tmdb/detail?id=42&type=tv'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.deepEqual(paths, ['/3/tv/42']);
});

test('TMDB details reject mismatched identities and title-less payloads', async t => {
    let payload = tmdbDetail({ id: 99, title: 'Wrong title' });
    const ctx = mockUpstreams(t, async () => Response.json(payload));
    for (const invalid of [payload, tmdbDetail({ id: 42 })]) {
        payload = invalid;
        const response = await worker.fetch(request('/api/tmdb/detail?id=42&type=movie'), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 502);
        assert.equal(ctx.writes.length, 0);
    }
});

test('long confirmed titles reach enrichment endpoints while TMDB search remains bounded', async t => {
    const title = 'Long Canonical '.repeat(9).trim();
    assert.ok([...title].length > 100 && [...title].length < 300);
    const calls = [];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        calls.push(`${url.hostname}${url.pathname}`);
        if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/movie/42') {
            return Response.json(tmdbDetail({
                id: 42, title, original_title: title, release_date: '2024-01-01',
                poster_path: '/confirmed-poster.jpg', vote_average: 8, vote_count: 1000
            }));
        }
        if (url.hostname === 'by669.org' && url.pathname === '/api/discussions') return Response.json({ data: [] });
        if (url.hostname === 'wpzy.org' && url.pathname === '/search.htm') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.hostname === 'movie.douban.com' && url.pathname === '/j/subject_suggest') return Response.json([]);
        if (url.hostname === 'zh.wikipedia.org' && url.pathname === '/w/api.php') return Response.json({ query: { search: [{ title }] } });
        if (url.hostname === 'zh.wikipedia.org' && url.pathname.startsWith('/api/rest_v1/page/summary/')) {
            return Response.json({ title, description: '2024 film', extract: `${title} is a 2024 film.` });
        }
        throw new Error(`Unexpected upstream: ${url.hostname}${url.pathname}`);
    });
    const env = { TMDB_API_KEY: 'test' };

    const detail = await worker.fetch(request('/api/tmdb/detail?id=42&type=movie'), env, ctx);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).title, title);

    for (const path of [
        `/api/resource?q=${encodeURIComponent(title)}`,
        `/api/douban/search?q=${encodeURIComponent(title)}`,
        `/api/wiki/zh?q=${encodeURIComponent(title)}&type=movie&year=2024`,
        `/api/poster?title=${encodeURIComponent(title)}&year=2024&id=42&type=movie`
    ]) {
        const response = await worker.fetch(request(path), env, ctx);
        assert.equal(response.status, 200, path);
    }

    const beforeRejectedSearch = calls.length;
    const search = await worker.fetch(request(`/api/tmdb/search?q=${encodeURIComponent(title)}`), env, ctx);
    assert.equal(search.status, 400, 'ordinary TMDB search retains the 100-character limit');
    assert.equal(calls.length, beforeRejectedSearch);
});

test('TMDB details reject the opposite media schema even when its numeric ID matches', async t => {
    let payload;
    const ctx = mockUpstreams(t, async () => Response.json(payload));
    for (const type of ['movie', 'tv']) {
        payload = tmdbDetail({ id: 42, [type === 'movie' ? 'name' : 'title']: 'Wrong media' });
        const response = await worker.fetch(request(`/api/tmdb/detail?id=42&type=${type}`), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 502);
    }
    assert.equal(ctx.writes.length, 0);
});

test('typed TMDB details use only their own title, original title and release date fields', async t => {
    const ctx = mockUpstreams(t, async () => Response.json(tmdbDetail({
        id: 42, title: 'Film', name: 'Series', original_title: 'Original Film', original_name: 'Original Series',
        release_date: '2001-01-01', first_air_date: '2020-01-01'
    })));
    const response = await worker.fetch(request('/api/tmdb/detail?id=42&type=tv'), { TMDB_API_KEY: 'test' }, ctx);
    const detail = await response.json();
    assert.equal(response.status, 200);
    assert.equal(detail.title, 'Series');
    assert.equal(detail.originalTitle, 'Original Series');
    assert.equal(detail.year, '2020');
});

test('TMDB search ranks and normalizes a TV result using TV identity fields', async t => {
    const item = { id: 42, media_type: 'tv', title: 'Wrong Film', name: 'Series',
        original_title: 'Wrong Original', original_name: 'Original Series',
        release_date: '2001-01-01', first_air_date: '2020-01-01', poster_path: '/series.jpg' };
    const ctx = mockUpstreams(t, async url => new URL(url).pathname.includes('/search/')
        ? Response.json({ results: [item] }) : Response.json(tmdbDetail(item)));
    const response = await worker.fetch(request('/api/tmdb/search?q=Series%202020'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.results[0].title, 'Series');
    assert.equal(data.results[0].originalTitle, 'Original Series');
    assert.equal(data.results[0].year, '2020');
    assert.ok(data.results[0].matchScore >= 0.72);
    const poster = await worker.fetch(request('/api/poster?title=Series&year=2020'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(poster.status, 200);
    assert.equal((await poster.json()).poster, 'https://image.tmdb.org/t/p/w500/series.jpg');
});

test('media details reject missing or malformed appended fields and allow genuinely empty credits', async t => {
    let payload;
    const ctx = mockUpstreams(t, async () => Response.json(payload));
    for (const type of ['movie', 'tv']) {
        const valid = { id: 42, [type === 'movie' ? 'title' : 'name']: 'Complete detail', external_ids: {}, credits: { cast: [], crew: [] } };
        const malformed = [
            { credits: undefined }, { credits: null }, { credits: [] }, { credits: {} },
            { credits: { cast: [], crew: null } }, { credits: { cast: {}, crew: [] } },
            { external_ids: undefined }, { external_ids: null }, { external_ids: [] }
        ];
        for (const fields of malformed) {
            payload = { ...valid, ...fields };
            const response = await worker.fetch(request(`/api/tmdb/detail?id=42&type=${type}`), { TMDB_API_KEY: 'test' }, ctx);
            assert.equal(response.status, 502, `${type}: ${JSON.stringify(fields)}`);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(ctx.writes.length, type === 'movie' ? 0 : 1, 'incomplete details must not be cached');
        }
        payload = valid;
        const response = await worker.fetch(request(`/api/tmdb/detail?id=42&type=${type}`), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).cast, []);
    }
    assert.equal(ctx.writes.length, 2);
});

test('cached incomplete media details are evicted and repaired with credits and external IDs', async t => {
    let upstreamCalls = 0;
    const deleted = [];
    const ctx = mockUpstreams(t, async () => {
        upstreamCalls += 1;
        return Response.json({ id: 42, title: 'Recovered Film', external_ids: { imdb_id: 'tt1234567' }, credits: {
            cast: [{ id: 31, name: 'Recovered Actor' }], crew: []
        } });
    });
    globalThis.caches.default.match = async () => Response.json({ id: 42, title: 'Recovered Film' });
    globalThis.caches.default.delete = async key => { deleted.push(key.url); return true; };
    const response = await worker.fetch(request('/api/tmdb/detail?id=42&type=movie'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.cast, ['Recovered Actor']);
    assert.equal(data.imdbId, 'tt1234567');
    assert.equal(upstreamCalls, 1);
    assert.equal(deleted.length, 1);
    assert.equal(ctx.writes.length, 1);
});

test('selected actors reject missing or malformed appended credits instead of caching empty filmographies', async t => {
    let payload;
    const ctx = mockUpstreams(t, async () => Response.json(payload));
    for (const combinedCredits of [undefined, null, [], { cast: null }, { cast: {} }]) {
        payload = { id: 31, name: 'Selected Actor', combined_credits: combinedCredits };
        const response = await worker.fetch(request('/api/tmdb/person?id=31&q=Selected%20Actor'), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 502);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(ctx.writes.length, 0);
    }

    payload = { id: 31, name: 'Selected Actor', combined_credits: { cast: [] } };
    const empty = await worker.fetch(request('/api/tmdb/person?id=31&q=Selected%20Actor'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).credits, []);
    assert.equal(ctx.writes.length, 1, 'a valid empty cast list remains cacheable');
});

test('cached actor payloads without appended credits are evicted and repaired from upstream', async t => {
    let upstreamCalls = 0;
    const deleted = [];
    const ctx = mockUpstreams(t, async () => {
        upstreamCalls += 1;
        return Response.json({ id: 31, name: 'Selected Actor', combined_credits: { cast: [
            { id: 42, media_type: 'tv', name: 'Recovered Series' }
        ] } });
    });
    globalThis.caches.default.match = async () => Response.json({ id: 31, name: 'Selected Actor' });
    globalThis.caches.default.delete = async key => { deleted.push(key.url); return true; };

    const response = await worker.fetch(request('/api/tmdb/person?id=31&q=Selected%20Actor'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).credits[0]?.title, 'Recovered Series');
    assert.equal(upstreamCalls, 1);
    assert.equal(deleted.length, 1);
    assert.equal(ctx.writes.length, 1);
});

test('TV runtime uses episode data and directors exclude assistant directors', async t => {
    const ctx = mockUpstreams(t, async () => Response.json(tmdbDetail({
        id: 42, name: 'Test series', episode_run_time: [0, 45],
        credits: { crew: [
            { name: 'Director', department: 'Directing', job: 'Director' },
            { name: 'Assistant', department: 'Directing', job: 'Assistant Director' }
        ] }
    })));
    const response = await worker.fetch(request('/api/tmdb/detail?id=42&type=tv'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(data.runtime, 45);
    assert.deepEqual(data.director, ['Director']);
});

test('poster search rejects a popular but unrelated title', async t => {
    const ctx = mockUpstreams(t, async () => Response.json({ results: [{
        id: 1, media_type: 'movie', title: 'Unrelated Blockbuster', poster_path: '/wrong.jpg', popularity: 1000
    }] }));
    const response = await worker.fetch(request('/api/poster?title=Obscure%20Film'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
});

test('selected poster identities never fall back to a same-title movie when the selected series has no image', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/tv/101') return Response.json(tmdbDetail({ id: 101, name: 'Shared Title', first_air_date: '2024-01-01', poster_path: null }));
        return Response.json({ results: [{ id: 202, media_type: 'movie', title: 'Shared Title', release_date: '2024-01-01', poster_path: '/wrong-movie.jpg' }] });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&year=2024&id=101&type=tv'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('poster searches reject an IMDb ID that conflicts with the selected TMDB identity', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/tv/101') return Response.json(tmdbDetail({
            id: 101,
            name: 'Shared Title',
            poster_path: '/series.jpg',
            external_ids: { imdb_id: 'tt1111111' }
        }));
        throw new Error(`Unexpected upstream URL ${url.pathname}`);
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&id=101&type=tv&imdb=tt2222222'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'No poster found' });
});

test('even an explicit IMDb ID cannot relabel a different TMDB work as the selection', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/tv/101') return Response.json(tmdbDetail({ id: 101, name: 'Shared Title', poster_path: null }));
        if (url.pathname === '/3/find/tt2222222') return Response.json({ movie_results: [{ id: 202, title: 'Shared Title' }], tv_results: [] });
        return Response.json({ Response: 'True', Title: 'Shared Title', imdbID: 'tt2222222', Poster: 'https://example.org/wrong.jpg' });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&id=101&type=tv&imdb=tt2222222'), { TMDB_API_KEY: 'test', OMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('poster identity parameters fail before upstream access when incomplete or invalid', async t => {
    let fetchCalls = 0;
    const ctx = mockUpstreams(t, async () => { fetchCalls += 1; return Response.json({}); });
    for (const params of ['id=101', 'type=tv', 'id=-1&type=tv', 'id=101&type=person', 'imdb=tt1111111', 'id=101&type=tv&imdb=bad']) {
        const response = await worker.fetch(request(`/api/poster?title=Test&${params}`), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 400, params);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(fetchCalls, 0);
});

test('HTTP 200 challenge detail pages are reported as incomplete resource scans', async t => {
    const ctx = mockUpstreams(t, async url => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/discussions') return Response.json({ data: [{ id: '1', attributes: { title: 'Test 夸克' } }] });
        if (parsed.pathname === '/search.htm') return new Response(WPZY_EMPTY_SEARCH_HTML);
        return new Response('<title>Just a moment...</title>');
    });
    const response = await worker.fetch(request('/api/resource?q=Test'), {}, ctx);
    const data = await response.json();
    assert.equal(data.partial, true);
    assert.equal(data.resourceMeta.failedPages, 1);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('HTTP 200 resource detail maintenance pages stay partial and recoverable for both providers', async t => {
    let provider = 'wpzy';
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/api/discussions') return Response.json({ data: provider === 'by669'
            ? [{ id: '42', attributes: { title: 'Review Movie 夸克' } }] : [] });
        if (url.pathname === '/search.htm') return new Response(provider === 'wpzy'
            ? '<li data-href="thread-100.htm"><a href="thread-100.htm">Review Movie 夸克</a></li>'
            : WPZY_EMPTY_SEARCH_HTML);
        return new Response('<title>网站维护</title><p>系统维护中，请稍后再试。</p>');
    });
    for (provider of ['wpzy', 'by669']) {
        const response = await worker.fetch(request('/api/resource?q=Review%20Movie&refresh=1'), {}, ctx);
        const data = await response.json();
        assert.equal(response.status, 200);
        assert.equal(data.partial, true, provider);
        assert.equal(data.resourceMeta.failedPages, 1, provider);
        assert.equal(data.resources.length + data.wpzysResources.length, 1, provider);
        assert.deepEqual(data.quarkUrls, []);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
});

test('resource searches scope release-year results and cached data to the selected TMDB identity', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.hostname === 'by669.org' && url.pathname === '/api/discussions') {
            const query = url.searchParams.get('filter[q]');
            assert.equal(query, 'Shared Work', 'the slow year-qualified search is filtered locally');
            return Response.json({ data: [1998, 2024].map(year => ({
                id: String(year), attributes: { title: `Shared Work ${year} 夸克` }
            })) });
        }
        if (url.hostname === 'wpzy.org' && url.pathname === '/search.htm') {
            assert.equal(url.searchParams.get('keyword'), 'Shared Work');
            return new Response([1998, 2024].map(year => `<li data-href="./thread-${year}.htm"><a href="./thread-${year}.htm">Shared Work ${year} 夸克</a></li>`).join(''));
        }
        if (url.hostname === 'zuidouyin.com') {
            assert.equal(url.searchParams.get('search'), 'Shared Work');
            return Response.json([1998, 2024].map(year => ({
                id: year, title: { rendered: '公用片名 夸克' },
                content: { protected: false, rendered: `<h4>Shared Work (${year})</h4><p>https://pan.quark.cn/s/index-${year}</p>` }
            })));
        }
        if (url.pathname === '/d/2024' || url.pathname === '/thread-2024.htm') {
            return new Response('https://pan.quark.cn/s/shared-2024');
        }
        throw new Error(`Unexpected upstream URL ${url}`);
    });
    const cache = new Map();
    globalThis.caches.default = {
        async match(request) { return cache.get(request.url)?.clone() || null; },
        async put(request, response) { cache.set(request.url, response.clone()); }
    };

    async function search(id) {
        const response = await worker.fetch(request(`/api/resource?q=Shared%20Work&id=${id}&type=movie&year=2024`), {}, ctx);
        return response.json();
    }

    const first = await search(42);
    await Promise.all(ctx.writes);
    const secondIdentity = await search(43);
    await Promise.all(ctx.writes);
    assert.deepEqual(first.resources.map(item => item.title), ['Shared Work 2024 夸克']);
    assert.deepEqual(first.wpzysResources.map(item => item.title), ['Shared Work 2024 夸克']);
    assert.deepEqual(first.zuidouyinResources.map(item => item.url), ['https://zuidouyin.com/?p=2024']);
    assert.deepEqual(secondIdentity.resources, first.resources);
    assert.equal(cache.size, 2, 'distinct selected TMDB IDs receive distinct cache entries');
});

test('a partial resource refresh preserves a previously complete Worker cache entry', async t => {
    let providerUnavailable = false;
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.hostname === 'zuidouyin.com') return Response.json([]);
        if (url.hostname === 'by669.org' && url.pathname === '/api/discussions') {
            if (providerUnavailable) return new Response('Unavailable', { status: 503 });
            return Response.json({ data: [{ id: '42', attributes: { title: 'Cached Work 夸克' } }] });
        }
        if (url.hostname === 'by669.org' && url.pathname === '/d/42') {
            return new Response('https://pan.quark.cn/s/cached-work');
        }
        if (url.hostname === 'wpzy.org' && url.pathname === '/search.htm') return new Response(WPZY_EMPTY_SEARCH_HTML);
        throw new Error(`Unexpected upstream URL ${url}`);
    });
    const cache = new Map();
    globalThis.caches.default = {
        async match(request) { return cache.get(request.url)?.clone() || null; },
        async put(request, response) { cache.set(request.url, response.clone()); }
    };

    async function search(refresh = false) {
        const suffix = refresh ? '&refresh=1' : '';
        const response = await worker.fetch(request(`/api/resource?q=Cached%20Work${suffix}`), {}, ctx);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response.json();
    }

    const complete = await search();
    await Promise.all(ctx.writes);
    providerUnavailable = true;
    const refreshed = await search(true);
    const subsequent = await search();
    assert.equal(complete.partial, false);
    assert.equal(refreshed.partial, true, 'refresh should report a partial scan so the UI can show its recovery state');
    assert.equal(subsequent.partial, false, 'the complete cached result remains available to later requests');
    assert.notDeepEqual(refreshed.quarkUrls, complete.quarkUrls, 'partial refresh results should describe the current scan');
    assert.deepEqual(subsequent.quarkUrls, complete.quarkUrls);
});

test('Douban streaming text chunks preserve full ratings, votes and genres', async t => {
    const originalRewriter = globalThis.HTMLRewriter;
    t.after(() => { globalThis.HTMLRewriter = originalRewriter; });
    globalThis.HTMLRewriter = class {
        handlers = new Map();
        on(selector, handler) { this.handlers.set(selector, handler); return this; }
        transform() {
            for (const [selector, chunks] of [
                ['strong[property="v:average"]', ['8.', '5']],
                ['span[property="v:votes"]', ['12', '345']],
                ['span[property="v:genre"]', ['喜', '剧']],
                ['span[property="v:summary"]', ['A summary ', 'with multiple chunks.']]
            ]) {
                const handler = this.handlers.get(selector);
                handler.element?.();
                chunks.forEach(text => handler.text({ text }));
            }
            return new Response('');
        }
    };
    const ctx = mockUpstreams(t, async () => new Response('<html>Valid detail</html>'));
    const response = await worker.fetch(request('/api/douban/detail?id=42'), {}, ctx);
    const data = await response.json();
    assert.equal(data.rating, 8.5);
    assert.equal(data.votes, 12345);
    assert.deepEqual(data.genres, ['喜剧']);
    assert.equal(data.summary, 'A summary with multiple chunks.');
});

test('a year attached directly to a title does not consume the final title character', async t => {
    const ctx = mockUpstreams(t, async url => {
        const query = new URL(url).searchParams.get('query');
        return Response.json({ results: query === '三体' ? [{
            id: 42, media_type: 'tv', name: '三体', first_air_date: '2023-01-01'
        }] : [] });
    });
    const response = await worker.fetch(request('/api/tmdb/search?q=三体2023'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(data.searchMeta.normalizedQuery, '三体');
    assert.equal(data.results[0]?.title, '三体');
});

test('a wrong-year exact title requires confirmation instead of automatic selection', async t => {
    const ctx = mockUpstreams(t, async () => Response.json({ results: [{
        id: 42, media_type: 'movie', title: 'Dune', release_date: '1984-12-01'
    }] }));
    const response = await worker.fetch(request('/api/tmdb/search?q=Dune%202021'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(data.results[0]?.title, 'Dune');
    assert.notEqual(data.results[0]?.matchConfidence, 'high');
    assert.ok(data.searchMeta.matchScore < 0.72);
});

test('literal film and series titles do not become inferred media-type instructions', async t => {
    const titles = [
        { id: 41, media_type: 'movie', title: 'The Truman Show' },
        { id: 42, media_type: 'movie', title: 'The TV Set' },
        { id: 43, media_type: 'tv', name: '电影少女' }
    ];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        return Response.json({ results: url.pathname === '/3/search/multi'
            ? titles.filter(item => (item.title || item.name) === url.searchParams.get('query'))
            : [] });
    });
    for (const item of titles) {
        const title = item.title || item.name;
        const response = await worker.fetch(request(`/api/tmdb/search?q=${encodeURIComponent(title)}`), { TMDB_API_KEY: 'test' }, ctx);
        const data = await response.json();
        assert.equal(response.status, 200);
        assert.equal(data.results[0]?.id, item.id, title);
        assert.equal(data.results[0]?.mediaType, item.media_type, title);
        assert.equal(data.results[0]?.matchConfidence, 'high', title);
        assert.equal(data.searchMeta.mediaType, null, title);
        assert.equal(data.searchMeta.normalizedQuery, title);
    }
});

test('unrelated Douban suggestions cannot become trusted TMDB aliases', async t => {
    const ctx = mockUpstreams(t, async url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'movie.douban.com') return Response.json([{ title: '无关电影', sub_title: 'Unrelated Movie' }]);
        return Response.json({ results: parsed.searchParams.get('query') === '无关电影' ? [{
            id: 42, media_type: 'movie', title: '无关电影'
        }] : [] });
    });
    const response = await worker.fetch(request('/api/tmdb/search?q=不存在的片名'), { TMDB_API_KEY: 'test' }, ctx);
    assert.deepEqual((await response.json()).results, []);
});

test('Wiki search never fetches an unrelated first result', async t => {
    const urls = [];
    const ctx = mockUpstreams(t, async url => {
        urls.push(url);
        return new URL(url).pathname.includes('/summary/')
            ? Response.json({ title: '无关页面', extract: 'Unrelated content.' })
            : Response.json({ query: { search: [{ title: '无关页面' }] } });
    });
    const response = await worker.fetch(request('/api/wiki/zh?q=不存在的片名'), {}, ctx);
    assert.equal(response.status, 404);
    const summaries = urls.filter(url => new URL(url).pathname.includes('/summary/'))
        .map(url => decodeURIComponent(new URL(url).pathname.split('/summary/')[1]));
    assert.deepEqual(summaries, [], 'standard names are resolved first and missing pages are never fetched');
    assert.equal(ctx.writes.length, 0);
});

test('Wiki skips mismatched candidate summaries and uses the next year-matching page', async t => {
    const summaries = [];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (!url.pathname.includes('/summary/')) {
            return Response.json({ query: { search: [
                { title: 'Shared Work (电影)' },
                { title: 'Shared Work (2020年电影)' }
            ] } });
        }

        const title = decodeURIComponent(url.pathname.split('/summary/')[1]);
        summaries.push(title);
        return Response.json({
            title,
            description: '电影',
            extract: title.includes('2020年') ? 'Shared Work是一部2020年电影。' : 'Shared Work是一部2010年电影。'
        });
    });

    const response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2020'), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).title, 'Shared Work (2020年电影)');
    assert.deepEqual(summaries, ['Shared Work (2020年电影)'], 'an explicit matching year should be tried first');
    assert.equal(ctx.writes.length, 1);
});

test('Wiki continues after a same-year candidate has contradictory identity evidence', async t => {
    const summaries = [];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (!url.pathname.includes('/summary/')) {
            return Response.json({ query: { search: [
                { title: 'Shared Work (2020年电影)' },
                { title: 'Shared Work（2020年电影）' }
            ] } });
        }

        const title = decodeURIComponent(url.pathname.split('/summary/')[1]);
        summaries.push(title);
        return Response.json({
            title,
            description: title.includes('（') ? '2020年电影' : '2010年电影',
            extract: title.includes('（') ? 'Shared Work是一部2020年电影。' : 'Shared Work是一部2010年电影。'
        });
    });

    const response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2020'), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).title, 'Shared Work（2020年电影）');
    assert.equal(summaries.length, 2);
    assert.equal(ctx.writes.length, 1, 'only the verified candidate should be cached');
});

test('Wiki skips missing pages but stops on upstream failures while checking candidates', async t => {
    let summaryCalls = 0;
    let firstStatus = 404;
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (!url.pathname.includes('/summary/')) {
            return Response.json({ query: { search: [
                { title: 'Shared Work (2020年电影)' },
                { title: 'Shared Work（2020年电影）' }
            ] } });
        }
        summaryCalls += 1;
        if (summaryCalls === 1) return new Response('deleted', { status: firstStatus });
        return Response.json({ title: 'Shared Work（2020年电影）', description: '2020年电影', extract: 'Shared Work是一部2020年电影。' });
    });

    const recovered = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2020'), {}, ctx);
    assert.equal(recovered.status, 200, 'a deleted first result should not hide a later match');
    assert.equal(summaryCalls, 2);

    summaryCalls = 0;
    firstStatus = 503;
    const unavailable = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2020'), {}, ctx);
    assert.equal(unavailable.status, 503);
    assert.equal(summaryCalls, 1, 'provider outages must not fan out to more pages');
    assert.equal(ctx.writes.length, 1);
});

test('Wiki disambiguation summaries are not presented as a movie synopsis', async t => {
    const ctx = mockUpstreams(t, async url => new URL(url).pathname.includes('/summary/')
        ? Response.json({ title: 'Dune', type: 'disambiguation', extract: 'Dune may refer to several works.' })
        : Response.json({ query: { search: [{ title: 'Dune' }] } }));
    const response = await worker.fetch(request('/api/wiki/zh?q=Dune'), {}, ctx);
    assert.equal(response.status, 404);
    assert.equal(ctx.writes.length, 0);
});

test('typed Wiki searches prefer the series page over its same-name novel', async t => {
    const ctx = mockUpstreams(t, async url => {
        const parsed = new URL(url);
        if (parsed.pathname.includes('/summary/')) {
            const title = decodeURIComponent(parsed.pathname.split('/summary/')[1]);
            return Response.json({ title, extract: title.includes('电视剧') ? '三体是一部电视剧。' : '三体是一部科幻小说。' });
        }
        return Response.json({ query: { search: [{ title: '三体' }, { title: '三体 (电视剧)' }] } });
    });
    const response = await worker.fetch(request('/api/wiki/zh?q=三体&type=tv&year=2023'), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).title, '三体 (电视剧)');
});

test('typed Wiki queries reject novel-only results instead of replacing the series overview', async t => {
    const ctx = mockUpstreams(t, async url => new URL(url).pathname.includes('/summary/')
        ? Response.json({ title: '三体', description: '科幻小说', extract: '三体是一部科幻小说。' })
        : Response.json({ query: { search: [{ title: '三体' }] } }));
    const response = await worker.fetch(request('/api/wiki/zh?q=三体&type=tv&year=2023'), {}, ctx);
    assert.equal(response.status, 404);
    assert.equal(ctx.writes.length, 0);
});

test('Wiki treats novel and comic words inside film titles as names instead of media types', async t => {
    let title = '';
    let summaryCalls = 0;
    const ctx = mockUpstreams(t, async input => {
        if (new URL(input).pathname.includes('/summary/')) {
            summaryCalls += 1;
            return Response.json({ title, description: '2024年电影', extract: `《${title}》是一部2024年上映的电影。` });
        }
        return Response.json({ query: { search: [{ title }] } });
    });
    for (title of ['小说家的电影', '漫画威龙', '电视之王']) {
        const response = await worker.fetch(request(`/api/wiki/zh?q=${encodeURIComponent(title)}&type=movie&year=2024`), {}, ctx);
        assert.equal(response.status, 200, title);
        assert.equal((await response.json()).title, title);
    }
    assert.equal(summaryCalls, 3);
});

test('Wiki classifies adaptations by their own medium and keeps explicit novel suffixes isolated', async t => {
    let title = 'Shared Work';
    let description = '2024年上映的漫画改编电影';
    let extract = '《Shared Work》是一部2024年电影，改编自同名小说。';
    const summaries = [];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname.includes('/summary/')) {
            summaries.push(decodeURIComponent(url.pathname.split('/summary/')[1]));
            return Response.json({ title, description, extract });
        }
        return Response.json({ query: { search: [{ title }] } });
    });
    for (description of ['2024年上映的漫画改编电影', 'film based on a novel', 'television film', '']) {
        const response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2024'), {}, ctx);
        assert.equal(response.status, 200, description);
    }
    title = 'Shared Work (novel)';
    description = 'novel adapted into a television series';
    extract = 'Shared Work is a novel adapted into a television series.';
    const response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=tv'), {}, ctx);
    assert.equal(response.status, 404);
    assert.equal(summaries.length, 4, 'explicit novel disambiguator must be rejected before summary fetch');
    title = 'Shared Work';
    description = '根据电视剧改编的小说';
    extract = '《Shared Work》是一部小说。';
    const novel = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=tv'), {}, ctx);
    assert.equal(novel.status, 404, 'the source television medium does not turn a novel into a series');
});

test('Wiki lead classification ignores the article title when no description is present', async t => {
    const title = '电视剧故事';
    const ctx = mockUpstreams(t, async input => new URL(input).pathname.includes('/summary/')
        ? Response.json({ title, extract: `${title}是一部2024年电影，讲述某部小说中的人物。故事讲述漫画家的经历。` })
        : Response.json({ query: { search: [{ title }] } }));
    const response = await worker.fetch(request(`/api/wiki/zh?q=${encodeURIComponent(title)}&type=movie&year=2024`), {}, ctx);
    assert.equal(response.status, 200);
});

test('Wiki rejects conflicting media types between the description and introduction', async t => {
    const ctx = mockUpstreams(t, async input => new URL(input).pathname.includes('/summary/')
        ? Response.json({
            title: 'Shared Work',
            description: '2024年电影',
            extract: '《Shared Work》是一部2024年电视剧。'
        })
        : Response.json({ query: { search: [{ title: 'Shared Work' }] } }));
    const response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2024'), {}, ctx);
    assert.equal(response.status, 404);
    assert.equal(ctx.writes.length, 0);
});

test('Wiki summaries cannot override an explicit non-media title suffix with a contradictory description', async t => {
    const ctx = mockUpstreams(t, async input => new URL(input).pathname.includes('/summary/')
        ? Response.json({ title: 'Shared Work (小说)', description: '2024年电影', extract: '《Shared Work》是一部2024年电影。' })
        : Response.json({ query: { search: [{ title: 'Shared Work' }] } }));
    const response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Work&type=movie&year=2024'), {}, ctx);
    assert.equal(response.status, 404);
    assert.equal(ctx.writes.length, 0);
});

test('Wiki distinguishes release-year evidence from numbers in titles and adapted source years', async t => {
    let summary = { title: '2001太空漫游', description: '1968年电影', extract: '《2001太空漫游》是一部1968年上映的电影。' };
    const ctx = mockUpstreams(t, async input => new URL(input).pathname.includes('/summary/')
        ? Response.json(summary)
        : Response.json({ query: { search: [{ title: summary.title }] } }));
    let response = await worker.fetch(request('/api/wiki/zh?q=2001太空漫游&type=movie&year=1968'), {}, ctx);
    assert.equal(response.status, 200, 'numbers that are part of a title are not release years');
    summary = { title: 'Shared Adaptation', description: '2024年电影', extract: '《Shared Adaptation》是一部电影，改编自1934年出版的同名小说。' };
    response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Adaptation&type=movie&year=2024'), {}, ctx);
    assert.equal(response.status, 200, 'a source novel year is not a contradictory film release year');
    summary = { title: 'Shared Adaptation (2005年电影)', description: '电影', extract: '《Shared Adaptation》是一部电影。' };
    response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Adaptation&type=movie&year=2024'), {}, ctx);
    assert.equal(response.status, 404, 'an explicit disambiguator year still rejects the wrong remake');
    summary = { title: 'Shared Adaptation', description: '电影', extract: '《Shared Adaptation》是一部电影，由某导演执导，于2005年上映。' };
    response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Adaptation&type=movie&year=2024'), {}, ctx);
    assert.equal(response.status, 404, 'release years in a later lead clause still reject the wrong remake');
    for (const evidence of ['根据2024年小说改编的2005年电影', '基于2024年小说改编的2005年电影', '改编自2024年小说的2005年电影', 'based on a 2024 novel and is a 2005 film']) {
        summary = { title: 'Shared Adaptation', description: evidence, extract: `《Shared Adaptation》是${evidence}。` };
        response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Adaptation&type=movie&year=2024'), {}, ctx);
        assert.equal(response.status, 404, evidence);
        response = await worker.fetch(request('/api/wiki/zh?q=Shared%20Adaptation&type=movie&year=2005'), {}, ctx);
        assert.equal(response.status, 200, evidence);
    }
});

test('resource page snapshots preserve independent password evidence and scan outcomes', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/api/discussions') return Response.json({ data: [
            { id: 'password-a', attributes: { title: 'Snapshot 夸克 A' } },
            { id: 'password-b', attributes: { title: 'Snapshot 夸克 B' } },
            { id: 'failed', attributes: { title: 'Snapshot 夸克 failed' } },
            { id: 'empty', attributes: { title: 'Snapshot 夸克 empty' } }
        ] });
        if (url.pathname === '/search.htm') return new Response('<li data-href="thread-123.htm"><a href="thread-123.htm">Snapshot 夸克</a></li>');
        if (url.pathname === '/d/password-a') return new Response('https://pan.quark.cn/s/shared?pwd=AAAA');
        if (url.pathname === '/d/password-b') return new Response('https://pan.quark.cn/s/shared?pwd=BBBB');
        if (url.pathname === '/d/failed') return new Response('Failure', { status: 503 });
        if (url.pathname === '/thread-123.htm') return new Response('回复后查看');
        if (url.pathname === '/d/empty') return new Response('No links in this post');
        throw new Error(`Unexpected input: ${url.pathname}`);
    });
    const response = await worker.fetch(request('/api/resource?q=Snapshot'), {}, ctx);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.partial, true);
    assert.equal(data.quarkUrls[0].password, undefined);
    assert.equal(data.quarkUrls[0].passwordConflict, true);
    const pages = new Map(data.resourceMeta.pages.map(page => [page.url, page]));
    const first = pages.get('https://by669.org/d/password-a');
    const second = pages.get('https://by669.org/d/password-b');
    assert.equal(first.status, 'ok');
    assert.equal(first.source, 'by669');
    assert.equal(first.quarkUrls[0].password, 'AAAA');
    assert.equal(first.quarkUrls[0].passwordRank, 2);
    assert.equal(second.quarkUrls[0].password, 'BBBB');
    assert.equal(second.quarkUrls[0].passwordRank, 2);
    assert.equal(pages.get('https://by669.org/d/failed').status, 'failed');
    assert.equal(pages.get('https://wpzy.org/thread-123.htm').status, 'restricted');
    assert.deepEqual(pages.get('https://by669.org/d/empty').quarkUrls, []);
});

test('resource metadata marks all unselected search pages as unattempted', async t => {
    let detailCalls = 0;
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.hostname === 'zuidouyin.com') return Response.json([]);
        if (url.pathname === '/api/discussions') return Response.json({ data: Array.from({ length: 15 }, (_, id) => ({
            id: `limited-${id}`, attributes: { title: `Limited 夸克 ${id}` }
        })) });
        if (url.pathname === '/search.htm') return new Response(WPZY_EMPTY_SEARCH_HTML);
        detailCalls += 1;
        return new Response('No links in this post');
    });
    const response = await worker.fetch(request('/api/resource?q=Limited'), {}, ctx);
    const data = await response.json();
    assert.equal(detailCalls, 12);
    assert.equal(data.resourceMeta.pages.length, 15);
    assert.equal(data.resourceMeta.pages.filter(page => page.status === 'ok').length, 12);
    assert.equal(data.resourceMeta.pages.filter(page => page.status === 'unattempted').length, 3);
    assert.ok(data.resourceMeta.pages.filter(page => page.status === 'unattempted').every(page => !('quarkUrls' in page)));
});

test('the public index returns attributed Quark evidence when neither forum has matches', async t => {
    const query = '樱兰高校男公关部';
    const title = `《${query}》（2006 年动画及真人版合集）[夸克网盘]`;
    const share = 'https://pan.quark.cn/s/public-index-anime';
    const sourceUrl = 'https://zuidouyin.com/?p=42';
    let indexRequests = 0;
    let indexAvailable = true;
    const ctx = mockUpstreams(t, async (input, options) => {
        const url = new URL(input);
        if (url.hostname === 'by669.org') return Response.json({ data: [] });
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        assert.equal(url.origin, 'https://zuidouyin.com');
        assert.equal(url.pathname, '/');
        assert.equal(url.searchParams.get('rest_route'), '/wp/v2/posts');
        assert.equal(url.searchParams.get('search'), query);
        assert.equal(url.searchParams.get('per_page'), '10');
        assert.equal(options.redirect, 'manual');
        assert.equal(new globalThis.Headers(options.headers).get('Cookie'), null);
        indexRequests++;
        if (!indexAvailable) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/redirect' } });
        return Response.json([
            { id: 42, link: 'https://untrusted.example/redirect', title: { rendered: title },
                content: { protected: false, rendered: `<p><a href="${share}?pwd=A1b2">合集</a></p>` } },
            { id: 43, title: { rendered: '其他作品 [夸克网盘]' },
                content: { protected: false, rendered: `<p>提到${query} https://pan.quark.cn/s/unrelated</p>` } },
            { id: 44, title: { rendered: title },
                content: { protected: true, rendered: '<p>https://pan.quark.cn/s/locked</p>' } }
        ]);
    });
    const env = { WPZY_COOKIE: 'bbs_token=fixture-cookie' };
    const url = `/api/resource?q=${encodeURIComponent(query)}&id=1043&type=tv&year=2006`;
    const response = await worker.fetch(request(url), env, ctx);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(indexRequests, 1, 'post content should arrive in the same request as search');
    assert.equal(data.partial, false);
    assert.deepEqual(data.resources, []);
    assert.deepEqual(data.wpzysResources, []);
    assert.deepEqual(data.zuidouyinResources, [{ title, url: sourceUrl, isQuark: true, source: 'zuidouyin' }]);
    const evidence = { url: share, title, password: 'A1b2', sourceUrl, sourceTitle: title };
    assert.deepEqual(data.quarkUrls, [evidence]);
    assert.deepEqual(data.resourceMeta.pages, [
        { url: sourceUrl, source: 'zuidouyin', status: 'ok', quarkUrls: [{ ...evidence, passwordRank: 2 }] }
    ]);
    indexAvailable = false;
    const degraded = await worker.fetch(request(`${url}&refresh=1`), env, ctx);
    assert.equal(degraded.status, 200);
    assert.equal(indexRequests, 2, 'the supplemental source is queried once per scan');
    const partial = await degraded.json();
    assert.deepEqual(partial.resourceMeta.providers, { by669: 'ok', wpzys: 'ok', zuidouyin: 'failed' });
    assert.equal(partial.partial, true);
    assert.deepEqual(partial.zuidouyinResources, []);
});

test('an index share within the Worker result cap stays visible after frontend deduplication', async t => {
    const share = 'https://pan.quark.cn/s/rare-index-share';
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.hostname === 'zuidouyin.com') return Response.json([
            { id: 42, title: { rendered: 'Crowded Title' }, content: { protected: false, rendered: share } }
        ]);
        if (url.pathname === '/api/discussions') return Response.json({
            data: Array.from({ length: 4 }, (_, id) => ({ id, attributes: { title: 'Crowded Title' } }))
        });
        const page = url.pathname.split('/').at(-1);
        return new Response(Array.from({ length: 25 }, (_, i) => `https://pan.quark.cn/s/page-${page}-${i}`).join('\n'));
    });
    const response = await worker.fetch(request('/api/resource?q=Crowded%20Title'), {}, ctx);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.quarkUrls.length, 100);
    const displayed = mergeResourceState(null, result).result.quarkUrls;
    assert.deepEqual(displayed.map(item => item.url), result.quarkUrls.map(item => item.url));
    assert.ok(displayed.some(item => item.url === share));
});

test('Wiki summaries reject a different remake year stated only in the introduction', async t => {
    let summary = { title: 'Shared Title', description: '电影', extract: 'Shared Title是一部2005年上映的电影。' };
    const ctx = mockUpstreams(t, async url => new URL(url).pathname.includes('/summary/')
        ? Response.json(summary)
        : Response.json({ query: { search: [{ title: summary.title }] } }));
    for (const title of ['Shared Title', 'Mr. Bean']) {
        for (const description of ['电影', '2024年电影']) {
            summary = { title, description, extract: `《${title}》是一部2005年上映的电影。` };
            const response = await worker.fetch(request(`/api/wiki/zh?q=${encodeURIComponent(title)}&type=movie&year=2024`), {}, ctx);
            assert.equal(response.status, 404);
            assert.equal(ctx.writes.length, 0);
        }
    }

    summary = { title: 'Shared Title', description: '电影', extract: 'Shared Title是一部2024年上映的电影。' };
    const matching = await worker.fetch(request('/api/wiki/zh?q=Shared%20Title&type=movie&year=2024'), {}, ctx);
    assert.equal(matching.status, 200);
    assert.equal((await matching.json()).extract, summary.extract);
    assert.equal(ctx.writes.length, 1);
});

test('separate Worker execution contexts never share credentials or request-scoped I/O', async t => {
    const ctx = mockUpstreams(t, async url => {
        const id = new URL(url).searchParams.get('api_key') === 'first-key' ? 41 : 42;
        await new Promise(resolve => globalThis.setTimeout(resolve, 10));
        return Response.json({ results: [{ id, title: 'Shared Title', media_type: 'movie' }] });
    });
    const responses = await Promise.all([
        worker.fetch(request('/api/tmdb/search?q=Shared%20Title'), { TMDB_API_KEY: 'first-key' }, ctx),
        worker.fetch(request('/api/tmdb/search?q=Shared%20Title'), { TMDB_API_KEY: 'second-key' }, { waitUntil() {} })
    ]);
    const data = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(data.map(item => item.results[0].id), [41, 42]);
});

function indexPost(id, title, rendered) {
    return { id, title: { rendered: title }, content: { protected: false, rendered } };
}

async function searchPublicIndex(t, posts, path, { by669 = [], onIndex = null } = {}) {
    const detailUrls = [];
    const ctx = mockUpstreams(t, async (input, options) => {
        const url = new URL(input);
        if (url.hostname === 'zuidouyin.com') {
            onIndex?.(url, options);
            return Response.json(posts);
        }
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.pathname === '/api/discussions') return Response.json({ data: by669 });
        detailUrls.push(url.href);
        return new Response(`夸克 https://pan.quark.cn/s/forum-${url.pathname.split('/').at(-1)}`);
    });
    const response = await worker.fetch(request(path), {}, ctx);
    assert.equal(response.status, 200);
    return { data: await response.json(), detailUrls };
}

test('a public index collection only contributes shares listed under the matched work heading', async t => {
    const { data } = await searchPublicIndex(t, [
        indexPost(1, '2024 国漫合集 夸克', [
            '<h2>斗破苍穹</h2><p>夸克 https://pan.quark.cn/s/doupo-main</p>',
            '<h3>特别篇</h3><p>https://pan.quark.cn/s/doupo-special</p>',
            '<h2>完美世界</h2><p>夸克 https://pan.quark.cn/s/perfect-world</p>'
        ].join('')),
        indexPost(2, '动画合集二', '<h3 class="wp-block-heading"><strong>斗破</strong>苍穹</h3><p>夸克 https://pan.quark.cn/s/doupo-nested</p><h3>其他</h3><p>https://pan.quark.cn/s/other</p>'),
        indexPost(3, '无关合集', '<h2>其他作品</h2><p>斗破苍穹 夸克 https://pan.quark.cn/s/body-mention</p>')
    ], `/api/resource?q=${encodeURIComponent('斗破苍穹')}`);
    assert.deepEqual(data.zuidouyinResources.map(item => item.url), ['https://zuidouyin.com/?p=1', 'https://zuidouyin.com/?p=2']);
    assert.deepEqual(data.quarkUrls.map(item => item.url), [
        'https://pan.quark.cn/s/doupo-main',
        'https://pan.quark.cn/s/doupo-special',
        'https://pan.quark.cn/s/doupo-nested'
    ]);
});

test('public index work headings accept a year from the post title or their own section only', async t => {
    const { data } = await searchPublicIndex(t, [
        indexPost(1, '2018 动画合集', '<h2>斗破苍穹</h2><p>夸克 https://pan.quark.cn/s/title-year</p>'),
        indexPost(2, '动画合集', '<h2>斗破苍穹</h2><p>2018年首播 夸克 https://pan.quark.cn/s/section-year</p><h2>其他</h2><p>2018</p>'),
        indexPost(3, '动画合集三', '<h2>斗破苍穹</h2><p>2016年首播 夸克 https://pan.quark.cn/s/wrong-year</p><h2>其他 2018</h2>'),
        indexPost(4, '动画合集四', '<h2>斗破苍穹</h2><p>夸克 https://pan.quark.cn/s/x2018y</p>')
    ], `/api/resource?q=${encodeURIComponent('斗破苍穹')}&id=1&type=movie&year=2018`);
    assert.deepEqual(data.quarkUrls.map(item => item.url), [
        'https://pan.quark.cn/s/title-year',
        'https://pan.quark.cn/s/section-year'
    ]);
});

test('prefetched public index posts do not consume forum detail-page slots', async t => {
    let indexHeaders = null;
    const by669 = Array.from({ length: 14 }, (_, id) => ({ id: `slot-${id}`, attributes: { title: `Slot Title 夸克 ${id}` } }));
    const posts = Array.from({ length: 4 }, (_, index) =>
        indexPost(index + 1, `Slot Title 夸克 ${index}`, `https://pan.quark.cn/s/index-${index}`));
    const { data, detailUrls } = await searchPublicIndex(t, posts, '/api/resource?q=Slot%20Title', {
        by669, onIndex: (_url, options) => { indexHeaders = new globalThis.Headers(options.headers); }
    });
    assert.equal(detailUrls.length, 12);
    assert.match(indexHeaders.get('User-Agent'), /Mozilla\/5\.0/);
    assert.equal(data.resourceMeta.attemptedPages, 16);
    assert.equal(data.resourceMeta.pages.filter(page => page.status === 'ok').length, 16);
    assert.equal(data.resourceMeta.pages.filter(page => page.status === 'unattempted').length, 2);
    assert.equal(data.partial, false);
    for (let index = 0; index < 4; index++) {
        assert.ok(data.quarkUrls.some(item => item.url === `https://pan.quark.cn/s/index-${index}`));
    }
});

const KUANGBIAO_BY669_TITLES = [
    '《狂飙》2023 全39集 4K 张译、张颂文、李一桐主演狂飙电视剧',
    '狂飙2023 张颂文/李一桐主演电视剧 狂飙夸克,百度,迅雷网盘观看下载,',
    '【国剧/犯罪/悬疑】狂飙（2023）4K 高码率 国语中字 全39集 已完结 79G',
    '电视剧【狂飙】4K 已完结 (2023) 国语 [单集2.2G]',
    '《公路狂飙》1999 日本喜剧电影，安藤政信、石田光主演，豆瓣7.6分',
    '《F1：狂飙飞车》2025 布拉德·皮特主演运动剧情电影，豆瓣高分',
    '【美影 动作 冒险】GT赛车：极速狂飙（2023）4k 中文字幕',
    '狂飙之路 2023 夸克'
];

async function searchResourceProviders(t, path, { by669 = [], wpzy = [], index = [] } = {}) {
    const searches = {};
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/api/discussions') {
            searches.by669 = url.searchParams.get('filter[q]');
            return Response.json({ data: by669.map((title, id) => ({ id: `t${id}`, attributes: { title } })) });
        }
        if (url.pathname === '/search.htm') {
            searches.wpzy = url.searchParams.get('keyword');
            return new Response(wpzy.map((title, id) => `<li data-href="thread-${id + 1}.htm"><a href="thread-${id + 1}.htm">${title}</a> 夸克</li>`).join('') || WPZY_EMPTY_SEARCH_HTML);
        }
        if (url.hostname === 'zuidouyin.com') {
            searches.index = url.searchParams.get('search');
            return Response.json(index);
        }
        return new Response(`夸克 https://pan.quark.cn/s/${url.pathname.replace(/\W/g, '')}`);
    });
    const response = await worker.fetch(request(path), {}, ctx);
    assert.equal(response.status, 200);
    return { data: await response.json(), searches };
}

test('resource providers keep only titles that name the selected work at a title boundary', async t => {
    const { data, searches } = await searchResourceProviders(t, `/api/resource?q=${encodeURIComponent('狂飙')}&id=215803&type=tv&year=2023`, {
        by669: KUANGBIAO_BY669_TITLES,
        wpzy: [
            '[4K][极速：伪装者 2026][女赛车技师假订婚上位！赛道<span class="keyword"> 狂飙 </span>荷尔蒙]',
            '首发《猫鼬/<span class="keyword"> 狂飙 </span>营救》[美国 动作 惊悚][2026]',
            '【国产剧】<span class="keyword">狂飙</span>（2023）全39集 4K'
        ],
        index: [
            indexPost(1, '[美国电影]《GT赛车：极速狂飙》（2023年）[夸克网盘]', 'https://pan.quark.cn/s/gt'),
            indexPost(2, '[国产剧]《狂飙》（2023年）[夸克网盘]', 'https://pan.quark.cn/s/kb'),
            indexPost(3, '[越南电影]《二凤》+《怒斩狂飙》（2019-2023年）[夸克网盘]', 'https://pan.quark.cn/s/vn')
        ]
    });
    assert.deepEqual(searches, { by669: '狂飙', wpzy: '狂飙', index: '狂飙' }, 'providers search by title, not title plus year');
    assert.deepEqual(data.resources.map(item => item.title), KUANGBIAO_BY669_TITLES.slice(0, 4));
    assert.deepEqual(data.wpzysResources.map(item => item.title), ['【国产剧】狂飙（2023）全39集 4K']);
    assert.deepEqual(data.zuidouyinResources.map(item => item.url), ['https://zuidouyin.com/?p=2']);
    assert.ok(!data.quarkUrls.some(item => /gt|vn/.test(item.url)));
});

test('resource years accept covered ranges for movies and later seasons for series', async t => {
    const movie = await searchResourceProviders(t, `/api/resource?q=${encodeURIComponent('流浪地球')}&id=535167&type=movie&year=2019`, {
        by669: [
            '《流浪地球》系列1-2两部 4K HDR 国语中字（2019-2023）',
            '流浪地球 (2019) 1080P 国语中字',
            '流浪地球2 (2023) 4K',
            '流浪地球 4K 典藏版',
            '流浪地球 (2023) 4K'
        ]
    });
    assert.deepEqual(movie.data.resources.map(item => item.title), [
        '《流浪地球》系列1-2两部 4K HDR 国语中字（2019-2023）',
        '流浪地球 (2019) 1080P 国语中字'
    ]);
    const series = await searchResourceProviders(t, `/api/resource?q=${encodeURIComponent('斗破苍穹')}&id=69567&type=tv&year=2017`, {
        by669: [
            '斗破苍穹 年番4 (2025)【附系列】又名: 斗破苍穹 第八季',
            '【国漫】斗破苍穹年番3 附1-4季+特别篇',
            '国漫 斗破苍穹 年番更至146 4k画质',
            '斗破苍穹 (2012) 旧版',
            '斗破苍穹4：逃亡（2025）4K 高码 夸克网盘资源',
            '斗破苍穹之少年归来 (2023) 1080P'
        ]
    });
    assert.deepEqual(series.data.resources.map(item => item.title), [
        '斗破苍穹 年番4 (2025)【附系列】又名: 斗破苍穹 第八季',
        '【国漫】斗破苍穹年番3 附1-4季+特别篇',
        '国漫 斗破苍穹 年番更至146 4k画质'
    ]);
});

test('Wiki resolves standard article names across script variants when search ranking omits them', async t => {
    const summaries = [];
    let lookup = null;
    const ctx = mockUpstreams(t, async (input, options) => {
        const url = new URL(input);
        assert.match(new globalThis.Headers(options?.headers).get('User-Agent'), /^iPlay\/\S+ \(https:\/\/iplay\.hackx64\.eu\.org/);
        assert.equal(new globalThis.Headers(options?.headers).get('Accept-Language'), 'zh-CN');
        if (url.searchParams.get('list') === 'search') {
            return Response.json({ query: { search: [{ title: '狂飆' }, { title: '狂飙突进运动' }] } });
        }
        if (url.searchParams.has('titles')) {
            lookup = url.searchParams;
            return Response.json({ query: {
                converted: [{ from: '狂飙 (电视剧)', to: '狂飆 (電視劇)' }],
                pages: [{ title: '狂飙 (2023年电视剧)', missing: true }, { title: '狂飆 (電視劇)', pageid: 1 }]
            } });
        }
        const title = decodeURIComponent(url.pathname.split('/summary/')[1]);
        summaries.push(title);
        return Response.json({ title, description: '2023年中国大陆电视剧', extract: '《狂飙》是一部2023年播出的中国大陆电视剧。' });
    });
    const response = await worker.fetch(request(`/api/wiki/zh?q=${encodeURIComponent('狂飙')}&type=tv&year=2023`), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).title, '狂飆 (電視劇)');
    assert.equal(lookup.get('converttitles'), '1');
    assert.equal(lookup.get('redirects'), '1');
    assert.deepEqual(lookup.get('titles').split('|'), ['狂飙 (2023年电视剧)', '狂飙 (电视剧)', '狂飙 (动画)']);
    assert.deepEqual(summaries, ['狂飆 (電視劇)'], 'only existing pages are summarized');
});

test('Wiki accepts the adjacent year only for a series premiering near the year boundary', async t => {
    let summary = { title: '繁花 (电视剧)', description: '2024年中国大陆电视剧' };
    let firstAirDate = '2023-12-27';
    const tmdbIds = [];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.hostname === 'api.themoviedb.org') {
            tmdbIds.push(url.pathname);
            return Response.json({ id: 1, name: 'Series', first_air_date: firstAirDate, external_ids: {}, credits: { cast: [], crew: [] } });
        }
        return url.pathname.includes('/summary/')
            ? Response.json({ ...summary, extract: `《${summary.title.split(' ')[0]}》是一部中国大陆电视剧。` })
            : Response.json({ query: { search: [{ title: summary.title }] } });
    });
    const env = { TMDB_API_KEY: 'test-key' };
    const wiki = path => worker.fetch(request(path), env, ctx);
    const fanhua = `/api/wiki/zh?q=${encodeURIComponent('繁花')}&type=tv&year=2023`;
    assert.equal((await wiki(`${fanhua}&id=1`)).status, 200, 'a December premiere may be listed the next year');
    assert.equal((await wiki(fanhua)).status, 404, 'without the premiere date the year stays exact');
    assert.deepEqual(tmdbIds, ['/3/tv/1']);

    // 斗破苍穹: the January 2017 animation is not the 2018 live-action series.
    summary = { title: '斗破苍穹 (电视剧)', description: '2018年中国大陆电视剧' };
    firstAirDate = '2017-01-07';
    const doupo = await wiki(`/api/wiki/zh?q=${encodeURIComponent('斗破苍穹')}&type=tv&year=2017&id=2`);
    assert.equal(doupo.status, 404);
});

test('resource titles match TMDB aliases, separator variants and adjacent movie years', async t => {
    const tmdbPaths = [];
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.hostname === 'api.themoviedb.org') {
            tmdbPaths.push(url.pathname);
            if (url.pathname === '/3/movie/1022789/alternative_titles') return Response.json({ id: 1022789, titles: [
                { iso_3166_1: 'CN', title: '哪吒2' },
                { iso_3166_1: 'TW', title: '哪吒之魔童鬧海' },
                { iso_3166_1: 'US', title: 'Ne Zha 2' },
                { iso_3166_1: 'RU', title: 'Нэчжа 2' },
                { iso_3166_1: 'US', title: 'NZ' }
            ] });
            return Response.json({ id: 1022789, title: '哪吒之魔童闹海', original_title: '哪吒之魔童闹海', external_ids: {}, credits: { cast: [], crew: [] } });
        }
        if (url.pathname === '/api/discussions') return Response.json({ data: [
            '哪吒2 (2025) 4K 国语中字',
            '哪吒之魔童鬧海 (2025) 繁中',
            'Ne.Zha.2.2025.2160p 夸克',
            '哪吒之魔童闹海 2026 流媒体版',
            '哪吒之魔童降世 (2019)',
            'NZ 2025 夸克'
        ].map((title, id) => ({ id: `n${id}`, attributes: { title } })) });
        if (url.pathname === '/search.htm') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.hostname === 'zuidouyin.com') return Response.json([]);
        return new Response('夸克');
    });
    const path = `/api/resource?q=${encodeURIComponent('哪吒之魔童闹海')}&id=1022789&type=movie&year=2025`;
    const response = await worker.fetch(request(path), { TMDB_API_KEY: 'test-key' }, ctx);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.resources.map(item => item.title), [
        '哪吒2 (2025) 4K 国语中字',
        '哪吒之魔童鬧海 (2025) 繁中',
        'Ne.Zha.2.2025.2160p 夸克',
        '哪吒之魔童闹海 2026 流媒体版'
    ]);
    assert.ok(tmdbPaths.includes('/3/movie/1022789/alternative_titles'));
});

test('the scheduled refresh does nothing unless titles are configured', async t => {
    let upstreamCalls = 0;
    mockUpstreams(t, async () => { upstreamCalls += 1; return Response.json({ results: [] }); });
    const pending = [];
    await worker.scheduled({ scheduledTime: Date.now() }, { TMDB_API_KEY: 'test-key' }, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    assert.equal(upstreamCalls, 0);
});

test('forum reposts with identical titles only use detail slots after distinct titles', async t => {
    const titles = Array.from({ length: 14 }, (_, index) => index < 8 ? 'Repost Title (2024) 夸克' : `Repost Title (2024) 版本${index}`);
    const { data, detailUrls } = await searchPublicIndex(t, [], '/api/resource?q=Repost%20Title', {
        by669: titles.map((title, id) => ({ id: `r${id}`, attributes: { title } }))
    });
    assert.equal(detailUrls.length, 12);
    const scanned = new Set(data.resourceMeta.pages.filter(page => page.status === 'ok').map(page => page.url));
    for (let index = 8; index < 14; index++) assert.ok(scanned.has(`https://by669.org/d/r${index}`), `distinct title ${index} is scanned`);
});
