import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers';
import worker from '../worker/_worker.js';
import { createResourceTitleMatcher, resourceTitleHasYear } from '../worker/resources.js';

function mock(t, fetcher) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    globalThis.fetch = fetcher;
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    t.after(() => Object.assign(globalThis, previous));
}

async function search(query, ip) {
    const response = await worker.fetch(new Request(`https://worker.test/api/tmdb/search?q=${encodeURIComponent(query)}`, {
        headers: { 'cf-connecting-ip': ip }
    }), { TMDB_API_KEY: 'test' }, { waitUntil() {} });
    return response.json();
}

test('a type word that belongs to the title does not filter the work out', async t => {
    mock(t, async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/search/multi')) {
            return Response.json({ results: [
                { id: 37165, media_type: 'movie', title: 'The Truman Show', original_title: 'The Truman Show', release_date: '1998-06-04' },
                { id: 9, media_type: 'movie', title: 'Truman', original_title: 'Truman', release_date: '2015-01-01' }
            ] });
        }
        return Response.json({ results: [] });
    });
    const partial = await search('truman show', 'type-word-1');
    assert.equal(partial.results[0]?.id, 37165, '"show" is part of the movie title');
    assert.ok(!partial.results.some(item => item.id === 9), 'a movie without the word is still filtered');

    const instructed = await search('The Truman Show 1998 TV', 'type-word-2');
    assert.deepEqual(instructed.results, [], 'a separate type word remains an instruction');
});

test('series threads may name a season after the title; movies may not', () => {
    const series = createResourceTitleMatcher('庆余年', 'tv');
    for (const title of ['庆余年2 全36集 4K', '庆余年Ⅱ 2024', '【国剧】庆余年1-2季 合集', '庆余年S02', '庆余年20集', '庆余年沪语版']) {
        assert.equal(series(title), true, title);
    }
    for (const title of ['庆余年2：风起', '庆余年之后', '庆余年show']) assert.equal(series(title), false, title);

    const movie = createResourceTitleMatcher('流浪地球', 'movie');
    assert.equal(movie('流浪地球2 (2023) 4K'), false);
    assert.equal(movie('流浪地球HDR 2019'), true);
    assert.equal(createResourceTitleMatcher('lost', 'tv')('losthd'), false);
});

test('resolutions and bitrates are not release years', () => {
    assert.equal(resourceTitleHasYear('狂飙 1920x1080', '2023', 'tv'), true);
    assert.equal(resourceTitleHasYear('狂飙 2000kbps', '2023', 'tv'), true);
    assert.equal(resourceTitleHasYear('狂飙 2021', '2023', 'tv'), false);
});

test('the page allows the Cloudflare analytics beacon and links its icons', async () => {
    const html = await readFile('index.html', 'utf8');
    assert.match(html, /script-src 'self' https:\/\/static\.cloudflareinsights\.com;/);
    assert.match(html, /connect-src 'self' https:\/\/cloudflareinsights\.com /);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /property="og:image"/);
});

test('a missing entry offers no retry and a missing season offers the whole series', async () => {
    const main = await readFile('js/main.js', 'utf8');
    assert.match(main, /actionLabel: seasonMissing \? '查看全剧' : entryMissing \? '' : '重试详情'/);
    assert.match(main, /reload\(\{ deferEnrichments: false, requestedSeason: null \}\)/);
});

test('the detail page leads to resources before the data dossier', async () => {
    const html = await readFile('index.html', 'utf8');
    assert.match(html, /id="jumpToResources"/);
    assert.match(html, /id="quickSearches"/);
    assert.ok(html.indexOf('id="resourcesSection"') < html.indexOf('id="profilePanel"'), 'resources come first');
    assert.ok(html.indexOf('id="tmdbOverview"') < html.indexOf('id="resourcesSection"'));
});

