/**
 * TMDB access, search intent and ranking, detail and person lookups.
 */

import {
    FALLBACK_TOTAL_TIMEOUT_MS,
    MAX_QUERY_LENGTH,
    UPSTREAM_TIMEOUT_MS,
    compactSearchText,
    createDeadline,
    createHttpError,
    deleteCachedResponse,
    errorResponse,
    fetchUpstream,
    isDeadlineExpired,
    isObject,
    jsonResponse,
    logErrorMessage,
    logEvent,
    normalizeMatchText,
    normalizeSearchInput,
    readJsonWithLimit,
    releaseUpstreamResponse,
    remainingDeadlineMs,
    scheduleCachePut,
    serveCachedJson,
    uniqueSearchValues,
    validateMediaType,
    validatePositiveInteger,
    validateRequiredText,
    withInFlight
} from './core.js';
import {
    extractDoubanAliasQueries,
    fetchDoubanAliasCandidates
} from './douban.js';

const TMDB_BASE = "https://api.themoviedb.org/3";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

const TMDB_POSTER_SIZE = "w500";

const SEARCH_MAX_ATTEMPTS = 6;

const SEARCH_MAX_RESULTS = 20;

export const SEARCH_MAX_ALIAS_QUERIES = 2;

const SEARCH_SCORE_CACHE_MAX_PAIRS = 1024;

const TMDB_ANIMATION_GENRE_ID = 16;

const PERSON_DEFAULT_PAGE_SIZE = 36;

const PERSON_MAX_PAGE_SIZE = 60;

const SEARCH_ACCEPT_SCORE = 0.72;

const SEARCH_AUTO_MATCH_SCORE = 0.56;

// The page asks before opening a title this close to the runner-up.
const SEARCH_CLOSE_MATCH_GAP = 0.08;

// A search answer carries the TMDB answer the page requests next when that
// lookup finishes within this extra wait and the search deadline.
const SEARCH_PREFETCH_WAIT_MS = 1500;

const SEARCH_PREFETCH_MIN_WAIT_MS = 250;

// Complete TMDB answers are deterministic for a release-tagged client URL.
// Let browsers reuse them briefly for history navigation; failures and
// degraded fallbacks keep the jsonResponse default of no-store.
const TMDB_BROWSER_CACHE_HEADERS = Object.freeze({ "Cache-Control": "public, max-age=300" });

export function getTmdbAuth(env) {
    if (env && env.TMDB_ACCESS_TOKEN) {
        return { type: "bearer", value: env.TMDB_ACCESS_TOKEN };
    }
    if (env && env.TMDB_API_KEY) {
        return { type: "api_key", value: env.TMDB_API_KEY };
    }
    return null;
}

export function tmdbImage(path, size = TMDB_POSTER_SIZE) {
    return typeof path === "string" && path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

function parseYear(date) {
    return typeof date === "string" && date ? date.slice(0, 4) : null;
}

function toSafeTmdbId(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string") {
        const text = value.trim();
        if (!/^\d+$/.test(text)) return null;
        value = text;
    }
    const id = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function toFiniteMetric(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value !== "number" && typeof value !== "string") return fallback;
    const metric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(metric) ? metric : fallback;
}

function pickTmdbText(...values) {
    return values.find(value => typeof value === "string" && value.trim())?.trim() || "";
}

function getTmdbMediaType(item, mediaTypeOverride = null) {
    const mediaType = mediaTypeOverride || item?.media_type;
    return mediaType === "movie" || mediaType === "tv" ? mediaType : null;
}

function getTmdbTitle(item, mediaTypeOverride = null) {
    const type = getTmdbMediaType(item, mediaTypeOverride);
    if (type) return pickTmdbText(type === "movie" ? item?.title : item?.name);
    return pickTmdbText(item?.title, item?.name);
}

function getTmdbOriginalTitle(item, mediaTypeOverride = null) {
    const type = getTmdbMediaType(item, mediaTypeOverride);
    if (type) return pickTmdbText(type === "movie" ? item?.original_title : item?.original_name, getTmdbTitle(item, type));
    return pickTmdbText(item?.original_title, item?.original_name, getTmdbTitle(item));
}

export function getTmdbYear(item, mediaTypeOverride = null) {
    const type = getTmdbMediaType(item, mediaTypeOverride);
    return parseYear(type === "movie" ? item?.release_date : type === "tv" ? item?.first_air_date
        : item?.release_date || item?.first_air_date);
}

function isValidTmdbSearchItem(item, mediaTypeOverride = null) {
    return isObject(item)
        && toSafeTmdbId(item.id) !== null
        && getTmdbMediaType(item, mediaTypeOverride) !== null
        && Boolean(getTmdbTitle(item, mediaTypeOverride));
}

export function normalizeTmdbItem(item, mediaTypeOverride = null, match = null) {
    if (!isValidTmdbSearchItem(item, mediaTypeOverride)) return null;

    const title = getTmdbTitle(item, mediaTypeOverride);
    const originalTitle = getTmdbOriginalTitle(item, mediaTypeOverride);
    const normalized = {
        id: toSafeTmdbId(item.id),
        mediaType: getTmdbMediaType(item, mediaTypeOverride),
        title,
        originalTitle,
        year: getTmdbYear(item, mediaTypeOverride),
        poster: tmdbImage(item.poster_path),
        backdrop: tmdbImage(item.backdrop_path, "w780"),
        summary: typeof item.overview === "string" ? item.overview : "",
        tmdbRating: toFiniteMetric(item.vote_average),
        tmdbVotes: Math.max(0, Math.floor(toFiniteMetric(item.vote_count, 0))),
        popularity: Math.max(0, toFiniteMetric(item.popularity, 0)),
        imdbId: null
    };

    if (match) {
        normalized.matchScore = Number(match.score.toFixed(3));
        normalized.matchConfidence = match.confidence;
        normalized.matchMethod = match.method;
    }

    return normalized;
}

function toNonNegativeInteger(value) {
    const numericValue = toFiniteMetric(value);
    return Number.isSafeInteger(numericValue) && numericValue >= 0 ? numericValue : null;
}

function normalizeTmdbSeasons(data, type) {
    if (type !== "tv" || !Array.isArray(data.seasons)) return [];

    const seenSeasonNumbers = new Set();
    const seasons = [];

    for (const season of data.seasons.filter(isObject).slice(0, 100)) {
        const seasonNumber = toNonNegativeInteger(season.season_number);
        if (seasonNumber === null || seenSeasonNumbers.has(seasonNumber)) continue;

        seenSeasonNumbers.add(seasonNumber);
        seasons.push({
            seasonNumber,
            name: pickTmdbText(season.name) || null,
            episodeCount: toNonNegativeInteger(season.episode_count)
        });
    }

    return seasons.sort((left, right) => left.seasonNumber - right.seasonNumber);
}

