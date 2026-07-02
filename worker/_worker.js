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
    "http://localhost:3000"
];

function getCorsHeaders(request) {
    const origin = request.headers.get("Origin");
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        return { "Access-Control-Allow-Origin": origin };
    }
    return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0] };
}

function withCors(response, request) {
    const headers = new Headers(response.headers);
    const corsHeaders = getCorsHeaders(request);
    for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
    }
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
                    ...getCorsHeaders(request),
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "86400",
                }
            });
        }

        const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
        if (!checkRateLimit(clientIp)) {
            return withCors(jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429), request);
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || url.pathname;

        if (path === "/api/tmdb/search") {
            return withCors(await handleTmdbSearch(url.searchParams.get("q"), env, ctx), request);
        }

        if (path === "/api/tmdb/detail") {
            return withCors(await handleTmdbDetail(
                url.searchParams.get("id"),
                url.searchParams.get("type"),
                env,
                ctx
            ), request);
        }

        if (path === "/api/douban/search") {
            return withCors(await handleDoubanSearch(url.searchParams.get("q"), ctx), request);
        }

        if (path === "/api/douban/detail") {
            return withCors(await handleDoubanDetail(url.searchParams.get("id"), ctx), request);
        }

        if (path === "/api/resource") {
            return withCors(await handleResourceSearch(url.searchParams.get("q"), ctx), request);
        }

        if (path === "/api/omdb") {
            const imdbId = url.searchParams.get("imdb");
            if (imdbId) {
                return withCors(await handleOmdbById(imdbId, env, ctx), request);
            }
            return withCors(await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"), env, ctx), request);
        }

        if (path === "/api/poster") {
            return withCors(await handlePosterSearch(url.searchParams.get("title"), url.searchParams.get("year"), env, ctx), request);
        }

        if (path === "/api/wiki/zh") {
            return withCors(await handleWikiZh(url.searchParams.get("q"), ctx), request);
        }

        return withCors(new Response("Not Found", { status: 404 }), request);
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

function checkRateLimit(ip) {
    const now = Date.now();

    if (_rateLimitMap.size > 10000) {
        for (const [k, v] of _rateLimitMap) {
            if (now - v.start > RATE_WINDOW) _rateLimitMap.delete(k);
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

    const res = await fetch(url);
    if (res.ok) {
        const data = await res.json();
        if (data.Response === "True") return data;
    }

    if (year) {
        const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`);
        if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json();
            if (fallbackData.Response === "True") return fallbackData;
        }
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

async function fetchTmdbJson(path, params, env, ctx, options = {}) {
    const auth = getTmdbAuth(env);
    if (!auth) {
        throw new Error("Missing TMDB_ACCESS_TOKEN or TMDB_API_KEY");
    }

    const url = new URL(`${TMDB_BASE}${path}`);
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    });

    const cacheKey = new Request(url.toString());
    const cache = caches.default;

    let response = options.refreshCache ? null : await cache.match(cacheKey);

    if (!response) {
        const headers = {
            "Accept": "application/json"
        };

        if (auth.type === "bearer") {
            headers.Authorization = `Bearer ${auth.value}`;
        } else {
            url.searchParams.set("api_key", auth.value);
        }

        response = await fetch(url.toString(), { headers });
        if (response.ok) {
            const clonedResponse = response.clone();
            const newHeaders = new Headers(clonedResponse.headers);
            newHeaders.set('Cache-Control', 'public, max-age=86400');
            const cacheResponse = new Response(clonedResponse.body, {
                status: clonedResponse.status,
                statusText: clonedResponse.statusText,
                headers: newHeaders
            });
            if (ctx) ctx.waitUntil(cache.put(cacheKey, cacheResponse));
        }
    }

    const data = await response.json();
    if (!response.ok) {
        const message = data && data.status_message ? data.status_message : `TMDB HTTP ${response.status}`;
        throw new Error(message);
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
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

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
                if (seen.has(item.id)) continue;
                seen.add(item.id);
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
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleTmdbDetail(id, type, env, ctx) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    const apiType = type === "tv" ? "tv" : "movie";
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
        }
    }

    return jsonResponse({ error: lastError ? lastError.message : "TMDB detail not found" }, 500);
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
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    const cacheKey = new Request(`https://douban-search-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const res = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: DOUBAN_SEARCH_HEADERS
        });

        if (!res.ok) {
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        const data = JSON.parse(await res.text());
        return cacheJson(ctx, cacheKey, data, 86400);
    } catch (e) {
        console.error("Douban search error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleDoubanDetail(id, ctx) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    const cacheKey = new Request(`https://douban-detail-cache.local/?id=${id}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetch(fetchUrl, {
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
        return jsonResponse({ error: e.message }, 500);
    }
}

// A Quark share URL ends at its opaque share token. Resource pages frequently
// embed the same URL in Markdown and escaped JSON, so matching arbitrary path
// characters also consumes `\\r\\n`, `\\u003C`, or the next Markdown URL.
const QUARK_URL_PATTERN = /(?:https?:\/\/)?(?:pan|drive)\.quark\.cn\/s\/[a-z0-9_-]+/gi;
const BY669_BASE = "https://by669.org";
const WPZYS_BASE = "https://www.wpzys.org";

function normalizeQuarkUrl(rawUrl) {
    if (!rawUrl) return null;

    const cleaned = rawUrl
        .replace(/&amp;/g, "&")
        .replace(/[。．｡]$/g, "")
        .replace(/[),.；;]+$/g, "");

    try {
        return new URL(cleaned.startsWith("http") ? cleaned : `https://${cleaned}`).toString();
    } catch {
        return cleaned.startsWith("http") ? cleaned : `https://${cleaned}`;
    }
}

function collectQuarkUrls(text) {
    if (!text) return [];

    const matches = new Set();
    const found = text.replace(/\\\//g, "/").match(QUARK_URL_PATTERN) || [];
    for (const item of found) {
        const url = normalizeQuarkUrl(item);
        if (url) matches.add(url);
    }

    return Array.from(matches);
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
        return new URL(decodeHtmlEntities(rawUrl), baseUrl).toString();
    } catch {
        return rawUrl;
    }
}

function isQuarkResourceText(text) {
    return Boolean(text && (text.includes("夸克") || text.toLowerCase().includes("quark") || collectQuarkUrls(text).length > 0));
}

async function fetchResourcePageQuarkUrls(resourceUrl, resourceTitle, referer = `${BY669_BASE}/`) {
    try {
        const res = await fetch(resourceUrl, {
            headers: {
                "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer": referer
            },
            redirect: "follow"
        });

        if (!res.ok) return [];

        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > 2 * 1024 * 1024) return [];

        const reader = res.body.getReader();
        const chunks = [];
        let totalSize = 0;
        const MAX_SIZE = 2 * 1024 * 1024;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalSize += value.byteLength;
            if (totalSize > MAX_SIZE) { reader.cancel(); return []; }
            chunks.push(value);
        }

        const decoder = new TextDecoder();
        const text = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
        const quarkUrls = collectQuarkUrls(text);

        return quarkUrls.map(url => ({
            title: resourceTitle,
            url,
            sourceUrl: resourceUrl,
            sourceTitle: resourceTitle
        }));
    } catch {
        return [];
    }
}

