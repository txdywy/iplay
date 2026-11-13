/**
 * Telegram bot: the web page's search, detail, actor and Quark resource flows
 * over chat messages and inline buttons. Telegram delivers updates to
 * POST /telegram/webhook; the bot answers with Bot API calls from waitUntil.
 */

import { calculateRecommendationScore, getRecommendationLabel, normalizeGenres } from '../js/scorer.js';
import { formatSeasonEpisodeCounts, formatSeasonTotals } from '../js/seasons.js';
import { pickBestTmdbMatch, rankTmdbCandidates, shouldConfirmTmdbCandidate } from '../js/match.js';
import {
    MAX_QUERY_LENGTH,
    checkRateLimit,
    fetchUpstream,
    jsonResponse,
    logErrorMessage,
    logEvent,
    readJsonWithLimit,
    readTextWithLimit,
    releaseUpstreamResponse
} from './core.js';
import { handleResourceSearch } from './resources.js';
import { handleTmdbDetail, handleTmdbPersonSearch, handleTmdbSearch } from './tmdb.js';
import { handleWikiZh } from './wiki.js';

export const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
export const TELEGRAM_SETUP_PATH = "/telegram/setup";
export const SITE_URL = "https://iplay.hackx64.eu.org/";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;
// Acknowledgements and indicators must not eat into the 30 s waitUntil budget.
const TELEGRAM_QUICK_TIMEOUT_MS = 4000;
const TELEGRAM_MAX_RETRY_AFTER_SECONDS = 3;
// Telegram counts 4096 characters after parsing; leave room for markup.
const PAGE_TEXT_BUDGET = 3600;
const VISIBLE_URL_LENGTH = 70;
const WIKI_SCORE_WAIT_MS = 2500;
const MAX_UPDATE_BYTES = 256 * 1024;
const MESSAGE_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const CANDIDATE_BUTTONS = 8;
const QUARK_PAGE_SIZE = 6;
const POST_PAGE_SIZE = 8;
const ACTOR_PAGE_SIZE = 8;
const CAST_BUTTONS = 3;

export const TELEGRAM_COMMANDS = [
    { command: "search", description: "搜索影视或演员，例如 /search 繁花" },
    { command: "actor", description: "按演员查作品，例如 /actor 胡歌" },
    { command: "help", description: "使用说明" }
];

const HELP_TEXT = [
    "<b>iPlay 追剧助手</b>",
    "",
    "直接发送片名、剧名或演员名即可搜索，也可以：",
    "• <code>/search 繁花</code>：搜索影视或演员",
    "• <code>/search 繁花 第二季</code>：带季数或年份更精确",
    "• <code>/actor 胡歌</code>：查看演员的全部作品",
    "",
    "在详情卡片上点 <b>🔍 夸克资源</b> 扫描网盘分享链接，点 <b>📋</b> 按钮复制提取码。",
    `网页版：${SITE_URL}`
].join("\n");

const EXAMPLE_QUERIES = ["繁花", "流浪地球2", "胡歌"];

// ---------------------------------------------------------------------------
// Configuration and security

export function getTelegramToken(env) {
    const token = typeof env?.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
    return /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token) ? token : "";
}

/**
 * The secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token. Derived from
 * the bot token so one Cloudflare secret configures the bot; an explicit
 * TELEGRAM_WEBHOOK_SECRET overrides it.
 */
export async function getTelegramWebhookSecret(env) {
    const configured = typeof env?.TELEGRAM_WEBHOOK_SECRET === "string" ? env.TELEGRAM_WEBHOOK_SECRET.trim() : "";
    if (/^[A-Za-z0-9_-]{16,256}$/.test(configured)) return configured;
    const token = getTelegramToken(env);
    if (!token) return "";
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new globalThis.TextEncoder().encode(`iplay-telegram-webhook:${token}`));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function getAllowedUserIds(env) {
    const raw = typeof env?.TELEGRAM_ALLOWED_USERS === "string" ? env.TELEGRAM_ALLOWED_USERS : "";
    return new Set(raw.split(",").map(value => value.trim()).filter(value => /^\d{1,20}$/.test(value)));
}

function isUserAllowed(env, userId) {
    const allowed = getAllowedUserIds(env);
    return allowed.size === 0 || allowed.has(String(userId));
}

function timingSafeEqual(left, right) {
    const a = new globalThis.TextEncoder().encode(String(left));
    const b = new globalThis.TextEncoder().encode(String(right));
    let diff = a.length ^ b.length;
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
    }
    return diff === 0;
}

// ---------------------------------------------------------------------------
// Routes

