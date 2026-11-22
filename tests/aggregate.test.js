import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { getPansouBase } from '../worker/aggregate.js';

const PANSOU = 'https://so.252035.xyz';
const PANSOUSUO = 'https://www.pansousuo.com';
const QUARK = 'https://drive-h.quark.cn';

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

// A PanSou-compatible index and Quark's share endpoints. `shares` maps a share
// id to how Quark answers for it.
function mockWorld(t, { pansou, pansousuo, shares = {}, pansouFailures = 0 }) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const cache = memoryCache();
    const calls = { pansou: [], pansousuo: [], token: [], detail: [] };
    let pansouAttempts = 0;
    globalThis.caches = cache;
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(String(input));
        if (url.origin === PANSOUSUO) {
            calls.pansousuo.push(url);
            assert.equal(options.redirect, 'manual');
            assert.equal(new globalThis.Headers(options.headers).get('authorization'), null);
            assert.equal(url.pathname, '/api/search');
            assert.equal(url.searchParams.get('pan'), 'quark');
            return typeof pansousuo === 'function' ? pansousuo() : Response.json({ items: pansousuo });
        }
        if (url.origin === PANSOU) {
            calls.pansou.push(url);
            pansouAttempts += 1;
            if (pansouAttempts <= pansouFailures) return new Response('', { status: 302, headers: { Location: 'https://elsewhere.test/' } });
            const items = typeof pansou === 'function' ? pansou(url) : pansou;
            return Response.json({ code: 0, data: { total: items.length, merged_by_type: { quark: items } } });
        }
        assert.equal(url.origin, QUARK, `unexpected host ${url.origin}`);
        assert.equal(options.redirect, 'manual');
        const headers = new globalThis.Headers(options.headers);
        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('authorization'), null);
        if (url.pathname.endsWith('/token')) {
            const { pwd_id: id, passcode } = JSON.parse(options.body);
            calls.token.push({ id, passcode });
            const share = shares[id];
            if (!share) return Response.json({ code: 41011 }, { status: 400 });
            if (share.throws) throw new Error('network down');
            if (share.throwsOnce && calls.token.filter(call => call.id === id).length === 1) throw new Error('timed out once');
            if (share.passcode && passcode !== share.passcode) return Response.json({ code: 41008 }, { status: 400 });
            if (share.code) return Response.json({ code: share.code }, { status: 400 });
            return Response.json({ code: 0, data: { stoken: 'secret-stoken', title: share.title, author: { nick: 'private-author' } } });
        }
        assert.ok(url.pathname.endsWith('/detail'));
        assert.equal(url.searchParams.get('stoken'), 'secret-stoken');
        const id = url.searchParams.get('pwd_id');
        calls.detail.push(id);
        const share = shares[id];
        return Response.json({
            code: 0,
            data: { list: (share.entries || []).map(name => ({ file_name: name, dir: !/\.\w{2,4}$/.test(name) })) },
            metadata: { _total: share.total ?? (share.entries || []).length }
        });
    };
    t.after(() => Object.assign(globalThis, previous));
    const writes = [];
    return {
        cache, calls,
        ctx: { waitUntil(promise) { writes.push(promise); } },
        flush: () => Promise.all(writes.splice(0))
    };
}

let client = 0;
async function aggregate(world, query = '测试剧', { env = {}, extra = '&id=1&type=tv&year=2023' } = {}) {
    client += 1;
    const response = await worker.fetch(new Request(`https://worker.test/api/resource/aggregate?q=${encodeURIComponent(query)}${extra}`, {
        headers: { 'cf-connecting-ip': `203.0.113.${client}`, Origin: 'https://iplay.hackx64.eu.org' }
    }), env, world.ctx);
    await world.flush();
    return response;
}

const post = (id, note, extra = {}) => ({
    url: `https://pan.quark.cn/s/${id}`, password: '', note, datetime: '2025-06-01T00:00:00Z', source: 'tg:chan1', ...extra
});

const indexed = (id, title, extra = {}) => ({
    pan: 'quark', title, share_url: `https://pan.quark.cn/s/${id}`, published_at: '2025-09-01T00:00:00Z', ...extra
});

