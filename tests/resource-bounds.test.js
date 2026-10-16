import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import worker from '../worker/_worker.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

function setup(t, { pages, discussions, cookie = '' }) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const entries = new Map();
    const writes = [];
    const calls = [];
    globalThis.caches = { default: {
        match: async key => entries.get(key.url)?.clone() || null,
        put: async (key, response) => { entries.set(key.url, response); }
    } };
    globalThis.fetch = async input => {
        const url = new URL(input);
        calls.push(url);
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.pathname === '/api/discussions') return Response.json({ data: discussions || pages.map((_, i) => ({
            id: String(i + 1), attributes: { title: 'Bounded resource 夸克' }
        })) });
        return new Response(pages[Number(url.pathname.split('/').at(-1)) - 1]);
    };
    t.after(() => Object.assign(globalThis, previous));
    return { entries, calls, async search(refresh = false) {
        const response = await worker.fetch(new Request(`https://worker.test/api/resource?q=Bounded${refresh ? '&refresh=1' : ''}`, {
            headers: { 'cf-connecting-ip': t.name }
        }), cookie ? { WPZY_COOKIE: cookie } : {}, { waitUntil(promise) { writes.push(promise); } });
        const text = await response.text();
        await Promise.all(writes.splice(0));
        return { response, text, data: JSON.parse(text) };
    } };
}

test('overlong share tokens are rejected whole without exposing a shortened prefix', async t => {
    const accepted = 'a'.repeat(128);
    const rejected = 'b'.repeat(129);
    const { search } = setup(t, { pages: [
        `<p>https://pan.quark.cn/s/${rejected}?pwd=bad1</p>`
        + `<p>https://pan.quark.cn/s/${accepted}?pwd=good2</p>`
    ] });
    const { data } = await search();
    assert.deepEqual(data.quarkUrls.map(item => item.url), [`https://pan.quark.cn/s/${accepted}`]);
    assert.equal(data.quarkUrls[0].password, 'good2');
    assert.deepEqual(data.resourceMeta.pages[0].quarkUrls.map(item => item.url), [`https://pan.quark.cn/s/${accepted}`]);
});

test('overlong raw share URLs cannot bypass the limit through removable query or hash data', async t => {
    const { search } = setup(t, { pages: [
        `<p>https://pan.quark.cn/s/query?note=${'a'.repeat(2100)}&pwd=bad1</p>`
        + `<p>https://pan.quark.cn/s/hash#${'a'.repeat(2100)}</p>`
        + '<p>https://pan.quark.cn/s/normal?pwd=good2</p>'
    ] });
    const { data } = await search();
    assert.deepEqual(data.quarkUrls.map(item => item.url), ['https://pan.quark.cn/s/normal']);
});

test('near-limit detail pages cannot amplify aggregate resource responses with giant share tokens', async t => {
    const { search } = setup(t, { pages: Array.from({ length: 12 }, (_, i) =>
        `https://pan.quark.cn/s/${i}${'a'.repeat(1900000)}`) });
    const { response, data, text } = await search();
    assert.equal(response.status, 200);
    assert.equal(data.resourceMeta.attemptedPages, 12);
    assert.equal(data.quarkUrls.length, 0);
    assert.ok(Buffer.byteLength(text) < 10000, `Unexpected aggregate output: ${Buffer.byteLength(text)} bytes`);
    assert.ok(data.resourceMeta.pages.every(page => page.quarkUrls.length === 0));
});

test('source metadata remains bounded with maximum-length titles and encoded discussion IDs', async t => {
    const discussions = Array.from({ length: 50 }, (_, i) => ({
        id: `${i}${'界'.repeat(198)}`, attributes: { title: '界'.repeat(10000) }
    }));
    const { search, calls } = setup(t, { pages: [], discussions });
    const { data, text } = await search();
    assert.equal(data.resources.length, 50);
    assert.ok(data.resources.every(item => item.title.length <= 300 && item.url.length <= 2048));
    assert.ok(calls.filter(url => url.pathname.startsWith('/d/')).every(url => url.href.length <= 2048));
    assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
});

test('resource browser responses are no-store on misses, hits and refreshes while edge copies keep their TTL', async t => {
    const { search, entries, calls } = setup(t, { pages: ['https://pan.quark.cn/s/cache-boundary'], cookie: 'bbs_token=server-test-session' });
    for (const refresh of [false, false, true]) {
        const previousCalls = calls.length;
        const { response, data } = await search(refresh);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(data.quarkUrls[0]?.url, 'https://pan.quark.cn/s/cache-boundary');
        assert.equal(entries.size, 1);
        assert.equal([...entries.values()][0].headers.get('cache-control'), 'public, max-age=43200');
        if (previousCalls && !refresh) assert.equal(calls.length, previousCalls, 'the Worker cache remains usable');
    }
});
