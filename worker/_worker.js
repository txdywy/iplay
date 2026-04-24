/**
 * Cloudflare Worker - iPlay API proxy
 */

const DEFAULT_OMDB_API_KEY = "80077e97";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "86400",
                }
            });
        }

        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/tmdb/search")) {
            return await handleTmdbSearch(url.searchParams.get("q"), env, ctx);
        }

        if (url.pathname.startsWith("/api/tmdb/detail")) {
            return await handleTmdbDetail(
                url.searchParams.get("id"),
                url.searchParams.get("type"),
                env,
                ctx
            );
        }

        if (url.pathname.startsWith("/api/douban/search")) {
            return await handleDoubanSearch(url.searchParams.get("q"), ctx);
        }

        if (url.pathname.startsWith("/api/douban/detail")) {
            return await handleDoubanDetail(url.searchParams.get("id"), ctx);
        }

        if (url.pathname.startsWith("/api/resource")) {
            return await handleResourceSearch(url.searchParams.get("q"), ctx);
        }

        if (url.pathname.startsWith("/api/omdb")) {
            const imdbId = url.searchParams.get("imdb");
            if (imdbId) {
                return await handleOmdbById(imdbId, env, ctx);
            }
            return await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"), env, ctx);
        }

        if (url.pathname.startsWith("/api/poster")) {
            return await handlePosterSearch(url.searchParams.get("title"), url.searchParams.get("year"), env, ctx);
        }

        if (url.pathname.startsWith("/api/wiki/zh")) {
            return await handleWikiZh(url.searchParams.get("q"), ctx);
        }

        return new Response("Not Found", { status: 404 });
    }
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": "*"
        }
    });
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
    return env && env.OMDB_API_KEY ? env.OMDB_API_KEY : DEFAULT_OMDB_API_KEY;
}

