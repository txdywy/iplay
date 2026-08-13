import test from 'node:test';
import assert from 'node:assert/strict';

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
