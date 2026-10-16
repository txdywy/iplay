// Each fetch (including body consumption) shares the remaining startup budget.
// A listening process that never sends headers must not hang the CI workflow.
async function waitForReadiness(url, readReady, { timeoutMs, child = null, processName }) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
        if (child && (child.exitCode !== null || child.signalCode)) {
            throw new Error(`${processName} exited before browser readiness (code ${child.exitCode}, signal ${child.signalCode || 'none'})`);
        }
        let response = null;
        try {
            const remaining = timeoutMs - (Date.now() - startedAt);
            response = await globalThis.fetch(url, {
                signal: globalThis.AbortSignal.timeout(Math.min(1000, Math.max(1, remaining)))
            });
            if (response.ok) {
                const ready = await readReady(response);
                if (ready) return ready.value;
            }
        } catch (error) {
            lastError = error;
        } finally {
            // HTTP readiness needs only the status; release its unread body.
            await response?.body?.cancel().catch(() => {});
        }
        const delay = Math.min(100, timeoutMs - (Date.now() - startedAt));
        if (delay > 0) await new Promise(resolve => globalThis.setTimeout(resolve, delay));
    }
    const suffix = lastError ? ': ' + lastError.message : '';
    throw new Error('Timed out waiting for ' + url + suffix);
}

// Cold CI Chrome can need more than 15s; keep its longer startup allowance.
export function waitForJson(url, predicate, { timeoutMs = 60000, child = null } = {}) {
    return waitForReadiness(url, async response => {
        const value = await response.json();
        return predicate(value) ? { value } : null;
    }, { timeoutMs, child, processName: 'Chrome' });
}

export function waitForHttp(url, { timeoutMs = 10000, child = null } = {}) {
    return waitForReadiness(url, () => ({ value: undefined }), {
        timeoutMs, child, processName: 'Static server'
    });
}
