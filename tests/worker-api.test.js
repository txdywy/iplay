import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/_worker.js';

function muteConsole(t, method) {
    const original = console[method];
    console[method] = () => {};
    t.after(() => { console[method] = original; });
}

test('local development origins can read Worker responses', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/not-found', {
            headers: {
                Origin: 'http://localhost:8080',
                'cf-connecting-ip': 'test-cors-local'
            }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    assert.match(response.headers.get('vary') || '', /\bOrigin\b/i);
});

test('unapproved origins do not receive a CORS allow header', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/not-found', {
            headers: {
                Origin: 'https://malicious.example',
                'cf-connecting-ip': 'test-cors-denied'
            }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('self-hosted frontends can be added through CORS_ALLOWED_ORIGINS', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/not-found', {
            headers: {
                Origin: 'https://fork.example',
                'cf-connecting-ip': 'test-cors-configured'
            }
        }),
        { CORS_ALLOWED_ORIGINS: 'https://fork.example, https://preview.example' },
        { waitUntil() {} }
    );

    assert.equal(response.headers.get('access-control-allow-origin'), 'https://fork.example');
});

test('API routes reject methods other than GET and OPTIONS', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=test', {
            method: 'POST',
            headers: { 'cf-connecting-ip': 'test-method' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
    assert.equal(response.headers.get('content-type'), 'application/json;charset=UTF-8');
    assert.deepEqual(await response.json(), { error: 'Method Not Allowed' });
});

test('unknown routes return a JSON error response', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/unknown', {
            headers: { 'cf-connecting-ip': 'test-not-found' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json;charset=UTF-8');
    assert.deepEqual(await response.json(), { error: 'Not Found' });
});

test('API routes enforce the documented per-IP request limit', async () => {
    let response;
    for (let requestNumber = 1; requestNumber <= 61; requestNumber += 1) {
        response = await worker.fetch(
            new Request('https://worker.test/not-found', {
                headers: { 'cf-connecting-ip': 'test-rate-limit' }
            }),
            {},
            { waitUntil() {} }
        );
    }

    assert.equal(response.status, 429);
});

test('Cloudflare rate limit bindings receive route-scoped keys and return Retry-After', async () => {
    const keys = [];
    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=test', {
            headers: { 'cf-connecting-ip': 'test-cloudflare-rate-limit' }
        }),
        {
            RESOURCE_RATE_LIMITER: {
                async limit({ key }) {
                    keys.push(key);
                    return { success: false };
                }
            }
        },
        { waitUntil() {} }
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { error: 'Rate limit exceeded. Try again later.' });
    assert.deepEqual(keys, ['test-cloudflare-rate-limit:resource']);
});

test('configured rate limit failures fail closed instead of bypassing protection', async t => {
    muteConsole(t, 'error');
    const response = await worker.fetch(
        new Request('https://worker.test/not-found', {
            headers: { 'cf-connecting-ip': 'test-rate-limit-failure' }
        }),
        {
            API_RATE_LIMITER: {
                async limit() {
                    throw new Error('binding unavailable');
                }
            }
        },
        { waitUntil() {} }
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { error: 'Rate limiter unavailable. Try again later.' });
});

test('resource routes keep their tighter local fallback when only the API binding exists', async t => {
    muteConsole(t, 'warn');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let apiBindingCalls = 0;

    globalThis.caches = {
        default: { match: async () => null, put: async () => undefined }
    };
    globalThis.fetch = async () => { throw new Error('provider unavailable'); };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=binding-fallback', {
            headers: { 'cf-connecting-ip': 'test-resource-binding-fallback' }
        }),
        {
            API_RATE_LIMITER: {
                async limit() {
                    apiBindingCalls += 1;
                    return { success: false };
                }
            }
        },
        { waitUntil() {} }
    );

    assert.equal(response.status, 502);
    assert.equal(apiBindingCalls, 0);
});

test('TMDB search rejects blank queries before calling an upstream service', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=%20%20%20', {
            headers: { 'cf-connecting-ip': 'test-blank-query' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Missing query' });
});

