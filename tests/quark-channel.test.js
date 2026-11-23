import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUARK_CHANNELS, getQuarkChannels, handleResourceSearch } from '../worker/resources.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

test('public Telegram results retain matched posts and reuse Quark extraction', async t => {
    const channelUrl = 'https://t.me/s/Quark_Movies';
    const post = (id, title, share) =>
        `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div data-post="Quark_Movies/${id}">\n`
        + `<div class="tgme_widget_message_text js-message_text">名称：${title}<br/><br/>`
        + `<a href="https://pan.quark.cn/s/${share}">夸克链接</a> 提取码：aB12</div></div></div>`;
    const html = '<section class="tgme_channel_history js-message_history">'
        + post(1, '<mark>流浪地球</mark><b> (2019) 4K</b>', 'ExampleA')
        + post(2, '流浪地球2 (2023)', 'Sequel')
        + post(3, '流浪地球 (2019) 壁纸', 'Wallpaper')
        + post(4, '流浪地球 (2024)', 'WrongYear')
        + post(5, '流浪地球更新目录 (2019)', 'Catalog')
        + post(6, '流浪地球 (2019) 蓝光', 'ExampleA')
        + '</section>';
    let channelAvailable = true;
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    t.after(() => { Object.assign(globalThis, { fetch: originalFetch, caches: originalCaches }); });
    globalThis.caches = { default: { match: async () => null } };
    globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.origin === 'https://t.me') {
            assert.equal(url.origin + url.pathname, channelUrl);
            assert.equal(url.searchParams.get('q'), '流浪地球');
            assert.equal(options.redirect, 'manual');
            return channelAvailable ? new Response(html) : new Response('', { status: 503 });
        }
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.hostname === 'zuidouyin.com') return Response.json([]);
        assert.equal(url.hostname, 'by669.org');
        return Response.json({ data: [] });
    };
    const search = async () => {
        const response = await handleResourceSearch('流浪地球', { QUARK_CHANNEL_SEARCH: '1', QUARK_CHANNELS: 'Quark_Movies' }, {}, { year: '2019' });
        assert.equal(response.status, 200);
        return response.json();
    };

    const result = await search();
    assert.deepEqual(result.quarkChannelResources.map(({ url }) => url), [`${channelUrl}/6`, `${channelUrl}/1`]);
    assert.equal(result.resourceMeta.providers.quarkChannel, 'ok');
    assert.equal(result.resourceMeta.attemptedPages, 2);
    assert.equal(result.quarkUrls.length, 1);
    assert.equal(result.quarkUrls[0].url, 'https://pan.quark.cn/s/ExampleA');
    assert.equal(result.quarkUrls[0].password, 'aB12');
    assert.equal(result.quarkUrls[0].sourceUrl, `${channelUrl}/6`);
    assert.ok(result.quarkChannelResources.every(post => !('text' in post)));

    channelAvailable = false;
    const partial = await search();
    assert.equal(partial.partial, true);
    assert.equal(partial.resourceMeta.providers.quarkChannel, 'failed');
    assert.equal(partial.resourceMeta.providers.by669, 'ok');
});