export async function handleTelegramWebhook(request, env, ctx) {
    if (!getTelegramToken(env)) return jsonResponse({ error: "Not Found" }, 404);
    if (request.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405, { Allow: "POST" });

    const expected = await getTelegramWebhookSecret(env);
    const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!expected || !timingSafeEqual(provided, expected)) return jsonResponse({ error: "Unauthorized" }, 401);

    let update;
    try {
        update = JSON.parse(await readTextWithLimit(request, MAX_UPDATE_BYTES));
    } catch {
        return jsonResponse({ error: "Invalid update" }, 400);
    }

    // Answer Telegram at once: a slow reply makes it resend the update.
    const work = processTelegramUpdate(update, env, ctx).catch(error => {
        logEvent("error", "telegram_update_failed", { error: logErrorMessage(error) });
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
    else await work;
    return jsonResponse({ ok: true });
}

/**
 * POST /telegram/setup registers the webhook and command menu.
 * Authenticate with a separate operator secret so the bot token stays server-side.
 */
export async function handleTelegramSetup(request, env) {
    if (request.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
    const token = getTelegramToken(env);
    const adminSecret = typeof env?.TELEGRAM_SETUP_SECRET === "string" ? env.TELEGRAM_SETUP_SECRET.trim() : "";
    if (!token || !adminSecret || adminSecret === token) {
        return jsonResponse({ error: "Telegram setup is not configured" }, 503);
    }

    const authorization = request.headers.get("Authorization") || "";
    if (!timingSafeEqual(authorization, `Bearer ${adminSecret}`)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);

    const webhookUrl = `${url.origin}${TELEGRAM_WEBHOOK_PATH}`;
    try {
        await callTelegram(env, "setWebhook", {
            url: webhookUrl,
            secret_token: await getTelegramWebhookSecret(env),
            allowed_updates: ["message", "callback_query"],
            // Keep messages sent while the webhook was unset unless asked to drop them.
            drop_pending_updates: url.searchParams.get("drop") === "1",
            max_connections: 20
        });
        await callTelegram(env, "setMyCommands", { commands: TELEGRAM_COMMANDS });
        await callTelegram(env, "setMyDescription", {
            description: "发送片名、剧名或演员名，查看评分、简介、推荐指数，并扫描夸克网盘资源。"
        }).catch(() => null);
        const me = await callTelegram(env, "getMe", {});
        const info = await callTelegram(env, "getWebhookInfo", {});
        return jsonResponse({
            ok: true,
            bot: me?.username ? `@${me.username}` : null,
            webhook: info?.url || webhookUrl,
            pendingUpdates: info?.pending_update_count ?? 0,
            access: getAllowedUserIds(env).size ? "allow-list" : "public"
        });
    } catch (error) {
        logEvent("error", "telegram_setup_failed", { error: logErrorMessage(error) });
        return jsonResponse({ error: `Telegram setup failed: ${error.publicMessage || "upstream error"}` }, 502);
    }
}

// ---------------------------------------------------------------------------
// Bot API client

async function callTelegram(env, method, payload, timeoutMs = TELEGRAM_TIMEOUT_MS, allowRetry = true) {
    const token = getTelegramToken(env);
    if (!token) throw new Error("Telegram bot token is not configured");
    const response = await fetchUpstream(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }, timeoutMs);

    let data = null;
    try {
        data = await readJsonWithLimit(response, 512 * 1024);
    } catch {
        await releaseUpstreamResponse(response);
    }
    if (!data?.ok) {
        // Telegram's flood control names a short wait; honor it once.
        const retryAfter = Number(data?.parameters?.retry_after);
        if (allowRetry && response.status === 429 && retryAfter > 0 && retryAfter <= TELEGRAM_MAX_RETRY_AFTER_SECONDS) {
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            return callTelegram(env, method, payload, timeoutMs, false);
        }
        const description = typeof data?.description === "string" ? data.description.slice(0, 200) : `HTTP ${response.status}`;
        const error = new Error(`Telegram ${method} failed: ${description}`);
        error.publicMessage = description;
        error.telegramDescription = description;
        if (response.status === 429) error.status = 429;
        throw error;
    }
    return data.result;
}

function isUnchangedMessageError(error) {
    return /message is not modified/i.test(error?.telegramDescription || "");
}

// ---------------------------------------------------------------------------
// Formatting helpers

export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Escape text, shortening the source until the escaped form fits `maxLength`. */
export function escapeTruncated(value, maxLength) {
    let chars = [...String(value ?? "")];
    let escaped = escapeHtml(chars.join(""));
    while (escaped.length > maxLength && chars.length > 0) {
        chars = chars.slice(0, Math.max(0, chars.length - Math.max(1, Math.ceil((escaped.length - maxLength) / 6)) - 1));
        escaped = `${escapeHtml(chars.join(""))}…`;
    }
    return escaped;
}

function truncate(value, maxLength) {
    const chars = [...String(value ?? "")];
    return chars.length > maxLength ? `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…` : chars.join("");
}

function mediaIcon(mediaType) {
    return mediaType === "tv" ? "📺" : "🎬";
}

function mediaLabel(mediaType) {
    return mediaType === "tv" ? "剧集" : "电影";
}

function formatRatingText(rating, votes) {
    const value = Number(rating);
    if (!Number.isFinite(value) || value <= 0) return "暂无评分";
    const count = Number(votes);
    return `${value.toFixed(1)}${Number.isFinite(count) && count > 0 ? `（${count} 人评分）` : ""}`;
}

function candidateLabel(item) {
    const year = item.year ? ` (${item.year})` : "";
    const rating = Number(item.tmdbRating) > 0 ? ` ⭐${Number(item.tmdbRating).toFixed(1)}` : "";
    return truncate(`${mediaIcon(item.mediaType)} ${item.title || item.originalTitle || "未命名"}${year}${rating}`, 60);
}

function safeHttpUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}

export function buildSiteUrl(detail, season = null) {
    const url = new URL(SITE_URL);
    url.searchParams.set("id", String(detail.id));
    url.searchParams.set("type", detail.mediaType);
    if (detail.title || detail.originalTitle) url.searchParams.set("title", detail.title || detail.originalTitle);
    if (season) url.searchParams.set("season", String(season));
    return url.toString();
}

// Telegram limits callback data to 64 bytes; every action fits by design.
export function callbackData(...parts) {
    const data = parts.map(part => String(part ?? "")).join("|");
    if (new globalThis.TextEncoder().encode(data).length > 64) throw new Error(`Callback data too long: ${data}`);
    return data;
}

