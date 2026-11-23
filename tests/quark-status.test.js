import { testQuarkAttempts } from './helpers/quark-attempts.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/_worker.js';

test('Quark status distinguishes accessible, protected, unavailable and unknown shares without caching account data', async t => {
    const coordinator = testQuarkAttempts(t);
    const entries = new Map();
    const writes = [];
    const calls = new Map();
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.caches = { default: {
        async match(key) { return entries.get(key.url)?.clone(); },
        async put(key, response) { entries.set(key.url, response); }
    } };
    globalThis.fetch = async (url, options) => {
        assert.equal(new URL(url).origin, 'https://drive-h.quark.cn');
        assert.equal(new URL(url).pathname, '/1/clouddrive/share/sharepage/token');
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'manual');
        const headers = new globalThis.Headers(options.headers);
        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('authorization'), null);
        const { pwd_id: id, passcode } = JSON.parse(options.body);
        assert.equal(passcode, '');
        calls.set(id, (calls.get(id) || 0) + 1);
        if (id === 'unknown') return new Response('<title>challenge</title>');
        if (id === 'limited') return Response.json({ code: 41006 }, { status: 429 });
        if (id === 'egress-error') return Response.json({ code: 41009 }, { status: 503 });
        if (id === 'redirect') return Response.json({ code: 41009 }, { status: 302, headers: { Location: 'https://untrusted.test/' } });
        if (id === 'timeout') throw new Error('temporary network error');
        if (id === 'live') return Response.json({ code: 0, data: { stoken: 'secret-token', author: 'private' } });
        const codes = {
            Missing: 41006, deleted: 41009, expired: 41019, cancelled: 41012, protected: 41008,
            wrong: 41007, 'missing-files': 41004, blocked: 41010, invalid: 41011, restricted: 41031
        };
        return Response.json({ code: codes[id] }, { status: id === 'Missing' ? 404 : 400 });
    };
    const limits = [];
    const limiter = { async limit({ key }) { limits.push(key); return { success: true }; } };
    async function probe(ids) {
        const params = new globalThis.URLSearchParams(ids.map(id => ['id', id]));
        const request = new Request('https://worker.test/api/resource/quark-status?' + params, {
            headers: { 'cf-connecting-ip': 'quark-test', Origin: 'https://iplay.hackx64.eu.org' }
        });
        const response = await worker.fetch(request, { RESOURCE_RATE_LIMITER: limiter, QUARK_PASSCODE_ATTEMPTS: coordinator }, {
            waitUntil(promise) { writes.push(promise); }
        });
        await Promise.all(writes.splice(0));
        return response;
    }

    assert.equal((await probe(['https://untrusted.invalid/'])).status, 400);
    assert.equal((await probe(Array.from({ length: 13 }, (_, index) => 'id-' + index))).status, 400);
    assert.equal(calls.size, 0);

    const ids = ['Missing', 'deleted', 'expired', 'cancelled', 'protected', 'wrong', 'live', 'unknown', 'limited', 'timeout', 'Missing'];
    const response = await probe(ids);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://iplay.hackx64.eu.org');
    const unavailable = { Missing: 'missing', deleted: 'deleted', expired: 'expired', cancelled: 'cancelled' };
    const unknown = ['wrong', 'unknown', 'limited', 'timeout'];
    const expected = { unavailable, unknown, available: ['live'], passcodeRequired: ['protected'] };
    assert.deepEqual(await response.json(), expected);
    assert.equal(calls.get('Missing'), 1);
    assert.deepEqual(await (await probe(ids)).json(), expected);
    for (const id of ['Missing', 'deleted', 'expired', 'cancelled', 'protected', 'live']) assert.equal(calls.get(id), 1);
    for (const id of ['unknown', 'limited', 'timeout', 'wrong']) assert.equal(calls.get(id), 2);
    const additional = await probe(['missing-files', 'blocked', 'invalid', 'restricted', 'egress-error', 'redirect']);
    assert.deepEqual(await additional.json(), {
        unavailable: { 'missing-files': 'missing_files', blocked: 'blocked', invalid: 'invalid', restricted: 'restricted' },
        unknown: ['egress-error', 'redirect'],
        available: [],
        passcodeRequired: []
    });
    assert.ok(limits.every(key => key === 'quark-test:quark-status'));
    for (const entry of entries.values()) {
        assert.ok(!/secret-token|private/.test(await entry.text()));
    }
});

