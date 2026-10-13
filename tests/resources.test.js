import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeResourceState, resourceQueryKey } from '../js/resources.js';

const sourceA = { title: 'A', url: 'https://by669.com/a', source: 'by669' };
const sourceB = { title: 'B', url: 'https://wpzy.org/thread-1.htm', source: 'wpzys' };
const share = (suffix, password, passwordRank = 1) => ({
    url: `https://pan.quark.cn/s/${suffix}`, ...(password ? { password, passwordRank } : {})
});
const page = (source, quarkUrls, status = 'ok') => ({ ...source, status, ...(quarkUrls ? { quarkUrls } : {}) });
function scan({ by669 = 'ok', wpzys = 'ok', resources = [sourceA], wpzysResources = [sourceB], pages = [], partial = false } = {}) {
    return { resources, wpzysResources, quarkUrls: [], partial, resourceMeta: { providers: { by669, wpzys }, pages, partial } };
}

test('partial retries preserve failed providers and replace successfully fetched pages', () => {
    const initial = mergeResourceState(null, scan({ wpzys: 'failed', wpzysResources: [], partial: true, pages: [page(sourceA, [share('retained', 'keep')])] }));
    const retried = mergeResourceState(initial, scan({ by669: 'failed', resources: [], partial: true, pages: [page(sourceB, [share('new', 'new1')])] }));
    assert.deepEqual(retried.result.resources, [sourceA]);
    assert.deepEqual(retried.result.wpzysResources, [sourceB]);
    assert.deepEqual(retried.result.quarkUrls.map(item => [item.url, item.password]), [
        ['https://pan.quark.cn/s/retained', 'keep'], ['https://pan.quark.cn/s/new', 'new1']
    ]);
    assert.equal(initial.result.quarkUrls.length, 1, 'merging must not mutate a prior snapshot');
    const recovered = mergeResourceState(retried, scan({ pages: [page(sourceA, []), page(sourceB, [share('new', 'new2')])] }));
    assert.deepEqual(recovered.result.quarkUrls.map(item => item.password), ['new2']);
});

test('successful searches invalidate deleted pages while failed and unattempted detail pages retain evidence', () => {
    const initial = mergeResourceState(null, scan({ pages: [page(sourceA, [share('a', 'aaaa')]), page(sourceB, [share('b', 'bbbb')])] }));
    for (const status of ['failed', 'unattempted']) {
        const retried = mergeResourceState(initial, scan({ partial: true, resources: [], pages: [page(sourceB, null, status)] }));
        assert.deepEqual(retried.result.quarkUrls.map(item => item.url), ['https://pan.quark.cn/s/b'], status);
    }
});

test('a page that now requires authorization keeps its source card but removes old extracted shares', () => {
    const initial = mergeResourceState(null, scan({ pages: [page(sourceB, [share('private', 'keep')])] }));
    for (const status of ['restricted', 'login_required']) {
        const restricted = mergeResourceState(initial, scan({ partial: true, pages: [page(sourceB, null, status)] }));
        assert.deepEqual(restricted.result.quarkUrls, []);
        assert.deepEqual(restricted.result.wpzysResources, [sourceB]);
    }
});

test('cross-page password conflicts cannot resurrect an old password, and URL evidence outranks prose', () => {
    const initial = mergeResourceState(null, scan({ wpzys: 'failed', wpzysResources: [], partial: true, pages: [page(sourceA, [share('shared', 'aaaa')])] }));
    const conflict = mergeResourceState(initial, scan({ by669: 'failed', resources: [], partial: true, pages: [page(sourceB, [share('shared', 'bbbb')])] }));
    assert.equal(conflict.result.quarkUrls.length, 1);
    assert.equal(conflict.result.quarkUrls[0].password, undefined);
    assert.equal(conflict.result.quarkUrls[0].passwordConflict, true);
    const explicit = mergeResourceState(conflict, scan({ by669: 'failed', resources: [], partial: true, pages: [page(sourceB, [share('shared', 'cccc', 2)])] }));
    assert.equal(explicit.result.quarkUrls[0].password, 'cccc');
    const conflictedExplicit = mergeResourceState(explicit, scan({ by669: 'failed', resources: [], partial: true, pages: [page(sourceB, [{ ...share('shared'), passwordRank: 2, passwordConflict: true }])] }));
    assert.equal(conflictedExplicit.result.quarkUrls[0].password, undefined, 'a conflict with omitted password remains authoritative');
});

