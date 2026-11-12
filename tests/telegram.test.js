import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { logErrorMessage } from '../worker/core.js';
import {
    buildQuarkPage,
    callbackData,
    buildPostPage,
    escapeHtml,
    escapeTruncated,
    getTelegramWebhookSecret,
    parseCommand
} from '../worker/telegram.js';
import { tmdbDetail } from './fixtures/tmdb.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const ENV = { TMDB_API_KEY: 'test', TELEGRAM_BOT_TOKEN: TOKEN };

const FANHUA = tmdbDetail({
    id: 106841,
    name: '繁花',
    original_name: '繁花',
    first_air_date: '2023-12-27',
    overview: '1990年代的上海，阿宝<从>一无所有到成为商界新贵。',
    poster_path: '/fanhua.jpg',
    vote_average: 8.1,
    vote_count: 120,
    genres: [{ id: 18, name: '剧情' }, { id: 10768, name: 'War & Politics' }],
    number_of_seasons: 1,
    number_of_episodes: 30,
    seasons: [{ season_number: 1, name: '第 1 季', episode_count: 30 }],
    credits: { cast: [{ id: 1001, name: '胡歌', character: '阿宝' }], crew: [{ name: '王家卫', job: 'Director' }] }
});

let clientCounter = 0;

function setup(t, { tmdb = {}, resources = null, telegramFailures = {} } = {}) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const telegram = [];
    const entries = new Map();
    globalThis.caches = { default: {
        match: async key => entries.get(String(key.url || key))?.clone() ?? null,
        put: async (key, response) => { entries.set(String(key.url || key), response); },
        delete: async key => entries.delete(String(key.url || key))
    } };
    globalThis.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url));
        if (parsed.hostname === 'api.telegram.org') {
            const method = parsed.pathname.split('/').at(-1);
            const body = options.body ? JSON.parse(options.body) : {};
            const call = { method, body, path: parsed.pathname };
            telegram.push(call);
            if (telegramFailures[method]) return Response.json({ ok: false, description: telegramFailures[method] }, { status: 400 });
            const result = call.result = method === 'getMe' ? { username: 'iplay_test_bot' }
                : method === 'getWebhookInfo' ? { url: 'https://worker.test/telegram/webhook', pending_update_count: 0 }
                    : method === 'sendMessage' || method === 'sendPhoto' ? { message_id: 100 + telegram.length }
                        : true;
            return Response.json({ ok: true, result });
        }
        if (parsed.hostname === 'api.themoviedb.org') {
            const path = parsed.pathname.replace(/^\/3/, '');
            const handler = tmdb[path];
            if (handler) return Response.json(typeof handler === 'function' ? handler(parsed) : handler);
            if (path === '/tv/106841') return Response.json(FANHUA);
            if (path.startsWith('/search/')) return Response.json({ page: 1, results: [], total_results: 0 });
            return Response.json({ status_message: 'not found' }, { status: 404 });
        }
        if (resources) return resources(parsed);
        if (parsed.hostname === 'movie.douban.com') return Response.json([]);
        return new Response('not mocked', { status: 404 });
    };
    t.after(() => Object.assign(globalThis, previous));
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    return { telegram, sent: () => telegram.filter(call => !['sendChatAction', 'answerCallbackQuery'].includes(call.method)) };
}

async function deliver(update, env = ENV, secretOverride = null) {
    const work = [];
    const secret = secretOverride ?? await getTelegramWebhookSecret(env);
    clientCounter += 1;
    const response = await worker.fetch(new Request('https://worker.test/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret, 'cf-connecting-ip': `tg-${clientCounter}` },
        body: JSON.stringify(update)
    }), env, { waitUntil(promise) { work.push(promise); } });
    // Cache writes may enqueue more work while updates are processed.
    while (work.length) await Promise.all(work.splice(0));
    return response;
}

function textMessage(text, { userId = 42, chatType = 'private' } = {}) {
    return { update_id: 1, message: { message_id: 1, text, chat: { id: userId, type: chatType }, from: { id: userId } } };
}

function callback(data, { userId = 42, message = { message_id: 7, caption: 'detail' } } = {}) {
    return { update_id: 2, callback_query: { id: 'cb1', data, from: { id: userId }, message: { chat: { id: userId, type: 'private' }, ...message } } };
}

function allCallbackData(markup) {
    return (markup?.inline_keyboard || []).flat().map(entry => entry.callback_data).filter(Boolean);
}