export function normalizeTmdbDetail(data, type) {
    if (!isObject(data)) return null;

    const isMovie = type === "movie";
    const title = pickTmdbText(isMovie ? data.title : data.name);
    const originalTitle = pickTmdbText(isMovie ? data.original_title : data.original_name, title);
    const year = parseYear(isMovie ? data.release_date : data.first_air_date);
    const credits = isObject(data.credits) ? data.credits : {};
    const castDetails = Array.isArray(credits.cast)
        ? credits.cast.filter(isObject).slice(0, 8).map(person => ({
            id: toSafeTmdbId(person.id),
            name: pickTmdbText(person.name),
            character: pickTmdbText(person.character) || null,
            profile: tmdbImage(person.profile_path, "w185")
        })).filter(person => person.name)
        : [];
    const cast = castDetails.map(person => person.name);
    const crew = Array.isArray(credits.crew) ? credits.crew.filter(isObject) : [];
    const director = new Set();
    const writer = new Set();

    for (const person of crew) {
        if (person.job === "Director") director.add(person.name);
        if (["Writer", "Screenplay", "Story"].includes(person.job)) writer.add(person.name);
    }

    const cleanDirector = [...director].filter(Boolean);
    const cleanWriter = [...writer].filter(Boolean);

    return {
        id: toSafeTmdbId(data.id),
        mediaType: type,
        title,
        originalTitle,
        year,
        poster: tmdbImage(data.poster_path),
        backdrop: tmdbImage(data.backdrop_path, "w780"),
        summary: typeof data.overview === "string" ? data.overview : "",
        genres: Array.isArray(data.genres) ? data.genres.filter(isObject).map(g => g.name).filter(name => typeof name === "string" && name.trim()).map(name => name.trim()) : [],
        runtime: type === "tv"
            ? (Array.isArray(data.episode_run_time)
                ? data.episode_run_time.map(value => toFiniteMetric(value)).find(value => value > 0) || null
                : null) || toFiniteMetric(data.last_episode_to_air?.runtime)
            : toFiniteMetric(data.runtime),
        status: typeof data.status === "string" ? data.status : null,
        originalLanguage: typeof data.original_language === "string" ? data.original_language : null,
        productionCompanies: Array.isArray(data.production_companies) ? data.production_companies.filter(isObject).map(c => c.name).filter(name => typeof name === "string" && name.trim()).map(name => name.trim()) : [],
        productionCountries: Array.isArray(data.production_countries) ? data.production_countries.filter(isObject).map(c => c.name).filter(name => typeof name === "string" && name.trim()).map(name => name.trim()) : [],
        cast,
        castDetails,
        director: cleanDirector,
        writer: cleanWriter,
        totalSeasons: type === "tv" ? toNonNegativeInteger(data.number_of_seasons) : null,
        totalEpisodes: type === "tv" ? toNonNegativeInteger(data.number_of_episodes) : null,
        seasons: normalizeTmdbSeasons(data, type),
        tmdbRating: toFiniteMetric(data.vote_average),
        tmdbVotes: Math.max(0, Math.floor(toFiniteMetric(data.vote_count, 0))),
        imdbId: typeof data.external_ids?.imdb_id === "string" ? data.external_ids.imdb_id : null,
        popularity: Math.max(0, toFiniteMetric(data.popularity, 0))
    };
}

function isValidTmdbPayload(path, data, params = {}) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (/^\/search\/(?:multi|movie|tv|person)$/.test(path)) return Array.isArray(data.results);
    if (/^\/find\/[^/]+$/.test(path)) return Array.isArray(data.movie_results) && Array.isArray(data.tv_results);
    if (/^\/(?:movie|tv)\/\d+$/.test(path)) {
        const appended = String(params.append_to_response || "").split(",");
        const title = path.startsWith("/movie/") ? data.title : data.name;
        return toSafeTmdbId(data.id) === Number(path.split("/").at(-1)) && Boolean(pickTmdbText(title))
            && (!appended.includes("external_ids") || isObject(data.external_ids))
            && (!appended.includes("credits") || (isObject(data.credits)
                && Array.isArray(data.credits.cast) && Array.isArray(data.credits.crew)));
    }
    if (/^\/person\/\d+$/.test(path)) {
        const expectsCredits = String(params.append_to_response || "").split(",").includes("combined_credits");
        return toSafeTmdbId(data.id) === Number(path.split("/").at(-1)) && Boolean(getTmdbPersonName(data))
            && (!expectsCredits || (isObject(data.combined_credits) && Array.isArray(data.combined_credits.cast)));
    }
    return true;
}

export async function fetchTmdbJson(path, params, env, ctx, options = {}) {
    const auth = getTmdbAuth(env);
    if (!auth) {
        throw createHttpError("Missing TMDB_ACCESS_TOKEN or TMDB_API_KEY", 503);
    }

    const keyUrl = new URL(`${TMDB_BASE}${path}`);
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            keyUrl.searchParams.set(key, value);
        }
    });
    const inFlightKey = `tmdb:${keyUrl.toString()}:${options.refreshCache ? "refresh" : "cached"}`;
    return withInFlight(ctx, inFlightKey, () => fetchTmdbJsonUncoalesced(path, params, env, ctx, options));
}

async function fetchTmdbJsonUncoalesced(path, params, env, ctx, options = {}) {
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

    const cachedResponse = options.refreshCache ? null : await serveCachedJson(cacheKey);
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

        if (isDeadlineExpired(options.deadline)) {
            throw createHttpError("Upstream request timed out", 504);
        }
        response = await fetchUpstream(
            url.toString(),
            // This compatibility target forwards Authorization when following
            // cross-origin redirects. TMDB API responses must come from this
            // exact endpoint, never a destination chosen by a Location header.
            { headers, redirect: "manual" },
            remainingDeadlineMs(options.deadline, UPSTREAM_TIMEOUT_MS)
        );
    }

    // Gate on HTTP status before parsing: gateways commonly return HTML or an
    // empty body for auth, rate-limit and outage errors. Those statuses still
    // control fallback/retry policy, and their bodies are never public data.
    if (!response.ok) {
        await releaseUpstreamResponse(response);
        if (cachedResponse) {
            await deleteCachedResponse(cacheKey);
            return fetchTmdbJsonUncoalesced(path, params, env, ctx, { ...options, refreshCache: true });
        }
        throw createHttpError(`TMDB HTTP ${response.status}`, response.status,
            response.status === 404 ? "TMDB resource not found" : "TMDB unavailable");
    }

    let data;
    try {
        data = await readJsonWithLimit(response);
    } catch (error) {
        if (cachedResponse) {
            await deleteCachedResponse(cacheKey);
            return fetchTmdbJsonUncoalesced(path, params, env, ctx, { ...options, refreshCache: true });
        }
        if (error.status) throw error;
        throw createHttpError("TMDB returned invalid JSON", 502);
    }

    if (!isValidTmdbPayload(path, data, params)) {
        if (cachedResponse) {
            await deleteCachedResponse(cacheKey);
            return fetchTmdbJsonUncoalesced(path, params, env, ctx, { ...options, refreshCache: true });
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
        scheduleCachePut(ctx, cacheKey, cacheResponse);
    }

    return data;
}

