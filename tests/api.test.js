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