test('the 盘搜索 index contributes verified shares alongside PanSou with the same identity checks and deduplication', async t => {
    const world = mockWorld(t, {
        pansou: [post('also-in-index', '测试片 (2023)'), post('pan-only', '测试片 (2023)')],
        pansousuo: [
            indexed('also-in-index', '测试片 (2023)', { access_code: 'ab12' }),
            indexed('index-only', '测试片 4K', { year: 2023 }),
            indexed('sequel', '测试片 2 (2024)'),
            indexed('other-year', '测试片 (2010)'),
            indexed('different-work', '测试片 (2023)', { work_title: '另一部电影' }),
            indexed('foreign-provider', '测试片 (2023)', { pan: 'baidu' }),
            indexed('offsite', '测试片 (2023)', { share_url: 'https://example.com/s/offsite' }),
            indexed('dead', '测试片 (2023)')
        ],
        shares: {
            'also-in-index': { passcode: 'ab12', entries: ['测试片.mkv'] },
            'index-only': { entries: ['测试片.mkv'] },
            'pan-only': { entries: ['测试片.mp4'] }
        }
    });
    const options = { env: { PANSOUSUO_SEARCH: '1' }, extra: '&id=1&type=movie&year=2023' };
    const response = await aggregate(world, '测试片', options);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.meta.provider, 'multiple');
    assert.deepEqual(result.meta.providers, { pansou: { status: 'ok', found: 2 }, pansousuo: { status: 'ok', found: 7 } });
    assert.deepEqual(result.results.map(item => item.url.split('/').at(-1)).sort(), ['also-in-index', 'index-only', 'pan-only']);
    const duplicate = result.results.find(item => item.url.endsWith('/also-in-index'));
    assert.equal(duplicate.source, 'index:pansousuo');
    assert.equal(duplicate.passcodeVerified, true);
    assert.deepEqual([...new Set(world.calls.token.map(item => item.id))].sort(), ['also-in-index', 'dead', 'index-only', 'pan-only']);
    assert.equal(world.calls.pansousuo[0].searchParams.get('q'), '测试片');
    await aggregate(world, '测试片', options);
    assert.equal(world.calls.pansousuo.length, 1, 'a cached search does not contact the index again');
});

test('the indexes remain usable independently during failure, cooldown and configured disablement', async t => {
    const world = mockWorld(t, {
        pansou: [post('pan-only', '测试剧 (2023)')], pansouFailures: 2,
        pansousuo: [indexed('index-only', '测试剧 (2023)')],
        shares: { 'index-only': { entries: ['测试剧'] } }
    });
    const env = { PANSOUSUO_SEARCH: '1' };
    const fallback = await (await aggregate(world, '测试剧', { env })).json();
    assert.equal(fallback.meta.providers.pansou.status, 'failed');
    assert.equal(fallback.results.length, 1);
    const duringCooldown = await (await aggregate(world, '测试剧', { env, extra: '&id=2&type=tv&year=2023' })).json();
    assert.equal(duringCooldown.meta.providers.pansou.status, 'cooldown');
    assert.equal(duringCooldown.meta.providers.pansousuo.status, 'ok');
    assert.equal(world.calls.pansou.length, 2);
    const indexOnly = await (await aggregate(world, '测试剧', { env: { ...env, PANSOU_API_URL: 'off' } })).json();
    assert.equal(indexOnly.meta.provider, 'pansousuo');
    const before = world.calls.pansousuo.length;
    const disabled = await (await aggregate(world, '测试剧', { env: { ...env, AGGREGATE_SEARCH: '0' } })).json();
    assert.equal(disabled.enabled, false);
    assert.equal(world.calls.pansousuo.length, before);
});