async function fetchTmdbSearch(query, language, env, ctx, options = {}) {
    return fetchTmdbJson("/search/multi", {
        query,
        language,
        include_adult: "false",
        page: "1"
    }, env, ctx, options);
}

async function fetchTmdbTypedSearch(mediaType, query, language, env, ctx, params = {}, options = {}) {
    return fetchTmdbJson(`/search/${mediaType}`, {
        query,
        language,
        include_adult: "false",
        page: "1",
        ...params
    }, env, ctx, options);
}

async function fetchTmdbFindByExternalId(externalId, language, env, ctx, options = {}) {
    return fetchTmdbJson(`/find/${encodeURIComponent(externalId)}`, {
        external_source: "imdb_id",
        language
    }, env, ctx, options);
}

async function fetchTmdbPersonSearch(query, language, env, ctx, options = {}) {
    return fetchTmdbJson("/search/person", {
        query,
        language,
        include_adult: "false",
        page: "1"
    }, env, ctx, options);
}

function parseChineseNumber(value) {
    if (!value) return null;
    if (/^\d+$/.test(value)) return Number(value);

    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units = { 十: 10, 百: 100, 千: 1000 };
    let total = 0;
    let current = 0;

    for (const character of value) {
        if (Object.prototype.hasOwnProperty.call(digits, character)) {
            current = current * 10 + digits[character];
            continue;
        }
        const unit = units[character];
        if (!unit) return null;
        total += (current || 1) * unit;
        current = 0;
    }

    const result = total + current;
    return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function extractSearchSeason(text) {
    // A bare "s" marker must not be part of a Latin word or possessive ("Ocean's 8"),
    // while Chinese titles commonly put the marker directly after the title ("庆余年S02").
    const match = text.match(/(?:(?:(?<![\p{L}\p{N}'’])|(?<=\p{Script=Han}))(?:s|season)\s*0*(\d{1,2})(?:\s*e\d{1,3})?\b|第\s*([0-9一二三四五六七八九十百两]+)\s*季)/iu);
    if (!match) return { value: null, match: "" };
    const value = parseChineseNumber(match[1] || match[2]);
    return value && value <= 99 ? { value, match: match[0] } : { value: null, match: "" };
}

function extractSearchYear(text) {
    const matches = [...text.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?=$|[^\d])/gu)];
    const match = matches.at(-1);
    if (!match || text.trim() === match[1]) return { value: null, match: "" };
    return { value: match[1], match: match[1] };
}

const SEARCH_RELEASE_NOISE_PATTERN = /(?:\b(?:2160p|1080p|720p|480p|4k|8k|web[- .]?(?:dl|rip)|blu?ray|brrip|dvdrip|hdtv|x26[45]|hevc|hdr10?|dolby(?:vision|atmos)?|proper|repack)\b|中字|双语|字幕|全集|完结|无删减|高清|高码)/giu;

const SEARCH_NOISE_PATTERN = new RegExp(`(?:${SEARCH_RELEASE_NOISE_PATTERN.source}|\\b(?:movie|film|tv|series|show)\\b|电影|电视剧|剧集|连续剧)`, "giu");

const SEARCH_ANIMATION_SUFFIX = /(?:动画片|动画版)$/u;

function hasCjkText(value) {
    return /\p{Script=Han}/u.test(value);
}

function cleanSearchTitle(text, seasonMatch, yearMatch, { keepTypeWords = false } = {}) {
    return normalizeSearchInput(text
        .replace(seasonMatch, " ")
        .replace(yearMatch, " ")
        .replace(keepTypeWords ? SEARCH_RELEASE_NOISE_PATTERN : SEARCH_NOISE_PATTERN, " ")
        .replace(/[()[\]{}【】（）]/gu, " ")
        .replace(/[._]+/gu, " ")
        .replace(/[-_:]+/gu, " ")
        .replace(/\s+/gu, " "));
}

function buildSearchIntent(query) {
    const originalQuery = normalizeSearchInput(query);
    const season = extractSearchSeason(originalQuery);
    const year = extractSearchYear(originalQuery);
    const mediaType = season.value || /(?:\b(?:tv|series|show)\b|电视剧|剧集|连续剧)/iu.test(originalQuery)
        ? "tv"
        : /(?:\b(?:movie|film)\b|电影)/iu.test(originalQuery)
            ? "movie"
            : null;
    // Words that implied the type, kept to recognize titles that contain them
    // ("The Truman Show", "电影世界") instead of filtering those works out.
    const typeWords = season.value ? []
        : Array.from(originalQuery.matchAll(/\b(?:tv|series|show|movie|film)\b|电视剧|剧集|连续剧|电影/giu), match => match[0].toLowerCase());
    const literalTitle = cleanSearchTitle(originalQuery, season.match, year.match, { keepTypeWords: true });
    const animationTitle = literalTitle.replace(SEARCH_ANIMATION_SUFFIX, "").trim();
    const animation = Boolean(animationTitle && animationTitle !== literalTitle);
    const searchTitle = animation ? animationTitle : literalTitle;
    const noiseCleanedTitle = cleanSearchTitle(originalQuery, season.match, year.match);
    const cleanedTitle = animation ? noiseCleanedTitle.replace(SEARCH_ANIMATION_SUFFIX, "").trim() : noiseCleanedTitle;
    const punctuationVariant = normalizeSearchInput(cleanedTitle.replace(/[‐‑‒–—]/gu, " "));
    const aliases = cleanedTitle
        .split(/\s*(?:\/|／|\||｜)\s*/u)
        .map(value => value.trim())
        .filter(value => [...value].length >= 2);
    const variants = uniqueSearchValues([literalTitle, searchTitle, cleanedTitle, punctuationVariant, ...aliases], MAX_QUERY_LENGTH, 6);
    const matchQueries = uniqueSearchValues([literalTitle, searchTitle, cleanedTitle, punctuationVariant, ...aliases, originalQuery], MAX_QUERY_LENGTH, 8);

    return {
        originalQuery,
        literalTitle,
        normalizedQuery: cleanedTitle || originalQuery,
        variants,
        matchQueries,
        year: year.value,
        season: season.value,
        mediaType,
        typeWords,
        animation,
        hasCjk: hasCjkText(originalQuery)
    };
}

function extractImdbIdFromQuery(query) {
    const match = normalizeSearchInput(query).match(/(?:^|[^a-z0-9])(tt\d{5,12})(?:$|[^a-z0-9])/iu);
    return match ? match[1].toLowerCase() : null;
}

function getLiteralSearchEvidence(titles, intent) {
    const original = compactSearchText(intent.originalQuery);
    const literal = compactSearchText(intent.literalTitle);
    let best = null;
    for (const title of titles) {
        const normalized = compactSearchText(title);
        if (normalized === original) return { title: intent.originalQuery, length: normalized.length, mediaType: null, animation: false, wholeQuery: true };
        const index = literal.indexOf(normalized);
        if (!normalized || index < 0 || (normalized.length < 3 && normalized !== literal)) continue;
        const rest = literal.slice(0, index) + literal.slice(index + normalized.length);
        if (rest && !/^(?:tvseries|television|series|show|tv|movies?|films?|电影|电视剧|剧集|连续剧|动画片|动画版)+$/u.test(rest)) continue;
        const television = /tv|television|series|show|电视剧|剧集|连续剧/u.test(rest);
        const movie = /movie|film|电影/u.test(rest);
        if (television && movie) continue;
        // Prefer the longest literal title before interpreting the remaining
        // type words, e.g. "电影少女" over "少女", or "Truman Show" over "Truman".
        if (!best || normalized.length > best.length) {
            best = {
                title,
                length: normalized.length,
                mediaType: television ? "tv" : movie ? "movie" : null,
                animation: /动画片|动画版/u.test(rest),
                wholeQuery: false
            };
        }
    }
    return best;
}

function editSimilarity(left, right) {
    const source = Array.from(left);
    const target = Array.from(right);
    if (!source.length || !target.length || source.length > 100 || target.length > 100) return 0;

    let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let row = 1; row <= source.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= target.length; column += 1) {
            const substitution = previous[column - 1] + (source[row - 1] === target[column - 1] ? 0 : 1);
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                substitution
            );
        }
        previous = current;
    }

    return Math.max(0, 1 - previous[target.length] / Math.max(source.length, target.length));
}

export function scoreSearchText(query, candidate) {
    const normalizedQuery = compactSearchText(query);
    const normalizedCandidate = compactSearchText(candidate);
    if (!normalizedQuery || !normalizedCandidate) return 0;
    if (normalizedQuery === normalizedCandidate) return 1;
    if (normalizedQuery.length < 3 || normalizedCandidate.length < 3) return 0;

    if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
        const coverage = Math.min(normalizedQuery.length, normalizedCandidate.length) / Math.max(normalizedQuery.length, normalizedCandidate.length);
        return Math.min(0.96, 0.72 + coverage * 0.24);
    }

    return Math.min(0.9, editSimilarity(normalizedQuery, normalizedCandidate) * 0.9);
}

