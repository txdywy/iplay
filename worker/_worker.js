/**
 * Cloudflare Worker - iPlay API proxy
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const TMDB_POSTER_SIZE = "original";

const ALLOWED_ORIGINS = [
    "https://iplay.hackx64.eu.org",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://localhost:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8080"
];

function getAllowedOrigins(env) {
    const origins = new Set(ALLOWED_ORIGINS);
    const configured = env && typeof env.CORS_ALLOWED_ORIGINS === "string"
        ? env.CORS_ALLOWED_ORIGINS.split(",").slice(0, 20)
        : [];

    for (const value of configured) {
        try {
            const url = new URL(value.trim());
            if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
        } catch {
            // Ignore malformed configuration entries instead of weakening CORS.
        }
    }
    return origins;
}

function getCorsHeaders(request, env) {
    const origin = request.headers.get("Origin");
    if (origin && getAllowedOrigins(env).has(origin)) {
        return { "Access-Control-Allow-Origin": origin };
    }
    return {};
}

function withCors(response, request, env) {
    const headers = new Headers(response.headers);
    const corsHeaders = getCorsHeaders(request, env);
    for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
    }
    headers.append("Vary", "Origin");
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    ...getCorsHeaders(request, env),
                    "Vary": "Origin",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "86400",
                }
            });
        }

        if (request.method !== "GET") {
            return withCors(new Response("Method Not Allowed", {
                status: 405,
                headers: { "Allow": "GET, OPTIONS" }
            }), request, env);
        }

        const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
        if (!checkRateLimit(clientIp)) {
            return withCors(jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429), request, env);
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || url.pathname;

        if (path === "/api/tmdb/search") {
            return withCors(await handleTmdbSearch(url.searchParams.get("q"), env, ctx), request, env);
        }

        if (path === "/api/tmdb/detail") {
            return withCors(await handleTmdbDetail(
                url.searchParams.get("id"),
                url.searchParams.get("type"),
                env,
                ctx
            ), request, env);
        }

        if (path === "/api/douban/search") {
            return withCors(await handleDoubanSearch(url.searchParams.get("q"), ctx), request, env);
        }

        if (path === "/api/douban/detail") {
            return withCors(await handleDoubanDetail(url.searchParams.get("id"), ctx), request, env);
        }

        if (path === "/api/resource") {
            return withCors(await handleResourceSearch(url.searchParams.get("q"), ctx), request, env);
        }

        if (path === "/api/omdb") {
            const imdbId = url.searchParams.get("imdb") || url.searchParams.get("i");
            if (imdbId) {
                return withCors(await handleOmdbById(imdbId, env, ctx), request, env);
            }
            return withCors(await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"), env, ctx), request, env);
        }

        if (path === "/api/poster") {
            return withCors(await handlePosterSearch(url.searchParams.get("title"), url.searchParams.get("year"), env, ctx), request, env);
        }

        if (path === "/api/wiki/zh") {
            return withCors(await handleWikiZh(url.searchParams.get("q"), ctx), request, env);
        }

        return withCors(new Response("Not Found", { status: 404 }), request, env);
    },

    async scheduled(event, env, ctx) {
        console.log(`Scheduled refresh started at ${new Date(event.scheduledTime).toISOString()}`);
        ctx.waitUntil(refreshScheduledData(env, ctx));
    }
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json;charset=UTF-8"
        }
    });
}

const MAX_QUERY_LENGTH = 100;

function validateRequiredText(value, label, maxLength = MAX_QUERY_LENGTH) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { error: jsonResponse({ error: `Missing ${label}` }, 400) };
    if ([...text].length > maxLength) {
        return { error: jsonResponse({ error: `${label} is too long` }, 400) };
    }
    return { value: text };
}

function validatePositiveInteger(value, label = "id") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { error: jsonResponse({ error: `Missing ${label}` }, 400) };
    if (!/^[1-9]\d{0,11}$/.test(text)) {
        return { error: jsonResponse({ error: `Invalid ${label}` }, 400) };
    }
    return { value: text };
}

function validateImdbId(value) {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!text) return { error: jsonResponse({ error: "Missing imdb id" }, 400) };
    if (!/^tt\d{5,12}$/.test(text)) {
        return { error: jsonResponse({ error: "Invalid imdb id" }, 400) };
    }
    return { value: text };
}

function validateMediaType(value) {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!text) return { value: "movie" };
    if (text !== "movie" && text !== "tv") {
        return { error: jsonResponse({ error: "Invalid media type" }, 400) };
    }
    return { value: text };
}

function validateOptionalYear(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { value: "" };
    if (!/^\d{4}$/.test(text)) {
        return { error: jsonResponse({ error: "Invalid year" }, 400) };
    }
    return { value: text };
}

function createHttpError(message, status = 500) {
    const error = new Error(message);
    error.status = status;
    return error;
}

const UPSTREAM_TIMEOUT_MS = 8000;
const RESOURCE_TIMEOUT_MS = 5000;
const MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;

async function fetchUpstream(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") {
            throw createHttpError("Upstream request timed out", 504);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function readTextWithLimit(response, maxBytes = MAX_UPSTREAM_BODY_BYTES) {
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw createHttpError("Upstream response is too large", 502);
    }

    if (!response.body) return "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalSize = 0;
    let text = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > maxBytes) {
            await reader.cancel();
            throw createHttpError("Upstream response is too large", 502);
        }
        text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
}

async function readJsonWithLimit(response, maxBytes = MAX_UPSTREAM_BODY_BYTES) {
    return JSON.parse(await readTextWithLimit(response, maxBytes));
}

async function serveCachedJson(cacheKey) {
    return await caches.default.match(cacheKey);
}

function cacheJson(ctx, cacheKey, data, maxAge) {
    const response = jsonResponse(data);
    const toCache = response.clone();
    toCache.headers.set("Cache-Control", `public, max-age=${maxAge}`);
    if (ctx) ctx.waitUntil(caches.default.put(cacheKey, toCache));
    return response;
}

function getTmdbAuth(env) {
    if (env && env.TMDB_ACCESS_TOKEN) {
        return { type: "bearer", value: env.TMDB_ACCESS_TOKEN };
    }
    if (env && env.TMDB_API_KEY) {
        return { type: "api_key", value: env.TMDB_API_KEY };
    }
    return null;
}

function getOmdbApiKey(env) {
    return env && env.OMDB_API_KEY ? env.OMDB_API_KEY : null;
}

function tmdbImage(path, size = TMDB_POSTER_SIZE) {
    return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

function parseYear(date) {
    return date ? date.slice(0, 4) : null;
}

const _rateLimitMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60000;
const RATE_LIMIT_MAX_ENTRIES = 10000;
const RATE_LIMIT_CLEANUP_BATCH = 100;

function checkRateLimit(ip) {
    const now = Date.now();

    if (_rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES && !_rateLimitMap.has(ip)) {
        let inspected = 0;
        for (const [key, value] of _rateLimitMap) {
            if (now - value.start > RATE_WINDOW) _rateLimitMap.delete(key);
            inspected += 1;
            if (inspected >= RATE_LIMIT_CLEANUP_BATCH) break;
        }

        if (_rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
            const oldestKey = _rateLimitMap.keys().next().value;
            if (oldestKey !== undefined) _rateLimitMap.delete(oldestKey);
        }
    }

    const entry = _rateLimitMap.get(ip);
    if (!entry || now - entry.start > RATE_WINDOW) {
        _rateLimitMap.set(ip, { start: now, count: 1 });
        return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT;
}

async function fetchOmdbWithYearFallback(title, year, env) {
    const apiKey = getOmdbApiKey(env);
    if (!apiKey || !title) return null;
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`;
    if (year) url += `&y=${year}`;

    const res = await fetchUpstream(url);
    if (!res.ok) {
        throw createHttpError(`OMDb rejected with status ${res.status}`, res.status);
    }

    const data = await readJsonWithLimit(res);
    if (data.Response === "True") return data;

    if (year) {
        const fallbackRes = await fetchUpstream(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`);
        if (!fallbackRes.ok) {
            throw createHttpError(`OMDb rejected with status ${fallbackRes.status}`, fallbackRes.status);
        }

        const fallbackData = await readJsonWithLimit(fallbackRes);
        if (fallbackData.Response === "True") return fallbackData;
    }
    return null;
}

function normalizeTmdbItem(item) {
    const title = item.title || item.name || "";
    const originalTitle = item.original_title || item.original_name || title;
    const year = parseYear(item.release_date || item.first_air_date);

    return {
        id: item.id,
        mediaType: item.media_type || (item.title ? "movie" : "tv"),
        title,
        originalTitle,
        year,
        poster: tmdbImage(item.poster_path),
        backdrop: tmdbImage(item.backdrop_path, "w780"),
        summary: item.overview || "",
        tmdbRating: item.vote_average ?? null,
        tmdbVotes: item.vote_count ?? 0,
        popularity: item.popularity ?? 0,
        imdbId: null
    };
}

function normalizeTmdbDetail(data, type) {
    const title = data.title || data.name || "";
    const originalTitle = data.original_title || data.original_name || title;
    const year = parseYear(data.release_date || data.first_air_date);
    const credits = data.credits || {};
    const cast = Array.isArray(credits.cast) ? credits.cast.slice(0, 8).map(person => person.name).filter(Boolean) : [];
    const crew = Array.isArray(credits.crew) ? credits.crew : [];
    const director = new Set();
    const writer = new Set();

    for (const person of crew) {
        if (person.job === "Director" || person.department === "Directing") director.add(person.name);
        if (["Writer", "Screenplay", "Story"].includes(person.job)) writer.add(person.name);
    }

    const cleanDirector = [...director].filter(Boolean);
    const cleanWriter = [...writer].filter(Boolean);

    return {
        id: data.id,
        mediaType: type,
        title,
        originalTitle,
        year,
        poster: tmdbImage(data.poster_path),
        backdrop: tmdbImage(data.backdrop_path, "w780"),
        summary: data.overview || "",
        genres: Array.isArray(data.genres) ? data.genres.map(g => g.name).filter(Boolean) : [],
        runtime: data.runtime ?? null,
        status: data.status || null,
        originalLanguage: data.original_language || null,
        productionCompanies: Array.isArray(data.production_companies) ? data.production_companies.map(c => c.name).filter(Boolean) : [],
        productionCountries: Array.isArray(data.production_countries) ? data.production_countries.map(c => c.name).filter(Boolean) : [],
        cast,
        director: cleanDirector,
        writer: cleanWriter,
        tmdbRating: data.vote_average ?? null,
        tmdbVotes: data.vote_count ?? 0,
        imdbId: data.external_ids && data.external_ids.imdb_id ? data.external_ids.imdb_id : null,
        popularity: data.popularity ?? 0
    };
}

function isValidTmdbPayload(path, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (path === "/search/multi") return Array.isArray(data.results);
    if (/^\/(?:movie|tv)\/\d+$/.test(path)) return Number.isInteger(Number(data.id));
    return true;
}

async function fetchTmdbJson(path, params, env, ctx, options = {}) {
    const auth = getTmdbAuth(env);
    if (!auth) {
        throw createHttpError("Missing TMDB_ACCESS_TOKEN or TMDB_API_KEY", 503);
    }

    const url = new URL(`${TMDB_BASE}${path}`);
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    });

    const cacheKey = new Request(url.toString());
    const cache = caches.default;

    const cachedResponse = options.refreshCache ? null : await cache.match(cacheKey);
    let response = cachedResponse;

    if (!response) {
        const headers = {
            "Accept": "application/json"
        };

        if (auth.type === "bearer") {
            headers.Authorization = `Bearer ${auth.value}`;
        } else {
            url.searchParams.set("api_key", auth.value);
        }

        response = await fetchUpstream(url.toString(), { headers });
    }

    let data;
    try {
        data = await readJsonWithLimit(response);
    } catch (error) {
        if (cachedResponse && typeof cache.delete === "function") {
            await cache.delete(cacheKey);
            return fetchTmdbJson(path, params, env, ctx, { ...options, refreshCache: true });
        }
        if (error.status) throw error;
        throw createHttpError("TMDB returned invalid JSON", 502);
    }

    if (!response.ok) {
        const message = data && data.status_message ? data.status_message : `TMDB HTTP ${response.status}`;
        throw createHttpError(message, response.status);
    }

    if (!isValidTmdbPayload(path, data)) {
        if (cachedResponse && typeof cache.delete === "function") {
            await cache.delete(cacheKey);
            return fetchTmdbJson(path, params, env, ctx, { ...options, refreshCache: true });
        }
        throw createHttpError("TMDB returned an invalid response", 502);
    }

    if (!cachedResponse) {
        const cacheResponse = new Response(JSON.stringify(data), {
            status: response.status,
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                "Cache-Control": "public, max-age=86400"
            }
        });
        if (ctx) ctx.waitUntil(cache.put(cacheKey, cacheResponse));
    }

    return data;
}

async function fetchTmdbSearch(query, language, env, ctx) {
    return fetchTmdbJson("/search/multi", {
        query,
        language,
        include_adult: "false",
        page: "1"
    }, env, ctx);
}

async function refreshScheduledData(env, ctx) {
    const titles = getScheduledRefreshTitles(env);
    if (titles.length === 0) return;

    await Promise.allSettled(titles.map(title => refreshTitleData(title, env, ctx)));
}

function getScheduledRefreshTitles(env) {
    const rawTitles = env && env.CRON_REFRESH_TITLES ? env.CRON_REFRESH_TITLES : "大叔再出招";
    return rawTitles
        .split(",")
        .map(title => title.trim())
        .filter(Boolean)
        .slice(0, 20);
}

async function refreshTitleData(title, env, ctx) {
    const searchData = await fetchTmdbJson("/search/multi", {
        query: title,
        language: "zh-CN",
        include_adult: "false",
        page: "1"
    }, env, ctx, { refreshCache: true });

    const candidates = Array.isArray(searchData.results)
        ? searchData.results.filter(item => item.media_type === "movie" || item.media_type === "tv")
        : [];
    const best = pickBestTmdbPosterCandidate(candidates, title, null);
    if (!best) return;

    await fetchTmdbJson(`/${best.media_type}/${best.id}`, {
        language: "zh-CN",
        append_to_response: "external_ids,credits"
    }, env, ctx, { refreshCache: true }).catch(() => null);
}

function normalizeMatchText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\s\-_:,.!?()[\]{}'"“”‘’·、，。/\\]/g, "");
}

function pickBestTmdbPosterCandidate(items, title, year) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const normalizedTitle = normalizeMatchText(title);
    const scored = items
        .filter(item => (item.media_type === "movie" || item.media_type === "tv") && item.poster_path)
        .map(item => {
            const itemTitle = normalizeMatchText(item.title || item.name);
            const originalTitle = normalizeMatchText(item.original_title || item.original_name);
            const itemYear = parseYear(item.release_date || item.first_air_date);
            let score = 0;

            if (itemTitle === normalizedTitle || originalTitle === normalizedTitle) score += 1000;
            if ((itemTitle && itemTitle.includes(normalizedTitle)) || (originalTitle && originalTitle.includes(normalizedTitle))) score += 400;
            if ((itemTitle && normalizedTitle.includes(itemTitle)) || (originalTitle && normalizedTitle.includes(originalTitle))) score += 200;
            if (year && itemYear === String(year)) score += 300;
            score += Math.min(Number(item.popularity) || 0, 100);
            score += Math.min(Number(item.vote_count) || 0, 1000) / 100;

            return { item, score };
        })
        .sort((a, b) => b.score - a.score);

    return scored.length > 0 ? scored[0].item : null;
}

async function handleTmdbSearch(query, env, ctx) {
    const queryCheck = validateRequiredText(query, "query");
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    try {
        let data = await fetchTmdbSearch(query, "zh-CN", env, ctx);

        const usableZh = data && Array.isArray(data.results) ? data.results.some(item => item.media_type === "movie" || item.media_type === "tv") : false;
        if (!usableZh) {
            data = await fetchTmdbSearch(query, "en-US", env, ctx);
        }

        const results = [];
        const seen = new Set();

        if (data && Array.isArray(data.results)) {
            for (const item of data.results) {
                if (item.media_type !== "movie" && item.media_type !== "tv") continue;
                const resultKey = `${item.media_type}:${item.id}`;
                if (seen.has(resultKey)) continue;
                seen.add(resultKey);
                results.push(normalizeTmdbItem(item));
            }
        }

        results.sort((a, b) => (b.tmdbVotes || 0) - (a.tmdbVotes || 0) || (b.popularity || 0) - (a.popularity || 0));

        return jsonResponse({
            page: data && data.page ? data.page : 1,
            totalResults: data && data.total_results ? data.total_results : results.length,
            results
        });
    } catch (e) {
        console.error("TMDB search error:", e.message);
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

async function handleTmdbDetail(id, type, env, ctx) {
    const idCheck = validatePositiveInteger(id);
    if (idCheck.error) return idCheck.error;
    id = idCheck.value;

    const typeCheck = validateMediaType(type);
    if (typeCheck.error) return typeCheck.error;
    type = typeCheck.value;

    const apiType = type;
    const attemptOrder = apiType === "tv" ? ["tv", "movie"] : ["movie", "tv"];
    let lastError = null;

    for (const candidateType of attemptOrder) {
        try {
            const data = await fetchTmdbJson(`/${candidateType}/${id}`, {
                language: "zh-CN",
                append_to_response: "external_ids,credits"
            }, env, ctx);

            return jsonResponse(normalizeTmdbDetail(data, candidateType));
        } catch (e) {
            lastError = e;
            if (e.status !== 404) {
                return jsonResponse({ error: e.message }, e.status || 502);
            }
        }
    }

    return jsonResponse({ error: lastError ? lastError.message : "TMDB detail not found" }, 404);
}

const DOUBAN_SEARCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "application/json,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://movie.douban.com/"
};

const DOUBAN_DETAIL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://movie.douban.com/"
};

async function handleDoubanSearch(query, ctx) {
    const queryCheck = validateRequiredText(query, "query");
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const cacheKey = new Request(`https://douban-search-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const res = await fetchUpstream(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: DOUBAN_SEARCH_HEADERS
        });

        if (!res.ok) {
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        const data = JSON.parse(await readTextWithLimit(res));
        return cacheJson(ctx, cacheKey, data, 86400);
    } catch (e) {
        console.error("Douban search error:", e.message);
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

async function handleDoubanDetail(id, ctx) {
    const idCheck = validatePositiveInteger(id);
    if (idCheck.error) return idCheck.error;
    id = idCheck.value;

    const cacheKey = new Request(`https://douban-detail-cache.local/?id=${id}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetchUpstream(fetchUrl, {
            headers: DOUBAN_DETAIL_HEADERS,
            redirect: "follow"
        });

        if (!res.ok) {
            console.warn(`Douban detail ${id} returned ${res.status}`);
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        let result = {
            rating: 0,
            votes: 0,
            genres: [],
            summary: "",
            imdbId: ""
        };
        let isParsingSummary = false;

        const rewriter = new HTMLRewriter()
            .on('strong[property="v:average"]', {
                text(text) { result.rating = parseFloat(text.text) || result.rating; }
            })
            .on('span[property="v:votes"]', {
                text(text) { result.votes = parseInt(text.text) || result.votes; }
            })
            .on('span[property="v:genre"]', {
                text(text) { if (text.text.trim()) result.genres.push(text.text.trim()); }
            })
            .on('span[property="v:summary"]', {
                element() { isParsingSummary = true; },
                text(text) { if (isParsingSummary) result.summary += text.text; },
                elementEnd() { isParsingSummary = false; }
            })
            .on('a[href*="imdb.com"]', {
                element(el) {
                    const href = el.getAttribute("href");
                    if (href) {
                        const match = href.match(/tt\d+/);
                        if (match) result.imdbId = match[0];
                    }
                }
            });

        await rewriter.transform(res).text();
        result.summary = result.summary.replace(/\s+/g, ' ').trim();

        return cacheJson(ctx, cacheKey, result, 86400);
    } catch (e) {
        console.error("Douban detail error:", e.message);
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

// Capture only the Quark share token plus optional password query/hash params.
// Resource pages frequently embed the same URL in Markdown and escaped JSON, so
// matching arbitrary path characters also consumes `\\r\\n`, `\\u003C`, or the
// next Markdown URL.
const QUARK_URL_PATTERN = /(?:https?:\/\/)?(?:pan|drive)\.quark\.cn\/s\/[a-z0-9_-]+(?:[?#][^\s"'<>\\),，。；;]*)?/gi;
const QUARK_PASSWORD_PATTERN = /(?:提取码|密码|访问码)\s*[：:=]?\s*([a-z0-9]{2,12})/gi;
const BY669_BASE = "https://by669.org";
const WPZYS_BASE = "https://www.wpzys.org";
const RESOURCE_ALLOWED_ORIGINS = new Set([BY669_BASE, WPZYS_BASE]);

function isValidQuarkPassword(value) {
    return /^[a-z0-9]{2,12}$/i.test(value) && !/^https?$/i.test(value);
}

function extractQuarkPasswordFromParams(params) {
    for (const key of ["pwd", "password", "passcode", "code"]) {
        const value = params.get(key);
        if (value && isValidQuarkPassword(value)) return value;
    }
    return "";
}

function extractQuarkPasswordFromUrl(url) {
    const searchPassword = extractQuarkPasswordFromParams(url.searchParams);
    if (searchPassword) return searchPassword;

    const hashText = url.hash.replace(/^#/, "");
    if (!hashText) return "";

    const hashQuery = hashText.includes("?") ? hashText.slice(hashText.indexOf("?") + 1) : hashText;
    return extractQuarkPasswordFromParams(new URL(`https://quark-password.local/?${hashQuery}`).searchParams);
}

function parseQuarkUrl(rawUrl) {
    if (!rawUrl) return null;

    const cleaned = rawUrl
        .replace(/&amp;/g, "&")
        .replace(/[。．｡]$/g, "")
        .replace(/[),.；;]+$/g, "");

    try {
        const url = new URL(cleaned.startsWith("http") ? cleaned : `https://${cleaned}`);
        return {
            url: `${url.origin}${url.pathname}`,
            password: extractQuarkPasswordFromUrl(url)
        };
    } catch {
        return {
            url: cleaned.startsWith("http") ? cleaned : `https://${cleaned}`,
            password: ""
        };
    }
}

function collectQuarkUrls(text) {
    return collectQuarkEntries(text).map(item => item.url);
}

function normalizeResourcePageText(text) {
    return decodeHtmlEntities(text)
        .replace(/\\\//g, "/")
        .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/\\[rnt]/g, " ")
        .replace(/%3a/gi, ":");
}

function collectQuarkEntries(text) {
    if (!text) return [];

    const normalizedText = normalizeResourcePageText(text);
    const occurrences = Array.from(normalizedText.matchAll(QUARK_URL_PATTERN), match => {
        const parsed = parseQuarkUrl(match[0]);
        return parsed && parsed.url ? {
            index: match.index,
            end: match.index + match[0].length,
            url: parsed.url,
            ...(parsed.password ? { password: parsed.password } : {})
        } : null;
    }).filter(Boolean);

    for (const match of normalizedText.matchAll(QUARK_PASSWORD_PATTERN)) {
        if (!isValidQuarkPassword(match[1])) continue;

        const passwordIndex = match.index;
        const previous = occurrences
            .filter(occurrence => occurrence.end <= passwordIndex && passwordIndex - occurrence.end <= 160)
            .at(-1);
        const next = occurrences.find(occurrence => (
            occurrence.index >= passwordIndex + match[0].length
            && occurrence.index - (passwordIndex + match[0].length) <= 160
        ));
        const textBeforeNext = next
            ? normalizedText.slice(passwordIndex + match[0].length, next.index)
            : "";
        const target = next && /(?:链接|地址|夸克)/.test(textBeforeNext) ? next : previous || next;

        if (target && !target.password) target.password = match[1];
    }

    const entries = new Map();
    for (const occurrence of occurrences) {
        const existing = entries.get(occurrence.url);
        if (!existing) {
            entries.set(occurrence.url, occurrence.password
                ? { url: occurrence.url, password: occurrence.password }
                : { url: occurrence.url });
        } else if (!existing.password && occurrence.password) {
            existing.password = occurrence.password;
        }
    }

    return Array.from(entries.values());
}

function decodeHtmlEntities(value) {
    if (!value) return "";

    return value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(value) {
    return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function resolveResourceUrl(rawUrl, baseUrl) {
    try {
        const url = new URL(decodeHtmlEntities(rawUrl), baseUrl);
        if (url.protocol !== "https:" || url.username || url.password || !RESOURCE_ALLOWED_ORIGINS.has(url.origin)) {
            return "";
        }
        return url.toString();
    } catch {
        return "";
    }
}

const RESOURCE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAllowedResource(resourceUrl, options = {}) {
    let currentUrl = resolveResourceUrl(resourceUrl, BY669_BASE);
    if (!currentUrl) throw new Error("Blocked untrusted resource URL");

    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetchUpstream(currentUrl, { ...options, redirect: "manual" }, RESOURCE_TIMEOUT_MS);
        if (!RESOURCE_REDIRECT_STATUSES.has(response.status)) return response;

        const location = response.headers.get("Location");
        const nextUrl = location ? resolveResourceUrl(location, currentUrl) : "";
        if (!nextUrl) throw new Error("Blocked untrusted resource redirect");
        currentUrl = nextUrl;
    }

    throw new Error("Too many resource redirects");
}

function isQuarkResourceText(text) {
    return Boolean(text && (text.includes("夸克") || text.toLowerCase().includes("quark") || collectQuarkUrls(text).length > 0));
}

async function fetchResourcePageQuarkUrls(resourceUrl, resourceTitle, referer = `${BY669_BASE}/`) {
    const safeResourceUrl = resolveResourceUrl(resourceUrl, BY669_BASE);
    if (!safeResourceUrl) throw createHttpError("Blocked untrusted resource URL", 502);

    const res = await fetchAllowedResource(safeResourceUrl, {
        headers: {
            "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": referer
        }
    });

    if (!res.ok) {
        throw createHttpError(`Resource page rejected with status ${res.status}`, res.status);
    }

    const text = await readTextWithLimit(res);
    const quarkEntries = collectQuarkEntries(text);

    return quarkEntries.map(({ url, password }) => ({
        title: resourceTitle,
        url,
        ...(password ? { password } : {}),
        sourceUrl: safeResourceUrl,
        sourceTitle: resourceTitle
    }));
}

async function fetchBy669Resources(query) {
    const res = await fetchAllowedResource(`${BY669_BASE}/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] }
    });

    if (!res.ok) throw new Error(`By669 rejected with status ${res.status}`);

    const data = JSON.parse(await readTextWithLimit(res));
    if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
        throw createHttpError("By669 returned an invalid response", 502);
    }
    const resources = [];

    for (const item of data.data.slice(0, 50)) {
        if (!item.attributes || !item.attributes.title) continue;

        resources.push({
            title: item.attributes.title,
            url: `${BY669_BASE}/d/${item.id}`,
            isQuark: isQuarkResourceText(item.attributes.title),
            source: "by669"
        });
    }

    return resources;
}

function parseWpzysResources(html, query) {
    const resources = [];
    const seenUrls = new Set();
    const normalizedQuery = normalizeMatchText(query);
    const itemPattern = /<li\b[^>]*data-href=["']([^"']*thread-\d+\.htm[^"']*)["'][\s\S]*?<\/li>/gi;
    let match;

    while ((match = itemPattern.exec(html)) !== null) {
        const block = match[0];
        const rawUrl = match[1];
        const url = resolveResourceUrl(rawUrl, WPZYS_BASE);
        if (!url || seenUrls.has(url)) continue;

        const threadPath = rawUrl.replace(/^\.\//, "").replace(/^\/+/, "").split("#")[0];
        const titlePattern = new RegExp(`<a[^>]+href=["'](?:\\./|/)?${threadPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)<\\/a>`, "i");
        const titleMatch = block.match(titlePattern) || block.match(/<a[^>]+href=["'][^"']*thread-\d+\.htm[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        const title = titleMatch ? stripHtml(titleMatch[1]) : stripHtml(block);
        const normalizedTitle = normalizeMatchText(title);

        if (!title || (normalizedQuery && !normalizedTitle.includes(normalizedQuery))) continue;
        if (!isQuarkResourceText(block)) continue;

        seenUrls.add(url);
        resources.push({
            title,
            url,
            isQuark: true,
            source: "wpzys"
        });
        if (resources.length >= 50) break;
    }

    return resources;
}

function isWpzysChallengePage(html) {
    return /(?:id=["']challenge-platform["']|\bcf-chl-|<title>\s*just a moment(?:\.\.\.)?\s*<\/title>|enable javascript and cookies to continue)/i.test(html);
}

async function fetchWpzysResources(query) {
    const res = await fetchAllowedResource(`${WPZYS_BASE}/search.htm?keyword=${encodeURIComponent(query)}`, {
        headers: {
            "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": `${WPZYS_BASE}/search.htm`
        }
    });

    if (!res.ok) throw new Error(`WPZYS rejected with status ${res.status}`);

    const html = await readTextWithLimit(res);
    if (!html.trim()) {
        throw createHttpError("WPZYS returned an empty response", 502);
    }
    if (isWpzysChallengePage(html)) {
        throw createHttpError("WPZYS returned a challenge page", 502);
    }

    return parseWpzysResources(html, query);
}

async function collectQuarkUrlsFromResources(resources) {
    const quarkUrls = [];
    const quarkUrlsByUrl = new Map();
    const batchSize = 6;
    const maxPages = Math.min(resources.length, 12);
    let failedPages = 0;

    for (let index = 0; index < maxPages; index += batchSize) {
        const batch = resources.slice(index, Math.min(index + batchSize, maxPages));
        const quarkUrlGroups = await Promise.allSettled(
            batch.map(entry => fetchResourcePageQuarkUrls(
                entry.url,
                entry.title,
                entry.source === "wpzys" ? `${WPZYS_BASE}/` : `${BY669_BASE}/`
            ))
        );

        for (const group of quarkUrlGroups) {
            if (group.status !== "fulfilled" || !Array.isArray(group.value)) {
                failedPages += 1;
                continue;
            }

            for (const item of group.value) {
                if (!item.url) continue;
                const existing = quarkUrlsByUrl.get(item.url);
                if (existing) {
                    if (!existing.password && item.password) existing.password = item.password;
                    continue;
                }
                quarkUrlsByUrl.set(item.url, item);
                quarkUrls.push(item);
            }
        }
    }

    return {
        quarkUrls,
        attemptedPages: maxPages,
        failedPages
    };
}

async function handleResourceSearch(query, ctx) {
    const queryCheck = validateRequiredText(query, "query");
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const cacheKey = new Request(`https://resource-search-v5-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const [by669Result, wpzysResult] = await Promise.allSettled([
            fetchBy669Resources(query),
            fetchWpzysResources(query)
        ]);

        if (by669Result.status === "rejected" && wpzysResult.status === "rejected") {
            console.warn("Resource providers unavailable", {
                by669: by669Result.reason?.message || "unknown error",
                wpzys: wpzysResult.reason?.message || "unknown error"
            });
            return jsonResponse({ error: "Resource providers unavailable" }, 502);
        }

        const resources = by669Result.status === "fulfilled" ? by669Result.value : [];
        const wpzysResources = wpzysResult.status === "fulfilled" ? wpzysResult.value : [];
        const allResources = [...resources, ...wpzysResources];
        const detailResult = await collectQuarkUrlsFromResources(allResources);

        const isPartial = by669Result.status === "rejected"
            || wpzysResult.status === "rejected"
            || detailResult.failedPages > 0;
        return cacheJson(ctx, cacheKey, {
            resources,
            wpzysResources,
            quarkUrls: detailResult.quarkUrls
        }, isPartial ? 900 : 43200);
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

function requireOmdbApiKey(env) {
    const key = getOmdbApiKey(env);
    if (!key) return { error: jsonResponse({ error: "OMDb API not configured" }, 503) };
    return { key };
}

async function handleOmdbById(imdbId, env, ctx) {
    const imdbIdCheck = validateImdbId(imdbId);
    if (imdbIdCheck.error) return imdbIdCheck.error;
    imdbId = imdbIdCheck.value;

    const keyCheck = requireOmdbApiKey(env);
    if (keyCheck.error) return keyCheck.error;

    const cacheKey = new Request(`https://omdb-cache.local/id/${encodeURIComponent(imdbId)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const res = await fetchUpstream(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${keyCheck.key}`);

        if (!res.ok) {
            return jsonResponse({ error: `OMDb rejected with status ${res.status}` }, res.status);
        }

        const data = await readJsonWithLimit(res);

        if (data.Response === "True") {
            return cacheJson(ctx, cacheKey, extractOmdbProfile(data), 86400);
        }
        return jsonResponse({ error: "OMDb: Not found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

async function handleOmdbSearch(title, year, env, ctx) {
    const titleCheck = validateRequiredText(title, "title");
    if (titleCheck.error) return titleCheck.error;
    title = titleCheck.value;

    const yearCheck = validateOptionalYear(year);
    if (yearCheck.error) return yearCheck.error;
    year = yearCheck.value;

    const keyCheck = requireOmdbApiKey(env);
    if (keyCheck.error) return keyCheck.error;

    const cacheKey = new Request(`https://omdb-cache.local/search/?t=${encodeURIComponent(title)}&y=${year || ''}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const data = await fetchOmdbWithYearFallback(title, year, env);
        if (data) return cacheJson(ctx, cacheKey, extractOmdbProfile(data), 86400);
        return jsonResponse({ error: "Not found on OMDb" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

function cleanOmdbValue(value) {
    return value && value !== "N/A" ? value : null;
}

function cleanOmdbFloat(value) {
    const clean = cleanOmdbValue(value);
    return clean ? Number.parseFloat(clean) : null;
}

function cleanOmdbInt(value) {
    const clean = cleanOmdbValue(value);
    return clean ? Number.parseInt(clean, 10) : null;
}

function splitOmdbList(value) {
    const clean = cleanOmdbValue(value);
    return clean ? clean.split(",").map(item => item.trim()).filter(Boolean) : [];
}

function extractRottenTomato(ratings) {
    if (!Array.isArray(ratings)) return null;
    const rTomato = ratings.find(r => r.Source === "Rotten Tomatoes");
    return rTomato ? Number.parseInt(rTomato.Value.replace('%', ''), 10) : null;
}

function extractOmdbProfile(data) {
    return {
        omdb: true,
        imdb: cleanOmdbFloat(data.imdbRating),
        imdbVotes: cleanOmdbValue(data.imdbVotes),
        rottenTomatoes: extractRottenTomato(data.Ratings),
        poster: cleanOmdbValue(data.Poster),
        title: cleanOmdbValue(data.Title),
        year: cleanOmdbValue(data.Year),
        type: cleanOmdbValue(data.Type),
        rated: cleanOmdbValue(data.Rated),
        released: cleanOmdbValue(data.Released),
        runtime: cleanOmdbValue(data.Runtime),
        genres: splitOmdbList(data.Genre),
        director: cleanOmdbValue(data.Director),
        writer: cleanOmdbValue(data.Writer),
        actors: cleanOmdbValue(data.Actors),
        plot: cleanOmdbValue(data.Plot),
        language: cleanOmdbValue(data.Language),
        country: cleanOmdbValue(data.Country),
        awards: cleanOmdbValue(data.Awards),
        boxOffice: cleanOmdbValue(data.BoxOffice),
        production: cleanOmdbValue(data.Production),
        metascore: cleanOmdbInt(data.Metascore),
        imdbId: cleanOmdbValue(data.imdbID)
    };
}

async function handlePosterSearch(title, year, env, ctx) {
    const titleCheck = validateRequiredText(title, "title");
    if (titleCheck.error) return titleCheck.error;
    title = titleCheck.value;

    const yearCheck = validateOptionalYear(year);
    if (yearCheck.error) return yearCheck.error;
    year = yearCheck.value;

    const hasTmdb = Boolean(getTmdbAuth(env));
    const hasOmdb = Boolean(getOmdbApiKey(env));
    if (!hasTmdb && !hasOmdb) {
        return jsonResponse({ error: "Poster providers are not configured" }, 503);
    }

    const configuredSources = `${hasTmdb ? "tmdb" : ""}-${hasOmdb ? "omdb" : ""}`;
    const cacheKey = new Request(`https://poster-v1-cache.local/?title=${encodeURIComponent(title)}&year=${year}&sources=${configuredSources}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const [tmdbResult, omdbResult] = await Promise.allSettled([
            tryTmdbForPoster(title, year, env, ctx),
            tryOmdbForPoster(title, year, env)
        ]);

        const tmdbPoster = tmdbResult.status === "fulfilled" ? tmdbResult.value : null;
        const omdbProfile = omdbResult.status === "fulfilled" ? omdbResult.value : null;
        const isPartial = (hasTmdb && tmdbResult.status === "rejected")
            || (hasOmdb && omdbResult.status === "rejected");
        const sourceFailures = [
            hasTmdb && tmdbResult.status === "rejected" ? tmdbResult.reason : null,
            hasOmdb && omdbResult.status === "rejected" ? omdbResult.reason : null
        ].filter(Boolean);
        const cacheMaxAge = isPartial ? 900 : 86400;

        if (tmdbPoster) {
            return cacheJson(ctx, cacheKey, {
                ...tmdbPoster,
                omdb: omdbProfile
            }, cacheMaxAge);
        }

        if (omdbProfile) return cacheJson(ctx, cacheKey, omdbProfile, cacheMaxAge);

        if (hasOmdb && omdbResult.status === "fulfilled") {
            const enTitle = await getEnglishTitleFromWiki(title);
            if (enTitle && enTitle !== title) {
                const result = await tryOmdbForPoster(enTitle, year, env);
                if (result) return cacheJson(ctx, cacheKey, result, cacheMaxAge);
            }
        }

        if (sourceFailures.length > 0) {
            const failure = sourceFailures.find(error => error?.status === 504) || sourceFailures[0];
            return jsonResponse({ error: failure.message }, failure.status || 502);
        }

        return jsonResponse({ error: "No poster found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}

async function tryTmdbForPoster(title, year, env, ctx) {
    let searchData = await fetchTmdbJson("/search/multi", {
        query: title,
        language: "zh-CN",
        include_adult: "false",
        page: "1"
    }, env, ctx);

    let candidates = Array.isArray(searchData.results)
        ? searchData.results.filter(item => !year || parseYear(item.release_date || item.first_air_date) === String(year))
        : [];
    let bestRaw = pickBestTmdbPosterCandidate(candidates, title, year);

    if (!bestRaw) {
        searchData = await fetchTmdbJson("/search/multi", {
            query: title,
            language: "en-US",
            include_adult: "false",
            page: "1"
        }, env, ctx);
        candidates = Array.isArray(searchData.results)
            ? searchData.results.filter(item => !year || parseYear(item.release_date || item.first_air_date) === String(year))
            : [];
        bestRaw = pickBestTmdbPosterCandidate(candidates, title, year);
    }

    if (!bestRaw) return null;

    const best = normalizeTmdbItem(bestRaw);
    return {
        poster: tmdbImage(bestRaw.poster_path),
        tmdbRating: best.tmdbRating,
        tmdbVotes: best.tmdbVotes,
        rottenTomatoes: null,
        tmdb: true,
        tmdbId: best.id,
        mediaType: best.mediaType
    };
}

async function tryOmdbForPoster(title, year, env) {
    const data = await fetchOmdbWithYearFallback(title, year, env);
    if (data && data.Poster && data.Poster !== "N/A") {
        return extractOmdbProfile(data);
    }
    return null;
}

async function getEnglishTitleFromWiki(zhTitle) {
    const title = await searchZhWikiTitle(zhTitle);
    if (!title) return null;

    const pageRes = await fetchUpstream(
        `https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=${encodeURIComponent(title)}&lllang=en&format=json&origin=*`,
        { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
    );
    if (!pageRes.ok) {
        throw createHttpError(`Wiki langlinks rejected with status ${pageRes.status}`, pageRes.status);
    }

    const pageData = await readJsonWithLimit(pageRes);
    const pages = pageData?.query?.pages;
    const page = pages && typeof pages === "object" ? Object.values(pages)[0] : null;
    const langlinks = Array.isArray(page?.langlinks) ? page.langlinks : [];
    return langlinks.length > 0 ? langlinks[0]["*"] || null : null;
}

async function searchZhWikiTitle(query) {
    const searchRes = await fetchUpstream(
        `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
        { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
    );
    if (!searchRes.ok) {
        throw createHttpError(`Wiki search rejected with status ${searchRes.status}`, searchRes.status);
    }
    const searchData = await readJsonWithLimit(searchRes);

    if (!Array.isArray(searchData?.query?.search) || !searchData.query.search.length) return null;
    return searchData.query.search[0].title;
}

async function handleWikiZh(query, ctx) {
    const queryCheck = validateRequiredText(query, "query");
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const cacheKey = new Request(`https://wiki-zh-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const searchRes = await fetchUpstream(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );

        if (!searchRes.ok) {
            return jsonResponse({ error: `Wiki search failed: ${searchRes.status}` }, searchRes.status);
        }

        const searchData = await readJsonWithLimit(searchRes);

        if (!searchData.query || !searchData.query.search || !searchData.query.search.length) {
            return jsonResponse({ error: "Not found on zh.wikipedia" }, 404);
        }

        const title = searchData.query.search[0].title;

        const summaryRes = await fetchUpstream(
            `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );

        if (!summaryRes.ok) {
             return jsonResponse({ error: `Wiki summary failed: ${summaryRes.status}` }, summaryRes.status);
        }

        const summaryData = await readJsonWithLimit(summaryRes);

        const result = {
            title: summaryData.title,
            extract: summaryData.extract,
            thumbnail: summaryData.thumbnail || null
        };

        return cacheJson(ctx, cacheKey, result, 86400);
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 502);
    }
}
