import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { tmdbDetail } from './fixtures/tmdb.js';

function setup(t, upstream) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const calls = [];
    globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        calls.push(url);
        return upstream(url, options);
    };
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    t.after(() => Object.assign(globalThis, previous));
    return { calls, ctx: { waitUntil() {} } };
}

const request = path => new Request(`https://worker.test${path}`, {
    headers: { 'cf-connecting-ip': encodeURIComponent(path) }
});

test('year-qualified titles retain literal Show, TV and Chinese media words', async t => {
    let item;
    const { ctx } = setup(t, async url => Response.json({
        results: url.pathname.endsWith('/search/tv') ? [] : [item]
    }));
    for (const [title, year, type] of [
        ['The Truman Show', '1998', 'movie'], ['The TV Set', '2006', 'movie'], ['电影少女', '2018', 'tv']
    ]) {
        item = { id: 42, media_type: type, [type === 'tv' ? 'name' : 'title']: title,
            [type === 'tv' ? 'first_air_date' : 'release_date']: `${year}-01-01` };
        const response = await worker.fetch(request(`/api/tmdb/search?q=${encodeURIComponent(`${title} ${year}`)}`), { TMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.results[0]?.mediaType, type, title);
        assert.equal(data.results[0]?.id, 42, title);
        assert.equal(data.searchMeta.year, year, 'the explicit release year must remain in effect');
        assert.equal(data.searchMeta.mediaType, null, 'words belonging to a confirmed title are not type instructions');
    }
});

test('release labels do not turn a literal title into a different media type', async t => {
    const { ctx } = setup(t, async url => Response.json({ results: url.pathname.endsWith('/search/tv') ? [] : [{
        id: 42, media_type: 'movie', title: 'The Truman Show', release_date: '1998-01-01'
    }] }));
    for (const query of ['The Truman Show (1998) 1080p WEB-DL', 'The.Truman.Show.1998.1080p',
        'The Truman Show 1998 movie', 'movie The Truman Show 1998', 'The Truman Show film']) {
        const response = await worker.fetch(request(`/api/tmdb/search?q=${encodeURIComponent(query)}`), { TMDB_API_KEY: 'test' }, ctx);
        const data = await response.json();
        assert.equal(data.results[0]?.mediaType, 'movie', query);
        assert.equal(data.searchMeta.year, query.endsWith('film') ? null : '1998');
    }
});

test('literal title recognition preserves explicit wrong-year and separate type constraints', async t => {
    const { ctx } = setup(t, async url => Response.json({ results: url.pathname.endsWith('/search/tv') ? [] : [{
        id: 42, media_type: 'movie', title: 'The Truman Show', release_date: '1998-01-01'
    }] }));
    const wrongYear = await worker.fetch(request('/api/tmdb/search?q=The%20Truman%20Show%202005'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await wrongYear.json();
    assert.equal(data.results[0]?.id, 42);
    assert.equal(data.searchMeta.year, '2005');
    assert.ok(data.results[0].matchScore <= 0.71);
    assert.notEqual(data.results[0].matchConfidence, 'high');
    const typed = await worker.fetch(request('/api/tmdb/search?q=The%20Truman%20Show%201998%20TV'), { TMDB_API_KEY: 'test' }, ctx);
    assert.deepEqual((await typed.json()).results, [], 'a separate TV instruction must not be discarded');
});

test('the longest literal title wins over type-like words belonging to a shorter title', async t => {
    let reverse = false;
    const { ctx } = setup(t, async () => {
        const items = [
            { id: 43, media_type: 'movie', title: '少女', release_date: '2018-01-01' },
            { id: 42, media_type: 'tv', name: '电影少女', first_air_date: '2018-01-01' }
        ];
        return Response.json({ results: reverse ? items.reverse() : items });
    });
    for (reverse of [false, true]) {
        for (const query of ['电影少女2018', '电影少女2018电视剧']) {
            const response = await worker.fetch(request(`/api/tmdb/search?q=${encodeURIComponent(query)}`), { TMDB_API_KEY: 'test' }, ctx);
            const data = await response.json();
            assert.equal(data.results[0]?.id, 42, query);
            assert.equal(data.results[0]?.mediaType, 'tv');
            assert.equal(data.searchMeta.year, '2018');
        }
    }
});

test('explicit blank identity parameters fail before any fallback lookup', async t => {
    const { calls, ctx } = setup(t, async () => { throw new Error('An invalid identity must not fetch'); });
    for (const path of [
        '/api/tmdb/person?q=Selected%20Actor&id=', '/api/tmdb/person?q=Selected%20Actor&id=%20%20',
        '/api/tmdb/detail?id=42&type=', '/api/tmdb/detail?id=42&type=%20%20',
        '/api/omdb?imdb=&title=Different', '/api/omdb?i=&title=Different', '/api/omdb?imdb=&i=tt1234567'
    ]) {
        const response = await worker.fetch(request(path), { TMDB_API_KEY: 'test', OMDB_API_KEY: 'test' }, ctx);
        assert.equal(response.status, 400, path);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls.length, 0);
});

test('a later lossy variant cannot replace a confirmed longer title with a different work', async t => {
    const { ctx } = setup(t, async url => {
        if (url.hostname !== 'api.themoviedb.org') return Response.json([]);
        return Response.json({ results: url.searchParams.get('query') === '电影少女2018'
            ? [{ id: 42, media_type: 'tv', name: '电影少女', first_air_date: '2017-01-01' }]
            : [{ id: 43, media_type: 'movie', title: '少女', release_date: '2018-01-01' }]
        });
    });
    const response = await worker.fetch(request('/api/tmdb/search?q=电影少女2018'), { TMDB_API_KEY: 'test' }, ctx);
    const data = await response.json();
    assert.equal(data.results[0]?.id, 42);
    assert.ok(data.results[0].matchScore <= 0.71, 'the wrong-year work still requires confirmation');
    assert.equal(data.results.some(item => item.id === 43), false, 'a generic stripped title is not an alias');
});

test('omitting a type still supports legacy untyped detail links', async t => {
    const { calls, ctx } = setup(t, async url => url.pathname.includes('/movie/')
        ? Response.json({ status_message: 'Not found' }, { status: 404 })
        : Response.json(tmdbDetail({ id: 42, name: 'Legacy Series' })));
    const response = await worker.fetch(request('/api/tmdb/detail?id=42'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mediaType, 'tv');
    assert.deepEqual(calls.map(url => url.pathname), ['/3/movie/42', '/3/tv/42']);
});
