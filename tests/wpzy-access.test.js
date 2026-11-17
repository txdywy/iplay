import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

const LOGIN_COOKIE = 'bbs_token=test-session-a; bbs_sid=test-sid';
const title = '流浪地球';
const thread = (id, extra = '') => `<li class="media thread tap" data-href="thread-${id}.htm"><a href="thread-${id}.htm"><span class="text-danger">流浪地球</span> 夸克 ${extra}</a><a href="forum-9-1.htm?tagids=1">夸克</a></li>`;

function setup(t, upstream, { by669, zuidouyin } = {}) {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    const requests = [];
    const entries = new Map();
    const writes = [];
    globalThis.caches = { default: {
        async match(key) { return entries.get(key.url)?.clone() || null; },
        async put(key, response) { entries.set(key.url, response); },
        async delete(key) { return entries.delete(key.url); }
    } };
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(String(input));
        const headers = new globalThis.Headers(options.headers);
        requests.push({ url: url.href, cookie: headers.get('Cookie'), method: options.method || 'GET' });
        if (url.origin === 'https://by669.org') return by669 ? by669(url) : Response.json({ data: [] });
        if (url.origin === 'https://zuidouyin.com') return zuidouyin ? zuidouyin(url) : Response.json([]);
        return upstream(url, headers);
    };
    t.after(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });
    const ctx = { waitUntil(promise) { writes.push(promise); } };
    async function search(cookie = LOGIN_COOKIE, { refresh = false, cacheOnly = false, query = title, identity = '' } = {}) {
        const response = await worker.fetch(new Request(`https://worker.test/api/resource${cacheOnly ? '/cache' : ''}?q=${encodeURIComponent(query)}${identity}${refresh ? '&refresh=1' : ''}`, {
            headers: { 'cf-connecting-ip': t.name, Cookie: 'bbs_token=untrusted-client-cookie' }
        }), cookie ? { WPZY_COOKIE: cookie } : {}, ctx);
        const body = await response.json();
        await Promise.all(writes.splice(0));
        return { response, body };
    }
    return { requests, entries, search };
}

test('WPZY matches supplementary Chinese characters encoded as HTML numeric entities', async t => {
    const { search } = setup(t, url => url.pathname === '/search.htm'
        ? new Response(thread(201, '&#127916; &#x110000;').replace('流浪地球', '&#x20bb7;祥'))
        : new Response('<p>https://pan.quark.cn/s/unicode-title</p>'));
    const { body } = await search(LOGIN_COOKIE, { query: '𠮷祥' });
    assert.equal(body.wpzysResources.length, 1);
    assert.equal(body.wpzysResources[0].title, '𠮷祥 夸克 🎬 �');
    assert.equal(body.quarkUrls[0].url, 'https://pan.quark.cn/s/unicode-title');
});

test('WPZY uses only the server secret for search, detail and same-origin redirects', async t => {
    const { search, requests, entries } = setup(t, (url, headers) => {
        assert.equal(url.origin, 'https://wpzy.org');
        assert.equal(headers.get('Cookie'), LOGIN_COOKIE);
        if (url.pathname === '/search.htm') return new Response(thread(201));
        if (url.pathname === '/thread-201.htm') return new Response(null, {status:302,headers:{Location:'thread-202.htm'}});
        if (url.pathname === '/thread-202.htm') return new Response('<p>https://pan.quark.cn/s/wpzy-public 提取码：abcd</p>');
        throw new Error('Unexpected resource path');
    });
    const { response, body } = await search();
    assert.equal(response.status, 200);
    assert.equal(body.partial, false);
    assert.deepEqual(body.resourceMeta.providers, {by669:'ok',wpzys:'ok',zuidouyin:'ok'});
    assert.equal(body.wpzysResources[0]?.url, 'https://wpzy.org/thread-201.htm');
    assert.equal(body.quarkUrls[0]?.password, 'abcd');
    assert.equal(body.quarkUrls[0]?.sourceUrl, 'https://wpzy.org/thread-201.htm');
    assert.ok(requests.filter(request => request.url.startsWith('https://by669.org/')).every(request => request.cookie === null));
    assert.ok(requests.every(request => request.method === 'GET'));
    assert.ok([...entries.keys()].every(key => key.startsWith('https://resource-search-v19-cache.local/') && !key.includes('test-session-a') && !key.includes('bbs_token')));
    assert.ok(!JSON.stringify(body).includes('test-session-a'));
    assert.equal(response.headers.get('set-cookie'), null);
});

