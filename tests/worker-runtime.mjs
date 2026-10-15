import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RELEASE_VERSION } from '../js/release.js';
import { probeNativeRateLimit } from './helpers/native-rate-limit.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';
import { tmdbDetail } from './fixtures/tmdb.js';

const { Response } = globalThis;

// Real workerd execution, real Cache API/HTMLRewriter/rate-limit bindings.
// All upstream requests are intercepted, so CI uses no credentials or network.
const root = fileURLToPath(new URL('..', import.meta.url));
const modules = await Promise.all(['worker/_worker.js', 'js/release.js'].map(async path => ({
    type: 'ESModule', path: fileURLToPath(new URL(`../${path}`, import.meta.url)),
    contents: await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
})));
const checks = [];
const runtimeCookie = 'bbs_token=runtime-wpzy-secret; bbs_sid=runtime-wpzy-sid';
const bindings = { ENVIRONMENT: 'production', TMDB_API_KEY: 'runtime-test', WPZY_COOKIE: runtimeCookie };
let wpzyMode = 'public';
let personCreditsAvailable = false;
let mediaFieldsAvailable = false;
let wikiRemakeYear = '2005';
const wikiIdentityCases = {
    '小说家的电影': { description: '2024年漫画改编电影', extract: '《小说家的电影》是一部2024年电影，改编自同名小说。' },
    '2001太空漫游': { description: '1968年电影', extract: '《2001太空漫游》是一部1968年电影。' },
    'Runtime Adaptation': { description: '根据2024年小说改编的2005年电影', extract: '《Runtime Adaptation》是根据2024年小说改编的2005年电影。' }
};
const ratelimits = {
    API_RATE_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } },
    RESOURCE_RATE_LIMITER: { namespace_id: '1002', simple: { limit: 10, period: 60 } }
};

