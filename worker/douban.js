/**
 * Douban search and detail enrichment, with a circuit for blocked detail pages.
 */

import {
    MAX_MEDIA_TITLE_LENGTH,
    MAX_QUERY_LENGTH,
    UPSTREAM_TIMEOUT_MS,
    cacheJson,
    compactSearchText,
    createHttpError,
    decodeHtmlEntities,
    deleteCachedResponse,
    errorResponse,
    fetchUpstream,
    isChallengePage,
    isDeadlineExpired,
    isObject,
    jsonResponse,
    logErrorMessage,
    logEvent,
    readJsonWithLimit,
    readTextWithLimit,
    releaseUpstreamResponse,
    remainingDeadlineMs,
    scheduleCachePut,
    serveCachedJson,
    uniqueSearchValues,
    validatePositiveInteger,
    validateRequiredText
} from './core.js';
import {
    SEARCH_MAX_ALIAS_QUERIES,
    scoreSearchText
} from './tmdb.js';

export const DOUBAN_SEARCH_HEADERS = {
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

export async function handleDoubanSearch(query, ctx) {
    const queryCheck = validateRequiredText(query, "query", MAX_MEDIA_TITLE_LENGTH);
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const cacheKey = new Request(`https://douban-search-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const data = await fetchDoubanSuggestions(query);
        return cacheJson(ctx, cacheKey, data, getDoubanSuggestionMaxAge(data));
    } catch (e) {
        logEvent("error", "douban_search_failed", { error: logErrorMessage(e) });
        return errorResponse(e);
    }
}

// A newly announced title may have no suggestions yet; recheck it sooner.
function getDoubanSuggestionMaxAge(data) {
    return data.length ? 86400 : 3600;
}

async function fetchDoubanSuggestions(query, deadline = null) {
    const res = await fetchUpstream(
        `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`,
        { headers: DOUBAN_SEARCH_HEADERS },
        remainingDeadlineMs(deadline, UPSTREAM_TIMEOUT_MS)
    );

    if (!res.ok) {
        await releaseUpstreamResponse(res);
        // Douban blocking or throttling the Worker is a temporary outage for the visitor.
        if (res.status === 403 || res.status === 429) {
            throw createHttpError(`Douban rejected with status ${res.status}`, 503, "Douban unavailable");
        }
        throw createHttpError(`Douban rejected with status ${res.status}`, res.status, `Douban rejected with status ${res.status}`);
    }

    // A followed redirect to Douban's verification page arrives as HTML with 200.
    const body = await readTextWithLimit(res);
    if (isChallengePage(body)) throw createHttpError("Douban search returned a challenge page", 503, "Douban unavailable");
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw createHttpError("Douban returned an invalid response", 502);
    }
    if (!Array.isArray(data)) throw createHttpError("Douban returned an invalid response", 502);
    return data;
}

export async function fetchDoubanAliasCandidates(query, ctx, deadline = null) {
    const cacheKey = new Request(`https://douban-search-cache.local/?q=${encodeURIComponent(query)}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) {
        try {
            const cachedData = await readJsonWithLimit(cached);
            return Array.isArray(cachedData) ? cachedData : [];
        } catch {
            await deleteCachedResponse(cacheKey);
        }
    }

    if (isDeadlineExpired(deadline)) throw createHttpError("Upstream request timed out", 504);
    const data = await fetchDoubanSuggestions(query, deadline);

    const cacheResponse = new Response(JSON.stringify(data), {
        status: 200,
        headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "Cache-Control": `public, max-age=${getDoubanSuggestionMaxAge(data)}`
        }
    });
    scheduleCachePut(ctx, cacheKey, cacheResponse);
    return data;
}

