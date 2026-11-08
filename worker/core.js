/**
 * Shared Worker infrastructure: JSON responses, validation, errors, bounded upstream I/O, caching, rate limits and text helpers.
 */

import { RELEASE_VERSION } from '../js/release.js';

export function jsonResponse(data, status = 200, extraHeaders = {}) {
    const headers = new Headers({
        "Content-Type": "application/json;charset=UTF-8",
        "Cache-Control": "no-store"
    });
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);

    return new Response(JSON.stringify(data), {
        status,
        headers
    });
}

export function logErrorMessage(error) {
    return String(error?.message || error || "Unknown error")
        .replace(/([?&](?:api_key|apikey|access_token|token)=)[^&\s]+/giu, "$1[REDACTED]")
        .replace(/(\bbbs_(?:token|sid)\s*=\s*)[^;\s"<>]+/giu, "$1[REDACTED]")
        .replace(/(\b(?:Bearer|Basic)\s+)[^\s;,"<>]+/giu, "$1[REDACTED]")
        .slice(0, 500);
}

export function logEvent(level, event, details = {}) {
    console[level](JSON.stringify({ event, version: RELEASE_VERSION, ...details }));
}

export const MAX_QUERY_LENGTH = 100;

export const MAX_MEDIA_TITLE_LENGTH = 300;

export function validateRequiredText(value, label, maxLength = MAX_QUERY_LENGTH) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { error: jsonResponse({ error: `Missing ${label}` }, 400) };
    if ([...text].length > maxLength) {
        return { error: jsonResponse({ error: `${label} is too long` }, 400) };
    }
    return { value: text };
}

export function validatePositiveInteger(value, label = "id") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { error: jsonResponse({ error: `Missing ${label}` }, 400) };
    if (!/^[1-9]\d{0,11}$/.test(text)) {
        return { error: jsonResponse({ error: `Invalid ${label}` }, 400) };
    }
    return { value: text };
}

export function validateImdbId(value) {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!text) return { error: jsonResponse({ error: "Missing imdb id" }, 400) };
    if (!/^tt\d{5,12}$/.test(text)) {
        return { error: jsonResponse({ error: "Invalid imdb id" }, 400) };
    }
    return { value: text };
}

export function validateMediaType(value) {
    if (value === null || value === undefined) return { value: "movie" };
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (text !== "movie" && text !== "tv") {
        return { error: jsonResponse({ error: "Invalid media type" }, 400) };
    }
    return { value: text };
}

export function validateOptionalYear(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { value: "" };
    if (!/^\d{4}$/.test(text)) {
        return { error: jsonResponse({ error: "Invalid year" }, 400) };
    }
    return { value: text };
}

const publicHttpErrors = new WeakMap();

export function createHttpError(message, status = 500, publicMessage = message) {
    const error = new Error(message);
    error.status = status;
    // Only application-created errors have public messages. Provider-supplied
    // diagnostics must pass a separate, fixed publicMessage at their boundary.
    publicHttpErrors.set(error, publicMessage);
    return error;
}

// Upstream credential statuses describe the Worker's own requests, not the
// visitor's: a revoked TMDB key must not reach the browser as its own 401/403.
function toClientErrorStatus(status) {
    return status === 401 || status === 403 || status === 407 ? 502 : status;
}

export function errorResponse(error, fallbackStatus = 502) {
    const upstreamStatus = getErrorStatus(error, fallbackStatus);
    const status = toClientErrorStatus(upstreamStatus);
    const publicMessage = error && typeof error === "object" ? publicHttpErrors.get(error) : null;
    return jsonResponse({ error: publicMessage || (status === 504
        ? "Upstream request timed out"
        : status === 500 ? "Internal Server Error" : "Upstream service unavailable") },
    status, status === 429 || status === 503 ? { "Retry-After": "60" } : {});
}

export const UPSTREAM_TIMEOUT_MS = 10000;

export const FALLBACK_TOTAL_TIMEOUT_MS = 11000;

const MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;

const upstreamResponseMeta = new WeakMap();

// Execution contexts own their I/O. Never share a Response, timer, deadline or
// cache-write lifetime between separate Worker invocations.
const inFlightByContext = new WeakMap();

export function withInFlight(ctx, key, task) {
    if (!ctx || typeof ctx !== "object") return Promise.resolve().then(task);
    let inFlightRequests = inFlightByContext.get(ctx);
    if (!inFlightRequests) {
        inFlightRequests = new Map();
        inFlightByContext.set(ctx, inFlightRequests);
    }
    const existing = inFlightRequests.get(key);
    if (existing) return existing;

    const promise = Promise.resolve().then(task);
    inFlightRequests.set(key, promise);
    promise.then(
        () => { if (inFlightRequests.get(key) === promise) inFlightRequests.delete(key); },
        () => { if (inFlightRequests.get(key) === promise) inFlightRequests.delete(key); }
    );
    return promise;
}

export function getErrorStatus(error, fallback = 500) {
    return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : fallback;
}

export async function fetchUpstream(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
    const controller = new AbortController();
    const meta = {
        controller,
        timedOut: false,
        timeoutId: setTimeout(() => {
            meta.timedOut = true;
            controller.abort();
        }, timeoutMs)
    };
    let response = null;

    try {
        const fetchedResponse = await fetch(url, { ...options, signal: controller.signal });
        if (!fetchedResponse || typeof fetchedResponse !== "object") {
            throw new Error("Upstream returned an invalid response");
        }
        response = fetchedResponse;
        upstreamResponseMeta.set(response, meta);
        return response;
    } catch (error) {
        if (error.name === "AbortError") {
            throw createHttpError("Upstream request timed out", 504);
        }
        throw error;
    } finally {
        if (!response) clearTimeout(meta.timeoutId);
    }
}

export async function releaseUpstreamResponse(response) {
    const meta = upstreamResponseMeta.get(response);
    if (meta) {
        clearTimeout(meta.timeoutId);
        upstreamResponseMeta.delete(response);
    }

    try {
        if (response && response.body) await response.body.cancel();
    } catch {
        // The response is already being discarded.
    }
}

export async function readTextWithLimit(response, maxBytes = MAX_UPSTREAM_BODY_BYTES) {
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await releaseUpstreamResponse(response);
        throw createHttpError("Upstream response is too large", 502);
    }

    if (!response.body) {
        await releaseUpstreamResponse(response);
        return "";
    }

    let reader = null;
    const decoder = new TextDecoder();
    let totalSize = 0;
    let text = "";

    try {
        reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalSize += value.byteLength;
            if (totalSize > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    // The body is already over the configured limit.
                }
                throw createHttpError("Upstream response is too large", 502);
            }
            text += decoder.decode(value, { stream: true });
        }
    } catch (error) {
        const meta = upstreamResponseMeta.get(response);
        if (error.name === "AbortError" || meta?.timedOut) {
            throw createHttpError("Upstream request timed out", 504);
        }
        throw error;
    } finally {
        const meta = upstreamResponseMeta.get(response);
        if (meta) {
            clearTimeout(meta.timeoutId);
            upstreamResponseMeta.delete(response);
        }
        if (reader) {
            try {
                reader.releaseLock();
            } catch {
                // The reader may already have released its lock.
            }
        }
    }

    return text + decoder.decode();
}

