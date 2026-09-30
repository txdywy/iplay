import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';

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
        if (parsed.pathname === '/search.htm') return new Response('<html>No results</html>');
        return new Response('<title>Just a moment...</title>');
    });
    const response = await worker.fetch(request('/api/resource?q=Test'), {}, ctx);
    const data = await response.json();
    assert.equal(data.partial, true);
    assert.equal(data.resourceMeta.failedPages, 1);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=900');
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