test('TMDB detail rejects non-numeric identifiers before building an upstream URL', async () => {
    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/detail?id=..%2F..%2Faccount&type=movie', {
            headers: { 'cf-connecting-ip': 'test-invalid-tmdb-id' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid id' });
});

test('TMDB does not cache a successful HTTP response until its JSON is valid', async t => {
    muteConsole(t, 'error');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cachePuts = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (...args) => { cachePuts.push(args); }
        }
    };
    globalThis.fetch = async () => new Response('<html>temporary gateway page</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=test', {
            headers: { 'cf-connecting-ip': 'test-tmdb-invalid-json' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 502);
    assert.equal(cachePuts.length, 0);
});

test('cache read failures fall back to the upstream response', async t => {
    muteConsole(t, 'warn');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => { throw new Error('cache unavailable'); },
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => Response.json({
        page: 1,
        total_results: 0,
        results: []
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=cache-fallback', {
            headers: { 'cf-connecting-ip': 'test-cache-read-fallback' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        page: 1,
        totalResults: 0,
        results: []
    });
});

test('cache write failures do not fail an otherwise valid API response', async t => {
    muteConsole(t, 'warn');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let cacheWrite;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => { throw new Error('cache write unavailable'); }
        }
    };
    globalThis.fetch = async () => Response.json({
        page: 1,
        total_results: 0,
        results: []
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=cache-write-fallback', {
            headers: { 'cf-connecting-ip': 'test-cache-write-fallback' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil(promise) { cacheWrite = promise; } }
    );

    assert.equal(response.status, 200);
    assert.ok(cacheWrite);
    await assert.doesNotReject(cacheWrite);
});

test('TMDB does not cache JSON that violates the upstream response contract', async t => {
    muteConsole(t, 'error');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cachePuts = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (...args) => { cachePuts.push(args); }
        }
    };
    globalThis.fetch = async () => Response.json({ unexpected: true });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=invalid-shape', {
            headers: { 'cf-connecting-ip': 'test-tmdb-invalid-shape' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 502);
    assert.equal(cachePuts.length, 0);
});

test('TMDB rejects an oversized upstream body without caching it', async t => {
    muteConsole(t, 'error');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cachePuts = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (...args) => { cachePuts.push(args); }
        }
    };
    globalThis.fetch = async () => Response.json({
        page: 1,
        total_results: 0,
        results: [],
        padding: 'x'.repeat(2 * 1024 * 1024)
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=oversized', {
            headers: { 'cf-connecting-ip': 'test-tmdb-body-limit' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Upstream response is too large' });
    assert.equal(cachePuts.length, 0);
});

test('TMDB search keeps movie and TV results that share the same numeric id', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => Response.json({
        page: 1,
        total_results: 2,
        results: [
            { id: 42, media_type: 'movie', title: 'Shared Id Movie', vote_count: 10 },
            { id: 42, media_type: 'tv', name: 'Shared Id Series', vote_count: 9 }
        ]
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=shared', {
            headers: { 'cf-connecting-ip': 'test-tmdb-shared-id' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.deepEqual(body.results.map(item => [item.mediaType, item.id]), [
        ['movie', 42],
        ['tv', 42]
    ]);
});

test('TMDB detail does not retry another media type after upstream rate limiting', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ status_message: 'TMDB rate limit exceeded' }, { status: 429 });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/detail?id=42&type=movie', {
            headers: { 'cf-connecting-ip': 'test-tmdb-rate-limit' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 429);
    assert.equal(fetchCalls, 1);
});

test('TMDB detail retries the alternate media type only after a not-found response', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes('/movie/42')) {
            return Response.json({ status_message: 'Not found' }, { status: 404 });
        }
        return Response.json({ id: 42, name: 'Fallback Series', credits: {} });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/tmdb/detail?id=42&type=movie', {
            headers: { 'cf-connecting-ip': 'test-tmdb-not-found-fallback' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.mediaType, 'tv');
    assert.equal(requestedUrls.length, 2);
});

test('TMDB upstream requests carry a timeout signal', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let upstreamSignal = null;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async (_url, options = {}) => {
        upstreamSignal = options.signal;
        return Response.json({ page: 1, total_results: 0, results: [] });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    await worker.fetch(
        new Request('https://worker.test/api/tmdb/search?q=timeout', {
            headers: { 'cf-connecting-ip': 'test-tmdb-timeout-signal' }
        }),
        { TMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.ok(upstreamSignal instanceof AbortSignal);
});

test('upstream body stalls are aborted after the response headers arrive', async t => {
    muteConsole(t, 'error');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async (_url, { signal }) => new Response(new globalThis.ReadableStream({
        start(controller) {
            signal.addEventListener('abort', () => {
                controller.error(new globalThis.DOMException('The operation was aborted', 'AbortError'));
            }, { once: true });
        }
    }));
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const responsePromise = worker.fetch(
        new Request('https://worker.test/api/douban/search?q=body-timeout', {
            headers: { 'cf-connecting-ip': 'test-body-timeout' }
        }),
        {},
        { waitUntil() {} }
    );
    await new Promise(resolve => globalThis.setImmediate(resolve));
    t.mock.timers.tick(10000);

    const response = await responsePromise;
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'Upstream request timed out' });
});