export async function readJsonWithLimit(response, maxBytes = MAX_UPSTREAM_BODY_BYTES) {
    return JSON.parse(await readTextWithLimit(response, maxBytes));
}

export async function serveCachedJson(cacheKey) {
    try {
        return await caches.default.match(cacheKey);
    } catch (error) {
        logEvent("warn", "cache_read_failed", { error: logErrorMessage(error) });
        return null;
    }
}

export async function deleteCachedResponse(cacheKey) {
    try {
        if (typeof caches.default.delete === "function") await caches.default.delete(cacheKey);
    } catch (error) {
        logEvent("warn", "cache_delete_failed", { error: logErrorMessage(error) });
    }
}

export function scheduleCachePut(ctx, cacheKey, response) {
    if (!ctx || typeof ctx.waitUntil !== "function") return;

    const write = Promise.resolve()
        .then(() => caches.default.put(cacheKey, response))
        .catch(error => logEvent("warn", "cache_write_failed", { error: logErrorMessage(error) }));

    try {
        ctx.waitUntil(write);
    } catch (error) {
        logEvent("warn", "cache_wait_until_failed", { error: logErrorMessage(error) });
    }
}

export function cacheJson(ctx, cacheKey, data, maxAge, { maxBytes = null } = {}) {
    const body = JSON.stringify(data);
    if (maxBytes && new globalThis.TextEncoder().encode(body).byteLength > maxBytes) {
        throw createHttpError("Aggregated response is too large", 502);
    }
    const response = new Response(body, { headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Cache-Control": `public, max-age=${maxAge}`
    } });
    const toCache = response.clone();
    scheduleCachePut(ctx, cacheKey, toCache);
    return response;
}

export function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

const _rateLimitMap = new Map();

const RATE_LIMIT = 60;

