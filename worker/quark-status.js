import { isQuarkShareId, QUARK_CHECK_BATCH_SIZE } from '../js/quark.js';
import { forEachWithConcurrency, jsonResponse } from './core.js';
import { probeQuarkShare } from './quark-share.js';

export async function handleQuarkStatus(ids, ctx) {
    if (ids.length === 0 || ids.length > QUARK_CHECK_BATCH_SIZE || !ids.every(isQuarkShareId)) {
        return jsonResponse({ error: 'Invalid Quark share IDs' }, 400);
    }
    const uniqueIds = [...new Set(ids)];
    const statuses = new Map();
    await forEachWithConcurrency(uniqueIds, 4, async id => {
        statuses.set(id, (await probeQuarkShare(id, ctx)).status);
    });
    const available = uniqueIds.filter(id => statuses.get(id) === 'available');
    const passcodeRequired = uniqueIds.filter(id => statuses.get(id) === 'passcode_required');
    const unavailable = Object.fromEntries(uniqueIds.filter(id => statuses.get(id)
        && statuses.get(id) !== 'available' && statuses.get(id) !== 'passcode_required').map(id => [id, statuses.get(id)]));
    const unknown = uniqueIds.filter(id => statuses.get(id) === undefined);
    return jsonResponse({ unavailable, unknown, available, passcodeRequired });
}
