/**
 * API 请求封装 - Cloudflare Worker 版本
 */
import { RELEASE_VERSION } from './release.js?v=1.0.21';

const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://iplayw.hackx64.eu.org';
const DEFAULT_TIMEOUT_MS = 12000;
const RESOURCE_TIMEOUT_MS = 18000;
const POSTER_TIMEOUT_MS = 18000;
const OMDB_TIMEOUT_MS = 12000;
// Successful TMDB answers are briefly browser-cacheable. Tag them by release so
// a new frontend never reuses a response shaped for the previous Worker.
const RELEASE_PARAM = `v=${encodeURIComponent(RELEASE_VERSION)}`;
// A search answer may embed the TMDB answer this page requests next. Serve
// that identical request from memory, as briefly as a browser would cache it.
const PREFETCH_TTL_MS = 300000;
const PREFETCH_MAX_ENTRIES = 8;
const prefetchedResponses = new Map();
// Missing Worker configuration answers every OMDb request the same way.
let omdbNotConfigured = false;

function tmdbDetailUrl(id, type) {
    let url = `${API_BASE}/api/tmdb/detail?id=${encodeURIComponent(id)}`;
    if (type !== undefined && type !== null) url += `&type=${encodeURIComponent(type)}`;
    return `${url}&${RELEASE_PARAM}`;
}

function tmdbPersonUrl(query, { personId, offset, limit, mediaType } = {}) {
    const params = [`q=${encodeURIComponent(query)}`];
    if (personId !== undefined && personId !== null) params.push(`id=${encodeURIComponent(personId)}`);
    if (offset !== undefined && offset !== null) params.push(`offset=${encodeURIComponent(offset)}`);
    if (limit !== undefined && limit !== null) params.push(`limit=${encodeURIComponent(limit)}`);
    if (mediaType) params.push(`mediaType=${encodeURIComponent(mediaType)}`);
    params.push(RELEASE_PARAM);
    return `${API_BASE}/api/tmdb/person?${params.join('&')}`;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPrefetchedPerson(value) {
    return isPlainObject(value) && Number.isSafeInteger(value.id) && value.id > 0
        && typeof value.name === 'string' && Boolean(value.name.trim());
}

function rememberPrefetched(prefetched) {
    if (!isPlainObject(prefetched)) return;
    const { detail, person } = prefetched;
    const entries = [];
    if (isPlainObject(detail?.data) && Number.isSafeInteger(detail.id) && detail.id > 0
        && (detail.type === 'movie' || detail.type === 'tv')
        && detail.data.id === detail.id && detail.data.mediaType === detail.type
        && typeof detail.data.title === 'string' && detail.data.title.trim()) {
        entries.push([tmdbDetailUrl(detail.id, detail.type), detail.data]);
    }
    if (isPlainObject(person?.data) && typeof person.query === 'string' && person.query.trim()
        && Array.isArray(person.data.credits)
        && (person.data.person === null || isPrefetchedPerson(person.data.person))
        && (!person.data.searchMeta?.ambiguous || (Array.isArray(person.data.personCandidates)
            && person.data.personCandidates.length > 0 && person.data.personCandidates.every(isPrefetchedPerson)))) {
        entries.push([tmdbPersonUrl(person.query), person.data]);
    }
    const expiresAt = Date.now() + PREFETCH_TTL_MS;
    for (const [url, data] of entries) {
        prefetchedResponses.delete(url);
        prefetchedResponses.set(url, { expiresAt, data });
    }
    while (prefetchedResponses.size > PREFETCH_MAX_ENTRIES) {
        prefetchedResponses.delete(prefetchedResponses.keys().next().value);
    }
}

function readPrefetched(url, options = {}) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // A caller explicitly requesting revalidation must reach fetch. Invalidate
    // the local answer as well so a later read cannot resurrect stale data.
    if (['no-store', 'reload', 'no-cache'].includes(options.cache)) {
        prefetchedResponses.delete(url);
        return null;
    }
    if (options.method && options.method.toUpperCase() !== 'GET') return null;
    const entry = prefetchedResponses.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        prefetchedResponses.delete(url);
        return null;
    }
    // Callers extend credit lists in place; each read gets its own copy.
    return structuredClone(entry.data);
}