test('several channels are searched at once, each in its own title format', async t => {
    const page = (channel, posts) => '<section class="tgme_channel_history js-message_history">' + posts.map(([id, first, share]) =>
        `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div data-post="${channel}/${id}">\n`
        + `<div class="tgme_widget_message_text js-message_text">${first}<br/>年份：2023<br/>`
        + `<a href="https://pan.quark.cn/s/${share}">链接</a></div></div></div>`).join('') + '</section>';
    const pages = {
        chanAlpha: page('chanAlpha', [[1, '【标题】：漫长的季节 4K', 'alphaOne'], [2, '漫长的季节 全12集', 'alphaTwo'], [3, '另一部剧 2023', 'other']]),
        chanBravo: page('chanBravo', [[7, '🎬 名称：漫长的季节 (2023)', 'bravoOne'], [8, '✨ 漫长的季节.4K.x265', 'bravoTwo'], [9, '漫长的季节 解说', 'commentary']]),
        chanDown: null
    };
    const requested = [];
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    t.after(() => Object.assign(globalThis, previous));
    t.mock.method(console, 'warn', () => {});
    const cache = new Map();
    globalThis.caches = { default: {
        match: async key => cache.get(key.url)?.clone(),
        put: async (key, response) => { cache.set(key.url, response); }
    } };
    const writes = [];
    const ctx = { waitUntil(promise) { writes.push(promise); } };
    const flush = () => Promise.all(writes.splice(0));
    globalThis.fetch = async input => {
        const url = new URL(input);
        if (url.origin === 'https://t.me') {
            const channel = url.pathname.split('/').at(-1);
            requested.push(channel);
            return pages[channel] ? new Response(pages[channel]) : new Response('', { status: 503 });
        }
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.hostname === 'zuidouyin.com') return Response.json([]);
        return Response.json({ data: [] });
    };
    const env = { QUARK_CHANNEL_SEARCH: '1', QUARK_CHANNELS: 'chanAlpha, chanBravo,chanDown,bad name,x' };
    const identity = { year: '2023', id: '225008', mediaType: 'tv' };
    const scan = async options => {
        const response = await handleResourceSearch('漫长的季节', env, ctx, { ...identity, ...options });
        await flush();
        return response.json();
    };
    const result = await scan();
    assert.deepEqual(requested.sort(), ['chanAlpha', 'chanBravo', 'chanDown'], 'invalid channel names are ignored');
    assert.equal(result.resourceMeta.providers.quarkChannel, 'ok', 'one channel failing does not fail the source');
    // Newest first in each channel, alternating between channels.
    assert.deepEqual(result.quarkChannelResources.map(post => post.url), [
        'https://t.me/s/chanAlpha/2', 'https://t.me/s/chanBravo/8', 'https://t.me/s/chanAlpha/1', 'https://t.me/s/chanBravo/7'
    ]);
    assert.deepEqual(result.quarkChannelResources.map(post => post.title), ['漫长的季节 全12集', '漫长的季节.4K.x265', '漫长的季节 4K', '漫长的季节 (2023)']);
    assert.deepEqual(result.quarkUrls.map(item => item.url.split('/').at(-1)).sort(), ['alphaOne', 'alphaTwo', 'bravoOne', 'bravoTwo']);

    pages.chanBravo = null;
    pages.chanAlpha = page('chanAlpha', []);
    const partial = await scan({ refresh: true });
    assert.equal(partial.partial, true);
    assert.deepEqual(partial.resourceMeta.failedChannels, ['chanBravo', 'chanDown']);
    assert.deepEqual(partial.quarkUrls.map(item => item.url.split('/').at(-1)).sort(), ['bravoOne', 'bravoTwo']);
    assert.deepEqual((await scan({ cacheOnly: true })).quarkChannelResources, partial.quarkChannelResources);
    pages.chanBravo = page('chanBravo', []);
    assert.deepEqual((await scan({ refresh: true })).quarkUrls, []);

    pages.chanAlpha = null;
    pages.chanBravo = null;
    const down = await scan({ refresh: true });
    assert.equal(down.resourceMeta.providers.quarkChannel, 'failed', 'the source fails only when no channel answers');
});

test('the channel list defaults to the measured channels and accepts an override', () => {
    assert.deepEqual(getQuarkChannels({}), DEFAULT_QUARK_CHANNELS);
    assert.ok(DEFAULT_QUARK_CHANNELS.includes('Quark_Movies') && DEFAULT_QUARK_CHANNELS.length >= 5);
    assert.deepEqual(getQuarkChannels({ QUARK_CHANNELS: 'one_channel, two_channel ,two_channel' }), ['one_channel', 'two_channel']);
    assert.deepEqual(getQuarkChannels({ QUARK_CHANNELS: '../evil, a' }), DEFAULT_QUARK_CHANNELS, 'no valid name falls back to the defaults');
});
