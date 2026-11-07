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

test('recommendation score changes smoothly across the 7.0 rating boundary', () => {
    const score = rating => calculateRecommendationScore({ rating, summary: 'A sufficiently detailed summary.' }).score;
    assert.ok(Math.abs(score(7.0) - score(6.9)) <= 2);
    assert.ok(score(7.1) > score(7.0));
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

test('custom preference changes take effect on the next score and zero scores add no warning', async () => {
    const source = (await readFile(new URL('../js/scorer.js', import.meta.url), 'utf8'))
        .replaceAll('export function ', 'function ');
    const storage = { value: null, getItem() { return this.value; } };
    const errors = [];
    const score = runInNewContext(`
        globalThis.window = { localStorage: globalThis.storage };
        globalThis.console = { error: (...args) => globalThis.errors.push(args) };
        ${source}; calculateRecommendationScore
    `, { storage, errors });
    const data = { rating: 8, votes: 10000, genres: ['恐怖'], summary: 'A sufficiently detailed summary.', hasWiki: true, source: 'tmdb' };
    const defaultResult = score(data);

    storage.value = JSON.stringify({ 恐怖: { score: 0, reason: 'Neutral now' } });
    const neutralResult = score(data);
    assert.ok(neutralResult.score > defaultResult.score);
    assert.equal(neutralResult.report.cons.includes('Neutral now'), false);
    assert.equal(neutralResult.report.cons.some(reason => reason.includes('恐怖')), false);

    storage.value = JSON.stringify({ 恐怖: { score: 2, reason: 'New preference' } });
    const updatedResult = score(data);
    assert.ok(updatedResult.score > neutralResult.score);
    assert.ok(updatedResult.report.pros.includes('New preference'));
    assert.deepEqual(errors, []);
});
