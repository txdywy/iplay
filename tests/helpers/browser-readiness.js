// Cold CI Chrome can need more than 15s, but an exited process or a stalled
// debug response must not consume the whole workflow timeout.
export async function waitForJson(url, predicate, { timeoutMs = 60000, child = null } = {}) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
        if (child && (child.exitCode !== null || child.signalCode)) {
            throw new Error(`Chrome exited before browser readiness (code ${child.exitCode}, signal ${child.signalCode || 'none'})`);
        }
        try {
            const remaining = timeoutMs - (Date.now() - startedAt);
            const response = await globalThis.fetch(url, {
                signal: globalThis.AbortSignal.timeout(Math.min(1000, Math.max(1, remaining)))
            });
            if (response.ok) {
                const value = await response.json();
                if (predicate(value)) return value;
            } else {
                await response.body?.cancel();
            }
        } catch (error) {
            lastError = error;
        }
        const delay = Math.min(100, timeoutMs - (Date.now() - startedAt));
        if (delay > 0) await new Promise(resolve => globalThis.setTimeout(resolve, delay));
    }
    const suffix = lastError ? ': ' + lastError.message : '';
    throw new Error('Timed out waiting for ' + url + suffix);
}
