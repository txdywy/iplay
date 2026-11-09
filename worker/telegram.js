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
 * GET /telegram/setup?token=<bot token> registers the webhook and the command
 * menu. The caller proves ownership with the bot token itself.
 */
export async function handleTelegramSetup(request, env) {
    const token = getTelegramToken(env);
    if (!token) return jsonResponse({ error: "TELEGRAM_BOT_TOKEN is not configured" }, 503);

    const url = new URL(request.url);
    if (!timingSafeEqual(url.searchParams.get("token") || "", token)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const webhookUrl = `${url.origin}${TELEGRAM_WEBHOOK_PATH}`;
    try {
        await callTelegram(env, "setWebhook", {
            url: webhookUrl,
            secret_token: await getTelegramWebhookSecret(env),
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: true,
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

async function callTelegram(env, method, payload) {
    const token = getTelegramToken(env);
    if (!token) throw new Error("Telegram bot token is not configured");
    const response = await fetchUpstream(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }, TELEGRAM_TIMEOUT_MS);

    let data = null;
    try {
        data = await readJsonWithLimit(response, 512 * 1024);
    } catch {
        await releaseUpstreamResponse(response);
    }
    if (!data?.ok) {
        const description = typeof data?.description === "string" ? data.description.slice(0, 200) : `HTTP ${response.status}`;
        const error = new Error(`Telegram ${method} failed: ${description}`);
        error.publicMessage = description;
        error.telegramDescription = description;
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
        throw error;
    }
    return data;
}

function getDetail(env, ctx, mediaType, id, season = null) {
    return readHandler(handleTmdbDetail(String(id), mediaType, season === null ? null : String(season), env, ctx));
}

function getResources(env, ctx, detail, refresh = false) {
    return readHandler(handleResourceSearch(detail.title || detail.originalTitle, env, ctx, {
        refresh,
        id: String(detail.id),
        mediaType: detail.mediaType,
        year: detail.year ? String(detail.year) : null
    }));
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
    return error?.message ? truncate(error.message, 200) : "处理失败，请稍后重试。";
}

// ---------------------------------------------------------------------------
// Update dispatch

export async function processTelegramUpdate(update, env, ctx) {
    if (update?.callback_query) return handleCallbackQuery(update.callback_query, env, ctx);
    const message = update?.message;
    if (message && typeof message.text === "string" && message.chat?.id && message.from?.id) {
        return handleTextMessage(message, env, ctx);
    }
    return null;
}

function createChat(env, chatId) {
    return {
        chatId,
        send: (text, markup = null, extra = {}) => callTelegram(env, "sendMessage", {
            chat_id: chatId,
            text: truncate(text, MESSAGE_LIMIT),
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...(markup ? { reply_markup: markup } : {}),
            ...extra
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
        typing: () => callTelegram(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => null)
    };
}

async function enforceLimits(env, userId, kind) {
    if (!isUserAllowed(env, userId)) return "unauthorized";
    const decision = await checkRateLimit(`tg:${userId}`, kind === "resource" ? "/api/resource" : "/api/telegram", env);
    if (decision === null) return "unavailable";
    return decision ? "ok" : "limited";
}

const LIMIT_MESSAGES = {
    limited: "操作太频繁了，请一分钟后再试。",
    unavailable: "服务暂时不可用，请稍后再试。"
};

function unauthorizedText(userId) {
    return `抱歉，这个 bot 仅对授权用户开放。\n你的 Telegram 用户 ID 是 <code>${escapeHtml(userId)}</code>，可以发给管理员申请开通。`;
}

export function parseCommand(text) {
    const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match) return { command: null, argument: text.trim() };
    return { command: match[1].toLowerCase(), argument: (match[2] || "").trim() };
}

async function handleTextMessage(message, env, ctx) {
    const chat = createChat(env, message.chat.id);
    const userId = message.from.id;
    const { command, argument } = parseCommand(message.text);
    const isPrivate = message.chat.type === "private";

    // In groups only commands are for the bot; any text in a private chat is a search.
    if (!command && !isPrivate) return null;

    if (command === "start" || command === "help") {
        if (!isUserAllowed(env, userId)) return chat.send(unauthorizedText(userId));
        return chat.send(HELP_TEXT, keyboard([EXAMPLE_QUERIES.map(query => button(`🔎 ${query}`, "q", query))]));
    }

    if (command && !["search", "s", "actor", "a"].includes(command)) {
        return chat.send("未知命令。发送 /help 查看用法。");
    }

    const limit = await enforceLimits(env, userId, "search");
    if (limit === "unauthorized") return chat.send(unauthorizedText(userId));
    if (limit !== "ok") return chat.send(LIMIT_MESSAGES[limit]);

    if (!argument) {
        return chat.send(command === "actor" || command === "a"
            ? "请在命令后加上演员名，例如 <code>/actor 胡歌</code>"
            : "请发送片名、剧名或演员名，例如 <code>繁花</code>");
    }
    if ([...argument].length > MAX_QUERY_LENGTH) return chat.send(`关键词太长了，请控制在 ${MAX_QUERY_LENGTH} 个字以内。`);

    await chat.typing();
    try {
        if (command === "actor" || command === "a") return await runActorSearch(chat, env, ctx, argument);
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
    }).catch(() => null);

    if (!message?.chat?.id || !userId || data === "noop") return answer();
    const chat = createChat(env, message.chat.id);
    const [action, ...args] = data.split("|");
    // Scans count against the resource limit; paging a scanned list reuses its cache.
    const isScan = action === "rf" || (action === "r" && args[2] === "0");

    const limit = await enforceLimits(env, userId, isScan ? "resource" : "search");
    if (limit === "unauthorized") return answer("仅限授权用户使用", true);
    if (limit !== "ok") return answer(LIMIT_MESSAGES[limit], true);

    try {
        switch (action) {
            case "q":
                await answer();
                await chat.typing();
                return await runSearch(chat, env, ctx, args.join("|"));
            case "d":
                await answer();
                return await sendDetailCard(chat, env, ctx, args[0], args[1], args[2] ? Number(args[2]) : null);
            case "r":
                return await showQuarkPage(chat, env, ctx, message, args, answer, { refresh: false });
            case "rf":
                return await showQuarkPage(chat, env, ctx, message, [...args.slice(0, 2), "0"], answer, { refresh: true });
            case "rp":
                await answer();
                return await showPostPage(chat, env, ctx, message, args);
            case "w":
                await answer();
                return await sendSynopsis(chat, env, ctx, args[0], args[1]);
            case "ss":
                await answer();
                return await sendSeasons(chat, env, ctx, args[0]);
            case "a":
                await answer();
                return await showActorPage(chat, env, ctx, message, args);
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
        .map(actor => [button(`👤 演员：${truncate(actor.name || actor.originalName, 30)}`, "a", actor.id, 0, "")]);

    if (results.length === 0) {
        if (actorRows.length > 0) return chat.send("找到以下可能的演员，请选择：", keyboard(actorRows));
        if (tmdbError) throw tmdbError;
        return chat.send(`没有找到“${escapeHtml(query)}”的可靠匹配。试试补充年份、季数，或换个更完整的名称。`);
    }

    const ranked = rankTmdbCandidates(results);
    const candidate = pickBestTmdbMatch(ranked, query) || (ranked.length === 1 ? ranked[0] : null);

    if (!candidate || shouldConfirmTmdbCandidate(ranked) || prefersActor || (actorRows.length > 0 && !hasReliableTitle)) {
        const rows = ranked.slice(0, CANDIDATE_BUTTONS)
            .map(item => [button(candidateLabel(item), "d", item.mediaType, item.id, requestedSeason || "")]);
        return chat.send(`“${escapeHtml(query)}”找到 ${ranked.length} 个结果，请选择：`, keyboard([...actorRows, ...rows]));
    }

    return sendDetailCard(chat, env, ctx, candidate.mediaType, candidate.id, requestedSeason);
}

async function runActorSearch(chat, env, ctx, name) {
    const person = await readHandler(handleTmdbPersonSearch(name, env, ctx, { limit: String(ACTOR_PAGE_SIZE) }));
    if (person?.person?.id && Array.isArray(person.credits)) return renderActorPage(chat, null, person, "");
    const candidates = Array.isArray(person?.personCandidates) ? person.personCandidates : [];
    if (candidates.length > 0) {
        return chat.send("找到多位同名或相近的演员，请选择：", keyboard(
            candidates.slice(0, 6).map(actor => [button(`👤 ${truncate(actor.name || actor.originalName, 40)}`, "a", actor.id, 0, "")])
        ));
    }
    return chat.send(`没有找到演员“${escapeHtml(name)}”。`);
}

// ---------------------------------------------------------------------------
// Detail card

export function buildDetailCaption(detail, season = null) {
    const genres = normalizeGenres(detail.genres);
    const score = calculateRecommendationScore({
        rating: detail.tmdbRating,
        votes: detail.tmdbVotes,
        genres,
        hasWiki: false,
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
        [button("🔍 夸克资源", "r", detail.mediaType, detail.id, 0)],
        [button("📖 完整简介", "w", detail.mediaType, detail.id),
            ...(detail.mediaType === "tv" && detail.seasons?.length ? [button("🗂 分季", "ss", detail.id)] : [])],
        (detail.castDetails || []).filter(person => person.id).slice(0, CAST_BUTTONS)
            .map(person => button(`👤 ${truncate(person.name, 12)}`, "a", person.id, 0, "")),
        [{ text: "🌐 网页打开", url: buildSiteUrl(detail, season) }]
    ];
    return keyboard(rows);
}

async function sendDetailCard(chat, env, ctx, mediaType, id, season = null) {
    if (mediaType !== "movie" && mediaType !== "tv") throw new Error("条目类型无效，请重新搜索");
    await chat.typing();
    let detail;
    let seasonNote = "";
    try {
        detail = await getDetail(env, ctx, mediaType, id, season);
    } catch (error) {
        if (!season || error.status !== 404) throw error;
        // A season the series does not have still shows the series.
        seasonNote = `\n\n⚠️ ${escapeHtml(error.message)}`;
        season = null;
        detail = await getDetail(env, ctx, mediaType, id);
    }

    const caption = buildDetailCaption(detail, season) + seasonNote;
    const markup = buildDetailKeyboard(detail, season);
    const poster = safeHttpUrl(detail.poster);
    if (poster && [...caption].length <= CAPTION_LIMIT) {
        try {
            return await callTelegram(env, "sendPhoto", {
                chat_id: chat.chatId,
                photo: poster,
                caption,
                parse_mode: "HTML",
                reply_markup: markup
            });
        } catch (error) {
            logEvent("warn", "telegram_photo_failed", { error: logErrorMessage(error) });
        }
    }
    return chat.send(caption, markup);
}

async function sendSynopsis(chat, env, ctx, mediaType, id) {
    await chat.typing();
    const detail = await getDetail(env, ctx, mediaType, id);
    const wiki = await readHandler(handleWikiZh(detail.title || detail.originalTitle, ctx, {
        mediaType: detail.mediaType,
        year: detail.year ? String(detail.year) : null,
        id: String(detail.id),
        env
    })).catch(() => null);
    const text = typeof wiki?.extract === "string" && wiki.extract.trim() ? wiki.extract.trim() : String(detail.summary || "").trim();
    const source = wiki?.extract ? "中文 Wikipedia" : "TMDB";
    if (!text) return chat.send(`《${escapeHtml(detail.title)}》暂无简介。`);
    return chat.send(`<b>${escapeHtml(detail.title)}</b> · 简介（${source}）\n\n${escapeHtml(truncate(text, 3500))}`);
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
        `<b>${escapeHtml(detail.title)}</b> · 分季${totals ? `（${escapeHtml(totals)}）` : ""}\n\n${counts.map(escapeHtml).join("\n") || "暂无分季资料"}`,
        keyboard(grouped)
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

export function buildQuarkPage(detail, result, page, { stale = false } = {}) {
    const items = Array.isArray(result?.quarkUrls) ? result.quarkUrls.filter(item => safeHttpUrl(item?.url)) : [];
    const posts = [...(result?.resources || []), ...(result?.wpzysResources || []), ...(result?.zuidouyinResources || [])];
    const totalPages = Math.max(1, Math.ceil(items.length / QUARK_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), totalPages - 1);
    const pageItems = items.slice(current * QUARK_PAGE_SIZE, (current + 1) * QUARK_PAGE_SIZE);
    const header = `<b>${escapeHtml(detail.title)}</b>${detail.year ? ` (${escapeHtml(detail.year)})` : ""} · 夸克资源`;

    const lines = [header];
    if (items.length === 0) {
        lines.push("", posts.length
            ? `暂未提取到夸克链接，但找到 ${posts.length} 个资源帖，可点下方按钮查看。`
            : "暂未发现资源。可以稍后点“重新扫描”再试。");
    } else {
        lines.push(`共 ${items.length} 个分享链接`);
        pageItems.forEach((item, index) => {
            const number = current * QUARK_PAGE_SIZE + index + 1;
            const url = safeHttpUrl(item.url);
            lines.push("",
                `${number}. ${escapeHtml(truncate(item.title || item.sourceTitle || "夸克网盘分享", 90))}`,
                `🔗 <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
            if (item.password) lines.push(`🔑 提取码：<code>${escapeHtml(item.password)}</code>`);
            else if (item.passwordConflict) lines.push("🔑 提取码有多个候选，请到原帖确认");
            const source = safeHttpUrl(item.sourceUrl);
            if (source) lines.push(`📄 <a href="${escapeHtml(source)}">来源帖子</a>`);
        });
    }
    const notice = describeResourceProviders(result?.resourceMeta || result);
    if (notice) lines.push("", notice);
    if (stale) lines.push("", "⚠️ 本次重新扫描失败，显示的是之前的结果。");

    const copyButtons = pageItems
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

async function showQuarkPage(chat, env, ctx, message, args, answer, { refresh }) {
    const [mediaType, id, pageText] = args;
    const page = Number(pageText) || 0;
    const isFirstOpen = !refresh && page === 0 && !message.text?.includes("夸克资源");
    await answer(refresh || isFirstOpen ? "正在扫描资源，通常需要 5–15 秒…" : "");

    const detail = await getDetail(env, ctx, mediaType, id);
    // Opening resources from a detail card posts a new message; paging and
    // rescans edit the resource message in place.
    let targetId = isFirstOpen ? null : message.message_id;
    if (!targetId) {
        const placeholder = await chat.send(`<b>${escapeHtml(detail.title)}</b> · 夸克资源\n\n⏳ 正在扫描资源索引和论坛帖子…`);
        targetId = placeholder?.message_id;
    } else if (refresh) {
        await chat.edit(targetId, `<b>${escapeHtml(detail.title)}</b> · 夸克资源\n\n⏳ 正在重新扫描…`);
    }

    const response = await handleResourceSearch(detail.title || detail.originalTitle, env, ctx, {
        refresh,
        id: String(detail.id),
        mediaType: detail.mediaType,
        year: detail.year ? String(detail.year) : null
    });
    const stale = response.headers.get("X-iPlay-Stale") === "1";
    let result;
    try {
        result = await readHandler(response);
    } catch (error) {
        const text = `<b>${escapeHtml(detail.title)}</b> · 夸克资源\n\n😵 资源扫描失败：${escapeHtml(describeError(error))}`;
        const markup = keyboard([[button("🔄 重试", "rf", detail.mediaType, detail.id)]]);
        return targetId ? chat.edit(targetId, text, markup) : chat.send(text, markup);
    }
    const { text, markup } = buildQuarkPage(detail, result, page, { stale });
    return targetId ? chat.edit(targetId, text, markup) : chat.send(text, markup);
}

async function showPostPage(chat, env, ctx, message, args) {
    const [mediaType, id, pageText] = args;
    const detail = await getDetail(env, ctx, mediaType, id);
    const result = await getResources(env, ctx, detail);
    const posts = [...(result.resources || []), ...(result.wpzysResources || []), ...(result.zuidouyinResources || [])]
        .filter(post => safeHttpUrl(post?.url));
    const totalPages = Math.max(1, Math.ceil(posts.length / POST_PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(pageText) || 0), totalPages - 1);
    const lines = [`<b>${escapeHtml(detail.title)}</b> · 资源帖（${posts.length}）`];
    posts.slice(page * POST_PAGE_SIZE, (page + 1) * POST_PAGE_SIZE).forEach((post, index) => {
        const url = safeHttpUrl(post.url);
        lines.push("", `${page * POST_PAGE_SIZE + index + 1}. <a href="${escapeHtml(url)}">${escapeHtml(truncate(post.title || url, 90))}</a>`);
    });
    if (posts.length === 0) lines.push("", "暂无资源帖。");
    const markup = keyboard([
        paginationRow(page, totalPages, next => callbackData("rp", mediaType, id, next)),
        [button("🔙 夸克链接", "r", mediaType, id, 0)]
    ]);
    // Posts always get their own message so the Quark list stays available.
    if (message.text?.includes("资源帖")) return chat.edit(message.message_id, lines.join("\n"), markup);
    return chat.send(lines.join("\n"), markup);
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
        total ? `${filterName}：第 ${offset + 1}–${offset + credits.length} 部，共 ${total} 部。点击作品查看详情：` : `暂无${filterName}。`
    ].join("\n");

    const filterButton = (label, value) => button(filter === value ? `· ${label} ·` : label, "a", person.id, 0, value);
    const markup = keyboard([
        ...credits.map(credit => [button(
            truncate(`${candidateLabel(credit)}${credit.character ? ` 饰 ${credit.character}` : ""}`, 60),
            "d", credit.mediaType, credit.id
        )]),
        paginationRow(page, totalPages, next => callbackData("a", person.id, next * ACTOR_PAGE_SIZE, filter)),
        [filterButton("全部", ""), filterButton("电影", "movie"), filterButton("剧集", "tv")]
    ]);
    return messageId ? chat.edit(messageId, text, markup) : chat.send(text, markup);
}

async function showActorPage(chat, env, ctx, message, args) {
    const [personId, offsetText, filter = ""] = args;
    const mediaType = filter === "movie" || filter === "tv" ? filter : "";
    const data = await getPersonPage(env, ctx, personId, Math.max(0, Number(offsetText) || 0), mediaType);
    // Paging an actor list edits it; opening an actor from elsewhere posts one.
    const isActorList = typeof message.text === "string" && message.text.startsWith("👤");
    return renderActorPage(chat, isActorList ? message.message_id : null, data, mediaType);
}
