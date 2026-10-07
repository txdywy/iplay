import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/_worker.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

let fixtureClient = 0;
function resourceRequest(url) {
    fixtureClient += 1;
    return new Request(url, { headers: { 'cf-connecting-ip': `203.0.113.${fixtureClient}` } });
}

async function searchQuarkPages(t, pages) {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    globalThis.caches = { default: { match: async () => null, put: async () => undefined } };
    globalThis.fetch = async url => {
        const value = String(url);
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: pages.map((_, index) => ({
                id: String(index + 1), attributes: { title: `配对测试 ${index + 1} 夸克` }
            })) });
        }
        if (value.startsWith('https://wpzy.org/search.htm')) return new Response(WPZY_EMPTY_SEARCH_HTML);
        const page = /^https:\/\/by669\.org\/d\/(\d+)$/.exec(value);
        if (page) return new Response(pages[Number(page[1]) - 1]);
        throw new Error(`Unexpected fetch: ${value}`);
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
    });
    const response = await worker.fetch(resourceRequest('https://worker.test/api/resource?q=配对测试'), {}, { waitUntil() {} });
    assert.equal(response.status, 200);
    const result = await response.json();
    for (const item of result.quarkUrls) {
        assert.ok(Object.keys(item).every(key => ['title', 'url', 'password', 'sourceUrl', 'sourceTitle'].includes(key)));
    }
    return result.quarkUrls.map(({ url, password }) => ({ url, ...(password ? { password } : {}) }));
}

test('resource search pairs each following password with its own link, not the next link label', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>链接：https://pan.quark.cn/s/first 提取码：a1B2</p>'
        + '<p>链接：https://pan.quark.cn/s/second 提取码：c3D4</p>'
    ]), [
        { url: 'https://pan.quark.cn/s/first', password: 'a1B2' },
        { url: 'https://pan.quark.cn/s/second', password: 'c3D4' }
    ]);
});

test('resource search never attaches a Baidu share password to the preceding Quark share', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>夸克：https://pan.quark.cn/s/quark-public '
        + '百度：https://pan.baidu.com/s/baidu-share?pwd=6868 提取码：6868</p>'
    ]), [{ url: 'https://pan.quark.cn/s/quark-public' }]);
});

test('resource search binds a leading password inside the next paragraph to that paragraph link', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/no-code</p>'
        + '<p>提取码：b2C3 https://pan.quark.cn/s/leading-code</p>'
    ]), [
        { url: 'https://pan.quark.cn/s/no-code' },
        { url: 'https://pan.quark.cn/s/leading-code', password: 'b2C3' }
    ]);
});

test('resource search reads formatted passwords next to an anchor whose visible text is not a URL', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p><a href="https://pan.quark.cn/s/formatted" class="' + 'x'.repeat(180)
        + '">下载夸克资源</a><strong>提取码：</strong><span><code>a1B2</code></span></p>'
    ]), [{ url: 'https://pan.quark.cn/s/formatted', password: 'a1B2' }]);
});

test('resource search does not carry a preceding foreign share password forward to a Quark link', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>百度：https://pan.baidu.com/s/baidu-first 提取码：6868</p>'
        + '<p>夸克：https://pan.quark.cn/s/quark-next</p>'
    ]), [{ url: 'https://pan.quark.cn/s/quark-next' }]);
});

test('resource search prefers a password embedded in the same share URL over nearby duplicate prose', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/duplicate 提取码：old1</p>'
        + '<p>https://pan.quark.cn/s/duplicate?pwd=new2</p>'
    ]), [{ url: 'https://pan.quark.cn/s/duplicate', password: 'new2' }]);
});

test('resource search omits conflicting equally supported passwords across duplicate pages', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/conflict 提取码：a1B2</p>',
        '<p>https://pan.quark.cn/s/conflict 提取码：c3D4</p>',
        '<p>https://pan.quark.cn/s/conflict 提取码：a1B2</p>'
    ]), [{ url: 'https://pan.quark.cn/s/conflict' }]);
});

test('resource search does not borrow passwords from another card or footer', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<div class="post"><p>https://pan.quark.cn/s/card-public</p></div>'
        + '<footer>访问码：other1</footer>'
    ]), [{ url: 'https://pan.quark.cn/s/card-public' }]);
});

test('resource search does not truncate an overlong password token into a plausible code', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/malformed 提取码：abcdefghijklmnop</p>'
    ]), [{ url: 'https://pan.quark.cn/s/malformed' }]);
});

test('resource search does not treat a provider-labelled Baidu code as a Quark password', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/public-with-note 百度提取码：6868</p>'
    ]), [{ url: 'https://pan.quark.cn/s/public-with-note' }]);
});

test('resource search omits conflicting password parameters in one URL instead of guessing from prose', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/query-conflict?pwd=a1B2&amp;password=c3D4 提取码：a1B2</p>'
    ]), [{ url: 'https://pan.quark.cn/s/query-conflict' }]);
});

