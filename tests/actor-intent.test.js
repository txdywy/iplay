import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/_worker.js';
import { tmdbDetail } from './fixtures/tmdb.js';

const BROWSER_CACHE = 'public, max-age=300';

function mockUpstreams(t, handler) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const calls = [];
    globalThis.caches = { default: { match: async () => null, put: async () => undefined } };
    globalThis.fetch = async url => {
        const parsed = new URL(String(url));
        calls.push(parsed);
        return handler(parsed);
    };
    t.after(() => Object.assign(globalThis, previous));
    return calls;
}

async function call(path, env = { TMDB_API_KEY: 'test-key' }) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, {
        headers: { 'cf-connecting-ip': `actor-intent:${path}` }
    }), env, { waitUntil() {} });
    return { response, body: await response.json() };
}

const actor = (id, name, extra = {}) => ({
    id, media_type: 'person', name, original_name: name, known_for_department: 'Acting', popularity: 10, ...extra
});
const work = (id, title, extra = {}) => ({
    id, media_type: 'movie', title, original_title: title, release_date: '2023-01-01', vote_count: 10, ...extra
});
const tmdbSearches = calls => calls.filter(url => url.hostname === 'api.themoviedb.org' && /^\/3\/search\/(?:multi|movie|tv)$/.test(url.pathname));

test('a Chinese actor name is marked as actor intent and skips title-only fallbacks', async t => {
    const calls = mockUpstreams(t, url => {
        if (url.hostname !== 'api.themoviedb.org') throw new Error(`unexpected upstream ${url.hostname}`);
        return Response.json({ results: [
            actor(31, '汤姆·汉克斯', { original_name: 'Tom Hanks' }),
            work(7, '汤姆·汉克斯讲二战', { media_type: 'tv', name: '汤姆·汉克斯讲二战', title: undefined, first_air_date: '2026-01-01' })
        ] });
    });

    const { response, body } = await call(`/api/tmdb/search?q=${encodeURIComponent('汤姆汉克斯')}`);

    assert.equal(response.status, 200);
    assert.deepEqual(body.searchMeta.exactPerson, { id: 31, name: '汤姆·汉克斯' });
    assert.equal(body.searchMeta.matchedBy, 'title-contains');
    assert.equal(body.searchMeta.attempts, 1, 'the documentary must not trigger en-US, typed or Douban alias fallbacks');
    assert.equal(tmdbSearches(calls).length, 1);
    assert.equal(calls.some(url => url.hostname === 'movie.douban.com'), false);
    assert.equal(response.headers.get('cache-control'), BROWSER_CACHE);
});

test('a Chinese actor without matching works answers after one title search and embeds the person', async t => {
    const calls = mockUpstreams(t, url => url.pathname === '/3/person/41'
        ? Response.json({ id: 41, name: '张译', combined_credits: { cast: [] } })
        : Response.json({ results: [actor(41, '张译')] }));

    const { body } = await call(`/api/tmdb/search?q=${encodeURIComponent('张译')}`);

    assert.deepEqual(body.results, []);
    assert.deepEqual(body.searchMeta.exactPerson, { id: 41, name: '张译' });
    assert.equal(body.searchMeta.attempts, 1);
    assert.deepEqual(calls.map(url => url.pathname), ['/3/search/multi', '/3/search/person', '/3/person/41'],
        'no en-US or Douban title requests come before the person lookup');
    assert.equal(body.prefetched.person.query, '张译');
    assert.equal(body.prefetched.person.data.person.id, 41);
});

test('Latin actor names keep the en-US title pass that can find an exact English title', async t => {
    const calls = mockUpstreams(t, url => {
        if (url.searchParams.get('language') === 'en-US') return Response.json({ results: [work(9, 'Ran', { original_title: '乱' })] });
        return Response.json({ results: [actor(51, '然', { original_name: 'Ran' })] });
    });

    const { body } = await call('/api/tmdb/search?q=Ran');

    assert.deepEqual(body.searchMeta.exactPerson, { id: 51, name: '然' });
    assert.equal(body.searchMeta.matchedBy, 'title-exact', 'the exact English title still outranks the actor');
    assert.deepEqual(body.results.map(item => item.id), [9]);
    assert.ok(tmdbSearches(calls).some(url => url.searchParams.get('language') === 'en-US'));
});

