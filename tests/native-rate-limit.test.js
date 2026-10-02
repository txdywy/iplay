import test from 'node:test';
import assert from 'node:assert/strict';
import { probeNativeRateLimit } from './helpers/native-rate-limit.js';

test('native rate-limit verification recovers from a real wall-clock window rollover', async () => {
    let nowMs = 59900;
    let calls = 0;
    const buckets = new Map();
    const dispatch = async key => {
        if (++calls === 31) nowMs = 60100;
        const epoch = Math.floor(nowMs / 60000);
        const bucket = buckets.get(key);
        const count = bucket?.epoch === epoch ? bucket.count : 0;
        buckets.set(key, { epoch, count: count + 1 });
        return new Response(null, { status: count >= 60 ? 429 : 404, headers: { 'Retry-After': '60' } });
    };
    const response = await probeNativeRateLimit(dispatch, { limit: 60, periodSeconds: 60, now: () => nowMs });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
});

test('native rate-limit verification fails when a stable window never returns HTTP 429', async () => {
    await assert.rejects(probeNativeRateLimit(async () => new Response(null, { status: 404 }), {
        now: () => 10000
    }), /Rate limiting is missing inside an unchanged wall-clock window/);
});

test('native rate-limit verification does not hide premature throttling or unrelated runtime errors', async () => {
    for (const status of [429, 503]) {
        await assert.rejects(probeNativeRateLimit(async () => new Response(null, { status }), {
            now: () => 10000
        }), /Requests within the configured quota must remain allowed/);
    }
});

test('native rate-limit verification cannot pass by continually crossing windows', async () => {
    let nowMs = 0;
    await assert.rejects(probeNativeRateLimit(async () => {
        nowMs += 60000;
        return new Response(null, { status: 404 });
    }, { now: () => nowMs }), /all three attempts; no HTTP 429 was verified/);
});
