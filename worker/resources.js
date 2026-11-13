/**
 * Quark resource search across By669, WPZY and 醉都音.
 */

import {
    MAX_MEDIA_TITLE_LENGTH,
    MAX_QUERY_LENGTH,
    cacheJson,
    compactSearchText,
    createDeadline,
    createHttpError,
    decodeHtmlEntities,
    errorResponse,
    escapeRegExp,
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
    serveCachedJson,
    stripHtml,
    stripInlineHtml,
    validateOptionalYear,
    validatePositiveInteger,
    validateRequiredText,
    withInFlight
} from './core.js';
import {
    DOUBAN_SEARCH_HEADERS
} from './douban.js';
import {
    fetchTmdbJson,
    getTmdbAuth,
    validatePersonMediaType
} from './tmdb.js';

const RESOURCE_TIMEOUT_MS = 5000;

const RESOURCE_TOTAL_TIMEOUT_MS = 15000;

const RESOURCE_MAX_REDIRECTS = 1;

const RESOURCE_MAX_DETAIL_PAGES = 12;

const RESOURCE_MAX_WPZY_DETAIL_PAGES = 6;

const RESOURCE_MAX_ZUIDOUYIN_POSTS = 4;

const ZUIDOUYIN_SEARCH_PAGE_SIZE = 10;

const RESOURCE_DETAIL_CONCURRENCY = 6;

const RESOURCE_MAX_PROVIDER_RESULTS = 50;

const RESOURCE_MAX_QUARK_URLS_PER_PAGE = 25;

const RESOURCE_MAX_QUARK_URLS_TOTAL = 100;

// Real share identifiers are short. Keep generous compatibility margins while
// preventing one upstream URL from dominating both aggregate and page evidence.
const RESOURCE_MAX_URL_LENGTH = 2048;

const RESOURCE_MAX_QUARK_TOKEN_LENGTH = 128;

