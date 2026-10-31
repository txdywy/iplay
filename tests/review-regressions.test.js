import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
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
    assert.equal(urls.length, 1);
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
