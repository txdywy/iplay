import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceHistory, OPENED_LINKS_KEY, OPENED_LINK_COUNTS_KEY, STARRED_LINKS_KEY } from '../js/resource-history.js';

function fixture() {
    const shared = new Map();
    const storage = { getItem: key => shared.get(key) ?? null, setItem: (key, raw) => shared.set(key, raw) };
    return { storage, write: (key, value) => storage.setItem(key, JSON.stringify(value)) };
}

test('legacy clear and tuple writes reconcile with migrated counts exactly once', () => {
    const { storage, write } = fixture();
    const left = createResourceHistory(() => storage);
    const right = createResourceHistory(() => storage);
    write(OPENED_LINKS_KEY, [['A', 7], ['B', 3]]);
    assert.equal(left.syncOpens({ persist: true }).marks.get('A'), 7);
    assert.deepEqual(JSON.parse(storage.getItem(OPENED_LINKS_KEY)), ['A', 'B']);
    // A v1.0.63 tab reads the URL list as one open per URL before incrementing.
    write(OPENED_LINKS_KEY, [['B', 1], ['A', 2]]);
    assert.equal(right.syncOpens({ persist: true }).marks.get('A'), 8);
    assert.equal(left.syncOpens({ persist: true }).marks.get('A'), 8);
    // A v1.0.61 tab can clear and reopen before the new tab handles the event.
    const oldValue = storage.getItem(OPENED_LINKS_KEY);
    write(OPENED_LINKS_KEY, ['B']);
    const newValue = storage.getItem(OPENED_LINKS_KEY);
    write(OPENED_LINKS_KEY, ['B', 'A']);
    assert.deepEqual([...left.syncOpens({ legacyChange: { oldValue, newValue }, persist: true }).marks], [['B', 3], ['A', 1]]);
    assert.equal(right.syncOpens({ persist: true }).marks.get('A'), 1);
    right.syncOpens({ clear: ['A'], persist: true });
    write(OPENED_LINKS_KEY, ['B', 'A']);
    assert.equal(left.syncOpens({ persist: true }).marks.get('A'), 1);
    right.syncOpens({ increment: 'C', persist: true });
    write(OPENED_LINKS_KEY, ['B', 'A']);
    assert.ok(!left.syncOpens({ persist: true }).marks.has('C'));

    left.syncOpens({ increment: 'A', persist: true });
    left.syncOpens({ increment: 'B', persist: true });
    const beforeReorder = storage.getItem(OPENED_LINKS_KEY);
    assert.equal(beforeReorder, '["A","B"]');
    write(OPENED_LINKS_KEY, ['B', 'A']);
    assert.deepEqual([...left.syncOpens({
        legacyChange: { oldValue: beforeReorder, newValue: '["B"]' }, persist: true
    }).marks], [['B', 4], ['A', 1]]);
});

test('quota recovery replays pending operations without replacing sibling edits', () => {
    const { storage } = fixture();
    let full = false;
    const left = createResourceHistory(() => ({ ...storage, setItem(key, raw) {
        if (full) throw new Error('quota');
        storage.setItem(key, raw);
    } }));
    const right = createResourceHistory(() => storage);
    left.syncOpens({ increment: 'A', persist: true });
    left.syncStars('A');
    full = true;
    left.syncOpens({ increment: 'A', persist: true });
    left.syncStars('A');
    left.syncStars('C');
    assert.deepEqual([...left.syncOpens().marks], [['A', 2]]);
    right.syncOpens({ increment: 'B', persist: true });
    right.syncStars('B');
    full = false;
    assert.deepEqual([...left.syncOpens({ increment: 'A', persist: true }).marks], [['B', 1], ['A', 3]]);
    assert.deepEqual([...left.syncStars()], ['B', 'C']);
    assert.equal(JSON.parse(storage.getItem(STARRED_LINKS_KEY)).length, 2);
});

test('a failed compatibility mirror does not replay a committed count', () => {
    const { storage } = fixture();
    let mirrorFails = true;
    const left = createResourceHistory(() => ({ ...storage, setItem(key, raw) {
        if (mirrorFails && key === OPENED_LINKS_KEY) throw new Error('quota');
        storage.setItem(key, raw);
    } }));
    const right = createResourceHistory(() => storage);
    assert.equal(left.syncOpens({ increment: 'A', persist: true }).marks.get('A'), 1);
    assert.equal(right.syncOpens().marks.get('A'), 1);
    assert.ok(storage.getItem(OPENED_LINK_COUNTS_KEY));
    mirrorFails = false;
    assert.equal(left.syncOpens({ increment: 'A', persist: true }).marks.get('A'), 2);
    assert.deepEqual(JSON.parse(storage.getItem(OPENED_LINKS_KEY)), ['A']);
});
