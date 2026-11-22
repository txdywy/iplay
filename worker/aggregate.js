import {
    cacheJson, createDeadline, createHttpError, errorResponse, fetchUpstream, forEachWithConcurrency,
    isDeadlineExpired, isObject, jsonResponse, logErrorMessage, logEvent, readJsonWithLimit,
    releaseUpstreamResponse, remainingDeadlineMs, serveCachedJson, withInFlight
} from './core.js';
import { probeQuarkShare } from './quark-share.js';
import {
    createResourceTitleMatcher, getResourceTitleAliases, isValidQuarkPassword, parseQuarkUrl,
    resourceTitleHasYear, validateResourceRequest
} from './resources.js';

/**
 * Aggregated Quark search: a separate module from the forum scan.
 *
 * It asks a PanSou-compatible search API (https://github.com/fish2018/pansou,
 * which indexes many public Telegram channels and share sites) for Quark
 * shares, keeps the ones whose title names this work and year, then checks
 * each share on Quark itself. Aggregators list many dead links, so only
 * shares that are verifiably reachable are returned, with the passcode check
 * and the share's top-level folder names that show what is inside.
 */

// A public community instance. Self-hosting is easy and more dependable:
// point PANSOU_API_URL at your own. "off" (or AGGREGATE_SEARCH=0) disables it.
const DEFAULT_PANSOU_URL = 'https://so.252035.xyz';
// The community instance sometimes stalls. A second, narrower attempt (the
// Telegram channels alone answer in about two seconds) rescues most stalls.
const PANSOU_ATTEMPT_TIMEOUT_MS = 7000;
const TOTAL_TIMEOUT_MS = 28000;
// Quark is slow from the edge on some days; the module has a long deadline.
const QUARK_CHECK_TIMEOUT_MS = 6000;
const MAX_PANSOU_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS_SCANNED = 3000;
const MAX_CANDIDATES = 60;
// Workers keep at most six connections open per request.
const CHECK_CONCURRENCY = 6;
// Requests to Quark per invocation (token, passcode retry and folder listing).
// Together with the search itself this stays well under the platform limit.
const QUARK_REQUEST_BUDGET = 36;
const CACHE_SECONDS_VERIFIED = 600;
const CACHE_SECONDS_PARTIAL = 120;
// The index sometimes answers with a fraction of its usual results; such a
// thin answer is not worth keeping for long.
const THIN_INDEX_RESPONSE = 5;
const MAX_TITLE_LENGTH = 160;
const SOURCE_PATTERN = /^(?:tg|plugin):[\w.-]{1,64}$/;

