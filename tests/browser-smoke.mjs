import assert from 'node:assert/strict';

const browserWs = process.env.BROWSER_WS;
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173/';

if (!browserWs) {
    throw new Error('BROWSER_WS is required; connect this script to an isolated Chrome page.');
}

const socket = new globalThis.WebSocket(browserWs);
let nextCommandId = 1;
const pendingCommands = new Map();

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const pending = pendingCommands.get(message.id);
    if (!pending) return;
    pendingCommands.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
});

await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextCommandId++;
        pendingCommands.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression, { awaitPromise = false } = {}) {
    const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true
    });
    return result.result?.value;
}

async function waitFor(expression, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
}

await command('Page.enable');
await command('Runtime.enable');
await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
        const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
        const poster = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        const candidate = (title, id) => ({
            id,
            mediaType: 'movie',
            title,
            originalTitle: title,
            year: '2024',
            poster,
            summary: 'A browser smoke test synopsis.',
            tmdbRating: 8.2,
            tmdbVotes: 1200,
            popularity: 20,
            matchScore: 1,
            matchConfidence: 'high'
        });
        window.__smoke = { calls: [], resourceCalls: 0 };
        window.requestIdleCallback = undefined;
        window.cancelIdleCallback = undefined;
        if (new URL(location.href).searchParams.has('fallback')) window.IntersectionObserver = undefined;
        window.fetch = async (rawUrl, options = {}) => {
            const url = new URL(rawUrl, location.href);
            window.__smoke.calls.push(url.pathname + url.search);
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (url.pathname === '/api/tmdb/search') {
                const query = url.searchParams.get('q') || '';
                if (query === 'Slow Movie') {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, 250);
                        options.signal?.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                    });
                }
                const ids = { 'Test Movie': 100, 'Slow Movie': 101, 'Fresh Movie': 102, 'Fallback Movie': 103, 'No IMDb Movie': 104 };
                return json({ results: [candidate(query, ids[query] || 104)] });
            }
            if (url.pathname === '/api/tmdb/detail') {
                const id = Number(url.searchParams.get('id'));
                const titles = { 100: 'Test Movie', 101: 'Slow Movie', 102: 'Fresh Movie', 103: 'Fallback Movie', 104: 'No IMDb Movie' };
                const title = titles[id] || 'Smoke Movie';
                return json({
                    ...candidate(title, id),
                    genres: ['Drama'],
                    runtime: 120,
                    status: 'Released',
                    originalLanguage: 'en',
                    productionCompanies: ['Smoke Studio'],
                    productionCountries: ['United States'],
                    cast: ['Smoke Actor'],
                    director: ['Smoke Director'],
                    writer: ['Smoke Writer'],
                    imdbId: id === 104 ? '' : 'tt1234567'
                });
            }
            if (url.pathname === '/api/douban/search') return json([]);
            if (url.pathname === '/api/wiki/zh') return json({ extract: '中文烟测简介。' });
            if (url.pathname === '/api/omdb') return json({ omdb: true, imdb: 8.4, poster });
            if (url.pathname === '/api/resource') {
                window.__smoke.resourceCalls += 1;
                if (window.__smoke.resourceCalls === 1) return json({ error: 'temporary resource outage' }, 502);
                return json({
                    resources: [{ title: 'Smoke resource', url: 'https://resource.example/smoke' }],
                    wpzysResources: [{ title: 'Smoke forum', url: 'https://forum.example/smoke' }],
                    quarkUrls: [{ title: 'Smoke Quark', url: 'https://pan.quark.cn/s/smoke', password: 'abcd' }]
                });
            }
            return json({});
        };
    })();`
});

async function search(query) {
    await evaluate(`(() => {
        const input = document.querySelector('#searchInput');
        input.value = ${JSON.stringify(query)};
        input.form.requestSubmit();
    })()`);
}

async function assertSearchReady(title) {
    await waitFor(`document.querySelector('#showTitle')?.textContent === ${JSON.stringify(title)}`);
    assert.equal(await evaluate('document.querySelector("#errorState:not(.hidden)") === null'), true);
    assert.equal(await evaluate('document.body.scrollWidth === document.documentElement.scrollWidth'), true);
}

async function runObserverFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 0, 'resources should stay deferred before entering the viewport');

    await evaluate("document.querySelector('#resourcesSection')?.scrollIntoView({ block: 'start' })");
    await waitFor('window.__smoke.resourceCalls === 1');
    await waitFor("document.querySelector('#resourcesSection button')?.textContent.includes('重试资源扫描')");
    assert.match(await evaluate('document.querySelector("#resourcesStatus")?.textContent || ""'), /失败/);

    await evaluate("document.querySelector('#resourcesSection button')?.click()");
    await waitFor('window.__smoke.resourceCalls === 2');
    await waitFor("Boolean(document.querySelector('#resourceList a[href=\\\"https://resource.example/smoke\\\"]'))");
    assert.equal(await evaluate('document.querySelector("#quarkUrlList a")?.getAttribute("href")'), 'https://pan.quark.cn/s/smoke');
}

async function runStaleSearchFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Slow Movie');
    await new Promise(resolve => setTimeout(resolve, 25));
    await search('Fresh Movie');
    await assertSearchReady('Fresh Movie');
    assert.equal(await evaluate('document.querySelector("#showTitle")?.textContent'), 'Fresh Movie');
}

async function runTitleOmdbFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('No IMDb Movie');
    await assertSearchReady('No IMDb Movie');
    await waitFor("document.querySelector('#omdbStatus')?.textContent.includes('已补充 OMDb 数据')");
    const calls = await evaluate('window.__smoke.calls');
    assert.ok(calls.some(call => call.includes('/api/omdb?title=No%20IMDb%20Movie&year=2024')));
    assert.equal(calls.some(call => call.startsWith('/api/poster?')), false, 'an existing TMDB poster should avoid a second poster search');
}

async function runTimerFallbackFlow() {
    await command('Page.navigate', { url: `${baseUrl}?fallback=1` });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Fallback Movie');
    await assertSearchReady('Fallback Movie');
    await new Promise(resolve => setTimeout(resolve, 1450));
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 1, 'old browsers should use the bounded timer fallback');
}

try {
    await runObserverFlow();
    await runStaleSearchFlow();
    await runTitleOmdbFlow();
    await runTimerFallbackFlow();
    console.log(JSON.stringify({ browserSmoke: 'passed', viewport: '390x844', flows: ['observer', 'retry', 'stale-search', 'title-omdb', 'timer-fallback'] }));
} finally {
    socket.close();
}
