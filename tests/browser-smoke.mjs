import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

const browserWs = process.env.BROWSER_WS;
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const canonicalPoster = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const fallbackPoster = 'data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

if (!browserWs) {
    throw new Error('BROWSER_WS is required; connect this script to an isolated Chrome page.');
}

const socket = new globalThis.WebSocket(browserWs);
let nextCommandId = 1;
const pendingCommands = new Map();
const browserExceptions = [];
const actorPosterRequests = [];

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        actorPosterRequests.push(request.url);
        const width = Number(new URL(request.url).pathname.match(/\/w(\d+)\//)?.[1]) || 500;
        const posterBody = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width * 1.5}"><rect width="100%" height="100%" fill="#141417"/></svg>`;
        void command('Fetch.fulfillRequest', {
            requestId,
            responseCode: request.url.includes('audit-actor-broken') ? 404 : 200,
            responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }],
            body: request.url.includes('audit-actor-broken') ? '' : Buffer.from(posterBody).toString('base64')
        }).catch(error => browserExceptions.push(error.message));
        return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails;
        browserExceptions.push(detail.exception?.description || detail.text);
    }
    const pending = pendingCommands.get(message.id);
    if (!pending) return;
    pendingCommands.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
});

await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextCommandId++;
        pendingCommands.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression, { awaitPromise = false } = {}) {
    const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
}

