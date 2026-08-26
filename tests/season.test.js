import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSeasonEpisodeCounts, formatSeasonTotals } from '../js/seasons.js';

test('season episode formatter orders seasons and labels specials and unknown counts', () => {
    assert.equal(
        formatSeasonEpisodeCounts([
            { seasonNumber: 2, episodeCount: 8 },
            { seasonNumber: 0, episodeCount: 2 },
            { seasonNumber: 1, episodeCount: 10 },
            { seasonNumber: 3, episodeCount: null },
            { seasonNumber: 'invalid', episodeCount: 99 }
        ]),
        '特别篇：2 集 / 第 1 季：10 集 / 第 2 季：8 集 / 第 3 季：待定'
    );
});

test('season formatters handle empty, malformed, and aggregate-only data', () => {
    assert.equal(formatSeasonEpisodeCounts([{ seasonNumber: -1, episodeCount: 4 }]), '');
    assert.equal(formatSeasonEpisodeCounts(null), '');
    assert.equal(formatSeasonTotals(3, 20), '共 3 季：20 集');
    assert.equal(formatSeasonTotals('invalid', 20), '共 20 集');
    assert.equal(formatSeasonTotals(null, null), '');
});