async function fetchBy669Resources(query) {
    const res = await fetch(`${BY669_BASE}/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] }
    });

    if (!res.ok) throw new Error(`By669 rejected with status ${res.status}`);

    const data = await res.json();
    const resources = [];

    for (const item of data.data || []) {
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
        if (seenUrls.has(url)) continue;

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
    }

    return resources;
}

async function fetchWpzysResources(query) {
    const res = await fetch(`${WPZYS_BASE}/search.htm?keyword=${encodeURIComponent(query)}`, {
        headers: {
            "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": `${WPZYS_BASE}/search.htm`
        },
        redirect: "follow"
    });

    if (!res.ok) throw new Error(`WPZYS rejected with status ${res.status}`);

    return parseWpzysResources(await res.text(), query);
}

async function collectQuarkUrlsFromResources(resources) {
    const quarkUrls = [];
    const seenQuarkUrls = new Set();
    const batchSize = 5;
    const maxPages = Math.min(resources.length, 16);

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
            if (group.status !== "fulfilled" || !Array.isArray(group.value)) continue;

            for (const item of group.value) {
                if (!item.url || seenQuarkUrls.has(item.url)) continue;
                seenQuarkUrls.add(item.url);
                quarkUrls.push(item);
            }
        }
    }

    return quarkUrls;
}

async function handleResourceSearch(query, ctx) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    const cacheKey = new Request(`https://resource-search-v3-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const [by669Result, wpzysResult] = await Promise.allSettled([
            fetchBy669Resources(query),
            fetchWpzysResources(query)
        ]);

        const resources = by669Result.status === "fulfilled" ? by669Result.value : [];
        const wpzysResources = wpzysResult.status === "fulfilled" ? wpzysResult.value : [];
        const allResources = [...resources, ...wpzysResources];
        const quarkUrls = await collectQuarkUrlsFromResources(allResources);

        return cacheJson(ctx, cacheKey, { resources: allResources, wpzysResources, quarkUrls }, 43200);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