async function waitFor(expression, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for: ${expression}; browser exceptions: ${JSON.stringify(browserExceptions)}`);
}

await command('Page.enable');
await command('Runtime.enable');
await command('Network.enable');
await command('Fetch.enable', { patterns: [{ urlPattern: 'https://image.tmdb.org/t/p/*/audit-actor-*', resourceType: 'Image' }] });
// Font availability is external to these mocked UI regressions. Blocking it
// keeps cold-browser readiness deterministic when Google's font CDN stalls.
await command('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] });
await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
});
await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
        const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
        const poster = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        const canonicalPoster = ${JSON.stringify(canonicalPoster)};
        const fallbackPoster = ${JSON.stringify(fallbackPoster)};
        const candidate = (title, id) => ({
            id,
            mediaType: 'movie',
            title,
            originalTitle: title,
            year: '2024',
            poster,
            summary: 'A browser smoke test synopsis.',
            tmdbRating: 8.2,
            tmdbVotes: 1200,
            popularity: 20,
            matchScore: 1,
            matchConfidence: 'high'
        });
        window.__smoke = { calls: [], requestOptions: [], resourceCalls: 0, posterCalls: 0, detailCalls: 0, detailResolved: 0, detailAttempts: {}, actorFilterFailures: 0 };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: async text => { window.__smoke.copied = text; }
        } });
        window.requestIdleCallback = undefined;
        window.cancelIdleCallback = undefined;
        if (new URL(location.href).searchParams.has('fallback')) window.IntersectionObserver = undefined;
        window.fetch = async (rawUrl, options = {}) => {
            const url = new URL(rawUrl, location.href);
            window.__smoke.calls.push(url.pathname + url.search);
            window.__smoke.requestOptions.push({ path: url.pathname, refresh: url.searchParams.get('refresh'), cache: options.cache });
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (url.pathname === '/api/tmdb/search') {
                const query = url.searchParams.get('q') || '';
                window.__smoke.identityMode = query === 'Identity Movie';
                if (query === 'Slow Movie') {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, 250);
                        options.signal?.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                    });
                }
                const ids = {
                    'Test Movie': 100,
                    'Slow Movie': 101,
                    'Fresh Movie': 102,
                    'Fallback Movie': 103,
                    'No IMDb Movie': 104,
                    'Broken Poster Movie': 105,
                    'Progressive Movie': 106,
                    'Retry Detail Movie': 107,
                    'Unsafe Poster Movie': 108,
                    'Identity Movie': 110,
                    'Changing Metadata Movie': 111,
                    'Updated Poster Movie': 112,
                    'Slow Broken Poster Movie': 113,
                    'Retry Canonical Movie': 114,
                    'Fast Broken Poster Movie': 115,
                    'Retained Enrichment Movie': 116,
                    'No Poster Movie': 117,
                    'Failed OMDb Poster Movie': 118,
                    'Unconfirmed OMDb Poster Movie': 119
                };
                window.__smoke.posterlessMode = ['No Poster Movie', 'Failed OMDb Poster Movie', 'Unconfirmed OMDb Poster Movie'].includes(query) ? query : '';
                if (query === 'Overlapping Actor') {
                    // A documentary containing the name clears the title threshold.
                    return json({
                        results: [{ ...candidate('Overlapping Actor Documentary', 330), matchScore: 0.864 }],
                        searchMeta: { matchScore: 0.864, matchedBy: 'title-contains', exactPerson: { id: 930, name: query } }
                    });
                }
                if (query === 'Exact Title Actor') {
                    return json({
                        results: [{ ...candidate(query, 331) }],
                        searchMeta: { matchScore: 1, matchedBy: 'title-exact', exactPerson: { id: 931, name: query } }
                    });
                }
                if (['Smoke Actor', 'Clickable Actor', 'Paged Actor', 'Ambiguous Actor', 'Racing Actor', 'Slow Actor', 'Empty Actor', 'Medium Actor', 'Filter Race Actor', 'Responsive Actor'].includes(query)) {
                    return json({ results: [], searchMeta: { matchScore: 0 } });
                }
                const candidatePoster = query === 'Unsafe Poster Movie'
                        ? 'javascript:alert(1)'
                        : window.__smoke.posterlessMode ? null : poster;
                return json({ results: [{ ...candidate(query, ids[query] || 104), poster: candidatePoster }], searchMeta: { matchScore: 1 } });
            }
            if (url.pathname === '/api/tmdb/person') {
                const query = url.searchParams.get('q') || '';
                const selectedId = url.searchParams.get('id');
                if (query === 'Responsive Actor') return json({
                    person: { id: 920, name: query, matchScore: 1, profile: poster },
                    credits: [
                        { ...candidate('Responsive Poster Film', 320), poster: ' https://image.tmdb.org/t/p/w500/audit-actor-poster.jpg ' },
                        candidate('External Poster Film', 321),
                        { ...candidate('Broken Poster Film', 322), poster: 'https://image.tmdb.org/t/p/w500/audit-actor-broken.jpg' },
                        { ...candidate('Comma Poster Film', 323), poster: 'https://image.tmdb.org/t/p/w500/audit-actor-comma.jpg,https://unexpected.invalid/tracker' }
                    ],
                    totalResults: 4, offset: 0, limit: 36, hasMore: false, counts: { tv: 0, movie: 4 }
                });
                if (query === 'Overlapping Actor') return json({
                    person: { id: 930, name: query, matchScore: 1, profile: poster },
                    credits: [{ ...candidate('Overlapping Actor Film', 332), mediaType: 'movie' }],
                    totalResults: 1, offset: 0, limit: 36, hasMore: false, counts: { tv: 0, movie: 1 }
                });
                if (query === 'Medium Actor') return json({
                    person: { id: 915, name: 'Medium Actor Match', matchScore: selectedId ? 1 : 0.78, profile: poster },
                    credits: [{ ...candidate('Medium Actor Film', 315), mediaType: 'movie' }],
                    totalResults: 1, offset: 0, limit: 36, hasMore: false, counts: { tv: 0, movie: 1 }
                });
                if (query === 'Filter Race Actor') {
                    const mediaType = url.searchParams.get('mediaType');
                    if (mediaType) await new Promise(resolve => setTimeout(resolve, mediaType === 'tv' ? 300 : 600));
                    return json({
                        person: { id: 916, name: query, matchScore: 1, profile: poster },
                        credits: [{ ...candidate(mediaType === 'tv' ? 'Stale Series' : 'Current Film', mediaType === 'tv' ? 316 : 317), mediaType: mediaType || 'movie' }],
                        totalResults: 1, offset: 0, limit: 36, hasMore: false, counts: { tv: 1, movie: 1 }
                    });
                }
                if (query === 'Slow Actor') {
                    // Deliberately ignore cancellation to verify the UI rejects late responses.
                    await new Promise(resolve => setTimeout(resolve, 250));
                    return json({
                        person: { id: 913, name: 'Slow Actor', matchScore: 1, profile: poster },
                        credits: [{ ...candidate('Stale Film', 313), mediaType: 'movie' }],
                        totalResults: 1,
                        offset: 0,
                        limit: 36,
                        hasMore: false,
                        counts: { tv: 0, movie: 1 }
                    });
                }
                if (query === 'Empty Actor') {
                    return json({
                        person: { id: 914, name: 'Empty Actor', matchScore: 1, profile: poster },
                        credits: [],
                        totalResults: 0,
                        offset: 0,
                        limit: 36,
                        hasMore: false,
                        counts: { tv: 0, movie: 0 }
                    });
                }
                if (selectedId === '911') {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, 250);
                        options.signal?.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                    });
                    return json({
                        person: { id: 911, name: 'Slow Choice', originalName: 'Slow Choice', profile: poster },
                        credits: [{ ...candidate('Slow Film', 311), mediaType: 'movie' }],
                        totalResults: 1,
                        offset: 0,
                        limit: 36,
                        hasMore: false,
                        counts: { tv: 0, movie: 1 }
                    });
                }
                if (selectedId === '912') {
                    return json({
                        person: { id: 912, name: 'Fast Choice', originalName: 'Fast Choice', profile: poster },
                        credits: [{ ...candidate('Fast Film', 312), mediaType: 'movie' }],
                        totalResults: 1,
                        offset: 0,
                        limit: 36,
                        hasMore: false,
                        counts: { tv: 0, movie: 1 }
                    });
                }
                if (url.searchParams.get('id') === '901') {
                    if (new URL(location.href).searchParams.has('actor-retry')) {
                        window.__smoke.actorSelectionAttempts = (window.__smoke.actorSelectionAttempts || 0) + 1;
                        if (window.__smoke.actorSelectionAttempts === 1) return json({ error: 'temporary selected actor outage' }, 503);
                    }
                    return json({
                        person: { id: 901, name: 'Ambiguous Actor', originalName: 'Ambiguous Actor', profile: poster, matchScore: 1, matchConfidence: 'high' },
                        credits: [{ ...candidate('Selected Film', 304), mediaType: 'movie', title: 'Selected Film', originalTitle: 'Selected Film' }],
                        totalResults: 1,
                        offset: 0,
                        limit: 36,
                        hasMore: false,
                        counts: { tv: 0, movie: 1 }
                    });
                }
                if (query === 'Ambiguous Actor') {
                    return json({
                        person: null,
                        credits: [],
                        personCandidates: [
                            { id: 901, name: 'Ambiguous Actor', originalName: 'Ambiguous Actor', matchScore: 1, profile: poster },
                            { id: 902, name: 'Ambiguous Actor', originalName: 'Ambiguous Actor', matchScore: 1, profile: poster }
                        ],
                        searchMeta: { ambiguous: true, matchScore: 1 }
                    });
                }
                if (query === 'Racing Actor') {
                    return json({
                        person: null,
                        credits: [],
                        personCandidates: [
                            { id: 911, name: 'Slow Choice', originalName: 'Slow Choice', matchScore: 1, profile: poster },
                            { id: 912, name: 'Fast Choice', originalName: 'Fast Choice', matchScore: 1, profile: poster }
                        ],
                        searchMeta: { ambiguous: true, matchScore: 1 }
                    });
                }
                if (query === 'Paged Actor') {
                    const pagedCredits = [
                        { ...candidate('Paged Film 1', 301), mediaType: 'movie', title: 'Paged Film 1', originalTitle: 'Paged Film 1' },
                        { ...candidate('Paged Film 2', 302), mediaType: 'movie', title: 'Paged Film 2', originalTitle: 'Paged Film 2' },
                        { ...candidate('Paged Series', 303), mediaType: 'tv', title: 'Paged Series', originalTitle: 'Paged Series' }
                    ];
                    const offset = Number(url.searchParams.get('offset') || 0);
                    const requestedType = url.searchParams.get('mediaType');
                    if (requestedType === 'movie' && window.__smoke.actorFilterFailures++ === 0) {
                        return json({ error: 'temporary actor filter outage' }, 503);
                    }
                    const filteredCredits = requestedType
                        ? pagedCredits.filter(credit => credit.mediaType === requestedType)
                        : pagedCredits;
                    const limit = 2;
                    const page = filteredCredits.slice(offset, offset + limit);
                    return json({
                        person: { id: 903, name: query, originalName: query, profile: poster, matchScore: 1, matchConfidence: 'high' },
                        credits: page,
                        totalResults: filteredCredits.length,
                        offset,
                        limit,
                        hasMore: offset + page.length < filteredCredits.length,
                        counts: { tv: 1, movie: 2 }
                    });
                }
                if (query !== 'Smoke Actor' && query !== 'Clickable Actor') return json({});
                const allCredits = [
                    { ...candidate('Smoke Series', 201), mediaType: 'tv', title: 'Smoke Series', originalTitle: 'Smoke Series', character: 'Lead' },
                    { ...candidate('Actor Movie', 200), mediaType: 'movie', title: 'Actor Movie', originalTitle: 'Actor Movie', character: 'Guest' }
                ];
                const requestedType = url.searchParams.get('mediaType');
                const filteredCredits = requestedType ? allCredits.filter(credit => credit.mediaType === requestedType) : allCredits;
                const offset = Number(url.searchParams.get('offset') || 0);
                const page = filteredCredits.slice(offset, offset + 36);
                return json({
                    person: {
                        id: 900,
                        name: query,
                        originalName: query,
                        profile: poster,
                        matchScore: 1,
                        matchConfidence: 'high'
                    },
                    credits: page,
                    totalResults: filteredCredits.length,
                    offset,
                    limit: 36,
                    hasMore: offset + page.length < filteredCredits.length,
                    counts: { tv: 1, movie: 1 }
                });
            }
            if (url.pathname === '/api/tmdb/detail') {
                window.__smoke.detailCalls += 1;
                const id = Number(url.searchParams.get('id'));
                const titles = {
                    100: 'Test Movie',
                    101: 'Slow Movie',
                    102: 'Fresh Movie',
                    103: 'Fallback Movie',
                    104: 'No IMDb Movie',
                    105: 'Broken Poster Movie',
                    106: 'Progressive Movie',
                    107: 'Retry Detail Movie',
                    108: 'Unsafe Poster Movie',
                    109: 'Canonical Movie',
                    110: 'Identity Movie',
                    111: 'Canonical Renamed Movie',
                    112: 'Updated Poster Movie',
                    113: 'Slow Broken Poster Movie',
                    114: 'Recovered Canonical Movie',
                    115: 'Fast Broken Poster Movie',
                    116: 'Retained Enrichment Movie',
                    117: 'No Poster Movie',
                    118: 'Failed OMDb Poster Movie',
                    119: 'Unconfirmed OMDb Poster Movie',
                    200: 'Actor Movie',
                    331: 'Exact Title Actor',
                    201: 'Smoke Series'
                };
                let title = titles[id] || 'Smoke Movie';
                if (id === 116) {
                    window.__smoke.detailAttempts[id] = (window.__smoke.detailAttempts[id] || 0) + 1;
                    if (window.__smoke.detailAttempts[id] > 1) await new Promise(resolve => setTimeout(resolve, 350));
                    if (window.__smoke.detailAttempts[id] === 1 || !window.__smoke.retentionRecovery) return json({ error: 'continuing detail outage' }, 503);
                    if (window.__smoke.retentionRecovery === 'canonical') title = 'Recovered Retained Movie';
                }
                if (id === 106 || id === 109 || id === 111 || id === 112 || id === 113 || id === 115) {
                    await new Promise(resolve => setTimeout(resolve, 450));
                }
                if (id === 107 || id === 114) {
                    window.__smoke.detailAttempts[id] = (window.__smoke.detailAttempts[id] || 0) + 1;
                    if (window.__smoke.detailAttempts[id] === 1) return json({ error: 'temporary detail outage' }, 503);
                }
                if (id === 108) await new Promise(resolve => setTimeout(resolve, 200));
                const response = json({
                    ...candidate(title, id),
                    year: id === 111 || (id === 116 && window.__smoke.retentionRecovery === 'canonical') ? '2025' : '2024',
                    poster: id >= 117 && id <= 119 ? null : id === 112 ? canonicalPoster : poster,
                    genres: ['Drama'],
                    runtime: 120,
                    status: 'Released',
                    originalLanguage: 'en',
                    productionCompanies: ['Smoke Studio'],
                    productionCountries: ['United States'],
                    cast: ['Smoke Actor'],
                    castDetails: [{ id: 900, name: 'Clickable Actor', character: 'Lead' }],
                    director: ['Smoke Director'],
                    writer: ['Smoke Writer'],
                    imdbId: id === 104 || id === 111 ? '' : title === 'Recovered Retained Movie' ? 'tt7654321' : 'tt1234567',
                    summary: id === 106 ? '详情已到达。' : 'A browser smoke test detail.'
                });
                window.__smoke.detailResolved += 1;
                return response;
            }
            if (url.pathname === '/api/douban/search') {
                if (url.searchParams.get('q') === 'Retained Enrichment Movie') return window.__smoke.detailAttempts[116] > 1
                    ? json({ error: 'supplement outage' }, 503)
                    : json([{ id: '413', title: 'Retained Enrichment Movie', year: '2024' }]);
                if (url.searchParams.get('q') === 'Canonical Renamed Movie') return json([
                    { id: '411', title: 'Canonical Renamed Movie', year: '2024' },
                    { id: '412', title: 'Canonical Renamed Movie', year: '2025' }
                ]);
                return json([]);
            }
            if (url.pathname === '/api/douban/detail') return json({ rating: 9.1 });
            if (url.pathname === '/api/wiki/zh' && ['Retained Enrichment Movie', 'Recovered Retained Movie'].includes(url.searchParams.get('q')) && window.__smoke.detailAttempts[116] > 1) return json({ error: 'supplement outage' }, 503);
            if (url.pathname === '/api/wiki/zh') return json({ extract: url.searchParams.get('q') === 'Changing Metadata Movie'
                ? '旧片同名作品简介。'
                : url.searchParams.get('q') === 'Canonical Renamed Movie' ? '详情确认后的新版作品简介。' : '中文烟测简介。' });
            if (url.pathname === '/api/omdb') {
                if (window.__smoke.posterlessMode === 'Failed OMDb Poster Movie') return json({ error: 'temporary OMDb outage' }, 503);
                if (window.__smoke.posterlessMode) return json({ omdb: true, imdb: 8.4,
                    imdbId: window.__smoke.posterlessMode === 'Unconfirmed OMDb Poster Movie' ? 'tt7654321' : 'tt1234567', poster: null });
                return window.__smoke.retentionRecovery && window.__smoke.detailAttempts[116] > 1
                    ? json({ error: 'supplement outage' }, 503)
                    : json({ omdb: true, imdb: 8.4, imdbId: 'tt1234567', poster: window.__smoke.identityMode ? null : poster });
            }
            if (url.pathname === '/api/resource') {
                window.__smoke.resourceCalls += 1;
                if (window.__smoke.resourceMode === 'large') return json({
                    resources: Array.from({ length: 20 }, (_, index) => ({ title: 'Source ' + index, url: 'https://by669.org/d/' + index })),
                    wpzysResources: Array.from({ length: 20 }, (_, index) => ({ title: 'Forum ' + index, url: 'https://wpzy.org/thread-' + index + '.htm' })),
                    quarkUrls: Array.from({ length: 100 }, (_, index) => ({ title: 'Share ' + index, url: 'https://pan.quark.cn/s/large-' + index, password: 'abcd' }))
                });
                if (window.__smoke.resourceMode === 'long-titles') {
                    const title = 'UnbrokenReleaseFilename'.repeat(12);
                    return json({
                        resources: Array.from({ length: 8 }, (_, index) => ({ title: title + index, url: 'https://by669.org/d/long-' + index })),
                        wpzysResources: Array.from({ length: 8 }, (_, index) => ({ title: title + index, url: 'https://wpzy.org/thread-long-' + index + '.htm' })),
                        quarkUrls: Array.from({ length: 8 }, (_, index) => ({ title: title + index, sourceTitle: title, url: 'https://pan.quark.cn/s/long-' + index, password: 'abcd' }))
                    });
                }
                if (window.__smoke.resourceMode === 'canonical-retry') return json({
                    resources: [{ title: url.searchParams.get('q'), url: 'https://resource.example/' + (url.searchParams.get('q') === 'Retry Canonical Movie' ? 'old' : 'canonical') }],
                    wpzysResources: [], quarkUrls: []
                });
                if (window.__smoke.resourceMode === 'alternating') {
                    const first = window.__smoke.resourceCalls === 1;
                    const sourceUrl = first ? 'https://by669.com/retained' : 'https://wpzy.org/thread-302.htm';
                    const links = Array.from({ length: first ? 8 : 1 }, (_, index) => ({ title: first ? 'Retained Quark' : 'Recovered Quark', url: 'https://pan.quark.cn/s/' + (first ? 'retained' + (index ? '-' + index : '') : 'recovered'), password: first ? 'keep' : 'new1', passwordRank: 1, sourceUrl }));
                    return json({
                        partial: true,
                        resourceMeta: {
                            partial: true, providers: { by669: first ? 'ok' : 'failed', wpzys: first ? 'failed' : 'ok' }, failedPages: 0,
                            pages: [{ url: sourceUrl, source: first ? 'by669' : 'wpzys', status: 'ok', quarkUrls: links }]
                        },
                        resources: first ? [{ title: 'Retained source', url: 'https://by669.com/retained', source: 'by669' }] : [],
                        wpzysResources: first ? [] : [{ title: 'Recovered source', url: 'https://wpzy.org/thread-302.htm', source: 'wpzys' }],
                        quarkUrls: links
                    });
                }
                if (window.__smoke.resourceMode === 'recovery') {
                    if (window.__smoke.resourceCalls === 2) {
                        await new Promise(resolve => setTimeout(resolve, 350));
                        return json({ error: 'temporary completion outage' }, 502);
                    }
                    const partial = window.__smoke.resourceCalls === 1;
                    return json({
                        partial,
                        resourceMeta: { partial, providers: { by669: 'ok', wpzys: partial ? 'failed' : 'ok' }, failedPages: 0 },
                        resources: [{ title: 'Retained resource', url: 'https://resource.example/retained' }],
                        wpzysResources: [],
                        quarkUrls: Array.from({ length: 8 }, (_, index) => ({
                            title: 'Retained Quark', url: 'https://pan.quark.cn/s/retained' + (index ? '-' + index : ''), password: 'keep'
                        }))
                    });
                }
                if (window.__smoke.resourceMode) return json({
                    partial: true,
                    resourceMeta: {
                        partial: true, providers: {by669:'ok',wpzys:window.__smoke.resourceMode === 'login' ? 'failed' : 'ok'},
                        providerIssues: window.__smoke.resourceMode === 'login' ? {wpzys:'login_required'} : {},
                        selectedPages: 1, attemptedPages: 1, failedPages: window.__smoke.resourceMode === 'restricted' ? 1 : 0,
                        restrictedPages: window.__smoke.resourceMode === 'restricted' ? 1 : 0, loginRequiredPages: 0
                    },
                    resources: [{title:'Smoke resource',url:'https://resource.example/smoke'}],
                    wpzysResources: window.__smoke.resourceMode === 'restricted' ? [{title:'Restricted WPZY source',url:'https://wpzy.org/thread-301.htm'}] : [],
                    quarkUrls: []
                });
                if (window.__smoke.resourceCalls === 1) return json({ error: 'temporary resource outage' }, 502);
                if (window.__smoke.resourceCalls === 2) return json({
                    partial: true,
                    resourceMeta: { partial: true, providers: { by669: 'failed', wpzys: 'ok' }, failedPages: 1 },
                    resources: [{ title: 'Smoke resource', url: 'https://resource.example/smoke' }],
                    wpzysResources: [],
                    quarkUrls: []
                });
                return json({
                    resources: [{ title: 'Smoke resource', url: 'https://resource.example/smoke' }],
                    wpzysResources: [{ title: 'Smoke forum', url: 'https://forum.example/smoke' }],
                    quarkUrls: [
                        { title: 'Smoke Quark', url: 'https://pan.quark.cn/s/smoke', password: 'abcd' },
                        { title: 'Smoke Quark second', url: 'https://pan.quark.cn/s/smoke-second', password: 'e5F6' },
                        { title: 'Smoke Quark public', url: 'https://pan.quark.cn/s/smoke-public' }
                    ]
                });
            }
            if (url.pathname === '/api/poster') {
                window.__smoke.posterCalls += 1;
                if (url.searchParams.get('title') === 'Retained Enrichment Movie') return window.__smoke.detailAttempts[116] > 1
                    ? json({ error: 'supplement outage' }, 503)
                    : json({ tmdb: true, tmdbId: 116, mediaType: 'movie', poster, omdb: { omdb: true, imdb: 8.4, imdbId: 'tt1234567' } });
                if (url.searchParams.get('title') === 'Slow Broken Poster Movie') {
                    await new Promise(resolve => setTimeout(resolve, 650));
                    return json({ tmdb: true, tmdbId: 113, mediaType: 'movie', poster: fallbackPoster });
                }
                if (url.searchParams.get('title') === 'Identity Movie') return json({
                    tmdb: true, tmdbId: new URL(location.href).searchParams.get('poster-mismatch') === 'imdb' ? 110 : 202,
                    mediaType: 'movie', poster: 'https://images.example/wrong.jpg',
                    omdb: { omdb: true, imdb: 2, imdbId: 'tt7654321', poster: 'https://images.example/wrong.jpg' }
                });
                if (url.searchParams.get('title') === 'No IMDb Movie') return json({
                    tmdb: true, tmdbId: 104, mediaType: 'movie', poster,
                    omdb: { omdb: true, imdb: 8.4, imdbId: 'tt1234567', poster }
                });
                return json({ tmdb: true, tmdbId: Number(url.searchParams.get('id') || 105), mediaType: 'movie', poster: fallbackPoster });
            }
            return json({});
        };
    })();`
});