test('Quark cards keep the share address case and drop duplicate sources', async () => {
    const main = await readFile('js/main.js', 'utf8');
    const card = main.slice(main.indexOf('function renderQuarkUrls'), main.indexOf('function renderQuarkUrls') + 1400);
    assert.doesNotMatch(card.match(/metaClass: '[^']*'/)[0], /uppercase/);
    assert.match(card, /item\.sourceTitle !== item\.title/);
    assert.match(main, /searchRetryEdits \? '修改关键词'/);
});

test('an actor\'s works can be ordered by rating, with thinly rated works last', async t => {
    const cast = [
        { id: 1, media_type: 'movie', title: 'New Few Votes', release_date: '2025-01-01', vote_average: 10, vote_count: 2 },
        { id: 2, media_type: 'movie', title: 'Old Classic', release_date: '2005-01-01', vote_average: 8.9, vote_count: 900 },
        { id: 3, media_type: 'tv', name: 'Mid Series', first_air_date: '2015-01-01', vote_average: 7.5, vote_count: 300 }
    ];
    mock(t, async () => Response.json({ id: 77, name: 'Sorted Actor', combined_credits: { cast } }));
    const page = async query => {
        const response = await worker.fetch(new Request(`https://worker.test/api/tmdb/person?id=77${query}`, {
            headers: { 'cf-connecting-ip': `sort${query}` }
        }), { TMDB_API_KEY: 'test' }, { waitUntil() {} });
        return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await page('')).body.credits.map(credit => credit.id), [1, 3, 2], 'newest first by default');
    assert.deepEqual((await page('&sort=rating')).body.credits.map(credit => credit.id), [2, 3, 1]);
    assert.deepEqual((await page('&sort=rating&mediaType=movie')).body.credits.map(credit => credit.id), [2, 1]);
    assert.equal((await page('&sort=bogus')).status, 400);
});

test('the detail page offers favorites, one synopsis and a way back to search', async () => {
    const [html, main] = await Promise.all([readFile('index.html', 'utf8'), readFile('js/main.js', 'utf8')]);
    for (const id of ['favoriteToggle', 'favoriteList', 'backToTop', 'actorSortToggle', 'tmdbOverviewPanel']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /<details id="tmdbOverviewPanel"/);
    assert.match(main, /RESOURCE_AUTO_START_MS = 1500/);
    assert.doesNotMatch(main, /createInfoCard\('(?:Runtime|Cast|Director|Genres)'/);
});

test('"第N部" searches without the marker and does not restrict results to series', async t => {
    const queries = [];
    mock(t, async url => {
        const parsed = new URL(String(url));
        if (!parsed.pathname.includes('/search/')) return Response.json({ results: [] });
        queries.push(parsed.searchParams.get('query'));
        return Response.json({ results: parsed.searchParams.get('query') === '怪奇物语' ? [
            { id: 66732, media_type: 'tv', name: '怪奇物语', first_air_date: '2016-07-15' },
            { id: 9001, media_type: 'movie', title: '怪奇物语', release_date: '2020-01-01' }
        ] : [] });
    });
    const data = await search('怪奇物语 第4部', 'part-1');
    assert.ok(queries.includes('怪奇物语'), 'the cleaned title is searched');
    assert.equal(data.searchMeta.season, 4);
    assert.equal(data.searchMeta.mediaType, null);
    assert.deepEqual(data.results.map(item => item.mediaType).sort(), ['movie', 'tv']);

    const strict = await search('怪奇物语 第4季', 'part-2');
    assert.equal(strict.searchMeta.mediaType, 'tv');
    assert.ok(strict.results.every(item => item.mediaType === 'tv'));
});

test('a season search does not wait for a detail the page cannot reuse', async t => {
    let detailRequested = false;
    mock(t, async url => {
        const path = new URL(String(url)).pathname;
        if (path.includes('/search/')) {
            return Response.json({ results: [{ id: 5, media_type: 'tv', name: '庆余年', first_air_date: '2019-11-26' }] });
        }
        detailRequested = true;
        await new Promise(resolve => setTimeout(resolve, 1200));
        return Response.json({ id: 5, name: '庆余年', external_ids: {}, credits: { cast: [], crew: [] } });
    });
    const started = Date.now();
    const data = await search('庆余年 第二季', 'season-wait');
    assert.ok(Date.now() - started < 600, 'the response is not held for the prefetch');
    assert.equal(data.prefetched, undefined);
    assert.equal(detailRequested, true, 'the upstream cache is still warmed');
});

test('"第N部" is found before a year or type word and ignored after a named season', async t => {
    mock(t, async () => Response.json({ results: [] }));
    assert.equal((await search('沙丘 第二部 2024', 'part-year')).searchMeta.season, 2);
    assert.equal((await search('哈利波特第1部（国语）', 'part-note')).searchMeta.season, 1);
    assert.equal((await search('进击的巨人 最终季 第2部', 'part-final')).searchMeta.season, null);
    assert.equal((await search('我的第一部动画片', 'part-title')).searchMeta.season, null);
});

test('favorites need a confirmed work, and only typed searches are remembered', async () => {
    const main = await readFile('js/main.js', 'utf8');
    assert.match(main, /if \(!activeDetailState\?\.detailConfirmed\) return;/);
    assert.match(main, /favoriteToggle\.disabled = !activeDetailState\?\.detailConfirmed/);
    assert.match(main, /if \(historyMode === 'push'\) rememberSearch\(query\);/);
    assert.match(main, /searchRetryEdits = !onRetry && error\?\.noMatch === true;/);
    assert.match(main, /if \(url\.search === window\.location\.search\) return;/);
});
