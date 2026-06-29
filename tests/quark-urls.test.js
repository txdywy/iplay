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
                data: [{ id: '19033', attributes: { title: '三体 4K' } }]
            });
        }

        if (value.startsWith('https://www.wpzys.org/search.htm')) {
            return new Response('', { status: 200 });
        }

        if (value === 'https://by669.org/d/19033') {
            return new Response([
                '[夸克](https://pan.quark.cn/s/3c6b77320fe6](https://v.v8l.cn/s/ZqoQAxx)',
                '"https:\\/\\/pan.quark.cn\\/s\\/3c6b77320fe6\\u0022',
                'https://pan.quark.cn/s/3c6b77320fe6\\u003C/a\\u003E\\u003C/p\\u003E',
                'https://pan.quark.cn/s/3c6b77320fe6\\r\\n\\r\\n导演：'
            ].join('\n'), { status: 200 });
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

    assert.deepEqual(
        result.quarkUrls.map(item => item.url),
        ['https://pan.quark.cn/s/3c6b77320fe6']
    );
});