async function search(query) {
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    await evaluate(`(() => {
        const input = document.querySelector('#searchInput');
        input.value = ${JSON.stringify(query)};
        input.form.requestSubmit();
    })()`);
}

async function assertSearchReady(title) {
    await waitFor(`document.querySelector('#showTitle')?.textContent === ${JSON.stringify(title)}`);
    assert.equal(await evaluate('document.querySelector("#errorState:not(.hidden)") === null'), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true);
}

async function runObserverFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#doubanBackupBox')).display"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#rottenRatingBox')).display"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#imdbRatingBox')).display"), 'flex');
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 0, 'resources should stay deferred before entering the viewport');

    await evaluate("document.querySelector('#resourcesSection')?.scrollIntoView({ block: 'start' })");
    await waitFor('window.__smoke.resourceCalls === 1');
    await waitFor("document.querySelector('#resourcesSection button')?.textContent.includes('重试资源扫描')");
    assert.match(await evaluate('document.querySelector("#resourcesStatus")?.textContent || ""'), /失败/);

    await evaluate("document.querySelector('#resourcesSection button')?.click()");
    await waitFor('window.__smoke.resourceCalls === 2');
    await waitFor("document.querySelector('#resourcesNotice')?.textContent.includes('部分完成')");
    await evaluate("document.querySelector('#resourcesNotice button')?.click()");
    await waitFor('window.__smoke.resourceCalls === 3');
    await waitFor("Boolean(document.querySelector('#resourceList a[href=\\\"https://resource.example/smoke\\\"]'))");
    assert.equal(await evaluate('document.querySelector("#quarkUrlList a")?.getAttribute("href")'), 'https://pan.quark.cn/s/smoke');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#quarkUrlList li')).map(card => ({ url: card.querySelector('a')?.getAttribute('href'), passwordText: card.innerText.match(/提取码：[a-z0-9]+/i)?.[0] || '', buttons: card.querySelectorAll('button').length }))"), [
        { url: 'https://pan.quark.cn/s/smoke', passwordText: '提取码：abcd', buttons: 1 },
        { url: 'https://pan.quark.cn/s/smoke-second', passwordText: '提取码：e5F6', buttons: 1 },
        { url: 'https://pan.quark.cn/s/smoke-public', passwordText: '', buttons: 0 }
    ]);
    await evaluate("document.querySelectorAll('#quarkUrlList button')[1].click()");
    await waitFor("window.__smoke.copied === 'e5F6'");
    assert.equal(await evaluate('window.__smoke.copied'), 'e5F6');
    const calls = await evaluate('window.__smoke.calls');
    assert.ok(calls.some(call => call.includes('/api/resource?q=Test%20Movie&refresh=1')));
    assert.deepEqual(await evaluate("window.__smoke.requestOptions.filter(call => call.path === '/api/resource' && call.refresh === '1').map(call => call.cache)"), ['no-store', 'no-store']);
}

async function runStaleSearchFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Slow Movie');
    await new Promise(resolve => setTimeout(resolve, 25));
    await search('Fresh Movie');
    await assertSearchReady('Fresh Movie');
    assert.equal(await evaluate('document.querySelector("#showTitle")?.textContent'), 'Fresh Movie');
}

async function runWpzyAccessFlow(mode) {
    await command('Page.navigate', {url:baseUrl});
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    await evaluate(`window.__smoke.resourceMode = ${JSON.stringify(mode)}`);
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({block:'start'})");
    await waitFor("document.querySelector('#resourcesNotice')?.textContent.includes('部分完成')");
    if (mode === 'restricted') {
        assert.match(await evaluate("document.querySelector('#resourcesNotice').textContent"), /回复或 VIP/);
        assert.equal(await evaluate("document.querySelector('#resourcesNotice button') === null"), true, 'Retry cannot unlock reply/VIP restrictions');
        assert.equal(await evaluate("document.querySelector('#wpzysResourceList a')?.getAttribute('href')"), 'https://wpzy.org/thread-301.htm');
    } else {
        assert.match(await evaluate("document.querySelector('#resourcesNotice').textContent"), /维护者更新登录/);
        assert.match(await evaluate("document.querySelector('#wpzysResourceList').textContent"), /登录需要维护/);
        assert.equal(await evaluate("document.querySelector('#resourceList a')?.getAttribute('href')"), 'https://resource.example/smoke');
    }
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 1);
}