test('an exact title keeps title intent when it shares an actor name', async t => {
    mockUpstreams(t, () => Response.json({ results: [actor(61, '英雄'), work(62, '英雄', { release_date: '2002-12-19' })] }));

    const { body } = await call(`/api/tmdb/search?q=${encodeURIComponent('英雄')}`);

    assert.equal(body.searchMeta.matchedBy, 'title-exact');
    assert.deepEqual(body.results.map(item => item.id), [62]);
    assert.ok(body.searchMeta.exactPerson, 'clients decide; an exact title wins over the hint');
});

test('only acting credits and exact names produce actor intent', async t => {
    const calls = mockUpstreams(t, url => {
        if (url.hostname === 'movie.douban.com') return Response.json([]);
        return Response.json({ results: [
            actor(71, '张艺谋', { known_for_department: 'Directing' }),
            actor(72, '张艺谋的朋友')
        ] });
    });

    const { body } = await call(`/api/tmdb/search?q=${encodeURIComponent('张艺谋')}`);

    assert.equal(body.searchMeta.exactPerson, undefined);
    assert.ok(body.searchMeta.attempts > 1, 'non-actor queries keep the existing title fallbacks');
    assert.ok(calls.some(url => url.hostname === 'movie.douban.com'));
});

test('degraded title searches stay out of browser caches', async t => {
    let tmdbCalls = 0;
    mockUpstreams(t, url => {
        if (url.hostname === 'movie.douban.com') return Response.json([]);
        tmdbCalls += 1;
        if (tmdbCalls === 1) return Response.json({ results: [work(81, '无关作品')] });
        return Response.json({ status_message: 'temporary' }, { status: 500 });
    });

    const { response, body } = await call(`/api/tmdb/search?q=${encodeURIComponent('不存在的片名')}`);

    assert.equal(response.status, 200);
    assert.equal(body.searchMeta.confidence, 'low');
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('successful detail and person answers are briefly browser-cacheable; failures are not', async t => {
    let failPersonEnglish = false;
    mockUpstreams(t, url => {
        if (url.pathname === '/3/movie/42') return Response.json(tmdbDetail({ id: 42, title: 'Detail Movie' }));
        if (url.pathname === '/3/movie/43') return Response.json({ status_message: 'missing' }, { status: 404 });
        if (url.pathname === '/3/search/person') {
            if (url.searchParams.get('language') === 'en-US' && failPersonEnglish) {
                return Response.json({ status_message: 'temporary' }, { status: 500 });
            }
            const query = url.searchParams.get('query');
            // A weak zh-CN candidate keeps the response successful after en-US fails.
            return Response.json({ results: query === 'Known Actor' ? [actor(91, 'Known Actor')]
                : query === 'Nobody Else' ? [actor(92, 'Unrelated Performer')] : [] });
        }
        if (url.pathname === '/3/person/91') return Response.json({ id: 91, name: 'Known Actor', combined_credits: { cast: [] } });
        throw new Error(`unexpected ${url.pathname}`);
    });

    const detail = await call('/api/tmdb/detail?id=42&type=movie');
    assert.equal(detail.response.status, 200);
    assert.equal(detail.response.headers.get('cache-control'), BROWSER_CACHE);
    const missing = await call('/api/tmdb/detail?id=43&type=movie');
    assert.equal(missing.response.status, 404);
    assert.equal(missing.response.headers.get('cache-control'), 'no-store');

    const person = await call('/api/tmdb/person?q=Known%20Actor');
    assert.equal(person.body.person.id, 91);
    assert.equal(person.response.headers.get('cache-control'), BROWSER_CACHE);
    const selected = await call('/api/tmdb/person?q=Known%20Actor&id=91&offset=0&limit=36');
    assert.equal(selected.response.headers.get('cache-control'), BROWSER_CACHE);

    const none = await call('/api/tmdb/person?q=Nobody%20Here');
    assert.equal(none.body.person, null);
    assert.equal(none.response.headers.get('cache-control'), BROWSER_CACHE);
    failPersonEnglish = true;
    const degraded = await call('/api/tmdb/person?q=Nobody%20Else');
    assert.equal(degraded.body.person, null);
    assert.equal(degraded.response.headers.get('cache-control'), 'no-store');
});
