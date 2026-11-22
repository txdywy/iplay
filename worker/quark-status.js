import { isQuarkShareId, QUARK_CHECK_BATCH_SIZE } from '../js/quark.js';
import { createDeadline, forEachWithConcurrency, jsonResponse } from './core.js';
import { probeQuarkShare } from './quark-share.js';
import { isValidQuarkPassword } from './resources.js';

// Workers keep at most six connections open per request.
const CHECK_CONCURRENCY = 6;
// Quark answers in three to four seconds from the edge on a slow day, now and
// then in more than four and a half. Each step may take seven; the batch as a
// whole stops at fifteen, inside the page's twenty-second wait.
const CHECK_STEP_TIMEOUT_MS = 7000;
const CHECK_BATCH_DEADLINE_MS = 15000;

// `pwd=<id>:<code>` supplies the passcode a page listed for a share; it is
// submitted once, only when Quark asks for one. `content=1` also reads the
// share's top level, which tells an empty share from one with files.
function parsePasscodes(entries) {
    const codes = new Map();
    for (const entry of entries.slice(0, QUARK_CHECK_BATCH_SIZE)) {
        const separator = String(entry).lastIndexOf(':');
        const id = String(entry).slice(0, separator);
        const code = String(entry).slice(separator + 1);
        if (separator > 0 && isQuarkShareId(id) && isValidQuarkPassword(code)) codes.set(id, code);
    }
    return codes;
}

export async function handleQuarkStatus(ids, ctx, { passcodes = [], content = false } = {}) {
    if (ids.length === 0 || ids.length > QUARK_CHECK_BATCH_SIZE || !ids.every(isQuarkShareId)) {
        return jsonResponse({ error: 'Invalid Quark share IDs' }, 400);
    }
    const uniqueIds = [...new Set(ids)];
    const codes = parsePasscodes(passcodes);
    // Token, one passcode attempt and one listing per share at most.
    const budget = { remaining: uniqueIds.length * 3 };
    const results = new Map();
    const deadline = createDeadline(CHECK_BATCH_DEADLINE_MS);
    await forEachWithConcurrency(uniqueIds, CHECK_CONCURRENCY, async id => {
        results.set(id, await probeQuarkShare(id, ctx, {
            passcode: codes.get(id) || '', listing: content, budget, timeoutMs: CHECK_STEP_TIMEOUT_MS, deadline
        }));
    });
    const status = id => results.get(id)?.status;
    const available = uniqueIds.filter(id => status(id) === 'available');
    const passcodeRequired = uniqueIds.filter(id => status(id) === 'passcode_required');
    const passcodeMismatch = uniqueIds.filter(id => status(id) === 'passcode_mismatch');
    const unavailable = Object.fromEntries(uniqueIds
        .filter(id => status(id) && !['available', 'passcode_required', 'passcode_mismatch'].includes(status(id)))
        .map(id => [id, status(id)]));
    const unknown = uniqueIds.filter(id => status(id) === undefined);
    const body = { unavailable, unknown, available, passcodeRequired };
    if (codes.size) {
        body.passcodeVerified = available.filter(id => results.get(id).passcodeVerified);
        body.passcodeMismatch = passcodeMismatch;
    }
    if (content) {
        // Only what a visitor of the share would see: how many top-level items
        // and the first few names.
        body.content = Object.fromEntries(available
            .filter(id => Number.isInteger(results.get(id).totalItems))
            .map(id => [id, { items: results.get(id).totalItems, names: (results.get(id).entries || []).map(entry => entry.name) }]));
    }
    return jsonResponse(body);
}