async function runStaleActorSearchFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Slow Actor');
    await new Promise(resolve => setTimeout(resolve, 25));
    await search('Fresh Movie');
    await assertSearchReady('Fresh Movie');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate("document.querySelector('#showTitle')?.textContent"), 'Fresh Movie');
    assert.equal(await evaluate("document.querySelector('#actorResultsArea')?.classList.contains('hidden')"), true);
}

async function runEmptyActorFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Empty Actor');
    await waitFor("document.querySelector('#actorResultsTitle')?.textContent === 'Empty Actor'");
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id]').length"), 0);
    assert.equal(await evaluate("document.querySelector('#actorNotice')?.textContent.includes('没有可显示')"), true);
}

async function runProgressiveFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Progressive Movie');
    await assertSearchReady('Progressive Movie');
    assert.equal(await evaluate('document.querySelector("#loadingState")?.classList.contains("hidden")'), true);
    assert.equal(await evaluate('window.__smoke.detailResolved'), 0, 'the base result should render before slow detail resolves');
    await waitFor('window.__smoke.detailResolved === 1');
    await waitFor("document.querySelector('#omdbFields')?.textContent.includes('Smoke Studio')");
}

async function runDetailRetryFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Retry Detail Movie');
    await assertSearchReady('Retry Detail Movie');
    await waitFor("document.querySelector('#dataNotice button')?.textContent.includes('重试详情')");
    await evaluate("document.querySelector('#dataNotice button')?.click()");
    await waitFor('window.__smoke.detailAttempts[107] === 2');
    await waitFor("document.querySelector('#dataNotice')?.classList.contains('hidden')");
}

async function runResourceRetryAfterDetailRetryFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Retry Detail Movie');
    await assertSearchReady('Retry Detail Movie');
    await waitFor("document.querySelector('#dataNotice button')?.textContent.includes('重试详情')");
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await waitFor("document.querySelector('#resourcesSection button')?.textContent.includes('重试资源扫描')");
    await evaluate("document.querySelector('#resourcesSection button').click()");
    await waitFor("document.querySelector('#resourcesNotice')?.textContent.includes('部分完成')");
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 2);

    await evaluate("document.querySelector('#dataNotice button').click()");
    await waitFor('window.__smoke.detailAttempts[107] === 2');
    await waitFor("document.querySelector('#dataNotice')?.classList.contains('hidden')");
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 2, 'detail retry must retain completed resource scans');
    assert.equal(await evaluate("document.querySelector('#resourceList a')?.getAttribute('href')"), 'https://resource.example/smoke');

    await evaluate("document.querySelector('#resourcesNotice button').click()");
    await waitFor('window.__smoke.resourceCalls === 3');
    await waitFor("document.querySelector('#quarkUrlList a')?.getAttribute('href') === 'https://pan.quark.cn/s/smoke'");
    assert.equal(await evaluate("document.querySelector('#resourcesNotice').classList.contains('hidden')"), true);
    assert.ok((await evaluate('window.__smoke.calls')).some(call => call.includes('/api/resource?q=Retry%20Detail%20Movie&refresh=1')));
}

async function runTitleOmdbFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('No IMDb Movie');
    await assertSearchReady('No IMDb Movie');
    await waitFor("document.querySelector('#omdbStatus')?.textContent.includes('已补充 OMDb 数据')");
    const calls = await evaluate('window.__smoke.calls');
    const posterCall = calls.find(call => call.startsWith('/api/poster?'));
    assert.ok(posterCall, 'title-based metadata must use the identity-verified poster endpoint');
    assert.equal(new URL(posterCall, baseUrl).searchParams.get('id'), '104');
    assert.equal(new URL(posterCall, baseUrl).searchParams.get('type'), 'movie');
    assert.equal(calls.some(call => call.startsWith('/api/omdb?title=')), false);
    assert.equal(await evaluate("document.querySelector('#showCover').getAttribute('src')"), 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
        'an existing TMDB poster must be preserved when adding verified metadata');
}

async function runPosterIdentityFlow(mismatch) {
    await command('Page.navigate', { url: `${baseUrl}?poster-mismatch=${mismatch}` });
    await search('Identity Movie');
    await assertSearchReady('Identity Movie');
    await waitFor("window.__smoke.detailResolved === 1 && document.querySelector('#omdbStatus').getAttribute('aria-busy') !== 'true'");
    await evaluate("document.querySelector('#showCover').dispatchEvent(new Event('error'))");
    await waitFor("window.__smoke.posterCalls === 1 && document.querySelector('#omdbStatus').getAttribute('aria-busy') !== 'true'");
    assert.match(await evaluate("document.querySelector('#omdbFields').textContent"), /8\.4/u,
        'a same-title poster response must not overwrite the selected IMDb profile');
    assert.equal(await evaluate("document.querySelector('#showCover').getAttribute('src').includes('wrong.jpg')"), false);
    const calls = await evaluate('window.__smoke.calls');
    const params = new URL(calls.find(call => call.startsWith('/api/poster?')), baseUrl).searchParams;
    assert.equal(params.get('id'), '110');
    assert.equal(params.get('type'), 'movie');
    assert.equal(params.get('imdb'), 'tt1234567');
}

async function runConfirmedPosterAbsenceFlow() {
    for (const title of ['No Poster Movie', 'Failed OMDb Poster Movie', 'Unconfirmed OMDb Poster Movie']) {
        await command('Page.navigate', { url: baseUrl });
        await search(title);
        await assertSearchReady(title);
        await waitFor("window.__smoke.detailResolved === 1 && document.querySelector('#omdbStatus').getAttribute('aria-busy') === 'false'");
        const confirmedAbsent = title === 'No Poster Movie';
        assert.equal(await evaluate('window.__smoke.posterCalls'), confirmedAbsent ? 0 : 1,
            'only a successful profile matching the confirmed IMDb identity can eliminate the repeated poster lookup');
        if (confirmedAbsent) {
            assert.match(await evaluate("document.querySelector('#omdbStatus').textContent"), /已补充.*暂无可用海报/u);
            assert.equal(await evaluate("document.querySelector('#imdbRating').textContent"), '8.4');
            assert.equal(await evaluate("document.querySelector('#showCover').getAttribute('src').startsWith('data:image/svg+xml')"), true);
        } else {
            await waitFor(`document.querySelector('#showCover').getAttribute('src') === ${JSON.stringify(fallbackPoster)}`);
        }
    }
}

async function runActorResponsivePosterFlow() {
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    try {
        for (const [width, deviceScaleFactor, expectedSourceWidth, standardFontSize = 16, scrollbarWidth = 0] of [
            [390, 1, 185], [390, 2, 342], [640, 1, 185], [768, 1, 185],
            [1024, 1, 185], [1280, 1, 185], [1472, 1, 342], [1472, 2, 500],
            [640, 1, 342, 20], [900, 1, 342, 20], [768, 1, 185, 16, 16]
        ]) {
            // Resize an empty document so the previous page cannot start an
            // image request for its new DPR while the next navigation begins.
            await command('Page.navigate', { url: 'about:blank' });
            await waitFor("location.href === 'about:blank' && document.readyState === 'complete'");
            // Change the browser preference so media-query rem units use the
            // same initial font size as Tailwind, rather than an HTML override.
            await command('Page.setFontSizes', { fontSizes: { standard: standardFontSize } });
            await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor, mobile: width < 768 });
            await command('Page.navigate', { url: baseUrl });
            await waitFor("history.state?.kind === 'home'");
            if (scrollbarWidth) {
                await evaluate(`(() => {
                    const style = document.createElement('style');
                    style.textContent = 'html { overflow-y: scroll; } ::-webkit-scrollbar { width: ${scrollbarWidth}px; }';
                    document.head.appendChild(style);
                })()`);
                await waitFor(`innerWidth - document.documentElement.clientWidth === ${scrollbarWidth}`);
            }
            const requestsBefore = actorPosterRequests.length;
            await search('Responsive Actor');
            await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id]').length === 4");
            await evaluate("document.querySelector('#actorCreditList button[data-media-id=\"320\"] img').scrollIntoView({block:'center'})");
            await waitFor("document.querySelector('#actorCreditList button[data-media-id=\"320\"] img').complete && document.querySelector('#actorCreditList button[data-media-id=\"320\"] img').naturalWidth > 0");
            const image = await evaluate(`(() => {
                const image = document.querySelector('#actorCreditList button[data-media-id="320"] img');
                const external = document.querySelector('#actorCreditList button[data-media-id="321"] img');
                const comma = document.querySelector('#actorCreditList button[data-media-id="323"] img');
                return { currentSrc: image.currentSrc, width: image.getBoundingClientRect().width,
                    viewportGutter: innerWidth - document.documentElement.clientWidth,
                    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize), rootInlineFontSize: document.documentElement.style.fontSize,
                    threeColumnBreakpoint: matchMedia('(min-width: 40rem)').matches,
                    srcset: image.srcset, sizes: image.sizes, externalSrcset: external.getAttribute('srcset'), externalSizes: external.getAttribute('sizes'), commaSrcset: comma.getAttribute('srcset'), commaSizes: comma.getAttribute('sizes') };
            })()`);
            assert.match(image.currentSrc, new RegExp('/w' + expectedSourceWidth + '/audit-actor-poster\\.jpg$'), `${width}px DPR ${deviceScaleFactor}, browser font ${standardFontSize}px`);
            assert.equal(image.rootFontSize, standardFontSize, 'the browser preference must change the initial font size');
            assert.equal(image.rootInlineFontSize, '', 'the font-size regression must not be simulated by an HTML style override');
            assert.equal(image.threeColumnBreakpoint, width >= 40 * standardFontSize);
            assert.match(image.srcset, /185w.*342w.*500w/u);
            assert.equal(image.externalSrcset, null, 'non-TMDB poster sources retain their original URL');
            assert.equal(image.externalSizes, null);
            assert.equal(image.commaSrcset, null, 'a standalone URL containing srcset separators must not introduce extra candidates');
            assert.equal(image.commaSizes, null);
            const declaredWidth = width >= 92 * standardFontSize ? (81.25 * standardFontSize - 14) / 6
                : width >= 80 * standardFontSize ? (width - 10.75 * standardFontSize - 14) / 6
                    : width >= 64 * standardFontSize ? (width - 10 * standardFontSize - 12) / 5
                        : width >= 48 * standardFontSize ? (width - 9.25 * standardFontSize - 10) / 4
                            : width >= 40 * standardFontSize ? (width - 7 * standardFontSize - 8) / 3
                                : (width - 6.25 * standardFontSize - 6) / 2;
            // vw includes classic scrollbar space; the grid uses the smaller
            // layout viewport. Account for that measured gutter per column,
            // including the point where the main container reaches its cap.
            const columns = width >= 80 * standardFontSize ? 6 : width >= 64 * standardFontSize ? 5
                : width >= 48 * standardFontSize ? 4 : width >= 40 * standardFontSize ? 3 : 2;
            const mainCap = 92 * standardFontSize;
            const gutterPerColumn = (Math.min(width, mainCap) - Math.min(width - image.viewportGutter, mainCap)) / columns;
            assert.ok(declaredWidth >= image.width - 0.02 && Math.abs(declaredWidth - gutterPerColumn - image.width) < 1,
                `the declared image size must match the actual grid after its ${image.viewportGutter}px gutter: ${declaredWidth} vs ${image.width}`);
            assert.equal(actorPosterRequests.slice(requestsBefore).filter(url => url.includes('/audit-actor-poster.jpg')).length, 1,
                'setting responsive attributes before src must issue only the selected request');
            await evaluate("document.querySelector('#actorCreditList button[data-media-id=\"322\"] img').scrollIntoView({block:'center'})");
            await waitFor("document.querySelector('#actorCreditList button[data-media-id=\"322\"] img').getAttribute('src').startsWith('data:image/svg+xml')");
            assert.equal(await evaluate("document.querySelector('#actorCreditList button[data-media-id=\"322\"] img').hasAttribute('srcset') || document.querySelector('#actorCreditList button[data-media-id=\"322\"] img').hasAttribute('sizes')"), false,
                'a failed responsive image must clear all candidates before displaying the placeholder');
        }
    } finally {
        await command('Page.setFontSizes', { fontSizes: { standard: 16 } });
        await command('Network.setCacheDisabled', { cacheDisabled: false });
        await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    }
}

