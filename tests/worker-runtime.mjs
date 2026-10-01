import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RELEASE_VERSION } from '../js/release.js';

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
const ratelimits = {
    API_RATE_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } },
    RESOURCE_RATE_LIMITER: { namespace_id: '1002', simple: { limit: 10, period: 60 } }
};

async function upstream(request) {
    const url = new URL(request.url);
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/movie/603') {
        return Response.json({ id: 603, title: 'Runtime Movie', overview: 'Verified movie overview.' });
    }
    if (url.hostname === 'by669.org') {
        assert.equal(request.headers.get('Cookie'), null, 'WPZY cookie leaked to another provider');
        await new Promise(resolve => setTimeout(resolve, 30));
        return url.pathname === '/api/discussions'
            ? Response.json({ data: [{ id: '42', attributes: { title: 'Runtime Movie 夸克' } }] })
            : new Response('<p>https://pan.quark.cn/s/runtime42 提取码：abcd</p>');
    }
    if (url.hostname === 'wpzy.org') {
        assert.equal(request.headers.get('Cookie'), runtimeCookie);
        assert.equal(request.method, 'GET');
        if (url.pathname === '/search.htm') {
            if (wpzyMode === 'login') return new Response(null, {status:302,headers:{Location:'user-login.htm'}});
            return new Response('<li data-href="thread-100.htm"><a href="thread-100.htm">Runtime Movie 夸克</a></li>');
        }
        assert.equal(url.pathname, '/thread-100.htm', 'Non-resource WPZY path must not be fetched');
        return new Response(wpzyMode === 'restricted'
            ? '<h3>【待操作】点击&lt;立即回复&gt;查看资源（开通VIP会员无需操作）</h3>'
            : '<p>https://pan.quark.cn/s/runtime-wpzy</p>');
    }
    if (url.hostname === 'movie.douban.com' && url.pathname === '/subject/42/') {
        return new Response('<strong property="v:average">8.5</strong><span property="v:votes">12345</span><span property="v:genre">喜剧</span><span property="v:summary">A complete runtime synopsis.</span>');
    }
    if (url.hostname === 'zh.wikipedia.org') {
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

    for (const phase of ['cold', 'cached']) {
        const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => request('/api/resource?q=Runtime%20Movie', `runtime-${phase}-${i}`)));
        for (const response of responses) {
            assert.equal(response.status, 200);
            const data = await response.json();
            assert.equal(data.partial, false);
            assert.equal(data.quarkUrls[0]?.password, 'abcd');
            assert.equal(data.quarkUrls[0]?.url, 'https://pan.quark.cn/s/runtime42');
            assert.equal(data.wpzysResources[0]?.url, 'https://wpzy.org/thread-100.htm');
            assert.ok(data.quarkUrls.some(item => item.url === 'https://pan.quark.cn/s/runtime-wpzy'));
            assert.ok(!JSON.stringify(data).includes('runtime-wpzy-secret'));
        }
        checks.push(`${phase}-concurrent-resource-streams`);
    }

    wpzyMode = 'restricted';
    const restricted = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-restricted');
    const restrictedData = await restricted.json();
    assert.equal(restricted.status, 200);
    assert.equal(restrictedData.partial, true);
    assert.equal(restrictedData.resourceMeta.restrictedPages, 1);
    assert.equal(restrictedData.wpzysResources.length, 1);
    assert.equal(restrictedData.quarkUrls.length, 1);
    checks.push('authenticated-wpzy-and-restricted-posts');

    wpzyMode = 'login';
    const expired = await request('/api/resource?q=Runtime%20Movie&refresh=1', 'runtime-wpzy-expired');
    const expiredData = await expired.json();
    assert.equal(expiredData.partial, true);
    assert.equal(expiredData.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.equal(expired.headers.get('cache-control'), 'public, max-age=900');
    checks.push('wpzy-login-expiry-fails-closed');
    wpzyMode = 'public';

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

    let limited;
    for (let i = 0; i < 61; i++) limited = await request('/not-found', 'runtime-rate-limit');
    assert.equal(limited.status, 429);
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