async function upstream(request) {
    const url = new URL(request.url);
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/search/multi') {
        return Response.json({ results: [{ id: 41, media_type: 'movie', title: 'The Truman Show', original_title: 'The Truman Show', release_date: '1998-06-04' }] });
    }
    if (url.hostname === 'api.themoviedb.org' && /^\/3\/(tv|movie)\/101$/.test(url.pathname)) {
        const tv = url.pathname.includes('/tv/');
        return Response.json(tmdbDetail({ id: 101, title: tv ? undefined : 'Shared Title', name: tv ? 'Shared Title' : undefined, poster_path: tv ? '/series.jpg' : '/movie.jpg' }));
    }
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/movie/603') {
        return Response.json(tmdbDetail({ id: 603, title: 'Runtime Movie', overview: 'Verified movie overview.' }));
    }
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/movie/604') {
        return Response.json({ status_message: 'Fetch failed for https://api.themoviedb.org/?api_key=runtime-test; Bearer runtime-private-token' }, { status: 503 });
    }
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/movie/605') {
        return Response.json({ id: 605, title: 'Recovered Movie', ...(mediaFieldsAvailable ? {
            external_ids: { imdb_id: 'tt1234567' }, credits: { cast: [{ id: 31, name: 'Runtime Actor' }], crew: [] }
        } : {}) });
    }
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/person/31') {
        return Response.json({ id: 31, name: 'Runtime Actor', ...(personCreditsAvailable ? { combined_credits: { cast: [] } } : {}) });
    }
    if (url.hostname === 'by669.org') {
        assert.equal(request.headers.get('Cookie'), null, 'WPZY cookie leaked to another provider');
        await new Promise(resolve => setTimeout(resolve, 30));
        return url.pathname === '/api/discussions'
            ? Response.json({ data: [{ id: '42', attributes: { title: 'Runtime Movie 夸克' } }] })
            : wpzyMode === 'conflict' ? new Response('https://pan.quark.cn/s/runtime-shared?pwd=AAAA')
            : new Response('<p>链接：https://pan.quark.cn/s/runtime42 提取码：abcd</p>'
                + '<p>链接：<a href="https://pan.quark.cn/s/runtime-formatted">夸克资源</a><b>提取码：</b><span>e5F6</span></p>'
                + '<p>夸克：https://pan.quark.cn/s/runtime-public 百度：https://pan.baidu.com/s/foreign?pwd=6868 提取码：6868</p>');
    }
    if (url.hostname === 'wpzy.org') {
        assert.equal(request.headers.get('Cookie'), runtimeCookie);
        assert.equal(request.method, 'GET');
        if (url.pathname === '/search.htm') {
            if (wpzyMode === 'login') return new Response(null, {status:302,headers:{Location:'user-login.htm'}});
            if (wpzyMode === 'maintenance') return new Response('<title>网站维护</title><p>请求过于频繁，请稍后重试</p>');
            if (wpzyMode === 'empty') return new Response(WPZY_EMPTY_SEARCH_HTML);
            return new Response('<li data-href="thread-100.htm"><a href="thread-100.htm">Runtime Movie 夸克</a></li>');
        }
        assert.equal(url.pathname, '/thread-100.htm', 'Non-resource WPZY path must not be fetched');
        if (wpzyMode === 'detail-maintenance') return new Response('<title>Service unavailable</title><h1>Maintenance in progress</h1>');
        if (wpzyMode === 'conflict') return new Response('https://pan.quark.cn/s/runtime-shared?pwd=BBBB');
        if (wpzyMode === 'pairing') return new Response('<p>链接：https://pan.quark.cn/s/wpzy-private 提取码：w7P8</p>'
            + '<p>夸克：https://pan.quark.cn/s/wpzy-public 百度：https://pan.baidu.com/s/wpzy-foreign 提取码：6868</p>');
        return new Response(wpzyMode === 'restricted'
            ? '<h3>【待操作】点击&lt;立即回复&gt;查看资源（开通VIP会员无需操作）</h3>'
            : '<p>https://pan.quark.cn/s/runtime-wpzy</p>');
    }
    if (url.hostname === 'movie.douban.com' && url.pathname === '/subject/42/') {
        return new Response('<strong property="v:average">8.5</strong><span property="v:votes">12345</span><span property="v:genre">喜剧</span><span property="v:summary">A complete runtime synopsis.</span>');
    }
    if (url.hostname === 'zh.wikipedia.org') {
        const title = url.pathname.includes('/summary/') ? decodeURIComponent(url.pathname.split('/summary/')[1]) : url.searchParams.get('srsearch');
        if (wikiIdentityCases[title]) return url.pathname.includes('/summary/')
            ? Response.json({ title, ...wikiIdentityCases[title] })
            : Response.json({ query: { search: [{ title }] } });
        if (url.pathname.endsWith('/summary/Runtime%20Remake')) {
            return Response.json({ title: 'Runtime Remake', description: '电影', extract: `Runtime Remake（Mr. Bean）是一部${wikiRemakeYear}年上映的电影。` });
        }
        if (url.searchParams.get('srsearch') === 'Runtime Remake') {
            return Response.json({ query: { search: [{ title: 'Runtime Remake' }] } });
        }
        return url.pathname.includes('/summary/')
            ? Response.json({ title: '三体 (电视剧)', description: '2023年电视剧', extract: '三体是一部电视剧。' })
            : Response.json({ query: { search: [{ title: '三体' }, { title: '三体 (电视剧)' }] } });
    }
    throw new Error(`Unexpected runtime-test upstream: ${url.hostname}${url.pathname}`);
}

const options = { modules, modulesRoot: root, compatibilityDate: '2024-04-23', bindings, ratelimits, outboundService: upstream };
const runtime = new Miniflare(convertV4MiniflareOptions(options));
const request = (path, ip = 'runtime-core') => runtime.dispatchFetch(`https://worker.test${path}`, {
    headers: { Origin: 'https://iplay.hackx64.eu.org', 'cf-connecting-ip': ip }
});

