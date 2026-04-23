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
            const imdbId = url.searchParams.get("imdb");
            if (imdbId) {
                return await handleOmdbById(imdbId);
            }
            return await handleOmdbSearch(url.searchParams.get("title"), url.searchParams.get("year"));
        }

        // 新增：专门的海报获取接口，优先 OMDb
        if (url.pathname.startsWith("/api/poster")) {
            return await handlePosterSearch(url.searchParams.get("title"), url.searchParams.get("year"));
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

// 豆瓣搜索 API 用简化 Headers（不要 Accept-Encoding，避免压缩问题）
const DOUBAN_SEARCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://movie.douban.com/"
};

// 豆瓣详情页用完整浏览器 Headers（需要 Cookie 绕过反爬）
const DOUBAN_DETAIL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://movie.douban.com/",
    "Cookie": "bid=xOqR3l3nZzE; __utmc=30149280"
};

async function handleDoubanSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
            headers: DOUBAN_SEARCH_HEADERS
        });
        const text = await res.text();
        // 防御：如果返回的是 JSONP 或空内容，做兼容处理
        const data = JSON.parse(text);
        return jsonResponse(data);
    } catch (e) {
        console.error("Douban search error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleDoubanDetail(id) {
    if (!id) return jsonResponse({ error: "Missing id" }, 400);

    try {
        const fetchUrl = `https://movie.douban.com/subject/${id}/`;
        const res = await fetch(fetchUrl, {
            headers: DOUBAN_DETAIL_HEADERS,
            redirect: "follow"
        });

        if (!res.ok) {
            console.warn(`Douban detail ${id} returned ${res.status}`);
            return jsonResponse({ error: `Douban rejected with status ${res.status}` }, res.status);
        }

        let result = {
            rating: 0, votes: 0, genres: [], summary: "", imdbId: ""
        };
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
                text(text) { if (isParsingSummary) result.summary += text.text; }
            })
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

        return jsonResponse(result);
    } catch (e) {
        console.error("Douban detail error:", e.message);
        return jsonResponse({ error: e.message }, 500);
    }
}

async function handleResourceSearch(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const res = await fetch(`https://by669.org/api/discussions?filter[q]=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] }
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
 * 专门的海报获取接口
 * 策略：用 OMDb 获取海报，如果标题搜不到，尝试从中文维基获取英文名再搜
 */
async function handlePosterSearch(title, year) {
    if (!title) return jsonResponse({ error: "Missing title" }, 400);

    try {
        // 1. 直接尝试用提供的标题搜 OMDb
        let result = await tryOmdbForPoster(title, year);
        if (result) return jsonResponse(result);

        // 2. 如果失败，尝试从中文维基获取英文名
        const enTitle = await getEnglishTitleFromWiki(title);
        if (enTitle && enTitle !== title) {
            result = await tryOmdbForPoster(enTitle, year);
            if (result) return jsonResponse(result);
        }

        return jsonResponse({ error: "No poster found" }, 404);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function tryOmdbForPoster(title, year) {
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`;
    if (year) url += `&y=${year}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.Response === "True" && data.Poster && data.Poster !== "N/A") {
        return {
            poster: data.Poster,
            imdb: data.imdbRating && data.imdbRating !== "N/A" ? parseFloat(data.imdbRating) : null,
            imdbVotes: data.imdbVotes,
            rottenTomatoes: extractRottenTomato(data.Ratings),
            imdbId: data.imdbID
        };
    }

    // 降级：不带年份重试
    if (year) {
        const fallbackRes = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`);
        const fallbackData = await fallbackRes.json();
        if (fallbackData.Response === "True" && fallbackData.Poster && fallbackData.Poster !== "N/A") {
            return {
                poster: fallbackData.Poster,
                imdb: fallbackData.imdbRating && fallbackData.imdbRating !== "N/A" ? parseFloat(fallbackData.imdbRating) : null,
                imdbVotes: fallbackData.imdbVotes,
                rottenTomatoes: extractRottenTomato(fallbackData.Ratings),
                imdbId: fallbackData.imdbID
            };
        }
    }

    return null;
}

async function getEnglishTitleFromWiki(zhTitle) {
    try {
        const searchRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(zhTitle)}&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const searchData = await searchRes.json();

        if (!searchData.query || !searchData.query.search.length) return null;

        const title = searchData.query.search[0].title;

        // 获取维基页面，从中提取英文名（通常在括号里）
        const pageRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=${encodeURIComponent(title)}&lllang=en&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const pageData = await pageRes.json();

        const pages = pageData.query.pages;
        const pageId = Object.keys(pages)[0];
        const langlinks = pages[pageId].langlinks;

        if (langlinks && langlinks.length > 0) {
            return langlinks[0]["*"]; // 英文标题
        }

        return null;
    } catch (e) {
        console.warn("Wiki English title fetch failed:", e);
        return null;
    }
}

function extractRottenTomato(ratings) {
    if (!ratings) return null;
    const rTomato = ratings.find(r => r.Source === "Rotten Tomatoes");
    return rTomato ? parseInt(rTomato.Value.replace('%', '')) : null;
}

async function handleWikiZh(query) {
    if (!query) return jsonResponse({ error: "Missing query" }, 400);

    try {
        const searchRes = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
        );
        const searchData = await searchRes.json();

        if (!searchData.query || !searchData.query.search.length) {
            return jsonResponse({ error: "Not found on zh.wikipedia" }, 404);
        }

        const title = searchData.query.search[0].title;

        const summaryRes = await fetch(
            `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
            { headers: { "User-Agent": DOUBAN_SEARCH_HEADERS["User-Agent"] } }
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
