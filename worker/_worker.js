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
            return await handleTmdbSearch(url.searchParams.get("q"), env);
        }

        if (url.pathname.startsWith("/api/tmdb/detail")) {
            return await handleTmdbDetail(
                url.searchParams.get("id"),
                url.searchParams.get("type"),
                env
            );
        }

        if (url.pathname.startsWith("/api/douban/search")) {
            return await handleDoubanSearch(url.searchParams.get("q"));
        }

        if (url.pathname.startsWith("/api/douban/detail")) {
            return await handleDoubanDetail(url.searchParams.get("id"));
        }

        if (url.pathname.startsWith("/api/resource")) {
            return await handleResourceSearch(url.searchParams.get("q"));
        }

        if (url.pathname.startsWith("/api/omdb")) {
            const imdbId = url.searchParams.get("imdb");
            if (imdbId) {
                return await handleOmdbById(imdbId, env);
            }
            return await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"), env);
        }

        if (url.pathname.startsWith("/api/poster")) {
            return await handlePosterSearch(url.searchParams.get("title"), url.searchParams.get("year"), env);
        }

        if (url.pathname.startsWith("/api/wiki/zh")) {
            return await handleWikiZh(url.searchParams.get("q"));
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
        tmdbRating: data.vote_average ?? null,
        tmdbVotes: data.vote_count ?? 0,
        imdbId: data.external_ids && data.external_ids.imdb_id ? data.external_ids.imdb_id : null,
        popularity: data.popularity ?? 0
    };
}

async function fetchTmdbJson(path, params, env) {
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

    const headers = {
        "Accept": "application/json"
    };

    if (auth.type === "bearer") {
        headers.Authorization = `Bearer ${auth.value}`;
    } else {
        url.searchParams.set("api_key", auth.value);
    }

    const res = await fetch(url.toString(), { headers });

    const data = await res.json();
    if (!res.ok) {
        const message = data && data.status_message ? data.status_message : `TMDB HTTP ${res.status}`;
        throw new Error(message);
    }

    return data;
}

async function handleTmdbSearch(query, env) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const data = await fetchTmdbJson("/search/multi", {
            query,
            language: "zh-CN",
            include_adult: "false",
            page: "1"
        }, env);

        const results = (data.results || [])
            .filter(item => item.media_type === "movie" || item.media_type === "tv")
            .map(normalizeTmdbItem)
            .sort((a, b) => (b.tmdbVotes || 0) - (a.tmdbVotes || 0) || (b.popularity || 0) - (a.popularity || 0));

        return jsonResponse({
            page: data.page || 1,
            totalResults: data.total_results || results.length,
            results
        });
    } catch (e) {
        console.error("TMDB search error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleTmdbDetail(id, type, env) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    const apiType = type === "tv" ? "tv" : "movie";
    const attemptOrder = apiType === "tv" ? ["tv", "movie"] : ["movie", "tv"];
    let lastError = null;

    for (const candidateType of attemptOrder) {
        try {
            const data = await fetchTmdbJson(`/${candidateType}/${id}`, {
                language: "zh-CN",
                append_to_response: "external_ids"
            }, env);

            return jsonResponse(normalizeTmdbDetail(data, candidateType));
        } catch (e) {
            lastError = e;
        }
    }

    return jsonResponse({ error: lastError ? lastError.message : "TMDB detail not found" }, 500);
}

const DOUBAN_SEARCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://movie.douban.com/"
};

const DOUBAN_DETAIL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://movie.douban.com/",
    "Cookie": "bid=xOqR3l3nZzE; __utmc=30149280"
};