function button(text, ...parts) {
    return { text, callback_data: callbackData(...parts) };
}

function keyboard(rows) {
    return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length > 0) };
}

function paginationRow(page, totalPages, makeData) {
    if (totalPages <= 1) return [];
    return [
        page > 0 ? { text: "◀ 上一页", callback_data: makeData(page - 1) } : { text: " ", callback_data: "noop" },
        { text: `${page + 1} / ${totalPages}`, callback_data: "noop" },
        page < totalPages - 1 ? { text: "下一页 ▶", callback_data: makeData(page + 1) } : { text: " ", callback_data: "noop" }
    ];
}

// ---------------------------------------------------------------------------
// Data access through the existing route handlers (shared caches and rules)

async function readHandler(responsePromise) {
    const response = await responsePromise;
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
        error.status = response.status;
        error.fromHandler = true;
        throw error;
    }
    return data;
}

function getDetail(env, ctx, mediaType, id, season = null) {
    return readHandler(handleTmdbDetail(String(id), mediaType, season === null ? null : String(season), env, ctx));
}

function getResources(env, ctx, detail, options) {
    return handleResourceSearch(detailTitle(detail), env, ctx, {
        ...options,
        id: String(detail.id),
        mediaType: detail.mediaType,
        year: detail.year ? String(detail.year) : null
    });
}

function getPersonPage(env, ctx, personId, offset, mediaType) {
    return readHandler(handleTmdbPersonSearch("", env, ctx, {
        personId: String(personId),
        offset: String(offset),
        limit: String(ACTOR_PAGE_SIZE),
        mediaType: mediaType || null
    }));
}

function describeError(error) {
    if (error?.status === 429) return "请求比较频繁，请稍等片刻再试。";
    if (error?.status === 503) return "数据服务暂时不可用，稍后重试通常即可恢复。";
    if (error?.status === 504 || /timed out|timeout/i.test(error?.message || "")) return "数据源响应超时，请稍后重试。";
    // Only the route handlers' own 4xx messages are written for visitors.
    // Telegram API and runtime errors stay in the logs.
    return error?.fromHandler && error.status >= 400 && error.status < 500 && error.message
        ? truncate(error.message, 200)
        : "处理失败，请稍后重试。";
}

// ---------------------------------------------------------------------------
// Update dispatch

export async function processTelegramUpdate(update, env, ctx) {
    if (update?.callback_query) return handleCallbackQuery(update.callback_query, env, ctx);
    const message = update?.message;
    if (!message?.chat?.id || !message.from?.id || message.from.is_bot) return null;
    if (typeof message.text === "string") return handleTextMessage(message, env, ctx);
    // Photos, stickers and other content in a private chat get a short hint.
    if (message.chat.type === "private" && await enforceLimits(env, message.from.id, "search") === "ok") {
        return createChat(env, message).send("请发送文字：片名、剧名或演员名，例如 <code>繁花</code>。");
    }
    return null;
}

/**
 * Replies go to the chat and forum topic of `message`. `replyTo` ties an
 * answer to the asking message in groups, where several people may be talking.
 */
function createChat(env, message, { replyTo = null } = {}) {
    const chatId = message.chat.id;
    const target = {
        chat_id: chatId,
        ...(message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {})
    };
    const reply = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    return {
        chatId,
        target,
        reply,
        send: (text, markup = null) => callTelegram(env, "sendMessage", {
            ...target,
            ...reply,
            text: truncate(text, MESSAGE_LIMIT),
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...(markup ? { reply_markup: markup } : {})
        }),
        edit: async (messageId, text, markup = null) => {
            try {
                return await callTelegram(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: truncate(text, MESSAGE_LIMIT),
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                    ...(markup ? { reply_markup: markup } : {})
                });
            } catch (error) {
                if (isUnchangedMessageError(error)) return null;
                throw error;
            }
        },
        // Fire and forget: the indicator must never delay or fail a reply.
        typing: () => {
            void callTelegram(env, "sendChatAction", { ...target, action: "typing" }, TELEGRAM_QUICK_TIMEOUT_MS).catch(() => null);
        }
    };
}

/**
 * Rate limits come first so that no reply, including "unauthorized", can be
 * triggered without bound. Returns ok, limited, unavailable or unauthorized.
 */
async function enforceLimits(env, userId, kind) {
    const decision = await checkRateLimit(`tg:${userId}`, kind === "resource" ? "/api/resource" : "/api/telegram", env);
    if (decision === null) return "unavailable";
    if (!decision) return "limited";
    return isUserAllowed(env, userId) ? "ok" : "unauthorized";
}

const LIMIT_MESSAGES = {
    limited: "操作太频繁了，请一分钟后再试。",
    unavailable: "服务暂时不可用，请稍后再试。"
};

function unauthorizedText(userId) {
    return `抱歉，这个 bot 仅对授权用户开放。\n你的 Telegram 用户 ID 是 <code>${escapeHtml(userId)}</code>，可以发给管理员申请开通。`;
}

export function parseCommand(text) {
    const match = /^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match) return { command: null, mention: null, argument: text.trim() };
    return { command: match[1].toLowerCase(), mention: match[2] ? match[2].toLowerCase() : null, argument: (match[3] || "").trim() };
}

const SEARCH_COMMANDS = new Set(["search", "s"]);
const ACTOR_COMMANDS = new Set(["actor", "a"]);
const HELP_COMMANDS = new Set(["start", "help"]);