export function extractDoubanAliasQueries(data, originalQuery, year) {
    if (!Array.isArray(data)) return [];
    const original = compactSearchText(originalQuery);
    const aliases = [];
    const fields = ["title", "original_title", "name", "sub_title", "aka"];

    for (const item of data.slice(0, 10)) {
        if (!isObject(item)) continue;
        // Suggestions are not exact matches. Only use aliases belonging to a
        // title that already matches the query and its requested year.
        if (scoreSearchText(originalQuery, item.title) < 0.86) continue;
        if (year && String(item.year || "") !== year) continue;
        for (const field of fields) {
            const value = item[field];
            if (typeof value !== "string" || !value.trim()) continue;
            if (compactSearchText(value) === original) continue;
            aliases.push(value);
        }
    }

    return uniqueSearchValues(aliases, MAX_QUERY_LENGTH, SEARCH_MAX_ALIAS_QUERIES);
}

// Douban rejects Worker requests for subject pages with 403 or a challenge.
// Respect the block: remember it briefly so later views fail fast instead of
// spending another upstream request on every detail page.
const DOUBAN_BLOCK_TTL_SECONDS = 1800;

const doubanBlockKey = () => new Request("https://douban-detail-cache.local/blocked");

function doubanUnavailableResponse() {
    return jsonResponse({ error: "Douban detail temporarily unavailable" }, 503, {
        "Retry-After": String(DOUBAN_BLOCK_TTL_SECONDS)
    });
}

function markDoubanBlocked(ctx, reason) {
    logEvent("warn", "douban_detail_blocked", { reason });
    cacheJson(ctx, doubanBlockKey(), { blocked: true }, DOUBAN_BLOCK_TTL_SECONDS);
    return doubanUnavailableResponse();
}

export async function handleDoubanDetail(id, ctx) {
    const idCheck = validatePositiveInteger(id);
    if (idCheck.error) return idCheck.error;
    id = idCheck.value;

    const cacheKey = new Request(`https://douban-detail-cache.local/?id=${id}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;
    if (await serveCachedJson(doubanBlockKey())) return doubanUnavailableResponse();

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetchUpstream(fetchUrl, {
            headers: DOUBAN_DETAIL_HEADERS,
            redirect: "follow"
        });

        if (!res.ok) {
            logEvent("warn", "douban_detail_rejected", { id, status: res.status });
            await releaseUpstreamResponse(res);
            if (res.status === 403 || res.status === 429) return markDoubanBlocked(ctx, `status_${res.status}`);
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        const result = {
            rating: 0,
            votes: 0,
            genres: [],
            summary: "",
            imdbId: ""
        };
        let ratingText = "";
        let votesText = "";
        let genreIndex = -1;

        const rewriter = new HTMLRewriter()
            .on('strong[property="v:average"]', {
                text(text) { ratingText += text.text; }
            })
            .on('span[property="v:votes"]', {
                text(text) { votesText += text.text; }
            })
            .on('span[property="v:genre"]', {
                element() { genreIndex = result.genres.push("") - 1; },
                text(text) { if (genreIndex >= 0) result.genres[genreIndex] += text.text; }
            })
            .on('span[property="v:summary"]', {
                text(text) { result.summary += text.text; }
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

        const html = await readTextWithLimit(res);
        if (isChallengePage(html) || /<title>\s*(?:禁止访问|登录跳转)[^<]*<\/title>/iu.test(html.slice(0, 4096))) {
            return markDoubanBlocked(ctx, "challenge");
        }
        await rewriter.transform(new Response(html)).text();
        result.rating = parseFloat(ratingText.trim()) || 0;
        result.votes = parseInt(votesText.trim(), 10) || 0;
        // HTMLRewriter text chunks are raw markup text; entities are not decoded.
        result.genres = [...new Set(result.genres.map(genre => decodeHtmlEntities(genre).trim()).filter(Boolean))];
        result.summary = decodeHtmlEntities(result.summary).replace(/\s+/g, ' ').trim();
        if (!result.rating && !result.votes && result.genres.length === 0 && !result.summary && !result.imdbId) {
            throw createHttpError("Douban returned an invalid detail page", 502);
        }

        return cacheJson(ctx, cacheKey, result, 86400);
    } catch (e) {
        logEvent("error", "douban_detail_failed", { error: logErrorMessage(e) });
        return errorResponse(e);
    }
}