function createSearchTextScorer() {
    // Re-ranking after a fallback must re-evaluate identity and intent, but
    // the same query/title pair always has the same text score. Keep only
    // bounded, request-owned values; raw string keys avoid joined copies of
    // potentially long upstream titles.
    const scores = new Map();
    let pairCount = 0;
    return (query, candidate) => {
        let candidates = scores.get(query);
        if (candidates?.has(candidate)) return candidates.get(candidate);
        const score = scoreSearchText(query, candidate);
        if (pairCount < SEARCH_SCORE_CACHE_MAX_PAIRS) {
            if (!candidates) {
                candidates = new Map();
                scores.set(query, candidates);
            }
            candidates.set(candidate, score);
            pairCount += 1;
        }
        return score;
    };
}

function getSearchConfidence(score) {
    if (score >= 0.86) return "high";
    if (score >= 0.65) return "medium";
    return "low";
}

function scoreTmdbCandidate(item, intent, sourceIndex = 0, strategy = "direct", scoreText = scoreSearchText) {
    if (!isValidTmdbSearchItem(item)) return null;
    if (intent.animation && !(Array.isArray(item.genre_ids) && item.genre_ids.includes(TMDB_ANIMATION_GENRE_ID))) return null;

    const title = getTmdbTitle(item);
    const originalTitle = getTmdbOriginalTitle(item);
    let bestScore = 0;
    let bestMethod = "none";
    let matchedQuery = intent.normalizedQuery;

    for (const query of intent.matchQueries) {
        for (const [field, value] of [["title", title], ["originalTitle", originalTitle]]) {
            const score = scoreText(query, value);
            if (score > bestScore) {
                bestScore = score;
                bestMethod = score === 1 ? `${field}-exact` : score >= 0.72 ? `${field}-contains` : `${field}-fuzzy`;
                matchedQuery = query;
            }
        }
    }

    const candidateYear = getTmdbYear(item);
    if (intent.year && candidateYear === intent.year) bestScore += 0.1;
    if (intent.year && candidateYear && candidateYear !== intent.year) bestScore -= 0.08;

    const mediaType = getTmdbMediaType(item);
    if (intent.mediaType && mediaType && mediaType !== intent.mediaType) {
        // "truman show" implies TV only through a word of the movie's own
        // title. Keep a work whose title contains that word and matches the
        // query as typed; everything else of the other type is filtered out.
        const titles = [title, originalTitle].filter(Boolean);
        // Every type word must belong to the title: in "The Truman Show 1998 TV"
        // the separate "TV" is an instruction and still filters the movie.
        const typeWords = intent.typeWords || [];
        const namesTypeWord = typeWords.length > 0
            && titles.some(value => typeWords.every(word => value.toLowerCase().includes(word)));
        const literalScore = namesTypeWord ? Math.max(...titles.map(value => scoreText(intent.literalTitle, value))) : 0;
        if (literalScore < SEARCH_ACCEPT_SCORE) return null;
        if (literalScore + 0.1 > bestScore) {
            bestScore = literalScore + 0.1;
            bestMethod = "title-contains";
            matchedQuery = intent.literalTitle;
        }
    } else if (intent.mediaType && mediaType === intent.mediaType) {
        bestScore += 0.08;
    }

    // A strong title match does not establish the requested remake's identity.
    // Keep it selectable, but ask the user to confirm conflicting/missing years.
    const score = Math.max(0, Math.min(intent.year && candidateYear !== intent.year ? 0.71 : 1, bestScore));
    return {
        score,
        confidence: getSearchConfidence(score),
        method: bestMethod,
        matchedQuery,
        strategy,
        sourceIndex
    };
}

