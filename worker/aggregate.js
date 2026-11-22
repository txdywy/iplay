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
 * It queries PanSou and the 盘搜索 public index for Quark shares,
 * keeps the ones whose title names this work and year, then checks
 * each share on Quark itself. Aggregators list many dead links, so only
 * shares that are verifiably reachable are returned, with the passcode check
 * and the share's top-level folder names that show what is inside.
 */

// A public community instance. Self-hosting is easy and more dependable:
// point PANSOU_API_URL at your own. "off" disables that provider.
const DEFAULT_PANSOU_URL = 'https://so.252035.xyz';
const PANSOUSUO_SEARCH_URL = 'https://www.pansousuo.com/api/search';
const PANSOUSUO_SOURCE = 'index:pansousuo';
const PANSOUSUO_TIMEOUT_MS = 8000;
const MAX_PANSOUSUO_BYTES = 512 * 1024;
const MAX_PANSOUSUO_QUERY_LENGTH = 60;
// The community instance sometimes stalls. A second, narrower attempt (the
// Telegram channels alone answer in about two seconds) rescues most stalls.
const PANSOU_ATTEMPT_TIMEOUT_MS = 7000;
const TOTAL_TIMEOUT_MS = 28000;
// Quark is slow from the edge on some days; the module has a long deadline.
const QUARK_CHECK_TIMEOUT_MS = 6000;
const MAX_PANSOU_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS_SCANNED = 3000;
const MAX_CANDIDATES = 60;
const CHECK_CONCURRENCY = 4;
// Requests to Quark per invocation (token, passcode retry and folder listing).
// Together with the search itself this stays well under the platform limit.
const QUARK_REQUEST_BUDGET = 36;
const CACHE_SECONDS_VERIFIED = 600;
const CACHE_SECONDS_PARTIAL = 120;
// After the index fails, visitors in the next minute and a half are told at
// once instead of each waiting out the timeouts. A retry still tries again.
const INDEX_DOWN_SECONDS = 90;
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
    return items.map(item => item?.source === PANSOUSUO_SOURCE ? { ...item, source: '' } : item);
}