test('same-page successful evidence clears old passwords and former conflicts', () => {
    const initial = mergeResourceState(null, scan({ pages: [page(sourceA, [share('a', 'aaaa')]), page(sourceB, [share('a', 'bbbb')])] }));
    assert.equal(initial.result.quarkUrls[0].passwordConflict, true);
    const corrected = mergeResourceState(initial, scan({ pages: [page(sourceA, [share('a', 'cccc')]), page(sourceB, [])] }));
    assert.equal(corrected.result.quarkUrls[0].password, 'cccc');
    const publicShare = mergeResourceState(corrected, scan({ pages: [page(sourceA, [share('a')]), page(sourceB, [])] }));
    assert.equal(publicShare.result.quarkUrls[0].password, undefined);
});

test('provider login expiration clears old extracted shares while retaining the source for maintenance', () => {
    const initial = mergeResourceState(null, scan({ pages: [page(sourceB, [share('private', 'keep')])] }));
    const unavailable = scan({ wpzys: 'failed', wpzysResources: [], partial: true });
    unavailable.resourceMeta.providerIssues = { wpzys: 'login_required' };
    const expired = mergeResourceState(initial, unavailable);
    assert.deepEqual(expired.result.quarkUrls, []);
    assert.deepEqual(expired.result.wpzysResources, [sourceB]);
});

test('detail login expiration invalidates retained evidence for that provider while keeping current public-page evidence', () => {
    const secondB = { ...sourceB, url: 'https://wpzy.org/thread-2.htm' };
    const initial = mergeResourceState(null, scan({ wpzysResources: [sourceB, secondB], pages: [page(sourceB, [share('b', 'bbbb')]), page(secondB, [share('c', 'cccc')])] }));
    const retried = mergeResourceState(initial, scan({ partial: true, wpzysResources: [sourceB, secondB], pages: [page(sourceB, null, 'login_required'), page(secondB, null, 'unattempted'), page(sourceA, [share('public', 'aaaa')])] }));
    assert.deepEqual(retried.result.quarkUrls.map(item => item.url), ['https://pan.quark.cn/s/public']);
});

test('display cap still reconciles conflicts encountered after the first hundred unique shares', () => {
    const links = Array.from({ length: 125 }, (_, index) => share(String(index), 'aaaa'));
    const result = mergeResourceState(null, scan({ pages: [page(sourceA, links), page(sourceB, [share('0', 'bbbb')])] }));
    assert.equal(result.result.quarkUrls.length, 100);
    assert.equal(result.result.quarkUrls[0].password, undefined);
    assert.equal(result.result.quarkUrls[0].passwordConflict, true);
    assert.equal(result.pages[0].quarkUrls.length, 125, 'retained evidence remains available for later scans');
});

test('legacy resource responses remain usable and full scans clear obsolete links', () => {
    const initial = mergeResourceState(null, { partial: true, resources: [sourceA], quarkUrls: [{ ...share('legacy', 'keep'), sourceUrl: sourceA.url }], resourceMeta: { providers: { by669: 'ok', wpzys: 'failed' } } });
    const retried = mergeResourceState(initial, { partial: true, resources: [], wpzysResources: [sourceB], quarkUrls: [{ ...share('new', 'new1'), sourceUrl: sourceB.url }], resourceMeta: { providers: { by669: 'failed', wpzys: 'ok' } } });
    assert.equal(retried.result.quarkUrls.length, 2);
    const complete = mergeResourceState(retried, { resources: [], wpzysResources: [], quarkUrls: [] });
    assert.deepEqual(complete.result.quarkUrls, []);
});

