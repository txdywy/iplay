/**
 * Poster lookup for a confirmed TMDB work.
 */

import {
    MAX_MEDIA_TITLE_LENGTH,
    cacheJson,
    createDeadline,
    errorResponse,
    isObject,
    jsonResponse,
    serveCachedJson,
    validateImdbId,
    validateOptionalYear,
    validatePositiveInteger,
    validateRequiredText,
    withInFlight
} from './core.js';
import {
    fetchTmdbJson,
    getTmdbAuth,
    getTmdbYear,
    normalizeTmdbDetail,
    normalizeTmdbItem,
    pickBestTmdbPosterCandidate,
    tmdbImage,
    validatePersonMediaType
} from './tmdb.js';

const POSTER_TOTAL_TIMEOUT_MS = 15000;

export async function handlePosterSearch(title, year, env, ctx, { refresh = false, tmdbId = null, mediaType = null, imdbId = null } = {}) {
    const titleCheck = validateRequiredText(title, "title", MAX_MEDIA_TITLE_LENGTH);
    if (titleCheck.error) return titleCheck.error;
    title = titleCheck.value;

    const yearCheck = validateOptionalYear(year);
    if (yearCheck.error) return yearCheck.error;
    year = yearCheck.value;

    const identity = { tmdbId: null, mediaType: null, imdbId: null };
    if (tmdbId !== null || mediaType !== null) {
        const idCheck = validatePositiveInteger(tmdbId);
        if (idCheck.error) return idCheck.error;
        const typeCheck = validatePersonMediaType(mediaType);
        if (typeCheck.error) return typeCheck.error;
        if (!typeCheck.value) return jsonResponse({ error: "Missing media type" }, 400);
        identity.tmdbId = Number(idCheck.value);
        identity.mediaType = typeCheck.value;
    }
    if (imdbId !== null) {
        const imdbCheck = validateImdbId(imdbId);
        if (imdbCheck.error) return imdbCheck.error;
        if (!identity.tmdbId) return jsonResponse({ error: "Missing TMDB identity" }, 400);
        identity.imdbId = imdbCheck.value;
    }

    const response = await withInFlight(
        ctx,
        `poster:${refresh ? "refresh:" : ""}${title}:${year}:${JSON.stringify(identity)}`,
        () => handlePosterSearchUncoalesced(title, year, env, ctx, { refresh, identity })
    );
    return response.clone();
}

async function handlePosterSearchUncoalesced(title, year, env, ctx, { refresh = false, identity } = {}) {
    const titleCheck = validateRequiredText(title, "title", MAX_MEDIA_TITLE_LENGTH);
    if (titleCheck.error) return titleCheck.error;
    title = titleCheck.value;

    const yearCheck = validateOptionalYear(year);
    if (yearCheck.error) return yearCheck.error;
    year = yearCheck.value;

    if (!getTmdbAuth(env)) return jsonResponse({ error: "TMDB is not configured" }, 503);
    const cacheKey = new Request(`https://poster-v6-cache.local/?title=${encodeURIComponent(title)}&year=${year}&id=${identity.tmdbId || ""}&type=${identity.mediaType || ""}&imdb=${identity.imdbId || ""}`);
    const cached = refresh ? null : await serveCachedJson(cacheKey);
    if (cached) return cached;
    try {
        const result = await tryTmdbForPoster(title, year, env, ctx, createDeadline(POSTER_TOTAL_TIMEOUT_MS), { refreshCache: refresh, identity });
        return result ? cacheJson(ctx, cacheKey, result, 86400) : jsonResponse({ error: "No poster found" }, 404);
    } catch (error) {
        return errorResponse(error);
    }
}

async function tryTmdbForPoster(title, year, env, ctx, deadline = null, { refreshCache = false, identity = {} } = {}) {
    if (identity.tmdbId) {
        const data = await fetchTmdbJson(`/${identity.mediaType}/${identity.tmdbId}`, {
            language: "zh-CN", append_to_response: "external_ids,credits"
        }, env, ctx, { deadline, refreshCache });
        const detail = normalizeTmdbDetail(data, identity.mediaType);
        if (identity.imdbId && detail.imdbId && identity.imdbId !== detail.imdbId) return null;
        return detail.poster ? {
            poster: detail.poster, tmdbRating: detail.tmdbRating, tmdbVotes: detail.tmdbVotes,
            tmdb: true, tmdbId: detail.id, mediaType: detail.mediaType
        } : null;
    }
    let searchData = await fetchTmdbJson("/search/multi", {
        query: title,
        language: "zh-CN",
        include_adult: "false",
        page: "1"
    }, env, ctx, { deadline, refreshCache });

    let candidates = Array.isArray(searchData.results)
        ? searchData.results.filter(item => isObject(item) && (!year || getTmdbYear(item) === String(year)))
        : [];
    let bestRaw = pickBestTmdbPosterCandidate(candidates, title, year);

    if (!bestRaw) {
        searchData = await fetchTmdbJson("/search/multi", {
            query: title,
            language: "en-US",
            include_adult: "false",
            page: "1"
        }, env, ctx, { deadline, refreshCache });
        candidates = Array.isArray(searchData.results)
            ? searchData.results.filter(item => isObject(item) && (!year || getTmdbYear(item) === String(year)))
            : [];
        bestRaw = pickBestTmdbPosterCandidate(candidates, title, year);
    }

    if (!bestRaw) return null;

    const best = normalizeTmdbItem(bestRaw);
    if (!best) return null;
    return {
        poster: tmdbImage(bestRaw.poster_path),
        tmdbRating: best.tmdbRating,
        tmdbVotes: best.tmdbVotes,
        tmdb: true,
        tmdbId: best.id,
        mediaType: best.mediaType
    };
}
