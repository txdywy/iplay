import test from 'node:test';
import assert from 'node:assert/strict';

import { formatRating, toFiniteNumber } from '../js/format.js';

test('toFiniteNumber accepts numeric strings and rejects non-finite values', () => {
    assert.equal(toFiniteNumber('8.5'), 8.5);
    assert.equal(toFiniteNumber(4), 4);
    assert.equal(toFiniteNumber(0), 0);
    assert.equal(toFiniteNumber(null), null);
    assert.equal(toFiniteNumber('  '), null);
    assert.equal(toFiniteNumber(false), null);
    assert.equal(toFiniteNumber('not-a-number'), null);
    assert.equal(toFiniteNumber(Infinity, 0), 0);
});

test('formatRating safely formats valid positive ratings', () => {
    assert.equal(formatRating('8.56'), '8.6');
    assert.equal(formatRating(7), '7.0');
    assert.equal(formatRating(0), '-.-');
    assert.equal(formatRating('invalid', 'N/A'), 'N/A');
});