test('resource search reports a provider outage without caching an empty result', async t => {
    muteConsole(t, 'warn');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cachePuts = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (...args) => { cachePuts.push(args); }
        }
    };
    globalThis.fetch = async () => { throw new Error('provider unavailable'); };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=test', {
            headers: { 'cf-connecting-ip': 'test-resource-outage' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 502);
    assert.equal(cachePuts.length, 0);
});

test('resource search rejects overlong queries before fan-out', async () => {
    const query = 'x'.repeat(101);
    const response = await worker.fetch(
        new Request(`https://worker.test/api/resource?q=${query}`, {
            headers: { 'cf-connecting-ip': 'test-resource-query-length' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'query is too long' });
});

test('text and numeric API parameters are normalized and validated consistently', async () => {
    const cases = [
        ['/api/douban/search?q=%20%20', {}, 'test-invalid-douban-query'],
        ['/api/douban/detail?id=not-a-number', {}, 'test-invalid-douban-id'],
        ['/api/wiki/zh?q=%20%20', {}, 'test-invalid-wiki-query'],
        ['/api/poster?title=%20%20', {}, 'test-invalid-poster-title'],
        ['/api/omdb?title=%20%20', { OMDB_API_KEY: 'test-key' }, 'test-invalid-omdb-title']
    ];

    for (const [path, env, clientIp] of cases) {
        const response = await worker.fetch(
            new Request(`https://worker.test${path}`, {
                headers: { 'cf-connecting-ip': clientIp }
            }),
            env,
            { waitUntil() {} }
        );
        assert.equal(response.status, 400, path);
    }
});

test('media type and year parameters reject unsupported formats', async () => {
    const cases = [
        ['/api/tmdb/detail?id=42&type=person', { TMDB_API_KEY: 'test-key' }, 'test-invalid-media-type'],
        ['/api/omdb?title=test&year=20x6', { OMDB_API_KEY: 'test-key' }, 'test-invalid-omdb-year'],
        ['/api/poster?title=test&year=20x6', {}, 'test-invalid-poster-year']
    ];

    for (const [path, env, clientIp] of cases) {
        const response = await worker.fetch(
            new Request(`https://worker.test${path}`, {
                headers: { 'cf-connecting-ip': clientIp }
            }),
            env,
            { waitUntil() {} }
        );
        assert.equal(response.status, 400, path);
    }
});

test('resource search keeps each provider in its own response collection', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({
                data: [{ id: '1', attributes: { title: '测试资源' } }]
            });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('<li data-href="./thread-123.htm"><a href="./thread-123.htm">测试夸克资源</a> 夸克</li>');
        }
        if (value === 'https://by669.org/d/1' || value === 'https://www.wpzys.org/thread-123.htm') {
            return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=%E6%B5%8B%E8%AF%95', {
            headers: { 'cf-connecting-ip': 'test-resource-provider-groups' }
        }),
        {},
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.deepEqual(body.resources.map(item => item.source), ['by669']);
    assert.deepEqual(body.wpzysResources.map(item => item.source), ['wpzys']);
});

test('resource detail fan-out fairly includes the second provider', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({
                data: Array.from({ length: 13 }, (_, index) => ({
                    id: `by-${index + 1}`,
                    attributes: { title: `fair by669 ${index + 1}` }
                }))
            });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('<li data-href="./thread-999.htm"><a href="./thread-999.htm">fair wpzys resource</a> 夸克</li>');
        }
        if (value.startsWith('https://by669.org/d/by-')) {
            return new Response(`https://pan.quark.cn/s/${value.split('/').at(-1)}`);
        }
        if (value === 'https://www.wpzys.org/thread-999.htm') {
            return new Response('https://pan.quark.cn/s/wpzys-fair');
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=fair', {
            headers: { 'cf-connecting-ip': 'test-resource-fairness' }
        }),
        {},
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.quarkUrls.some(item => item.url === 'https://pan.quark.cn/s/wpzys-fair'));
    assert.ok(body.quarkUrls.length <= 100);
});