// One getMe per isolate and token: groups address commands as /cmd@username.
const botUsernames = new Map();

async function getBotUsername(env) {
    const token = getTelegramToken(env);
    if (!botUsernames.has(token)) {
        const lookup = callTelegram(env, "getMe", {}, TELEGRAM_QUICK_TIMEOUT_MS)
            .then(me => (typeof me?.username === "string" ? me.username.toLowerCase() : null))
            .catch(() => null);
        botUsernames.set(token, lookup);
        // A failed lookup is retried by the next group command.
        void lookup.then(username => { if (!username) botUsernames.delete(token); });
    }
    return botUsernames.get(token);
}

async function handleTextMessage(message, env, ctx) {
    const userId = message.from.id;
    const { command, mention, argument } = parseCommand(message.text);
    const isPrivate = message.chat.type === "private";
    const chat = createChat(env, message, { replyTo: isPrivate ? null : message.message_id });
    const isKnown = SEARCH_COMMANDS.has(command) || ACTOR_COMMANDS.has(command) || HELP_COMMANDS.has(command);

    if (!isPrivate) {
        // In groups only this bot's own commands are for it: never answer
        // plain chat, unknown commands or commands addressed to another bot.
        if (!isKnown) return null;
        if (mention && mention !== await getBotUsername(env)) return null;
    }

    const limit = await enforceLimits(env, userId, "search");
    // Stay silent when limited: a reply per message would itself be unbounded.
    if (limit === "limited") return null;
    if (limit === "unavailable") return chat.send(LIMIT_MESSAGES.unavailable);
    if (limit === "unauthorized") return isPrivate ? chat.send(unauthorizedText(userId)) : null;

    if (HELP_COMMANDS.has(command)) {
        return chat.send(HELP_TEXT, keyboard([EXAMPLE_QUERIES.map(query => button(`🔎 ${query}`, "q", query))]));
    }
    if (command && !isKnown) return chat.send("未知命令。发送 /help 查看用法。");

    const wantsActor = ACTOR_COMMANDS.has(command);
    if (!argument) {
        return chat.send(wantsActor
            ? "请在命令后加上演员名，例如 <code>/actor 胡歌</code>"
            : "请发送片名、剧名或演员名，例如 <code>繁花</code>");
    }
    if ([...argument].length > MAX_QUERY_LENGTH) return chat.send(`关键词太长了，请控制在 ${MAX_QUERY_LENGTH} 个字以内。`);

    chat.typing();
    try {
        if (wantsActor) return await runActorSearch(chat, env, ctx, argument);
        return await runSearch(chat, env, ctx, argument);
    } catch (error) {
        logEvent("warn", "telegram_search_failed", { error: logErrorMessage(error) });
        return chat.send(`😵 搜索失败：${escapeHtml(describeError(error))}`);
    }
}

async function handleCallbackQuery(query, env, ctx) {
    const userId = query.from?.id;
    const message = query.message;
    const data = typeof query.data === "string" ? query.data : "";
    const answer = (text = "", showAlert = false) => callTelegram(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        ...(text ? { text, show_alert: showAlert } : {})
    }, TELEGRAM_QUICK_TIMEOUT_MS).catch(() => null);

    if (!message?.chat?.id || !userId || data === "noop") return answer();
    const chat = createChat(env, message);
    const [action, ...args] = data.split("|");
    // A photo card cannot be edited into a text page. Buttons that page a text
    // message post a new one when pressed on a card (cards sent by older releases).
    const editableId = typeof message.text === "string" ? message.message_id : null;
    // Opening or rescanning resources runs a scan and counts against the
    // resource limit; paging a scanned list ("r", "rp") reads its cache.
    const isScan = action === "ro" || action === "rf";

    const limit = await enforceLimits(env, userId, isScan ? "resource" : "search");
    if (limit === "unauthorized") return answer("仅限授权用户使用", true);
    if (limit !== "ok") return answer(LIMIT_MESSAGES[limit], true);

    try {
        switch (action) {
            case "q":
                await answer();
                chat.typing();
                return await runSearch(chat, env, ctx, args.join("|"));
            case "d":
                await answer();
                return await sendDetailCard(chat, env, ctx, args[0], args[1], args[2] ? Number(args[2]) : null);
            case "ro":
                await answer("正在扫描资源，通常需要 5–15 秒…");
                return await showQuarkPage(chat, env, ctx, args[0], args[1], 0, { messageId: null });
            case "rf":
                await answer("正在重新扫描…");
                return await showQuarkPage(chat, env, ctx, args[0], args[1], 0, { messageId: editableId, refresh: true });
            case "r":
                await answer();
                return await showQuarkPage(chat, env, ctx, args[0], args[1], Number(args[2]) || 0, { messageId: editableId, cacheOnly: true });
            case "rp":
                await answer();
                return await showPostPage(chat, env, ctx, editableId, args);
            case "w":
                await answer();
                return await sendSynopsis(chat, env, ctx, args[0], args[1]);
            case "ss":
                await answer();
                return await sendSeasons(chat, env, ctx, args[0]);
            case "ao":
                await answer();
                return await showActorPage(chat, env, ctx, null, [args[0], 0, ""]);
            case "a":
                await answer();
                return await showActorPage(chat, env, ctx, editableId, args);
            default:
                return answer("这个按钮已失效，请重新搜索");
        }
    } catch (error) {
        logEvent("warn", "telegram_action_failed", { action, error: logErrorMessage(error) });
        await answer();
        return chat.send(`😵 操作失败：${escapeHtml(describeError(error))}`);
    }
}

