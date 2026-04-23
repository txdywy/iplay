/**
 * Cloudflare Worker - iPlay API 代理 (终极版)
 * 功能：
 * 1. 豆瓣搜索 + 详情抓取（含评分、类型、简介、IMDb ID）
 * 2. 通过 IMDb ID 直接查询 OMDb 获取 IMDb & 烂番茄评分
 * 3. 夸克资源搜索
 * 4. 中文 Wikipedia 剧情简介
 */

const OMDB_API_KEY = "80077e97";

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
            // 优先使用 IMDb ID 直接查询，精准度最高
            const imdbId = url.searchParams.get("imdb");
            if (imdbId) {
                return await handleOmdbById(imdbId);
            }
            // 降级：用英文标题搜索
            return await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"));
        }

        if (url.pathname.startsWith("/api/wiki/zh")) {
            return await handleWikiZh(url.searchParams.get("q"));
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
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
    "DNT": "1",
    "Sec-Ch-Ua": "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"",
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"macOS\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cookie": "bid=xOqR3l3nZzE; ap_v=0,6.0; ll=\"108288\"; __utmc=30149280"
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
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        let result = {
            rating: 0, votes: 0, genres: [], summary: "", imdbId: ""
        };
        let isParsingSummary = false;
        let isParsingImdb = false;

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
            // 豆瓣简介
            .on('span[property="v:summary"]', {
                element(el) { isParsingSummary = true; },
                text(text) { if (isParsingSummary) result.summary += text.text; }
            })
            .on('span[property="v:summary"].all', {
                element(el) { result.summary = ""; isParsingSummary = true; },
                text(text) { if (isParsingSummary) result.summary += text.text; }
            })
            // IMDb ID 提取：豆瓣详情页中 <span class="pl">IMDb:</span> 后面紧跟 tt 开头的 ID
            .on('span.pl', {
                text(text) {
                    if (text.text.includes("IMDb")) isParsingImdb = true;
                }
            })
            // IMDb ID 通常在紧跟的文本节点或 a 标签中
            .on('a[href*="imdb.com"]', {
                element(el) {
                    const href = el.getAttribute("href");
                    if (href) {
                        const match = href.match(/tt\d+/);
                        if (match) result.imdbId = match[0];
                    }
                }
            });

        await rewriter.transform(res).text();
        result.summary = result.summary.replace(/\s+/g, ' ').trim();

        // 如果上面没抓到 a 标签里的 IMDb，尝试从其他位置正则补充
        // 但 HTMLRewriter 已经处理了大部分情况

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
 * 通过 IMDb ID 直接查询 OMDb（最精准）
 */
async function handleOmdbById(imdbId) {
    try {
        const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`);
        const data = await res.json();

        if (data.Response === "True") {
            return jsonResponse(extractOmdbRatings(data));
        }
        return jsonResponse({ error: "OMDb: Not found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

/**
 * 通过英文标题搜索 OMDb（降级方案）
 */
async function handleOmdbSearch(title, year) {
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    try {
        let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`;
        if (year) url += `&y=${year}`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.Response === "True") {
            return jsonResponse(extractOmdbRatings(data));
        }

        // 降级：不带年份重试
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
        rottenTomatoes: rotten,
        poster: data.Poster && data.Poster !== "N/A" ? data.Poster : null
    };
}

/**
 * 中文 Wikipedia 摘要
 */
async function handleWikiZh(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        // 1. 搜索中文维基
        const searchRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
            { headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] } }
        );
        const searchData = await searchRes.json();

        if (!searchData.query || !searchData.query.search.length) {
            return jsonResponse({ error: "Not found on zh.wikipedia" }, 404);
        }

        const title = searchData.query.search[0].title;

        // 2. 获取中文摘要
        const summaryRes = await fetch(
            `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
            { headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] } }
        );
        const summaryData = await summaryRes.json();

        return jsonResponse({
            title: summaryData.title,
            extract: summaryData.extract,
            thumbnail: summaryData.thumbnail || null
        });
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}
