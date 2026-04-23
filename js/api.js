/**
 * API 请求封装 - Cloudflare Worker 版本
 */

// 指向你部署成功的 Cloudflare Worker 域名
const API_BASE = "https://iplay.andylaw2017.workers.dev";

/**
 * 带有超时机制的 fetch
 */
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

/**
 * 豆瓣 API 接口 (通过我们的 Worker 代理)
 */
export const DoubanAPI = {
    async search(query) {
        return fetchWithTimeout(`${API_BASE}/api/douban/search?q=${encodeURIComponent(query)}`);
    },

    async getDetail(id) {
        return fetchWithTimeout(`${API_BASE}/api/douban/detail?id=${id}`);
    }
};

/**
 * Wikipedia API (原生支持 CORS，不需要走 Worker)
 */
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

/**
 * by669 资源 API (通过 Worker 代理)
 */
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