import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/_worker.js';

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

        if (value.startsWith('https://www.wpzys.org/search.htm')) {
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
        new Request('https://worker.test/api/resource?q=%E4%B8%89%E4%BD%93'),
        {},
        { waitUntil() {} }
    );
    const result = await response.json();

    assert.deepEqual(result.quarkUrls.map(({ url, password }) => ({ url, password })), [
        { url: 'https://pan.quark.cn/s/3c6b77320fe6', password: 'a1B2' },
        { url: 'https://drive.quark.cn/s/before-pass', password: 'Z9y8' },
        { url: 'https://pan.quark.cn/s/escaped-pass', password: 'c3D4' },
        { url: 'https://pan.quark.cn/s/no-pass', password: 'n0P5' },
        { url: 'https://pan.quark.cn/s/cross-page', password: 'm3Rg' }
    ]);
});