test('the webhook is disabled without a bot token and rejects a wrong secret', async t => {
    setup(t);
    const disabled = await worker.fetch(new Request('https://worker.test/telegram/webhook', { method: 'POST', body: '{}' }), { TMDB_API_KEY: 'x' }, { waitUntil() {} });
    assert.equal(disabled.status, 404);
    const wrong = await deliver(textMessage('繁花'), ENV, 'not-the-secret');
    assert.equal(wrong.status, 401);
});

test('the setup route proves ownership with the bot token and registers the webhook', async t => {
    const { telegram } = setup(t);
    const denied = await worker.fetch(new Request('https://worker.test/telegram/setup?token=wrong', { headers: { 'cf-connecting-ip': 'setup-1' } }), ENV, { waitUntil() {} });
    assert.equal(denied.status, 401);
    assert.equal(telegram.length, 0);

    const response = await worker.fetch(new Request(`https://worker.test/telegram/setup?token=${encodeURIComponent(TOKEN)}`, { headers: { 'cf-connecting-ip': 'setup-2' } }), ENV, { waitUntil() {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.bot, '@iplay_test_bot');
    assert.equal(body.access, 'public');
    const setWebhook = telegram.find(call => call.method === 'setWebhook');
    assert.equal(setWebhook.body.url, 'https://worker.test/telegram/webhook');
    assert.equal(setWebhook.body.secret_token, await getTelegramWebhookSecret(ENV));
    assert.deepEqual(setWebhook.body.allowed_updates, ['message', 'callback_query']);
    assert.ok(telegram.some(call => call.method === 'setMyCommands'));
});

test('a confident title search sends the detail card with poster, score and actions', async t => {
    const { sent } = setup(t, { tmdb: {
        '/search/multi': { page: 1, total_results: 1, results: [{ ...FANHUA, media_type: 'tv' }] }
    } });
    const response = await deliver(textMessage('繁花'));
    assert.equal(response.status, 200);
    const [photo] = sent();
    assert.equal(photo.method, 'sendPhoto');
    assert.equal(photo.body.photo, 'https://image.tmdb.org/t/p/w500/fanhua.jpg');
    assert.match(photo.body.caption, /<b>繁花<\/b> \(2023\)/);
    assert.match(photo.body.caption, /剧情 \/ 战争 \/ 政治/, 'TMDB TV genres are normalized');
    assert.match(photo.body.caption, /推荐指数 <b>\d+<\/b>/);
    assert.match(photo.body.caption, /阿宝&lt;从&gt;/, 'summaries are HTML-escaped');
    const data = allCallbackData(photo.body.reply_markup);
    assert.ok(data.includes('ro|tv|106841'));
    assert.ok(data.includes('ao|1001'));
    const urls = photo.body.reply_markup.inline_keyboard.flat().map(entry => entry.url).filter(Boolean);
    assert.deepEqual(urls, ['https://iplay.hackx64.eu.org/?id=106841&type=tv&title=%E7%B9%81%E8%8A%B1']);
});

test('ambiguous titles become candidate buttons and a selected candidate opens its card', async t => {
    const { sent } = setup(t, { tmdb: {
        '/search/multi': { page: 1, total_results: 2, results: [
            { id: 1, media_type: 'movie', title: '英雄', release_date: '2002-12-19', vote_average: 7.2 },
            { id: 2, media_type: 'movie', title: '英雄', release_date: '1993-01-01', vote_average: 6 }
        ] },
        '/movie/1': tmdbDetail({ id: 1, title: '英雄', release_date: '2002-12-19' })
    } });
    await deliver(textMessage('英雄'));
    const [picker] = sent();
    assert.equal(picker.method, 'sendMessage');
    assert.match(picker.body.text, /找到 2 个结果/);
    assert.deepEqual(allCallbackData(picker.body.reply_markup), ['d|movie|1|', 'd|movie|2|']);

    await deliver(callback('d|movie|1|'));
    const card = sent().at(-1);
    assert.equal(card.method, 'sendMessage', 'a card without a poster falls back to text');
    assert.match(card.body.text, /<b>英雄<\/b> \(2002\)/);
});

test('resource buttons scan Quark links with copyable passwords and page in place', async t => {
    const shares = Array.from({ length: 8 }, (_, index) => `<p>链接：https://pan.quark.cn/s/fanhua${index} 提取码：ab${index}${index}</p>`).join('');
    const { sent } = setup(t, { resources: parsed => {
        const value = parsed.toString();
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: [{ id: '1', attributes: { title: '《繁花》2023 全30集 夸克' } }] });
        }
        if (value === 'https://by669.org/d/1') return new Response(shares);
        if (value.startsWith('https://wpzy.org/search.htm')) return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (parsed.hostname === 'movie.douban.com') return Response.json([]);
        return Response.json([]);
    } });

    await deliver(callback('ro|tv|106841'));
    const messages = sent();
    assert.match(messages[0].body.text, /正在扫描/);
    assert.deepEqual(allCallbackData(messages[0].body.reply_markup), ['rf|tv|106841'], 'the placeholder can always be rescanned');
    const page = messages.at(-1);
    assert.equal(page.method, 'editMessageText');
    assert.equal(page.body.message_id, messages[0].result.message_id, 'the scan result replaces its placeholder');
    assert.match(page.body.text, /共 8 个分享链接/);
    assert.match(page.body.text, /<a href="https:\/\/pan\.quark\.cn\/s\/fanhua0">https:\/\/pan\.quark\.cn\/s\/fanhua0<\/a>/);
    assert.match(page.body.text, /提取码：<code>ab00<\/code>/);
    const copy = page.body.reply_markup.inline_keyboard.flat().filter(entry => entry.copy_text);
    assert.equal(copy.length, 6, 'one copy button per password on the page');
    assert.equal(copy[0].copy_text.text, 'ab00');
    assert.ok(allCallbackData(page.body.reply_markup).includes('r|tv|106841|1'));

    await deliver(callback('r|tv|106841|1', { message: { message_id: 55, text: '繁花 · 夸克资源' } }));
    const second = sent().at(-1);
    assert.equal(second.method, 'editMessageText');
    assert.equal(second.body.message_id, 55);
    assert.match(second.body.text, /7\. /);
    assert.match(second.body.text, /fanhua7/);
});

