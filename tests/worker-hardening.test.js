import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import worker from '../worker/_worker.js';
import { rateLimitClientKey, toClientErrorStatus } from '../worker/core.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

function mock(t, fetcher) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const puts = [];
    globalThis.fetch = fetcher;
    globalThis.caches = { default: { match: async () => null, put: async (key, response) => { puts.push(response); } } };
    t.after(() => Object.assign(globalThis, previous));
    const writes = [];
    return { ctx: { waitUntil(promise) { writes.push(promise); } }, puts, flush: () => Promise.all(writes.splice(0)) };
}

let client = 0;
function request(path) {
    client += 1;
    return new Request(`https://worker.test${path}`, { headers: { 'cf-connecting-ip': `198.51.100.${client}` } });
}

test('IPv6 clients are rate limited per /64, IPv4 clients per address', () => {
    assert.equal(rateLimitClientKey('2001:db8:85a3:12:0:8a2e:370:7334'), '2001:db8:85a3:12::/64');
    assert.equal(rateLimitClientKey('2001:DB8:85A3:0012:ffff:1:2:3'), '2001:db8:85a3:12::/64');
    assert.equal(rateLimitClientKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(rateLimitClientKey('::1'), '0:0:0:0::/64');
    assert.equal(rateLimitClientKey('203.0.113.7'), '203.0.113.7');
    assert.equal(rateLimitClientKey(''), 'unknown');
    assert.equal(rateLimitClientKey(null), 'unknown');
});

test('provider throttles and failures reach the visitor as outages, not as their own limit', () => {
    assert.equal(toClientErrorStatus(429), 503);
    assert.equal(toClientErrorStatus(500), 502);
    assert.equal(toClientErrorStatus(520), 502);
    assert.equal(toClientErrorStatus(503), 503);
    assert.equal(toClientErrorStatus(504), 504);
    assert.equal(toClientErrorStatus(401), 502);
    assert.equal(toClientErrorStatus(404), 404);
});

test('a TMDB server error is a 502 with no provider detail', async t => {
    t.mock.method(console, 'error', () => {});
    const { ctx } = mock(t, async () => new Response('stack trace', { status: 500 }));
    const response = await worker.fetch(request('/api/tmdb/search?q=ServerError'), { TMDB_API_KEY: 'test' }, ctx);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('stack trace'));
});

test('an empty TMDB search is cached for an hour, a hit for a day', async t => {
    let results = [];
    const { ctx, puts, flush } = mock(t, async () => Response.json({ page: 1, results, total_pages: 1, total_results: results.length }));
    await worker.fetch(request('/api/tmdb/search?q=NotYetIndexed'), { TMDB_API_KEY: 'test' }, ctx);
    await flush();
    assert.ok(puts.length > 0);
    assert.ok(puts.every(response => response.headers.get('cache-control') === 'public, max-age=3600'));
    puts.length = 0;
    results = [{ id: 1, media_type: 'movie', title: 'Indexed', release_date: '2024-01-01' }];
    await worker.fetch(request('/api/tmdb/search?q=Indexed'), { TMDB_API_KEY: 'test' }, ctx);
    await flush();
    assert.ok(puts.some(response => response.headers.get('cache-control') === 'public, max-age=86400'));
});

test('a WPZY cache coordination outage is a 503, not a 500', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    const { ctx } = mock(t, async url => {
        const host = new URL(String(url)).hostname;
        if (host === 'by669.org') return Response.json({ data: [] });
        if (host === 'zuidouyin.com') return Response.json([]);
        return new Response(WPZY_EMPTY_SEARCH_HTML);
    });
    for (const failure of [
        { getByName: () => ({ fetch: async () => new Response('down', { status: 500 }) }) },
        { getByName: () => ({ fetch: async () => { throw new Error('Durable Object reset'); } }) }
    ]) {
        const response = await worker.fetch(request('/api/resource?q=协调故障'), {
            WPZY_COOKIE: 'bbs_token=fixture', WPZY_CACHE_SESSION: failure
        }, ctx);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('retry-after'), '60');
    }
});

test('an unterminated WPZY item attribute is parsed in linear time', async t => {
    const hostile = `<ul><li data-href="${'thread-1.htm'.repeat(1)}${'a'.repeat(400000)}`;
    mock(t, async url => {
        const host = new URL(String(url)).hostname;
        if (host === 'by669.org') return Response.json({ data: [] });
        if (host === 'zuidouyin.com') return Response.json([]);
        return new Response(hostile);
    });
    t.mock.method(console, 'warn', () => {});
    const started = performance.now();
    const response = await worker.fetch(request('/api/resource?q=线性'), {}, { waitUntil() {} });
    assert.equal(response.status, 200);
    assert.ok(performance.now() - started < 1500, 'the WPZY item pattern must not backtrack super-linearly');
});
