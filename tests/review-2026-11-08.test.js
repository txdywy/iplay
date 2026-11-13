import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import worker from '../worker/_worker.js';
import { decodeHtmlEntities } from '../worker/core.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';
import { calculateRecommendationScore, getPreferenceSettings, normalizeGenres, savePreferenceWeights } from '../js/scorer.js';

function memoryCache() {
    const entries = new Map();
    return {
        entries,
        default: {
            match: async key => entries.get(String(key.url || key))?.clone() ?? null,
            put: async (key, response) => { entries.set(String(key.url || key), response); }
        }
    };
}

function mockGlobals(t, fetcher, cache = memoryCache()) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    globalThis.fetch = fetcher;
    globalThis.caches = cache;
    t.after(() => Object.assign(globalThis, previous));
    const writes = [];
    return { cache, ctx: { waitUntil(promise) { writes.push(promise); } }, flush: () => Promise.all(writes.splice(0)) };
}

function request(path, ip) {
    return new Request(`https://worker.test${path}`, { headers: { 'cf-connecting-ip': ip } });
}

test('HTML entities decode once, so escaped entities stay literal', () => {
    assert.equal(decodeHtmlEntities('Tom &amp;lt;3 &amp;amp; &#60;&#x4e2d;&nbsp;x &bogus;'), 'Tom &lt;3 &amp; <中 x &bogus;');
});

test('a password label followed by a long blank run is scanned in linear time', async t => {
    const page = `<p>链接：https://pan.quark.cn/s/blankrun 密码${' '.repeat(200000)}提取码：a1B2</p>`;
    mockGlobals(t, async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: [{ id: '1', attributes: { title: '空白测试 夸克' } }] });
        }
        if (value === 'https://by669.org/d/1') return new Response(page);
        if (value.startsWith('https://wpzy.org/search.htm')) return new Response(WPZY_EMPTY_SEARCH_HTML);
        throw new Error(`Unexpected fetch: ${value}`);
    });
    const started = performance.now();
    const response = await worker.fetch(request('/api/resource?q=空白测试', 'blank-run'), {}, { waitUntil() {} });
    const elapsed = performance.now() - started;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).quarkUrls.map(({ url }) => url), ['https://pan.quark.cn/s/blankrun']);
    assert.ok(elapsed < 2000, `the password pattern must not backtrack quadratically (${Math.round(elapsed)} ms)`);
});

test('a forced resource refresh keeps the cached answer when every provider fails', async t => {
    let failing = false;
    const { ctx, flush } = mockGlobals(t, async url => {
        if (failing) return new Response('down', { status: 503 });
        const host = new URL(String(url)).hostname;
        if (host === 'by669.org') return Response.json({ data: [] });
        if (host === 'zuidouyin.com') return Response.json([]);
        return new Response('down', { status: 503 });
    });
    t.mock.method(console, 'warn', () => {});
    const first = await worker.fetch(request('/api/resource?q=stale-test', 'stale-1'), {}, ctx);
    assert.equal(first.status, 200);
    await flush();

    failing = true;
    const refreshed = await worker.fetch(request('/api/resource?q=stale-test&refresh=1', 'stale-2'), {}, ctx);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.headers.get('x-iplay-stale'), '1');
    assert.equal(refreshed.headers.get('cache-control'), 'no-store');
    assert.ok(Array.isArray((await refreshed.json()).resources));
});

test('a Douban search challenge page is a 503 the client can back off from', async t => {
    const { ctx } = mockGlobals(t, async () => new Response('<html><title>Just a moment...</title></html>', {
        headers: { 'content-type': 'text/html' }
    }));
    t.mock.method(console, 'error', () => {});
    const response = await worker.fetch(request('/api/douban/search?q=challenge', 'douban-challenge'), {}, ctx);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { error: 'Douban unavailable' });
});

test('empty Douban suggestions are cached briefly', async t => {
    const { cache, ctx, flush } = mockGlobals(t, async () => Response.json([]));
    const response = await worker.fetch(request('/api/douban/search?q=brand-new', 'douban-empty'), {}, ctx);
    assert.equal(response.status, 200);
    await flush();
    const cachedSuggestions = [...cache.entries.values()].map(entry => entry.headers.get('cache-control'));
    assert.ok(cachedSuggestions.includes('public, max-age=3600'));
});

