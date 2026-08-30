/**
 * API 请求封装 - Cloudflare Worker 版本
 */

const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://iplayw.hackx64.eu.org';
const DEFAULT_TIMEOUT_MS = 12000;
const RESOURCE_TIMEOUT_MS = 18000;
const POSTER_TIMEOUT_MS = 18000;
const OMDB_TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    let abortListener = null;

    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else {
            abortListener = () => controller.abort();
            options.signal.addEventListener('abort', abortListener, { once: true });
        }
    }

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        let data;
        try {
            data = await response.json();
        } catch (error) {
            if (!response.ok) {
                const httpError = new Error(`HTTP error! status: ${response.status}`);
                httpError.status = response.status;
                throw httpError;
            }
            throw error;
        }

        if (!response.ok) {
            const error = new Error(data && data.error ? data.error : `HTTP error! status: ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    } catch (error) {
        if (error.name === 'AbortError') {
            if (options.signal && options.signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            throw new Error('Request timed out. Please try again.', { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(id);
        if (options.signal && abortListener) {
            options.signal.removeEventListener('abort', abortListener);
        }
    }
}

export const TmdbAPI = {
    async search(query, options = {}) {
        return fetchWithTimeout(`${API_BASE}/api/tmdb/search?q=${encodeURIComponent(query)}`, options);
    },
    async getDetail(id, type, options = {}) {
        let url = `${API_BASE}/api/tmdb/detail?id=${encodeURIComponent(id)}`;
        if (type) url += `&type=${encodeURIComponent(type)}`;
        return fetchWithTimeout(url, options);
    }
};

export const DoubanAPI = {
    async search(query, options = {}) {
        return fetchWithTimeout(`${API_BASE}/api/douban/search?q=${encodeURIComponent(query)}`, options);
    },
    async getDetail(id, options = {}) {
        return fetchWithTimeout(`${API_BASE}/api/douban/detail?id=${encodeURIComponent(id)}`, options);
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
            console.debug("Wiki zh fetch failed:", e);
            return null;
        }
    }
};

/**
 * OMDb 详情接口：使用 TMDB 已确认的 IMDb ID，避免再次按片名搜索。
 */
export const OmdbAPI = {
    async getById(imdbId, options = {}) {
        if (!imdbId) return null;
        try {
            return await fetchWithTimeout(`${API_BASE}/api/omdb?imdb=${encodeURIComponent(imdbId)}`, options, OMDB_TIMEOUT_MS);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.debug("OMDb fetch failed:", e);
            return null;
        }
    },
    async search(title, year, options = {}) {
        if (!title) return null;
        try {
            return await fetchWithTimeout(`${API_BASE}/api/omdb?title=${encodeURIComponent(title)}&year=${encodeURIComponent(year || '')}`, options, OMDB_TIMEOUT_MS);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.debug("OMDb title fetch failed:", e);
            return null;
        }
    }
};

export const ResourceAPI = {
    async search(query, options = {}, { refresh = false } = {}) {
        const refreshParam = refresh ? '&refresh=1' : '';
        return fetchWithTimeout(`${API_BASE}/api/resource?q=${encodeURIComponent(query)}${refreshParam}`, options, RESOURCE_TIMEOUT_MS);
    }
};

/**
 * 海报专用接口：优先 TMDB，再向 OMDb 兜底
 */
export const PosterAPI = {
    async getPoster(title, year, options = {}, { refresh = false } = {}) {
        if (!title) return null;
        try {
            const refreshParam = refresh ? '&refresh=1' : '';
            return await fetchWithTimeout(`${API_BASE}/api/poster?title=${encodeURIComponent(title)}&year=${encodeURIComponent(year || '')}${refreshParam}`, options, POSTER_TIMEOUT_MS);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.debug("Poster fetch failed:", e);
            return null;
        }
    }
};
