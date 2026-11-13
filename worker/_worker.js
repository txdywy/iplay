/**
 * Cloudflare Worker - iPlay API proxy. Routes requests and runs the scheduled refresh.
 */

import { RELEASE_VERSION } from '../js/release.js';
import {
    checkRateLimit,
    errorResponse,
    forEachWithConcurrency,
    getErrorStatus,
    isObject,
    jsonResponse,
    logErrorMessage,
    logEvent
} from './core.js';
import {
    handleDoubanDetail,
    handleDoubanSearch
} from './douban.js';
import {
    handlePosterSearch
} from './poster.js';
import {
    handleResourceSearch
} from './resources.js';
import {
    fetchTmdbJson,
    handleTmdbDetail,
    handleTmdbPersonSearch,
    handleTmdbSearch,
    pickBestTmdbPosterCandidate
} from './tmdb.js';
import {
    TELEGRAM_SETUP_PATH,
    TELEGRAM_WEBHOOK_PATH,
    handleTelegramSetup,
    handleTelegramWebhook
} from './telegram.js';
import {
    handleWikiZh
} from './wiki.js';

const ALLOWED_ORIGINS = [
    "https://iplay.hackx64.eu.org",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://localhost:3000",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
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
    headers.set("X-iPlay-Version", RELEASE_VERSION);
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
                    "X-iPlay-Version": RELEASE_VERSION,
                }
            });
        }

        const requestPath = new URL(request.url).pathname.replace(/\/+$/, "");
        // Telegram posts updates from shared IPs; the webhook authenticates
        // with its secret header and rate-limits per Telegram user instead.
        if (requestPath === TELEGRAM_WEBHOOK_PATH) {
            try {
                return await handleTelegramWebhook(request, env, ctx);
            } catch (error) {
                logEvent("error", "telegram_webhook_failed", { error: logErrorMessage(error) });
                return errorResponse(error, 500);
            }
        }

        if (request.method !== "GET" && requestPath !== TELEGRAM_SETUP_PATH) {
            return withCors(jsonResponse({ error: "Method Not Allowed" }, 405, {
                Allow: "GET, OPTIONS"
            }), request, env);
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || url.pathname;
        const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
        try {
            const rateLimitDecision = await checkRateLimit(clientIp, path, env);
            if (rateLimitDecision === null) {
                return withCors(jsonResponse({ error: "Rate limiter unavailable. Try again later." }, 503, {
                    "Retry-After": "60"
                }), request, env);
            }
            if (!rateLimitDecision) {
                return withCors(jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429, {
                    "Retry-After": "60"
                }), request, env);
            }

            if (path === "/api/tmdb/search") {
                return withCors(await handleTmdbSearch(url.searchParams.get("q"), env, ctx), request, env);
            }

            if (path === "/api/tmdb/person") {
                return withCors(await handleTmdbPersonSearch(
                    url.searchParams.get("q"),
                    env,
                    ctx,
                    {
                        personId: url.searchParams.get("id"),
                        offset: url.searchParams.get("offset"),
                        limit: url.searchParams.get("limit"),
                        mediaType: url.searchParams.get("mediaType"),
                        sort: url.searchParams.get("sort")
                    }
                ), request, env);
            }

            if (path === "/api/tmdb/detail") {
                return withCors(await handleTmdbDetail(
                    url.searchParams.get("id"),
                    url.searchParams.get("type"),
                    url.searchParams.get("season"),
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
                return withCors(await handleResourceSearch(
                    url.searchParams.get("q"),
                    env,
                    ctx,
                    {
                        refresh: url.searchParams.get("refresh") === "1",
                        id: url.searchParams.get("id"),
                        mediaType: url.searchParams.get("type"),
                        year: url.searchParams.get("year")
                    }
                ), request, env);
            }

            if (path === "/api/poster") {
                return withCors(await handlePosterSearch(
                    url.searchParams.get("title"),
                    url.searchParams.get("year"),
                    env,
                    ctx,
                    {
                        refresh: url.searchParams.get("refresh") === "1",
                        tmdbId: url.searchParams.get("id"),
                        mediaType: url.searchParams.get("type"),
                        imdbId: url.searchParams.get("imdb")
                    }
                ), request, env);
            }

            if (path === TELEGRAM_SETUP_PATH) {
                return await handleTelegramSetup(request, env);
            }

            if (path === "/api/wiki/zh") {
                return withCors(await handleWikiZh(url.searchParams.get("q"), ctx, {
                    mediaType: url.searchParams.get("type"),
                    year: url.searchParams.get("year"),
                    id: url.searchParams.get("id"),
                    env
                }), request, env);
            }

            return withCors(jsonResponse({ error: "Not Found" }, 404), request, env);
        } catch (error) {
            logEvent("error", "request_failed", { path, error: logErrorMessage(error), status: getErrorStatus(error) });
            return withCors(errorResponse(error, 500), request, env);
        }
    },

    async scheduled(event, env, ctx) {
        logEvent("log", "scheduled_refresh_started", { scheduledTime: new Date(event.scheduledTime).toISOString() });
        ctx.waitUntil(refreshScheduledData(env, ctx));
    }
};

const SCHEDULED_REFRESH_CONCURRENCY = 4;

const MAX_SCHEDULED_REFRESH_TITLES = 20;

async function refreshScheduledData(env, ctx) {
    const titles = getScheduledRefreshTitles(env);
    if (titles.length === 0) return;

    await forEachWithConcurrency(titles, SCHEDULED_REFRESH_CONCURRENCY, title => refreshTitleData(title, env, ctx));
}

function getScheduledRefreshTitles(env) {
    // Refresh only titles the operator configured; there is no built-in list.
    const rawTitles = typeof env?.CRON_REFRESH_TITLES === "string" ? env.CRON_REFRESH_TITLES : "";
    return rawTitles
        .split(",")
        .map(title => title.trim())
        .filter(Boolean)
        .slice(0, MAX_SCHEDULED_REFRESH_TITLES);
}

async function refreshTitleData(title, env, ctx) {
    const searchData = await fetchTmdbJson("/search/multi", {
        query: title,
        language: "zh-CN",
        include_adult: "false",
        page: "1"
    }, env, ctx, { refreshCache: true });

    const candidates = Array.isArray(searchData.results)
        ? searchData.results.filter(item => isObject(item) && (item.media_type === "movie" || item.media_type === "tv"))
        : [];
    const best = pickBestTmdbPosterCandidate(candidates, title, null);
    if (!best) return;

    await fetchTmdbJson(`/${best.media_type}/${best.id}`, {
        language: "zh-CN",
        append_to_response: "external_ids,credits"
    }, env, ctx, { refreshCache: true }).catch(() => null);
}
