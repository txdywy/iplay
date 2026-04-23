/**
 * Cloudflare Worker - iPlay API 代理 (加强防屏蔽版)
 */

export default {
    async fetch(request, env, ctx) {
        // 1. 处理 CORS 预检请求 (Options)
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

        // 2. 路由处理
        if (url.pathname.startsWith("/api/douban/search")) {
            return await handleDoubanSearch(url.searchParams.get("q"));
        }

        if (url.pathname.startsWith("/api/douban/detail")) {
            return await handleDoubanDetail(url.searchParams.get("id"));
        }

        if (url.pathname.startsWith("/api/resource")) {
            return await handleResourceSearch(url.searchParams.get("q"));
        }

        return new Response("Not Found", { status: 404 });
    }
};

/**
 * 通用响应生成器 (带 CORS 头)
 */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": "*"
        }
    });
}

// 模拟真实浏览器的强力 Headers
const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua": "\"Not A(Brand\";v=\"99\", \"Google Chrome\";v=\"121\", \"Chromium\";v=\"121\"",
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"Windows\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1"
};

/**
 * 豆瓣搜索
 */
async function handleDoubanSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: BROWSER_HEADERS
        });
        const data = await res.json();
        return jsonResponse(data);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

/**
 * 豆瓣详情抓取 (评分、类型、简介)
 */
async function handleDoubanDetail(id) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetch(fetchUrl, {
            headers: BROWSER_HEADERS,
            // CF Worker 防止被强制重定向或缓存问题
            redirect: "follow"
        });

        if (!res.ok) {
            // 如果豆瓣依然报 403，返回特定的错误告知前端
            return jsonResponse({ error: `Douban rejected the request with status ${res.status}` }, res.status);
        }

        let result = { rating: 0, votes: 0, genres: [], summary: "" };
        let isParsingSummary = false;

        // 使用 HTMLRewriter
        const rewriter = new HTMLRewriter()
            .on('strong[property="v:average"]', {
                text(text) { result.rating = parseFloat(text.text) || result.rating; }
            })
            .on('span[property="v:votes"]', {
                text(text) { result.votes = parseInt(text.text) || result.votes; }
            })
            .on('span[property="v:genre"]', {
                text(text) { if(text.text.trim()) result.genres.push(text.text.trim()); }
            })
            .on('span[property="v:summary"]', {
                element(el) { isParsingSummary = true; },
                text(text) {
                    if (isParsingSummary) {
                        result.summary += text.text;
                    }
                }
            })
            .on('span[property="v:summary"].all', { // 处理折叠的长简介
                element(el) {
                    result.summary = ""; // 清空之前的短简介
                    isParsingSummary = true;
                },
                text(text) {
                    if (isParsingSummary) {
                        result.summary += text.text;
                    }
                }
            });

        await rewriter.transform(res).text();

        // 清理简介中的空白字符
        result.summary = result.summary.replace(/\s+/g, ' ').trim();

        return jsonResponse(result);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

/**
 * by669 夸克资源搜索
 */
async function handleResourceSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://by669.org/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] }
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