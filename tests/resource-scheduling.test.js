import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/_worker.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

function setup(t, detail) {
    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    const started = [];
    let active = 0;
    let peak = 0;
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    globalThis.fetch = async input => {
        const url = new URL(input);
        if (url.hostname === 'zuidouyin.com') return Response.json([]);
        if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
        if (url.pathname === '/api/discussions') return Response.json({data:Array.from({length:12},(_,i)=>({id:String(i+1),attributes:{title:'Scheduling Movie 夸克'}}))});
        const page = Number(url.pathname.split('/').at(-1));
        started.push(page);
        peak = Math.max(peak, ++active);
        try { return new Response(await detail(page)); }
        finally { active--; }
    };
    t.after(() => Object.assign(globalThis, previous));
    return { started, peak:()=>peak, async search() {
        const response = await worker.fetch(new Request('https://worker.test/api/resource?q=Scheduling%20Movie&refresh=1', {
            headers:{'cf-connecting-ip':t.name}
        }),{}, {waitUntil(){}});
        assert.equal(response.status,200);
        return response.json();
    } };
}

test('a completed detail slot starts the next page before a slow earlier page finishes', async t => {
    let releaseFirst;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    let sawSeventh;
    const seventh = new Promise(resolve => { sawSeventh = resolve; });
    const { search, peak } = setup(t, async page => {
        if (page === 1) await first;
        if (page === 7) sawSeventh(true);
        return `https://pan.quark.cn/s/page-${page}`;
    });
    const pending = search();
    let timer;
    try {
        const startedBeforeFirstFinished = await Promise.race([
            seventh,
            new Promise(resolve => { timer = globalThis.setTimeout(()=>resolve(false),2000); })
        ]);
        assert.equal(startedBeforeFirstFinished,true,'page 7 must use a free connection instead of waiting for the entire first batch');
    } finally {
        globalThis.clearTimeout(timer);
        releaseFirst();
        const data = await pending;
        assert.ok(peak()<=6);
        assert.equal(data.resourceMeta.attemptedPages,12);
        assert.deepEqual(data.quarkUrls.map(item=>item.url),Array.from({length:12},(_,i)=>`https://pan.quark.cn/s/page-${i+1}`),
            'network completion order must not change share ordering');
    }
});

test('out-of-order completions preserve duplicate password evidence and failed-page accounting', async t => {
    const { search } = setup(t, async page => {
        if (page === 1) await new Promise(resolve=>globalThis.setTimeout(resolve,30));
        if (page === 3) throw new Error('temporary upstream failure');
        if (page === 1) return 'https://pan.quark.cn/s/duplicate?pwd=AAAA';
        if (page === 8) return 'https://pan.quark.cn/s/duplicate?pwd=BBBB';
        return `https://pan.quark.cn/s/page-${page}`;
    });
    const data = await search();
    assert.equal(data.resourceMeta.attemptedPages,12);
    assert.equal(data.resourceMeta.failedPages,1);
    assert.equal(data.resourceMeta.pages[2].status,'failed');
    const duplicate = data.quarkUrls.find(item=>item.url.endsWith('/duplicate'));
    assert.equal(duplicate.passwordConflict,true);
    assert.equal(duplicate.password,undefined);
    assert.equal(data.resourceMeta.pages[0].quarkUrls[0].password,'AAAA');
    assert.equal(data.resourceMeta.pages[7].quarkUrls[0].password,'BBBB');
});

test('the response cap does not stop scans needed to reconcile later duplicate passwords', async t => {
    const { search, started, peak } = setup(t, async page => Array.from({length:25},(_,i)=>
        `https://pan.quark.cn/s/page-${page}-${i}`).join('\n'));
    const data = await search();
    assert.equal(data.quarkUrls.length,100);
    assert.equal(started.length,12,'scan the bounded selected set before applying the aggregate result cap');
    assert.ok(peak()<=6);
    assert.equal(data.resourceMeta.attemptedPages,started.length);
    assert.equal(data.resourceMeta.pages.filter(page=>page.status==='ok').length,started.length);
    assert.deepEqual(data.quarkUrls.map(item=>item.url),Array.from({length:100},(_,i)=>`https://pan.quark.cn/s/page-${Math.floor(i/25)+1}-${i%25}`));
});

test('password conflict results do not depend on whether the cap fills before or after late pages', async t => {
    async function runOrder(order, subtest) {
        const releases = new Map();
        const started = [];
        const { search } = setup(subtest, page => {
            started.push(page);
            return new Promise(resolve => releases.set(page, resolve));
        });
        const pending = search();
        const tick = () => new Promise(resolve => globalThis.setImmediate(resolve));

        for (const page of order) {
            for (let attempt = 0; !releases.has(page) && attempt < 100; attempt += 1) await tick();
            assert.ok(releases.has(page), `detail page ${page} should have been scheduled; started ${started.join(',')}`);
            const body = page === 1
                ? ['https://pan.quark.cn/s/shared?pwd=aaaa', ...Array.from({ length: 24 }, (_, i) => `https://pan.quark.cn/s/first-${i}`)].join('\n')
                : page >= 2 && page <= 4
                    ? Array.from({ length: 25 }, (_, i) => `https://pan.quark.cn/s/page-${page}-${i}`).join('\n')
                    : page === 12 ? 'https://pan.quark.cn/s/shared?pwd=bbbb' : 'No shares';
            releases.get(page)(body);
            await tick();
        }

        const data = await pending;
        assert.equal(data.partial, false);
        assert.equal(data.resourceMeta.attemptedPages, 12);
        assert.equal(data.quarkUrls.length, 100);
        const shared = data.quarkUrls.find(item => item.url === 'https://pan.quark.cn/s/shared');
        assert.equal(shared.passwordConflict, true);
        assert.equal(shared.password, undefined);
        return data.quarkUrls.map(item => ({ url: item.url, password: item.password, passwordConflict: item.passwordConflict }));
    }

    let capFirstResult;
    let conflictFirstResult;
    await t.test('the cap fills before the conflicting page responds', async subtest => {
        capFirstResult = await runOrder(Array.from({ length: 12 }, (_, i) => i + 1), subtest);
        assert.ok(capFirstResult.some(item => item.passwordConflict));
    });
    await t.test('the conflicting page responds before the cap fills', async subtest => {
        conflictFirstResult = await runOrder([5, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 6], subtest);
        assert.ok(conflictFirstResult.some(item => item.passwordConflict));
    });
    assert.deepEqual(conflictFirstResult, capFirstResult);
});

test('an expired aggregate deadline leaves queued pages unattempted', async t => {
    let now = 1700000000000;
    t.mock.method(Date,'now',()=>now);
    const { search, started } = setup(t, async page => {
        await Promise.resolve();
        now += 16000;
        return `https://pan.quark.cn/s/page-${page}`;
    });
    const data = await search();
    assert.equal(started.length,6);
    assert.equal(data.resourceMeta.attemptedPages,6);
    assert.equal(data.resourceMeta.pages.filter(page=>page.status==='unattempted').length,6);
});
