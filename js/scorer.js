/**
 * 个性化推荐算法
 */

const PREFERENCE_WEIGHTS = {
    '喜剧': { score: 2.5, reason: '符合喜剧偏好' },
    '轻松': { score: 2.0, reason: '基调轻松减压' },
    '爱情': { score: 1.5, reason: '包含浪漫/Melo元素' },
    '剧情': { score: 1.0, reason: '剧情导向' },
    '职业': { score: 1.5, reason: '职场背景设定' },
    '恐怖': { score: -3.0, reason: '包含恐怖元素' },
    '血腥': { score: -3.0, reason: '可能含有血腥镜头' },
    '暴力': { score: -2.5, reason: '存在暴力情节' },
    '惊悚': { score: -2.0, reason: '惊悚刺激氛围' },
    '犯罪': { score: -1.0, reason: '犯罪题材' },
    '悲剧': { score: -3.0, reason: '剧情致郁/苦大仇深' },
    '灾难': { score: -1.5, reason: '环境压抑' }
};

const PREFERENCE_STORAGE_KEY = 'iplay_preference_weights';
const PREFERENCE_SCORE_LIMIT = 5;
// Stored JSON comes from the viewer's own browser, but keys such as
// "__proto__" must still never reach an object's prototype chain.
const UNSAFE_PREFERENCE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
let preferenceStorageErrorLogged = false;

function getPreferenceStorage() {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
}

function clampPreferenceScore(score) {
    return Math.max(-PREFERENCE_SCORE_LIMIT, Math.min(PREFERENCE_SCORE_LIMIT, score));
}

function readCustomPreferenceWeights() {
    const custom = new Map();
    try {
        const raw = getPreferenceStorage()?.getItem(PREFERENCE_STORAGE_KEY);
        if (!raw) return custom;
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return custom;
        for (const [genre, value] of Object.entries(parsed)) {
            const name = genre.trim();
            if (!name || name.length > 40 || UNSAFE_PREFERENCE_KEYS.has(name)) continue;
            const score = typeof value === 'number' ? value : Number(value?.score);
            if (!Number.isFinite(score)) continue;
            custom.set(name, {
                score: clampPreferenceScore(score),
                reason: typeof value?.reason === 'string' && value.reason.trim()
                    ? value.reason.trim().slice(0, 120)
                    : `自定义偏好：${name}`
            });
        }
    } catch (error) {
        if (!preferenceStorageErrorLogged) {
            console.error('Failed to load custom preference weights', error);
            preferenceStorageErrorLogged = true;
        }
    }
    return custom;
}

function getPreferenceWeights() {
    const weights = new Map(Object.entries(PREFERENCE_WEIGHTS));
    for (const [genre, value] of readCustomPreferenceWeights()) weights.set(genre, value);
    return weights;
}

/**
 * Genre preferences for the settings panel: built-in genres first, then any
 * custom genres the viewer added, each with its current and default score.
 */
export function getPreferenceSettings() {
    const custom = readCustomPreferenceWeights();
    const genres = [...Object.keys(PREFERENCE_WEIGHTS), ...[...custom.keys()].filter(genre => !(genre in PREFERENCE_WEIGHTS))];
    return genres.map(genre => ({
        genre,
        score: custom.get(genre)?.score ?? PREFERENCE_WEIGHTS[genre].score,
        defaultScore: PREFERENCE_WEIGHTS[genre]?.score ?? 0,
        reason: custom.get(genre)?.reason ?? PREFERENCE_WEIGHTS[genre]?.reason ?? `自定义偏好：${genre}`
    }));
}

/** Persist scores that differ from the defaults. Returns false if storage is unavailable. */
export function savePreferenceWeights(scores) {
    const stored = {};
    for (const [genre, value] of Object.entries(scores || {})) {
        const score = Number(value);
        if (UNSAFE_PREFERENCE_KEYS.has(genre) || !Number.isFinite(score)) continue;
        const defaults = PREFERENCE_WEIGHTS[genre];
        if (defaults && defaults.score === clampPreferenceScore(score)) continue;
        stored[genre] = { score: clampPreferenceScore(score), reason: defaults?.reason || `自定义偏好：${genre}` };
    }
    try {
        const storage = getPreferenceStorage();
        if (!storage) return false;
        if (Object.keys(stored).length) storage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(stored));
        else storage.removeItem(PREFERENCE_STORAGE_KEY);
        return true;
    } catch {
        return false;
    }
}