test('legacy passwords with unknown confidence cannot override or conceal equal-confidence conflicts', () => {
    for (const rank of [1, 2]) {
        const initial = mergeResourceState(null, scan({ wpzys: 'failed', wpzysResources: [], partial: true, pages: [page(sourceA, [share('shared', 'AAAA', rank)])] }));
        const retried = mergeResourceState(initial, {
            partial: true, resources: [], wpzysResources: [sourceB],
            quarkUrls: [{ url: 'https://pan.quark.cn/s/shared', password: 'BBBB', sourceUrl: sourceB.url }],
            resourceMeta: { providers: { by669: 'failed', wpzys: 'ok' } }
        });
        assert.equal(retried.result.quarkUrls[0].password, undefined, `rank ${rank}`);
        assert.equal(retried.result.quarkUrls[0].passwordConflict, true);
    }
    const legacy = mergeResourceState(null, {
        partial: true, resources: [sourceA], wpzysResources: [],
        quarkUrls: [{ url: 'https://pan.quark.cn/s/shared', password: 'AAAA', sourceUrl: sourceA.url }],
        resourceMeta: { providers: { by669: 'ok', wpzys: 'failed' } }
    });
    const newEvidence = mergeResourceState(legacy, scan({ by669: 'failed', resources: [], partial: true, pages: [page(sourceB, [share('shared', 'BBBB', 2)])] }));
    assert.equal(newEvidence.result.quarkUrls[0].password, undefined);
});

test('legacy same-share responses without a password cannot resurrect retained passwords', () => {
    for (const rank of [1, 2]) {
        const initial = mergeResourceState(null, scan({ wpzys: 'failed', wpzysResources: [], partial: true, pages: [page(sourceA, [share('shared', 'AAAA', rank)])] }));
        const retried = mergeResourceState(initial, {
            partial: true, resources: [], wpzysResources: [sourceB],
            quarkUrls: [{ url: 'https://pan.quark.cn/s/shared', sourceUrl: sourceB.url }],
            resourceMeta: { providers: { by669: 'failed', wpzys: 'ok' } }
        });
        assert.equal(retried.result.quarkUrls[0].password, undefined, `rank ${rank}`);
        assert.equal(retried.result.quarkUrls[0].passwordConflict, true);
    }
});

test('unknown confidence compares against the strongest known evidence and removed conflicts recover', () => {
    const sourceC = { ...sourceA, url: 'https://by669.org/d/stronger' };
    for (const password of ['AAAA', 'BBBB']) {
        for (const reverse of [false, true]) {
            const legacy = mergeResourceState(null, {
                partial: true, resources: [], wpzysResources: [sourceB],
                quarkUrls: [{ url: 'https://pan.quark.cn/s/shared', password, sourceUrl: sourceB.url }],
                resourceMeta: { providers: { by669: 'failed', wpzys: 'ok' } }
            });
            const pages = [page(sourceA, [share('shared', 'AAAA', 1)]), page(sourceC, [share('shared', 'BBBB', 2)])];
            if (reverse) pages.reverse();
            const result = mergeResourceState(legacy, scan({ wpzys: 'failed', wpzysResources: [], resources: [sourceA, sourceC], partial: true, pages }));
            assert.equal(result.result.quarkUrls[0].password, password === 'BBBB' ? 'BBBB' : undefined);
            assert.ok(Object.keys(result.result.quarkUrls[0]).every(key => !key.startsWith('_')));
            const recovered = mergeResourceState(result, scan({ wpzysResources: [], resources: [sourceA, sourceC], pages }));
            assert.equal(recovered.result.quarkUrls[0].password, 'BBBB');
            assert.equal(recovered.result.quarkUrls[0].passwordConflict, undefined);
        }
    }
});

test('resource query identity includes canonical metadata as well as media ID', () => {
    const candidate = { id: 1, mediaType: 'movie', title: 'Candidate', year: '2024' };
    assert.notEqual(resourceQueryKey(candidate), resourceQueryKey({ ...candidate, title: 'Canonical' }));
    assert.notEqual(resourceQueryKey(candidate), resourceQueryKey({ ...candidate, year: '2025' }));
    assert.notEqual(resourceQueryKey(candidate), resourceQueryKey({ ...candidate, mediaType: 'tv' }));
    assert.equal(resourceQueryKey(candidate), resourceQueryKey({ ...candidate, originalTitle: 'Unused name' }));
});
