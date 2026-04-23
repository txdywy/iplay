/**
 * API 请求封装 - Cloudflare Worker 版本
 */

const API_BASE = "https://iplay.andylaw2017.workers.dev";

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

/**
 * 中文 Wikipedia API (通过 Worker 代理)
 */
export const WikiAPI = {
    async getSummary(query) {
        try {
            return await fetchWithTimeout(`${API_BASE}/api/wiki/zh?q=${encodeURIComponent(query)}`);
        } catch (e) {
            console.warn("Wiki zh fetch failed:", e);
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
 * 全球评分聚合 (IMDb & Rotten Tomatoes)
 * 优先使用 IMDb ID（最精准），降级到英文标题搜索
 */
export const GlobalRatingAPI = {
    async getRatings(imdbId, englishTitle, year) {
        if (imdbId) {
            try {
                return await fetchWithTimeout(`${API_BASE}/api/omdb?imdb=${imdbId}`);
            } catch (e) {
                console.warn("OMDb by ID failed, trying by title:", e);
            }
        }
        // 降级：用英文标题
        if (englishTitle) {
            try {
                let url = `${API_BASE}/api/omdb?title=${encodeURIComponent(englishTitle)}`;
                if (year) url += `&year=${year}`;
                return await fetchWithTimeout(url);
            } catch (e) {
                console.warn("OMDb by title failed:", e);
            }
        }
        return null;
    }
};