const RATE_WINDOW = 60000;

const RATE_LIMIT_MAX_ENTRIES = 10000;

const RATE_LIMIT_CLEANUP_BATCH = 100;

function checkLocalRateLimit(key, limit = RATE_LIMIT) {
    const now = Date.now();

    if (_rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES && !_rateLimitMap.has(key)) {
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

    const entry = _rateLimitMap.get(key);
    if (!entry || now - entry.start > RATE_WINDOW) {
        _rateLimitMap.set(key, { start: now, count: 1 });
        return true;
    }
    entry.count++;
    return entry.count <= limit;
}

export async function checkRateLimit(ip, path, env) {
    const isResourceRoute = path === "/api/resource";
    const routeKey = isResourceRoute ? "resource" : "api";
    const binding = isResourceRoute ? env?.RESOURCE_RATE_LIMITER : env?.API_RATE_LIMITER;

    if (binding) {
        if (typeof binding.limit !== "function") {
            logEvent("error", "rate_limiter_binding_invalid");
            return null;
        }
        try {
            const result = await binding.limit({ key: `${ip}:${routeKey}` });
            if (!result || typeof result.success !== "boolean") {
                logEvent("error", "rate_limiter_result_invalid");
                return null;
            }
            return result.success;
        } catch (error) {
            logEvent("error", "rate_limiter_failed", { error: logErrorMessage(error) });
            return null;
        }
    }

    const requiresDistributedLimiter = String(env?.ENVIRONMENT || "").toLowerCase() === "production"
        || String(env?.REQUIRE_DISTRIBUTED_RATE_LIMIT || "").toLowerCase() === "true";
    if (requiresDistributedLimiter) {
        logEvent("error", "rate_limiter_binding_missing");
        return null;
    }

    return checkLocalRateLimit(`${routeKey}:${ip}`, isResourceRoute ? 10 : RATE_LIMIT);
}

export async function forEachWithConcurrency(items, concurrency, task) {
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;

            try {
                await task(items[index], index);
            } catch (error) {
                logEvent("warn", "scheduled_refresh_failed", { error: logErrorMessage(error) });
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

export function normalizeMatchText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\s\-_:,.!?()[\]{}'"“”‘’·、，。/\\]/g, "");
}

export function normalizeSearchInput(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .replace(/[‐‑‒–—]/gu, "-")
        .replace(/\u00a0/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

export function compactSearchText(value) {
    return normalizeSearchInput(value)
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function uniqueSearchValues(values, maxLength = 100, maxValues = 6) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = normalizeSearchInput(value);
        if (!normalized || [...normalized].length > maxLength || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
        if (result.length >= maxValues) break;
    }
    return result;
}

const NAMED_HTML_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

export function decodeHtmlEntities(value) {
    if (!value) return "";

    const codePoint = (code, radix) => {
        const number = Number.parseInt(code, radix);
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
            ? String.fromCodePoint(number) : "\uFFFD";
    };
    // Decode in one pass: "&amp;lt;" is the literal text "&lt;", not "<".
    return value.replace(/&(?:(amp|quot|apos|lt|gt|nbsp)|#(\d+)|#x([0-9a-f]+));/gi, (entity, name, decimal, hex) => {
        if (name) return NAMED_HTML_ENTITIES[name.toLowerCase()] ?? entity;
        return decimal ? codePoint(decimal, 10) : codePoint(hex, 16);
    });
}

export function stripHtml(value) {
    // Do not retry every '<' against the same unterminated tag. Excluding
    // nested openers bounds the work for malformed input to a linear scan.
    return decodeHtmlEntities(value.replace(/<[^<>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Inline formatting such as <strong>斗破</strong>苍穹 is part of one word.
export function stripInlineHtml(value) {
    return stripHtml(value.replace(/<\/?(?:span|em|b|strong|font|mark|i|u|a|code|small|sup|sub)\b[^<>]*>/gi, ""));
}

export function createDeadline(timeoutMs) {
    return { expiresAt: Date.now() + timeoutMs };
}

export function isDeadlineExpired(deadline) {
    return Boolean(deadline && deadline.expiresAt <= Date.now());
}

export function remainingDeadlineMs(deadline, fallbackMs) {
    if (!deadline) return fallbackMs;
    return Math.max(1, Math.min(fallbackMs, deadline.expiresAt - Date.now()));
}

export function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isChallengePage(html) {
    return /(?:id=["']challenge-platform["']|\bcf-chl-|<title>\s*just a moment(?:\.\.\.)?\s*<\/title>|enable javascript and cookies to continue)/i.test(html);
}
