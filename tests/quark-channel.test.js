import test from 'node:test';
import assert from 'node:assert/strict';
import { handleResourceSearch } from '../worker/resources.js';
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
        const response = await handleResourceSearch('流浪地球', { QUARK_CHANNEL_SEARCH: '1' }, {}, { year: '2019' });
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
