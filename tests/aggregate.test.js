import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { getPansouBase } from '../worker/aggregate.js';

const PANSOU = 'https://so.252035.xyz';
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
function mockWorld(t, { pansou, shares = {}, pansouFailures = 0 }) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const cache = memoryCache();
    const calls = { pansou: [], token: [], detail: [] };
    let pansouAttempts = 0;
    globalThis.caches = cache;
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(String(input));
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
    assert.equal(world.cache.entries.size, 0);
    assert.deepEqual(world.calls.pansou.map(url => url.searchParams.get('src')), ['all', 'tg']);
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
    const afterFirst = world.calls.pansou.length;
    assert.equal(afterFirst, 1);
    const cached = await (await aggregate(world)).json();
    assert.equal(world.calls.pansou.length, afterFirst, 'the second search is served from the cache');
    assert.ok(cached.meta.cacheExpiresAt > Date.now());
    await aggregate(world, '测试剧', { extra: '&id=1&type=tv&year=2023&refresh=1' });
    assert.equal(world.calls.pansou.length, afterFirst + 1, 'refresh asks the index again');
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
