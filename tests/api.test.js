import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_VERSION } from '../js/release.js';

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

test('resource searches isolate browser-cached passwords from previous releases', async t => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => Response.json({ quarkUrls: [{
        url: 'https://pan.quark.cn/s/public',
        ...(new URL(url).searchParams.get('v') === RELEASE_VERSION ? {} : { password: '6868' })
    }] });
    t.after(() => { globalThis.fetch = originalFetch; });
    const result = await ResourceAPI.search('cached public share');
    assert.equal(result.quarkUrls[0].password, undefined, 'a cached pre-fix code must not survive a frontend release');
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
    assert.match(requestedUrl, new RegExp(`/api/tmdb/search\\?q=a%20b&v=${RELEASE_VERSION.replaceAll('.', '\\.')}$`));
});

test('TMDB person API encodes actor names', async t => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (url, options = {}) => {
        requestedUrl = String(url);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ person: { name: 'A B' }, credits: [] });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    const result = await TmdbAPI.searchPerson('A B');

    assert.deepEqual(result, { person: { name: 'A B' }, credits: [] });
    assert.match(requestedUrl, new RegExp(`/api/tmdb/person\\?q=A%20B&v=${RELEASE_VERSION.replaceAll('.', '\\.')}$`));
});

test('TMDB person API encodes pagination, type filters, and person selection', async t => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (url, options = {}) => {
        requestedUrl = String(url);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ person: { id: 900 }, credits: [] });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    await TmdbAPI.searchPerson('A B', {
        personId: 900,
        offset: 36,
        limit: 60,
        mediaType: 'movie'
    });

    assert.equal(requestedUrl, `http://localhost:8787/api/tmdb/person?q=A%20B&id=900&offset=36&limit=60&mediaType=movie&v=${RELEASE_VERSION}`);
});

