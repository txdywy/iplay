import assert from 'node:assert/strict';

export async function probeNativeRateLimit(dispatch, { limit = 60, periodSeconds = 60, now = Date.now } = {}) {
    const periodMs = periodSeconds * 1000;
    // Native Miniflare counters use wall-clock-aligned windows. Retry only a
    // proven rollover, on a fresh key, and never accept a missing HTTP 429.
    for (let attempt = 0; attempt < 3; attempt++) {
        const startEpoch = Math.floor(now() / periodMs);
        for (let i = 0; i <= limit; i++) {
            const response = await dispatch(`native-rate-probe-${attempt}`);
            if (i === limit && response.status === 429) return response;
            assert.equal(response.status, 404, 'Requests within the configured quota must remain allowed');
            await response.body?.cancel();
            if (i === limit) {
                assert.notEqual(Math.floor(now() / periodMs), startEpoch,
                    'Rate limiting is missing inside an unchanged wall-clock window');
            }
        }
    }
    throw new Error('Rate-limit probe crossed a window in all three attempts; no HTTP 429 was verified');
}