export function resetPreferenceWeights() {
    try {
        getPreferenceStorage()?.removeItem(PREFERENCE_STORAGE_KEY);
        return true;
    } catch {
        return false;
    }
}

function getRatingLabel(source) {
    if (source === 'tmdb') return 'TMDB评分';
    if (source === 'douban') return '豆瓣评分';
    return '评分';
}

export function calculateRecommendationScore(data = {}) {
    const { rating, votes, genres, hasWiki, source } = data;
    const preferenceWeights = getPreferenceWeights();
    const report = { pros: [], cons: [] };
    const ratingLabel = getRatingLabel(source);
    const numericRating = Number(rating);
    const safeRating = Number.isFinite(numericRating) && numericRating > 0
        ? Math.min(10, numericRating)
        : 0;
    const numericVotes = Number(votes);
    const safeVotes = Number.isFinite(numericVotes) && numericVotes > 0 ? numericVotes : 0;
    const safeGenres = Array.isArray(genres)
        ? [...new Set(genres.filter(genre => typeof genre === 'string').map(genre => genre.trim()).filter(Boolean))]
        : [];

    let baseScore;
    if (safeRating >= 9.0) {
        baseScore = 55 + (safeRating - 9.0) * 5;
        report.pros.push(`${ratingLabel}极高 (${safeRating.toFixed(1)})`);
    } else if (safeRating >= 8.0) {
        baseScore = 45 + (safeRating - 8.0) * 10;
        report.pros.push(`口碑优良 (${safeRating.toFixed(1)})`);
    } else if (safeRating >= 7.0) {
        baseScore = 28 + (safeRating - 7.0) * 17;
    } else if (safeRating > 0) {
        baseScore = safeRating * 4;
        report.cons.push(`${ratingLabel}较低 (${safeRating.toFixed(1)})`);
    } else {
        baseScore = 30;
        report.cons.push('暂无有效评分参考');
    }

    let heatScore = 0;
    if (hasWiki) {
        heatScore += 5;
        report.pros.push('具备一定国际知名度 (Wiki收录)');
    }

    if (safeVotes > 0) {
        const voteScore = Math.min(15, Math.log10(safeVotes) * 2.8);
        heatScore += voteScore;
        if (safeVotes > 100000) report.pros.push(`现象级爆款 (${Math.floor(safeVotes / 10000)}w+人评价)`);
        else if (safeVotes < 5000) report.cons.push('受众较窄，稍显冷门');
    }

    let preferenceScore = 10;
    let hasFatalFlaw = false;

    if (safeGenres.length > 0) {
        safeGenres.forEach(genre => {
            const pref = preferenceWeights.get(genre) || null;
            if (pref) {
                preferenceScore += pref.score * 2.5;
                if (pref.score > 0) {
                    report.pros.push(pref.reason);
                } else if (pref.score < 0) {
                    report.cons.push(pref.reason);
                    if (pref.score <= -2.5) hasFatalFlaw = true;
                }
            }
        });
    }

    preferenceScore = Math.max(0, Math.min(20, preferenceScore));

    let totalScore = baseScore + heatScore + preferenceScore;

    if (hasFatalFlaw) {
        totalScore = Math.min(totalScore * 0.7, 59);
        report.cons.unshift('⚠️ 严重触及雷区 (包含你讨厌的元素)');
    }

    if (!hasWiki && (!data.summary || data.summary.length < 10)) {
        totalScore -= 2;
    }

    return {
        score: Math.min(100, Math.max(0, Math.round(totalScore))),
        details: {
            base: Math.round(baseScore),
            heat: Math.round(heatScore),
            preference: Math.round(preferenceScore)
        },
        report
    };
}

export function getRecommendationLabel(score) {
    if (score >= 85) return { label: '天选好剧 🌟', color: 'text-green-500' };
    if (score >= 70) return { label: '值得一看 👍', color: 'text-blue-500' };
    if (score >= 50) return { label: '剧荒打发 👀', color: 'text-yellow-500' };
    return { label: '极度劝退 💣', color: 'text-red-500' };
}