test('resource detail extraction caps links per page and globally', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({
                data: Array.from({ length: 5 }, (_, index) => ({
                    id: `cap-${index + 1}`,
                    attributes: { title: `cap resource ${index + 1}` }
                }))
            });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) return new Response('');
        if (value.startsWith('https://by669.org/d/cap-')) {
            const resourceId = value.split('/').at(-1);
            const pageLinks = Array.from({ length: 30 }, (_, index) => `https://pan.quark.cn/s/${resourceId}-${index + 1}`).join('\n');
            return new Response(pageLinks);
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=cap', {
            headers: { 'cf-connecting-ip': 'test-resource-link-cap' }
        }),
        {},
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.quarkUrls.length, 100);
});

test('resource search never fetches an external URL supplied by forum HTML', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: [] });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('<li data-href="https://attacker.example/thread-123.htm"><a href="https://attacker.example/thread-123.htm">测试夸克资源</a> 夸克</li>');
        }
        return new Response('unexpected external fetch', { status: 200 });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    await worker.fetch(
        new Request('https://worker.test/api/resource?q=%E6%B5%8B%E8%AF%95', {
            headers: { 'cf-connecting-ip': 'test-resource-ssrf' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(requestedUrls.includes('https://attacker.example/thread-123.htm'), false);
});

test('resource page redirects are checked before an external destination is fetched', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async (url, options = {}) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({
                data: [{ id: 'redirect', attributes: { title: '测试资源' } }]
            });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('', { status: 200 });
        }
        if (value === 'https://by669.org/d/redirect') {
            if (options.redirect === 'follow') {
                requestedUrls.push('https://attacker.example/private');
                return new Response('', { status: 200 });
            }
            return new Response(null, {
                status: 302,
                headers: { Location: 'https://attacker.example/private' }
            });
        }
        return new Response('', { status: 200 });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    await worker.fetch(
        new Request('https://worker.test/api/resource?q=%E6%B5%8B%E8%AF%95', {
            headers: { 'cf-connecting-ip': 'test-resource-redirect-ssrf' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(requestedUrls.includes('https://attacker.example/private'), false);
});

test('resource search ignores an oversized forum response body', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    const oversizedHtml = `${'x'.repeat(2 * 1024 * 1024 + 1)}<li data-href="./thread-999.htm"><a href="./thread-999.htm">测试夸克资源</a> 夸克</li>`;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: [] });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response(oversizedHtml, { status: 200 });
        }
        return new Response('', { status: 200 });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=%E6%B5%8B%E8%AF%95', {
            headers: { 'cf-connecting-ip': 'test-resource-body-limit' }
        }),
        {},
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.deepEqual(body.wpzysResources, []);
    assert.equal(requestedUrls.includes('https://www.wpzys.org/thread-999.htm'), false);
});

test('OMDb accepts the documented i parameter as an IMDb id alias', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let upstreamUrl = '';

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        upstreamUrl = String(url);
        return Response.json({
            Response: 'True',
            imdbID: 'tt1234567',
            Title: 'Test Movie',
            Ratings: []
        });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/omdb?i=tt1234567', {
            headers: { 'cf-connecting-ip': 'test-omdb-i-alias' }
        }),
        { OMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.match(upstreamUrl, /[?&]i=tt1234567(?:&|$)/);
});

test('OMDb rejects malformed IMDb identifiers before calling upstream', async t => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ Response: 'False' });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const response = await worker.fetch(
        new Request('https://worker.test/api/omdb?imdb=..%2F..%2F', {
            headers: { 'cf-connecting-ip': 'test-omdb-invalid-id' }
        }),
        { OMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 400);
    assert.equal(fetchCalls, 0);
});

test('OMDb ignores malformed optional rating fields instead of crashing', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => Response.json({
        Response: 'True',
        Title: 'Malformed Metadata',
        Genre: { unexpected: true },
        imdbRating: 'not-a-number',
        Ratings: [null, { Source: 'Rotten Tomatoes', Value: 87 }]
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/omdb?title=Malformed%20Metadata', {
            headers: { 'cf-connecting-ip': 'test-omdb-malformed-fields' }
        }),
        { OMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.imdb, null);
    assert.equal(body.rottenTomatoes, 87);
    assert.deepEqual(body.genres, []);
});