test('Quark status can read what a share holds and verify a listed passcode', async t => {
    const coordinator = testQuarkAttempts(t);
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    const entries = new Map();
    globalThis.caches = { default: {
        async match(key) { return entries.get(key.url)?.clone(); },
        async put(key, response) { entries.set(key.url, response); }
    } };
    const passcodeAttempts = [];
    const shares = {
        full: { items: ['繁花 (2023) 4K', 'readme.txt'] },
        empty: { items: [] },
        locked: { passcode: 'Ab12', items: ['繁花 全30集'] },
        wrongcode: { passcode: 'REAL' },
        nocode: { passcode: 'zz99' }
    };
    globalThis.fetch = async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/token')) {
            const { pwd_id: id, passcode } = JSON.parse(options.body);
            if (passcode) passcodeAttempts.push([id, passcode]);
            const share = shares[id];
            if (share.passcode && passcode !== share.passcode) return Response.json({ code: 41008 }, { status: 400 });
            return Response.json({ code: 0, data: { stoken: 'tok-' + id, author: 'private' } });
        }
        const id = parsed.searchParams.get('pwd_id');
        assert.equal(parsed.searchParams.get('stoken'), 'tok-' + id);
        return Response.json({ code: 0, data: { list: shares[id].items.map(name => ({ file_name: name, dir: !name.includes('.') })) }, metadata: { _total: shares[id].items.length } });
    };
    const params = new globalThis.URLSearchParams([
        ...Object.keys(shares).map(id => ['id', id]),
        ['pwd', 'locked:Ab12'], ['pwd', 'wrongcode:nope'], ['pwd', 'bogus:<script>'], ['content', '1']
    ]);
    const response = await worker.fetch(new Request('https://worker.test/api/resource/quark-status?' + params, {
        headers: { 'cf-connecting-ip': 'quark-content' }
    }), { QUARK_PASSCODE_ATTEMPTS: coordinator }, { waitUntil() {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.available, ['full', 'empty', 'locked']);
    assert.deepEqual(body.passcodeRequired, ['nocode'], 'no listed passcode: the share still asks for one');
    assert.deepEqual(body.passcodeVerified, ['locked']);
    assert.deepEqual(body.passcodeMismatch, ['wrongcode']);
    assert.deepEqual(body.content, {
        full: { items: 2, names: ['繁花 (2023) 4K', 'readme.txt'] },
        empty: { items: 0, names: [] },
        locked: { items: 1, names: ['繁花 全30集'] }
    });
    assert.deepEqual(passcodeAttempts.sort(), [['locked', 'Ab12'], ['wrongcode', 'nope']], 'only listed, well-formed passcodes are tried, once');
    assert.ok(!JSON.stringify(body).includes('tok-') && !JSON.stringify(body).includes('private'));

    // Without the new parameters the answer is unchanged.
    const plain = await (await worker.fetch(new Request('https://worker.test/api/resource/quark-status?id=full', {
        headers: { 'cf-connecting-ip': 'quark-plain' }
    }), { QUARK_PASSCODE_ATTEMPTS: coordinator }, { waitUntil() {} })).json();
    assert.deepEqual(plain, { unavailable: {}, unknown: [], available: ['full'], passcodeRequired: [] });
});

test('a share refuses passcode guesses after two wrong ones, whoever asks', async t => {
    const coordinator = testQuarkAttempts(t);
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    const entries = new Map();
    globalThis.caches = { default: {
        async match(key) { return entries.get(key.url)?.clone(); },
        async put(key, response) { entries.set(key.url, response); }
    } };
    const attempts = [];
    globalThis.fetch = async (url, options = {}) => {
        const { pwd_id: id, passcode } = JSON.parse(options.body);
        if (passcode) attempts.push(passcode);
        if (passcode !== 'REAL') return Response.json({ code: 41008 }, { status: 400 });
        return Response.json({ code: 0, data: { stoken: 'tok-' + id } });
    };
    const probe = async (code, client) => {
        const writes = [];
        const response = await worker.fetch(new Request(`https://worker.test/api/resource/quark-status?id=guessme&pwd=guessme:${code}`, {
            headers: { 'cf-connecting-ip': client }
        }), { QUARK_PASSCODE_ATTEMPTS: coordinator }, { waitUntil(promise) { writes.push(promise); } });
        await Promise.all(writes);
        return response.json();
    };
    assert.deepEqual((await probe('aa01', '198.51.100.1')).passcodeMismatch, ['guessme']);
    assert.deepEqual((await probe('aa02', '198.51.100.2')).passcodeMismatch, ['guessme']);
    const third = await probe('aa03', '198.51.100.3');
    assert.deepEqual(third.passcodeMismatch, [], 'a third guess is not submitted');
    assert.deepEqual(third.passcodeRequired, ['guessme']);
    assert.deepEqual(attempts, ['aa01', 'aa02'], 'Quark saw only two guesses');
    const correct = await probe('REAL', '198.51.100.4');
    assert.deepEqual(correct.passcodeRequired, ['guessme'], 'the cap holds even for the right code, for the rest of the hour');
});