test('resource previews read the existing snapshot for the same work and login without scanning', async t => {
    let currentShare = 'first-share';
    const { search, requests } = setup(t, url => new Response(url.pathname === '/search.htm'
        ? thread(201, '2019') : 'https://pan.quark.cn/s/' + currentShare));
    const identity = '&id=550988&type=movie&year=2019';
    const preview = options => search(LOGIN_COOKIE, { cacheOnly: true, identity, ...options });
    assert.equal((await preview()).response.status, 410);
    assert.equal(requests.length, 0);

    const { body: original } = await search(LOGIN_COOKIE, { identity });
    assert.equal(original.quarkUrls[0]?.url, 'https://pan.quark.cn/s/first-share');
    const warm = requests.length;
    const { response, body } = await preview({ refresh: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.quarkUrls[0]?.url, original.quarkUrls[0]?.url);
    assert.equal((await preview({ identity: '&id=550989&type=movie&year=2019' })).response.status, 410);
    const otherLogin = await search('bbs_token=other-server-session', { cacheOnly: true, identity });
    assert.equal(otherLogin.response.status, 410);
    assert.equal(requests.length, warm);

    currentShare = 'second-share';
    const refreshed = await search(LOGIN_COOKIE, { identity, refresh: true });
    assert.ok(requests.length > warm);
    assert.equal(refreshed.body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/second-share');
    assert.equal((await preview()).body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/second-share');
});

test('an explicit upstream login failure removes previously extracted shares from future previews', async t => {
    let expired = false;
    const { search } = setup(t, url => {
        if (expired) return new Response(null, { status: 302, headers: { Location: 'user-login.htm' } });
        return new Response(url.pathname === '/search.htm' ? thread(201) : 'https://pan.quark.cn/s/old-share');
    });
    assert.equal((await search()).body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/old-share');
    expired = true;
    const refresh = await search(LOGIN_COOKIE, { refresh: true });
    assert.equal(refresh.body.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.deepEqual(refresh.body.quarkUrls, []);
    assert.deepEqual((await search(LOGIN_COOKIE, { cacheOnly: true })).body.quarkUrls, []);
});

test('refresh removes login-gated shares while retaining temporarily unavailable public pages', async t => {
    let providersOffline = false;
    const failure = () => new Response(null, { status: 503 });
    const { entries, search } = setup(t, url => {
        if (providersOffline) return new Response(null, { status: 302, headers: { Location: 'user-login.htm' } });
        return new Response(url.pathname === '/search.htm' ? thread(201) : 'https://pan.quark.cn/s/login-share');
    }, {
        by669: url => {
            if (providersOffline) return failure();
            if (url.pathname === '/api/discussions') return Response.json({ data: [{ id: 21, attributes: { title: title + ' 夸克' } }] });
            return new Response('https://pan.quark.cn/s/public-share?pwd=keep');
        },
        zuidouyin: () => providersOffline ? failure() : Response.json([])
    });
    const first = (await search()).body;
    assert.equal(first.quarkUrls.length, 2);
    providersOffline = true;
    const refresh = await search(LOGIN_COOKIE, { refresh: true });
    assert.equal(refresh.response.status, 200);
    assert.equal(refresh.body.partial, true);
    assert.equal(refresh.body.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.deepEqual(refresh.body.quarkUrls.map(({ url, password }) => [url, password]),
        [['https://pan.quark.cn/s/public-share', 'keep']]);
    assert.deepEqual(refresh.body.resourceMeta.retainedPages.map(page => page.source), ['by669']);
    const preview = (await search(LOGIN_COOKIE, { cacheOnly: true })).body;
    assert.deepEqual(preview.quarkUrls, refresh.body.quarkUrls);
    assert.ok(preview.resourceMeta.cacheExpiresAt <= first.resourceMeta.cacheExpiresAt);

    // The entry can disappear between a browser's preview and its refresh.
    entries.clear();
    const cold = await search(LOGIN_COOKIE, { refresh: true });
    assert.equal(cold.response.status, 200);
    assert.equal(cold.body.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.deepEqual(cold.body.quarkUrls, []);
});

test('WPZY login redirects are failures, not cached empty successes', async t => {
    const { search, requests, entries } = setup(t, () => new Response(null, {status:302,headers:{Location:'user-login.htm'}}));
    const { response, body } = await search();
    assert.equal(response.status, 200);
    assert.equal(body.partial, true);
    assert.equal(body.resourceMeta.providers.wpzys, 'failed');
    assert.equal(body.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal([...entries.values()][0].headers.get('cache-control'), 'public, max-age=900');
    assert.ok(!requests.some(request => request.url.includes('user-login')));
});

test('WPZY HTTP 200 login forms are not mistaken for no matching resources', async t => {
    const { search } = setup(t, () => new Response('<title>用户登录</title><form action="user-login.htm"><input name="username"></form>'));
    const { body } = await search();
    assert.equal(body.partial, true);
    assert.equal(body.resourceMeta.providerIssues.wpzys, 'login_required');
});

test('WPZY HTTP 200 maintenance pages are recoverable provider failures, not healthy empty searches', async t => {
    const { search, entries } = setup(t, () => new Response('<html><title>网站维护</title><p>请求过于频繁，请稍后重试。</p></html>'));
    const { response, body } = await search();
    assert.equal(response.status, 200);
    assert.equal(body.partial, true);
    assert.equal(body.resourceMeta.providers.wpzys, 'failed');
    assert.equal(body.resourceMeta.providerIssues.wpzys, 'upstream_unavailable');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal([...entries.values()][0].headers.get('cache-control'), 'public, max-age=900');
});

test('recognized WPZY empty search results remain healthy and cacheable', async t => {
    const { search, entries } = setup(t, () => new Response(WPZY_EMPTY_SEARCH_HTML));
    const { response, body } = await search();
    assert.equal(body.partial, false);
    assert.equal(body.resourceMeta.providers.wpzys, 'ok');
    assert.deepEqual(body.wpzysResources, []);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal([...entries.values()][0].headers.get('cache-control'), 'public, max-age=1800', 'an empty scan is rechecked sooner');
});

test('unknown WPZY HTTP 200 documents do not qualify as empty search results', async t => {
    const { search, entries } = setup(t, () => new Response('<html>No matching resources</html>'));
    const { response, body } = await search();
    assert.equal(body.resourceMeta.providers.wpzys, 'failed');
    assert.equal(body.partial, true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal([...entries.values()][0].headers.get('cache-control'), 'public, max-age=900');
});

test('valid WPZY results without Quark links are not provider failures', async t => {
    const { search } = setup(t, () => new Response('<li data-href="thread-901.htm"><a href="thread-901.htm">流浪地球 百度</a></li>'));
    const { body } = await search();
    assert.equal(body.resourceMeta.providers.wpzys, 'ok');
    assert.equal(body.partial, false);
    assert.deepEqual(body.wpzysResources, []);
});

test('a cached WPZY maintenance result can be refreshed after upstream recovery', async t => {
    let recovered = false;
    const { search, requests, entries } = setup(t, url => new Response(!recovered
        ? '<title>网站维护</title>'
        : url.pathname === '/search.htm' ? thread(902) : 'https://pan.quark.cn/s/recovered'));
    assert.equal((await search()).body.partial, true);
    const requestsAfterFailure = requests.length;
    recovered = true;
    assert.equal((await search()).body.partial, true);
    assert.equal(requests.length, requestsAfterFailure, 'partial results can still use their short cache');
    const { response, body } = await search(LOGIN_COOKIE, { refresh: true });
    assert.equal(body.partial, false);
    assert.equal(body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/recovered');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal([...entries.values()][0].headers.get('cache-control'), 'public, max-age=43200');
});

test('WPZY restricted posts retain source cards without extracting gated links', async t => {
    const { search, requests } = setup(t, url => {
        if (url.pathname === '/search.htm') return new Response(thread(301) + thread(302));
        if (url.pathname === '/thread-301.htm') return new Response('<h3>【待操作】点击&lt;立即回复&gt;查看资源（开通VIP会员无需操作）</h3><script>"https://pan.quark.cn/s/hidden-link"</script>');
        return new Response('<p>https://pan.quark.cn/s/public-link</p>');
    });
    const { body } = await search();
    assert.equal(body.wpzysResources.length, 2);
    assert.deepEqual(body.quarkUrls.map(item => item.url), ['https://pan.quark.cn/s/public-link']);
    assert.equal(body.partial, true);
    assert.equal(body.resourceMeta.failedPages, 1);
    assert.equal(body.resourceMeta.restrictedPages, 1);
    assert.ok(requests.every(request => request.method === 'GET' && !request.url.includes('post-create')));
});

test('valid resource posts discussing maintenance still expose their public links', async t => {
    const { search } = setup(t, url => new Response(url.pathname === '/search.htm'
        ? thread(303)
        : '<title>网站维护教程 夸克资源</title><p>教程介绍系统维护中与 service unavailable 的处理。</p><a href="https://pan.quark.cn/s/maintenance-tutorial">公开资源</a>'));
    const { body } = await search();
    assert.equal(body.partial, false);
    assert.equal(body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/maintenance-tutorial');
});

test('malformed WPZY detail HTML cannot monopolize resource parsing CPU', async t => {
    const { search } = setup(t, url => new Response(url.pathname === '/search.htm'
        ? thread(801) : '<'.repeat(40000)));
    const startedAt = globalThis.performance.now();
    const { response, body } = await search();
    const elapsedMs = globalThis.performance.now() - startedAt;
    assert.equal(response.status, 200);
    assert.equal(body.wpzysResources.length, 1);
    assert.ok(elapsedMs < 500, `40KB malformed HTML took ${elapsedMs.toFixed(1)}ms (budget: 500ms)`);
});

test('unterminated WPZY result items are rejected without repeated full-page scans', async t => {
    const { search } = setup(t, () => new Response('<li data-href="thread-801.htm">'.repeat(4000)));
    const startedAt = globalThis.performance.now();
    const { body } = await search();
    const elapsedMs = globalThis.performance.now() - startedAt;
    assert.equal(body.resourceMeta.providers.wpzys, 'failed');
    assert.ok(elapsedMs < 500, `Unterminated result items took ${elapsedMs.toFixed(1)}ms (budget: 500ms)`);
});

test('WPZY cache and in-flight work are isolated by normalized login state', async t => {
    const { search, requests, entries } = setup(t, (url, headers) => {
        const isA = headers.get('Cookie') === LOGIN_COOKIE;
        if (!headers.has('Cookie')) return new Response(null, {status:302,headers:{Location:'user-login.htm'}});
        if (url.pathname === '/search.htm') return new Response(thread(isA ? 401 : 402));
        return new Response(`https://pan.quark.cn/s/${isA ? 'account-a' : 'account-b'}`);
    });
    assert.equal((await search('')).body.partial, true);
    const [first, second] = await Promise.all([search(), search('bbs_token=test-session-b; bbs_sid=test-sid')]);
    assert.equal(first.body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/account-a');
    assert.equal(second.body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/account-b');
    const count = requests.length;
    assert.equal((await search()).body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/account-a');
    assert.equal((await search('bbs_sid=test-sid; HMACCOUNT=ignored; bbs_token=test-session-a')).body.quarkUrls[0]?.url, 'https://pan.quark.cn/s/account-a');
    assert.equal(requests.length, count);
    assert.equal(entries.size, 3);
    assert.ok([...entries.keys()].every(key => !key.includes('test-session') && !key.includes('test-sid')));
});

test('WPZY refuses cross-provider redirects before sending credentials', async t => {
    const { search, requests } = setup(t, url => {
        if (url.origin === 'https://wpzy.org') return new Response(null, {status:302,headers:{Location:'https://by669.org/d/999'}});
        throw new Error('Cross-provider redirect should not be fetched');
    });
    const { body } = await search();
    assert.equal(body.resourceMeta.providers.wpzys, 'failed');
    assert.ok(requests.some(request => request.url.startsWith('https://wpzy.org/')));
    assert.ok(!requests.some(request => request.url === 'https://by669.org/d/999'));
});

test('host-only WPZY credentials are not sent to the www alias', async t => {
    const { search, requests } = setup(t, (url, headers) => {
        if (url.origin === 'https://wpzy.org') return new Response(null, {status:302,headers:{Location:'https://www.wpzy.org/search.htm?keyword=test'}});
        assert.equal(headers.get('Cookie'), null);
        return new Response('<title>用户登录</title><form action="user-login.htm"></form>');
    });
    const { body } = await search();
    assert.equal(body.resourceMeta.providerIssues.wpzys, 'login_required');
    assert.ok(requests.filter(request => request.url.startsWith('https://www.wpzy.org/')).every(request => request.cookie === null));
});

test('WPZY validates cookies and excludes analytics cookies from the upstream header', async t => {
    const { search, requests } = setup(t, () => new Response(WPZY_EMPTY_SEARCH_HTML));
    await search('bbs_token=test-session-a; HMACCOUNT=tracking; bbs_sid=test-sid');
    assert.equal(requests.find(request => request.url.startsWith('https://wpzy.org/'))?.cookie, LOGIN_COOKIE);
    requests.length = 0;
    await search('bbs_token=bad\r\nInjected: true; bbs_sid=test-sid');
    assert.ok(requests.every(request => request.cookie === null));
});

test('WPZY search results cannot masquerade as another provider or an old domain', async t => {
    const { search, requests } = setup(t, url => {
        if (url.pathname === '/search.htm') return new Response([
            thread(501),
            '<li data-href="https://by669.org/thread-502.htm"><a href="https://by669.org/thread-502.htm">流浪地球 夸克</a></li>',
            '<li data-href="https://www.wpzys.org/thread-503.htm"><a href="https://www.wpzys.org/thread-503.htm">流浪地球 夸克</a></li>',
            '<li data-href="https://www.wpzy.org/thread-504.htm#comments"><a href="https://www.wpzy.org/thread-504.htm#comments">流浪地球 夸克</a></li>'
        ].join(''));
        return new Response('<p>No public link in this post</p>');
    });
    const { body } = await search();
    assert.deepEqual(body.wpzysResources.map(item => item.url), ['https://wpzy.org/thread-501.htm','https://wpzy.org/thread-504.htm']);
    assert.ok(!requests.some(request => request.url.includes('/thread-502.htm') || request.url.includes('wpzys.org')));
});

test('WPZY rejects non-resource and action-query redirects without following them', async t => {
    const { search, requests } = setup(t, () => new Response(null, {status:302,headers:{Location:'thread-999.htm?delete=1'}}));
    const { body } = await search();
    assert.equal(body.resourceMeta.providers.wpzys, 'failed');
    assert.ok(!requests.some(request => request.url.includes('delete=1')));
});

test('WPZY detail login expiry is reported separately from restricted posts', async t => {
    const { search } = setup(t, url => url.pathname === '/search.htm'
        ? new Response(thread(601)) : new Response('<title>用户登录</title>'));
    const { body } = await search();
    assert.equal(body.resourceMeta.providers.wpzys, 'ok');
    assert.equal(body.resourceMeta.failedPages, 1);
    assert.equal(body.resourceMeta.loginRequiredPages, 1);
    assert.equal(body.resourceMeta.restrictedPages, 0);
    assert.equal(body.wpzysResources.length, 1);
});

test('WPZY detail reads are capped without dropping the full source result list', async t => {
    const { search, requests } = setup(t, url => url.pathname === '/search.htm'
        ? new Response(Array.from({length:14}, (_,index) => thread(701+index)).join(''))
        : new Response('<p>No public share link in this post</p>'));
    const { body } = await search();
    assert.equal(body.wpzysResources.length, 14);
    assert.equal(body.resourceMeta.selectedPages, 6);
    assert.equal(requests.filter(request => request.url.includes('/thread-')).length, 6);
});

test('resource failure logs redact WPZY login cookie fragments', async t => {
    const logs = [];
    const originalWarn = console.warn;
    console.warn = message => logs.push(String(message));
    t.after(() => { console.warn = originalWarn; });
    const { search } = setup(t, () => new Response('unused'));
    globalThis.fetch = async () => { throw new Error('Upstream failed: bbs_token=private-token; bbs_sid=private-sid'); };
    const { response, body } = await search();
    assert.equal(response.status, 502);
    assert.deepEqual(body, {error:'Resource providers unavailable'});
    assert.ok(logs.length > 0);
    assert.ok(logs.every(log => !log.includes('private-token') && !log.includes('private-sid')));
    assert.ok(logs.some(log => log.includes('[REDACTED]')));
});