test('a cached Wikipedia answer does not wait on the TMDB adjacent-year lookup', async t => {
    const calls = [];
    const { ctx, flush } = mockGlobals(t, async url => {
        const parsed = new URL(String(url));
        calls.push(parsed.hostname);
        if (parsed.hostname === 'api.themoviedb.org') return Response.json({ id: 7, name: '繁花', first_air_date: '2023-12-27' });
        if (parsed.pathname.endsWith('/w/api.php')) {
            return Response.json({ query: { search: [{ title: '繁花 (电视剧)' }] } });
        }
        return Response.json({
            title: '繁花 (电视剧)',
            description: '2023年中国电视剧',
            extract: '《繁花》是2023年播出的中国电视剧。'
        });
    });
    const env = { TMDB_API_KEY: 'test' };
    const path = '/api/wiki/zh?q=%E7%B9%81%E8%8A%B1&type=tv&year=2023&id=7';
    const first = await worker.fetch(request(path, 'wiki-1'), env, ctx);
    assert.equal(first.status, 200);
    await flush();
    calls.length = 0;
    const second = await worker.fetch(request(path, 'wiki-2'), env, ctx);
    assert.equal(second.status, 200);
    assert.deepEqual(calls, []);
});

test('upstream credential failures are not reported as the visitor\'s own 401', async t => {
    const { ctx } = mockGlobals(t, async () => new Response('denied', { status: 401 }));
    t.mock.method(console, 'error', () => {});
    const response = await worker.fetch(request('/api/tmdb/search?q=auth', 'tmdb-auth'), { TMDB_API_KEY: 'revoked' }, ctx);
    assert.equal(response.status, 502);
});

test('TMDB TV genres are split into names the preferences use', () => {
    assert.deepEqual(normalizeGenres(['War & Politics', '剧情'], ['战争', '纪录片']), ['战争', '政治', '剧情', '纪录']);
    assert.deepEqual(normalizeGenres(['动作冒险', 'Sci-Fi & Fantasy']), ['动作', '冒险', '科幻', '奇幻']);
    assert.deepEqual(normalizeGenres(null, ['constructor']), ['constructor']);
    const war = calculateRecommendationScore({ rating: 8, genres: ['War & Politics'], summary: 'A sufficiently detailed summary.' });
    assert.ok(war.report.cons.some(reason => reason.includes('战争')));
});

test('every built-in preference genre is one a data source returns', () => {
    const sourceGenres = new Set([
        // TMDB zh-CN movie and TV genres after normalization, plus Douban genres.
        '动作', '冒险', '动画', '喜剧', '犯罪', '纪录', '剧情', '家庭', '奇幻', '历史', '恐怖', '音乐', '悬疑', '爱情',
        '科幻', '电视电影', '惊悚', '战争', '西部', '儿童', '政治', '灾难', '武侠', '古装', '传记', '运动'
    ]);
    for (const { genre } of getPreferenceSettings()) assert.ok(sourceGenres.has(genre), genre);
});

test('an emptied preference field keeps the default instead of saving 0', t => {
    const store = new Map();
    const previous = globalThis.window;
    globalThis.window = { localStorage: {
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, value),
        removeItem: key => store.delete(key)
    } };
    t.after(() => { globalThis.window = previous; });
    assert.equal(savePreferenceWeights({ 恐怖: '', 喜剧: ' ', 爱情: '4' }), true);
    const settings = new Map(getPreferenceSettings().map(entry => [entry.genre, entry.score]));
    assert.equal(settings.get('恐怖'), -3);
    assert.equal(settings.get('喜剧'), 2.5);
    assert.equal(settings.get('爱情'), 4);
});

test('the toast preserves horizontal centering when it moves into view', async () => {
    const [html, css, main] = await Promise.all([
        readFile('index.html', 'utf8'), readFile('css/input.css', 'utf8'), readFile('js/main.js', 'utf8')
    ]);
    assert.match(html, /id="toast"[^>]*-translate-x-1\/2 translate-y-20[^>]*transition-\[translate,opacity\]/);
    assert.match(css, /\.toast-visible\s*\{\s*translate: -50% 0;/);
    assert.match(main, /toast\.classList\.add\('toast-visible'\)/);
});

test('the search button stays enabled so Enter can replace a running search', async () => {
    const main = await readFile('js/main.js', 'utf8');
    assert.doesNotMatch(main, /searchButton\.disabled\s*=/);
});
