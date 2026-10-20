export const PERFORMANCE_SEARCH_QUERY = '这是一段非常长的影视作品查询名称用来衡量近似字符串匹配在六次回退查询以及重复候选集合情况下所需要的计算时间和重复工作占比 movie 2023 1080p | 另一个别名';

// Different IDs across attempts simulate additional results while repeated
// translated/original titles exercise the work repeated during re-ranking.
export function searchPerformanceResults(attempt) {
    return Array.from({ length: 20 }, (_, index) => {
        const title = `${PERFORMANCE_SEARCH_QUERY.split(' movie')[0].slice(0, -15)}而这里使用另外一组不同的字符${index}`;
        return {
            id: attempt * 100 + index + 1,
            media_type: 'movie',
            title,
            original_title: title,
            release_date: '2020-01-01',
            vote_count: index % 4,
            popularity: index % 3
        };
    });
}

export function searchPerformanceAlias(query) {
    return [{ title: query, year: '2023', sub_title: '另一个完全不同的公开电影别名' }];
}