test('an actor name opens the actor\'s works with filters and paging', async t => {
    const credits = Array.from({ length: 10 }, (_, index) => ({
        id: 500 + index, media_type: index % 2 ? 'tv' : 'movie', title: `作品${index}`, name: `作品${index}`,
        release_date: '2020-01-01', first_air_date: '2020-01-01', character: `角色${index}`
    }));
    const { sent } = setup(t, { tmdb: {
        '/search/person': { results: [{ id: 1001, name: '胡歌', known_for_department: 'Acting', popularity: 10 }] },
        '/person/1001': { id: 1001, name: '胡歌', combined_credits: { cast: credits } }
    } });
    await deliver(textMessage('/actor@iplay_test_bot 胡歌'));
    const list = sent().at(-1);
    assert.match(list.body.text, /👤 <b>胡歌<\/b>/);
    const data = allCallbackData(list.body.reply_markup);
    assert.ok(data.some(value => /^d\|(movie|tv)\|5\d\d$/.test(value)));
    assert.ok(data.includes('a|1001|8|'), 'next page');
    assert.ok(data.includes('a|1001|0|tv'), 'TV filter');

    await deliver(callback('a|1001|0|tv', { message: { message_id: 9, text: '👤 胡歌' } }));
    const filtered = sent().at(-1);
    assert.equal(filtered.method, 'editMessageText');
    assert.match(filtered.body.text, /剧集：第 1–5 部，共 5 部/);
});

test('an allow-list blocks other users and tells them their id', async t => {
    const { sent } = setup(t);
    await deliver(textMessage('繁花', { userId: 777 }), { ...ENV, TELEGRAM_ALLOWED_USERS: '42, 43' });
    assert.match(sent()[0].body.text, /<code>777<\/code>/);
});

test('group chats only answer commands', async t => {
    const { sent } = setup(t);
    await deliver(textMessage('随便聊聊', { chatType: 'group' }));
    assert.equal(sent().length, 0);
    await deliver(textMessage('/ban someone', { chatType: 'group' }));
    await deliver(textMessage('/help@another_bot', { chatType: 'group' }));
    assert.equal(sent().filter(call => call.method !== 'getMe').length, 0, 'unknown commands and other bots\' commands are ignored');
    await deliver(textMessage('/help@iplay_test_bot', { chatType: 'group' }));
    const help = sent().filter(call => call.method !== 'getMe')[0];
    assert.match(help.body.text, /iPlay 追剧助手/);
    assert.equal(help.body.reply_parameters.message_id, 1, 'group answers reply to the asking message');
});