test('a 盘搜索 rate limit does not remove successful PanSou results', async t => {
    const world = mockWorld(t, {
        pansou: [post('pan-only', '测试剧 (2023)')],
        pansousuo: () => new Response(null, { status: 429 }),
        shares: { 'pan-only': { entries: ['测试剧'] } }
    });
    const response = await aggregate(world, '测试剧', { env: { PANSOUSUO_SEARCH: '1' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.meta.providers.pansousuo.status, 'failed');
    assert.equal(result.results[0].source, 'tg:chan1');
});

test('duplicate results preserve a valid alternate passcode and accept decimal release metadata', async t => {
    const world = mockWorld(t, {
        pansou: [post('protected', '测试片 5.1声道 (2023)', { password: 'ok12' })],
        pansousuo: [
            indexed('protected', '测试片 2.5GB (2023)', { access_code: 'old1' }),
            indexed('decimal', '测试片 2.5GB (2023)'),
            indexed('sequel', '测试片 2 (2024)')
        ],
        shares: {
            protected: { passcode: 'ok12', entries: ['测试片.mkv'] },
            decimal: { entries: ['测试片.mp4'] }
        }
    });
    const response = await aggregate(world, '测试片', {
        env: { PANSOUSUO_SEARCH: '1' }, extra: '&id=1&type=movie&year=2023'
    });
    const result = await response.json();
    assert.equal(result.results.length, 2);
    const share = result.results.find(item => item.url.endsWith('/protected'));
    assert.equal(share.password, 'ok12');
    assert.equal(share.passcodeVerified, true);
    assert.equal(share.source, 'tg:chan1');
    assert.deepEqual(world.calls.token.filter(call => call.id === 'protected' && call.passcode).map(call => call.passcode), ['old1', 'ok12']);
    assert.ok(!world.calls.token.some(call => call.id === 'sequel'));
});

test('aggregate search returns only verified shares of this work, with what is inside', async t => {
    const world = mockWorld(t, {
        pansou: [
            post('alive1', '测试剧 (2023) 4K 全集\n更多资源请关注频道', { datetime: '2025-06-01T00:00:00Z' }),
            post('alive1', '测试剧 2023 重发', { datetime: '2024-01-01T00:00:00Z', password: 'old1' }),
            post('garbled', '测试剧 (2023) 高码', { datetime: '2025-07-01T00:00:00Z', source: 'plugin:hunhepan' }),
            post('pwreq1', '测试剧 2023 全30集', { password: 'ab12', datetime: '2025-08-01T00:00:00Z' }),
            post('pwbad1', '测试剧 2023 4K', { password: 'zz99' }),
            post('pwnone', '测试剧 2023 1080P'),
            { ...post('pwurl1', '测试剧 (2023) 合集'), url: 'https://pan.quark.cn/s/pwurl1?pwd=Qx9z' },
            post('dead1', '测试剧 2023 4K'),
            post('gone1', '测试剧 2023 蓝光'),
            post('banned1', '测试剧 2023 国语'),
            post('unknown1', '测试剧 (2023) HDR'),
            post('novel1', '测试剧.txt 全文'),
            post('novel2', '测试剧 (2023) 4K'),
            post('audio1', '测试剧 有声剧 2023'),
            post('other1', '另一部剧 2023 4K'),
            post('oldyear1', '测试剧 (2015) 4K'),
            { url: 'https://example.com/s/notquark', password: '', note: '测试剧 2023', datetime: '2025-01-01T00:00:00Z', source: 'tg:x' }
        ],
        shares: {
            alive1: { title: '测试剧 (2023) 4K', entries: ['测试剧 (2023) 4K', 'readme.txt'], total: 2 },
            garbled: { title: '测L试Z剧 2023', entries: ['测L试Z剧 (2023)'] },
            pwreq1: { passcode: 'ab12', title: '测试剧 全30集', entries: ['测试剧.S01'] },
            pwbad1: { passcode: 'OTHER' },
            pwnone: { passcode: 'needed' },
            pwurl1: { passcode: 'Qx9z', title: '测试剧 合集', entries: ['测试剧 合集'] },
            novel2: { title: '测试剧 全文', entries: ['测试剧-全文.txt', '测试剧-番外.epub'] },
            dead1: { code: 41011 },
            gone1: { code: 41012 },
            banned1: { code: 41031 },
            unknown1: { throws: true }
        }
    });
    const response = await aggregate(world);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://iplay.hackx64.eu.org');
    const body = await response.json();

    const byId = Object.fromEntries(body.results.map(item => [item.url.split('/').at(-1), item]));
    assert.deepEqual(Object.keys(byId).sort(), ['alive1', 'garbled', 'pwnone', 'pwreq1', 'pwurl1', 'unknown1']);
    assert.equal(byId.alive1.status, 'available');
    assert.equal(byId.alive1.contentMatch, true);
    assert.equal(byId.alive1.shareTitle, '测试剧 (2023) 4K');
    assert.deepEqual(byId.alive1.entries, [{ name: '测试剧 (2023) 4K', dir: true }, { name: 'readme.txt', dir: false }]);
    assert.equal(byId.alive1.totalItems, 2);
    assert.equal(byId.alive1.password, 'old1', 'a repost supplies the passcode the newest post lacks');
    assert.equal(byId.alive1.datetime, '2025-06-01T00:00:00.000Z', 'the newest post names the share');
    assert.equal(byId.alive1.source, 'tg:chan1');
    assert.equal(byId.garbled.contentMatch, undefined, 'a deliberately garbled name cannot be confirmed');
    assert.equal(byId.garbled.source, 'plugin:hunhepan');
    assert.deepEqual([byId.pwreq1.status, byId.pwreq1.passcodeVerified, byId.pwreq1.password], ['available', true, 'ab12']);
    assert.deepEqual([byId.pwurl1.status, byId.pwurl1.passcodeVerified, byId.pwurl1.password], ['available', true, 'Qx9z']);
    assert.deepEqual([byId.pwnone.status, byId.pwnone.passcodeVerified], ['passcode_required', undefined]);
    assert.equal(byId.unknown1.status, 'unknown');

    // Verified shares of this work come before unconfirmed and passcode-locked ones.
    const order = body.results.map(item => item.status);
    assert.deepEqual(order, [...order].sort((a, b) => ['available', 'unknown', 'passcode_required'].indexOf(a) - ['available', 'unknown', 'passcode_required'].indexOf(b)));

    assert.deepEqual(body.meta.hidden, { invalid: 1, cancelled: 1, restricted: 1, passcode_mismatch: 1, not_video: 1 });
    assert.equal(body.meta.hiddenCount, 5);
    assert.equal(body.meta.found, 17);
    assert.equal(body.meta.matched, 11, 'books, audio, other works, other years and non-Quark links are dropped before any check');
    assert.equal(body.meta.unchecked, 0);
    assert.equal(body.meta.unknown, 1);
    assert.equal(body.meta.verified, body.results.length - 1, 'an unconfirmed share is not counted as verified');

    // One passcode attempt per share, and only the passcode the index listed.
    const attempts = world.calls.token.filter(call => call.passcode);
    assert.deepEqual(attempts.map(call => [call.id, call.passcode]).sort(), [['pwbad1', 'zz99'], ['pwreq1', 'ab12'], ['pwurl1', 'Qx9z']]);
    assert.ok(!world.calls.detail.includes('dead1') && !world.calls.detail.includes('pwbad1'), 'only reachable shares are listed');

    // Neither the response nor the cache carries Quark's credential or the sharer.
    const serialized = JSON.stringify(body) + (await Promise.all([...world.cache.entries.values()].map(entry => entry.clone().text()))).join('');
    assert.ok(!/secret-stoken|private-author/.test(serialized));
});

test('aggregate search asks for Quark shares only and falls back to the faster source when the index stalls', async t => {
    const world = mockWorld(t, {
        pansou: [post('alive1', '测试剧 (2023)')],
        shares: { alive1: { title: '测试剧', entries: ['测试剧'] } },
        pansouFailures: 1
    });
    const body = await (await aggregate(world)).json();
    assert.equal(body.results.length, 1);
    assert.deepEqual(world.calls.pansou.map(url => url.searchParams.get('src')), ['all', 'tg']);
    for (const url of world.calls.pansou) {
        assert.equal(url.pathname, '/api/search');
        assert.equal(url.searchParams.get('kw'), '测试剧');
        assert.equal(url.searchParams.get('cloud_types'), 'quark');
        assert.equal(url.searchParams.get('res'), 'merge');
    }
});

test('PANSOU_SOURCE pins one source and PANSOU_API_URL selects the index', async t => {
    const world = mockWorld(t, { pansou: [] });
    const env = { PANSOU_SOURCE: 'plugin' };
    const response = await aggregate(world, '测试剧', { env });
    assert.equal(response.status, 200);
    assert.deepEqual(world.calls.pansou.map(url => url.searchParams.get('src')), ['plugin']);
    assert.equal(getPansouBase({ PANSOU_API_URL: 'https://pan.example.org/pansou/' }), 'https://pan.example.org/pansou');
    assert.equal(getPansouBase({}), PANSOU);
});

test('aggregate search can be switched off and refuses an unsafe index address', async t => {
    const world = mockWorld(t, { pansou: [post('alive1', '测试剧 2023')] });
    t.mock.method(console, 'warn', () => {});
    for (const env of [
        { PANSOU_API_URL: 'off' }, { AGGREGATE_SEARCH: '0' },
        { PANSOU_API_URL: 'http://plain.example.org' },
        { PANSOU_API_URL: 'https://user:pass@pan.example.org' },
        { PANSOU_API_URL: 'https://pan.example.org/?token=1' }
    ]) {
        const response = await aggregate(world, '测试剧', { env });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { enabled: false, results: [], meta: {} });
    }
    assert.equal(world.calls.pansou.length, 0, 'a disabled module never contacts the index');
});

test('a stalled or failing index is a gateway error that is not cached', async t => {
    const world = mockWorld(t, { pansou: [], pansouFailures: 5 });
    t.mock.method(console, 'warn', () => {});
    const response = await aggregate(world);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Aggregate search unavailable' });
    const keys = [...world.cache.entries.keys()];
    assert.ok(!keys.some(key => key.startsWith('https://aggregate-search-')), 'no search result is cached');
    assert.ok(keys.some(key => key.startsWith('https://aggregate-index-down-')), 'the outage is remembered briefly');
    assert.deepEqual(world.calls.pansou.map(url => url.searchParams.get('src')).sort(), ['all', 'tg'], 'both sources were asked at once');
});

test('right after the index failed, visitors are told at once; a retry still tries again', async t => {
    const world = mockWorld(t, { pansou: [post('alive1', '测试剧 (2023)')], shares: { alive1: { title: '测试剧', entries: ['测试剧'] } }, pansouFailures: 2 });
    t.mock.method(console, 'warn', () => {});
    assert.equal((await aggregate(world)).status, 502);
    const asked = world.calls.pansou.length;
    const quick = await aggregate(world, '别的剧');
    assert.equal(quick.status, 503);
    assert.equal(quick.headers.get('retry-after'), '60');
    assert.match((await quick.json()).error, /聚合源刚刚没有响应/);
    assert.equal(world.calls.pansou.length, asked, 'nobody waits on an index that just failed');
    const retried = await aggregate(world, '测试剧', { extra: '&id=1&type=tv&year=2023&refresh=1' });
    assert.equal(retried.status, 200, 'an explicit retry asks the index again');
    assert.equal((await retried.json()).results.length, 1);
});

test('the fuller answer is used when it arrives shortly after the faster one, otherwise the faster one', async t => {
    for (const [allDelay, expectFound] of [[30, 2], [2600, 1]]) {
        const world = mockWorld(t, {
            pansou: url => url.searchParams.get('src') === 'all'
                ? [post('alive1', '测试剧 (2023)'), post('alive2', '测试剧 (2023) 4K')]
                : [post('alive1', '测试剧 (2023)')],
            shares: { alive1: { title: '测试剧', entries: ['测试剧'] }, alive2: { title: '测试剧 4K', entries: ['测试剧'] } }
        });
        const answer = globalThis.fetch;
        globalThis.fetch = async (input, options) => {
            const url = new URL(String(input));
            if (url.searchParams.get('src') === 'all') await new Promise(resolve => globalThis.setTimeout(resolve, allDelay));
            return answer(input, options);
        };
        const body = await (await aggregate(world, `测试剧${allDelay}`)).json();
        assert.equal(body.meta.found, expectFound, allDelay < 2000 ? 'the fuller answer wins within the grace' : 'a slow fuller answer is not waited for');
    }
});

test('a malformed index response is a provider fault, an empty one is simply empty', async t => {
    t.mock.method(console, 'warn', () => {});
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.caches = memoryCache();
    let body = { code: 0, data: { total: 0 } };
    globalThis.fetch = async () => Response.json(body);
    const world = { ctx: { waitUntil() {} }, flush: async () => {} };
    const empty = await aggregate(world);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json()).results.length, 0);
    body = { code: 0, data: { merged_by_type: { quark: 'nope' } } };
    assert.equal((await aggregate(world, '另一个剧')).status, 502);
});

