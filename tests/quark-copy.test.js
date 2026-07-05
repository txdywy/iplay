import test from 'node:test';
import assert from 'node:assert/strict';

import { copyQuarkShare, formatQuarkCopyText } from '../js/quark.js';

test('formats only the normalized Quark password for copying', () => {
    assert.equal(
        formatQuarkCopyText({ password: ' a1B2 ' }),
        'a1B2'
    );
});

test('returns an empty copy value when no password was found', () => {
    assert.equal(formatQuarkCopyText({}), '');
});

test('writes only the Quark password in one clipboard action', async () => {
    const writes = [];

    await copyQuarkShare(
        { password: 'a1B2' },
        async text => writes.push(text)
    );

    assert.deepEqual(writes, ['a1B2']);
});
