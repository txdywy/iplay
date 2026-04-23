/**
 * Cloudflare Worker - iPlay API 代理
 * 部署指南：
 * 1. 在 Cloudflare 中创建一个新的 Worker
 * 2. 复制此文件代码贴入
 * 3. 前端 fetch('/api/search?q=...')
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

/**
 * 豆瓣搜索
 */
async function handleDoubanSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
            }
        });
        const data = await res.json();
        return jsonResponse(data);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

/**
 * 豆瓣详情抓取 (评分、类型、简介)
 * Note: Cloudflare Worker 支持原生 HTMLRewriter，可以高效解析 HTML
 */
async function handleDoubanDetail(id) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    try {
        const res = await fetch(`https://movie.douban.com/subject/${id}/`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
            }
        });

        if (!res.ok) throw new Error("Fetch failed");

        // 我们需要提取：评分(rating)、评价人数(votes)、类型(genres)、简介(summary)
        let result = { rating: 0, votes: 0, genres: [], summary: "" };

        // 使用 Cloudflare HTMLRewriter 提取数据，这比正则更稳且不耗费太多内存
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
                text(text) { result.summary += text.text.trim(); }
            });

        await rewriter.transform(res).text(); // 触发解析

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
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
            }
        });

        const data = await res.json();

        // 整理返回给前端的数据结构
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