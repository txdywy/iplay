/**
 * Cloudflare Worker - iPlay API 代理 (加强防屏蔽版 + OMDb 全球评分聚合)
 */

const OMDB_API_KEY = "80077e97"; // 用户提供的 OMDb API Key

export default {
    async fetch(request, env, ctx) {
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

        if (url.pathname.startsWith("/api/douban/search")) {
            return await handleDoubanSearch(url.searchParams.get("q"));
        }

        if (url.pathname.startsWith("/api/douban/detail")) {
            return await handleDoubanDetail(url.searchParams.get("id"));
        }

        if (url.pathname.startsWith("/api/resource")) {
            return await handleResourceSearch(url.searchParams.get("q"));
        }

        if (url.pathname.startsWith("/api/omdb")) {
            // 需要英文标题和年份来提高准确率
            return await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"));
        }

        return new Response("Not Found", { status: 404 });
    }
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": "*"
        }
    });
}

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "max-age=0"
};

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

async function handleDoubanDetail(id) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetch(fetchUrl, {
            headers: BROWSER_HEADERS,
            redirect: "follow"
        });

        if (!res.ok) {
            return jsonResponse({ error: `Douban rejected the request with status ${res.status}` }, res.status);
        }

        let result = { rating: 0, votes: 0, genres: [], summary: "" };
        let isParsingSummary = false;

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
                    if (isParsingSummary) result.summary += text.text;
                }
            })
            .on('span[property="v:summary"].all', {
                element(el) {
                    result.summary = "";
                    isParsingSummary = true;
                },
                text(text) {
                    if (isParsingSummary) result.summary += text.text;
                }
            });

        await rewriter.transform(res).text();
        result.summary = result.summary.replace(/\s+/g, ' ').trim();

        return jsonResponse(result);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

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

/**
 * 聚合全球评分 (IMDb & Rotten Tomatoes)
 */
async function handleOmdbSearch(title, year) {
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    try {
        // 先尝试带年份搜索（更精确）
        let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`;
        if (year) url += `&y=${year}`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.Response === "True") {
            return jsonResponse(extractOmdbRatings(data));
        }

        // 如果带年份没找到，可能年份有差，尝试不带年份
        if (year) {
            const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`);
            const fallbackData = await fallbackRes.json();
            if (fallbackData.Response === "True") {
                return jsonResponse(extractOmdbRatings(fallbackData));
            }
        }

        return jsonResponse({ error: "Not found on OMDb" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

function extractOmdbRatings(data) {
    let imdb = data.imdbRating && data.imdbRating !== "N/A" ? parseFloat(data.imdbRating) : null;
    let rotten = null;

    if (data.Ratings) {
        const rTomato = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
        if (rTomato) {
            rotten = parseInt(rTomato.Value.replace('%', ''));
        }
    }

    return {
        imdb,
        imdbVotes: data.imdbVotes,
        rottenTomatoes: rotten
    };
}