function requireOmdbApiKey(env) {
    const key = getOmdbApiKey(env);
    if (!key) return { error: jsonResponse({ error: "OMDb API not configured" }, 503) };
    return { key };
}

async function handleOmdbById(imdbId, env, ctx) {
    const keyCheck = requireOmdbApiKey(env);
    if (keyCheck.error) return keyCheck.error;
    if (!imdbId) return jsonResponse({ error: "Missing imdb id" }, 400);

    const cacheKey = new Request(`https://omdb-cache.local/id/${encodeURIComponent(imdbId)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${keyCheck.key}`);

        if (!res.ok) {
            return jsonResponse({ error: `OMDb rejected with status ${res.status}` }, res.status);
        }

        const data = await res.json();

        if (data.Response === "True") {
            return cacheJson(ctx, cacheKey, extractOmdbProfile(data), 86400);
        }
        return jsonResponse({ error: "OMDb: Not found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleOmdbSearch(title, year, env, ctx) {
    const keyCheck = requireOmdbApiKey(env);
    if (keyCheck.error) return keyCheck.error;
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    const cacheKey = new Request(`https://omdb-cache.local/search/?t=${encodeURIComponent(title)}&y=${year || ''}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const data = await fetchOmdbWithYearFallback(title, year, env);
        if (data) return cacheJson(ctx, cacheKey, extractOmdbProfile(data), 86400);
        return jsonResponse({ error: "Not found on OMDb" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
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
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    try {
        const [tmdbResult, omdbResult] = await Promise.allSettled([
            tryTmdbForPoster(title, year, env, ctx),
            tryOmdbForPoster(title, year, env)
        ]);

        const tmdbPoster = tmdbResult.status === "fulfilled" ? tmdbResult.value : null;
        const omdbProfile = omdbResult.status === "fulfilled" ? omdbResult.value : null;

        if (tmdbPoster) {
            return jsonResponse({
                ...tmdbPoster,
                omdb: omdbProfile
            });
        }

        if (omdbProfile) return jsonResponse(omdbProfile);

        const enTitle = await getEnglishTitleFromWiki(title);
        if (enTitle && enTitle !== title) {
            const result = await tryOmdbForPoster(enTitle, year, env);
            if (result) return jsonResponse(result);
        }

        return jsonResponse({ error: "No poster found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function tryTmdbForPoster(title, year, env, ctx) {
    try {
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
    } catch {
        return null;
    }
}

async function tryOmdbForPoster(title, year, env) {
    const data = await fetchOmdbWithYearFallback(title, year, env);
    if (data && data.Poster && data.Poster !== "N/A") {
        return extractOmdbProfile(data);
    }
    return null;
}

async function getEnglishTitleFromWiki(zhTitle) {
    try {
        const title = await searchZhWikiTitle(zhTitle);
        if (!title) return null;

        const pageRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=${encodeURIComponent(title)}&lllang=en&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const pageData = await pageRes.json();

        const pages = pageData.query.pages;
        const pageId = Object.keys(pages)[0];
        const langlinks = pages[pageId].langlinks;

        if (langlinks && langlinks.length > 0) {
            return langlinks[0]["*"];
        }

        return null;
    } catch (e) {
        console.warn("Wiki English title fetch failed:", e);
        return null;
    }
}

async function searchZhWikiTitle(query) {
    const searchRes = await fetch(
        `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
        { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
    );
    const searchData = await searchRes.json();

    if (!searchData.query || !searchData.query.search.length) return null;
    return searchData.query.search[0].title;
}

async function handleWikiZh(query, ctx) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    const cacheKey = new Request(`https://wiki-zh-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const searchRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );

        if (!searchRes.ok) {
            return jsonResponse({ error: `Wiki search failed: ${searchRes.status}` }, searchRes.status);
        }

        const searchData = await searchRes.json();

        if (!searchData.query || !searchData.query.search || !searchData.query.search.length) {
            return jsonResponse({ error: "Not found on zh.wikipedia" }, 404);
        }

        const title = searchData.query.search[0].title;

        const summaryRes = await fetch(
            `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );

        if (!summaryRes.ok) {
             return jsonResponse({ error: `Wiki summary failed: ${summaryRes.status}` }, summaryRes.status);
        }

        const summaryData = await summaryRes.json();

        const result = {
            title: summaryData.title,
            extract: summaryData.extract,
            thumbnail: summaryData.thumbnail || null
        };

        return cacheJson(ctx, cacheKey, result, 86400);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}
