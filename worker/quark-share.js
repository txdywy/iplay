import {
    cacheJson, fetchUpstream, isDeadlineExpired, readJsonWithLimit, releaseUpstreamResponse, remainingDeadlineMs, serveCachedJson
} from './core.js';

// Quark's public share client asks these two endpoints when a visitor opens a
// share link: one issues a short-lived share token, the other lists a folder.
// Both work without an account, and neither is used to download anything.
const SHARE_TOKEN_URL = 'https://drive-h.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=';
const SHARE_DETAIL_URL = 'https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail';
// Quark answers in two to three seconds from the edge on a slow day, so the
// default leaves room; a caller with a longer deadline can allow more.
const CHECK_TIMEOUT_MS = 4500;
const CHECK_CACHE_SECONDS = 300;
const MAX_TOKEN_RESPONSE_BYTES = 24 * 1024;
const MAX_DETAIL_RESPONSE_BYTES = 128 * 1024;
const LISTING_PAGE_SIZE = 8;
const MAX_LISTED_ENTRIES = 4;
const MAX_NAME_LENGTH = 120;

// Definitive failures used by Quark's public share client. Account and visit
// limits are inconclusive, while a passcode prompt has its own status.
export const UNAVAILABLE_BY_CODE = new Map([
    [41004, 'missing_files'],
    [41006, 'missing'],
    [41009, 'deleted'],
    [41010, 'blocked'],
    [41011, 'invalid'],
    [41012, 'cancelled'],
    [41019, 'expired'],
    // The sharer's account is banned: the link exists but cannot be viewed.
    [41031, 'restricted']
]);

const REQUEST_HEADERS = {
    'Accept': 'application/json',
    'Origin': 'https://pan.quark.cn',
    'Referer': 'https://pan.quark.cn/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
};

// `budget` ({ remaining }) bounds how many requests one Worker invocation
// spends on Quark; a spent budget makes the check inconclusive.
function spend(budget) {
    if (!budget) return true;
    if (budget.remaining <= 0) return false;
    budget.remaining -= 1;
    return true;
}

async function requestShareToken(id, passcode, budget, timeoutMs) {
    if (!spend(budget)) return undefined;
    const response = await fetchUpstream(SHARE_TOKEN_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pwd_id: id, passcode, support_visit_limit_private_share: true })
    }, timeoutMs);
    if (!response.ok && ![400, 403, 404, 410].includes(response.status)) {
        await releaseUpstreamResponse(response);
        return undefined;
    }
    return { ok: response.ok, data: await readJsonWithLimit(response, MAX_TOKEN_RESPONSE_BYTES) };
}

function classifyToken(result) {
    const data = result?.data;
    if (UNAVAILABLE_BY_CODE.has(data?.code)) return UNAVAILABLE_BY_CODE.get(data.code);
    if (data?.code === 41008) return 'passcode_required';
    const tokenIssued = result?.ok && data?.code === 0 && typeof data.data?.stoken === 'string' && data.data.stoken.length > 0;
    return tokenIssued ? 'available' : undefined;
}

function cleanName(value) {
    return typeof value === 'string'
        // eslint-disable-next-line no-control-regex
        ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH)
        : '';
}

// The top level of a share is enough to tell whether it holds the work it is
// advertised as: a folder named after the series, or a few video files.
async function listShareTopLevel(id, stoken, budget, timeoutMs) {
    if (!spend(budget)) return null;
    const url = new URL(SHARE_DETAIL_URL);
    for (const [key, value] of Object.entries({
        pr: 'ucpro', fr: 'pc', uc_param_str: '', pwd_id: id, stoken, pdir_fid: '0', force: '0',
        _page: '1', _size: String(LISTING_PAGE_SIZE), _fetch_banner: '0', _fetch_share: '0', _fetch_total: '1',
        _sort: 'file_type:asc,updated_at:desc'
    })) url.searchParams.set(key, value);
    const response = await fetchUpstream(url.href, { redirect: 'manual', headers: REQUEST_HEADERS }, timeoutMs);
    if (!response.ok) {
        await releaseUpstreamResponse(response);
        return null;
    }
    const data = await readJsonWithLimit(response, MAX_DETAIL_RESPONSE_BYTES);
    if (data?.code !== 0 || !Array.isArray(data.data?.list)) return null;
    const entries = data.data.list
        .map(entry => ({ name: cleanName(entry?.file_name), dir: entry?.dir === true }))
        .filter(entry => entry.name)
        .slice(0, MAX_LISTED_ENTRIES);
    const total = Number(data.metadata?._total);
    return { entries, totalItems: Number.isSafeInteger(total) && total >= entries.length ? total : entries.length };
}