test('checks stay within the Quark request budget and report what was left unchecked', async t => {
    const items = Array.from({ length: 60 }, (_, index) => post(`bulk${index}`, `测试剧 (2023) 第${index}版`, {
        datetime: new Date(Date.UTC(2025, 0, 1 + index)).toISOString()
    }));
    const shares = Object.fromEntries(items.map((item, index) => [`bulk${index}`, { title: `测试剧 ${index}`, entries: ['测试剧'] }]));
    const world = mockWorld(t, { pansou: items, shares });
    const body = await (await aggregate(world)).json();
    const quarkRequests = world.calls.token.length + world.calls.detail.length;
    assert.ok(quarkRequests <= 36, `at most 36 Quark requests, saw ${quarkRequests}`);
    assert.equal(body.meta.matched, 60);
    assert.ok(body.meta.unchecked > 0);
    assert.equal(body.results.length + body.meta.unchecked, 60);
    // The newest posts are checked first.
    assert.ok(body.results.some(item => item.url.endsWith('bulk59')));
});

test('a verified answer is cached, and refresh checks again', async t => {
    const world = mockWorld(t, {
        pansou: [post('alive1', '测试剧 (2023)')],
        shares: { alive1: { title: '测试剧', entries: ['测试剧'] } }
    });
    assert.equal((await aggregate(world)).status, 200);
    // Both sources are asked at once.
    const afterFirst = world.calls.pansou.length;
    assert.equal(afterFirst, 2);
    const cached = await (await aggregate(world)).json();
    assert.equal(world.calls.pansou.length, afterFirst, 'the second search is served from the cache');
    assert.ok(cached.meta.cacheExpiresAt > Date.now());
    await aggregate(world, '测试剧', { extra: '&id=1&type=tv&year=2023&refresh=1' });
    assert.equal(world.calls.pansou.length, afterFirst + 2, 'refresh asks the index again');
});