try {
    const detail = await request('/api/tmdb/detail?id=603&type=movie');
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get('x-iplay-version'), RELEASE_VERSION);
    assert.equal(detail.headers.get('access-control-allow-origin'), 'https://iplay.hackx64.eu.org');
    assert.equal((await detail.json()).id, 603);
    checks.push('production-bindings-and-release');

    const incompleteMedia = await request('/api/tmdb/detail?id=605&type=movie');
    assert.equal(incompleteMedia.status, 502);
    assert.equal(incompleteMedia.headers.get('cache-control'), 'no-store');
    await incompleteMedia.json();
    mediaFieldsAvailable = true;
    const recoveredMedia = await request('/api/tmdb/detail?id=605&type=movie');
    assert.equal(recoveredMedia.status, 200, 'incomplete appended media fields must not poison native caches');
    const recoveredMediaData = await recoveredMedia.json();
    assert.deepEqual(recoveredMediaData.cast, ['Runtime Actor']);
    assert.equal(recoveredMediaData.imdbId, 'tt1234567');
    checks.push('appended-media-fields-validation-and-recovery');

    const malformedPerson = await request('/api/tmdb/person?id=31&q=Runtime%20Actor');
    assert.equal(malformedPerson.status, 502);
    assert.equal(malformedPerson.headers.get('cache-control'), 'no-store');
    await malformedPerson.json();
    personCreditsAvailable = true;
    const recoveredPerson = await request('/api/tmdb/person?id=31&q=Runtime%20Actor');
    assert.equal(recoveredPerson.status, 200, 'incomplete appended data must not poison native actor caches');
    assert.deepEqual((await recoveredPerson.json()).credits, []);
    checks.push('appended-actor-credits-validation-and-recovery');

    const literalTitle = await request('/api/tmdb/search?q=The%20Truman%20Show');
    const literalTitleData = await literalTitle.json();
    assert.equal(literalTitle.status, 200);
    assert.equal(literalTitleData.results[0]?.id, 41);
    assert.equal(literalTitleData.searchMeta.mediaType, null);
    checks.push('literal-title-over-inferred-type');

    for (const query of ['The Truman Show 1998', 'The Truman Show 1998 movie']) {
        const response = await request(`/api/tmdb/search?q=${encodeURIComponent(query)}`, 'runtime-year-qualified-title');
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.results[0]?.id, 41);
        assert.equal(data.results[0]?.mediaType, 'movie');
        assert.equal(data.searchMeta.year, '1998');
    }
    checks.push('year-qualified-literal-title-and-type-hints');

    for (const path of ['/api/tmdb/detail?id=101&type=', '/api/tmdb/person?id=&q=Runtime%20Actor', '/api/omdb?imdb=&title=Runtime%20Movie']) {
        const response = await request(path, 'runtime-explicit-empty-identity');
        assert.equal(response.status, 400, path);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.json();
    }
    checks.push('explicit-empty-identity-rejected-without-fallback');

    for (const mediaType of ['tv', 'movie', 'tv']) {
        const poster = await request(`/api/poster?title=Shared%20Title&id=101&type=${mediaType}`);
        const posterData = await poster.json();
        assert.equal(poster.status, 200);
        assert.equal(posterData.tmdbId, 101);
        assert.equal(posterData.mediaType, mediaType);
        assert.ok(posterData.poster.endsWith(mediaType === 'tv' ? '/series.jpg' : '/movie.jpg'));
    }
    checks.push('selected-poster-and-native-cache-identity-isolation');

    for (const phase of ['cold', 'cached']) {
        const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => request('/api/resource?q=Runtime%20Movie', `runtime-${phase}-${i}`)));
        for (const response of responses) {
            assert.equal(response.status, 200);
            const data = await response.json();
            assert.equal(data.partial, false);
            assert.equal(data.quarkUrls[0]?.password, 'abcd');
            assert.equal(data.quarkUrls[0]?.url, 'https://pan.quark.cn/s/runtime42');
            assert.equal(data.quarkUrls.find(item => item.url === 'https://pan.quark.cn/s/runtime-formatted')?.password, 'e5F6');
            const publicShare = data.quarkUrls.find(item => item.url === 'https://pan.quark.cn/s/runtime-public');
            assert.ok(publicShare);
            assert.equal(publicShare.password, undefined, 'Baidu password must not leak into a Quark share');
            assert.ok(data.quarkUrls.every(item => Object.keys(item).every(key => !key.startsWith('_'))));
            assert.equal(data.resourceMeta.pages.length, 2);
            assert.ok(data.resourceMeta.pages.every(page => page.status === 'ok' && Array.isArray(page.quarkUrls)));
            assert.equal(data.resourceMeta.pages.find(page => page.source === 'by669')?.quarkUrls[0]?.passwordRank, 1);
            assert.equal(data.wpzysResources[0]?.url, 'https://wpzy.org/thread-100.htm');
            assert.ok(data.quarkUrls.some(item => item.url === 'https://pan.quark.cn/s/runtime-wpzy'));
            assert.ok(!JSON.stringify(data).includes('runtime-wpzy-secret'));
        }
        checks.push(`${phase}-concurrent-resource-streams`);
        checks.push(`${phase}-quark-password-pairing-and-foreign-provider-isolation`);
    }

    wpzyMode = 'restricted';
    const restricted = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-restricted');
    const restrictedData = await restricted.json();
    assert.equal(restricted.status, 200);
    assert.equal(restrictedData.partial, true);
    assert.equal(restrictedData.resourceMeta.restrictedPages, 1);
    assert.equal(restrictedData.wpzysResources.length, 1);
    assert.equal(restrictedData.quarkUrls.length, 3);
    assert.ok(restrictedData.quarkUrls.every(item => item.sourceUrl.startsWith('https://by669.org/')));
    const restrictedPage = restrictedData.resourceMeta.pages.find(page => page.source === 'wpzys');
    assert.equal(restrictedPage.status, 'restricted');
    assert.equal(restrictedPage.quarkUrls, undefined);
    checks.push('authenticated-wpzy-and-restricted-posts');

    wpzyMode = 'pairing';
    const wpzyPairing = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-pairing');
    const wpzyPairingData = await wpzyPairing.json();
    assert.equal(wpzyPairing.status, 200);
    assert.equal(wpzyPairingData.partial, false);
    const wpzyPrivate = wpzyPairingData.quarkUrls.find(item => item.url === 'https://pan.quark.cn/s/wpzy-private');
    assert.equal(wpzyPrivate?.password, 'w7P8');
    assert.equal(wpzyPrivate?.sourceUrl, 'https://wpzy.org/thread-100.htm');
    const wpzyPublic = wpzyPairingData.quarkUrls.find(item => item.url === 'https://pan.quark.cn/s/wpzy-public');
    assert.ok(wpzyPublic);
    assert.equal(wpzyPublic.password, undefined);
    checks.push('authenticated-wpzy-quark-password-pairing');

    wpzyMode = 'conflict';
    for (const refresh of ['&refresh=1', '']) {
        const conflict = await request(`/api/resource?q=Runtime%20Movie${refresh}`, `runtime-conflict-${refresh ? 'cold' : 'cached'}`);
        assert.equal(conflict.status, 200);
        const data = await conflict.json();
        const shared = data.quarkUrls.find(item => item.url === 'https://pan.quark.cn/s/runtime-shared');
        assert.equal(shared?.passwordConflict, true);
        assert.equal(shared?.password, undefined);
        const by669Evidence = data.resourceMeta.pages.find(page => page.source === 'by669').quarkUrls[0];
        const wpzyEvidence = data.resourceMeta.pages.find(page => page.source === 'wpzys').quarkUrls[0];
        assert.equal(by669Evidence.password, 'AAAA', 'global conflict reconciliation must not mutate page evidence');
        assert.equal(wpzyEvidence.password, 'BBBB');
        assert.equal(by669Evidence.passwordRank, 2);
        assert.equal(wpzyEvidence.passwordRank, 2);
        assert.ok(data.resourceMeta.pages.every(page => page.quarkUrls.every(item => Object.keys(item).every(key => !key.startsWith('_')))));
    }
    checks.push('resource-page-password-evidence-and-cache-serialization');

    wpzyMode = 'login';
    const expired = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-expired');
    const expiredData = await expired.json();
    assert.equal(expiredData.partial, true);
    assert.equal(expiredData.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.equal(expired.headers.get('cache-control'), 'public, max-age=900');
    checks.push('wpzy-login-expiry-fails-closed');

    wpzyMode = 'maintenance';
    const maintenance = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-maintenance');
    const maintenanceData = await maintenance.json();
    assert.equal(maintenance.status, 200);
    assert.equal(maintenanceData.partial, true);
    assert.equal(maintenanceData.resourceMeta.providers.wpzys, 'failed');
    assert.equal(maintenanceData.resourceMeta.providerIssues.wpzys, 'upstream_unavailable');
    assert.equal(maintenance.headers.get('cache-control'), 'public, max-age=900');
    checks.push('wpzy-maintenance-fails-closed');

    wpzyMode = 'detail-maintenance';
    const detailMaintenance = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-detail-maintenance');
    const detailMaintenanceData = await detailMaintenance.json();
    assert.equal(detailMaintenance.status, 200);
    assert.equal(detailMaintenanceData.partial, true);
    assert.equal(detailMaintenanceData.resourceMeta.failedPages, 1);
    assert.equal(detailMaintenanceData.wpzysResources.length, 1);
    assert.equal(detailMaintenance.headers.get('cache-control'), 'public, max-age=900');
    checks.push('detail-maintenance-keeps-source-and-short-cache');

    wpzyMode = 'empty';
    const empty = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-empty');
    const emptyData = await empty.json();
    assert.equal(emptyData.partial, false);
    assert.equal(emptyData.resourceMeta.providers.wpzys, 'ok');
    assert.deepEqual(emptyData.wpzysResources, []);
    assert.equal(empty.headers.get('cache-control'), 'public, max-age=43200');
    checks.push('wpzy-recognized-empty-search');
    wpzyMode = 'public';

    const failedDetail = await request('/api/tmdb/detail?id=604&type=movie', 'runtime-safe-errors');
    assert.equal(failedDetail.status, 503);
    assert.equal(failedDetail.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await failedDetail.json(), { error: 'TMDB unavailable' });
    checks.push('safe-public-error-boundary');

    const douban = await request('/api/douban/detail?id=42');
    assert.equal(douban.status, 200);
    const doubanData = await douban.json();
    assert.equal(doubanData.rating, 8.5);
    assert.equal(doubanData.votes, 12345);
    assert.deepEqual(doubanData.genres, ['喜剧']);
    assert.equal(doubanData.summary, 'A complete runtime synopsis.');
    checks.push('native-html-rewriter');

    const wiki = await request('/api/wiki/zh?q=三体&type=tv&year=2023');
    assert.equal(wiki.status, 200);
    assert.equal((await wiki.json()).title, '三体 (电视剧)');
    checks.push('typed-wiki-summary');

    const wrongRemake = await request('/api/wiki/zh?q=Runtime%20Remake&type=movie&year=2024');
    assert.equal(wrongRemake.status, 404);
    assert.equal(wrongRemake.headers.get('cache-control'), 'no-store');
    await wrongRemake.json();
    wikiRemakeYear = '2024';
    const matchingRemake = await request('/api/wiki/zh?q=Runtime%20Remake&type=movie&year=2024');
    assert.equal(matchingRemake.status, 200, 'a wrong-year summary must not poison the native cache');
    assert.ok((await matchingRemake.json()).extract.includes('2024'));
    checks.push('wiki-introduction-year-validation-and-recovery');

    for (const [title, year] of [['小说家的电影', '2024'], ['2001太空漫游', '1968'], ['Runtime Adaptation', '2005']]) {
        const response = await request(`/api/wiki/zh?q=${encodeURIComponent(title)}&type=movie&year=${year}`, `runtime-wiki-identity-${year}`);
        assert.equal(response.status, 200, title);
        assert.equal((await response.json()).title, title);
    }
    const wrongAdaptation = await request('/api/wiki/zh?q=Runtime%20Adaptation&type=movie&year=2024', 'runtime-wiki-adaptation-wrong-year');
    assert.equal(wrongAdaptation.status, 404);
    assert.equal(wrongAdaptation.headers.get('cache-control'), 'no-store');
    await wrongAdaptation.json();
    checks.push('wiki-title-words-and-adapted-source-year-isolation');

    const limited = await probeNativeRateLimit(ip => request('/not-found', ip), {
        limit: ratelimits.API_RATE_LIMITER.simple.limit,
        periodSeconds: ratelimits.API_RATE_LIMITER.simple.period
    });
    assert.equal(limited.headers.get('retry-after'), '60');
    checks.push('native-rate-limiter');

    await runtime.setOptions(convertV4MiniflareOptions({ ...options, ratelimits: {} }));
    const unavailable = await request('/api/tmdb/detail?id=603&type=movie');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    checks.push('production-fails-closed-without-bindings');

    console.log(JSON.stringify({ workerRuntime: 'passed', release: RELEASE_VERSION, checks }));
} finally {
    await runtime.dispose();
}
