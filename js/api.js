/**
 * API 请求封装 - Cloudflare Worker 版本
 */

const API_BASE = "https://iplayw.hackx64.eu.org";

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort());
    }

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
            if (options.signal && options.signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            throw new Error(`Request timeout: ${url}`, { cause: error });
        }
        throw error;
    }
}

export const TmdbAPI = {
    async search(query, options = {}) {
        return fetchWithTimeout(`${API_BASE}/api/tmdb/search?q=${encodeURIComponent(query)}`, options);
    },
    async getDetail(id, type, options = {}) {
        let url = `${API_BASE}/api/tmdb/detail?id=${id}`;
        if (type) url += `&type=${encodeURIComponent(type)}`;
        return fetchWithTimeout(url, options);
    }
};

export const DoubanAPI = {
    async search(query, options = {}) {
        return fetchWithTimeout(`${API_BASE}/api/douban/search?q=${encodeURIComponent(query)}`, options);
    },
    async getDetail(id, options = {}) {
        return fetchWithTimeout(`${API_BASE}/api/douban/detail?id=${id}`, options);
    }
};

/**
 * 中文 Wikipedia API (通过 Worker 代理)
 */
export const WikiAPI = {
    async getSummary(query, options = {}) {
        try {
            return await fetchWithTimeout(`${API_BASE}/api/wiki/zh?q=${encodeURIComponent(query)}`, options);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.warn("Wiki zh fetch failed:", e);
            return null;
        }
    }
};

export const ResourceAPI = {
    async search(query, options = {}) {
        try {
            return await fetchWithTimeout(`${API_BASE}/api/resource?q=${encodeURIComponent(query)}`, options);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error("Resource fetch failed:", error);
            return { resources: [], quarkUrls: [] };
        }
    }
};

/**
 * 海报专用接口：优先 TMDB，再向 OMDb 兜底
 */
export const PosterAPI = {
    async getPoster(title, year, options = {}) {
        if (!title) return null;
        try {
            return await fetchWithTimeout(`${API_BASE}/api/poster?title=${encodeURIComponent(title)}&year=${year || ''}`, options);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.warn("Poster fetch failed:", e);
            return null;
        }
    }
};
