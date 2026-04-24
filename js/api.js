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

export const TmdbAPI = {
    async search(query) {
        return fetchWithTimeout(`${API_BASE}/api/tmdb/search?q=${encodeURIComponent(query)}`);
    },
    async getDetail(id, type) {
        let url = `${API_BASE}/api/tmdb/detail?id=${id}`;
        if (type) url += `&type=${encodeURIComponent(type)}`;
        return fetchWithTimeout(url);
    }
};

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
            return { resources: [], quarkUrls: [] };
        }
    }
};

/**
 * 海报专用接口：优先 TMDB，再向 OMDb 兜底
 */
export const PosterAPI = {
    async getPoster(title, year) {
        if (!title) return null;
        try {
            return await fetchWithTimeout(`${API_BASE}/api/poster?title=${encodeURIComponent(title)}&year=${year || ''}`);
        } catch (e) {
            console.warn("Poster fetch failed:", e);
            return null;
        }
    }
};