function rankTmdbCandidates(entries, intent, scoreText = scoreSearchText) {
    const unique = new Map();
    let sourceIndex = 0;

    for (const entry of entries) {
        if (!isObject(entry)) continue;
        const item = entry.item;
        if (!isValidTmdbSearchItem(item, entry.mediaType)) continue;
        const mediaType = getTmdbMediaType(item, entry.mediaType);
        const key = `${mediaType}:${toSafeTmdbId(item.id)}`;
        const normalizedItem = { ...item, media_type: mediaType };
        const scoringIntent = entry.strategy === "douban-alias" && entry.query && !intent.matchQueries.includes(entry.query)
            ? {
                ...intent,
                matchQueries: uniqueSearchValues([entry.query, ...intent.matchQueries], MAX_QUERY_LENGTH, 8)
            }
            : intent;
        const candidate = {
            item: normalizedItem,
            mediaType,
            strategy: entry.strategy || "direct",
            sourceIndex,
            match: entry.match || scoreTmdbCandidate(normalizedItem, scoringIntent, sourceIndex, entry.strategy || "direct", scoreText)
        };
        const existing = unique.get(key);
        if (!existing || candidate.match?.score > existing.match?.score) unique.set(key, candidate);
        sourceIndex += 1;
    }

    return [...unique.values()]
        .filter(entry => entry.match)
        .sort((left, right) => (
            right.match.score - left.match.score
            || (toFiniteMetric(right.item.vote_count, 0) - toFiniteMetric(left.item.vote_count, 0))
            || (toFiniteMetric(right.item.popularity, 0) - toFiniteMetric(left.item.popularity, 0))
            || left.match.sourceIndex - right.match.sourceIndex
        ));
}

function getTmdbSearchEntries(data, mediaTypeOverride = null, strategy = "direct", match = null, query = null) {
    if (!Array.isArray(data?.results)) return [];
    return data.results.map(item => ({
        item,
        mediaType: mediaTypeOverride,
        strategy,
        query,
        ...(match ? { match } : {})
    }));
}

function getTmdbFindEntries(data) {
    const externalMatch = {
        score: 1,
        confidence: "high",
        method: "external-id",
        strategy: "external-id",
        sourceIndex: 0
    };
    const movieEntries = Array.isArray(data?.movie_results)
        ? data.movie_results.map(item => ({ item, mediaType: "movie", strategy: "external-id", match: externalMatch }))
        : [];
    const tvEntries = Array.isArray(data?.tv_results)
        ? data.tv_results.map(item => ({ item, mediaType: "tv", strategy: "external-id", match: externalMatch }))
        : [];
    return [...movieEntries, ...tvEntries];
}

function shouldStopSearchFallback(error) {
    return [401, 403, 429, 503, 504].includes(error?.status);
}

function getTopSearchMatch(ranked) {
    return ranked[0]?.match || null;
}

function isExactTitleMatch(ranked) {
    return /-exact$|^external-id$/.test(getTopSearchMatch(ranked)?.method || "");
}

function findExactTmdbActor(results, query) {
    // /search/multi already returns people. A query that is exactly an actor's
    // name is actor intent, even when documentaries contain that name.
    const normalizedQuery = compactSearchText(query);
    if (normalizedQuery.length < 2 || !Array.isArray(results)) return null;
    let best = null;
    for (const item of results) {
        if (!isObject(item) || item.media_type !== "person" || item.known_for_department !== "Acting"
            || toSafeTmdbId(item.id) === null) continue;
        if (![item.name, item.original_name].some(name => typeof name === "string" && compactSearchText(name) === normalizedQuery)) continue;
        if (!best || toFiniteMetric(item.popularity, 0) > toFiniteMetric(best.popularity, 0)) best = item;
    }
    return best ? { id: toSafeTmdbId(best.id), name: getTmdbPersonName(best) } : null;
}

async function buildTmdbSearchResponse(ranked, intent, attempts, { exactPerson = null, cacheable = false, prefetch = null } = {}) {
    const topMatch = getTopSearchMatch(ranked);
    const results = ranked
        .filter(entry => entry.match.score >= SEARCH_AUTO_MATCH_SCORE)
        .slice(0, SEARCH_MAX_RESULTS)
        .map(entry => normalizeTmdbItem(entry.item, entry.mediaType, entry.match))
        .filter(Boolean);

    const body = {
        page: 1,
        totalResults: results.length,
        results,
        searchMeta: {
            originalQuery: intent.originalQuery,
            normalizedQuery: intent.normalizedQuery,
            year: intent.year,
            season: intent.season,
            mediaType: intent.mediaType,
            strategy: topMatch?.strategy || "none",
            confidence: topMatch?.confidence || "none",
            matchScore: topMatch ? Number(topMatch.score.toFixed(3)) : 0,
            matchedBy: topMatch?.method || null,
            attempts,
            ...(exactPerson ? { exactPerson } : {})
        }
    };
    const prefetched = prefetch ? await prefetchTmdbFollowUp(body, prefetch) : null;
    if (prefetched) body.prefetched = prefetched;
    return jsonResponse(body, 200, cacheable ? TMDB_BROWSER_CACHE_HEADERS : {});
}

// Mirrors the page's routing in js/main.js and js/match.js: a confident title
// opens its detail, anything else asks for an actor first. A mismatch only
// leaves an unused payload; the page then makes its normal request.
function predictTmdbFollowUp(results, searchMeta) {
    const prefersActor = Boolean(searchMeta.exactPerson) && !/-exact$|^external-id$/.test(searchMeta.matchedBy || "");
    if (results.length === 0 || prefersActor || searchMeta.matchScore < SEARCH_ACCEPT_SCORE) return { kind: "person" };
    const [top, second] = results;
    if (top.matchConfidence !== "high") return null;
    if (second && top.matchScore - second.matchScore < SEARCH_CLOSE_MATCH_GAP) return null;
    return { kind: "detail", id: top.id, type: top.mediaType };
}

