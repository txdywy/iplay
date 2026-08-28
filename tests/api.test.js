import test from 'node:test';
import assert from 'node:assert/strict';

const originalLocation = globalThis.location;
globalThis.location = { hostname: 'localhost' };
const { ResourceAPI } = await import('../js/api.js');
globalThis.location = originalLocation;

test('resource API propagates provider failures to the UI layer', async t => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(
        { error: 'Resource providers unavailable' },
        { status: 502 }
    );
    t.after(() => { globalThis.fetch = originalFetch; });

    await assert.rejects(
        ResourceAPI.search('test'),
        /Resource providers unavailable/
    );
});

test('API clients encode queries and return JSON responses', async t => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (url, options = {}) => {
        requestedUrl = String(url);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ results: [{ id: 1 }] });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    const result = await TmdbAPI.search('a b');

    assert.deepEqual(result, { results: [{ id: 1 }] });
    assert.match(requestedUrl, /\/api\/tmdb\/search\?q=a%20b$/);
});

test('API client timeout aborts a request after the documented default', async t => {
    const originalFetch = globalThis.fetch;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            reject(new globalThis.DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    const requestPromise = TmdbAPI.search('timeout');
    await new Promise(resolve => globalThis.setImmediate(resolve));
    t.mock.timers.tick(12000);

    await assert.rejects(requestPromise, error => error.message === 'Request timed out. Please try again.');
});

test('Wiki API keeps caller cancellation distinct from a network failure', async t => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            reject(new globalThis.DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
    t.after(() => { globalThis.fetch = originalFetch; });

    const { WikiAPI } = await import('../js/api.js');
    const controller = new globalThis.AbortController();
    const requestPromise = WikiAPI.getSummary('cancelled', { signal: controller.signal });
    controller.abort();

    await assert.rejects(requestPromise, error => error.name === 'AbortError');
});

test('OMDb client fetches a known IMDb profile by id', async t => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (url, options = {}) => {
        requestedUrl = String(url);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ omdb: true, imdb: 8.4 });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { OmdbAPI } = await import('../js/api.js');
    const result = await OmdbAPI.getById('tt1234567');

    assert.deepEqual(result, { omdb: true, imdb: 8.4 });
    assert.match(requestedUrl, /\/api\/omdb\?imdb=tt1234567$/);
});

test('OMDb client can enrich a title when an IMDb id is unavailable', async t => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (url, options = {}) => {
        requestedUrl = String(url);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ omdb: true, title: 'Test Movie' });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { OmdbAPI } = await import('../js/api.js');
    const result = await OmdbAPI.search('Test Movie', 2024);

    assert.deepEqual(result, { omdb: true, title: 'Test Movie' });
    assert.match(requestedUrl, /\/api\/omdb\?title=Test%20Movie&year=2024$/);
});

test('OMDb client keeps provider failures recoverable and preserves caller aborts', async t => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (_url, options = {}) => {
        fetchCalls += 1;
        if (options.signal?.aborted) throw new globalThis.DOMException('Aborted', 'AbortError');
        return Response.json({ error: 'OMDb unavailable' }, { status: 503 });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { OmdbAPI } = await import('../js/api.js');
    assert.equal(await OmdbAPI.getById(''), null);
    assert.equal(await OmdbAPI.getById('tt1234567'), null);

    const controller = new globalThis.AbortController();
    controller.abort();
    await assert.rejects(
        OmdbAPI.getById('tt1234567', { signal: controller.signal }),
        error => error.name === 'AbortError'
    );
    assert.equal(fetchCalls, 2);
});