test('a passcode Quark never answered for is not remembered as needing one', async t => {
    const coordinator = testQuarkAttempts(t);
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    const entries = new Map();
    globalThis.caches = { default: {
        async match(key) { return entries.get(key.url)?.clone(); },
        async put(key, response) { entries.set(key.url, response); }
    } };
    let fail = true;
    globalThis.fetch = async (url, options = {}) => {
        const { passcode } = JSON.parse(options.body);
        if (!passcode) return Response.json({ code: 41008 }, { status: 400 });
        if (fail) return new Response('busy', { status: 503 });
        return Response.json({ code: 0, data: { stoken: 'tok' } });
    };
    const probe = async () => {
        const writes = [];
        const response = await worker.fetch(new Request('https://worker.test/api/resource/quark-status?id=busy1&pwd=busy1:Ab12', {
            headers: { 'cf-connecting-ip': '198.51.100.9' }
        }), { QUARK_PASSCODE_ATTEMPTS: coordinator }, { waitUntil(promise) { writes.push(promise); } });
        await Promise.all(writes);
        return response.json();
    };
    const first = await probe();
    assert.deepEqual(first.unknown, ['busy1'], 'an unanswered passcode is inconclusive');
    assert.ok(![...entries.keys()].some(key => key.includes('quark-share-verify')), 'and nothing is cached');
    fail = false;
    assert.deepEqual((await probe()).passcodeVerified, ['busy1'], 'the next check asks again');
});


test('the share coordinator atomically reserves slots and releases a completed one', async t => {
    const binding = testQuarkAttempts(t);
    const share = binding.getByName('local-share');
    const reserve = async () => (await share.fetch('https://local.test/', { method: 'POST' })).json();
    const reservations = await Promise.all([reserve(), reserve(), reserve()]);
    assert.equal(reservations.filter(Boolean).length, 2);
    assert.equal(await reserve(), null);
    await share.fetch('https://local.test/', { method: 'DELETE', body: reservations.find(Boolean) });
    assert.equal(typeof await reserve(), 'string');
});

test('an attempt Quark never answered holds its slot for ten minutes, not the hour', async t => {
    const binding = testQuarkAttempts(t);
    const share = binding.getByName('slow-share');
    const endpoint = 'https://local.test/';
    const reserve = async () => (await share.fetch(endpoint, { method: 'POST' })).json();
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const unanswered = await reserve();
    const refused = await reserve();
    assert.equal(await reserve(), null);
    await share.fetch(endpoint, { method: 'PATCH', body: unanswered });
    now += 11 * 60_000;
    assert.equal(typeof await reserve(), 'string', 'the unanswered slot is free after ten minutes');
    assert.equal(await reserve(), null, 'the refused one is still held');
    now += 50 * 60_000;
    assert.equal(typeof await reserve(), 'string', 'and is free after the hour');
    assert.ok(refused);
});

test('a passcode check that times out shortens its reservation instead of keeping it for the hour', async t => {
    const coordinator = testQuarkAttempts(t);
    const methods = [];
    const binding = { getByName(name) {
        const stub = coordinator.getByName(name);
        return { fetch: (url, options = {}) => { methods.push(options.method); return stub.fetch(url, options); } };
    } };
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
    globalThis.fetch = async (url, options = {}) => {
        const { passcode } = JSON.parse(options.body);
        if (!passcode) return Response.json({ code: 41008 }, { status: 400 });
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };
    const writes = [];
    const response = await worker.fetch(new Request('https://worker.test/api/resource/quark-status?id=slow1&pwd=slow1:Ab12', {
        headers: { 'cf-connecting-ip': '198.51.100.21' }
    }), { QUARK_PASSCODE_ATTEMPTS: binding }, { waitUntil(promise) { writes.push(promise); } });
    await Promise.all(writes);
    assert.deepEqual((await response.json()).unknown, ['slow1']);
    assert.deepEqual(methods, ['POST', 'PATCH']);
});
