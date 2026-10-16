import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';

function setup(t) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const writes = [];
    let summary;
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    globalThis.fetch = async input => new URL(input).pathname.includes('/summary/')
        ? Response.json(summary)
        : Response.json({ query: { search: [{ title: 'Shared Work' }] } });
    t.after(() => Object.assign(globalThis, previous));
    return async (extract, year, extra = {}) => {
        summary = { title: 'Shared Work', description: '美国科幻电影', extract, ...extra };
        const response = await worker.fetch(new Request(`https://worker.test/api/wiki/zh?q=Shared%20Work&type=movie&year=${year}`, {
            headers: { 'cf-connecting-ip': t.name }
        }), {}, { waitUntil(promise) { writes.push(promise); } });
        await Promise.all(writes.splice(0));
        return response;
    };
}

test('Wiki restoration, rerelease and award years do not override the work release year', async t => {
    const search = setup(t);
    for (const extract of [
        '《Shared Work》是一部1984年上映、2021年修复重映的美国科幻电影。',
        '《Shared Work》是一部1984年电影，由2021年获奖的某导演执导。',
        '《Shared Work》是一部1984年电影，于2021年重新上映。',
        'Shared Work is a 1984 science fiction film restored and re-released in 2021.',
        'Shared Work is a film first released in 1984 and restored in 2021.',
        'Shared Work is a 1984 film, directed by the 2021 Academy Award winner.'
    ]) {
        assert.equal((await search(extract, '2021')).status, 404, extract);
        assert.equal((await search(extract, '1984')).status, 200, extract);
    }
});

test('incidental years alone do not establish a requested Wiki work year', async t => {
    const search = setup(t);
    for (const extract of ['《Shared Work》是一部电影，2021年完成修复。', 'Shared Work is a film restored in 2021.']) {
        assert.equal((await search(extract, '2021')).status, 404);
    }
});

test('Wiki keeps independent regional release years as possible work evidence', async t => {
    const search = setup(t);
    for (const year of ['1984', '1985']) {
        assert.equal((await search('《Shared Work》于1984年在美国首映、1985年在中国上映，是一部科幻电影。', year)).status, 200);
    }
});

test('a contradictory explicit Wiki title year is not overridden by the description year', async t => {
    const search = setup(t);
    const response = await search('《Shared Work》是一部电影。', '2021', {
        title: 'Shared Work (1984年电影)', description: '2021年电影'
    });
    assert.equal(response.status, 404);
});