// ---------------------------------------------------------------------------
// Search (mirrors the web page's choice between titles and actors)

async function runSearch(chat, env, ctx, query) {
    let tmdbSearch = null;
    let tmdbError = null;
    try {
        tmdbSearch = await readHandler(handleTmdbSearch(query, env, ctx));
    } catch (error) {
        tmdbError = error;
    }

    const results = Array.isArray(tmdbSearch?.results) ? tmdbSearch.results.filter(item => item?.id && item?.mediaType) : [];
    const meta = tmdbSearch?.searchMeta || {};
    const requestedSeason = Number(meta.season) || null;
    const titleScore = Number(meta.matchScore);
    // An exact actor name outranks works that merely contain it.
    const prefersActor = Boolean(meta.exactPerson) && !/-exact$|^external-id$/.test(String(meta.matchedBy || ""));
    const hasReliableTitle = results.length > 0 && !prefersActor && (!Number.isFinite(titleScore) || titleScore >= 0.72);

    let actorCandidates = [];
    if (!hasReliableTitle) {
        const person = await readHandler(handleTmdbPersonSearch(query, env, ctx, { limit: String(ACTOR_PAGE_SIZE) })).catch(() => null);
        const actorScore = Number(person?.person?.matchScore);
        if (person?.person?.id && Array.isArray(person.credits) && actorScore >= 0.86) {
            return renderActorPage(chat, null, person, "");
        }
        actorCandidates = person?.searchMeta?.ambiguous && Array.isArray(person.personCandidates)
            ? person.personCandidates
            : person?.person && actorScore >= 0.72 ? [person.person] : [];
    }
    if (meta.exactPerson?.id && !actorCandidates.some(actor => actor.id === meta.exactPerson.id)) {
        actorCandidates = [meta.exactPerson, ...actorCandidates];
    }
    const actorRows = actorCandidates.filter(actor => actor?.id).slice(0, 4)
        .map(actor => [button(`👤 演员：${truncate(actor.name || actor.originalName, 30)}`, "ao", actor.id)]);

    if (results.length === 0) {
        if (actorRows.length > 0) return chat.send("找到以下可能的演员，请选择：", keyboard(actorRows));
        if (tmdbError) throw tmdbError;
        return chat.send(`没有找到“${escapeHtml(query)}”的可靠匹配。试试补充年份、季数，或换个更完整的名称。`);
    }

    // A requested season only applies to series; a movie rejects it.
    const seasonFor = item => (requestedSeason && item.mediaType === "tv" ? requestedSeason : "");
    const ranked = rankTmdbCandidates(results);
    const candidate = pickBestTmdbMatch(ranked, query) || (ranked.length === 1 ? ranked[0] : null);

    if (!candidate || shouldConfirmTmdbCandidate(ranked) || prefersActor || (actorRows.length > 0 && !hasReliableTitle)) {
        const rows = ranked.slice(0, CANDIDATE_BUTTONS)
            .map(item => [button(candidateLabel(item), "d", item.mediaType, item.id, seasonFor(item))]);
        return chat.send(`“${escapeHtml(query)}”找到 ${ranked.length} 个结果，请选择：`, keyboard([...actorRows, ...rows]));
    }

    return sendDetailCard(chat, env, ctx, candidate.mediaType, candidate.id, seasonFor(candidate) || null);
}

async function runActorSearch(chat, env, ctx, name) {
    const person = await readHandler(handleTmdbPersonSearch(name, env, ctx, { limit: String(ACTOR_PAGE_SIZE) }));
    if (person?.person?.id && Array.isArray(person.credits)) return renderActorPage(chat, null, person, "");
    const candidates = Array.isArray(person?.personCandidates) ? person.personCandidates : [];
    if (candidates.length > 0) {
        return chat.send("找到多位同名或相近的演员，请选择：", keyboard(
            candidates.slice(0, 6).map(actor => [button(`👤 ${truncate(actor.name || actor.originalName, 40)}`, "ao", actor.id)])
        ));
    }
    return chat.send(`没有找到演员“${escapeHtml(name)}”。`);
}

// ---------------------------------------------------------------------------
// Detail card

export function buildDetailCaption(detail, season = null, { hasWiki = false } = {}) {
    const genres = normalizeGenres(detail.genres);
    const score = calculateRecommendationScore({
        rating: detail.tmdbRating,
        votes: detail.tmdbVotes,
        genres,
        hasWiki,
        summary: detail.summary,
        source: "tmdb"
    });
    const label = getRecommendationLabel(score.score).label;
    const title = detail.title || detail.originalTitle || "未命名";
    const lines = [
        `<b>${escapeHtml(title)}</b>${detail.year ? ` (${escapeHtml(detail.year)})` : ""}`,
        detail.originalTitle && detail.originalTitle !== title ? `<i>${escapeHtml(detail.originalTitle)}</i>` : null,
        `${mediaIcon(detail.mediaType)} ${mediaLabel(detail.mediaType)}${genres.length ? ` · ${escapeHtml(genres.slice(0, 4).join(" / "))}` : ""}`,
        `⭐ TMDB ${escapeHtml(formatRatingText(detail.tmdbRating, detail.tmdbVotes))}`,
        `🎯 推荐指数 <b>${score.score}</b> · ${escapeHtml(label)}`,
        detail.director?.length ? `🎬 导演：${escapeHtml(detail.director.slice(0, 2).join("、"))}` : null,
        detail.cast?.length ? `👥 主演：${escapeHtml(detail.cast.slice(0, 4).join("、"))}` : null
    ];
    if (detail.mediaType === "tv") {
        const totals = formatSeasonTotals(detail.totalSeasons, detail.totalEpisodes);
        const selected = season ? detail.seasons?.find(entry => entry.seasonNumber === season) : null;
        if (selected) lines.push(`🗂 第 ${season} 季：${selected.episodeCount ?? "待定"} 集${totals ? `（${escapeHtml(totals)}）` : ""}`);
        else if (totals) lines.push(`🗂 ${escapeHtml(totals)}`);
    }
    const head = lines.filter(Boolean).join("\n");
    const summary = String(detail.summary || "").trim();
    const room = CAPTION_LIMIT - [...head].length - 4;
    return summary && room > 40 ? `${head}\n\n${escapeHtml(truncate(summary, Math.min(room, 360)))}` : head;
}