async function runBrokenPosterFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Broken Poster Movie');
    await assertSearchReady('Broken Poster Movie');
    await evaluate("document.querySelector('#showCover')?.dispatchEvent(new Event('error'))");
    await waitFor('window.__smoke.posterCalls === 1');
    await waitFor(`document.querySelector('#showCover')?.getAttribute('src') === ${JSON.stringify(fallbackPoster)}`);
    const calls = await evaluate('window.__smoke.calls');
    const params = new URL(calls.find(call => call.startsWith('/api/poster?')), baseUrl).searchParams;
    assert.equal(params.get('id'), '105');
    assert.equal(params.get('type'), 'movie');
    assert.equal(params.get('imdb'), 'tt1234567');
    assert.equal(params.get('refresh'), '1');
    assert.equal(await evaluate("window.__smoke.requestOptions.find(call => call.path === '/api/poster' && call.refresh === '1')?.cache"), 'no-store');
}

async function runUnsafePosterFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Unsafe Poster Movie');
    await assertSearchReady('Unsafe Poster Movie');
    assert.equal(
        await evaluate("document.querySelector('#showCover')?.getAttribute('src')?.startsWith('javascript:')"),
        false,
        'unsafe poster URLs must never reach the image element'
    );
}

async function runTimerFallbackFlow() {
    await command('Page.navigate', { url: `${baseUrl}?fallback=1` });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Fallback Movie');
    await assertSearchReady('Fallback Movie');
    await new Promise(resolve => setTimeout(resolve, 1450));
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 1, 'old browsers should use the bounded timer fallback');
}

async function runActorFlow() {
    await command('Page.navigate', { url: baseUrl });
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    // History traversal must start from a document activated by real input;
    // synthetic submits can be skipped by the browser's history intervention.
    // https://chromium.googlesource.com/chromium/src/+/main/docs/history_manipulation_intervention.md
    await evaluate("document.querySelector('#searchInput').value = 'Smoke Actor'; document.querySelector('#searchInput').focus()");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor("document.querySelector('#actorResultsArea:not(.hidden)')");
    assert.equal(await evaluate("document.querySelector('#actorResultsTitle')?.textContent"), 'Smoke Actor');
    assert.equal(await evaluate("document.querySelector('#actor-tv-title')?.textContent.includes('电视剧')"), true);
    assert.equal(await evaluate("document.querySelector('#actor-movie-title')?.textContent.includes('电影')"), true);
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id]').length"), 2);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('actor') === 'Smoke Actor'"), true);

    await evaluate("document.querySelector('#actorFilterTv')?.click()");
    await waitFor("document.querySelector('#actor-tv-title') && document.querySelectorAll('#actorCreditList button[data-media-id]').length === 1");
    assert.equal(await evaluate('window.__smoke.calls.some(call => call.includes("mediaType=tv"))'), true);
    assert.equal(await evaluate("document.querySelector('#actorFilterAll span').textContent"), '(2)');
    assert.equal(await evaluate("document.querySelector('#actorFilterAll').getAttribute('aria-label')"), '全部 2 部');
    await evaluate("document.querySelector('#actorFilterAll')?.click()");
    await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id]').length === 2");

    await evaluate("document.querySelector('#actorCreditList button[data-media-id=\\\"200\\\"]')?.click()");
    await waitFor("document.querySelector('#showTitle')?.textContent === 'Actor Movie'");
    assert.equal(await evaluate("location.search.includes('id=200') && location.search.includes('type=movie')"), true);
    await waitFor("document.querySelector('#omdbFields button[data-actor-name=\\\"Clickable Actor\\\"]')");

    await evaluate("document.querySelector('#omdbFields button[data-actor-name=\\\"Clickable Actor\\\"]')?.click()");
    await waitFor("document.querySelector('#actorResultsTitle')?.textContent === 'Clickable Actor'");
    assert.equal(await evaluate("window.__smoke.calls.some(call => call.startsWith('/api/tmdb/search?q=Clickable%20Actor'))"), false,
        'cast controls should use their known person ID instead of repeating a name search');
    assert.equal(await evaluate("window.__smoke.calls.some(call => call.includes('q=Clickable%20Actor&id=900'))"), true);
    assert.equal(await evaluate("document.querySelector('#actorResultsArea:not(.hidden)') !== null"), true);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('actor') === 'Clickable Actor'"), true);
    assert.match(await evaluate("document.querySelector('#searchStatus').textContent"), /已找到演员.*Clickable Actor.*已加载 2 \/ 2 部作品/u,
        'direct cast navigation must finish its live loading status');

    await evaluate('history.back()');
    await waitFor("history.state?.kind === 'detail' && new URL(location.href).searchParams.get('id') === '200' && document.querySelector('#resultsArea:not(.hidden) #showTitle')?.textContent === 'Actor Movie' && document.querySelector('#searchStatus').textContent.includes('详情已加载')");
    await evaluate('history.back()');
    await waitFor("history.state?.kind === 'actor' && new URL(location.href).searchParams.get('actor') === 'Smoke Actor' && document.querySelector('#actorResultsArea:not(.hidden) #actorResultsTitle')?.textContent === 'Smoke Actor' && document.querySelectorAll('#actorCreditList button[data-media-id]').length === 2");
    await evaluate('history.back()');
    await waitFor("history.state?.kind === 'home' && location.search === '' && document.querySelector('#actorResultsArea')?.classList.contains('hidden') && document.querySelector('#resultsArea')?.classList.contains('hidden') && document.querySelector('#searchInput')?.value === ''");
}

async function runExactActorIntentFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Overlapping Actor');
    await waitFor("document.querySelector('#actorResultsTitle')?.textContent === 'Overlapping Actor'");
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id=\\\"332\\\"]').length"), 1);
    assert.equal(await evaluate("document.querySelector('#resultsArea').classList.contains('hidden')"), true);
    assert.equal(await evaluate('window.__smoke.detailCalls'), 0, 'a documentary containing an actor name must not open as the result');
    assert.equal(await evaluate("new URL(location.href).searchParams.get('person')"), '930');

    await command('Page.navigate', { url: baseUrl });
    await search('Exact Title Actor');
    await assertSearchReady('Exact Title Actor');
    assert.equal(await evaluate("window.__smoke.calls.some(call => call.startsWith('/api/tmdb/person'))"), false,
        'an exact title keeps title intent even when an actor shares its name');
}

async function runActorCandidateFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Ambiguous Actor');
    await waitFor("document.querySelector('#actorCandidatePicker:not(.hidden)')");
    assert.equal(await evaluate("document.querySelectorAll('#actorCandidateList button[data-person-id]').length"), 2);
    await evaluate("document.querySelector('#actorCandidateList button[data-person-id=\\\"901\\\"]')?.click()");
    await waitFor("document.querySelector('#actorResultsTitle')?.textContent === 'Ambiguous Actor'");
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id=\\\"304\\\"]').length"), 1);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('person')"), '901');
    assert.match(await evaluate("document.querySelector('#searchStatus').textContent"), /已找到演员.*Ambiguous Actor/u,
        'confirming an actor candidate must finish its live loading status');
    const shareUrl = await evaluate('location.href');
    await command('Page.navigate', { url: shareUrl });
    await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id=\\\"304\\\"]').length === 1");
    assert.equal(await evaluate("document.querySelector('#actorCandidatePicker').classList.contains('hidden')"), true);
    assert.equal(await evaluate("window.__smoke.calls.some(call => call.startsWith('/api/tmdb/search'))"), false);
}