function tmdbImage(path, size = "w500") {
    return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

function parseYear(date) {
    return date ? date.slice(0, 4) : null;
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
        poster: tmdbImage(item.poster_path, "w342"),
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
    const director = [];
    const writer = [];

    for (const person of crew) {
        if (person.job === "Director" || person.department === "Directing") director.push(person.name);
        if (["Writer", "Screenplay", "Story"].includes(person.job)) writer.push(person.name);
    }

    const cleanDirector = director.filter(Boolean);
    const cleanWriter = writer.filter(Boolean);

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

async function fetchTmdbJson(path, params, env, ctx) {
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

    let response = await cache.match(cacheKey);

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
            ctx.waitUntil(cache.put(cacheKey, cacheResponse));
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

async function handleTmdbSearch(query, env, ctx) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        let zhData = null;
        try {
            zhData = await fetchTmdbSearch(query, "zh-CN", env, ctx);
        } catch(e) {
            console.error("zh-CN TMDB fetch failed:", e.message);
            throw e; // We want to see this error!
        }
        let data = zhData;

        const usableZh = data && Array.isArray(data.results) ? data.results.some(item => item.media_type === "movie" || item.media_type === "tv") : false;
        if (!usableZh) {
            try {
                data = await fetchTmdbSearch(query, "en-US", env, ctx);
            } catch(e) {
                console.error("en-US TMDB fetch failed:", e.message);
                throw e; // We want to see this error!
            }
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
    "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Accept": "application/json,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://movie.douban.com/"
};

function randomBid() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 11 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const DOUBAN_DETAIL_HEADERS_BASE = {
    "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://movie.douban.com/"
};

function getDoubanDetailHeaders() {
    return DOUBAN_DETAIL_HEADERS_BASE;
}

async function handleDoubanSearch(query, ctx) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    const cacheKey = new Request(`https://douban-search-cache.local/?q=${encodeURIComponent(query)}`);
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: newHeaders
        });
    }

    try {
        const res = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: DOUBAN_SEARCH_HEADERS
        });

        if (!res.ok) {
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        const text = await res.text();
        const data = JSON.parse(text);

        const responseToCache = jsonResponse(data);
        responseToCache.headers.set('Cache-Control', 'public, max-age=86400');
        ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

        return jsonResponse(data);
    } catch (e) {
        console.error("Douban search error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleDoubanDetail(id, ctx) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    const cacheKey = new Request(`https://douban-detail-cache.local/?id=${id}`);
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: newHeaders
        });
    }

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetch(fetchUrl, {
            headers: getDoubanDetailHeaders(),
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
                text(text) { if (isParsingSummary) result.summary += text.text; }
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

        const responseToCache = jsonResponse(result);
        responseToCache.headers.set('Cache-Control', 'public, max-age=86400');
        ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

        return jsonResponse(result);
    } catch (e) {
        console.error("Douban detail error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

const QUARK_URL_PATTERN = /https?:\/\/(?:pan|drive)\.quark\.cn\/[^\s"'<>）)\u4e00-\u9fa5]+/gi;
const QUARK_SHORT_PATTERN = /(?:pan|drive)\.quark\.cn\/[^\s"'<>）)\u4e00-\u9fa5]+/gi;

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

    for (const pattern of [QUARK_URL_PATTERN, QUARK_SHORT_PATTERN]) {
        const found = text.match(pattern) || [];
        for (const item of found) {
            const url = normalizeQuarkUrl(item);
            if (url) matches.add(url);
        }
    }

    return Array.from(matches);
}

async function fetchResourcePageQuarkUrls(resourceUrl, resourceTitle) {
    try {
        const res = await fetch(resourceUrl, {
            headers: {
                "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer": "https://by669.org/"
            },
            redirect: "follow"
        });

        if (!res.ok) return [];

        const text = await res.text();
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

async function handleResourceSearch(query, ctx) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    const cacheKey = new Request(`https://resource-search-cache.local/?q=${encodeURIComponent(query)}`);
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: newHeaders
        });
    }

    try {
        const res = await fetch(`https://by669.org/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] }
        });

        if (!res.ok) {
            return jsonResponse({ error: `By669 rejected with status ${res.status}` }, res.status);
        }

        const data = await res.json();
        const resources = [];

        for (const item of data.data || []) {
            if (!item.attributes || !item.attributes.title) continue;

            resources.push({
                title: item.attributes.title,
                url: `https://by669.org/d/${item.id}`,
                isQuark: item.attributes.title.includes('夸') || item.attributes.title.toLowerCase().includes('quark')
            });
        }

        const quarkUrls = [];
        const seenQuarkUrls = new Set();
        const batchSize = 5;

        const maxPages = Math.min(resources.length, 10);
        for (let index = 0; index < maxPages; index += batchSize) {
            const batch = resources.slice(index, Math.min(index + batchSize, maxPages));
            const quarkUrlGroups = await Promise.allSettled(
                batch.map(entry => fetchResourcePageQuarkUrls(entry.url, entry.title))
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

        const result = { resources, quarkUrls };
        const responseToCache = jsonResponse(result);
        responseToCache.headers.set('Cache-Control', 'public, max-age=43200');
        if (ctx) ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

        return jsonResponse(result);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleOmdbById(imdbId, env, ctx) {
    const cacheKey = new Request(`https://omdb-cache.local/id/${imdbId}`);
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: newHeaders
        });
    }

    try {
        const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${getOmdbApiKey(env)}`);

        if (!res.ok) {
            return jsonResponse({ error: `OMDb rejected with status ${res.status}` }, res.status);
        }

        const data = await res.json();

        if (data.Response === "True") {
            const responseToCache = jsonResponse(extractOmdbProfile(data));
            responseToCache.headers.set('Cache-Control', 'public, max-age=86400');
            if (ctx) ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
            return jsonResponse(extractOmdbProfile(data));
        }
        return jsonResponse({ error: "OMDb: Not found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleOmdbSearch(title, year, env, ctx) {
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    const cacheKey = new Request(`https://omdb-cache.local/search/?t=${encodeURIComponent(title)}&y=${year || ''}`);
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: newHeaders
        });
    }

    try {
        let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`;
        if (year) url += `&y=${year}`;

        const res = await fetch(url);

        if (!res.ok) {
            return jsonResponse({ error: `OMDb rejected with status ${res.status}` }, res.status);
        }

        const data = await res.json();

        if (data.Response === "True") {
            const responseToCache = jsonResponse(extractOmdbProfile(data));
            responseToCache.headers.set('Cache-Control', 'public, max-age=86400');
            if (ctx) ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
            return jsonResponse(extractOmdbProfile(data));
        }

        if (year) {
            const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`);
            const fallbackData = await fallbackRes.json();
            if (fallbackData.Response === "True") {
                const responseToCache = jsonResponse(extractOmdbProfile(fallbackData));
                responseToCache.headers.set('Cache-Control', 'public, max-age=86400');
                if (ctx) ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
                return jsonResponse(extractOmdbProfile(fallbackData));
            }
        }

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
        const tmdbPromise = tryTmdbForPoster(title, year, env, ctx);
        const omdbPromise = tryOmdbForPoster(title, year, env);

        const tmdbPoster = await tmdbPromise;
        if (tmdbPoster) {
            const omdbProfile = await omdbPromise.catch(() => null);
            return jsonResponse({
                ...tmdbPoster,
                omdb: omdbProfile
            });
        }

        let result = await omdbPromise;
        if (result) return jsonResponse(result);

        const enTitle = await getEnglishTitleFromWiki(title);
        if (enTitle && enTitle !== title) {
            result = await tryOmdbForPoster(enTitle, year, env);
            if (result) return jsonResponse(result);
        }

        return jsonResponse({ error: "No poster found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function tryTmdbForPoster(title, year, env, ctx) {
    try {
        const searchData = await fetchTmdbJson("/search/multi", {
            query: title,
            language: "zh-CN",
            include_adult: "false",
            page: "1"
        }, env, ctx);

        const candidates = (searchData.results || [])
            .filter(item => (item.media_type === "movie" || item.media_type === "tv") && item.poster_path)
            .map(normalizeTmdbItem)
            .filter(item => !year || item.year === year || String(item.year || "").startsWith(year));

        if (candidates.length === 0) return null;

        const best = candidates[0];
        return {
            poster: best.poster,
            tmdbRating: best.tmdbRating,
            tmdbVotes: best.tmdbVotes,
            rottenTomatoes: null,
            tmdb: true,
            tmdbId: best.id,
            mediaType: best.mediaType
        };
    } catch (e) {
        return null;
    }
}

async function tryOmdbForPoster(title, year, env) {
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`;
    if (year) url += `&y=${year}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();

    if (data.Response === "True" && data.Poster && data.Poster !== "N/A") {
        return extractOmdbProfile(data);
    }

    if (year) {
        const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`);
        if (!fallbackRes.ok) return null;

        const fallbackData = await fallbackRes.json();
        if (fallbackData.Response === "True" && fallbackData.Poster && fallbackData.Poster !== "N/A") {
            return extractOmdbProfile(fallbackData);
        }
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
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: newHeaders
        });
    }

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

        const responseToCache = jsonResponse(result);
        responseToCache.headers.set('Cache-Control', 'public, max-age=86400');
        if (ctx) ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

        return jsonResponse(result);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}
