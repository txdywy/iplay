import { isQuarkShareId, QUARK_CHECK_BATCH_SIZE } from '../js/quark.js';
import {
    cacheJson, fetchUpstream, forEachWithConcurrency, jsonResponse, readJsonWithLimit,
    releaseUpstreamResponse, serveCachedJson
} from './core.js';

const SHARE_TOKEN_URL = 'https://drive-h.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=';
const CHECK_TIMEOUT_MS = 3200;
const CHECK_CACHE_SECONDS = 300;
const MAX_TOKEN_RESPONSE_BYTES = 24 * 1024;

// Definitive states used by Quark's public share client. A passcode prompt,
// login requirement, visit limit or expired access token is inconclusive.
const UNAVAILABLE_BY_CODE = new Map([
    [41004, 'missing_files'],
    [41006, 'missing'],
    [41009, 'deleted'],
    [41010, 'blocked'],
    [41011, 'invalid'],
    [41012, 'cancelled'],
    [41019, 'expired']
]);

async function checkShare(id, ctx) {
    const cacheKey = new Request('https://quark-share-status-v1-cache.local/' + id);
    try {
        const cached = await serveCachedJson(cacheKey);
        if (cached) return (await cached.json()).reason;

        const response = await fetchUpstream(SHARE_TOKEN_URL, {
            method: 'POST',
            redirect: 'manual',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Origin': 'https://pan.quark.cn',
                'Referer': 'https://pan.quark.cn/',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            },
            body: JSON.stringify({ pwd_id: id, passcode: '', support_visit_limit_private_share: true })
        }, CHECK_TIMEOUT_MS);
        if (!response.ok && ![400, 403, 404, 410].includes(response.status)) {
            await releaseUpstreamResponse(response);
            return undefined;
        }

        const data = await readJsonWithLimit(response, MAX_TOKEN_RESPONSE_BYTES);
        const reason = UNAVAILABLE_BY_CODE.get(data?.code) ?? null;
        const requiresPasscode = data?.code === 41008;
        const tokenIssued = response.ok && data?.code === 0 && typeof data.data?.stoken === 'string' && data.data.stoken.length > 0;
        if (reason || requiresPasscode || tokenIssued) {
            // Cache only the status. Quark's token response can include
            // author information and a temporary access credential.
            cacheJson(ctx, cacheKey, { reason }, CHECK_CACHE_SECONDS);
            return reason;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

export async function handleQuarkStatus(ids, ctx) {
    if (ids.length === 0 || ids.length > QUARK_CHECK_BATCH_SIZE || !ids.every(isQuarkShareId)) {
        return jsonResponse({ error: 'Invalid Quark share IDs' }, 400);
    }
    const uniqueIds = [...new Set(ids)];
    const statuses = new Map();
    await forEachWithConcurrency(uniqueIds, 4, async id => {
        statuses.set(id, await checkShare(id, ctx));
    });
    const unavailable = Object.fromEntries(uniqueIds.filter(id => statuses.get(id)).map(id => [id, statuses.get(id)]));
    const unknown = uniqueIds.filter(id => statuses.get(id) === undefined);
    return jsonResponse({ unavailable, unknown });
}