test('poster aggregation reuses its cached result for identical requests', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let cachedResponse = null;
    let fetchCalls = 0;

    globalThis.caches = {
        default: {
            match: async () => cachedResponse ? cachedResponse.clone() : null,
            put: async (_key, response) => { cachedResponse = response.clone(); }
        }
    };
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({
            Response: 'True',
            Title: 'Test Movie',
            Year: '2026',
            Poster: 'https://images.example/poster.jpg',
            Ratings: []
        });
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    for (const clientIp of ['test-poster-cache-1', 'test-poster-cache-2']) {
        const response = await worker.fetch(
            new Request('https://worker.test/api/poster?title=Test%20Movie&year=2026', {
                headers: { 'cf-connecting-ip': clientIp }
            }),
            { OMDB_API_KEY: 'test-key' },
            { waitUntil() {} }
        );
        assert.equal(response.status, 200);
    }

    assert.equal(fetchCalls, 1);
    assert.ok(cachedResponse);
    assert.equal(cachedResponse.headers.get('cache-control'), 'public, max-age=86400');
});

test('poster aggregation reports missing provider configuration', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({});
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/poster?title=Test%20Movie', {
            headers: { 'cf-connecting-ip': 'test-poster-no-providers' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Poster providers are not configured' });
    assert.equal(fetchCalls, 0);
});

test('resource search treats HTTP 200 provider error payloads as an outage without caching', async t => {
    muteConsole(t, 'warn');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cachePuts = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (...args) => { cachePuts.push(args); }
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ errors: [{ detail: 'temporarily blocked' }] });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=soft-failure', {
            headers: { 'cf-connecting-ip': 'test-resource-soft-failure' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Resource providers unavailable' });
    assert.equal(cachePuts.length, 0);
});

test('resource search short-caches raw results when every detail page fails', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let cachedResponse = null;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (_key, response) => { cachedResponse = response.clone(); }
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({
                data: [{ id: '1', attributes: { title: '测试资源' } }]
            });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('<html><body><p>No matching threads</p></body></html>');
        }
        if (value === 'https://by669.org/d/1') {
            return new Response('temporarily unavailable', { status: 503 });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=detail-outage', {
            headers: { 'cf-connecting-ip': 'test-resource-detail-outage' }
        }),
        {},
        { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.resources.length, 1);
    assert.deepEqual(body.quarkUrls, []);
    assert.ok(cachedResponse);
    assert.equal(cachedResponse.headers.get('cache-control'), 'public, max-age=900');
});

test('poster aggregation short-caches a usable result when a configured source fails', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cacheWrites = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (key, response) => {
                cacheWrites.push({
                    url: key.url,
                    cacheControl: response.headers.get('cache-control')
                });
            }
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://api.themoviedb.org/3/search/multi')) {
            return Response.json({
                results: [{
                    id: 7,
                    media_type: 'movie',
                    title: 'Test Movie',
                    release_date: '2026-01-01',
                    poster_path: '/poster.jpg'
                }]
            });
        }
        if (value.startsWith('https://www.omdbapi.com/')) {
            return Response.json({ Error: 'temporarily unavailable' }, { status: 503 });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/poster?title=Test%20Movie&year=2026', {
            headers: { 'cf-connecting-ip': 'test-poster-partial-cache' }
        }),
        { TMDB_API_KEY: 'tmdb-key', OMDB_API_KEY: 'omdb-key' },
        { waitUntil() {} }
    );
    const body = await response.json();
    const posterCacheWrite = cacheWrites.find(write => write.url.startsWith('https://poster-v1-cache.local/'));

    assert.equal(response.status, 200);
    assert.equal(body.tmdb, true);
    assert.ok(posterCacheWrite);
    assert.equal(posterCacheWrite.cacheControl, 'public, max-age=900');
});

test('poster aggregation short-caches OMDb fallback when configured TMDB fails', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const cacheWrites = [];

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (key, response) => {
                cacheWrites.push({
                    url: key.url,
                    cacheControl: response.headers.get('cache-control')
                });
            }
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://api.themoviedb.org/3/search/multi')) {
            return Response.json({ status_message: 'temporarily unavailable' }, { status: 503 });
        }
        if (value.startsWith('https://www.omdbapi.com/')) {
            return Response.json({
                Response: 'True',
                Title: 'Fallback Movie',
                Poster: 'https://images.example/fallback.jpg',
                Ratings: []
            });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/poster?title=Fallback%20Movie', {
            headers: { 'cf-connecting-ip': 'test-poster-tmdb-partial-cache' }
        }),
        { TMDB_API_KEY: 'tmdb-key', OMDB_API_KEY: 'omdb-key' },
        { waitUntil() {} }
    );
    const body = await response.json();
    const posterCacheWrite = cacheWrites.find(write => write.url.startsWith('https://poster-v1-cache.local/'));

    assert.equal(response.status, 200);
    assert.equal(body.omdb, true);
    assert.ok(posterCacheWrite);
    assert.equal(posterCacheWrite.cacheControl, 'public, max-age=900');
});