export function buildDetailKeyboard(detail, season = null) {
    const rows = [
        [button("🔍 夸克资源", "ro", detail.mediaType, detail.id)],
        [button("📖 完整简介", "w", detail.mediaType, detail.id),
            ...(detail.mediaType === "tv" && detail.seasons?.length ? [button("🗂 分季", "ss", detail.id)] : [])],
        (detail.castDetails || []).filter(person => person.id).slice(0, CAST_BUTTONS)
            .map(person => button(`👤 ${truncate(person.name, 12)}`, "ao", person.id)),
        [{ text: "🌐 网页打开", url: buildSiteUrl(detail, season) }]
    ];
    return keyboard(rows);
}

async function sendDetailCard(chat, env, ctx, mediaType, id, season = null) {
    if (mediaType !== "movie" && mediaType !== "tv") throw new Error("条目类型无效，请重新搜索");
    if (mediaType !== "tv") season = null;
    chat.typing();
    let detail;
    let seasonNote = "";
    try {
        detail = await getDetail(env, ctx, mediaType, id, season);
    } catch (error) {
        if (!season || (error.status !== 404 && error.status !== 400)) throw error;
        // A season the series does not have still shows the series.
        seasonNote = error.status === 404 ? `\n\n⚠️ ${escapeHtml(error.message)}` : "";
        season = null;
        detail = await getDetail(env, ctx, mediaType, id);
    }

    // The page adds points for a Chinese Wikipedia article. Use it when the
    // (cached) lookup answers quickly, and never hold the card for it.
    const wikiLookup = getWikiSummary(env, ctx, detail).then(wiki => Boolean(wiki?.extract?.trim()));
    // A lookup that loses the race still finishes and caches for the next card.
    ctx?.waitUntil?.(wikiLookup);
    let wikiTimer;
    const hasWiki = await Promise.race([
        wikiLookup,
        new Promise(resolve => { wikiTimer = setTimeout(resolve, WIKI_SCORE_WAIT_MS, false); })
    ]).finally(() => clearTimeout(wikiTimer));
    const caption = buildDetailCaption(detail, season, { hasWiki }) + seasonNote;
    const markup = buildDetailKeyboard(detail, season);
    const poster = safeHttpUrl(detail.poster);
    if (poster && [...caption].length <= CAPTION_LIMIT) {
        try {
            return await callTelegram(env, "sendPhoto", {
                ...chat.target,
                ...chat.reply,
                photo: poster,
                caption,
                parse_mode: "HTML",
                reply_markup: markup
            });
        } catch (error) {
            logEvent("warn", "telegram_photo_failed", { error: logErrorMessage(error) });
            // After a timeout Telegram may still deliver the photo card.
            if (error?.status === 504) return null;
        }
    }
    return chat.send(caption, markup);
}

function detailTitle(detail) {
    return detail.title || detail.originalTitle || "未命名";
}

function getWikiSummary(env, ctx, detail) {
    return readHandler(handleWikiZh(detailTitle(detail), ctx, {
        mediaType: detail.mediaType,
        year: detail.year ? String(detail.year) : null,
        id: String(detail.id),
        env
    })).catch(() => null);
}

// Follow-up messages scroll away from their card: offer the way back.
function followUpKeyboard(detail, extraRows = []) {
    return keyboard([
        ...extraRows,
        [button("🔍 夸克资源", "ro", detail.mediaType, detail.id), button("↩ 详情卡片", "d", detail.mediaType, detail.id, "")]
    ]);
}

async function sendSynopsis(chat, env, ctx, mediaType, id) {
    chat.typing();
    const detail = await getDetail(env, ctx, mediaType, id);
    const wiki = await getWikiSummary(env, ctx, detail);
    const text = typeof wiki?.extract === "string" && wiki.extract.trim() ? wiki.extract.trim() : String(detail.summary || "").trim();
    const source = wiki?.extract ? "中文 Wikipedia" : "TMDB";
    const title = escapeTruncated(detailTitle(detail), 300);
    if (!text) return chat.send(`《${title}》暂无简介。`, followUpKeyboard(detail));
    return chat.send(`<b>${title}</b> · 简介（${source}）\n\n${escapeTruncated(text, PAGE_TEXT_BUDGET)}`, followUpKeyboard(detail));
}

