const TMDB_AUTO_MATCH_SCORE = 0.56;
const CLOSE_MATCH_GAP = 0.08;

export function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[\s\-_:,.!?()[\]{}'"“”‘’·—–、，。·/\\]/gu, '');
}

function getTmdbScore(item) {
    const score = Number(item?.matchScore);
    return Number.isFinite(score) ? score : null;
}

export function rankTmdbCandidates(results) {
    if (!Array.isArray(results)) return [];

    return results
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({ item, index, score: getTmdbScore(item) }))
        .sort((left, right) => {
            if (left.score !== null && right.score !== null) return right.score - left.score || left.index - right.index;
            if (left.score !== null) return -1;
            if (right.score !== null) return 1;
            return left.index - right.index;
        })
        .map(entry => entry.item);
}

function getCandidateTitle(item) {
    return [item?.title, item?.originalTitle].filter(Boolean);
}

export function findBestMatch(results, query, titleFn) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const normalizedQuery = normalizeSearchText(query);
    const exact = results.find(item => normalizeSearchText(titleFn(item)) === normalizedQuery);
    if (exact) return exact;

    const loose = results.find(item => {
        const normalizedTitle = normalizeSearchText(titleFn(item));
        return normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle);
    });
    if (loose) return loose;

    return results[0];
}

export function pickBestTmdbMatch(results, query) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const ranked = rankTmdbCandidates(results);
    const scored = ranked.filter(item => getTmdbScore(item) !== null);
    if (scored.length > 0) return getTmdbScore(scored[0]) >= TMDB_AUTO_MATCH_SCORE ? scored[0] : null;

    const normalizedQuery = normalizeSearchText(query);
    const exact = ranked.find(item => getCandidateTitle(item).some(title => normalizeSearchText(title) === normalizedQuery));
    if (exact) return exact;

    const loose = ranked.find(item => getCandidateTitle(item).some(title => {
        const normalizedTitle = normalizeSearchText(title);
        return normalizedTitle.includes(normalizedQuery)
            || (normalizedTitle.length >= 2 && normalizedQuery.includes(normalizedTitle));
    }));
    if (loose) return loose;

    const yearMatch = ranked.find(item => item.year && String(query).includes(String(item.year)));
    return yearMatch || null;
}

export function shouldConfirmTmdbCandidate(results) {
    const ranked = rankTmdbCandidates(results);
    if (ranked.length === 0) return false;

    const top = ranked[0];
    const topScore = getTmdbScore(top);
    const topConfidence = String(top.matchConfidence || '').toLowerCase();
    if (ranked.length === 1) return topScore !== null && topConfidence !== 'high';

    const second = ranked[1];
    const secondScore = getTmdbScore(second);

    if (topConfidence !== 'high') return true;
    if (topScore === null || secondScore === null) return false;
    return topScore - secondScore < CLOSE_MATCH_GAP;
}
