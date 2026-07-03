import test from 'node:test';
import assert from 'node:assert/strict';

import { copyQuarkShare, formatQuarkCopyText } from '../js/quark.js';

test('formats a Quark URL and password for one-click copying', () => {
    assert.equal(
        formatQuarkCopyText({ url: 'https://pan.quark.cn/s/demo', password: ' a1B2 ' }),
        'https://pan.quark.cn/s/demo\n提取码：a1B2'
    );
});

test('copies only the Quark URL when no password was found', () => {
    assert.equal(
        formatQuarkCopyText({ url: 'https://pan.quark.cn/s/demo' }),
        'https://pan.quark.cn/s/demo'
    );
});

test('writes the combined Quark share text in one clipboard action', async () => {
    const writes = [];

    await copyQuarkShare(
        { url: 'https://pan.quark.cn/s/demo', password: 'a1B2' },
        async text => writes.push(text)
    );

    assert.deepEqual(writes, ['https://pan.quark.cn/s/demo\n提取码：a1B2']);
});