async function runDeepLinkFlow() {
    await command('Page.navigate', { url: `${baseUrl}?id=109&type=movie&title=Wrong%20Title` });
    await waitFor("window.__smoke?.detailCalls === 1");
    assert.equal(await evaluate("window.__smoke.calls.some(call => /wiki|douban|omdb|resource/.test(call))"), false,
        'unverified URL titles must not initiate supplementary searches');
    await assertSearchReady('Canonical Movie');
    await waitFor("document.querySelector('#omdbStatus').textContent.includes('已补充')");
    assert.equal(await evaluate("document.querySelector('#tmdbOverview').textContent"), 'A browser smoke test detail.');
    assert.equal(await evaluate("document.querySelector('#wikiSummary').textContent.includes('中文烟测简介')"), true);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('title')"), 'Canonical Movie');
    assert.equal(await evaluate("document.querySelector('#searchInput').value"), 'Canonical Movie');
    await evaluate("document.querySelector('#resultsArea [data-share-current]').click()");
    assert.equal(await evaluate('window.__smoke.copied'), await evaluate('location.href'));
    await evaluate("document.querySelector('#resourcesSection button')?.click()");
    await waitFor('window.__smoke.resourceCalls === 1');
    const calls = await evaluate('window.__smoke.calls');
    assert.ok(calls.some(call => call.includes('/api/wiki/zh?q=Canonical%20Movie')));
    assert.ok(calls.some(call => call.includes('/api/resource?q=Canonical%20Movie')));
    assert.equal(calls.some(call => call.includes('Wrong%20Title')), false);
}

async function runDesktopReducedMotionFlow() {
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await command('Page.navigate', { url: baseUrl });
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#resultsArea .fade-up')).animationName"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#rottenRatingBox')).display"), 'none');
}

async function runActorCandidateRaceFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Racing Actor');
    await waitFor("document.querySelector('#actorCandidatePicker:not(.hidden)')");
    await evaluate(`(() => {
        document.querySelector('#actorCandidateList button[data-person-id="911"]')?.click();
        document.querySelector('#actorCandidateList button[data-person-id="912"]')?.click();
    })()`);
    await waitFor("document.querySelector('#actorResultsTitle')?.textContent === 'Fast Choice'");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate("document.querySelector('#actorResultsTitle')?.textContent"), 'Fast Choice');
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id=\"312\"]').length"), 1);
}

async function runActorPaginationFlow() {
    await command('Page.navigate', { url: baseUrl });
    await new Promise(resolve => setTimeout(resolve, 250));
    await search('Paged Actor');
    await waitFor("document.querySelector('#actorResultsArea:not(.hidden)')");
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id]').length"), 2);
    assert.equal(await evaluate("document.querySelector('#actorLoadMore:not(.hidden)') !== null"), true);
    await evaluate("window.__smoke.initialActorCards = Array.from(document.querySelectorAll('#actorCreditList button[data-media-id]'))");
    await evaluate("document.querySelector('#actorLoadMore')?.click()");
    await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id]').length === 3");
    assert.equal(await evaluate("window.__smoke.initialActorCards.every(card => card.isConnected && document.querySelector('#actorCreditList').contains(card))"), true,
        'pagination must preserve existing cards, image state and listeners instead of rebuilding the whole filmography');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#actorCreditList h3')).map(heading => heading.id)"), ['actor-tv-title', 'actor-movie-title'],
        'a TV group introduced by a later page must still precede the existing movie group');
    assert.equal(await evaluate("document.querySelector('#actor-tv-title span').textContent"), '01');
    assert.equal(await evaluate("document.querySelector('#actor-movie-title span').textContent"), '02');
    assert.equal(await evaluate("document.querySelector('#actorLoadMore.hidden') !== null"), true);

    await evaluate("document.querySelector('#actorFilterMovie')?.click()");
    await waitFor("document.querySelector('#actorLoadMore')?.textContent.includes('重试')");
    assert.equal(await evaluate("document.querySelectorAll('#actorCreditList button[data-media-id]').length"), 0);
    await evaluate("document.querySelector('#actorLoadMore')?.click()");
    await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id]').length === 2");
    assert.equal(await evaluate("document.querySelector('#actorLoadMore.hidden') !== null"), true);
}

async function runMediumActorFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Medium Actor');
    await waitFor("document.querySelector('#actorCandidatePicker:not(.hidden)')");
    assert.equal(await evaluate("document.querySelector('#errorState.hidden') !== null"), true);
    await evaluate("document.querySelector('#actorCandidateList button[data-person-id=\"915\"]').click()");
    await waitFor("document.querySelector('#actorResultsArea:not(.hidden)')");
    assert.equal(await evaluate("document.querySelector('#actorResultsTitle').textContent"), 'Medium Actor Match');
    assert.match(await evaluate("document.querySelector('#searchStatus').textContent"), /已找到演员.*Medium Actor Match.*已加载 1 \/ 1 部作品/u);
}

async function runActorFilterRaceFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Filter Race Actor');
    await waitFor("document.querySelector('#actorResultsArea:not(.hidden)')");
    await evaluate("document.querySelector('#actorFilterTv').click(); document.querySelector('#actorFilterMovie').click()");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await evaluate("document.querySelector('#actorFilterMovie').getAttribute('aria-pressed')"), 'true');
    assert.equal(await evaluate("document.querySelector('#actorCreditList').getAttribute('aria-busy')"), 'true',
        'the cancelled TV response must not finish the newer movie load');
    await waitFor("document.querySelector('#actorCreditList button[data-media-id=\"317\"]')");
    assert.equal(await evaluate("document.querySelector('#actorCreditList button[data-media-id=\"316\"]') === null"), true);
    assert.equal(await evaluate("document.querySelector('#actorCreditList').getAttribute('aria-busy')"), 'false');
}

async function runResourceRetryPreservationFlow() {
    await command('Page.navigate', { url: baseUrl });
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    await evaluate("window.__smoke.resourceMode = 'recovery'");
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await waitFor("document.querySelector('#resourcesNotice button') && window.__smoke.resourceCalls === 1");
    await evaluate("Array.from(document.querySelectorAll('#quarkUrlList button')).find(button => button.textContent.startsWith('显示更多')).click()");
    assert.equal(await evaluate("document.querySelectorAll('#quarkUrlList a').length"), 8);

    await evaluate("document.querySelector('#resourcesNotice button').click()");
    await waitFor('window.__smoke.resourceCalls === 2');
    assert.equal(await evaluate("document.querySelector('#resourceList a')?.getAttribute('href')"), 'https://resource.example/retained',
        'resource completion must keep usable source cards visible while loading');
    assert.equal(await evaluate("document.querySelector('#quarkUrlList a')?.getAttribute('href')"), 'https://pan.quark.cn/s/retained');
    assert.equal(await evaluate("document.querySelector('#resourcesNotice button')?.disabled"), true,
        'completion cannot be submitted repeatedly while the request is pending');
    await evaluate("document.querySelector('#quarkUrlList button').click()");
    await waitFor("window.__smoke.copied === 'keep'");

    await waitFor("document.querySelector('#resourcesStatus').getAttribute('aria-busy') === 'false'");
    assert.match(await evaluate("document.querySelector('#resourcesStatus').textContent"), /失败.*保留/);
    assert.equal(await evaluate("document.querySelector('#quarkUrlList a')?.getAttribute('href')"), 'https://pan.quark.cn/s/retained',
        'a failed completion must not remove already-extracted share links');
    assert.equal(await evaluate("document.querySelectorAll('#quarkUrlList a').length"), 8,
        'a failed completion must preserve the expanded resource list');
    await evaluate("document.querySelector('#resourcesNotice button').click()");
    await waitFor("window.__smoke.resourceCalls === 3 && document.querySelector('#resourcesNotice').classList.contains('hidden')");
    assert.equal(await evaluate("document.querySelector('#resourcesStatus').textContent"), '资源扫描完成');
}

async function runActorIdentityRetryFlow(shared) {
    await command('Page.navigate', { url: `${baseUrl}?actor-retry=1${shared ? '&actor=Ambiguous%20Actor&person=901' : ''}` });
    if (!shared) {
        await search('Ambiguous Actor');
        await waitFor("document.querySelector('#actorCandidatePicker:not(.hidden)')");
        await evaluate("document.querySelector('#actorCandidateList button[data-person-id=\"901\"]').click()");
    }
    await waitFor("document.querySelector('#errorState:not(.hidden)') && window.__smoke.actorSelectionAttempts === 1");
    const callsBeforeRetry = await evaluate('window.__smoke.calls.length');
    await evaluate("document.querySelector('#retrySearchButton').click()");
    await waitFor("document.querySelector('#actorResultsArea:not(.hidden)')");
    assert.equal(await evaluate('window.__smoke.actorSelectionAttempts'), 2);
    assert.equal(await evaluate("document.querySelector('#actorCreditList button[data-media-id=\"304\"]') !== null"), true);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('person')"), '901');
    const retryCalls = await evaluate(`window.__smoke.calls.slice(${callsBeforeRetry})`);
    assert.equal(retryCalls.length, 1, 'selected actor recovery must use a single exact-ID request');
    assert.equal(new URL(retryCalls[0], baseUrl).searchParams.get('id'), '901');
    assert.equal(await evaluate("document.querySelector('#errorState').classList.contains('hidden')"), true);
}

async function runSharedTypeValidationFlow() {
    for (const type of ['book', '']) {
        await command('Page.navigate', { url: `${baseUrl}?id=109&type=${type}&title=Shared%20Title` });
        await waitFor("document.querySelector('#errorState:not(.hidden)')");
        assert.match(await evaluate("document.querySelector('#errorMsg').textContent"), /类型.*无效/);
        assert.deepEqual(await evaluate('window.__smoke.calls'), [], 'invalid explicit media types must never probe another ID namespace');
    }
    await command('Page.navigate', { url: `${baseUrl}?id=109&type=MOVIE&title=Shared%20Title` });
    await assertSearchReady('Canonical Movie');
    assert.equal(await evaluate("new URL(location.href).searchParams.get('type')"), 'movie');
    assert.ok((await evaluate('window.__smoke.calls')).some(call => call.includes('/api/tmdb/detail?id=109&type=movie')));
}