export function getPansouBase(env) {
    const raw = typeof env?.PANSOU_API_URL === 'string' ? env.PANSOU_API_URL.trim() : '';
    if (/^(?:off|false|0|disabled)$/i.test(raw) || String(env?.AGGREGATE_SEARCH ?? '').trim() === '0') return null;
    try {
        const url = new URL(raw || DEFAULT_PANSOU_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsupported URL');
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        logEvent('warn', 'aggregate_config_invalid', { reason: 'PANSOU_API_URL must be an https URL without credentials, query or fragment' });
        return null;
    }
}

// Sources to try in order. PANSOU_SOURCE (all, tg or plugin) pins a single one.
function getPansouSources(env) {
    const value = typeof env?.PANSOU_SOURCE === 'string' ? env.PANSOU_SOURCE.trim().toLowerCase() : '';
    return ['all', 'tg', 'plugin'].includes(value) ? [value] : ['all', 'tg'];
}

// Books, audio dramas, soundtracks and extras are not the work itself.
const NON_VIDEO_PATTERN = /\.(?:txt|epub|mobi|azw3?|pdf|docx?)\b|有声|听书|小说|全本|原声|\bost\b|\bflac\b|壁纸|解说|混剪|预告|花絮|漫画|图解/i;

function cleanText(value, maxLength) {
    return typeof value === 'string'
        // eslint-disable-next-line no-control-regex
        ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        : '';
}

async function fetchPansouOnce(base, query, source, deadline) {
    const url = new URL(`${base}/api/search`);
    url.searchParams.set('kw', query);
    url.searchParams.set('cloud_types', 'quark');
    url.searchParams.set('res', 'merge');
    url.searchParams.set('src', source);
    const response = await fetchUpstream(url.href, {
        headers: { Accept: 'application/json' },
        redirect: 'manual'
    }, remainingDeadlineMs(deadline, PANSOU_ATTEMPT_TIMEOUT_MS));
    if (!response.ok) {
        await releaseUpstreamResponse(response);
        throw createHttpError(`PanSou rejected with status ${response.status}`, 502, 'Aggregate search unavailable');
    }
    const body = await readJsonWithLimit(response, MAX_PANSOU_BYTES);
    const items = body?.data?.merged_by_type?.quark;
    // An empty result omits the key; a malformed body is a provider fault.
    if (items === undefined && isObject(body?.data)) return [];
    if (!Array.isArray(items)) throw createHttpError('PanSou returned an invalid response', 502, 'Aggregate search unavailable');
    return items;
}

async function fetchPansou(base, query, sources, deadline) {
    let lastError;
    for (const source of sources) {
        if (isDeadlineExpired(deadline)) break;
        try {
            return await fetchPansouOnce(base, query, source, deadline);
        } catch (error) {
            lastError = error;
            logEvent('warn', 'aggregate_source_attempt_failed', { source, error: logErrorMessage(error) });
        }
    }
    throw lastError || createHttpError('Aggregate search timed out', 504, 'Upstream request timed out');
}

// Keeps shares whose own title names this work (and year) and removes
// duplicates; the newest posts come first because they are likelier to live.
function selectCandidates(items, matchesTitle, { year, mediaType }) {
    const byId = new Map();
    for (const item of items.slice(0, MAX_ITEMS_SCANNED)) {
        if (!isObject(item)) continue;
        const note = typeof item.note === 'string' ? item.note : '';
        if (!note || note.length > 4000) continue;
        const parsed = parseQuarkUrl(typeof item.url === 'string' ? item.url : '');
        if (!parsed) continue;
        if (!matchesTitle(note) || !resourceTitleHasYear(note, year, mediaType)) continue;
        const title = cleanText(note.split(/\r?\n/).find(line => line.trim()) || note, MAX_TITLE_LENGTH);
        if (NON_VIDEO_PATTERN.test(title)) continue;
        const id = parsed.url.slice(parsed.url.lastIndexOf('/') + 1);
        const listed = typeof item.password === 'string' ? item.password.trim() : '';
        const password = isValidQuarkPassword(listed) ? listed : parsed.password;
        const time = Date.parse(item.datetime);
        const candidate = {
            id,
            url: parsed.url,
            password,
            title,
            source: SOURCE_PATTERN.test(item.source) ? item.source : '',
            time: Number.isFinite(time) ? time : 0
        };
        const existing = byId.get(id);
        // The same share is reposted by many channels; keep the newest post
        // and any passcode a repost supplied.
        if (!existing || candidate.time > existing.time) {
            byId.set(id, { ...candidate, password: candidate.password || existing?.password || '' });
        } else if (!existing.password && candidate.password) {
            existing.password = candidate.password;
        }
    }
    return [...byId.values()].sort((a, b) => b.time - a.time).slice(0, MAX_CANDIDATES);
}

const STATUS_RANK = { available: 0, unknown: 1, passcode_required: 2 };

async function verifyCandidates(candidates, ctx, deadline) {
    const budget = { remaining: QUARK_REQUEST_BUDGET };
    const checked = new Map();
    const check = candidate => probeQuarkShare(candidate.id, ctx, {
        passcode: candidate.password, listing: true, budget, timeoutMs: QUARK_CHECK_TIMEOUT_MS
    });
    await forEachWithConcurrency(candidates, CHECK_CONCURRENCY, async candidate => {
        if (isDeadlineExpired(deadline) || budget.remaining <= 0) return;
        const result = await check(candidate);
        // A check cut short by the budget is not evidence about the share.
        if (result.status !== undefined || budget.remaining > 0) checked.set(candidate.id, result);
    });
    // Quark answers a share now and then with a timeout or a limit. One more
    // pass, with whatever budget is left, settles most of those.
    const inconclusive = candidates.filter(candidate => checked.has(candidate.id) && checked.get(candidate.id).status === undefined);
    await forEachWithConcurrency(inconclusive, CHECK_CONCURRENCY, async candidate => {
        if (isDeadlineExpired(deadline) || budget.remaining <= 0) return;
        const result = await check(candidate);
        if (result.status !== undefined) checked.set(candidate.id, result);
    });
    return checked;
}

// Does what is inside the share name the work? A post may mention a title in
// passing, so the share's own title and folder names are the better evidence.
// Releases that deliberately garble names ("流#浪#地#球") cannot be matched
// and are kept without the badge.
function contentNamesWork(result, matchesTitle) {
    return [result.shareTitle, ...(result.entries || []).map(entry => entry.name)]
        .some(text => text && matchesTitle(text));
}

// A share is not the work when its own title says so, or when everything in
// it is a book or soundtrack. A stray readme or poster beside the episodes
// does not make it one.
function isNonVideoShare(result) {
    if (result.shareTitle && NON_VIDEO_PATTERN.test(result.shareTitle)) return true;
    const entries = result.entries || [];
    return entries.length > 0 && entries.every(entry => NON_VIDEO_PATTERN.test(entry.name));
}

function buildResponse(candidates, checked, { found, matched }, matchesTitle) {
    const results = [];
    const hidden = {};
    let unchecked = 0;
    for (const candidate of candidates) {
        const result = checked.get(candidate.id);
        if (!result) {
            unchecked += 1;
            continue;
        }
        const { status } = result;
        if (status === 'available' && isNonVideoShare(result)) {
            hidden.not_video = (hidden.not_video || 0) + 1;
            continue;
        }
        if (status !== undefined && status !== 'available' && status !== 'passcode_required') {
            hidden[status] = (hidden[status] || 0) + 1;
            continue;
        }
        results.push({
            title: candidate.title,
            url: candidate.url,
            ...(candidate.password ? { password: candidate.password } : {}),
            ...(candidate.source ? { source: candidate.source } : {}),
            ...(candidate.time ? { datetime: new Date(candidate.time).toISOString() } : {}),
            status: status ?? 'unknown',
            ...(result.passcodeVerified ? { passcodeVerified: true } : {}),
            ...(result.shareTitle ? { shareTitle: result.shareTitle } : {}),
            ...(result.entries?.length ? { entries: result.entries, totalItems: result.totalItems } : {}),
            ...(contentNamesWork(result, matchesTitle) ? { contentMatch: true } : {}),
            _time: candidate.time
        });
    }
    results.sort((a, b) => (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1)
        || Number(Boolean(b.contentMatch)) - Number(Boolean(a.contentMatch)) || b._time - a._time);
    for (const result of results) delete result._time;
    const unknown = results.filter(result => result.status === 'unknown').length;
    return {
        enabled: true,
        results,
        meta: {
            provider: 'pansou',
            found,
            matched,
            // Checked on Quark and reachable; unconfirmed ones are counted apart.
            verified: results.length - unknown,
            unknown,
            unchecked,
            hidden,
            hiddenCount: Object.values(hidden).reduce((sum, count) => sum + count, 0)
        }
    };
}

export async function handleAggregateSearch(rawQuery, env, ctx, { refresh = false, id = null, mediaType = null, year = null } = {}) {
    const request = validateResourceRequest(rawQuery, id, mediaType, year);
    if (request.error) return request.error;
    const { query, identity } = request;

    const base = getPansouBase(env);
    if (!base) return jsonResponse({ enabled: false, results: [], meta: {} }, 200, { 'Cache-Control': 'no-store' });
    const sources = getPansouSources(env);

    const cacheKey = new Request(`https://aggregate-search-v1-cache.local/?base=${encodeURIComponent(base)}&src=${sources.join('+')}&q=${encodeURIComponent(query)}&id=${identity.id || ''}&type=${identity.mediaType || ''}&year=${identity.year || ''}`);
    const cached = refresh ? null : await serveCachedJson(cacheKey);
    const response = cached || await withInFlight(ctx, `aggregate:${cacheKey.url}:${refresh ? 'refresh' : ''}`, async () => {
        try {
            const deadline = createDeadline(TOTAL_TIMEOUT_MS);
            // The alias lookup is bounded and cached; it must not delay the search.
            const [items, aliases] = await Promise.all([
                fetchPansou(base, query, sources, deadline),
                getResourceTitleAliases(query, identity, env, ctx).catch(() => [])
            ]);
            const matchesTitle = createResourceTitleMatcher([query, ...aliases], identity.mediaType);
            const candidates = selectCandidates(items, matchesTitle, identity);
            const checked = await verifyCandidates(candidates, ctx, deadline);
            const body = buildResponse(candidates, checked, { found: items.length, matched: candidates.length }, matchesTitle);
            const partial = body.meta.unknown > 0 || body.meta.unchecked > 0 || items.length < THIN_INDEX_RESPONSE;
            const seconds = partial ? CACHE_SECONDS_PARTIAL : CACHE_SECONDS_VERIFIED;
            body.meta.cacheExpiresAt = Date.now() + seconds * 1000;
            return cacheJson(ctx, cacheKey, body, seconds);
        } catch (error) {
            logEvent('warn', 'aggregate_search_failed', { error: logErrorMessage(error) });
            return errorResponse(error, 502);
        }
    });

    const clientResponse = response.clone();
    const headers = new Headers(clientResponse.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(clientResponse.body, { status: clientResponse.status, statusText: clientResponse.statusText, headers });
}
