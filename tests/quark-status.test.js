import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/_worker.js';

test('Quark status labels only confirmed failures and caches no upstream account data', async t => {
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
            wrong: 41007, 'missing-files': 41004, blocked: 41010, invalid: 41011
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
        const response = await worker.fetch(request, { RESOURCE_RATE_LIMITER: limiter }, {
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
    assert.deepEqual(await response.json(), { unavailable });
    assert.equal(calls.get('Missing'), 1);
    assert.deepEqual(await (await probe(ids)).json(), { unavailable });
    for (const id of ['Missing', 'deleted', 'expired', 'cancelled', 'protected', 'live']) assert.equal(calls.get(id), 1);
    for (const id of ['unknown', 'limited', 'timeout', 'wrong']) assert.equal(calls.get(id), 2);
    const additional = await probe(['missing-files', 'blocked', 'invalid', 'egress-error', 'redirect']);
    assert.deepEqual(await additional.json(), {
        unavailable: { 'missing-files': 'missing_files', blocked: 'blocked', invalid: 'invalid' }
    });
    assert.ok(limits.every(key => key === 'quark-test:quark-status'));
    for (const entry of entries.values()) {
        assert.ok(!/secret-token|private/.test(await entry.text()));
    }
});
