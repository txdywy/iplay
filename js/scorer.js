/**
 * 剧集个性化推荐算法
 */

// 用户偏好类型权重设置
const PREFERENCE_WEIGHTS = {
    // 强推类型
    '喜剧': { score: 2.5, reason: "符合喜剧偏好" },
    '轻松': { score: 2.0, reason: "基调轻松减压" },
    '爱情': { score: 1.5, reason: "包含浪漫/Melo元素" },
    '剧情': { score: 1.0, reason: "剧情导向" },
    '职业': { score: 1.5, reason: "职场背景设定" },

    // 避雷类型
    '恐怖': { score: -3.0, reason: "包含恐怖元素" },
    '血腥': { score: -3.0, reason: "可能含有血腥镜头" },
    '暴力': { score: -2.5, reason: "存在暴力情节" },
    '惊悚': { score: -2.0, reason: "惊悚刺激氛围" },
    '犯罪': { score: -1.0, reason: "犯罪题材" },
    '悲剧': { score: -3.0, reason: "剧情致郁/苦大仇深" },
    '灾难': { score: -1.5, reason: "环境压抑" }
};

/**
 * 计算个人推荐指数 (0 - 100分) 并生成分析报告
 */
export function calculateRecommendationScore(data) {
    const { rating, votes, genres, hasWiki } = data;
    const report = { pros: [], cons: [] };

    // 1. 豆瓣评分基础分 (满分60)
    // 规避有些剧没有评分的情况
    const safeRating = rating > 0 ? rating : 0;

    // 评分转换逻辑调整：
    // 9.0分以上极品：55-60分
    // 8.0-9.0分佳作：45-55分
    // 7.0-8.0分及格：35-45分
    // 6.0分以下烂剧：惩罚性极低分
    let baseScore = 0;
    if (safeRating >= 9.0) {
        baseScore = 55 + (safeRating - 9.0) * 5;
        report.pros.push(`豆瓣评分极高 (${safeRating.toFixed(1)})`);
    } else if (safeRating >= 8.0) {
        baseScore = 45 + (safeRating - 8.0) * 10;
        report.pros.push(`口碑优良 (${safeRating.toFixed(1)})`);
    } else if (safeRating >= 7.0) {
        baseScore = 35 + (safeRating - 7.0) * 10;
    } else if (safeRating > 0) {
        baseScore = safeRating * 4; // <7分的剧，分数大幅缩水
        report.cons.push(`豆瓣评分较低 (${safeRating.toFixed(1)})`);
    } else {
        baseScore = 30; // 无评分给予中等偏下基础分
        report.cons.push(`暂无有效评分参考`);
    }

    // 2. 热度分 (满分20)
    let heatScore = 0;
    if (hasWiki) {
        heatScore += 5;
        report.pros.push(`具备一定国际知名度 (Wiki收录)`);
    }

    // 评价人数 (对数计算，50万人评=15分满分)
    if (votes > 0) {
        const voteScore = Math.min(15, Math.log10(votes) * 2.8);
        heatScore += voteScore;
        if (votes > 100000) report.pros.push(`现象级爆款 (${Math.floor(votes/10000)}w+人评价)`);
        else if (votes < 5000) report.cons.push(`受众较窄，稍显冷门`);
    }

    // 3. 偏好类型分 (满分20，有强惩罚机制)
    let preferenceScore = 10; // 默认给10分中立分
    let hasFatalFlaw = false;

    if (genres && genres.length > 0) {
        genres.forEach(genre => {
            const pref = PREFERENCE_WEIGHTS[genre];
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

    // 限制偏好分在 0-20 之间
    preferenceScore = Math.max(0, Math.min(20, preferenceScore));

    // 计算总分
    let totalScore = baseScore + heatScore + preferenceScore;

    // 致命雷区判定：如果命中极端反感的标签，实施降维打击
    if (hasFatalFlaw) {
        totalScore = Math.min(totalScore * 0.7, 59); // 强行压在及格线以下
        report.cons.unshift("⚠️ 严重触及雷区 (包含你讨厌的元素)");
    }

    // 如果没有剧情简介，也稍微扣一点体验分
    if (!hasWiki && (!data.summary || data.summary.length < 10)) {
        totalScore -= 2;
    }

    // 格式化输出
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
    if (score >= 85) return { label: "天选好剧 🌟", color: "text-green-500" };
    if (score >= 70) return { label: "值得一看 👍", color: "text-blue-500" };
    if (score >= 50) return { label: "剧荒打发 👀", color: "text-yellow-500" };
    return { label: "极度劝退 💣", color: "text-red-500" };
}