async function runSharedIdentityValidationFlow() {
    for (const person of ['', '0', '-1', '901x', '1234567890123']) {
        await command('Page.navigate', { url: `${baseUrl}?actor=Ambiguous%20Actor&person=${person}` });
        await waitFor("document.readyState === 'complete' && document.querySelector('#errorState:not(.hidden)')");
        assert.deepEqual(await evaluate('window.__smoke.calls'), [], 'an invalid explicit person ID must never fall back to a same-name actor');
        assert.equal(await evaluate("document.querySelector('#errorState:not(.hidden)') !== null"), true);
        assert.match(await evaluate("document.querySelector('#errorMsg').textContent"), /人物.*ID.*无效/);
    }
    for (const id of ['', '0', '-1', '109x', '1234567890123']) {
        await command('Page.navigate', { url: `${baseUrl}?id=${id}&type=movie&title=Shared%20Title` });
        await waitFor("document.querySelector('#errorState:not(.hidden)')");
        assert.match(await evaluate("document.querySelector('#errorMsg').textContent"), /影视.*ID.*无效/);
        assert.deepEqual(await evaluate('window.__smoke.calls'), []);
    }
    await command('Page.navigate', { url: `${baseUrl}?actor=Smoke%20Actor` });
    await waitFor("document.querySelector('#actorResultsArea:not(.hidden)')");
    assert.equal(await evaluate("document.querySelector('#actorResultsTitle').textContent"), 'Smoke Actor', 'legacy name-only actor links remain supported');
    await command('Page.navigate', { url: `${baseUrl}?actor=Ambiguous%20Actor&person=%20901%20` });
    await waitFor("document.querySelector('#actorCreditList button[data-media-id=\"304\"]')");
    assert.equal((await evaluate('window.__smoke.calls')).length, 1, 'valid trimmed person IDs use exact selection');
}

async function runCanonicalEnrichmentFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Changing Metadata Movie');
    await assertSearchReady('Changing Metadata Movie');
    assert.equal(await evaluate('window.__smoke.detailResolved'), 0, 'search metadata remains immediately visible');
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('window.__smoke.resourceCalls'), 0, 'early resource visibility must wait for the confirmed title');
    assert.equal(await evaluate("window.__smoke.calls.some(call => ['/api/wiki/', '/api/douban/', '/api/omdb', '/api/poster'].some(path => call.startsWith(path)))"), false,
        'identity-sensitive enrichment waits for canonical details');
    await assertSearchReady('Canonical Renamed Movie');
    await waitFor("document.querySelector('#wikiStatus').getAttribute('aria-busy') === 'false'");
    const calls = (await evaluate('window.__smoke.calls')).map(call => new URL(call, baseUrl));
    for (const path of ['/api/wiki/zh', '/api/douban/search']) {
        const enrichment = calls.find(url => url.pathname === path);
        assert.equal(enrichment?.searchParams.get('q'), 'Canonical Renamed Movie', path);
    }
    assert.equal(calls.find(url => url.pathname === '/api/wiki/zh')?.searchParams.get('year'), '2025');
    await waitFor("window.__smoke.calls.some(call => call.includes('/api/douban/detail?id=412'))");
    assert.equal(await evaluate("window.__smoke.calls.some(call => call.includes('/api/douban/detail?id=411'))"), false);
    await waitFor("window.__smoke.calls.some(call => call.includes('/api/poster?'))");
    assert.equal(new URL((await evaluate("window.__smoke.calls.find(call => call.includes('/api/poster?'))")), baseUrl).searchParams.get('title'), 'Canonical Renamed Movie');
    assert.equal(await evaluate("document.body.textContent.includes('旧片同名作品简介。')"), false);
    assert.equal(await evaluate("document.body.textContent.includes('详情确认后的新版作品简介。')"), true);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('title')"), 'Canonical Renamed Movie');
    await evaluate("window.__smoke.resourceCalls || document.querySelector('#resourcesSection button')?.click()");
    await waitFor('window.__smoke.resourceCalls === 1');
    const resourceCalls = (await evaluate("window.__smoke.calls.filter(call => call.startsWith('/api/resource?'))")).map(call => new URL(call, baseUrl));
    assert.deepEqual(resourceCalls.map(url => url.searchParams.get('q')), ['Canonical Renamed Movie']);
}

async function runAlternatingResourceRetryFlow() {
    await command('Page.navigate', { url: baseUrl });
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    await evaluate("window.__smoke.resourceMode = 'alternating'");
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await waitFor("document.querySelector('#resourcesNotice button') && window.__smoke.resourceCalls === 1");
    await evaluate("Array.from(document.querySelectorAll('#quarkUrlList button')).find(button => button.textContent.startsWith('显示更多')).click()");
    assert.equal(await evaluate("document.querySelectorAll('#quarkUrlList a').length"), 8);
    await evaluate("document.querySelector('#resourcesNotice button').click()");
    await waitFor("window.__smoke.resourceCalls === 2 && document.querySelector('#resourcesStatus').getAttribute('aria-busy') === 'false'");
    assert.equal(await evaluate("document.querySelector('#resourceList a')?.getAttribute('href')"), 'https://by669.com/retained');
    assert.equal(await evaluate("document.querySelector('#wpzysResourceList a')?.getAttribute('href')"), 'https://wpzy.org/thread-302.htm');
    assert.equal(await evaluate("document.querySelectorAll('#quarkUrlList a').length"), 9, 'partial completion preserves the expanded list');
    assert.equal(await evaluate("document.querySelector('#quarkUrlList a[href=\"https://pan.quark.cn/s/recovered\"]') !== null"), true);
    await evaluate("Array.from(document.querySelectorAll('#quarkUrlList button')).find(button => button.closest('li')?.textContent.includes('Retained Quark'))?.click()");
    await waitFor("window.__smoke.copied === 'keep'");
}

async function runCanonicalDetailRetryResourceFlow() {
    await command('Page.navigate', { url: baseUrl });
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    await evaluate("window.__smoke.resourceMode = 'canonical-retry'");
    await search('Retry Canonical Movie');
    await assertSearchReady('Retry Canonical Movie');
    await waitFor("document.querySelector('#dataNotice button')?.textContent.includes('重试详情')");
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await waitFor("document.querySelector('#resourceList a')?.getAttribute('href') === 'https://resource.example/old'");
    await evaluate("document.querySelector('#dataNotice button').click()");
    await assertSearchReady('Recovered Canonical Movie');
    await evaluate("window.__smoke.resourceCalls > 1 || document.querySelector('#resourcesSection button')?.click()");
    await waitFor("document.querySelector('#resourceList a')?.getAttribute('href') === 'https://resource.example/canonical'");
    const queries = (await evaluate("window.__smoke.calls.filter(call => call.startsWith('/api/resource?'))")).map(call => new URL(call, baseUrl).searchParams.get('q'));
    assert.deepEqual(queries, ['Retry Canonical Movie', 'Recovered Canonical Movie']);
    assert.equal(await evaluate("document.querySelector('#resourceList a[href=\"https://resource.example/old\"]') === null"), true);
}

async function runUpdatedPosterFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Updated Poster Movie');
    await assertSearchReady('Updated Poster Movie');
    await waitFor('window.__smoke.detailResolved === 1');
    await waitFor("document.querySelector('#searchStatus').textContent.includes('详情已加载')");
    assert.equal(await evaluate("document.querySelector('#showCover').getAttribute('src')"), canonicalPoster, 'confirmed detail poster must replace the search candidate poster');
}

async function runPosterFallbackDetailRaceFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Slow Broken Poster Movie');
    await assertSearchReady('Slow Broken Poster Movie');
    await evaluate("document.querySelector('#showCover').dispatchEvent(new Event('error'))");
    await waitFor('window.__smoke.posterCalls === 1');
    await waitFor('window.__smoke.detailResolved === 1');
    await waitFor(`document.querySelector('#showCover').getAttribute('src') === ${JSON.stringify(fallbackPoster)}`);
    assert.equal(await evaluate('window.__smoke.posterCalls'), 1, 'detail repaint must not discard an in-flight verified fallback');
    await command('Page.navigate', { url: baseUrl });
    await search('Fast Broken Poster Movie');
    await assertSearchReady('Fast Broken Poster Movie');
    await evaluate("document.querySelector('#showCover').dispatchEvent(new Event('error'))");
    await waitFor(`document.querySelector('#showCover').getAttribute('src') === ${JSON.stringify(fallbackPoster)}`);
    assert.equal(await evaluate('window.__smoke.detailResolved'), 0);
    await waitFor('window.__smoke.detailResolved === 1');
    assert.equal(await evaluate("document.querySelector('#showCover').getAttribute('src')"), fallbackPoster, 'detail repaint must keep an already-verified fallback for the failed primary image');
}

async function runCompleteResourceVisibilityFlow() {
    await command('Page.navigate', { url: baseUrl });
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
    await evaluate("window.__smoke.resourceMode = 'large'");
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await waitFor("document.querySelector('#quarkUrlList a')");
    for (const [selector, total] of [['#quarkUrlList', 100], ['#resourceList', 20], ['#wpzysResourceList', 20]]) {
        assert.equal(await evaluate(`document.querySelectorAll('${selector} a').length`), 6, 'initial rendering remains bounded');
        await evaluate(`Array.from(document.querySelectorAll('${selector} button')).find(button => button.textContent.startsWith('显示更多')).click()`);
        assert.equal(await evaluate(`document.querySelectorAll('${selector} a').length`), total, 'every returned result must remain accessible');
    }
    assert.equal(await evaluate("document.querySelector('#quarkUrlList a[href=\"https://pan.quark.cn/s/large-99\"]') !== null"), true);
    await evaluate("document.querySelector('#quarkUrlList a[href=\"https://pan.quark.cn/s/large-99\"]').closest('li').querySelector('button').click()");
    await waitFor("window.__smoke.copied === 'abcd'");
}