async function fetchPansousuo(query, deadline) {
    if ([...query].length > MAX_PANSOUSUO_QUERY_LENGTH) return [];
    const url = new URL(PANSOUSUO_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('pan', 'quark');
    const response = await fetchUpstream(url.href, {
        headers: { Accept: 'application/json' },
        redirect: 'manual'
    }, remainingDeadlineMs(deadline, PANSOUSUO_TIMEOUT_MS));
    if (!response.ok) {
        await releaseUpstreamResponse(response);
        throw createHttpError(`盘搜索 returned HTTP ${response.status}`, 502, 'Aggregate search unavailable');
    }
    const body = await readJsonWithLimit(response, MAX_PANSOUSUO_BYTES);
    if (!Array.isArray(body?.items)) throw createHttpError('盘搜索 returned invalid JSON', 502, 'Aggregate search unavailable');
    if (body.blocked === true) return [];
    return body.items.slice(0, 30).filter(item => item?.pan === 'quark').map(item => ({
        url: item.share_url,
        password: item.access_code,
        note: item.title,
        workTitle: item.work_title,
        year: Number.isInteger(item.year) && item.year >= 1800 && item.year <= 2100 ? item.year : null,
        datetime: item.published_at || item.created_at,
        source: PANSOUSUO_SOURCE
    }));
}

// The sources are asked at once and the first answer wins: one stalled
// request no longer costs a whole timeout before the next is tried. When the
// faster, Telegram-only answer comes first, the fuller one gets a short grace.
const FULL_SOURCE_GRACE_MS = 2000;

async function fetchPansou(base, query, sources, deadline) {
    const attempts = sources.map(source => fetchPansouOnce(base, query, source, deadline).then(
        items => ({ source, items }),
        error => {
            logEvent('warn', 'aggregate_source_attempt_failed', { source, error: logErrorMessage(error) });
            throw error;
        }
    ));
    for (const attempt of attempts) attempt.catch(() => {});
    let first;
    try {
        first = await Promise.any(attempts);
    } catch (failure) {
        throw failure.errors?.[0] || createHttpError('Aggregate search timed out', 504, 'Upstream request timed out');
    }
    if (first.source === sources[0]) return first.items;
    let timer;
    const grace = new Promise(resolve => {
        timer = setTimeout(resolve, Math.min(FULL_SOURCE_GRACE_MS, remainingDeadlineMs(deadline, FULL_SOURCE_GRACE_MS)), null);
    });
    const fuller = await Promise.race([attempts[0].catch(() => null), grace]);
    clearTimeout(timer);
    return fuller?.items || first.items;
}

// Keeps shares whose own title names this work (and year) and removes
// duplicates; the newest posts come first because they are likelier to live.
function selectCandidates(items, matchesTitle, { year, mediaType }) {
    const byId = new Map();
    for (const item of items) {
        if (!isObject(item)) continue;
        const note = typeof item.note === 'string' ? item.note : '';
        if (!note || note.length > 4000) continue;
        const parsed = parseQuarkUrl(typeof item.url === 'string' ? item.url : '');
        if (!parsed) continue;
        const fromPansousuo = item.source === PANSOUSUO_SOURCE;
        const workTitle = fromPansousuo && typeof item.workTitle === 'string' ? item.workTitle.trim() : '';
        if (workTitle && (workTitle.length > 400 || !matchesTitle(workTitle))) continue;
        const yearEvidence = fromPansousuo && item.year ? `${note}\n${item.year}` : note;
        if (!matchesTitle(note) || !resourceTitleHasYear(yearEvidence, year, mediaType)) continue;
        const title = cleanText(note.split(/\r?\n/).find(line => line.trim()) || note, MAX_TITLE_LENGTH);
        if (NON_VIDEO_PATTERN.test(title)) continue;
        const id = parsed.url.slice(parsed.url.lastIndexOf('/') + 1);
        const listed = typeof item.password === 'string' ? item.password.trim() : '';
        const password = fromPansousuo
            ? parsed.password || (!parsed._passwordConflict && isValidQuarkPassword(listed) ? listed : '')
            : isValidQuarkPassword(listed) ? listed : parsed.password;
        const date = Date.parse(item.datetime);
        const time = Number.isFinite(date) ? date : 0;
        const source = fromPansousuo || SOURCE_PATTERN.test(item.source) ? item.source : '';
        const candidate = {
            id,
            url: parsed.url,
            title,
            source,
            time,
            credential: password ? { password, source, time } : undefined
        };
        const existing = byId.get(id);
        if (!existing) {
            byId.set(id, candidate);
            continue;
        }
        // Keep the newest post, but preserve a distinct passcode from the
        // other index in case the preferred credential is explicitly rejected.
        const [newer, older] = candidate.time > existing.time ? [candidate, existing] : [existing, candidate];
        const credential = newer.credential || older.credential;
        const alternate = credential && [older.credential, existing.alternate, newer.credential].find(item => item
            && item.password !== credential.password
            && (item.source === PANSOUSUO_SOURCE) !== (credential.source === PANSOUSUO_SOURCE));
        byId.set(id, { ...newer, credential, alternate });
    }
    const ranked = [...byId.values()].sort((a, b) => b.time - a.time);
    // The check budget is shared. Give each index a turn even when one has
    // enough newer reposts to consume all available checks on its own.
    const primary = ranked.filter(item => item.source !== PANSOUSUO_SOURCE);
    const supplemental = ranked.filter(item => item.source === PANSOUSUO_SOURCE);
    const candidates = [];
    for (let i = 0; candidates.length < MAX_CANDIDATES && i < Math.max(primary.length, supplemental.length); i++) {
        if (primary[i]) candidates.push(primary[i]);
        if (supplemental[i] && candidates.length < MAX_CANDIDATES) candidates.push(supplemental[i]);
    }
    return candidates;
}

const STATUS_RANK = { available: 0, unknown: 1, passcode_required: 2 };

async function verifyCandidates(candidates, ctx, deadline) {
    const budget = { remaining: QUARK_REQUEST_BUDGET };
    const checked = new Map();
    const check = async candidate => {
        const probe = passcode => probeQuarkShare(candidate.id, ctx, {
            passcode, listing: true, budget, timeoutMs: QUARK_CHECK_TIMEOUT_MS
        });
        const result = await probe(candidate.credential?.password);
        if (result.status !== 'passcode_mismatch' || !candidate.alternate || budget.remaining <= 0 || isDeadlineExpired(deadline)) return result;
        const alternate = await probe(candidate.alternate.password);
        return alternate.passcodeVerified ? { ...alternate, credential: candidate.alternate } : result;
    };
    await forEachWithConcurrency(candidates, CHECK_CONCURRENCY, async candidate => {
        if (isDeadlineExpired(deadline) || budget.remaining <= 0) return;
        const result = await check(candidate);
        // A check cut short by the budget is not evidence about the share.
        if (result.status !== undefined || budget.remaining > 0) checked.set(candidate.id, result);
    });
    // Quark answers a share now and then with a timeout or a limit. One more
    // pass, with whatever budget is left, settles most of those. When most of
    // the first pass failed, Quark is struggling: more requests would only
    // wait longer and add load.
    const inconclusive = candidates.filter(candidate => checked.has(candidate.id) && checked.get(candidate.id).status === undefined);
    if (inconclusive.length * 2 > checked.size) return checked;
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

function buildResponse(candidates, checked, { found, matched, providers }, matchesTitle) {
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
        // Reachable but holding nothing is as useless as a dead link.
        if (status === 'available' && result.totalItems === 0) {
            hidden.empty = (hidden.empty || 0) + 1;
            continue;
        }
        if (status === 'available' && isNonVideoShare(result)) {
            hidden.not_video = (hidden.not_video || 0) + 1;
            continue;
        }
        if (status !== undefined && status !== 'available' && status !== 'passcode_required') {
            hidden[status] = (hidden[status] || 0) + 1;
            continue;
        }
        const password = (result.credential || candidate.credential)?.password;
        const { source, time } = result.credential || candidate;
        results.push({
            title: candidate.title,
            url: candidate.url,
            ...(password ? { password } : {}),
            ...(source ? { source } : {}),
            ...(time ? { datetime: new Date(time).toISOString() } : {}),
            status: status ?? 'unknown',
            ...(result.passcodeVerified ? { passcodeVerified: true } : {}),
            ...(result.shareTitle ? { shareTitle: result.shareTitle } : {}),
            ...(result.entries?.length ? { entries: result.entries, totalItems: result.totalItems } : {}),
            ...(contentNamesWork(result, matchesTitle) ? { contentMatch: true } : {}),
            _time: time
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
            provider: Object.keys(providers).length > 1 ? 'multiple' : Object.keys(providers)[0],
            providers,
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

// `cacheOnly` answers 410 instead of searching (paging a result already shown);
// `timeoutMs` lets a caller with less time, such as the Telegram bot, shorten the deadline.
export async function handleAggregateSearch(rawQuery, env, ctx, { refresh = false, cacheOnly = false, timeoutMs = TOTAL_TIMEOUT_MS, id = null, mediaType = null, year = null } = {}) {
    const request = validateResourceRequest(rawQuery, id, mediaType, year);
    if (request.error) return request.error;
    const { query, identity } = request;

    const base = getPansouBase(env);
    const usePansousuo = String(env?.PANSOUSUO_SEARCH ?? '').trim() === '1';
    if (String(env?.AGGREGATE_SEARCH ?? '').trim() === '0' || (!base && !usePansousuo)) {
        return jsonResponse({ enabled: false, results: [], meta: {} }, 200, { 'Cache-Control': 'no-store' });
    }
    const sources = getPansouSources(env);
    const cacheKey = new Request(`https://aggregate-search-v1-cache.local/?base=${encodeURIComponent(base || '')}&src=${sources.join('+')}&q=${encodeURIComponent(query)}&id=${identity.id || ''}&type=${identity.mediaType || ''}&year=${identity.year || ''}${usePansousuo ? '&pansousuo=1' : ''}`);
    const cached = refresh ? null : await serveCachedJson(cacheKey);
    if (cacheOnly && !cached) {
        return jsonResponse({ error: '聚合结果已过期，请重新搜索。' }, 410, { 'Cache-Control': 'no-store' });
    }
    const response = cached || await withInFlight(ctx, `aggregate:${cacheKey.url}:${refresh ? 'refresh' : ''}`, async () => {
        try {
            const deadline = createDeadline(Math.min(timeoutMs, TOTAL_TIMEOUT_MS));
            const indexes = {
                ...(base ? { pansou: { key: base, fetch: () => fetchPansou(base, query, sources, deadline) } } : {}),
                ...(usePansousuo ? { pansousuo: { key: PANSOUSUO_SEARCH_URL, fetch: () => fetchPansousuo(query, deadline) } } : {})
            };
            // The alias lookup is bounded and cached; it must not delay the search.
            const aliasesTask = getResourceTitleAliases(query, identity, env, ctx).catch(() => []);
            const indexesResult = await Promise.all(Object.entries(indexes).map(async ([name, index]) => {
                const downKey = new Request(`https://aggregate-index-down-v1.local/?base=${encodeURIComponent(index.key)}`);
                if (!refresh && await serveCachedJson(downKey)) return { name, status: 'cooldown' };
                try {
                    return { name, status: 'ok', items: await index.fetch() };
                } catch (error) {
                    cacheJson(ctx, downKey, { down: true }, INDEX_DOWN_SECONDS);
                    logEvent('warn', 'aggregate_index_failed', { provider: name, error: logErrorMessage(error) });
                    return { name, status: 'failed', error };
                }
            }));
            const successful = indexesResult.filter(index => index.status === 'ok');
            if (!successful.length) {
                if (indexesResult.every(index => index.status === 'cooldown')) {
                    return jsonResponse({ error: '聚合源刚刚没有响应，请稍后重试。' }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '60' });
                }
                throw indexesResult.find(index => index.error).error;
            }
            const providers = Object.fromEntries(indexesResult.map(({ name, status, items }) => [name, { status, found: items?.length ?? 0 }]));
            const items = successful.flatMap(index => index.items.slice(0, MAX_ITEMS_SCANNED));
            const aliases = await aliasesTask;
            const matchesTitle = createResourceTitleMatcher([query, ...aliases], identity.mediaType);
            const candidates = selectCandidates(items, matchesTitle, identity);
            const checked = await verifyCandidates(candidates, ctx, deadline);
            const found = successful.reduce((sum, index) => sum + index.items.length, 0);
            const body = buildResponse(candidates, checked, { found, matched: candidates.length, providers }, matchesTitle);
            const partial = body.meta.unknown > 0 || body.meta.unchecked > 0 || found < THIN_INDEX_RESPONSE
                || successful.length < indexesResult.length;
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