async function sendSeasons(chat, env, ctx, id) {
    const detail = await getDetail(env, ctx, "tv", id);
    const counts = formatSeasonEpisodeCounts(detail.seasons).split(" / ").filter(Boolean);
    const totals = formatSeasonTotals(detail.totalSeasons, detail.totalEpisodes);
    const rows = (detail.seasons || []).filter(entry => entry.seasonNumber > 0).slice(0, 24)
        .map(entry => button(`第 ${entry.seasonNumber} 季`, "d", "tv", detail.id, entry.seasonNumber));
    const grouped = [];
    for (let index = 0; index < rows.length; index += 4) grouped.push(rows.slice(index, index + 4));
    return chat.send(
        `<b>${escapeTruncated(detailTitle(detail), 300)}</b> · 分季${totals ? `（${escapeHtml(totals)}）` : ""}\n\n${escapeTruncated(counts.join("\n"), PAGE_TEXT_BUDGET) || "暂无分季资料"}`,
        followUpKeyboard(detail, grouped)
    );
}

// ---------------------------------------------------------------------------
// Quark resources

function describeResourceProviders(meta) {
    const providers = meta?.providers || {};
    const failed = Object.entries(providers).filter(([, status]) => status === "failed").map(([name]) => ({
        by669: "By669", wpzys: "WPZY", zuidouyin: "醉都音"
    }[name] || name));
    return failed.length ? `⚠️ ${failed.join("、")} 暂时不可用，结果可能不完整。` : meta?.partial ? "⚠️ 部分资源页未能读取，结果可能不完整。" : "";
}

function resourceHeader(detail, label) {
    return `<b>${escapeTruncated(detailTitle(detail), 300)}</b>${detail.year ? ` (${escapeHtml(detail.year)})` : ""} · ${label}`;
}

function collectPosts(result) {
    return [...(result?.resources || []), ...(result?.wpzysResources || []), ...(result?.zuidouyinResources || [])]
        .filter(post => safeHttpUrl(post?.url));
}

/** A link whose visible text is shortened; the href keeps the full URL. */
function htmlLink(url, label) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * Append entries while the page stays inside Telegram's message limit, so a
 * few very long URLs can never cut the markup mid-tag. Returns the count used.
 */
function appendWithinBudget(lines, blocks) {
    let used = lines.join("\n").length;
    let count = 0;
    for (const block of blocks) {
        const size = block.join("\n").length + 2;
        if (used + size > PAGE_TEXT_BUDGET) break;
        lines.push("", ...block);
        used += size;
        count += 1;
    }
    return count;
}

export function buildQuarkPage(detail, result, page, { stale = false } = {}) {
    const items = Array.isArray(result?.quarkUrls) ? result.quarkUrls.filter(item => safeHttpUrl(item?.url)) : [];
    const posts = collectPosts(result);
    const totalPages = Math.max(1, Math.ceil(items.length / QUARK_PAGE_SIZE));
    const current = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
    const pageItems = items.slice(current * QUARK_PAGE_SIZE, (current + 1) * QUARK_PAGE_SIZE);

    const lines = [resourceHeader(detail, "夸克资源")];
    let shown = 0;
    if (items.length === 0) {
        lines.push("", posts.length
            ? `暂未提取到夸克链接，但找到 ${posts.length} 个资源帖，可点下方按钮查看。`
            : "暂未发现资源。可以稍后点“重新扫描”再试。");
    } else {
        lines.push(`共 ${items.length} 个分享链接`);
        shown = appendWithinBudget(lines, pageItems.map((item, index) => {
            const url = safeHttpUrl(item.url);
            const source = safeHttpUrl(item.sourceUrl);
            return [
                `${current * QUARK_PAGE_SIZE + index + 1}. ${escapeHtml(truncate(item.title || item.sourceTitle || "夸克网盘分享", 90))}`,
                `🔗 ${htmlLink(url, truncate(url, VISIBLE_URL_LENGTH))}`,
                item.password ? `🔑 提取码：<code>${escapeHtml(item.password)}</code>`
                    : item.passwordConflict ? "🔑 提取码有多个候选，请到原帖确认" : null,
                source ? `📄 ${htmlLink(source, "来源帖子")}` : null
            ].filter(Boolean);
        }));
        if (shown < pageItems.length) lines.push("", `（本页另有 ${pageItems.length - shown} 条链接过长未显示，可到资源帖查看）`);
    }
    const notice = describeResourceProviders(result?.resourceMeta || result);
    if (notice) lines.push("", notice);
    if (stale) lines.push("", "⚠️ 本次重新扫描失败，显示的是之前的结果。");

    const copyButtons = pageItems.slice(0, shown)
        .map((item, index) => item.password ? { text: `📋 复制提取码 ${current * QUARK_PAGE_SIZE + index + 1}`, copy_text: { text: item.password } } : null)
        .filter(Boolean);
    const copyRows = [];
    for (let index = 0; index < copyButtons.length; index += 2) copyRows.push(copyButtons.slice(index, index + 2));

    const markup = keyboard([
        ...copyRows,
        paginationRow(current, totalPages, next => callbackData("r", detail.mediaType, detail.id, next)),
        [button("🔄 重新扫描", "rf", detail.mediaType, detail.id),
            ...(posts.length ? [button(`📄 资源帖 (${posts.length})`, "rp", detail.mediaType, detail.id, 0)] : [])]
    ]);
    return { text: lines.join("\n"), markup };
}

/**
 * `messageId` null posts a new resource message (opened from a detail card);
 * otherwise that message is edited in place (paging, rescans, back from posts).
 */
function resourceRetryKeyboard(detail) {
    return keyboard([[button("🔄 重新扫描", "rf", detail.mediaType, detail.id)]]);
}

