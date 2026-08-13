import test from 'node:test';
import assert from 'node:assert/strict';

const originalLocation = globalThis.location;
globalThis.location = { hostname: 'localhost' };
const { ResourceAPI } = await import('../js/api.js');
globalThis.location = originalLocation;

test('resource API propagates provider failures to the UI layer', async t => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(
        { error: 'Resource providers unavailable' },
        { status: 502 }
    );
    t.after(() => { globalThis.fetch = originalFetch; });

    await assert.rejects(
        ResourceAPI.search('test'),
        /Resource providers unavailable/
    );
});