test('resource and poster retries request fresh Worker data', async t => {
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    const cacheModes = [];
    globalThis.fetch = async (url, options) => {
        requestedUrls.push(String(url));
        cacheModes.push(options.cache);
        return Response.json({ ok: true });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { PosterAPI } = await import('../js/api.js');
    await ResourceAPI.search('retry me', {}, { refresh: true });
    await PosterAPI.getPoster('retry me', 2024, {}, { refresh: true });

    // Reusing the refresh URL must still reach the server after a partial retry.
    await ResourceAPI.search('retry me', { cache: 'force-cache' }, { refresh: true });
    await PosterAPI.getPoster('retry me', 2024, { cache: 'force-cache' }, { refresh: true });
    await ResourceAPI.search('retry me');
    await PosterAPI.getPoster('retry me', 2024);

    const resourceUrl = new URL(requestedUrls[0]);
    assert.equal(resourceUrl.pathname, '/api/resource');
    assert.equal(resourceUrl.searchParams.get('q'), 'retry me');
    assert.equal(resourceUrl.searchParams.get('refresh'), '1');
    assert.equal(resourceUrl.searchParams.get('v'), RELEASE_VERSION);
    assert.match(requestedUrls[1], /\/api\/poster\?title=retry%20me&year=2024&refresh=1$/);
    assert.equal(requestedUrls[2], requestedUrls[0]);
    assert.equal(requestedUrls[3], requestedUrls[1]);
    assert.deepEqual(cacheModes, ['no-store', 'no-store', 'no-store', 'no-store', 'no-store', undefined]);
});

test('resource requests reach the Worker after provider access changes even with an old browser cache', async t => {
    const browserCache = new Map();
    let accessible = true;
    let workerRequests = 0;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        if (options.cache !== 'no-store' && browserCache.has(url)) return Response.json(browserCache.get(url));
        workerRequests += 1;
        const result = { quarkUrls: accessible ? [{ url: 'https://pan.quark.cn/s/previous-session' }] : [] };
        // Represents an HTTP entry saved by a previously deployed client.
        browserCache.set(url, result);
        return Response.json(result);
    });
    assert.equal((await ResourceAPI.search('same version')).quarkUrls.length, 1);
    accessible = false;
    assert.deepEqual((await ResourceAPI.search('same version')).quarkUrls, []);
    assert.deepEqual((await ResourceAPI.search('same version', { cache: 'force-cache' })).quarkUrls, []);
    assert.equal(workerRequests, 3, 'each request must consult current Worker access and its isolated internal cache');
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

test('API client keeps a timeout classified as a timeout during a simultaneous caller abort', async t => {
    const originalFetch = globalThis.fetch;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            reject(new globalThis.DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    const controller = new globalThis.AbortController();
    const requestPromise = TmdbAPI.search('timeout-race', { signal: controller.signal });
    await new Promise(resolve => globalThis.setImmediate(resolve));
    t.mock.timers.tick(12000);
    controller.abort();

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

test('already cancelled API calls never reach the network', async t => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ results: [] }); };
    t.after(() => { globalThis.fetch = originalFetch; });
    const { TmdbAPI } = await import('../js/api.js');
    const controller = new globalThis.AbortController();
    controller.abort();
    await assert.rejects(TmdbAPI.search('cancelled', { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(calls, 0);
});

test('caller cancellation wins over a transport that returns stale data after abort', async t => {
    const originalFetch = globalThis.fetch;
    const controller = new globalThis.AbortController();
    globalThis.fetch = async () => {
        controller.abort();
        return Response.json({ results: [{ id: 42 }] });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const { TmdbAPI } = await import('../js/api.js');
    await assert.rejects(TmdbAPI.search('stale', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('Wiki requests carry selected identity and release without passing them as fetch options', async t => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('q'), 'Test Series');
        assert.equal(params.get('type'), 'tv');
        assert.equal(params.get('year'), '2023');
        assert.equal(params.get('v'), RELEASE_VERSION, 'previous-release browser summaries must not bypass current validation');
        assert.equal(options.mediaType, undefined);
        assert.equal(options.year, undefined);
        return Response.json({ extract: 'A series synopsis.' });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const { WikiAPI } = await import('../js/api.js');
    assert.ok(await WikiAPI.getSummary('Test Series', { mediaType: 'tv', year: '2023' }));
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

test('poster client sends the selected work identity without leaking it into fetch options', async t => {
    const originalFetch = globalThis.fetch;
    let requestedUrl;
    globalThis.fetch = async (url, options) => {
        requestedUrl = new URL(url);
        assert.equal(options.mediaId, undefined);
        assert.equal(options.mediaType, undefined);
        assert.equal(options.imdbId, undefined);
        assert.equal(options.cache, 'no-store');
        return Response.json({ tmdbId: 101, mediaType: 'tv' });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const { PosterAPI } = await import('../js/api.js');
    await PosterAPI.getPoster('Shared Title', 2024, { mediaId: 101, mediaType: 'tv', imdbId: 'tt1111111' }, { refresh: true });
    assert.equal(requestedUrl.searchParams.get('id'), '101');
    assert.equal(requestedUrl.searchParams.get('type'), 'tv');
    assert.equal(requestedUrl.searchParams.get('imdb'), 'tt1111111');
});

test('clients preserve explicit empty identities so the Worker can reject them instead of broadening a lookup', async t => {
    const urls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        urls.push(new URL(url));
        return Response.json({});
    });
    const { TmdbAPI, PosterAPI } = await import('../js/api.js');
    await TmdbAPI.searchPerson('Selected Actor', { personId: '' });
    await TmdbAPI.searchPerson('Selected Actor', { personId: 0 });
    await TmdbAPI.getDetail(42, '');
    await PosterAPI.getPoster('Selected Film', 2024, { mediaId: '', mediaType: '', imdbId: '' });
    await TmdbAPI.getDetail(42);
    assert.equal(urls[0].searchParams.get('id'), '');
    assert.equal(urls[1].searchParams.get('id'), '0');
    assert.equal(urls[2].searchParams.get('type'), '');
    for (const name of ['id', 'type', 'imdb']) assert.equal(urls[3].searchParams.get(name), '');
    assert.equal(urls[4].searchParams.has('type'), false, 'omitted legacy type remains omitted');
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
    assert.equal(fetchCalls, 1);
});

test('an embedded follow-up answer serves identical TMDB requests without a round trip', async t => {
    const originalFetch = globalThis.fetch;
    const requested = [];
    const detail = { id: 77, mediaType: 'movie', title: 'Embedded Detail', cast: [{ name: 'A' }] };
    const person = { person: { id: 78, name: 'Embedded Actor' }, credits: [{ id: 1 }], searchMeta: { query: 'Embedded Actor' } };
    globalThis.fetch = async url => {
        requested.push(new URL(url));
        if (new URL(url).pathname === '/api/tmdb/search') {
            return Response.json({ results: [], prefetched: { detail: { id: 77, type: 'movie', data: detail }, person: { query: 'Embedded Actor', data: person } } });
        }
        return Response.json({ fetched: new URL(url).pathname });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    const searchResult = await TmdbAPI.search('Embedded');
    assert.equal('prefetched' in searchResult, false, 'callers only see the search answer');

    const first = await TmdbAPI.getDetail(77, 'movie', { signal: new globalThis.AbortController().signal });
    assert.deepEqual(first, detail);
    first.cast.push({ name: 'mutated' });
    assert.deepEqual((await TmdbAPI.getDetail(77, 'movie')).cast, [{ name: 'A' }], 'every read is an independent copy');
    assert.deepEqual(await TmdbAPI.searchPerson('Embedded Actor'), person);
    assert.equal(requested.length, 1, 'detail and default person reads stay local');

    assert.deepEqual(await TmdbAPI.getDetail(77, 'tv'), { fetched: '/api/tmdb/detail' }, 'another media type is another identity');
    assert.deepEqual(await TmdbAPI.searchPerson('Embedded Actor', { offset: 36, limit: 36 }), { fetched: '/api/tmdb/person' },
        'only the default page was embedded');
    assert.equal(requested.length, 3);

    const controller = new globalThis.AbortController();
    controller.abort();
    await assert.rejects(TmdbAPI.getDetail(77, 'movie', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('malformed embedded answers are ignored', async t => {
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async url => {
        requested.push(new URL(url).pathname);
        if (new URL(url).pathname === '/api/tmdb/search') {
            return Response.json({ results: [], prefetched: { detail: { id: '79', type: 'movie', data: { title: 'string id' } }, person: { query: '', data: {} } } });
        }
        return Response.json({ fetched: true });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { TmdbAPI } = await import('../js/api.js');
    await TmdbAPI.search('Malformed');
    assert.deepEqual(await TmdbAPI.getDetail('79', 'movie'), { fetched: true });
    assert.deepEqual(requested, ['/api/tmdb/search', '/api/tmdb/detail']);
});

test('embedded answers reject mismatched identities and incomplete person data', async t => {
    const requested = [];
    let prefetched;
    t.mock.method(globalThis, 'fetch', async url => {
        requested.push(new URL(url).pathname);
        return new URL(url).pathname === '/api/tmdb/search'
            ? Response.json({ results: [], prefetched }) : Response.json({ fetched: true });
    });
    const { TmdbAPI } = await import('../js/api.js');
    for (const data of [
        { id: 881, mediaType: 'movie', title: 'Other ID' },
        { id: 880, mediaType: 'tv', title: 'Other Type' },
        { id: 880, mediaType: 'movie' },
        {}
    ]) {
        prefetched = { detail: { id: 880, type: 'movie', data } };
        await TmdbAPI.search('Invalid Embedded Detail');
        assert.deepEqual(await TmdbAPI.getDetail(880, 'movie'), { fetched: true });
    }
    for (const data of [
        {}, { person: { id: 882, name: 'Incomplete Actor' } }, { person: { id: 0, name: 'Invalid Actor' }, credits: [] },
        { person: null, credits: [], searchMeta: { ambiguous: true } },
        { person: null, credits: [], searchMeta: { ambiguous: true }, personCandidates: [] },
        { person: null, credits: [], searchMeta: { ambiguous: true }, personCandidates: [{ id: 0, name: 'Invalid Actor' }] }
    ]) {
        prefetched = { person: { query: 'Invalid Embedded Actor', data } };
        await TmdbAPI.search('Invalid Embedded Actor');
        assert.deepEqual(await TmdbAPI.searchPerson('Invalid Embedded Actor'), { fetched: true });
    }
    assert.equal(requested.length, 20, 'every malformed answer falls back to a real request');
});

test('explicit TMDB cache refreshes bypass and invalidate embedded answers', async t => {
    const detail = { id: 890, mediaType: 'movie', title: 'Old Detail' };
    const person = { person: { id: 891, name: 'Refresh Actor' }, credits: [] };
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const path = new URL(url).pathname;
        if (path === '/api/tmdb/search') return Response.json({ results: [], prefetched: {
            detail: { id: 890, type: 'movie', data: detail }, person: { query: 'Refresh Actor', data: person }
        } });
        requests.push({ path, cache: options.cache });
        return Response.json({ fresh: true });
    });
    const { TmdbAPI } = await import('../js/api.js');
    for (const cache of ['no-store', 'reload', 'no-cache']) {
        await TmdbAPI.search('Refresh Embedded');
        assert.deepEqual(await TmdbAPI.getDetail(890, 'movie', { cache }), { fresh: true });
        assert.deepEqual(await TmdbAPI.searchPerson('Refresh Actor', { cache }), { fresh: true });
        assert.deepEqual(await TmdbAPI.getDetail(890, 'movie'), { fresh: true }, 'later reads cannot resurrect the invalidated answer');
        assert.deepEqual(await TmdbAPI.searchPerson('Refresh Actor'), { fresh: true });
    }
    assert.equal(requests.length, 12);
    assert.deepEqual(requests.filter(entry => entry.cache).map(entry => entry.cache), ['no-store', 'no-store', 'reload', 'reload', 'no-cache', 'no-cache']);
});

test('valid empty and ambiguous embedded person answers still avoid a round trip', async t => {
    let data;
    let requests = 0;
    const query = 'Valid Embedded Person';
    t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        return Response.json({ results: [], prefetched: { person: { query, data } } });
    });
    const { TmdbAPI } = await import('../js/api.js');
    for (data of [
        { person: null, credits: [], searchMeta: { confidence: 'none' } },
        { person: null, credits: [], searchMeta: { ambiguous: true }, personCandidates: [
            { id: 892, name: query }, { id: 893, name: query }
        ] }
    ]) {
        await TmdbAPI.search(query);
        assert.deepEqual(await TmdbAPI.searchPerson(query), data);
    }
    assert.equal(requests, 2);
});

test('OMDb stops for this page once the Worker reports it is not configured', async t => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ error: 'OMDb API not configured' }, { status: 503 });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const { OmdbAPI } = await import('../js/api.js');
    assert.equal(await OmdbAPI.getById('tt7654321'), null);
    assert.equal(await OmdbAPI.getById('tt7654322'), null);
    assert.equal(await OmdbAPI.search('Another Title', 2024), null);
    assert.equal(fetchCalls, 1, 'a missing key is permanent until the Worker is redeployed');
});
