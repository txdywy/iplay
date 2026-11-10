import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