test('Douban reports a real upstream abort timeout as 504', async t => {
    muteConsole(t, 'error');
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            reject(new globalThis.DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const responsePromise = worker.fetch(
        new Request('https://worker.test/api/douban/search?q=timeout', {
            headers: { 'cf-connecting-ip': 'test-douban-timeout' }
        }),
        {},
        { waitUntil() {} }
    );
    await new Promise(resolve => globalThis.setImmediate(resolve));
    t.mock.timers.tick(10000);

    const response = await responsePromise;
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'Upstream request timed out' });
});

test('OMDb search preserves an upstream HTTP status', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => Response.json(
        { Error: 'rate limited' },
        { status: 429 }
    );
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/omdb?title=Rate%20Limited', {
            headers: { 'cf-connecting-ip': 'test-omdb-upstream-status' }
        }),
        { OMDB_API_KEY: 'test-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'OMDb rejected with status 429' });
});

test('Wiki preserves the 504 status produced by an aborted upstream request', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async () => {
        throw new globalThis.DOMException('The operation was aborted', 'AbortError');
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/wiki/zh?q=timeout', {
            headers: { 'cf-connecting-ip': 'test-wiki-timeout' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'Upstream request timed out' });
});

test('poster search preserves a configured source upstream status when no fallback exists', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://api.themoviedb.org/3/search/multi')) {
            return Response.json({ status_message: 'TMDB unavailable' }, { status: 503 });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/poster?title=Unavailable', {
            headers: { 'cf-connecting-ip': 'test-poster-upstream-status' }
        }),
        { TMDB_API_KEY: 'tmdb-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'TMDB unavailable' });
});

test('resource search treats a WPZYS HTTP 200 challenge page as a partial outage', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    let cachedResponse = null;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async (_key, response) => { cachedResponse = response.clone(); }
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: [] });
        }
        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('<html><title>Just a moment...</title><div id="challenge-platform"></div></html>');
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/resource?q=challenge', {
            headers: { 'cf-connecting-ip': 'test-resource-challenge' }
        }),
        {},
        { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.ok(cachedResponse);
    assert.equal(cachedResponse.headers.get('cache-control'), 'public, max-age=900');
});

test('poster search preserves a Wikipedia fallback upstream status', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://www.omdbapi.com/')) {
            return Response.json({ Response: 'False', Error: 'Movie not found!' });
        }
        if (value.startsWith('https://zh.wikipedia.org/w/api.php')) {
            return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://worker.test/api/poster?title=Wiki%20Fallback', {
            headers: { 'cf-connecting-ip': 'test-poster-wiki-status' }
        }),
        { OMDB_API_KEY: 'omdb-key' },
        { waitUntil() {} }
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Wiki search rejected with status 503' });
});

test('scheduled refresh limits title fan-out concurrency', async t => {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    const titles = Array.from({ length: 12 }, (_, index) => `Title ${index + 1}`).join(',');
    let activeRequests = 0;
    let maxActiveRequests = 0;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };
    globalThis.fetch = async url => {
        const value = String(url);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise(resolve => globalThis.setImmediate(resolve));
        activeRequests -= 1;

        if (value.includes('/search/multi')) {
            return Response.json({
                results: [{ id: 42, media_type: 'movie', title: 'Scheduled title', release_date: '2026-01-01' }]
            });
        }
        if (value.includes('/movie/42')) {
            return Response.json({ id: 42, title: 'Scheduled title', credits: {} });
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.caches = originalCaches;
        globalThis.fetch = originalFetch;
    });

    let refreshPromise;
    worker.scheduled(
        { scheduledTime: Date.now() },
        { TMDB_API_KEY: 'test-key', CRON_REFRESH_TITLES: titles },
        { waitUntil(promise) { if (!refreshPromise) refreshPromise = promise; } }
    );

    await refreshPromise;
    assert.ok(maxActiveRequests <= 4, `expected at most 4 concurrent refreshes, got ${maxActiveRequests}`);
});
