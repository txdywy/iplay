import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

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

test('unexpected upstream exceptions do not expose request URLs or credentials to API clients', async t => {
    const ctx = mockUpstreams(t, async url => { throw new Error(`Fetch failed for ${url}; Authorization: Bearer private-bearer; bbs_token=private-cookie`); });
    const response = await worker.fetch(request('/api/omdb?imdb=tt1234567'), { OMDB_API_KEY: 'private-omdb-key' }, ctx);
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
        '/api/douban/search?q=Review', '/api/douban/detail?id=42',
        '/api/omdb?title=Review', '/api/poster?title=Review',
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

test('provider error payloads cannot bypass safe public messages', async t => {
    const ctx = mockUpstreams(t, async url => String(url).includes('themoviedb.org')
        ? Response.json({ status_message: 'Failed: ?api_key=private-key; Bearer private-bearer' }, { status: 503 })
        : Response.json({ Response: 'False', Error: 'Request limit reached: ?apikey=private-omdb-key' }));
    for (const [path, status, message] of [
        ['/api/tmdb/detail?id=42&type=movie', 503, 'TMDB unavailable'],
        ['/api/omdb?imdb=tt1234567', 429, 'OMDb: Request limit reached!']
    ]) {
        const response = await worker.fetch(request(path), { TMDB_API_KEY: 'private-key', OMDB_API_KEY: 'private-omdb-key' }, ctx);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error: message });
    }
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
    let payload = { id: 99, title: 'Wrong title' };
    const ctx = mockUpstreams(t, async () => Response.json(payload));
    for (const invalid of [payload, { id: 42 }]) {
        payload = invalid;
        const response = await worker.fetch(request('/api/tmdb/detail?id=42&type=movie'), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 502);
        assert.equal(ctx.writes.length, 0);
    }
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
    const ctx = mockUpstreams(t, async () => Response.json({
        id: 42, name: 'Test series', episode_run_time: [0, 45],
        credits: { crew: [
            { name: 'Director', department: 'Directing', job: 'Director' },
            { name: 'Assistant', department: 'Directing', job: 'Assistant Director' }
        ] }
    }));
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
        if (url.pathname === '/3/tv/101') return Response.json({ id: 101, name: 'Shared Title', first_air_date: '2024-01-01', poster_path: null });
        return Response.json({ results: [{ id: 202, media_type: 'movie', title: 'Shared Title', release_date: '2024-01-01', poster_path: '/wrong-movie.jpg' }] });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&year=2024&id=101&type=tv'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('selected poster lookups preserve a known IMDb identity instead of title-search metadata', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/find/tt1111111') return Response.json({ movie_results: [], tv_results: [{ id: 101, name: 'Shared Title' }] });
        if (url.hostname === 'api.themoviedb.org') return Response.json({ id: 101, name: 'Shared Title', poster_path: null });
        const exact = url.searchParams.get('i') === 'tt1111111';
        return Response.json({ Response: 'True', Title: 'Shared Title', Year: '2024', Type: exact ? 'series' : 'movie',
            imdbID: exact ? 'tt1111111' : 'tt2222222', imdbRating: exact ? '8.8' : '2.0', Poster: 'https://example.org/poster.jpg' });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&year=2024&id=101&type=tv&imdb=tt1111111'), { TMDB_API_KEY: 'test', OMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.imdbId, 'tt1111111');
    assert.equal(data.imdb, 8.8);
    assert.equal(data.tmdbId, 101);
    assert.equal(data.mediaType, 'tv');
});

test('title-based OMDb poster metadata must map back to the selected TMDB identity', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/tv/101') return Response.json({ id: 101, name: 'Shared Title', poster_path: null });
        if (url.pathname === '/3/find/tt2222222') return Response.json({ movie_results: [{ id: 202, title: 'Shared Title' }], tv_results: [] });
        if (url.hostname === 'zh.wikipedia.org') return Response.json({ query: { search: [] } });
        return Response.json({ Response: 'True', Title: 'Shared Title', Year: '2024', Type: 'movie', imdbID: 'tt2222222', Poster: 'https://example.org/wrong.jpg' });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&year=2024&id=101&type=tv'), { TMDB_API_KEY: 'test', OMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('even an explicit IMDb ID cannot relabel a different TMDB work as the selection', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/tv/101') return Response.json({ id: 101, name: 'Shared Title', poster_path: null });
        if (url.pathname === '/3/find/tt2222222') return Response.json({ movie_results: [{ id: 202, title: 'Shared Title' }], tv_results: [] });
        return Response.json({ Response: 'True', Title: 'Shared Title', imdbID: 'tt2222222', Poster: 'https://example.org/wrong.jpg' });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&id=101&type=tv&imdb=tt2222222'), { TMDB_API_KEY: 'test', OMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('identity-verified title enrichment returns ratings even without an OMDb poster', async t => {
    const ctx = mockUpstreams(t, async input => {
        const url = new URL(input);
        if (url.pathname === '/3/tv/101') return Response.json({ id: 101, name: 'Shared Title', poster_path: null });
        if (url.pathname === '/3/find/tt1111111') return Response.json({ movie_results: [], tv_results: [{ id: 101, name: 'Shared Title' }] });
        return Response.json({ Response: 'True', Title: 'Shared Title', Year: '2024', Type: 'series', imdbID: 'tt1111111', imdbRating: '8.8', Poster: 'N/A' });
    });
    const response = await worker.fetch(request('/api/poster?title=Shared%20Title&id=101&type=tv'), { TMDB_API_KEY: 'test', OMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.tmdbId, 101);
    assert.equal(data.mediaType, 'tv');
    assert.equal(data.imdbId, 'tt1111111');
    assert.equal(data.imdb, 8.8);
    assert.equal(data.poster, null);
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

test('OMDb year fallback cannot attach a different remake to the requested year', async t => {
    const ctx = mockUpstreams(t, async url => new URL(url).searchParams.has('y')
        ? Response.json({ Response: 'False', Error: 'Movie not found!' })
        : Response.json({ Response: 'True', Title: 'Dune', Year: '1984', Poster: 'https://example.org/wrong.jpg' }));
    const response = await worker.fetch(request('/api/omdb?title=Dune&year=2021'), { OMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(ctx.writes.length, 0);
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
    assert.equal(response.headers.get('cache-control'), 'public, max-age=900');
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
        assert.equal(response.headers.get('cache-control'), 'public, max-age=900');
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

test('OMDb ID lookups reject a different identity and do not cache it', async t => {
    const ctx = mockUpstreams(t, async () => Response.json({
        Response: 'True', Title: 'Wrong Film', imdbID: 'tt7654321'
    }));
    const response = await worker.fetch(request('/api/omdb?imdb=tt1234567'), { OMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 502);
    assert.equal(ctx.writes.length, 0);
});

test('OMDb primary title lookup cannot attach a wrong-year remake', async t => {
    const ctx = mockUpstreams(t, async () => Response.json({
        Response: 'True', Title: 'Dune', Year: '1984', Poster: 'https://example.org/wrong.jpg'
    }));
    const response = await worker.fetch(request('/api/omdb?title=Dune&year=2021'), { OMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 404);
    assert.equal(ctx.writes.length, 0);
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