async function handleDoubanSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: DOUBAN_SEARCH_HEADERS
        });
        const text = await res.text();
        const data = JSON.parse(text);
        return jsonResponse(data);
    } catch (e) {
        console.error("Douban search error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleDoubanDetail(id) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

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

        return jsonResponse(result);
    } catch (e) {
        console.error("Douban detail error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleResourceSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://by669.org/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] }
        });

        const data = await res.json();
        const links = (data.data || [])
            .filter(item => item.attributes && item.attributes.title)
            .map(item => ({
                title: item.attributes.title,
                url: `https://by669.org/d/${item.id}`,
                isQuark: item.attributes.title.includes('夸') || item.attributes.title.toLowerCase().includes('quark')
            }));

        return jsonResponse(links);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleOmdbById(imdbId, env) {
    try {
        const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${getOmdbApiKey(env)}`);
        const data = await res.json();

        if (data.Response === "True") {
            return jsonResponse(extractOmdbRatings(data));
        }
        return jsonResponse({ error: "OMDb: Not found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleOmdbSearch(title, year, env) {
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    try {
        let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`;
        if (year) url += `&y=${year}`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.Response === "True") {
            return jsonResponse(extractOmdbRatings(data));
        }

        if (year) {
            const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`);
            const fallbackData = await fallbackRes.json();
            if (fallbackData.Response === "True") {
                return jsonResponse(extractOmdbRatings(fallbackData));
            }
        }

        return jsonResponse({ error: "Not found on OMDb" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

function extractOmdbRatings(data) {
    const imdb = data.imdbRating && data.imdbRating !== "N/A" ? parseFloat(data.imdbRating) : null;
    let rotten = null;

    if (data.Ratings) {
        const rTomato = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
        if (rTomato) {
            rotten = parseInt(rTomato.Value.replace('%', ''));
        }
    }

    return {
        imdb,
        imdbVotes: data.imdbVotes,
        rottenTomatoes: rotten,
        poster: data.Poster && data.Poster !== "N/A" ? data.Poster : null
    };
}

async function handlePosterSearch(title, year, env) {
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    try {
        const tmdbPoster = await tryTmdbForPoster(title, year, env);
        if (tmdbPoster) return jsonResponse(tmdbPoster);

        let result = await tryOmdbForPoster(title, year, env);
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

async function tryTmdbForPoster(title, year, env) {
    try {
        const searchData = await fetchTmdbJson("/search/multi", {
            query: title,
            language: "zh-CN",
            include_adult: "false",
            page: "1"
        }, env);

        const candidates = (searchData.results || [])
            .filter(item => (item.media_type === "movie" || item.media_type === "tv") && item.poster_path)
            .map(normalizeTmdbItem)
            .filter(item => !year || item.year === year || String(item.year || "").startsWith(year));

        if (candidates.length === 0) return null;

        const best = candidates[0];
        return {
            poster: best.poster,
            imdb: best.tmdbRating,
            imdbVotes: best.tmdbVotes,
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
    const data = await res.json();

    if (data.Response === "True" && data.Poster && data.Poster !== "N/A") {
        return {
            poster: data.Poster,
            imdb: data.imdbRating && data.imdbRating !== "N/A" ? parseFloat(data.imdbRating) : null,
            imdbVotes: data.imdbVotes,
            rottenTomatoes: extractRottenTomato(data.Ratings),
            imdbId: data.imdbID
        };
    }

    if (year) {
        const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${getOmdbApiKey(env)}`);
        const fallbackData = await fallbackRes.json();
        if (fallbackData.Response === "True" && fallbackData.Poster && fallbackData.Poster !== "N/A") {
            return {
                poster: fallbackData.Poster,
                imdb: fallbackData.imdbRating && fallbackData.imdbRating !== "N/A" ? parseFloat(fallbackData.imdbRating) : null,
                imdbVotes: fallbackData.imdbVotes,
                rottenTomatoes: extractRottenTomato(fallbackData.Ratings),
                imdbId: fallbackData.imdbID
            };
        }
    }

    return null;
}

async function getEnglishTitleFromWiki(zhTitle) {
    try {
        const searchRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(zhTitle)}&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const searchData = await searchRes.json();

        if (!searchData.query || !searchData.query.search.length) return null;

        const title = searchData.query.search[0].title;

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

function extractRottenTomato(ratings) {
    if (!ratings) return null;
    const rTomato = ratings.find(r => r.Source === "Rotten Tomatoes");
    return rTomato ? parseInt(rTomato.Value.replace('%', '')) : null;
}

async function handleWikiZh(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const searchRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const searchData = await searchRes.json();

        if (!searchData.query || !searchData.query.search.length) {
            return jsonResponse({ error: "Not found on zh.wikipedia" }, 404);
        }

        const title = searchData.query.search[0].title;

        const summaryRes = await fetch(
            `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const summaryData = await summaryRes.json();

        return jsonResponse({
            title: summaryData.title,
            extract: summaryData.extract,
            thumbnail: summaryData.thumbnail || null
        });
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}
