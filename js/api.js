/**
 * API 请求封装 - Cloudflare Worker 版本
 */

const API_BASE = "https://iplay.andylaw2017.workers.dev"; // 指向 Cloudflare Worker

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout: ${url}`);
        }
        throw error;
    }
}

export const DoubanAPI = {
    async search(query) {
        return fetchWithTimeout(`${API_BASE}/api/douban/search?q=${encodeURIComponent(query)}`);
    },
    async getDetail(id) {
        return fetchWithTimeout(`${API_BASE}/api/douban/detail?id=${id}`);
    }
};

export const WikiAPI = {
    async getSummary(query) {
        try {
            const searchRes = await fetchWithTimeout(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`);
            if (!searchRes.query || !searchRes.query.search.length) return null;

            const title = searchRes.query.search[0].title;
            const summaryRes = await fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);

            return summaryRes;
        } catch (e) {
            console.warn("Wiki fetch failed:", e);
            return null;
        }
    }
};

export const ResourceAPI = {
    async search(query) {
        try {
            return await fetchWithTimeout(`${API_BASE}/api/resource?q=${encodeURIComponent(query)}`);
        } catch (error) {
            console.error("Resource fetch failed:", error);
            return [];
        }
    }
};

/**
 * 全球评分聚合 (IMDb & 烂番茄)
 */
export const GlobalRatingAPI = {
    async getRatings(englishTitle, year) {
        if (!englishTitle) return null;
        try {
            let url = `${API_BASE}/api/omdb?title=${encodeURIComponent(englishTitle)}`;
            if (year) url += `&year=${year}`;
            return await fetchWithTimeout(url);
        } catch (error) {
            console.warn("Global ratings fetch failed:", error);
            return null;
        }
    }
};