const RESOURCE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Capture complete URL-like occurrences, including foreign providers, so their
// passwords stay within their own links. Never truncate a malformed Quark path
// into a different, apparently valid share.
const RESOURCE_LINK_PATTERN = /(?:https?:\/\/|(?:pan|drive)\.quark\.cn\/s\/)[^\s"'<>\\(),\x5B\x5D，。；;、（）【】《》]+/gi;

// Keep a single whitespace run on each side of the optional separator. Two
// adjacent `\s*` let a long blank run backtrack quadratically on forum HTML.
const QUARK_PASSWORD_PATTERN = /(?:提取码|密码|访问码)\s*(?:[：:=]\s*)?([a-z0-9]{2,12})(?![a-z0-9])/gi;

const BY669_BASE = "https://by669.org";

const WPZYS_BASE = "https://wpzy.org";

const ZUIDOUYIN_BASE = "https://zuidouyin.com";

const WPZY_ORIGINS = new Set([WPZYS_BASE, "https://www.wpzy.org"]);

const RESOURCE_ALLOWED_ORIGINS = new Set([BY669_BASE, ...WPZY_ORIGINS]);

async function getWpzySession(env) {
    const rawCookie = env?.WPZY_COOKIE;
    const values = new Map();
    if (typeof rawCookie === "string" && rawCookie.length <= 4096
        && !Array.from(rawCookie).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        for (const part of rawCookie.split(";")) {
            const separator = part.indexOf("=");
            if (separator < 0) continue;
            const name = part.slice(0, separator).trim();
            if (name !== "bbs_token" && name !== "bbs_sid") continue;
            const value = part.slice(separator + 1).trim();
            if (values.has(name) || !value || /[^\x21-\x7e]|[,;"\\]/.test(value)) {
                values.clear();
                break;
            }
            values.set(name, value);
        }
    }
    const cookie = values.has("bbs_token")
        ? ["bbs_token", "bbs_sid"].filter(name => values.has(name)).map(name => `${name}=${values.get(name)}`).join("; ")
        : "";
    if (!cookie) return { cookie: "", cacheScope: "anonymous" };
    // Hash only for internal cache/coalescing keys. Never expose or log credentials.
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new globalThis.TextEncoder().encode(cookie));
    return { cookie, cacheScope: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
}

function createResourceAccessError(issue) {
    const error = createHttpError(issue === "login_required" ? "WPZY login required" : "WPZY post requires reply or membership", 502);
    error.resourceIssue = issue;
    return error;
}

function isWpzyLoginPage(html) {
    return /<title\b[^>]*>\s*(?:用户登录|用户登陆)(?:\s*[-|][^<]*)?\s*<\/title>|<form\b[^>]*action=["'][^"']*user-login(?:\.htm|[?"'])/i.test(html);
}

function isWpzyRestrictedPage(html) {
    return /【待操作】|回复(?:后|即可)(?:查看|可见)|开通\s*VIP\s*会员无需操作/i.test(stripHtml(html));
}

function assertWpzyReadOnlyUrl(value) {
    const url = new URL(value);
    if (!WPZY_ORIGINS.has(url.origin)) return;
    if (/^\/user-login(?:\.htm)?\/?$/i.test(url.pathname)) throw createResourceAccessError("login_required");
    const isSearch = url.pathname === "/search.htm";
    const isThread = /^\/thread-\d+\.htm$/.test(url.pathname);
    if ((!isSearch && !isThread) || (isThread && url.search) || (isSearch && [...url.searchParams.keys()].some(key => key !== "keyword"))) {
        throw createHttpError("Blocked non-resource WPZY request", 502);
    }
}

function isValidQuarkPassword(value) {
    return /^[a-z0-9]{2,12}$/i.test(value) && !/^https?$/i.test(value);
}

function collectQuarkPasswordParams(params, passwords) {
    for (const key of ["pwd", "password", "passcode", "code"]) {
        for (const value of params.getAll(key)) {
            if (isValidQuarkPassword(value)) passwords.add(value);
        }
    }
}

function extractQuarkPasswordFromUrl(url) {
    const passwords = new Set();
    collectQuarkPasswordParams(url.searchParams, passwords);
    const hashText = url.hash.replace(/^#/, "");
    if (hashText) {
        const hashQuery = hashText.includes("?") ? hashText.slice(hashText.indexOf("?") + 1) : hashText;
        collectQuarkPasswordParams(new URL(`https://quark-password.local/?${hashQuery}`).searchParams, passwords);
    }
    return {
        password: passwords.size === 1 ? [...passwords][0] : "",
        _passwordConflict: passwords.size > 1
    };
}

function parseQuarkUrl(rawUrl) {
    if (!rawUrl || rawUrl.length > RESOURCE_MAX_URL_LENGTH) return null;

    const cleaned = rawUrl
        .replace(/&amp;/g, "&")
        .replace(/[。．｡]$/g, "")
        .replace(/[),.；;]+$/g, "");
    const absoluteUrl = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

    try {
        const url = new URL(absoluteUrl);
        if (!/^(?:pan|drive)\.quark\.cn$/i.test(url.hostname) || url.username || url.password) return null;
        // URL parsing collapses literal and encoded dot segments. A malformed
        // source must never become a different valid share after normalization.
        const rawPath = absoluteUrl.match(/^https?:\/\/[^/?#]+(\/[^?#]*)?/i)?.[1];
        if (rawPath !== url.pathname) return null;
        const token = url.pathname.match(/^\/s\/([a-z0-9_-]+)$/i)?.[1];
        if (!token || token.length > RESOURCE_MAX_QUARK_TOKEN_LENGTH) return null;
        return {
            url: `${url.origin}${url.pathname}`,
            ...extractQuarkPasswordFromUrl(url)
        };
    } catch {
        return null;
    }
}

function collectQuarkUrls(text, maxEntries = RESOURCE_MAX_QUARK_URLS_TOTAL) {
    return collectQuarkEntries(text, maxEntries).map(item => item.url);
}

function normalizeResourcePageText(text) {
    return decodeHtmlEntities(text)
        .replace(/\\\//g, "/")
        .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/\\r\\n|\\[rn]/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/%3a/gi, ":")
        .replace(/<br\b[^<>]*>/gi, "\n")
        .replace(/<\/?(?:a|span|strong|b|em|i|code|font|u|small|mark)\b[^<>]*>/gi, tag => {
            // Keep the destination even when an anchor only says "下载". Inline
            // formatting and long attributes must not split a label from its code.
            const href = /^<a\b/i.test(tag)
                ? tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
                : null;
            return href ? `${href[1] ?? href[2] ?? href[3]} ` : "";
        });
}

function quarkPasswordContextDistance(text) {
    if (/https?:\/\/|<\/?(?:div|li|tr|section|article|header|footer|form|script|style|meta)\b|[\r\n]\s*[\r\n]/i.test(text)) {
        return Number.POSITIVE_INFINITY;
    }
    const blocks = text.match(/<\/?(?:p|td|th)\b[^<>]*>/gi)?.length || 0;
    const lines = text.match(/[\r\n]+/g)?.length || 0;
    return blocks * 10 + lines;
}

function mergeQuarkPassword(target, source) {
    const sourceRank = source._passwordRank || 0;
    const targetRank = target._passwordRank || 0;
    if (!sourceRank || sourceRank < targetRank) return false;
    if (sourceRank > targetRank) {
        target._passwordRank = sourceRank;
        target._passwordConflict = Boolean(source._passwordConflict);
        if (source.password && !target._passwordConflict) {
            target.password = source.password;
            return true;
        }
    } else if (!source._passwordConflict && !target._passwordConflict && source.password === target.password) {
        return false;
    }
    // Equal-confidence disagreement is not resolved by page order or repetition.
    // Preserve the link and let a higher-confidence URL password resolve it later.
    target._passwordConflict = true;
    delete target.password;
    return false;
}

function* iterateResourceLinks(text) {
    for (const match of text.matchAll(RESOURCE_LINK_PATTERN)) {
        const isQuark = /^(?:https?:\/\/)?(?:pan|drive)\.quark\.cn\/s\//i.test(match[0]);
        const rawQuark = isQuark && match[0].length <= RESOURCE_MAX_URL_LENGTH ? match[0] : null;
        const parsed = rawQuark ? parseQuarkUrl(rawQuark) : null;
        yield {
            index: match.index,
            end: match.index + match[0].length,
            url: parsed?.url,
            ...(parsed?.password ? { password: parsed.password } : {}),
            ...(parsed?.password || parsed?._passwordConflict ? {
                _passwordRank: 2, _passwordConflict: parsed._passwordConflict
            } : {})
        };
    }
}

function collectQuarkEntries(text, maxEntries = Number.POSITIVE_INFINITY, trackedUrls = null, extraEntries = null) {
    if (!text) return [];

    const normalizedText = normalizeResourcePageText(text);
    const links = iterateResourceLinks(normalizedText);
    const entries = new Map();
    const tracked = extraEntries instanceof Map ? extraEntries : null;
    const retainOccurrence = occurrence => {
        if (!occurrence?.url) return;
        const existing = entries.get(occurrence.url);
        if (existing) {
            mergeQuarkPassword(existing, occurrence);
        } else if (tracked?.has(occurrence.url)) {
            const trackedEntry = tracked.get(occurrence.url);
            if (trackedEntry) mergeQuarkPassword(trackedEntry, occurrence);
            else tracked.set(occurrence.url, {
                url: occurrence.url,
                ...(occurrence.password ? { password: occurrence.password } : {}),
                _passwordRank: occurrence._passwordRank,
                _passwordConflict: occurrence._passwordConflict
            });
        } else if (entries.size < maxEntries) {
            entries.set(occurrence.url, {
                url: occurrence.url,
                ...(occurrence.password ? { password: occurrence.password } : {}),
                _passwordRank: occurrence._passwordRank,
                _passwordConflict: occurrence._passwordConflict
            });
        } else if (tracked && trackedUrls?.has(occurrence.url)
            && (occurrence._passwordRank || occurrence._passwordConflict)) {
            tracked.set(occurrence.url, {
                url: occurrence.url,
                ...(occurrence.password ? { password: occurrence.password } : {}),
                _passwordRank: occurrence._passwordRank,
                _passwordConflict: occurrence._passwordConflict
            });
        }
    };
    let precedingLink = null;
    let followingLink = links.next().value;
    for (const match of normalizedText.matchAll(QUARK_PASSWORD_PATTERN)) {
        if (!isValidQuarkPassword(match[1])) continue;

        const passwordIndex = match.index;
        if (/(?:百度(?:网盘)?|迅雷|阿里(?:云盘|网盘)?|天翼(?:云盘)?|UC(?:网盘)?|115(?:网盘)?|123(?:云盘)?)(?=[\s:：()（）【】\x5B\x5D，、,]|$)[\s:：()（）【】\x5B\x5D，、,]*$/i.test(normalizedText.slice(Math.max(0, passwordIndex - 24), passwordIndex))) {
            continue;
        }
        while (followingLink && followingLink.end <= passwordIndex) {
            // Once another URL intervenes, future prose cannot belong to the
            // preceding occurrence. Retain its evidence without keeping every
            // foreign URL or duplicate share in a page-sized array.
            retainOccurrence(precedingLink);
            precedingLink = followingLink;
            followingLink = links.next().value;
        }
        // A label inside another URL's query is not prose for a nearby share.
        if (followingLink?.index <= passwordIndex) continue;
        const previous = precedingLink && passwordIndex - precedingLink.end <= 160 ? precedingLink : null;
        const next = followingLink && followingLink.index - (passwordIndex + match[0].length) <= 160 ? followingLink : null;
        const textBeforeNext = next
            ? normalizedText.slice(passwordIndex + match[0].length, next.index)
            : "";
        const previousDistance = previous
            ? quarkPasswordContextDistance(normalizedText.slice(previous.end, passwordIndex))
            : Number.POSITIVE_INFINITY;
        const nextDistance = next ? quarkPasswordContextDistance(textBeforeNext) : Number.POSITIVE_INFINITY;
        // Prefer the link in the same paragraph/line. On a tie, a following
        // password belongs to the preceding link, regardless of the next label.
        const target = nextDistance < previousDistance ? next : previousDistance < Number.POSITIVE_INFINITY ? previous : null;

        if (target?.url) mergeQuarkPassword(target, { password: match[1], _passwordRank: 1 });
    }

    retainOccurrence(precedingLink);
    while (followingLink) {
        retainOccurrence(followingLink);
        followingLink = links.next().value;
    }

    return Array.from(entries.values());
}

function resolveResourceUrl(rawUrl, baseUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length > RESOURCE_MAX_URL_LENGTH) return "";
    try {
        const url = new URL(decodeHtmlEntities(rawUrl), baseUrl);
        if (url.href.length > RESOURCE_MAX_URL_LENGTH || url.protocol !== "https:" || url.username || url.password || !RESOURCE_ALLOWED_ORIGINS.has(url.origin)) {
            return "";
        }
        return url.toString();
    } catch {
        return "";
    }
}

const RESOURCE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAllowedResource(resourceUrl, options = {}, deadline = null, wpzySession = null) {
    let currentUrl = resolveResourceUrl(resourceUrl, BY669_BASE);
    if (!currentUrl) throw new Error("Blocked untrusted resource URL");

    for (let redirects = 0; redirects <= RESOURCE_MAX_REDIRECTS; redirects++) {
        if (isDeadlineExpired(deadline)) throw createHttpError("Resource search timed out", 504);

        const currentOrigin = new URL(currentUrl).origin;
        assertWpzyReadOnlyUrl(currentUrl);
        const headers = new Headers(options.headers);
        headers.delete("Cookie");
        // These cookies are host-only: www.wpzy.org and other providers must not receive them.
        if (currentOrigin === WPZYS_BASE && wpzySession?.cookie) headers.set("Cookie", wpzySession.cookie);

        const response = await fetchUpstream(
            currentUrl,
            { ...options, headers, redirect: "manual" },
            remainingDeadlineMs(deadline, RESOURCE_TIMEOUT_MS)
        );
        if (!RESOURCE_REDIRECT_STATUSES.has(response.status)) return response;

        const location = response.headers.get("Location");
        const nextUrl = location ? resolveResourceUrl(location, currentUrl) : "";
        await releaseUpstreamResponse(response);
        if (!nextUrl) throw new Error("Blocked untrusted resource redirect");
        const nextOrigin = new URL(nextUrl).origin;
        assertWpzyReadOnlyUrl(nextUrl);
        if (nextOrigin !== currentOrigin && !(WPZY_ORIGINS.has(currentOrigin) && WPZY_ORIGINS.has(nextOrigin))) {
            throw createHttpError("Blocked cross-provider resource redirect", 502);
        }
        currentUrl = nextUrl;
    }

    throw new Error("Too many resource redirects");
}

// Resource titles are free text such as "《狂飙》2023 全39集" or
// "【美影】GT赛车：极速狂飙（2023）". A substring test accepts other works that
// merely contain the query ("极速狂飙", "F1：狂飙飞车"), so a match must start
// and end at a title boundary. Common release prefixes and suffixes count as
// boundaries; a trailing number other than a year names another work.
const RESOURCE_TITLE_PREFIX_PATTERN = /(?:电视剧|电影|剧集|连续剧|动漫|动画|番剧|纪录片|综艺|国产剧|国剧|美剧|英剧|韩剧|日剧|泰剧|港剧|台剧|剧|国漫|日漫|美漫|国影|美影|港影|日影|韩影|首发|主演|又名|片名|译名)$/u;

const RESOURCE_TITLE_SUFFIX_PATTERN = /^(?:第|全|共|电视剧|电影|剧集|连续剧|动漫|动画|国语|粤语|沪语|普通话|国配|国粤|中字|中英|双语|简繁|字幕|高清|超清|蓝光|原盘|杜比|修复|完结|已完结|完整|更新|夸克|百度|迅雷|阿里|网盘|年番|合集|系列|未删减|无删减|导演剪辑|加长|特别篇|番外|主演|又名|豆瓣|评分|季|部|集)/u;

const RESOURCE_SEPARATOR_PATTERN = /[\p{P}\p{S}\s]/u;

function createResourceTitlePattern(name) {
    const chars = Array.from(String(name || "").normalize("NFKC").toLowerCase().trim())
        .filter(char => !RESOURCE_SEPARATOR_PATTERN.test(char));
    if (chars.length === 0) return null;
    // Sites differ in punctuation and spacing inside a name: "哈利·波特",
    // "哈利波特" and "Spider-Man" / "Spider Man" name the same work.
    return new RegExp(chars.map(escapeRegExp).join("[\\p{P}\\p{S}\\s]{0,3}"), "gu");
}

// A series thread names its seasons after the title: "庆余年2 全36集",
// "庆余年1-2季", "鱿鱼游戏S03", "庆余年Ⅱ" (NFKC: "ii"). For a movie the same
// suffix names a sequel, so only series accept it; a numbered subtitle such
// as "斗破苍穹4：逃亡" is another work either way.
const RESOURCE_SEASON_SUFFIX_PATTERN = /^(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}(?:\s*[-~+]\s*\d{1,2})?(?:季|部|集)?|i{2,3}|iv)(?![\p{L}\p{N}])(?!\s*[:：])/u;

// Quality tags glued to a Han title: "长安的荔枝HDR", "繁花4K".
const RESOURCE_QUALITY_SUFFIX_PATTERN = /^(?:hdr|uhd|hd|bd|web|dv|4k|8k|1080|2160|720)/u;

export function createResourceTitleMatcher(names, mediaType = null) {
    const patterns = (Array.isArray(names) ? names : [names]).map(createResourceTitlePattern).filter(Boolean);
    if (patterns.length === 0) return () => false;
    const isWord = char => /[\p{L}\p{N}]/u.test(char || "");
    return title => {
        const text = String(title || "").normalize("NFKC").toLowerCase();
        for (const match of patterns.flatMap(pattern => Array.from(text.matchAll(pattern)))) {
            const before = text.slice(0, match.index);
            const after = text.slice(match.index + match[0].length);
            const previous = Array.from(before).at(-1);
            const next = Array.from(after)[0];
            const leftOk = !isWord(previous) || (/\p{N}/u.test(previous) && !/\p{N}/u.test(match[0][0]))
                || RESOURCE_TITLE_PREFIX_PATTERN.test(before);
            if (!leftOk) continue;
            if (!isWord(next)) return true;
            if (mediaType === "tv" && RESOURCE_SEASON_SUFFIX_PATTERN.test(after)) return true;
            if (/\p{Script=Han}/u.test(match[0].at(-1)) && RESOURCE_QUALITY_SUFFIX_PATTERN.test(after)) return true;
            if (/\p{N}/u.test(next)) {
                // "狂飙2023" carries a year; "流浪地球2" is a sequel.
                if (/^(?:19|20)\d{2}(?!\d)/u.test(after) || /^(?:4k|8k|1080|2160|720)/u.test(after)) return true;
                continue;
            }
            if (/\p{Script=Han}/u.test(next) && RESOURCE_TITLE_SUFFIX_PATTERN.test(after)) return true;
        }
        return false;
    };
}

// Movies need the release year, an adjacent year (posts often state the
// local release, e.g. a December premiere shown the next year) or a covered
// range such as "（2019-2023年）". Series threads usually state the latest
// season's year, so any later year, or no year at all, is consistent.
export function resourceTitleHasYear(text, releaseYear, mediaType = null) {
    if (!releaseYear) return true;
    // Share tokens, resolutions ("1920x1080") and bitrates are not years.
    const value = String(text || "")
        .replace(/https?:\/\/\S+|(?:pan|drive)\.quark\.cn\/s\/\S+/giu, " ")
        .replace(/\d{3,4}\s*[x×*]\s*\d{3,4}|\d+\s*kbps/giu, " ");
    const year = Number(releaseYear);
    for (const range of value.matchAll(/(?:^|\D)((?:19|20)\d{2})\s*(?:-|–|—|~|～|至|到)\s*((?:19|20)\d{2})(?!\d)/gu)) {
        if (Number(range[1]) - 1 <= year && year <= Number(range[2]) + 1) return true;
    }
    const years = Array.from(value.matchAll(/(?:^|\D)((?:19|20)\d{2})(?!\d)/gu), match => Number(match[1]));
    if (years.some(value => Math.abs(value - year) <= 1)) return true;
    return mediaType === "tv" && (years.length === 0 || years.some(value => value >= year));
}

function isQuarkResourceText(text) {
    return Boolean(text && (
        text.includes("夸克")
        || text.toLowerCase().includes("quark")
        || collectQuarkUrls(text, 1).length > 0
    ));
}

function mapResourcePageQuarkEntries(text, resourceTitle, sourceUrl, trackedUrls = null, extraEntries = null) {
    const entries = collectQuarkEntries(text, RESOURCE_MAX_QUARK_URLS_PER_PAGE, trackedUrls, extraEntries);
    const withSource = ({ url, password, _passwordRank, _passwordConflict }) => ({
            title: resourceTitle,
            url,
            ...(password ? { password } : {}),
            _passwordRank,
            _passwordConflict,
            sourceUrl,
            sourceTitle: resourceTitle
        });
    if (extraEntries) {
        for (const [url, entry] of extraEntries) extraEntries.set(url, withSource(entry));
    }
    return entries.map(withSource);
}

async function fetchResourcePageText(resourceUrl, referer = `${BY669_BASE}/`, deadline = null, wpzySession = null) {
    const safeResourceUrl = resolveResourceUrl(resourceUrl, BY669_BASE);
    if (!safeResourceUrl) throw createHttpError("Blocked untrusted resource URL", 502);

    const res = await fetchAllowedResource(safeResourceUrl, {
        headers: {
            "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": referer
        }
    }, deadline, wpzySession);

    if (!res.ok) {
        await releaseUpstreamResponse(res);
        if (new URL(safeResourceUrl).origin === WPZYS_BASE && res.status === 401) throw createResourceAccessError("login_required");
        throw createHttpError(`Resource page rejected with status ${res.status}`, res.status);
    }

    const text = await readTextWithLimit(res);
    if (!text.trim() || isChallengePage(text)) {
        throw createHttpError("Resource detail returned an empty or challenge page", 502);
    }
    if (isResourceFailurePage(text)) {
        throw createHttpError("Resource detail returned an unavailable page", 502);
    }
    if (WPZY_ORIGINS.has(new URL(safeResourceUrl).origin)) {
        if (isWpzyLoginPage(text)) throw createResourceAccessError("login_required");
        if (isWpzyRestrictedPage(text)) throw createResourceAccessError("access_restricted");
    }
    return { text, sourceUrl: safeResourceUrl };
}

async function fetchBy669Resources(query, deadline = null, releaseYear = "", mediaType = null, titleMatcher = null) {
    // By669 full-text search with an appended year takes several seconds
    // longer and returns the same threads, so filter the year locally.
    const res = await fetchAllowedResource(`${BY669_BASE}/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] }
    }, deadline);

    if (!res.ok) {
        await releaseUpstreamResponse(res);
        throw new Error(`By669 rejected with status ${res.status}`);
    }

    const data = JSON.parse(await readTextWithLimit(res));
    if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
        throw createHttpError("By669 returned an invalid response", 502);
    }
    const matchesTitle = await (titleMatcher || createResourceTitleMatcher(query, mediaType));
    const resources = [];

    for (const item of data.data.slice(0, RESOURCE_MAX_PROVIDER_RESULTS)) {
        if (!isObject(item) || !isObject(item.attributes) || typeof item.attributes.title !== "string" || !item.attributes.title.trim()) continue;
        const resourceId = typeof item.id === "string" || typeof item.id === "number"
            ? String(item.id).trim()
            : "";
        if (!resourceId || resourceId.length > 200) continue;

        const title = item.attributes.title.trim().slice(0, 300);
        if (!matchesTitle(title) || !resourceTitleHasYear(title, releaseYear, mediaType)) continue;

        resources.push({
            title,
            url: `${BY669_BASE}/d/${encodeURIComponent(resourceId)}`,
            isQuark: isQuarkResourceText(item.attributes.title),
            source: "by669"
        });
    }

    return resources;
}

// WPZY pads the highlighted keyword with spaces, turning "狂飙营救" into
// "狂飙 营救". Chinese titles do not separate words, so match without them.
function collapseHanSpaces(text) {
    return text.replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1");
}

function parseWpzysResources(html, query, releaseYear = "", mediaType = null, matchesTitle = createResourceTitleMatcher(query, mediaType)) {
    const resources = [];
    let hasResultItems = false;
    const seenUrls = new Set();
    const itemPattern = /<li\b[^<>]*\bdata-href=["']([^"'<>]*thread-\d+\.htm[^"'<>]*)["'][^<>]*>/gi;
    const itemEndPattern = /<\/li\s*>/gi;
    let match;

    while ((match = itemPattern.exec(html)) !== null) {
        itemEndPattern.lastIndex = itemPattern.lastIndex;
        const itemEnd = itemEndPattern.exec(html);
        if (!itemEnd) break;
        const block = html.slice(match.index, itemEndPattern.lastIndex);
        itemPattern.lastIndex = itemEndPattern.lastIndex;
        const rawUrl = match[1];
        if (rawUrl.length > 2048) continue;
        const resolvedUrl = resolveResourceUrl(rawUrl, WPZYS_BASE);
        if (!resolvedUrl) continue;
        const parsedUrl = new URL(resolvedUrl);
        if (!WPZY_ORIGINS.has(parsedUrl.origin) || !/^\/thread-\d+\.htm$/.test(parsedUrl.pathname)) continue;
        // Canonicalize aliases and remove query/fragment actions from scraped links.
        const url = new URL(parsedUrl.pathname, WPZYS_BASE).href;
        if (seenUrls.has(url)) continue;

        const threadPath = rawUrl.replace(/^\.\//, "").replace(/^\/+/, "").split("#")[0];
        const titlePattern = new RegExp(`<a\\b[^<>]*\\bhref=["'](?:\\./|/)?${threadPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^<>]*>`, "i");
        const titleMatch = titlePattern.exec(block) || /<a\b[^<>]*\bhref=["'][^"'<>]*thread-\d+\.htm[^"'<>]*["'][^<>]*>/i.exec(block);
        const titleEndPattern = /<\/a\s*>/gi;
        titleEndPattern.lastIndex = titleMatch ? titleMatch.index + titleMatch[0].length : block.length;
        const titleEnd = titleEndPattern.exec(block);
        const title = stripInlineHtml(titleEnd
            ? block.slice(titleMatch.index + titleMatch[0].length, titleEnd.index)
            : block).slice(0, 300).trim();

        if (!title) continue;
        hasResultItems = true;
        if (!matchesTitle(collapseHanSpaces(title)) || !resourceTitleHasYear(title, releaseYear, mediaType)) continue;
        if (!isQuarkResourceText(block)) continue;

        seenUrls.add(url);
        resources.push({
            title,
            url,
            isQuark: true,
            source: "wpzys"
        });
        if (resources.length >= RESOURCE_MAX_PROVIDER_RESULTS) break;
    }

    return { resources, hasResultItems };
}

function isResourceFailurePage(html) {
    const failure = /(?:网站|站点|系统|服务|網站|站點|系統|服務)\s*(?:正在)?\s*(?:维护|維護|升级|升級)(?=中|[\s.!?,:;|。！，：；-]|$)|维护中|維護中|temporarily unavailable|service unavailable|under maintenance|maintenance (?:mode|in progress)|too many requests|请求(?:过于|太)频繁|請求過於頻繁|访问受限|^maintenance$/iu;
    // Inspect status headings, not arbitrary post text: a valid resource may
    // itself discuss maintenance, outages, or request limits.
    for (const heading of html.matchAll(/<(?:title|h1)\b[^<>]*>([^<>]*)<\/(?:title|h1)\s*>/gi)) {
        if (failure.test(stripHtml(heading[1]))) return true;
    }
    const text = stripHtml(html);
    return text.length <= 500 && text.match(failure)?.index === 0;
}

function isWpzyEmptySearchPage(html) {
    // An empty response must be a recognized search result, not arbitrary
    // HTTP 200 HTML (maintenance pages and soft blocks often use that status).
    return /<form\b[^<>]*\bclass=["'][^"'<>]*\bfxz-search-panel\b[^"'<>]*["'][^<>]*>/i.test(html)
        && /<input\b[^<>]*\bname=["']keyword["'][^<>]*>/i.test(html)
        && /<div\b[^<>]*\bclass=["'][^"'<>]*\bfxz-search-meta\b[^"'<>]*["'][^<>]*>/i.test(html)
        && /<div\b[^<>]*\bclass=["'][^"'<>]*\bfxz-empty\b[^"'<>]*["'][^<>]*>/i.test(html)
        && /找到约\s*0\s*条结果/.test(stripHtml(html));
}

async function fetchWpzysResources(query, deadline = null, wpzySession = null, releaseYear = "", mediaType = null, titleMatcher = null) {
    const res = await fetchAllowedResource(`${WPZYS_BASE}/search.htm?keyword=${encodeURIComponent(query)}`, {
        headers: {
            "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": `${WPZYS_BASE}/search.htm`
        }
    }, deadline, wpzySession);

    if (!res.ok) {
        await releaseUpstreamResponse(res);
        if (res.status === 401) throw createResourceAccessError("login_required");
        throw new Error(`WPZY rejected with status ${res.status}`);
    }

    const html = await readTextWithLimit(res);
    if (!html.trim()) {
        throw createHttpError("WPZY returned an empty response", 502);
    }
    if (isChallengePage(html)) {
        throw createHttpError("WPZY returned a challenge page", 502);
    }
    if (isWpzyLoginPage(html)) throw createResourceAccessError("login_required");
    const parsed = parseWpzysResources(html, query, releaseYear, mediaType,
        await (titleMatcher || createResourceTitleMatcher(query, mediaType)));
    if (!parsed.hasResultItems && !isWpzyEmptySearchPage(html)) {
        throw createHttpError("WPZY returned an unrecognized search page", 502);
    }
    return parsed.resources;
}

const ZUIDOUYIN_MAX_HEADINGS = 200;

const ZUIDOUYIN_MAX_HEADING_LENGTH = 1000;

// Split a WordPress post body into work sections. A section starts at an
// h2-h6 heading and ends before the next heading of the same or higher level,
// so a collection post only contributes the shares listed under that work.
function extractZuidouyinSections(html) {
    const headings = [];
    const lower = html.toLowerCase();
    for (const match of html.matchAll(/<h([2-6])\b[^<>]*>/gi)) {
        if (headings.length >= ZUIDOUYIN_MAX_HEADINGS) break;
        const contentStart = match.index + match[0].length;
        const close = lower.indexOf(`</h${match[1]}`, contentStart);
        if (close < 0 || close - contentStart > ZUIDOUYIN_MAX_HEADING_LENGTH) continue;
        headings.push({
            level: Number(match[1]),
            start: match.index,
            heading: stripInlineHtml(html.slice(contentStart, close))
        });
    }
    return headings.map((entry, index) => {
        const next = headings.slice(index + 1).find(other => other.level <= entry.level);
        return { heading: entry.heading, html: html.slice(entry.start, next ? next.start : html.length) };
    });
}

async function fetchZuidouyinPosts(query, deadline, releaseYear, mediaType = null, titleMatcher = null) {
    const normalizedQuery = compactSearchText(query);
    if (!normalizedQuery) return [];
    // Share tokens may contain digits that look like a year; only prose counts.
    const hasYear = value => resourceTitleHasYear(value, releaseYear, mediaType);

    const url = new URL(ZUIDOUYIN_BASE);
    url.searchParams.set("rest_route", "/wp/v2/posts");
    // Titles state years as ranges such as "2017-2026", which a year search
    // term would miss. Fetch a few more posts and verify identity locally.
    url.searchParams.set("search", query);
    url.searchParams.set("per_page", ZUIDOUYIN_SEARCH_PAGE_SIZE);
    url.searchParams.set("_fields", "id,title,content");
    const response = await fetchUpstream(url.href, {
        headers: {
            "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"],
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
        },
        redirect: "manual"
    }, remainingDeadlineMs(deadline, RESOURCE_TIMEOUT_MS));
    if (!response.ok) {
        await releaseUpstreamResponse(response);
        throw new Error(`Zuidouyin rejected with status ${response.status}`);
    }
    const posts = JSON.parse(await readTextWithLimit(response));
    if (!Array.isArray(posts)) throw createHttpError("Zuidouyin returned an invalid response", 502);
    const namesWork = await (titleMatcher || createResourceTitleMatcher(query, mediaType));

    const matches = new Map();
    for (const post of posts.slice(0, ZUIDOUYIN_SEARCH_PAGE_SIZE)) {
        if (matches.size >= RESOURCE_MAX_ZUIDOUYIN_POSTS) break;
        if (!Number.isSafeInteger(post?.id) || post.id < 1 || matches.has(post.id)) continue;
        const rawTitle = post.title?.rendered;
        const content = post.content?.rendered;
        if (typeof rawTitle !== "string" || typeof content !== "string" || post.content.protected !== false) continue;
        const title = stripHtml(rawTitle).slice(0, 300).trim();
        if (!title || !content.trim()) continue;
        // WordPress also searches article bodies. Only the post title or a
        // work heading identifies a match, including alternate-language names.
        // Collection headings rarely repeat the year; accept it from the
        // post title, the heading or that work's own section.
        const text = namesWork(title) && hasYear(title)
            ? content
            : extractZuidouyinSections(content)
                .filter(section => namesWork(section.heading)
                    && hasYear(`${title}\n${section.heading}\n${stripHtml(section.html)}`))
                .map(section => section.html)
                .join("\n");
        if (!text || (!isQuarkResourceText(title) && !isQuarkResourceText(text))) continue;
        matches.set(post.id, {
            title, url: `${ZUIDOUYIN_BASE}/?p=${post.id}`, isQuark: true, source: "zuidouyin", text
        });
    }
    return [...matches.values()];
}

async function collectQuarkUrlsFromResources(resources, deadline = null, wpzySession = null) {
    const quarkUrls = [];
    const quarkUrlsByUrl = new Map();
    // The caller bounds fetched pages; prefetched posts are already bounded.
    const maxPages = Math.min(resources.length, RESOURCE_MAX_DETAIL_PAGES + RESOURCE_MAX_ZUIDOUYIN_POSTS);
    let failedPages = 0;
    let restrictedPages = 0;
    let loginRequiredPages = 0;
    let attemptedPages = 0;
    const pages = resources.map(entry => ({ url: entry.url, source: entry.source, status: "unattempted" }));
    const results = [];
    const fetchIndexes = [];
    for (let index = 0; index < maxPages; index++) {
        const entry = resources[index];
        // A post body returned with the search result is evidence already in
        // hand; an exhausted deadline must not discard it.
        if (!isPrefetchedResource(entry)) {
            fetchIndexes.push(index);
            continue;
        }
        attemptedPages++;
        results[index] = { status: "fulfilled", value: { text: entry.text, sourceUrl: entry.url } };
    }
    let nextFetch = 0;
    async function scanPages() {
        while (nextFetch < fetchIndexes.length && !isDeadlineExpired(deadline)) {
            const index = fetchIndexes[nextFetch++];
            const entry = resources[index];
            attemptedPages++;
            try {
                const value = await fetchResourcePageText(entry.url,
                    entry.source === "wpzys" ? `${WPZYS_BASE}/` : `${BY669_BASE}/`, deadline, wpzySession);
                results[index] = { status: "fulfilled", value };
            } catch (reason) {
                results[index] = { status: "rejected", reason };
            }
        }
    }
    // Scan the entire fixed page selection before enforcing the response cap.
    // This keeps duplicate-password conflict checks independent of response timing.
    await Promise.all(Array.from({ length: Math.min(RESOURCE_DETAIL_CONCURRENCY, fetchIndexes.length) }, scanPages));

    for (const [index, group] of results.entries()) {
        if (!group) continue;
        const page = pages[index];
        if (group.status !== "fulfilled" || typeof group.value?.text !== "string") {
            failedPages += 1;
            if (group.reason?.resourceIssue === "access_restricted") restrictedPages += 1;
            if (group.reason?.resourceIssue === "login_required") loginRequiredPages += 1;
            page.status = group.reason?.resourceIssue === "access_restricted" ? "restricted"
                : group.reason?.resourceIssue === "login_required" ? "login_required" : "failed";
            continue;
        }

        page.status = "ok";
        const resource = resources[index];
        const primaryEntries = mapResourcePageQuarkEntries(group.value.text, resource.title, group.value.sourceUrl);
        for (const item of primaryEntries) {
            if (!item.url) continue;
            const existing = quarkUrlsByUrl.get(item.url);
            if (existing) {
                if (mergeQuarkPassword(existing, item)) {
                    existing.title = item.title;
                    existing.sourceUrl = item.sourceUrl;
                    existing.sourceTitle = item.sourceTitle;
                }
                continue;
            }
            // The cap limits new results, not reconciliation of duplicates
            // from pages whose requests have already started.
            if (quarkUrls.length >= RESOURCE_MAX_QUARK_URLS_TOTAL) continue;
            const entry = { ...item };
            quarkUrlsByUrl.set(item.url, entry);
            quarkUrls.push(entry);
        }
    }

    // Reconcile later occurrences of globally retained shares even when they
    // fall beyond another page's 25 new-share sampling limit. Keep the extra
    // evidence in page snapshots so future partial refreshes can reconcile it.
    const retainedUrls = new Set(quarkUrlsByUrl.keys());
    for (const [index, group] of results.entries()) {
        if (group?.status !== "fulfilled" || typeof group.value?.text !== "string") continue;
        const resource = resources[index];
        const extraEntries = new Map();
        const pageEntries = mapResourcePageQuarkEntries(
            group.value.text,
            resource.title,
            group.value.sourceUrl,
            retainedUrls,
            extraEntries
        );
        pages[index].quarkUrls = [...pageEntries, ...extraEntries.values()]
            .map(item => serializeQuarkEntry(item, { includeRank: true }));

        for (const item of extraEntries.values()) {
            const existing = quarkUrlsByUrl.get(item.url);
            if (!existing) continue;
            if (mergeQuarkPassword(existing, item)) {
                existing.title = item.title;
                existing.sourceUrl = item.sourceUrl;
                existing.sourceTitle = item.sourceTitle;
            }
        }
        group.value = null;
    }

    return {
        quarkUrls: quarkUrls.map(item => serializeQuarkEntry(item)),
        pages,
        attemptedPages,
        failedPages,
        restrictedPages,
        loginRequiredPages
    };
}

function serializeQuarkEntry({ title, url, password, sourceUrl, sourceTitle, _passwordRank, _passwordConflict }, { includeRank = false } = {}) {
    return {
        title, url, ...(password && !_passwordConflict ? { password } : {}), sourceUrl, sourceTitle,
        ...(_passwordConflict ? { passwordConflict: true } : {}),
        ...(includeRank && _passwordRank ? { passwordRank: _passwordRank } : {})
    };
}

// Entries that already carry their post body cost no request, so only pages
// that must be fetched count toward the detail-page budget. Interleaving keeps
// every provider represented before the response-wide share cap applies.
const isPrefetchedResource = entry => typeof entry?.text === "string";

// Forums repost the same release under identical titles. Scan distinct
// titles first so reposts only use detail slots that would otherwise be idle.
function preferDistinctTitles(resources) {
    const seen = new Set();
    const distinct = [];
    const reposts = [];
    for (const entry of resources) {
        const key = compactSearchText(entry.title);
        (seen.has(key) ? reposts : distinct).push(entry);
        seen.add(key);
    }
    return [...distinct, ...reposts];
}

function selectResourceDetails(...groups) {
    const selected = [];
    let fetchedPages = 0;
    for (let index = 0; groups.some(group => index < group.length); index++) {
        for (const group of groups) {
            if (index >= group.length) continue;
            const entry = group[index];
            if (!isPrefetchedResource(entry)) {
                if (fetchedPages >= RESOURCE_MAX_DETAIL_PAGES) continue;
                fetchedPages += 1;
            }
            selected.push(entry);
        }
    }
    return selected;
}

export async function handleResourceSearch(query, env, ctx, { refresh = false, cacheOnly = false, id = null, mediaType = null, year = null } = {}) {
    const queryCheck = validateRequiredText(query, "query", MAX_MEDIA_TITLE_LENGTH);
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const idCheck = id === null ? null : validatePositiveInteger(id);
    if (idCheck?.error) return idCheck.error;
    const mediaTypeCheck = mediaType === null ? null : validatePersonMediaType(mediaType);
    if (mediaTypeCheck?.error) return mediaTypeCheck.error;
    if (Boolean(idCheck) !== Boolean(mediaTypeCheck)) {
        return jsonResponse({ error: "TMDB id and media type must be provided together" }, 400);
    }
    const yearCheck = validateOptionalYear(year);
    if (yearCheck.error) return yearCheck.error;
    const identity = {
        id: idCheck ? Number(idCheck.value) : null,
        mediaType: mediaTypeCheck?.value || null,
        year: yearCheck.value
    };

    const wpzySession = await getWpzySession(env);

    const options = { refresh, cacheOnly, wpzySession, identity, env };
    const response = cacheOnly
        ? await handleResourceSearchUncoalesced(query, ctx, options)
        : await withInFlight(
            ctx,
            `resource:${wpzySession.cacheScope}:${refresh ? "refresh:" : ""}${query}:${JSON.stringify(identity)}`,
            () => handleResourceSearchUncoalesced(query, ctx, options)
        );
    const clientResponse = response.clone();
    // The internal cache is keyed by the server's login state. Browser caches
    // cannot observe that scope, so never let them retain account-derived data.
    const headers = new Headers(clientResponse.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(clientResponse.body, {
        status: clientResponse.status, statusText: clientResponse.statusText, headers
    });
}

const RESOURCE_ALIAS_TIMEOUT_MS = 3000;

const RESOURCE_MAX_ALIASES = 8;

const RESOURCE_ALIAS_REGIONS = new Set(["CN", "TW", "HK", "MO", "SG", "US", "GB"]);

// Forum posts may name a work by its original or regional title ("哪吒2",
// "駭客任務", "The Matrix"). Names come from TMDB for the selected identity;
// the lookup is cached and bounded so it never delays the provider searches.
async function getResourceTitleAliases(query, identity, env, ctx) {
    if (!identity.id || !identity.mediaType || !getTmdbAuth(env)) return [];
    const deadline = createDeadline(RESOURCE_ALIAS_TIMEOUT_MS);
    const path = `/${identity.mediaType}/${identity.id}`;
    const [detail, alternatives] = await Promise.allSettled([
        // Same request as the detail page, so it is normally a cache hit.
        fetchTmdbJson(path, { language: "zh-CN", append_to_response: "external_ids,credits" }, env, ctx, { deadline }),
        fetchTmdbJson(`${path}/alternative_titles`, {}, env, ctx, { deadline })
    ]);
    const names = [];
    if (detail.status === "fulfilled") {
        names.push(detail.value.title, detail.value.name, detail.value.original_title, detail.value.original_name);
    }
    if (alternatives.status === "fulfilled") {
        const list = alternatives.value?.titles || alternatives.value?.results;
        for (const item of Array.isArray(list) ? list : []) {
            if (RESOURCE_ALIAS_REGIONS.has(item?.iso_3166_1)) names.push(item.title);
        }
    }
    const seen = new Set([compactSearchText(query)]);
    const aliases = [];
    for (const name of names) {
        if (typeof name !== "string" || name.length > MAX_QUERY_LENGTH) continue;
        const compact = compactSearchText(name);
        // Short Latin names ("F1", "Up") match too many unrelated posts.
        if (!compact || seen.has(compact) || (/^[\p{Script=Latin}\d]+$/u.test(compact) ? compact.length < 4 : compact.length < 2)) continue;
        seen.add(compact);
        aliases.push(name.trim());
        if (aliases.length >= RESOURCE_MAX_ALIASES) break;
    }
    return aliases;
}

async function handleResourceSearchUncoalesced(query, ctx, { refresh = false, cacheOnly = false, wpzySession, identity = {}, env = {} } = {}) {
    const queryCheck = validateRequiredText(query, "query", MAX_MEDIA_TITLE_LENGTH);
    if (queryCheck.error) return queryCheck.error;
    query = queryCheck.value;

    const cacheKey = new Request(`https://resource-search-v19-cache.local/?q=${encodeURIComponent(query)}&id=${identity.id || ""}&type=${identity.mediaType || ""}&year=${identity.year || ""}&scope=${wpzySession.cacheScope}`);
    const cached = await serveCachedJson(cacheKey);
    if (cached && !refresh) return cached;
    if (cacheOnly) return jsonResponse({ error: "资源结果已过期或暂不可读，请重新扫描。" }, 410);

    let previousComplete = null;
    if (refresh && cached) {
        try {
            const previousData = await readJsonWithLimit(cached.clone());
            if (!previousData.partial && !previousData.resourceMeta?.partial) previousComplete = cached;
        } catch {
            // Ignore malformed cache entries and let the refreshed scan replace them.
        }
    }

    try {
        const deadline = createDeadline(RESOURCE_TOTAL_TIMEOUT_MS);
        // Search by title only; each provider verifies the year in its titles
        // and accepts the work's aliases once it has its own response.
        const titleMatcher = getResourceTitleAliases(query, identity, env, ctx)
            .catch(() => [])
            .then(aliases => createResourceTitleMatcher([query, ...aliases], identity.mediaType));
        const [by669Result, wpzysResult, zuidouyinResult] = await Promise.allSettled([
            fetchBy669Resources(query, deadline, identity.year, identity.mediaType, titleMatcher),
            fetchWpzysResources(query, deadline, wpzySession, identity.year, identity.mediaType, titleMatcher),
            fetchZuidouyinPosts(query, deadline, identity.year, identity.mediaType, titleMatcher)
        ]);

        const providerResults = Object.entries({ by669: by669Result, wpzys: wpzysResult, zuidouyin: zuidouyinResult });
        const failedProviders = providerResults.filter(([, result]) => result.status === "rejected");
        if (failedProviders.length === providerResults.length) {
            logEvent("warn", "resource_providers_failed",
                Object.fromEntries(failedProviders.map(([source, result]) => [source, logErrorMessage(result.reason)])));
            // A forced refresh must not replace a usable cached answer with an error.
            if (refresh && cached) return withStaleMarker(cached);
            return jsonResponse({ error: "Resource providers unavailable" }, 502);
        }

        const resources = by669Result.value ?? [];
        const wpzysResources = wpzysResult.value ?? [];
        const zuidouyinPosts = zuidouyinResult.value ?? [];
        const zuidouyinResources = zuidouyinPosts.map(({ title, url, isQuark, source }) => ({ title, url, isQuark, source }));
        const detailResources = selectResourceDetails(
            preferDistinctTitles(resources),
            preferDistinctTitles(wpzysResources).slice(0, RESOURCE_MAX_WPZY_DETAIL_PAGES),
            zuidouyinPosts
        );
        const detailResult = await collectQuarkUrlsFromResources(detailResources, deadline, wpzySession);
        const selectedUrls = new Set(detailResult.pages.map(page => page.url));
        const unselectedPages = [...resources, ...wpzysResources, ...zuidouyinResources]
            .filter(entry => !selectedUrls.has(entry.url))
            .map(({ url, source }) => ({ url, source, status: "unattempted" }));

        const isPartial = failedProviders.length > 0
            || detailResult.failedPages > 0
            || detailResult.attemptedPages < detailResources.length;
        const result = {
            resources,
            wpzysResources,
            zuidouyinResources,
            quarkUrls: detailResult.quarkUrls,
            partial: isPartial,
            resourceMeta: {
                partial: isPartial,
                providers: Object.fromEntries(providerResults.map(([source, result]) =>
                    [source, result.status === "fulfilled" ? "ok" : "failed"])),
                providerIssues: wpzysResult.status === "rejected"
                    ? { wpzys: wpzysResult.reason?.resourceIssue === "login_required" ? "login_required" : "upstream_unavailable" }
                    : {},
                selectedPages: detailResources.length,
                attemptedPages: detailResult.attemptedPages,
                failedPages: detailResult.failedPages,
                restrictedPages: detailResult.restrictedPages,
                loginRequiredPages: detailResult.loginRequiredPages,
                // The client rebuilds the capped list from this evidence.
                pages: [...detailResult.pages, ...unselectedPages]
            }
        };
        const cacheContext = isPartial && previousComplete ? null : ctx;
        // Links for a new release appear within hours: recheck an empty scan sooner.
        const maxAge = isPartial ? 900 : detailResult.quarkUrls.length === 0 ? 1800 : 43200;
        return cacheJson(cacheContext, cacheKey, result, maxAge, { maxBytes: RESOURCE_MAX_RESPONSE_BYTES });
    } catch (e) {
        if (refresh && cached) return withStaleMarker(cached);
        return errorResponse(e);
    }
}

function withStaleMarker(response) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-iPlay-Stale", "1");
    return new Response(response.body, { status: response.status, headers });
}