async function passcodeKey(passcode) {
    if (!passcode) return '';
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(`quark-passcode:${passcode}`));
    return [...new Uint8Array(digest).slice(0, 6)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Wrong passcodes a share may take from all callers together in an hour.
// The check exists to confirm a passcode a page listed, not to guess one.
const MAX_FAILED_PASSCODES = 2;
const FAILED_PASSCODE_WINDOW_SECONDS = 3600;

function failedPasscodeKey(id) {
    return new Request(`https://quark-passcode-failures-v1.local/${id}`);
}

async function failedPasscodeCount(id) {
    const cached = await serveCachedJson(failedPasscodeKey(id));
    const count = Number((await cached?.json().catch(() => null))?.count);
    return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Checks a Quark share the way a visitor's browser would.
 *
 * `status` is one of: available, passcode_required, passcode_mismatch, an
 * unavailable reason (see UNAVAILABLE_BY_CODE), or undefined when the check
 * was inconclusive. When the share asks for a passcode and one is supplied,
 * it is submitted once, unless the share has already refused
 * MAX_FAILED_PASSCODES passcodes this hour; success is `passcodeVerified`.
 * Every request is bounded by `deadline` when one is given; a step that would
 * start after it is skipped and the check is inconclusive.
 * Only the status and a few folder names are cached or returned, and only
 * from a complete check. The token response (author, credential) never
 * leaves this function.
 */
export async function probeQuarkShare(id, ctx, { passcode = '', listing = false, budget = null, timeoutMs = CHECK_TIMEOUT_MS, deadline = null } = {}) {
    const extended = Boolean(passcode) || listing;
    const cacheKey = extended
        ? new Request(`https://quark-share-verify-v1-cache.local/${id}?pw=${await passcodeKey(passcode)}&list=${listing ? 1 : 0}`)
        : new Request('https://quark-share-status-v2-cache.local/' + id);
    // The time a step may take, or null once the deadline has passed.
    const stepTimeout = () => (deadline ? (isDeadlineExpired(deadline) ? null : remainingDeadlineMs(deadline, timeoutMs)) : timeoutMs);
    try {
        const cached = await serveCachedJson(cacheKey);
        if (cached) return await cached.json();

        const firstTimeout = stepTimeout();
        if (firstTimeout === null) return { status: undefined };
        const first = await requestShareToken(id, '', budget, firstTimeout);
        let status = classifyToken(first);
        let tokenData = first?.data;
        let passcodeVerified = false;
        let complete = true;
        if (status === 'passcode_required' && passcode) {
            if (await failedPasscodeCount(id) >= MAX_FAILED_PASSCODES) {
                // Not tried: report what Quark said, and do not remember it.
                complete = false;
            } else {
                const secondTimeout = stepTimeout();
                const second = secondTimeout === null ? undefined : await requestShareToken(id, passcode, budget, secondTimeout);
                const retried = classifyToken(second);
                if (retried === 'available') {
                    status = 'available';
                    tokenData = second.data;
                    passcodeVerified = true;
                } else if (retried === 'passcode_required' || second?.data?.code === 41007) {
                    status = 'passcode_mismatch';
                    const failures = await failedPasscodeCount(id);
                    cacheJson(ctx, failedPasscodeKey(id), { count: failures + 1 }, FAILED_PASSCODE_WINDOW_SECONDS);
                } else if (retried) {
                    status = retried;
                } else {
                    // The passcode was never answered for: no conclusion.
                    return { status: undefined };
                }
            }
        }
        if (!status) return { status: undefined };

        const result = { status };
        if (passcodeVerified) result.passcodeVerified = true;
        if (status === 'available') {
            const title = cleanName(tokenData?.data?.title);
            if (title) result.shareTitle = title;
            if (listing) {
                const listTimeout = stepTimeout();
                const top = listTimeout === null ? null : await listShareTopLevel(id, tokenData.data.stoken, budget, listTimeout).catch(() => null);
                if (top) Object.assign(result, top);
                else complete = false;
            }
        }
        // Cache only what is safe to show (a status, a title and folder
        // names), and only when every step it depends on was answered.
        if (complete) cacheJson(ctx, cacheKey, result, CHECK_CACHE_SECONDS);
        return result;
    } catch {
        return { status: undefined };
    }
}