test('resource search pairs table row cells and respects rendered br line breaks', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<table><tr><td>https://pan.quark.cn/s/table-one</td><td>提取码：row1</td></tr>'
        + '<tr><td>https://pan.quark.cn/s/table-two</td><td>提取码：row2</td></tr></table>',
        '<p>https://pan.quark.cn/s/line-public<br>提取码：line3 https://pan.quark.cn/s/line-private</p>'
    ]), [
        { url: 'https://pan.quark.cn/s/table-one', password: 'row1' },
        { url: 'https://pan.quark.cn/s/table-two', password: 'row2' },
        { url: 'https://pan.quark.cn/s/line-public' },
        { url: 'https://pan.quark.cn/s/line-private', password: 'line3' }
    ]);
});

test('resource search keeps duplicate markup and foreign codes from consuming unique link and password limits', async t => {
    const foreign = Array.from({ length: 30 }, (_, i) => `<p>https://pan.baidu.com/s/foreign-${i} 提取码：other${i}</p>`).join('');
    const duplicates = '<p>https://pan.quark.cn/s/repeated</p>'.repeat(30);
    const unique = Array.from({ length: 24 }, (_, i) => `<p>https://pan.quark.cn/s/unique-${i} 提取码：code${i}</p>`).join('');
    assert.deepEqual(await searchQuarkPages(t, [foreign + duplicates + unique]), [
        { url: 'https://pan.quark.cn/s/repeated' },
        ...Array.from({ length: 24 }, (_, i) => ({ url: `https://pan.quark.cn/s/unique-${i}`, password: `code${i}` }))
    ]);
});

test('resource search resolves an earlier prose conflict with a later URL-bound password', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>https://pan.quark.cn/s/resolved 提取码：a1B2</p><p>https://pan.quark.cn/s/resolved 提取码：c3D4</p>',
        '<p>https://pan.quark.cn/s/resolved#pwd=r5T6</p>'
    ]), [{ url: 'https://pan.quark.cn/s/resolved', password: 'r5T6' }]);
});

test('resource search canonicalizes case-insensitive schemes and hosts without changing share tokens', async t => {
    assert.deepEqual(await searchQuarkPages(t, [
        '<p>HTTPS://PAN.QUARK.CN/s/AbC123?pwd=a1B2</p>'
    ]), [{ url: 'https://pan.quark.cn/s/AbC123', password: 'a1B2' }]);
});

test('resource search keeps only canonical Quark share URLs from escaped page content', async t => {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;

    globalThis.caches = {
        default: {
            match: async () => null,
            put: async () => undefined
        }
    };

    globalThis.fetch = async url => {
        const value = String(url);

        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({
                data: [
                    { id: '19033', attributes: { title: '三体 4K' } },
                    { id: '19034', attributes: { title: '三体 夸克备用' } }
                ]
            });
        }

        if (value.startsWith('https://wpzy.org/search.htm')) {
            return new Response('', { status: 200 });
        }

        if (value === 'https://by669.org/d/19033') {
            return new Response([
                '[夸克](https://pan.quark.cn/s/3c6b77320fe6) 提取码：a1B2',
                '"https:\\/\\/pan.quark.cn\\/s\\/3c6b77320fe6\\u0022',
                'https://pan.quark.cn/s/3c6b77320fe6\\u003C/a\\u003E\\u003C/p\\u003E',
                'https://pan.quark.cn/s/3c6b77320fe6\\r\\n\\r\\n导演：',
                '密码 = Z9y8；链接：https://drive.quark.cn/s/before-pass',
                'https:\\/\\/pan.quark.cn\\/s\\/escaped-pass\\r\\n访问码%3Ac3D4',
                'URL 参数密码 https://pan.quark.cn/s/query-pass?pwd=q7R8',
                'Hash 参数密码 https://drive.quark.cn/s/hash-pass#pwd=h5K6',
                'https://pan.quark.cn/s/no-pass',
                '再次分享 https://pan.quark.cn/s/no-pass 提取码：n0P5',
                'https://pan.quark.cn/s/cross-page'
            ].join('\n'), { status: 200 });
        }

        if (value === 'https://by669.org/d/19034') {
            return new Response('https://pan.quark.cn/s/cross-page 提取码：m3Rg', { status: 200 });
        }

        throw new Error(`Unexpected fetch: ${value}`);
    };

    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
    });

    const response = await worker.fetch(
        resourceRequest('https://worker.test/api/resource?q=%E4%B8%89%E4%BD%93'),
        {},
        { waitUntil() {} }
    );
    const result = await response.json();

    assert.deepEqual(result.quarkUrls.map(({ url, password }) => ({ url, password })), [
        { url: 'https://pan.quark.cn/s/3c6b77320fe6', password: 'a1B2' },
        { url: 'https://drive.quark.cn/s/before-pass', password: 'Z9y8' },
        { url: 'https://pan.quark.cn/s/escaped-pass', password: 'c3D4' },
        { url: 'https://pan.quark.cn/s/query-pass', password: 'q7R8' },
        { url: 'https://drive.quark.cn/s/hash-pass', password: 'h5K6' },
        { url: 'https://pan.quark.cn/s/no-pass', password: 'n0P5' },
        { url: 'https://pan.quark.cn/s/cross-page', password: 'm3Rg' }
    ]);
});
