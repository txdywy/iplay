import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findBestMatch,
    normalizeSearchText,
    pickBestTmdbMatch,
    rankTmdbCandidates,
    shouldConfirmTmdbCandidate
} from '../js/match.js';

test('normalizes punctuation, spacing, and accents for title matching', () => {
    assert.equal(normalizeSearchText('  The—Bear! '), 'thebear');
    assert.equal(normalizeSearchText('Élite'), 'elite');
});

test('ranks TMDB candidates by match score and preserves stable order for ties', () => {
    const results = [
        { id: 1, title: 'Older match', matchScore: 0.72 },
        { id: 2, title: 'Best match', matchScore: 0.91 },
        { id: 3, title: 'Tie match', matchScore: 0.91 }
    ];

    assert.deepEqual(rankTmdbCandidates(results).map(item => item.id), [2, 3, 1]);
});

test('asks for confirmation when confidence is low or scores are too close', () => {
    assert.equal(shouldConfirmTmdbCandidate([
        { id: 1, title: 'The Office', matchScore: 0.78, matchConfidence: 'medium' },
        { id: 2, title: 'The Office', matchScore: 0.74, matchConfidence: 'medium' }
    ]), true);

    assert.equal(shouldConfirmTmdbCandidate([
        { id: 1, title: 'Dune', matchScore: 0.95, matchConfidence: 'high' },
        { id: 2, title: 'Dune', matchScore: 0.90, matchConfidence: 'high' }
    ]), true);

    assert.equal(shouldConfirmTmdbCandidate([
        { id: 1, title: 'Dune', matchScore: 0.95, matchConfidence: 'high' },
        { id: 2, title: 'Dune', matchScore: 0.72, matchConfidence: 'medium' }
    ]), false);

    assert.equal(shouldConfirmTmdbCandidate([
        { id: 1, title: 'Dune', matchScore: 0.62, matchConfidence: 'medium' }
    ]), true);

    assert.equal(shouldConfirmTmdbCandidate([
        { id: 1, title: 'Dune', matchScore: 0.91, matchConfidence: 'high' }
    ]), false);
});

test('selects an exact or loose title when TMDB match scores are unavailable', () => {
    const exact = pickBestTmdbMatch([
        { id: 1, title: '流浪地球' },
        { id: 2, title: '流浪地球 2' }
    ], '流浪地球');
    assert.equal(exact.id, 1);

    const loose = findBestMatch([
        { id: 1, title: 'Dune: Part Two' },
        { id: 2, title: 'Dune' }
    ], 'Dune: Part', item => item.title);
    assert.equal(loose.id, 1);
});