test('aggregate search validates its request and shares the resource rate limit', async t => {
    const world = mockWorld(t, { pansou: [] });
    assert.equal((await aggregate(world, '')).status, 400);
    assert.equal((await aggregate(world, '测试剧', { extra: '&id=1' })).status, 400);
    assert.equal((await aggregate(world, '测试剧', { extra: '&id=abc&type=tv' })).status, 400);
    assert.equal((await aggregate(world, '测试剧', { extra: '&year=nope' })).status, 400);
    const keys = [];
    const limiter = { async limit({ key }) { keys.push(key); return { success: false }; } };
    const limited = await aggregate(world, '测试剧', { env: { RESOURCE_RATE_LIMITER: limiter } });
    assert.equal(limited.status, 429);
    assert.match(keys[0], /:aggregate$/);
    assert.equal(world.calls.pansou.length, 0);
});

test('a thin answer from the index is cached only briefly, a full one for longer', async t => {
    const thin = mockWorld(t, {
        pansou: [post('alive1', '测试剧 (2023)')],
        shares: { alive1: { title: '测试剧', entries: ['测试剧'] } }
    });
    const before = Date.now();
    const thinBody = await (await aggregate(thin)).json();
    assert.ok(thinBody.meta.cacheExpiresAt - before <= 125_000, 'two minutes at most');

    const items = Array.from({ length: 6 }, (_, index) => post(`full${index}`, `测试剧 (2023) 版本${index}`));
    const shares = Object.fromEntries(items.map((item, index) => [`full${index}`, { title: `测试剧 ${index}`, entries: ['测试剧'] }]));
    const full = mockWorld(t, { pansou: items, shares });
    const fullBody = await (await aggregate(full, '测试剧B')).json();
    assert.ok(fullBody.meta.cacheExpiresAt - Date.now() > 300_000, 'ten minutes for a complete, fully verified answer');
});

