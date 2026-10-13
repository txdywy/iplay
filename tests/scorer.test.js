import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const { calculateRecommendationScore, getRecommendationLabel } = await import('../js/scorer.js');

test('recommendation scoring normalizes numeric strings from external APIs', () => {
    const result = calculateRecommendationScore({
        rating: '8.5',
        votes: '12345',
        genres: ['剧情'],
        hasWiki: true,
        summary: 'A sufficiently detailed summary.',
        source: 'tmdb'
    });

    assert.ok(Number.isInteger(result.score));
    assert.ok(result.score >= 0 && result.score <= 100);
});

test('recommendation labels preserve all documented score boundaries', () => {
    assert.equal(getRecommendationLabel(49).label, '极度劝退 💣');
    assert.equal(getRecommendationLabel(50).label, '剧荒打发 👀');
    assert.equal(getRecommendationLabel(70).label, '值得一看 👍');
    assert.equal(getRecommendationLabel(85).label, '天选好剧 🌟');
});

test('fatal preference matches cap the recommendation below 60', () => {
    const result = calculateRecommendationScore({
        rating: 10,
        votes: 1_000_000,
        genres: ['恐怖'],
        hasWiki: true,
        summary: 'A sufficiently detailed summary.',
        source: 'tmdb'
    });

    assert.ok(result.score <= 59);
});

test('duplicate and prototype-like genre names cannot inflate or corrupt the score', () => {
    const data = { rating: 8, votes: 1000, genres: ['喜剧'], summary: 'A sufficiently detailed summary.' };
    assert.deepEqual(
        calculateRecommendationScore({ ...data, genres: ['喜剧', ' 喜剧 ', 'constructor', '__proto__', null] }),
        calculateRecommendationScore(data)
    );
});

test('scoring works without Object.hasOwn and still ignores inherited genre keys', async () => {
    const source = (await readFile(new URL('../js/scorer.js', import.meta.url), 'utf8'))
        .replaceAll('export function ', 'function ');
    const score = runInNewContext(`Object.hasOwn = undefined; ${source}; calculateRecommendationScore`);
    const data = { rating: 8, votes: 1000, genres: ['剧情'], summary: 'A sufficiently detailed summary.' };
    assert.equal(score(data).score, calculateRecommendationScore(data).score);
    assert.equal(score({ ...data, genres: ['剧情', 'constructor', '__proto__'] }).score, score(data).score);
});
