/**
 * Chinese Wikipedia summaries with media type and year verification.
 */

import { RELEASE_VERSION } from '../js/release.js';
import {
    FALLBACK_TOTAL_TIMEOUT_MS,
    MAX_MEDIA_TITLE_LENGTH,
    UPSTREAM_TIMEOUT_MS,
    cacheJson,
    createDeadline,
    createHttpError,
    errorResponse,
    fetchUpstream,
    isDeadlineExpired,
    isObject,
    jsonResponse,
    logErrorMessage,
    logEvent,
    readJsonWithLimit,
    releaseUpstreamResponse,
    remainingDeadlineMs,
    serveCachedJson,
    validateOptionalYear,
    validatePositiveInteger,
    validateRequiredText
} from './core.js';
import {
    fetchTmdbJson,
    getTmdbAuth,
    scoreSearchText,
    validatePersonMediaType
} from './tmdb.js';

function getWikiIdentityEvidence(text) {
    // Quoted source titles and later adaptation clauses do not identify a work's
    // own medium or release year.
    let evidence = String(text || "").replace(/《[^》]*》|「[^」]*」|“[^”]*”/gu, "");
    const adaptation = /改[編编](?:自|成|[為为])|取材自|根[據据]|基[于於]|\bbased on\b|\badapted (?:from|into|to|for)\b|\badaptation of\b/iu.exec(evidence);
    if (adaptation && /電視|电视|劇集|剧集|影集|電影|电影|小說|小说|漫畫|漫画|\b(?:television|series|films?|movies?|novels?|manga|comics?)\b/iu.test(evidence.slice(0, adaptation.index))) {
        evidence = evidence.slice(0, adaptation.index);
    } else if (adaptation) {
        // A leading source clause can contain a different year and medium:
        // "根据2024年小说改编的2005年电影" identifies the 2005 film.
        const sourceAndWork = evidence.slice(adaptation.index);
        const sourceClause = sourceAndWork.match(/^(?:根[據据]|基[于於])[^，,。;；]*?改[編编](?:而成)?的|^(?:改[編编]自|取材自)[^，,。;；]*?的|^\bbased on\b[^,，;；]*?\band\s+(?:is|was)\s+(?:(?:an?|the)\s+)?|^\bbased on\b[^,，;；]*[,，;；]\s*/iu);
        if (sourceClause) evidence = evidence.slice(0, adaptation.index) + sourceAndWork.slice(sourceClause[0].length);
    }
    return evidence;
}

function getWikiKind(text) {
    // This function receives type evidence, never an unqualified article name.
    const evidence = getWikiIdentityEvidence(text);
    if (/(?:消歧義|消歧义|\bdisambiguation\b)/iu.test(evidence)) return "other";
    let kind = null;
    for (const clause of evidence.split(/[，,。;；]/u)) {
        const matches = Array.from(clause.matchAll(/電視|电视|劇集|剧集|影集|\btelevision\b|\btv series\b|電影|电影|\bfilms?\b|\bmovies?\b|小說(?!家)|小说(?!家)|漫畫(?!家)|漫画(?!家)|\bnovels?\b|\bmanga\b|\bcomics?\b/giu));
        if (matches.length) {
            kind = matches.at(-1)[0];
            break;
        }
    }
    // A source medium can precede the work's own noun: "漫画改编电影",
    // "television film", or "根据电视剧改编的小说".
    if (/(?:電視|电视|劇集|剧集|影集|\btelevision\b|\btv series\b)/iu.test(kind || "")) return "tv";
    if (/(?:電影|电影|\bfilms?\b|\bmovies?\b)/iu.test(kind || "")) return "movie";
    if (kind) return "other";
    return null;
}

function getWikiTitleKind(title) {
    // Wikipedia disambiguators are explicit identity evidence. Words inside
    // titles such as "小说家的电影" or "电视之王" are not.
    const suffix = getWikiTitleDisambiguator(title);
    return suffix ? getWikiKind(suffix) : null;
}

function getWikiTitleDisambiguator(title) {
    return String(title || "").match(/[(（]([^()（）]*)[)）]\s*$/u)?.[1] || "";
}

