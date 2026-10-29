import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/_worker.js';
import { tmdbDetail } from './fixtures/tmdb.js';

function mockUpstreams(t, handler) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches, warn: console.warn };
    const calls = [];
    globalThis.caches = { default: { match: async () => null, put: async () => undefined } };
    globalThis.fetch = async url => {
        const parsed = new URL(String(url));
        calls.push(parsed);
        return handler(parsed);
    };
    console.warn = () => {};
    t.after(() => {
        Object.assign(globalThis, { fetch: previous.fetch, caches: previous.caches });
        console.warn = previous.warn;
    });
    return calls;
}

async function search(query, ctx = { waitUntil() {} }) {
    const response = await worker.fetch(new Request(`https://worker.test/api/tmdb/search?q=${encodeURIComponent(query)}`, {
        headers: { 'cf-connecting-ip': `search-prefetch:${query}` }
    }), { TMDB_API_KEY: 'test-key' }, ctx);
    return { response, body: await response.json() };
}

const work = (id, title, extra = {}) => ({
    id, media_type: 'movie', title, original_title: title, release_date: '2020-01-01', vote_count: 10, ...extra
});
const paths = calls => calls.map(url => url.pathname);

test('a confident title answer embeds the detail the page opens next', async t => {
    const calls = mockUpstreams(t, url => url.pathname === '/3/movie/11'
        ? Response.json(tmdbDetail({ id: 11, title: 'Prefetch Movie' }))
        : Response.json({ results: [work(11, 'Prefetch Movie'), work(12, 'Another Film')] }));

    const { response, body } = await search('Prefetch Movie');

    assert.equal(response.status, 200);
    assert.equal(body.results[0].matchConfidence, 'high');
    assert.deepEqual(paths(calls), ['/3/search/multi', '/3/movie/11']);
    assert.equal(calls[1].searchParams.get('append_to_response'), 'external_ids,credits', 'the same upstream URL as /api/tmdb/detail');
    assert.deepEqual([body.prefetched.detail.id, body.prefetched.detail.type], [11, 'movie']);
    assert.equal(body.prefetched.detail.data.title, 'Prefetch Movie');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
});

test('titles the page asks the user to confirm are not prefetched', async t => {
    const calls = mockUpstreams(t, () => Response.json({ results: [
        work(21, 'Twin Title', { release_date: '2019-01-01' }),
        work(22, 'Twin Title', { release_date: '2021-01-01' })
    ] }));

    const { body } = await search('Twin Title');

    assert.equal(body.results.length, 2);
    assert.ok(body.results[0].matchScore - body.results[1].matchScore < 0.08);
    assert.equal(body.prefetched, undefined);
    assert.equal(calls.some(url => /^\/3\/(?:movie|tv)\//.test(url.pathname)), false);
});

test('a failed detail prefetch leaves the search answer intact', async t => {
    mockUpstreams(t, url => url.pathname === '/3/movie/31'
        ? Response.json({ status_message: 'temporary' }, { status: 500 })
        : Response.json({ results: [work(31, 'Fragile Detail')] }));

    const { response, body } = await search('Fragile Detail');

    assert.equal(response.status, 200);
    assert.deepEqual(body.results.map(item => item.id), [31]);
    assert.equal(body.prefetched, undefined);
});

test('a slow follow-up is not awaited but keeps running for the edge cache', async t => {
    let releaseDetail;
    const detailGate = new Promise(resolve => { releaseDetail = resolve; });
    mockUpstreams(t, async url => {
        if (url.pathname === '/3/movie/41') {
            await detailGate;
            return Response.json(tmdbDetail({ id: 41, title: 'Slow Detail' }));
        }
        return Response.json({ results: [work(41, 'Slow Detail')] });
    });
    const background = [];
    const started = Date.now();

    const { response, body } = await search('Slow Detail', { waitUntil: promise => background.push(promise) });

    assert.equal(response.status, 200);
    assert.equal(body.prefetched, undefined);
    assert.ok(Date.now() - started < 3000, 'the search answer waits at most the short prefetch budget');
    assert.ok(background.length > 0);
    releaseDetail();
    const settled = await Promise.all(background);
    assert.ok(settled.some(value => value?.detail?.data?.title === 'Slow Detail'), 'the lookup completes after the response');
});

test('weak or absent titles embed the person answer the page asks for next', async t => {
    const calls = mockUpstreams(t, url => {
        if (url.pathname === '/3/search/person') return Response.json({ results: [{ id: 51, name: 'Person Query', known_for_department: 'Acting' }] });
        if (url.pathname === '/3/person/51') return Response.json({ id: 51, name: 'Person Query', combined_credits: { cast: [work(52, 'Credit')] } });
        return Response.json({ results: [] });
    });

    const { body } = await search('Person Query');

    assert.deepEqual(body.results, []);
    assert.equal(body.prefetched.person.query, 'Person Query');
    assert.equal(body.prefetched.person.data.person.id, 51);
    assert.deepEqual(body.prefetched.person.data.credits.map(credit => credit.id), [52]);
    assert.equal(calls.filter(url => url.pathname === '/3/search/person').length, 1);
});

test('a degraded person answer is never embedded', async t => {
    mockUpstreams(t, url => {
        if (url.pathname === '/3/search/person') {
            return url.searchParams.get('language') === 'en-US'
                ? Response.json({ status_message: 'temporary' }, { status: 500 })
                : Response.json({ results: [{ id: 61, name: 'Someone Different', known_for_department: 'Acting' }] });
        }
        return Response.json({ results: [] });
    });

    const { body } = await search('Missing Person');

    assert.equal(body.prefetched, undefined, 'the page retries the person lookup itself');
});

test('an upstream that asks to stop gets no follow-up lookup', async t => {
    const calls = mockUpstreams(t, () => Response.json({ status_message: 'slow down' }, { status: 429 }));

    const { response } = await search('Rate Limited Title');

    assert.equal(response.status, 429);
    assert.deepEqual(paths(calls), ['/3/search/multi']);
});