test('a share whose first check is inconclusive is checked once more within the same request', async t => {
    const world = mockWorld(t, {
        pansou: [post('ok1', '测试剧 (2023) 4K'), post('ok2', '测试剧 (2023) HDR'), post('flaky1', '测试剧 (2023) 全集'), post('down1', '测试剧 (2023) 1080P')],
        shares: {
            ok1: { title: '测试剧 4K', entries: ['测试剧'] },
            ok2: { title: '测试剧 HDR', entries: ['测试剧'] },
            flaky1: { throwsOnce: true, title: '测试剧 全集', entries: ['测试剧'] },
            down1: { throws: true }
        }
    });
    const body = await (await aggregate(world)).json();
    const byId = Object.fromEntries(body.results.map(item => [item.url.split('/').at(-1), item]));
    assert.equal(byId.flaky1.status, 'available', 'the second attempt settles it');
    assert.equal(byId.down1.status, 'unknown', 'a share that keeps failing stays unconfirmed');
    assert.equal(world.calls.token.filter(call => call.id === 'flaky1').length, 2);
    assert.equal(world.calls.token.filter(call => call.id === 'down1').length, 2);
    assert.equal(body.meta.unknown, 1);
    assert.equal(body.meta.verified, 3);
});

test('when most first-pass checks fail, Quark is not asked again', async t => {
    const world = mockWorld(t, {
        pansou: [post('down1', '测试剧 (2023) 4K'), post('down2', '测试剧 (2023) 1080P'), post('down3', '测试剧 (2023) HDR')],
        shares: { down1: { throws: true }, down2: { throws: true }, down3: { throws: true } }
    });
    const body = await (await aggregate(world)).json();
    assert.equal(body.meta.unknown, 3);
    assert.equal(world.calls.token.length, 3, 'one attempt each: no second pass while Quark is failing');
});