test('helpers keep callback data within Telegram limits and escape HTML', () => {
    assert.throws(() => callbackData('q', 'x'.repeat(70)));
    assert.equal(callbackData('r', 'tv', 123456789012, 99), 'r|tv|123456789012|99');
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.deepEqual(parseCommand('/search@Bot 繁花 第二季'), { command: 'search', mention: 'bot', argument: '繁花 第二季' });
    assert.deepEqual(parseCommand('繁花'), { command: null, mention: null, argument: '繁花' });
    assert.equal(logErrorMessage(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage failed`), 'fetch https://api.telegram.org/bot[REDACTED]/sendMessage failed');
});

test('a resource page reports provider failures and stale rescans', () => {
    const { text, markup } = buildQuarkPage({ id: 1, mediaType: 'movie', title: '测试', year: '2024' }, {
        quarkUrls: [{ title: 'x', url: 'javascript:alert(1)' }],
        resources: [{ title: '帖子', url: 'https://by669.org/d/1' }],
        resourceMeta: { providers: { by669: 'ok', wpzys: 'failed', zuidouyin: 'ok' } }
    }, 0, { stale: true });
    assert.match(text, /暂未提取到夸克链接，但找到 1 个资源帖/);
    assert.match(text, /WPZY 暂时不可用/);
    assert.match(text, /之前的结果/);
    assert.ok(allCallbackData(markup).includes('rp|movie|1|0'));
});

test('a requested season is never attached to a movie', async t => {
    const { sent } = setup(t, { tmdb: {
        '/search/multi': { page: 1, total_results: 2, results: [
            { id: 11, media_type: 'movie', title: '英雄', release_date: '2002-12-19' },
            { id: 12, media_type: 'tv', name: '英雄', first_air_date: '2006-01-01' }
        ] },
        '/search/tv': { page: 1, total_results: 1, results: [{ id: 12, name: '英雄', first_air_date: '2006-01-01' }] },
        '/movie/11': tmdbDetail({ id: 11, title: '英雄', release_date: '2002-12-19' })
    } });
    await deliver(textMessage('英雄 第二季'));
    const data = sent().flatMap(call => allCallbackData(call.body.reply_markup));
    assert.ok(!data.some(value => /^d\|movie\|\d+\|\d/.test(value)), `movie buttons carry no season: ${data}`);

    // A stale button from an older release still opens the movie.
    await deliver(callback('d|movie|11|2'));
    assert.match(sent().at(-1).body.text, /<b>英雄<\/b> \(2002\)/);
});

test('a failed scan turns its placeholder into a retry, not a dead end', async t => {
    const { sent } = setup(t, { resources: () => new Response('down', { status: 503 }) });
    await deliver(callback('ro|tv|106841'));
    const last = sent().at(-1);
    assert.equal(last.method, 'editMessageText');
    assert.match(last.body.text, /资源扫描失败/);
    assert.deepEqual(allCallbackData(last.body.reply_markup), ['rf|tv|106841']);
    assert.equal(sent().filter(call => call.method === 'sendMessage').length, 1, 'no separate error message');
});

test('posts and Quark links switch inside one message', async t => {
    const { sent } = setup(t, { resources: parsed => {
        const value = parsed.toString();
        if (value.startsWith('https://by669.org/api/discussions')) {
            return Response.json({ data: [{ id: '1', attributes: { title: '《繁花》2023 全30集' } }] });
        }
        if (value === 'https://by669.org/d/1') return new Response('<p>no links here</p>');
        if (value.startsWith('https://wpzy.org/search.htm')) return new Response(WPZY_EMPTY_SEARCH_HTML);
        return Response.json([]);
    } });
    const resourceMessage = { message_id: 70, text: '繁花 · 夸克资源' };
    await deliver(callback('rp|tv|106841|0', { message: resourceMessage }));
    const posts = sent().at(-1);
    assert.equal(posts.method, 'editMessageText');
    assert.equal(posts.body.message_id, 70);
    assert.match(posts.body.text, /资源帖（1）/);
    assert.ok(allCallbackData(posts.body.reply_markup).includes('r|tv|106841|0'));

    await deliver(callback('r|tv|106841|0', { message: { message_id: 70, text: '繁花 · 资源帖（1）' } }));
    const back = sent().at(-1);
    assert.equal(back.method, 'editMessageText', 'going back edits in place instead of posting a new scan');
    assert.equal(back.body.message_id, 70);
});

test('long URLs and escaped text never cut the HTML markup', () => {
    const longUrl = `https://pan.quark.cn/s/${'a'.repeat(1900)}`;
    const detail = { id: 1, mediaType: 'movie', title: '测试', year: '2024' };
    const { text, markup } = buildQuarkPage(detail, {
        quarkUrls: Array.from({ length: 6 }, (_, index) => ({ title: `分享${index}`, url: `${longUrl}${index}`, password: 'ab12', sourceUrl: `${longUrl}src` }))
    }, 0);
    assert.ok(text.length <= 4096);
    assert.equal((text.match(/<a /g) || []).length, (text.match(/<\/a>/g) || []).length, 'every link is closed');
    assert.match(text, /链接过长未显示/);
    const shownLinks = (text.match(/🔗/g) || []).length;
    assert.equal(markup.inline_keyboard.flat().filter(entry => entry.copy_text).length, shownLinks, 'copy buttons match the links shown');

    const posts = buildPostPage(detail, { resources: Array.from({ length: 8 }, (_, index) => ({ title: `帖${index}`, url: `${longUrl}${index}` })) }, 0);
    assert.ok(posts.text.length <= 4096);

    const escaped = escapeTruncated('"&<>'.repeat(2000), 3600);
    assert.ok(escaped.length <= 3600);
    assert.doesNotMatch(escaped, /&[a-z]*$/, 'no entity is cut in half');
    assert.equal(escapeTruncated('短文本', 100), '短文本');
});

test('internal and Telegram errors are not shown to users', async t => {
    const { sent } = setup(t, { telegramFailures: { sendPhoto: 'Bad Request: wrong file identifier/HTTP URL specified' }, tmdb: {
        '/search/multi': { page: 1, total_results: 1, results: [{ ...FANHUA, media_type: 'tv' }] }
    } });
    await deliver(textMessage('繁花'));
    const messages = sent();
    assert.equal(messages.at(-1).method, 'sendMessage', 'a rejected photo falls back to a text card');
    assert.ok(!messages.some(call => /Bad Request|Telegram/.test(call.body.text || '')));
});

test('non-text private messages get a hint and bots are ignored', async t => {
    const { sent } = setup(t);
    await deliver({ update_id: 5, message: { message_id: 3, photo: [{}], chat: { id: 42, type: 'private' }, from: { id: 42 } } });
    assert.match(sent()[0].body.text, /请发送文字/);
    await deliver({ update_id: 6, message: { message_id: 4, text: '繁花', chat: { id: 42, type: 'private' }, from: { id: 99, is_bot: true } } });
    assert.equal(sent().length, 1);
});

test('buttons on photo cards from older releases still work', async t => {
    const { sent } = setup(t, { resources: () => Response.json([]), tmdb: {
        '/person/1001': { id: 1001, name: '胡歌', combined_credits: { cast: [] } }
    } });
    await deliver(callback('a|1001|0|', { message: { message_id: 7, caption: 'card' } }));
    assert.equal(sent().at(-1).method, 'sendMessage', 'a photo card is never edited into text');
    await deliver(callback('r|tv|106841|0', { message: { message_id: 7, caption: 'card' } }));
    assert.ok(!sent().some(call => call.method === 'editMessageText' && call.body.message_id === 7));
});

test('the card score counts a Chinese Wikipedia article and follow-ups lead back to the card', async t => {
    let wikiAvailable = true;
    const { sent } = setup(t, { resources: parsed => {
        if (parsed.hostname !== 'zh.wikipedia.org') return Response.json([]);
        if (!wikiAvailable) return Response.json({ query: { search: [] } });
        return parsed.pathname.endsWith('/w/api.php')
            ? Response.json({ query: { search: [{ title: '繁花 (电视剧)' }] } })
            : Response.json({ title: '繁花 (电视剧)', description: '2023年中国电视剧', extract: '《繁花》是2023年播出的中国电视剧。' });
    } });
    const score = text => Number(/推荐指数 <b>(\d+)<\/b>/.exec(text)[1]);
    await deliver(callback('d|tv|106841|'));
    const withWiki = score(sent().at(-1).body.caption);

    await deliver(callback('w|tv|106841'));
    const synopsis = sent().at(-1);
    assert.match(synopsis.body.text, /中文 Wikipedia/);
    assert.deepEqual(allCallbackData(synopsis.body.reply_markup), ['ro|tv|106841', 'd|tv|106841|']);

    await deliver(callback('ss|106841'));
    assert.ok(allCallbackData(sent().at(-1).body.reply_markup).includes('d|tv|106841|'));

    wikiAvailable = false;
    globalThis.caches.default.match = async () => null;
    await deliver(callback('d|tv|106841|'));
    assert.equal(withWiki - score(sent().at(-1).body.caption), 5, 'the article is worth the same 5 points as on the page');
});
