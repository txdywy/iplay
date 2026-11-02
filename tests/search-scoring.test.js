import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { PERFORMANCE_SEARCH_QUERY, searchPerformanceResults, searchPerformanceAlias } from './fixtures/search-performance.js';

function setup(t, upstream) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const calls = [];
    globalThis.fetch = async input => {
        const url = new URL(input);
        calls.push(url);
        return upstream(url, calls);
    };
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    t.after(() => Object.assign(globalThis, previous));
    return calls;
}

// Title-search budgets exclude the follow-up lookup a search answer embeds; it
// replaces the detail or person request the page would otherwise send.
const isTitleSearch = url => /^\/3\/(?:search\/(?:multi|movie|tv)|find\/)/.test(url.pathname);

async function search(query) {
    const response = await worker.fetch(new Request(`https://worker.test/api/tmdb/search?q=${encodeURIComponent(query)}`), {
        TMDB_API_KEY: 'test-only', API_RATE_LIMITER: { limit: async () => ({ success: true }) }
    }, { waitUntil() {} });
    assert.equal(response.status, 200);
    return response.json();
}

test('a later longer literal title re-scores earlier candidates against the current intent', async t => {
    let attempt = 0;
    setup(t, async () => Response.json({ results: ++attempt === 1
        ? [{ id: 1, media_type: 'tv', name: 'The Truman', first_air_date: '1997-01-01' }]
        : [{ id: 2, media_type: 'movie', title: 'The Truman Show', release_date: '1998-01-01' }]
    }));
    const data = await search('The Truman Show 1998');
    assert.equal(data.searchMeta.attempts, 2);
    assert.equal(data.searchMeta.normalizedQuery, 'The Truman Show');
    assert.equal(data.searchMeta.mediaType, null);
    assert.deepEqual(data.results.map(item => item.id), [2, 1]);
    assert.equal(data.results[0].matchScore, 1);
    assert.equal(data.results[1].matchMethod, 'title-contains', 'the earlier exact score belongs to the superseded shorter title');
    assert.equal(data.results[1].matchScore, 0.71, 'the explicit year still requires confirmation');
});

test('a Douban alias independently scores an already seen bilingual candidate', async t => {
    const calls = setup(t, async url => url.hostname === 'movie.douban.com'
        ? Response.json([{ title: '原始片名', sub_title: '别名电影' }])
        : Response.json({ results: [{ id: 7, media_type: 'movie', title: '别名电影', original_title: '别名电影' }] }));
    const data = await search('原始片名');
    assert.deepEqual(data.results.map(item => item.id), [7]);
    assert.equal(data.results[0].matchScore, 1);
    assert.equal(data.results[0].matchMethod, 'title-exact');
    assert.equal(data.searchMeta.strategy, 'douban-alias');
    assert.equal(data.searchMeta.attempts, 3);
    assert.equal(calls.filter(isTitleSearch).length, 3);
    assert.equal(calls.filter(url => url.hostname === 'movie.douban.com').length, 1);
});

test('repeated bilingual candidates preserve vote, popularity and first-source tie order', async t => {
    let attempt = 0;
    const items = [
        { id: 100, vote_count: 50, popularity: 5 },
        { id: 400, vote_count: 50, popularity: 5 },
        { id: 200, vote_count: 50, popularity: 50 },
        { id: 300, vote_count: 90, popularity: 1 }
    ].map(item => ({ ...item, media_type: 'movie', title: 'Equal Film', original_title: 'Equal Film', release_date: '2022-01-01' }));
    setup(t, async url => Response.json({ results: url.pathname.endsWith('/search/tv') ? [] : ++attempt === 1 ? items : [...items].reverse() }));
    const data = await search('Equal Film 2023');
    assert.ok(data.searchMeta.attempts > 1 && data.searchMeta.attempts <= 6);
    assert.deepEqual(data.results.map(item => item.id), [300, 200, 100, 400]);
    assert.ok(data.results.every(item => item.matchScore === 0.71));
});

test('a matching candidate beyond the text-score cache capacity is still evaluated', async t => {
    const target = 'Bounded Search Target';
    const results = Array.from({ length: 600 }, (_, index) => ({
        id: index + 1, media_type: 'movie', title: `Unrelated Work ${index}`, original_title: `Unrelated Original ${index}`
    }));
    results.push({ id: 900000, media_type: 'movie', title: target });
    const calls = setup(t, async () => Response.json({ results }));
    const data = await search(target);
    assert.deepEqual(data.results.map(item => item.id), [900000]);
    assert.equal(data.results[0].matchScore, 1);
    assert.equal(data.searchMeta.attempts, 1);
    assert.equal(calls.filter(isTitleSearch).length, 1);
});

test('six fallback searches with repeated title pairs keep the upstream request budget', async t => {
    let attempt = 0;
    const calls = setup(t, async url => url.hostname === 'movie.douban.com'
        ? Response.json(searchPerformanceAlias(url.searchParams.get('q')))
        : isTitleSearch(url) ? Response.json({ results: searchPerformanceResults(++attempt) }) : Response.json({ results: [] }));
    const data = await search(PERFORMANCE_SEARCH_QUERY);
    assert.equal(data.searchMeta.attempts, 6);
    assert.equal(attempt, 6);
    assert.equal(calls.filter(url => isTitleSearch(url) || url.hostname === 'movie.douban.com').length, 7, 'six TMDB requests and one Douban alias lookup');
    assert.ok(data.results.length > 0);
    assert.ok(data.results.every(item => item.matchScore < 0.72));
    assert.equal(data.searchMeta.year, '2023');
});

test('a possessive title is not read as a season marker', async t => {
    setup(t, async () => Response.json({ results: [
        { id: 402900, media_type: 'movie', title: "Ocean's 8", original_title: "Ocean's 8", release_date: '2018-06-07', vote_count: 9000 }
    ] }));
    const data = await search("Ocean's 8");
    assert.equal(data.searchMeta.season, null);
    assert.equal(data.searchMeta.mediaType, null);
    assert.deepEqual(data.results.map(item => item.id), [402900]);
});

test('a season marker attached to a Chinese title keeps the TV intent and cleans the query', async t => {
    setup(t, async url => Response.json({ results: url.searchParams.get('query') === '黑袍纠察队'
        ? [{ id: 76479, media_type: 'tv', name: '黑袍纠察队' }] : [] }));
    const data = await search('黑袍纠察队S04');
    assert.equal(data.searchMeta.season, 4);
    assert.equal(data.searchMeta.normalizedQuery, '黑袍纠察队');
    assert.equal(data.searchMeta.mediaType, 'tv');
    assert.deepEqual(data.results.map(item => item.id), [76479]);
});

test('an exact whole movie title overrides a season-like prefix', async t => {
    const title = 'S21: The Khmer Rouge Killing Machine';
    setup(t, async () => Response.json({ results: [{ id: 1, media_type: 'movie', title }] }));
    const data = await search(title);
    assert.equal(data.searchMeta.season, null);
    assert.equal(data.searchMeta.mediaType, null);
    assert.equal(data.searchMeta.normalizedQuery, title);
    assert.equal(data.searchMeta.attempts, 1);
    assert.deepEqual(data.results.map(item => item.id), [1]);
});

test('a base-title match still preserves an explicit season request', async t => {
    setup(t, async () => Response.json({ results: [{ id: 1668, media_type: 'tv', name: 'Friends' }] }));
    const data = await search('Friends S02');
    assert.equal(data.searchMeta.season, 2);
    assert.equal(data.searchMeta.mediaType, 'tv');
    assert.deepEqual(data.results.map(item => item.id), [1668]);
});