function getWikiIntroEvidence(intro, title) {
    let evidence = intro;
    for (const name of [title, title.replace(/\s*[(（][^()（）]*[)）]\s*$/u, "").trim()]) {
        if (name) evidence = evidence.replace(name, "");
    }
    // Original-language names often appear in parentheses before the predicate.
    evidence = evidence.replace(/^\s*(?:《》|「」|["“”])*\s*[(（][^()（）]*[)）]\s*/u, "");
    return getWikiIdentityEvidence(evidence);
}

function wikiTitleMatches(query, title) {
    if (typeof title !== "string" || !title.trim()) return false;
    const baseTitle = title.replace(/\s*[(（][^()（）]*[)）]\s*/gu, " ").trim();
    return scoreSearchText(query, baseTitle) >= 0.86;
}

// adjacentYear is set only for a series premiering near a year boundary;
// see getWikiAdjacentYear. Films and other series need the exact year.
function wikiYearMatches(year, text, adjacentYear = null) {
    if (!year) return true;
    const evidence = String(text || "");
    const matches = [...evidence.matchAll(/(?:19|20)\d{2}/g)];
    const possibleYears = [];
    const workYears = [];
    const workRole = /電視|电视|劇集|剧集|影集|電影|电影|首映|上映|首播|开播|開播|播出|發行|发行|\b(?:films?|movies?|television|series|released?|premiered?)\b/iu;
    const incidentalRole = /修[复復]|重映|重新|再次|再版|重版|再[发發]行|获奖|獲獎|入[选選]|(?:获|獲|赢|贏).{0,16}(?:奖|獎)|\b(?:restor\w*|re[- ]?(?:releas\w*|issu\w*)|awards?|oscar|academy|won)\b/iu;

    for (const [index, match] of matches.entries()) {
        // Classify the year within its own clause. A nearby later year must
        // not make a restoration or a director's award identify the film.
        const prefix = evidence.slice(Math.max(0, match.index - 100), match.index).split(/[，,。;；]/u).at(-1);
        const suffix = evidence.slice(match.index + 4, Math.min(matches[index + 1]?.index ?? evidence.length, match.index + 104))
            .split(/[，,。;；]/u)[0];
        const roleIndex = suffix.search(workRole);
        const incidentalIndex = suffix.search(incidentalRole);
        const releaseBeforeYear = /(?:首映|上映|首播|开播|開播|播出|發行|发行|\b(?:released?|premiered?)\b)\s*(?:于|於|在|in|on)?\s*$/iu.test(prefix)
            && !incidentalRole.test(prefix);
        if (!releaseBeforeYear && incidentalIndex >= 0 && (roleIndex < 0 || incidentalIndex < roleIndex)) continue;
        if (!releaseBeforeYear && roleIndex < 0 && incidentalRole.test(prefix)) continue;

        possibleYears.push(match[0]);
        if (roleIndex >= 0 || releaseBeforeYear) workYears.push(match[0]);
    }

    // Prefer explicit definitions/release dates. Keep multiple genuine regional
    // release years; do not guess a single year merely from their order.
    const years = workYears.length ? workYears : possibleYears;
    if (matches.length === 0 || years.includes(year)) return true;
    return Boolean(adjacentYear) && years.includes(adjacentYear);
}

// Wikimedia asks API clients to identify themselves with a contact URL
// instead of a browser User-Agent. zh-CN selects simplified Chinese text.
const WIKI_HEADERS = Object.freeze({
    "User-Agent": `iPlay/${RELEASE_VERSION} (https://iplay.hackx64.eu.org; https://github.com/txdywy/iplay)`,
    "Accept-Language": "zh-CN"
});

const WIKI_MAX_SUMMARY_CANDIDATES = 10;

// Search ranking can omit the article itself (狂飙 returns 狂飆, 狂飙突进运动,
// …). Standard disambiguated article names are cheap, exact candidates.
function getWikiDirectTitles(query, { mediaType = null, year = "" } = {}) {
    const kinds = mediaType === "movie" ? ["电影"] : mediaType === "tv" ? ["电视剧", "动画"] : ["电视剧", "电影"];
    // The bare name comes last: search finds it unless its stored script
    // differs ("狂飙" is stored as "狂飆"), and it then still needs the
    // media type and year evidence.
    return [...kinds.flatMap(kind => [...(year && kind !== "动画" ? [`${query} (${year}年${kind})`] : []), `${query} (${kind})`]), query];
}

// Chinese Wikipedia stores one script variant ("狂飆 (電視劇)"), and the REST
// summary endpoint does not convert "狂飙 (电视剧)" to it. Resolve all
// standard names in one query with variant conversion and redirects, and
// keep only pages that exist.
async function resolveZhWikiTitles(titles, deadline = null) {
    if (titles.length === 0 || isDeadlineExpired(deadline)) return [];
    const url = new URL("https://zh.wikipedia.org/w/api.php");
    for (const [key, value] of Object.entries({
        action: "query", titles: titles.join("|"), redirects: "1", converttitles: "1",
        format: "json", formatversion: "2", origin: "*"
    })) url.searchParams.set(key, value);
    const res = await fetchUpstream(url.href, { headers: WIKI_HEADERS }, remainingDeadlineMs(deadline, UPSTREAM_TIMEOUT_MS));
    if (!res.ok) {
        await releaseUpstreamResponse(res);
        throw createHttpError(`Wiki title lookup rejected with status ${res.status}`, res.status);
    }
    const data = await readJsonWithLimit(res);
    const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
    const existing = new Set(pages.filter(page => isObject(page) && !page.missing && !page.invalid
        && typeof page.title === "string").map(page => page.title));
    // Keep the guess order (year-qualified names first).
    const resolved = new Map();
    for (const list of [data?.query?.normalized, data?.query?.converted, data?.query?.redirects]) {
        for (const item of Array.isArray(list) ? list : []) {
            if (typeof item?.from === "string" && typeof item?.to === "string") resolved.set(item.from, item.to);
        }
    }
    const result = [];
    for (const title of titles) {
        let current = title;
        for (let step = 0; step < 3 && resolved.has(current); step++) current = resolved.get(current);
        if (existing.has(current) && !result.includes(current)) result.push(current);
    }
    return result;
}

async function searchZhWikiTitles(query, deadline = null, { mediaType = null, year = "", adjacentYear = null } = {}) {
    if (isDeadlineExpired(deadline)) throw createHttpError("Upstream request timed out", 504);
    const searchRes = await fetchUpstream(
        `https://zh.wikipedia.org/w/api.php?action=query&list=search&srlimit=10&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
        { headers: WIKI_HEADERS },
        remainingDeadlineMs(deadline, UPSTREAM_TIMEOUT_MS)
    );
    if (!searchRes.ok) {
        await releaseUpstreamResponse(searchRes);
        throw createHttpError(`Wiki search rejected with status ${searchRes.status}`, searchRes.status);
    }
    const searchData = await readJsonWithLimit(searchRes);

    if (!Array.isArray(searchData?.query?.search)) throw createHttpError("Wiki returned an invalid search response", 502);
    const candidates = searchData.query.search
        .filter(item => isObject(item) && wikiTitleMatches(query, item.title)
            && wikiYearMatches(year, getWikiTitleDisambiguator(item.title), adjacentYear))
        .filter(item => !mediaType || !getWikiTitleKind(item.title) || getWikiTitleKind(item.title) === mediaType);
    if (mediaType || year) candidates.sort((a, b) => (
        Number(Boolean(year) && wikiYearMatches(year, getWikiTitleDisambiguator(b.title), adjacentYear)
            && /(?:19|20)\d{2}/u.test(getWikiTitleDisambiguator(b.title)))
            - Number(Boolean(year) && wikiYearMatches(year, getWikiTitleDisambiguator(a.title), adjacentYear)
                && /(?:19|20)\d{2}/u.test(getWikiTitleDisambiguator(a.title)))
        || Number(Boolean(mediaType) && getWikiTitleKind(b.title) === mediaType)
            - Number(Boolean(mediaType) && getWikiTitleKind(a.title) === mediaType)
    ));
    return candidates.slice(0, 10).map(candidate => candidate.title);
}

const WIKI_IDENTITY_TIMEOUT_MS = 3000;

// A series premiering in November or December is often dated the next year
// on Wikipedia (繁花: 2023-12-27, listed as 2024), and one premiering in
// January or February the previous year. Only then is the adjacent year the
// same work; otherwise it is a different adaptation (斗破苍穹: the 2017
// animation versus the 2018 live-action series).
async function getWikiAdjacentYear(id, mediaType, year, env, ctx) {
    if (!id || mediaType !== "tv" || !year || !getTmdbAuth(env)) return null;
    try {
        const data = await fetchTmdbJson(`/tv/${id}`, { language: "zh-CN", append_to_response: "external_ids,credits" },
            env, ctx, { deadline: createDeadline(WIKI_IDENTITY_TIMEOUT_MS) });
        const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(data?.first_air_date || "");
        if (!match || match[1] !== year) return null;
        const month = Number(match[2]);
        return month >= 11 ? String(Number(year) + 1) : month <= 2 ? String(Number(year) - 1) : null;
    } catch {
        return null;
    }
}

export async function handleWikiZh(query, ctx, options = {}) {
    const queryCheck = validateRequiredText(query, "query", MAX_MEDIA_TITLE_LENGTH);
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const mediaTypeCheck = validatePersonMediaType(options.mediaType);
    if (mediaTypeCheck.error) return mediaTypeCheck.error;
    const yearCheck = validateOptionalYear(options.year);
    if (yearCheck.error) return yearCheck.error;
    const idCheck = options.id === null || options.id === undefined ? null : validatePositiveInteger(options.id);
    if (idCheck?.error) return idCheck.error;
    const mediaType = mediaTypeCheck.value;
    const year = yearCheck.value;
    const adjacentYear = await getWikiAdjacentYear(idCheck?.value, mediaType, year, options.env, ctx);

    const cacheKey = new Request(`https://wiki-zh-v8-cache.local/?q=${encodeURIComponent(query)}&type=${mediaType || ""}&year=${year}&near=${adjacentYear || ""}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached) return cached;

    try {
        const deadline = createDeadline(FALLBACK_TOTAL_TIMEOUT_MS);
        const yearMatches = text => wikiYearMatches(year, text, adjacentYear);
        const trySummaries = async (titles, verifiedTitles = new Set()) => {
            for (const title of titles) {
                if (isDeadlineExpired(deadline)) throw createHttpError("Upstream request timed out", 504);
                const summaryRes = await fetchUpstream(
                    `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
                    { headers: WIKI_HEADERS },
                    remainingDeadlineMs(deadline, UPSTREAM_TIMEOUT_MS)
                );

                if (!summaryRes.ok) {
                    const status = summaryRes.status;
                    await releaseUpstreamResponse(summaryRes);
                    // Deleted candidates are normal in Wikipedia's search index.
                    // Other provider failures should stop without fanning out.
                    if (status === 404) continue;
                    throw createHttpError(`Wiki summary failed: ${status}`, status);
                }

                const summaryData = await readJsonWithLimit(summaryRes);
                if (!isObject(summaryData)
                    || typeof summaryData.title !== "string"
                    || typeof summaryData.extract !== "string") {
                    throw createHttpError("Wiki returned an invalid response", 502);
                }

                // Latin titles such as "Mr. Bean" can contain periods inside the
                // Chinese lead sentence; keep its media/year evidence intact.
                const intro = summaryData.extract.split(/[。!?！？\r\n]/u)[0];
                const introEvidence = getWikiIntroEvidence(intro, summaryData.title);
                const descriptionEvidence = getWikiIdentityEvidence(summaryData.description);
                const titleKind = getWikiTitleKind(summaryData.title);
                const descriptionKind = getWikiKind(summaryData.description || "");
                const introKind = getWikiKind(introEvidence);
                if (summaryData.type === "disambiguation"
                    || !summaryData.extract.trim()
                    // Variant conversion proves a resolved standard name is this
                    // query, although its stored script ("狂飆") differs.
                    || !(verifiedTitles.has(title) || wikiTitleMatches(query, summaryData.title))
                    || !yearMatches(getWikiTitleDisambiguator(summaryData.title))
                    || !yearMatches(descriptionEvidence)
                    || !yearMatches(introEvidence)
                    || (mediaType && titleKind && titleKind !== mediaType)
                    || (mediaType && [descriptionKind, introKind].some(kind => kind && kind !== mediaType))
                    || (mediaType && !descriptionKind && !introKind && titleKind !== mediaType)) {
                    continue;
                }

                return {
                    title: summaryData.title,
                    extract: summaryData.extract,
                    thumbnail: isObject(summaryData.thumbnail) ? summaryData.thumbnail : null
                };
            }
            return null;
        };

        const searchTitles = (await searchZhWikiTitles(query, deadline, { mediaType, year, adjacentYear }))
            .slice(0, WIKI_MAX_SUMMARY_CANDIDATES);
        const fromSearch = await trySummaries(searchTitles);
        if (fromSearch) return cacheJson(ctx, cacheKey, fromSearch, 86400);

        // Resolve standard article names only when search found nothing, and
        // only after it: Wikimedia throttles concurrent anonymous requests.
        let lookup = "ok";
        const directTitles = await resolveZhWikiTitles(getWikiDirectTitles(query, { mediaType, year }), deadline)
            .catch(error => {
                lookup = "failed";
                logEvent("warn", "wiki_title_lookup_failed", { error: logErrorMessage(error) });
                return [];
            });
        const remaining = directTitles.filter(title => !searchTitles.includes(title));
        const fromLookup = await trySummaries(remaining, new Set(remaining));
        if (fromLookup) return cacheJson(ctx, cacheKey, fromLookup, 86400);

        return jsonResponse({
            error: searchTitles.length || remaining.length ? "No matching media summary on zh.wikipedia" : "Not found on zh.wikipedia",
            lookup
        }, 404);
    } catch (e) {
        return errorResponse(e);
    }
}