async function showQuarkPage(chat, env, ctx, mediaType, id, page, { messageId = null, refresh = false, cacheOnly = false } = {}) {
    const detail = await getDetail(env, ctx, mediaType, id);
    // Every state of the message keeps a rescan button: if the Worker is cut
    // off mid-scan, the placeholder must not become a dead end.
    const retryMarkup = resourceRetryKeyboard(detail);
    let targetId = messageId;
    if (!targetId && !cacheOnly) {
        const placeholder = await chat.send(`${resourceHeader(detail, "夸克资源")}\n\n⏳ 正在扫描资源索引和论坛帖子…`, retryMarkup);
        targetId = placeholder?.message_id ?? null;
    } else if (refresh) {
        await chat.edit(targetId, `${resourceHeader(detail, "夸克资源")}\n\n⏳ 正在重新扫描…`, retryMarkup).catch(() => null);
    }
    const show = (text, markup) => (targetId ? chat.edit(targetId, text, markup) : chat.send(text, markup));

    try {
        const response = await getResources(env, ctx, detail, { refresh, cacheOnly });
        if (response.status === 410) {
            const { error } = await response.json();
            return await show(`${resourceHeader(detail, "夸克资源")}\n\n${escapeHtml(error)}`, retryMarkup);
        }
        const stale = response.headers.get("X-iPlay-Stale") === "1";
        const { text, markup } = buildQuarkPage(detail, await readHandler(response), page, { stale });
        return await show(text, markup);
    } catch (error) {
        logEvent("warn", "telegram_resource_failed", { error: logErrorMessage(error) });
        return show(`${resourceHeader(detail, "夸克资源")}\n\n😵 资源扫描失败：${escapeHtml(describeError(error))}`, retryMarkup);
    }
}

export function buildPostPage(detail, result, page) {
    const posts = collectPosts(result);
    const totalPages = Math.max(1, Math.ceil(posts.length / POST_PAGE_SIZE));
    const current = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
    const lines = [resourceHeader(detail, `资源帖（${posts.length}）`)];
    if (posts.length === 0) lines.push("", "暂无资源帖。");
    appendWithinBudget(lines, posts.slice(current * POST_PAGE_SIZE, (current + 1) * POST_PAGE_SIZE).map((post, index) => {
        const url = safeHttpUrl(post.url);
        return [`${current * POST_PAGE_SIZE + index + 1}. ${htmlLink(url, truncate(post.title || url, 90))}`];
    }));
    const markup = keyboard([
        paginationRow(current, totalPages, next => callbackData("rp", detail.mediaType, detail.id, next)),
        [button("🔙 夸克链接", "r", detail.mediaType, detail.id, 0)]
    ]);
    return { text: lines.join("\n"), markup };
}

// The resource message switches between Quark links and forum posts in place.
async function showPostPage(chat, env, ctx, messageId, args) {
    const [mediaType, id, pageText] = args;
    const detail = await getDetail(env, ctx, mediaType, id);
    const response = await getResources(env, ctx, detail, { cacheOnly: true });
    const show = (text, markup) => messageId ? chat.edit(messageId, text, markup) : chat.send(text, markup);
    if (response.status === 410) {
        const { error } = await response.json();
        return show(`${resourceHeader(detail, "资源帖")}\n\n${escapeHtml(error)}`, resourceRetryKeyboard(detail));
    }
    const { text, markup } = buildPostPage(detail, await readHandler(response), Number(pageText) || 0);
    return show(text, markup);
}

// ---------------------------------------------------------------------------
// Actors

function renderActorPage(chat, messageId, data, filter) {
    const person = data.person || {};
    const credits = Array.isArray(data.credits) ? data.credits.filter(credit => credit?.id && credit?.mediaType) : [];
    const total = Number(data.totalResults) || 0;
    const offset = Number(data.offset) || 0;
    const page = Math.floor(offset / ACTOR_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / ACTOR_PAGE_SIZE));
    const counts = data.counts || {};
    const filterName = filter === "movie" ? "电影" : filter === "tv" ? "剧集" : "全部作品";
    const text = [
        `👤 <b>${escapeHtml(person.name || "演员")}</b>${person.originalName && person.originalName !== person.name ? ` (${escapeHtml(person.originalName)})` : ""}`,
        `电影 ${counts.movie ?? 0} 部 · 剧集 ${counts.tv ?? 0} 部`,
        !total ? `暂无${filterName}。`
            : credits.length ? `${filterName}：第 ${offset + 1}–${offset + credits.length} 部，共 ${total} 部。点击作品查看详情：`
                : `${filterName}共 ${total} 部，这一页没有内容，请返回上一页。`
    ].join("\n");

    const filterButton = (label, value) => button(filter === value ? `· ${label} ·` : label, "a", person.id, 0, value);
    const markup = keyboard([
        ...credits.map(credit => [button(
            truncate(`${candidateLabel(credit)}${credit.character ? ` 饰 ${credit.character}` : ""}`, 60),
            "d", credit.mediaType, credit.id
        )]),
        paginationRow(Math.min(page, totalPages), totalPages, next => callbackData("a", person.id, next * ACTOR_PAGE_SIZE, filter)),
        [filterButton("全部", ""), filterButton("电影", "movie"), filterButton("剧集", "tv")]
    ]);
    return messageId ? chat.edit(messageId, text, markup) : chat.send(text, markup);
}

// "ao" opens an actor in a new message; "a" pages or filters that message.
async function showActorPage(chat, env, ctx, messageId, args) {
    const [personId, offsetText, filter = ""] = args;
    const mediaType = filter === "movie" || filter === "tv" ? filter : "";
    const data = await getPersonPage(env, ctx, personId, Math.max(0, Number(offsetText) || 0), mediaType);
    return renderActorPage(chat, messageId, data, mediaType);
}