function noteOmdbFailure(error) {
    if (error?.status === 503 && /not configured/i.test(error.message || '')) omdbNotConfigured = true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    let timedOut = false;
    const id = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
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
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        let data;
        try {
            data = await response.json();
        } catch (error) {
            if (controller.signal.aborted || error.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
            if (!response.ok) {
                const httpError = new Error(`HTTP error! status: ${response.status}`);
                httpError.status = response.status;
                throw httpError;
            }
            throw error;
        }
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        if (!response.ok) {
            const error = new Error(data && data.error ? data.error : `HTTP error! status: ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    } catch (error) {
        if (error.name === 'AbortError') {
            if (!timedOut && options.signal && options.signal.aborted) {
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
        const data = await fetchWithTimeout(`${API_BASE}/api/tmdb/search?q=${encodeURIComponent(query)}&${RELEASE_PARAM}`, options);
        if (isPlainObject(data) && 'prefetched' in data) {
            rememberPrefetched(data.prefetched);
            delete data.prefetched;
        }
        return data;
    },
    async searchPerson(query, options = {}) {
        const {
            personId,
            offset,
            limit,
            mediaType,
            ...requestOptions
        } = options;
        const url = tmdbPersonUrl(query, { personId, offset, limit, mediaType });
        return readPrefetched(url, requestOptions) || fetchWithTimeout(url, requestOptions);
    },
    async getDetail(id, type, options = {}) {
        const url = tmdbDetailUrl(id, type);
        return readPrefetched(url, options) || fetchWithTimeout(url, options);
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
        const { mediaType, year, ...requestOptions } = options;
        const typeParam = mediaType ? `&type=${encodeURIComponent(mediaType)}` : '';
        const yearParam = year ? `&year=${encodeURIComponent(year)}` : '';
        try {
            return await fetchWithTimeout(`${API_BASE}/api/wiki/zh?q=${encodeURIComponent(query)}${typeParam}${yearParam}&v=${encodeURIComponent(RELEASE_VERSION)}`, requestOptions);
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
        if (!imdbId || omdbNotConfigured) return null;
        try {
            return await fetchWithTimeout(`${API_BASE}/api/omdb?imdb=${encodeURIComponent(imdbId)}`, options, OMDB_TIMEOUT_MS);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            noteOmdbFailure(e);
            console.debug("OMDb fetch failed:", e);
            return null;
        }
    },
    async search(title, year, options = {}) {
        if (!title || omdbNotConfigured) return null;
        try {
            return await fetchWithTimeout(`${API_BASE}/api/omdb?title=${encodeURIComponent(title)}&year=${encodeURIComponent(year || '')}`, options, OMDB_TIMEOUT_MS);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            noteOmdbFailure(e);
            console.debug("OMDb title fetch failed:", e);
            return null;
        }
    }
};

export const ResourceAPI = {
    async search(query, options = {}, { refresh = false } = {}) {
        const refreshParam = refresh ? '&refresh=1' : '';
        // The Worker cache is scoped to its current provider credentials. Always
        // reach it so a browser cannot reuse results from a revoked session.
        const requestOptions = { ...options, cache: 'no-store' };
        return fetchWithTimeout(`${API_BASE}/api/resource?q=${encodeURIComponent(query)}${refreshParam}&v=${encodeURIComponent(RELEASE_VERSION)}`, requestOptions, RESOURCE_TIMEOUT_MS);
    }
};

/**
 * 海报专用接口：优先 TMDB，再向 OMDb 兜底
 */
export const PosterAPI = {
    async getPoster(title, year, options = {}, { refresh = false } = {}) {
        if (!title) return null;
        try {
            const { mediaId, mediaType, imdbId, ...fetchOptions } = options;
            const identityParams = [
                mediaId !== undefined && mediaId !== null ? `&id=${encodeURIComponent(mediaId)}` : '',
                mediaType !== undefined && mediaType !== null ? `&type=${encodeURIComponent(mediaType)}` : '',
                imdbId !== undefined && imdbId !== null ? `&imdb=${encodeURIComponent(imdbId)}` : ''
            ].join('');
            const refreshParam = refresh ? '&refresh=1' : '';
            const requestOptions = refresh ? { ...fetchOptions, cache: 'no-store' } : fetchOptions;
            return await fetchWithTimeout(`${API_BASE}/api/poster?title=${encodeURIComponent(title)}&year=${encodeURIComponent(year || '')}${identityParams}${refreshParam}`, requestOptions, POSTER_TIMEOUT_MS);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.debug("Poster fetch failed:", e);
            return null;
        }
    }
};