test('Quark checks allow longer than three seconds, the aggregate module longest', async t => {
    const delays = [];
    const realSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...rest) => {
        delays.push(delay);
        return realSetTimeout(callback, delay, ...rest);
    });
    const world = mockWorld(t, {
        pansou: [post('alive1', '测试剧 (2023)')],
        shares: { alive1: { title: '测试剧', entries: ['测试剧'] } }
    });
    await aggregate(world);
    assert.ok(delays.includes(6000), 'the aggregate module gives each Quark request six seconds');
    delays.length = 0;
    const status = await worker.fetch(new Request('https://worker.test/api/resource/quark-status?id=alive1', {
        headers: { 'cf-connecting-ip': '203.0.113.250' }
    }), {}, world.ctx);
    assert.equal(status.status, 200);
    assert.ok(delays.includes(4500) && !delays.includes(3200), 'the shared check no longer cuts Quark off at 3.2 seconds');
});

test('cacheOnly serves a cached answer and refuses to search when there is none', async t => {
    const world = mockWorld(t, {
        pansou: [post('alive1', '测试剧 (2023)')],
        shares: { alive1: { title: '测试剧', entries: ['测试剧'] } }
    });
    const lookup = async () => {
        const { handleAggregateSearch } = await import('../worker/aggregate.js');
        const response = await handleAggregateSearch('测试剧', {}, world.ctx, { cacheOnly: true, id: '1', mediaType: 'tv', year: '2023' });
        await world.flush();
        return response;
    };
    const miss = await lookup();
    assert.equal(miss.status, 410);
    assert.equal(world.calls.pansou.length, 0, 'a cache-only request never searches');
    await aggregate(world);
    const hit = await lookup();
    assert.equal(hit.status, 200);
    assert.equal((await hit.json()).results.length, 1);
    assert.equal(world.calls.pansou.length, 2, 'only the one real search asked the index');
});