async function runResourceKeyboardAndLongTitleFlow() {
    await command('Page.navigate', { url: baseUrl });
    // This is the first cold document/module navigation; later business-state
    // waits retain their shorter timeout and report application exceptions.
    await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'", 15000);
    await evaluate("window.__smoke.resourceMode = 'long-titles'");
    await search('Test Movie');
    await assertSearchReady('Test Movie');
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({ block: 'start' })");
    await waitFor("document.querySelectorAll('#quarkUrlList a').length === 6");
    const layout = await evaluate(`(() => {
        const lists = ['#resourceList', '#wpzysResourceList', '#quarkUrlList'];
        return {
            viewport: document.documentElement.clientWidth,
            pageWidth: document.documentElement.scrollWidth,
            cards: lists.flatMap(selector => Array.from(document.querySelectorAll(selector + ' li a')).map(link => ({
                right: link.getBoundingClientRect().right,
                textRight: link.querySelector('div > div').getBoundingClientRect().right,
                text: link.textContent
            })))
        };
    })()`);
    assert.equal(layout.viewport, 390);
    assert.ok(layout.pageWidth <= layout.viewport + 1, `long release titles must wrap within the ${layout.viewport}px viewport (actual page width ${layout.pageWidth}px)`);
    assert.ok(layout.cards.every(card => card.right <= layout.viewport + 1 && card.textRight <= card.right + 1));
    assert.ok(layout.cards.every(card => card.text.includes('UnbrokenReleaseFilename'.repeat(12))), 'wrapping must preserve the complete title');

    await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('#quarkUrlList button')).find(item => item.textContent.startsWith('显示更多'));
        button.scrollIntoView({ block: 'center' });
        button.focus({ preventScroll: true });
    })()`);
    const beforeExpand = await evaluate('scrollY');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor("document.querySelectorAll('#quarkUrlList a').length === 8");
    assert.equal(await evaluate("document.activeElement === document.querySelectorAll('#quarkUrlList a')[6]"), true,
        'keyboard expansion must focus the first newly revealed share');
    assert.ok(Math.abs(await evaluate('scrollY') - beforeExpand) <= 1, 'expansion must preserve the current scroll position');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("document.activeElement === document.querySelectorAll('#quarkUrlList a')[6].closest('li').querySelector('button')"), true,
        'the next Tab must reach the new share password control in reading order');

    await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('#quarkUrlList button')).find(item => item.textContent === '收起列表');
        button.focus({ preventScroll: true });
    })()`);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await waitFor("document.querySelectorAll('#quarkUrlList a').length === 6");
    assert.match(await evaluate('document.activeElement.textContent'), /^显示更多/u, 'collapse must return focus to the surviving expansion control');

    const togglePoint = await evaluate(`(() => {
        const button = document.activeElement;
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, scroll: scrollY };
    })()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: togglePoint.x, y: togglePoint.y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: togglePoint.x, y: togglePoint.y, button: 'left', clickCount: 1 });
    await waitFor("document.querySelectorAll('#quarkUrlList a').length === 8");
    assert.ok(Math.abs(await evaluate('scrollY') - togglePoint.scroll) <= 1, 'pointer expansion must not jump to the end of the list');
    assert.notEqual(await evaluate('document.activeElement.textContent'), '收起列表');
    await evaluate(`(() => {
        document.querySelector('#searchInput').focus({ preventScroll: true });
        Array.from(document.querySelectorAll('#quarkUrlList button')).find(button => button.textContent === '收起列表').click();
    })()`);
    assert.equal(await evaluate("document.activeElement === document.querySelector('#searchInput')"), true,
        'an activation without control focus must preserve the existing input focus');
    await evaluate("Array.from(document.querySelectorAll('#quarkUrlList button')).find(button => button.textContent.startsWith('显示更多')).click()");
    assert.equal(await evaluate("document.activeElement === document.querySelector('#searchInput')"), true);
}

async function runDetailRetryPreservesEnrichmentFlow() {
    await command('Page.navigate', { url: baseUrl });
    await search('Retained Enrichment Movie');
    await assertSearchReady('Retained Enrichment Movie');
    await waitFor("document.querySelector('#dataNotice button') && !document.querySelector('#imdbRatingBox').classList.contains('hidden') && !document.querySelector('#doubanBackupBox').classList.contains('hidden') && document.querySelector('#wikiSummary').textContent.includes('中文烟测简介')");
    const retained = await evaluate("({ synopsis: document.querySelector('#wikiSummary').textContent, score: document.querySelector('#recScore').textContent })");
    await evaluate("document.querySelector('#dataNotice button').click()");
    assert.equal(await evaluate("document.querySelector('#wikiSummary').textContent"), retained.synopsis, 'pending detail retry must preserve the loaded synopsis');
    assert.equal(await evaluate("document.querySelector('#imdbRatingBox').classList.contains('hidden')"), false, 'pending retry retains verified OMDb ratings');
    assert.equal(await evaluate("document.querySelector('#doubanBackupBox').classList.contains('hidden')"), false);
    await waitFor("window.__smoke.detailAttempts[116] === 2 && document.querySelector('#dataNotice button')?.textContent.includes('重试详情')");
    await waitFor("document.querySelector('#wikiStatus').getAttribute('aria-busy') === 'false'");
    assert.equal(await evaluate("document.querySelector('#wikiSummary').textContent"), retained.synopsis, 'failed refreshes retain the prior synopsis');
    assert.equal(await evaluate("document.querySelector('#recScore').textContent"), retained.score);
    assert.equal(await evaluate("document.querySelector('#imdbRating').textContent"), '8.4');
    assert.equal(await evaluate("document.querySelector('#doubanBackupRating').textContent"), '9.1');
    assert.equal(await evaluate("document.querySelector('#imdbRatingBox').classList.contains('hidden')"), false);
    await evaluate("document.querySelector('#searchInput').value = 'Fresh Movie'; document.querySelector('#searchForm').requestSubmit()");
    await assertSearchReady('Fresh Movie');
    assert.equal(await evaluate("document.querySelector('#doubanBackupBox').classList.contains('hidden')"), true, 'a different work must not inherit the retained rating');
}

async function runDetailRetryRecoveryIdentityFlow() {
    for (const recovery of ['same', 'canonical']) {
        await command('Page.navigate', { url: baseUrl });
        await search('Retained Enrichment Movie');
        await assertSearchReady('Retained Enrichment Movie');
        await waitFor("document.querySelector('#dataNotice button') && !document.querySelector('#imdbRatingBox').classList.contains('hidden') && !document.querySelector('#doubanBackupBox').classList.contains('hidden') && document.querySelector('#wikiSummary').textContent.includes('中文烟测简介')");
        await evaluate(`window.__smoke.retentionRecovery = ${JSON.stringify(recovery)}; document.querySelector('#dataNotice button').click()`);
        await waitFor("window.__smoke.detailAttempts[116] === 2 && document.querySelector('#dataNotice').classList.contains('hidden') && document.querySelector('#wikiStatus').getAttribute('aria-busy') === 'false' && document.querySelector('#omdbStatus').getAttribute('aria-busy') === 'false'");
        const sameIdentity = recovery === 'same';
        assert.equal(await evaluate("document.querySelector('#wikiSummary').textContent.includes('中文烟测简介')"), sameIdentity, 'retained synopsis must belong to the confirmed title and year');
        assert.equal(await evaluate("document.querySelector('#doubanBackupBox').classList.contains('hidden')"), !sameIdentity, 'title-based ratings must be cleared when canonical metadata changes');
        assert.equal(await evaluate("document.querySelector('#imdbRatingBox').classList.contains('hidden')"), !sameIdentity, 'a changed IMDb ID must clear the prior rating even when its refresh fails');
        if (!sameIdentity) assert.equal(await evaluate("document.querySelector('#showTitle').textContent"), 'Recovered Retained Movie');
    }
}

try {
    await runResourceKeyboardAndLongTitleFlow();
    await runCompleteResourceVisibilityFlow();
    await runConfirmedPosterAbsenceFlow();
    await runActorResponsivePosterFlow();
    await runDetailRetryPreservesEnrichmentFlow();
    await runDetailRetryRecoveryIdentityFlow();
    await runSharedIdentityValidationFlow();
    await runCanonicalEnrichmentFlow();
    await runAlternatingResourceRetryFlow();
    await runCanonicalDetailRetryResourceFlow();
    await runUpdatedPosterFlow();
    await runPosterFallbackDetailRaceFlow();
    await runResourceRetryPreservationFlow();
    await runActorIdentityRetryFlow(false);
    await runActorIdentityRetryFlow(true);
    await runSharedTypeValidationFlow();
    await runObserverFlow();
    await runWpzyAccessFlow('restricted');
    await runWpzyAccessFlow('login');
    await runStaleSearchFlow();
    await runStaleActorSearchFlow();
    await runEmptyActorFlow();
    await runProgressiveFlow();
    await runDetailRetryFlow();
    await runResourceRetryAfterDetailRetryFlow();
    await runPosterIdentityFlow('tmdb');
    await runPosterIdentityFlow('imdb');
    await runTitleOmdbFlow();
    await runBrokenPosterFlow();
    await runUnsafePosterFlow();
    await runTimerFallbackFlow();
    await runActorFlow();
    await runExactActorIntentFlow();
    await runActorCandidateFlow();
    await runActorCandidateRaceFlow();
    await runActorPaginationFlow();
    await runMediumActorFlow();
    await runActorFilterRaceFlow();
    await runDeepLinkFlow();
    await runDesktopReducedMotionFlow();
    assert.deepEqual(browserExceptions, [], 'browser flows must complete without uncaught application exceptions');
    console.log(JSON.stringify({ browserSmoke: 'passed', viewports: ['390x844', '1280x900'], flows: ['long-resource-titles-and-keyboard-expansion', 'complete-resource-visibility', 'confirmed-poster-absence', 'actor-responsive-posters', 'detail-retry-preserves-enrichment', 'detail-retry-recovery-identity', 'shared-identity-validation', 'canonical-enrichment', 'alternating-provider-retry', 'canonical-detail-retry-resources', 'updated-detail-poster', 'poster-fallback-detail-races', 'resource-retry-preserves-links', 'selected-actor-retry', 'shared-actor-retry', 'shared-type-validation', 'observer-and-rating-visibility', 'resource-partial-retry', 'wpzy-reply-vip-restrictions', 'wpzy-login-maintenance', 'stale-search', 'stale-actor-search', 'empty-actor', 'progressive-detail', 'detail-retry', 'resource-retry-after-detail-retry', 'poster-tmdb-identity', 'poster-imdb-identity', 'identity-verified-title-omdb', 'broken-poster', 'unsafe-poster', 'timer-fallback', 'actor-search-and-id-navigation', 'exact-actor-intent', 'actor-candidate-picker-and-reload', 'actor-candidate-race', 'actor-pagination-and-filter-retry', 'medium-actor-confirmation', 'rapid-actor-filter-switch', 'canonical-deep-link-and-sharing', 'desktop-reduced-motion'] }));
} finally {
    socket.close();
}
