/**
 * 个性化推荐算法
 */

let PREFERENCE_WEIGHTS = {
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

try {
    const customWeights = typeof window !== 'undefined'
        ? window.localStorage.getItem('iplay_preference_weights')
        : null;
    if (customWeights) {
        const parsed = JSON.parse(customWeights);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            for (const [genre, value] of Object.entries(parsed)) {
                const score = typeof value === 'number' ? value : Number(value?.score);
                if (Number.isFinite(score)) {
                    PREFERENCE_WEIGHTS[genre] = {
                        score: Math.max(-5, Math.min(5, score)),
                        reason: typeof value?.reason === 'string' && value.reason.trim()
                            ? value.reason.trim().slice(0, 120)
                            : `自定义偏好：${genre}`
                    };
                }
            }
        }
    }
} catch (e) {
    console.error('Failed to load custom preference weights', e);
}

function getRatingLabel(source) {
    if (source === 'tmdb') return 'TMDB评分';
    if (source === 'douban') return '豆瓣评分';
    return '评分';
}

export function calculateRecommendationScore(data) {
    const { rating, votes, genres, hasWiki, source } = data;
    const report = { pros: [], cons: [] };
    const ratingLabel = getRatingLabel(source);
    const numericRating = Number(rating);
    const safeRating = Number.isFinite(numericRating) && numericRating > 0
        ? Math.min(10, numericRating)
        : 0;
    const numericVotes = Number(votes);
    const safeVotes = Number.isFinite(numericVotes) && numericVotes > 0 ? numericVotes : 0;
    const safeGenres = Array.isArray(genres) ? genres : [];

    let baseScore;
    if (safeRating >= 9.0) {
        baseScore = 55 + (safeRating - 9.0) * 5;
        report.pros.push(`${ratingLabel}极高 (${safeRating.toFixed(1)})`);
    } else if (safeRating >= 8.0) {
        baseScore = 45 + (safeRating - 8.0) * 10;
        report.pros.push(`口碑优良 (${safeRating.toFixed(1)})`);
    } else if (safeRating >= 7.0) {
        baseScore = 35 + (safeRating - 7.0) * 10;
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
            const pref = PREFERENCE_WEIGHTS[genre];
            if (pref) {
                preferenceScore += pref.score * 2.5;
                if (pref.score > 0) {
                    report.pros.push(pref.reason);
                } else {
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