async function prefetchTmdbFollowUp(body, { query, env, ctx, deadline }) {
    const followUp = predictTmdbFollowUp(body.results, body.searchMeta);
    const waitMs = Math.min(SEARCH_PREFETCH_WAIT_MS, deadline.expiresAt - Date.now());
    if (!followUp || waitMs < SEARCH_PREFETCH_MIN_WAIT_MS) return null;

    const lookup = followUp.kind === "detail"
        ? fetchNormalizedTmdbDetail(followUp.id, [followUp.type], env, ctx)
            .then(data => ({ detail: { id: followUp.id, type: followUp.type, data } }))
        : buildTmdbPersonPayload(query, env, ctx, { personId: null, offset: 0, limit: PERSON_DEFAULT_PAGE_SIZE, requestedMediaType: null })
            // Only a complete answer may stand in for the page's own request.
            .then(({ body: data, cacheable }) => cacheable ? { person: { query, data } } : null);
    const settled = lookup.catch(error => {
        logEvent("warn", "tmdb_prefetch_failed", { kind: followUp.kind, error: logErrorMessage(error) });
        return null;
    });
    // A slower lookup keeps running and caches its upstream answer, so the
    // page's own request after this response can still reuse it.
    ctx?.waitUntil?.(settled);
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, waitMs, null); });
    try {
        return await Promise.race([settled, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export function pickBestTmdbPosterCandidate(items, title, year) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const normalizedTitle = normalizeMatchText(title);
    const scored = items
        .filter(item => isValidTmdbSearchItem(item) && typeof item.poster_path === "string" && item.poster_path)
        .filter(item => Math.max(scoreSearchText(title, getTmdbTitle(item)), scoreSearchText(title, getTmdbOriginalTitle(item))) >= SEARCH_ACCEPT_SCORE)
        .map(item => {
            const itemTitle = normalizeMatchText(getTmdbTitle(item));
            const originalTitle = normalizeMatchText(getTmdbOriginalTitle(item));
            const itemYear = getTmdbYear(item);
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

function getTmdbPersonName(person) {
    return pickTmdbText(person?.name, person?.original_name);
}

function scoreTmdbPerson(query, person) {
    const names = [person?.name, person?.original_name].filter(value => typeof value === "string" && value.trim());
    const score = Math.max(0, ...names.map(name => scoreSearchText(query, name)));
    const departmentBonus = person?.known_for_department === "Acting" ? 0.04 : 0;
    return Math.min(1, score + departmentBonus);
}

function normalizeTmdbPerson(person, query, match = null) {
    if (!isObject(person) || toSafeTmdbId(person.id) === null || !getTmdbPersonName(person)) return null;

    const normalized = {
        id: toSafeTmdbId(person.id),
        name: getTmdbPersonName(person),
        originalName: pickTmdbText(person.original_name, person.name),
        profile: tmdbImage(person.profile_path, "w185"),
        knownForDepartment: typeof person.known_for_department === "string" ? person.known_for_department : null
    };
    const popularity = toFiniteMetric(person.popularity);
    if (popularity !== null) normalized.popularity = Math.max(0, popularity);

    if (match) {
        normalized.matchScore = Number(match.score.toFixed(3));
        normalized.matchConfidence = getSearchConfidence(match.score);
        normalized.matchMethod = match.method;
    } else if (query) {
        const score = scoreTmdbPerson(query, person);
        normalized.matchScore = Number(score.toFixed(3));
        normalized.matchConfidence = getSearchConfidence(score);
        normalized.matchMethod = score === 1 ? "name-exact" : score >= 0.72 ? "name-contains" : "name-fuzzy";
    }

    return normalized;
}

function normalizeTmdbPersonCredits(data) {
    const cast = Array.isArray(data?.combined_credits?.cast) ? data.combined_credits.cast : [];
    const seen = new Set();
    const credits = [];

    for (const item of cast) {
        if (!isObject(item)) continue;
        const mediaType = getTmdbMediaType(item)
            || (typeof item.first_air_date === "string" ? "tv" : typeof item.release_date === "string" ? "movie" : null);
        const normalized = normalizeTmdbItem(item, mediaType);
        if (!normalized) continue;

        const key = `${normalized.mediaType}:${normalized.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        credits.push({
            ...normalized,
            character: pickTmdbText(item.character) || null,
            creditId: typeof item.credit_id === "string" ? item.credit_id : null
        });
    }

    return credits.sort((left, right) => (
        (Number(right.year) || 0) - (Number(left.year) || 0)
        || (right.popularity || 0) - (left.popularity || 0)
        || left.title.localeCompare(right.title)
    ));
}

function parsePersonPagination(value, label, defaultValue, maxValue) {
    const text = value === null || value === undefined || value === ""
        ? String(defaultValue)
        : String(value).trim();
    if (!/^\d{1,7}$/.test(text)) return { error: jsonResponse({ error: `Invalid ${label}` }, 400) };
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxValue) {
        return { error: jsonResponse({ error: `Invalid ${label}` }, 400) };
    }
    return { value: parsed };
}

export function validatePersonMediaType(value) {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!text) return { value: null };
    if (text !== "movie" && text !== "tv") {
        return { error: jsonResponse({ error: "Invalid media type" }, 400) };
    }
    return { value: text };
}

function isAmbiguousTmdbPersonMatch(query, rankedPeople) {
    const accepted = rankedPeople.filter(candidate => candidate.score >= SEARCH_ACCEPT_SCORE);
    if (accepted.length < 2) return false;

    const normalizedQuery = compactSearchText(query);
    const exactMatches = accepted.filter(candidate => [candidate.person?.name, candidate.person?.original_name]
        .some(name => compactSearchText(name) === normalizedQuery));
    if (exactMatches.length > 1) return true;

    return accepted[1].score >= 0.86 && accepted[0].score - accepted[1].score < 0.06;
}

function normalizePersonCandidates(rankedPeople, query) {
    return rankedPeople
        .filter(candidate => candidate.score >= SEARCH_ACCEPT_SCORE)
        .slice(0, 6)
        .map(candidate => normalizeTmdbPerson(candidate.person, query, candidate))
        .filter(Boolean);
}

export async function handleTmdbPersonSearch(query, env, ctx, options = {}) {
    const personId = options.personId !== null && options.personId !== undefined ? validatePositiveInteger(options.personId, "id") : null;
    if (personId?.error) return personId.error;

    if (personId) {
        query = typeof query === "string" ? query.trim() : "";
        if ([...query].length > MAX_QUERY_LENGTH) {
            return jsonResponse({ error: "query is too long" }, 400);
        }
    }
    else {
        const queryCheck = validateRequiredText(query, "query");
        if (queryCheck.error) return queryCheck.error;
        query = queryCheck.value;
    }

    const offsetCheck = parsePersonPagination(options.offset, "offset", 0, 100000);
    if (offsetCheck.error) return offsetCheck.error;
    const limitCheck = parsePersonPagination(options.limit, "limit", PERSON_DEFAULT_PAGE_SIZE, PERSON_MAX_PAGE_SIZE);
    if (limitCheck.error || limitCheck.value < 1) return limitCheck.error || jsonResponse({ error: "Invalid limit" }, 400);
    const mediaTypeCheck = validatePersonMediaType(options.mediaType);
    if (mediaTypeCheck.error) return mediaTypeCheck.error;

    try {
        const { body, cacheable } = await buildTmdbPersonPayload(query, env, ctx, {
            personId: personId ? personId.value : null,
            offset: offsetCheck.value,
            limit: limitCheck.value,
            requestedMediaType: mediaTypeCheck.value
        });
        return jsonResponse(body, 200, cacheable ? TMDB_BROWSER_CACHE_HEADERS : {});
    } catch (error) {
        logEvent("error", "tmdb_person_failed", { error: logErrorMessage(error) });
        return errorResponse(error);
    }
}

// Takes validated inputs. `cacheable` is false when a skipped or failed lookup
// may have hidden a better person, so browsers must ask again.
async function buildTmdbPersonPayload(query, env, ctx, { personId, offset, limit, requestedMediaType }) {
    const deadline = createDeadline(FALLBACK_TOTAL_TIMEOUT_MS);
    let best;
    let attempts = 0;
    let degraded = false;

    if (personId) {
        best = {
            person: { id: Number(personId) },
            score: query ? scoreTmdbPerson(query, { id: Number(personId), name: query }) : 1,
            method: query ? "name-exact" : "person-id",
            sourceIndex: 0
        };
    } else {
        const people = [];
        const languages = ["zh-CN", "en-US"];
        let lastError = null;

        for (const language of languages) {
            if (isDeadlineExpired(deadline)) {
                degraded = true;
                break;
            }
            attempts += 1;
            try {
                const data = await fetchTmdbPersonSearch(query, language, env, ctx, { deadline });
                if (Array.isArray(data?.results)) {
                    people.push(...data.results);
                    if (data.results.some(person => scoreTmdbPerson(query, person) >= SEARCH_ACCEPT_SCORE)) break;
                }
            } catch (error) {
                lastError = error;
                degraded = true;
                if (shouldStopSearchFallback(error)) break;
            }
        }

        if (people.length === 0 && lastError) throw lastError;

        const rankedPeople = people
            .filter(person => isObject(person) && toSafeTmdbId(person.id) !== null)
            .map((person, sourceIndex) => {
                const score = scoreTmdbPerson(query, person);
                return {
                    person,
                    score,
                    method: score === 1 ? "name-exact" : score >= 0.72 ? "name-contains" : "name-fuzzy",
                    sourceIndex
                };
            })
            .sort((left, right) => (
                right.score - left.score
                || (right.person.known_for_department === "Acting" ? 1 : 0) - (left.person.known_for_department === "Acting" ? 1 : 0)
                || (toFiniteMetric(right.person.popularity, 0) - toFiniteMetric(left.person.popularity, 0))
                || left.sourceIndex - right.sourceIndex
            ));

        const distinctPeople = [];
        const seenPeople = new Set();
        for (const candidate of rankedPeople) {
            const id = toSafeTmdbId(candidate.person.id);
            if (seenPeople.has(id)) continue;
            seenPeople.add(id);
            distinctPeople.push(candidate);
        }

        if (isAmbiguousTmdbPersonMatch(query, distinctPeople)) {
            const candidates = normalizePersonCandidates(distinctPeople, query);
            return { cacheable: !degraded, body: {
                person: null,
                personCandidates: candidates,
                credits: [],
                totalResults: 0,
                offset: 0,
                limit,
                hasMore: false,
                counts: { tv: 0, movie: 0 },
                searchMeta: {
                    query,
                    attempts,
                    confidence: "ambiguous",
                    ambiguous: true,
                    matchScore: Number((distinctPeople[0]?.score || 0).toFixed(3))
                }
            } };
        }

        best = distinctPeople[0];
        if (!best || best.score < SEARCH_ACCEPT_SCORE) {
            return { cacheable: !degraded, body: {
                person: null,
                credits: [],
                totalResults: 0,
                offset: 0,
                limit,
                hasMore: false,
                counts: { tv: 0, movie: 0 },
                searchMeta: { query, attempts, confidence: "none", matchScore: 0 }
            } };
        }
    }

    const selectedPersonId = toSafeTmdbId(best.person.id);
    const personData = await fetchTmdbJson(`/person/${selectedPersonId}`, {
        language: "zh-CN",
        append_to_response: "combined_credits"
    }, env, ctx, { deadline });
    const person = normalizeTmdbPerson(personData, query, personId ? null : best);
    const allCredits = normalizeTmdbPersonCredits(personData);
    const filteredCredits = requestedMediaType
        ? allCredits.filter(credit => credit.mediaType === requestedMediaType)
        : allCredits;
    const credits = filteredCredits.slice(offset, offset + limit);
    const counts = {
        tv: allCredits.filter(credit => credit.mediaType === "tv").length,
        movie: allCredits.filter(credit => credit.mediaType === "movie").length
    };

    return { cacheable: !degraded, body: {
        person,
        credits,
        totalResults: filteredCredits.length,
        offset,
        limit,
        hasMore: offset + credits.length < filteredCredits.length,
        counts,
        searchMeta: {
            query,
            attempts,
            confidence: best.score >= 0.86 ? "high" : "medium",
            matchScore: Number(best.score.toFixed(3)),
            matchedBy: best.method
        }
    } };
}

export async function handleTmdbSearch(query, env, ctx) {
    const queryCheck = validateRequiredText(query, "query");
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    try {
        const intent = buildSearchIntent(query);
        const scoreText = createSearchTextScorer();
        const deadline = createDeadline(FALLBACK_TOTAL_TIMEOUT_MS);
        const entries = [];
        const attempted = new Set();
        let attempts = 0;
        let successfulAttempt = false;
        let lastError = null;
        let stopFallback = false;
        // A failed or deadline-skipped fallback may have hidden a better match.
        let degraded = false;
        let exactPerson = null;

        const runSearch = async (path, searchQuery, language, params = {}, mediaType = null, strategy = "direct") => {
            if (attempts >= SEARCH_MAX_ATTEMPTS || isDeadlineExpired(deadline) || stopFallback) {
                if (attempts < SEARCH_MAX_ATTEMPTS) degraded = true;
                return rankTmdbCandidates(entries, intent, scoreText);
            }

            const attemptKey = JSON.stringify([path, searchQuery, language, params]);
            if (attempted.has(attemptKey)) return rankTmdbCandidates(entries, intent, scoreText);
            attempted.add(attemptKey);
            attempts += 1;

            try {
                const data = path === "/search/multi"
                    ? await fetchTmdbSearch(searchQuery, language, env, ctx, { deadline })
                    : await fetchTmdbTypedSearch(path.slice("/search/".length), searchQuery, language, env, ctx, params, { deadline });
                successfulAttempt = true;
                if (path === "/search/multi" && !exactPerson) exactPerson = findExactTmdbActor(data.results, intent.originalQuery);
                // A literal title such as "The Truman Show" is stronger evidence
                // than type/year words inferred from the text of that title.
                if (path === "/search/multi") {
                    const titles = data.results.filter(item => isValidTmdbSearchItem(item))
                        .flatMap(item => [getTmdbTitle(item), getTmdbOriginalTitle(item)]);
                    const literalMatch = getLiteralSearchEvidence(titles, intent);
                    // A whole-query title match proves that a season-like prefix
                    // belongs to the title (for example "S21: ..."). A title
                    // match after removing "s02" must keep the season intent.
                    if (literalMatch && (!intent.season || literalMatch.wholeQuery)
                        && literalMatch.length >= (intent.literalEvidenceLength || 0)) {
                        intent.literalEvidenceLength = literalMatch.length;
                        intent.mediaType = literalMatch.mediaType;
                        intent.animation = literalMatch.animation;
                        if (literalMatch.wholeQuery) intent.season = null;
                        // A year appended to a literal title still constrains
                        // the requested remake. Only an exact whole-title match
                        // proves that the digits themselves belong to the name.
                        if (literalMatch.wholeQuery) intent.year = null;
                        intent.normalizedQuery = literalMatch.title;
                        // A confirmed literal name supersedes lossy noise-stripped
                        // variants, which may be the exact name of another work.
                        intent.matchQueries = uniqueSearchValues([literalMatch.title, intent.originalQuery], MAX_QUERY_LENGTH, 8);
                    }
                }
                entries.push(...getTmdbSearchEntries(data, mediaType, strategy, null, searchQuery));
            } catch (error) {
                lastError = error;
                degraded = true;
                stopFallback = shouldStopSearchFallback(error);
            }

            return rankTmdbCandidates(entries, intent, scoreText);
        };

        const isAccepted = ranked => (getTopSearchMatch(ranked)?.score || 0) >= SEARCH_ACCEPT_SCORE;
        const isLowConfidence = ranked => !isAccepted(ranked);
        let ranked = [];

        const imdbId = extractImdbIdFromQuery(query);
        if (imdbId) {
            try {
                const data = await fetchTmdbFindByExternalId(imdbId, "zh-CN", env, ctx, { deadline });
                successfulAttempt = true;
                ranked = rankTmdbCandidates(getTmdbFindEntries(data), intent, scoreText);
                return await buildTmdbSearchResponse(ranked, intent, 1, { cacheable: true, prefetch: { query, env, ctx, deadline } });
            } catch (error) {
                logEvent("error", "tmdb_external_id_failed", { error: logErrorMessage(error) });
                return errorResponse(error);
            }
        }

        ranked = await runSearch("/search/multi", intent.originalQuery, "zh-CN");
        // Title fallbacks for a Chinese actor name only find works that mention
        // the name. Latin names keep the en-US pass: it can find the exact
        // English title of a foreign-language work.
        const stopForActor = intent.hasCjk && Boolean(exactPerson) && !isExactTitleMatch(ranked);
        if (ranked.length === 0 && !stopFallback && !stopForActor) {
            ranked = await runSearch("/search/multi", intent.originalQuery, "en-US");
        }

        if (isLowConfidence(ranked) && !stopFallback && !stopForActor) {
            for (const variant of intent.variants.slice(0, 2)) {
                if (compactSearchText(variant) === compactSearchText(intent.originalQuery)) continue;
                ranked = await runSearch("/search/multi", variant, "zh-CN", {}, null, "normalized");
                if (isAccepted(ranked)) break;
            }
        }

        if (isLowConfidence(ranked) && !stopFallback && !stopForActor) {
            ranked = await runSearch("/search/multi", intent.normalizedQuery, "en-US", {}, null, "normalized");
        }

        if (isLowConfidence(ranked) && !stopFallback && !stopForActor && (intent.mediaType || intent.year)) {
            const typedMediaTypes = intent.mediaType ? [intent.mediaType] : ["movie", "tv"];
            for (const mediaType of typedMediaTypes) {
                const yearParam = intent.year
                    ? mediaType === "movie"
                        ? { primary_release_year: intent.year }
                        : { first_air_date_year: intent.year }
                    : {};
                ranked = await runSearch(
                    `/search/${mediaType}`,
                    intent.normalizedQuery,
                    "zh-CN",
                    yearParam,
                    mediaType,
                    "typed"
                );
                if (isAccepted(ranked)) break;
            }
        }

        if (isLowConfidence(ranked) && !stopFallback && !stopForActor && intent.hasCjk && attempts < SEARCH_MAX_ATTEMPTS) {
            try {
                const aliasData = await fetchDoubanAliasCandidates(intent.normalizedQuery, ctx, deadline);
                const aliases = extractDoubanAliasQueries(aliasData, intent.normalizedQuery, intent.year);
                for (const alias of aliases.slice(0, SEARCH_MAX_ALIAS_QUERIES)) {
                    ranked = await runSearch("/search/multi", alias, "zh-CN", {}, null, "douban-alias");
                    if (isAccepted(ranked)) break;
                }
            } catch (error) {
                degraded = true;
                logEvent("warn", "douban_alias_failed", { error: logErrorMessage(error) });
            }
        }

        if (!successfulAttempt && lastError && ranked.length === 0) {
            throw lastError;
        }

        return await buildTmdbSearchResponse(ranked, intent, attempts, {
            exactPerson,
            cacheable: !degraded,
            // An upstream that asked us to stop would refuse the follow-up too.
            prefetch: stopFallback ? null : { query, env, ctx, deadline }
        });
    } catch (e) {
        logEvent("error", "tmdb_search_failed", { error: logErrorMessage(e) });
        return errorResponse(e);
    }
}

export async function handleTmdbDetail(id, type, requestedSeason, env, ctx) {
    const hasExplicitType = type !== null && type !== undefined;
    const idCheck = validatePositiveInteger(id);
    if (idCheck.error) return idCheck.error;
    id = idCheck.value;

    const typeCheck = validateMediaType(type);
    if (typeCheck.error) return typeCheck.error;
    type = typeCheck.value;

    let season = null;
    if (requestedSeason !== null && requestedSeason !== undefined) {
        const seasonCheck = validatePositiveInteger(requestedSeason, "season");
        if (seasonCheck.error || Number(seasonCheck.value) > 99) {
            return jsonResponse({ error: "Invalid season" }, 400);
        }
        if (type !== "tv") return jsonResponse({ error: "A season can only be requested for a TV series" }, 400);
        season = Number(seasonCheck.value);
    }

    // A movie id and a TV id belong to different namespaces. Only legacy
    // untyped links may probe both; an explicit type must preserve identity.
    const attemptOrder = hasExplicitType ? [type] : ["movie", "tv"];
    try {
        const detail = await fetchNormalizedTmdbDetail(id, attemptOrder, env, ctx);
        if (season !== null && !detail.seasons.some(entry => entry.seasonNumber === season)) {
            const availableSeasons = detail.seasons.filter(entry => entry.seasonNumber > 0).length;
            const message = availableSeasons
                ? `未找到第 ${season} 季，该剧目前有 ${availableSeasons} 季。`
                : `未找到第 ${season} 季，该剧目前没有已公布的季度资料。`;
            return jsonResponse({ error: message }, 404);
        }
        return jsonResponse(detail, 200, TMDB_BROWSER_CACHE_HEADERS);
    } catch (error) {
        return errorResponse(error);
    }
}

async function fetchNormalizedTmdbDetail(id, attemptOrder, env, ctx) {
    const deadline = createDeadline(FALLBACK_TOTAL_TIMEOUT_MS);
    let lastError = null;

    for (const candidateType of attemptOrder) {
        try {
            const data = await fetchTmdbJson(`/${candidateType}/${id}`, {
                language: "zh-CN",
                append_to_response: "external_ids,credits"
            }, env, ctx, { deadline });
            return normalizeTmdbDetail(data, candidateType);
        } catch (e) {
            lastError = e;
            if (e.status !== 404) throw e;
        }
    }

    throw lastError || createHttpError("TMDB detail not found", 404);
}
