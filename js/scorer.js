/**
 * 剧集个性化推荐算法
 */

// 用户偏好类型权重设置
const PREFERENCE_WEIGHTS = {
    // 喜欢的类型加分
    '喜剧': 1.5,
    '轻松': 1.5,
    '爱情': 1.2, // Melo/爱情
    '职业': 1.2,
    '剧情': 1.0,

    // 不喜欢的类型扣分
    '恐怖': -2.0,
    '血腥': -2.0,
    '暴力': -2.0,
    '惊悚': -1.5,
    '犯罪': -1.0,
    '悲剧': -2.0,
    '灾难': -1.5,
    '悬疑': 0   // 中立
};

/**
 * 计算个人推荐指数 (0 - 100分)
 *
 * 核心逻辑：
 * 1. 基础分：豆瓣评分占比 60%
 * 2. 热度分：豆瓣评价人数 + Wiki 词条 占比 20%
 * 3. 偏好分：根据你喜欢的类型(喜剧/轻松/melo)和讨厌的类型(血腥/悲剧)进行奖惩 占比 20%
 */
export function calculateRecommendationScore(data) {
    const { rating, votes, genres, hasWiki } = data;

    // 1. 豆瓣评分基础分 (满分60)
    // 豆瓣评分 0-10 -> 映射到 0-60分
    let baseScore = (rating / 10) * 60;

    // 2. 热度分 (满分20)
    let heatScore = 0;
    if (hasWiki) heatScore += 5; // 有国际知名度

    // 根据豆瓣评价人数给分 (对数平滑，1万评论约10分，10万评论约15分)
    if (votes > 0) {
        heatScore += Math.min(15, Math.log10(votes) * 3);
    }

    // 3. 偏好类型分 (基础分10，根据类型浮动，上限20，下限可扣光)
    let preferenceScore = 10;
    let hasNegativeTags = false;

    if (genres && genres.length > 0) {
        genres.forEach(genre => {
            const weight = PREFERENCE_WEIGHTS[genre];
            if (weight) {
                preferenceScore += weight * 2;
                if (weight < 0) hasNegativeTags = true;
            }
        });
    }

    // 限制偏好分在 0-20 之间
    preferenceScore = Math.max(0, Math.min(20, preferenceScore));

    // 计算总分
    let totalScore = baseScore + heatScore + preferenceScore;

    // 强硬规避机制：如果是极端讨厌的类型（血腥/悲剧），哪怕评分高也大幅扣分
    if (hasNegativeTags) {
        totalScore -= 15;
    }

    return {
        score: Math.min(100, Math.max(0, Math.round(totalScore))),
        details: {
            base: Math.round(baseScore),
            heat: Math.round(heatScore),
            preference: Math.round(preferenceScore)
        }
    };
}

export function getRecommendationLabel(score) {
    if (score >= 85) return { label: "天选好剧 🌟", color: "text-green-500" };
    if (score >= 70) return { label: "值得一看 👍", color: "text-blue-500" };
    if (score >= 50) return { label: "剧荒打发 👀", color: "text-yellow-500" };
    return { label: "极度劝退 💣", color: "text-red-500" };
}