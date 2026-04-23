import { DoubanAPI, WikiAPI, ResourceAPI, GlobalRatingAPI, PosterAPI } from './api.js';
import { calculateRecommendationScore, getRecommendationLabel } from './scorer.js';

// DOM Elements
const els = {
    input: document.getElementById('searchInput'),
    loading: document.getElementById('loadingState'),
    error: document.getElementById('errorState'),
    errorMsg: document.getElementById('errorMsg'),
    results: document.getElementById('resultsArea'),

    cover: document.getElementById('showCover'),
    title: document.getElementById('showTitle'),
    subTitle: document.getElementById('showSubTitle'),

    doubanRating: document.getElementById('doubanRating'),
    imdbRatingBox: document.getElementById('imdbRatingBox'),
    imdbRating: document.getElementById('imdbRating'),
    rottenRatingBox: document.getElementById('rottenRatingBox'),
    rottenRating: document.getElementById('rottenRating'),

    tags: document.getElementById('showTags'),

    recScore: document.getElementById('recScore'),
    recLabel: document.getElementById('recLabel'),
    recBar: document.getElementById('recBar'),
    scoreDetails: document.getElementById('scoreDetails'),

    reportArea: document.getElementById('reportArea'),
    prosList: document.getElementById('prosList'),
    consList: document.getElementById('consList'),

    wikiSummary: document.getElementById('wikiSummary'),
    resourceList: document.getElementById('resourceList'),
    toast: document.getElementById('toast')
};

function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.style.transform = 'translateY(0)';
    els.toast.style.opacity = '1';
    setTimeout(() => {
        els.toast.style.transform = 'translateY(20px)';
        els.toast.style.opacity = '0';
    }, 3000);
}

/**
 * 加载海报 - 只从 OMDb 获取
 */
function loadPoster(posterUrl) {
    if (posterUrl) {
        els.cover.src = posterUrl;
    } else {
        els.cover.src = 'https://via.placeholder.com/400x600/141417/333333?text=NO+POSTER';
    }
}

// Main Process
async function handleSearch() {
    const query = els.input.value.trim();
    if (!query) return;

    els.error.classList.add('hidden');
    els.results.classList.add('hidden');
    els.loading.classList.remove('hidden');

    if (els.imdbRatingBox) els.imdbRatingBox.classList.add('hidden');
    if (els.rottenRatingBox) els.rottenRatingBox.classList.add('hidden');

    els.results.querySelectorAll('.fade-up').forEach(el => {
        el.style.animation = 'none';
        el.offsetHeight;
        el.style.animation = null;
    });

    try {
        // 1. 豆瓣基础搜索
        const searchData = await DoubanAPI.search(query);
        if (!searchData || searchData.length === 0) {
            throw new Error(`Satellite signal lost: No matching records for "${query}"`);
        }
        const show = searchData[0];

        els.title.textContent = show.title;
        els.subTitle.textContent = `${show.year} // ${show.type === 'movie' ? 'FILM' : 'SERIES'} // ID:${show.id}`;

        showToast("Signal locked. Initiating deep scan...");

        // 2. 并行获取所有数据
        const [doubanDetailResult, wikiData, resourceData, posterData] = await Promise.allSettled([
            DoubanAPI.getDetail(show.id),
            WikiAPI.getSummary(show.title),
            ResourceAPI.search(show.title),
            PosterAPI.getPoster(show.title, show.year) // 专用海报接口，会智能获取英文名
        ]);

        // 3. 处理豆瓣详情
        let doubanDetail = { rating: 0, votes: 0, genres: [], summary: "", imdbId: "" };

        if (doubanDetailResult.status === 'fulfilled' && doubanDetailResult.value && !doubanDetailResult.value.error) {
            doubanDetail = doubanDetailResult.value;
            els.doubanRating.textContent = doubanDetail.rating > 0 ? doubanDetail.rating.toFixed(1) : '-.-';
        } else {
            console.warn("Douban detail fetch failed:", doubanDetailResult);
            els.doubanRating.textContent = '?';
            showToast("Warning: Douban node unstable");
        }

        // 4. 处理海报 + 全球评分（全部来自 OMDb）
        let posterUrl = null;
        if (posterData.status === 'fulfilled' && posterData.value && !posterData.value.error) {
            const data = posterData.value;
            posterUrl = data.poster || null;

            if (data.imdb && els.imdbRatingBox) {
                els.imdbRating.textContent = data.imdb.toFixed(1);
                els.imdbRatingBox.classList.remove('hidden');
            }
            if (data.rottenTomatoes && els.rottenRatingBox) {
                els.rottenRating.textContent = `${data.rottenTomatoes}%`;
                els.rottenRating.className = data.rottenTomatoes >= 60
                    ? "text-red-500 font-bold"
                    : "text-green-500 font-bold";
                els.rottenRatingBox.classList.remove('hidden');
            }
        }

        // 5. 加载海报（纯 OMDb）
        loadPoster(posterUrl);

        // 6. 渲染类型标签
        if (doubanDetail.genres && doubanDetail.genres.length > 0) {
            els.tags.innerHTML = doubanDetail.genres.map(g =>
                `<span class="px-3 py-1 border border-cinema-700 text-cinema-100 text-xs font-mono uppercase tracking-widest rounded-full">${g}</span>`
            ).join('');
        } else {
            els.tags.innerHTML = `<span class="px-3 py-1 border border-cinema-700 text-cinema-400 text-xs font-mono uppercase tracking-widest rounded-full">UNKNOWN CLASS</span>`;
        }

        // 7. 渲染剧情简介（中文维基优先，豆瓣中文回退）
        let hasWiki = false;
        const wikiResult = wikiData.status === 'fulfilled' ? wikiData.value : null;

        if (wikiResult && wikiResult.extract && !wikiResult.error) {
            els.wikiSummary.innerHTML = `
                <span class="text-xs border border-cinema-700 px-2 py-1 rounded text-cinema-400 mb-2 inline-block">ZH.WIKIPEDIA</span><br>
                ${wikiResult.extract}
            `;
            hasWiki = true;
        } else if (doubanDetail.summary) {
            els.wikiSummary.innerHTML = `
                <span class="text-xs border border-cinema-700 px-2 py-1 rounded text-cinema-400 mb-2 inline-block">DOUBAN</span><br>
                ${doubanDetail.summary}
            `;
        } else {
            els.wikiSummary.innerHTML = `
                <span class="text-xs border border-cinema-700 px-2 py-1 rounded text-cinema-400 mb-2 inline-block">NO DATA</span><br>
                <span class="text-cinema-400 italic">暂无剧情简介</span>
            `;
        }

        // 8. 渲染资源
        els.resourceList.innerHTML = '';
        if (resourceData.status === 'fulfilled' && resourceData.value && resourceData.value.length > 0) {
            const links = resourceData.value;
            els.resourceList.innerHTML = links.slice(0, 5).map(link => `
                <li class="p-3 hover:bg-cinema-800 transition-colors group">
                    <a href="${link.url}" target="_blank" class="flex items-start gap-3">
                        <i class="fas fa-link text-[#0099ff] mt-1 opacity-70 group-hover:opacity-100"></i>
                        <span class="text-cinema-100 group-hover:text-white line-clamp-2 text-sm leading-snug">${link.title}</span>
                    </a>
                </li>
            `).join('');
        } else {
            els.resourceList.innerHTML = '<li class="p-4 text-sm font-mono text-cinema-400">No raw resources detected.</li>';
        }

        // 9. 计算推荐指数
        const scoreData = calculateRecommendationScore({
            ...doubanDetail,
            hasWiki
        });

        const labelInfo = getRecommendationLabel(scoreData.score);
        els.recScore.textContent = scoreData.score;
        els.recScore.className = `text-5xl md:text-7xl font-black font-mono ${labelInfo.color}`;

        els.recLabel.textContent = labelInfo.label;
        els.recLabel.className = `text-lg font-bold tracking-wider ${labelInfo.color}`;

        els.recBar.style.animation = 'none';
        els.recBar.offsetHeight;
        els.recBar.style.width = `${scoreData.score}%`;
        els.recBar.className = `h-full progress-bar ${
            scoreData.score >= 85 ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.5)]' :
            scoreData.score >= 70 ? 'bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]' :
            scoreData.score >= 50 ? 'bg-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.5)]' :
            'bg-accent-red shadow-[0_0_15px_rgba(229,9,20,0.5)]'
        }`;

        els.scoreDetails.innerHTML = `
            <span>BAS: ${scoreData.details.base}</span>
            <span>POP: ${scoreData.details.heat}</span>
            <span>PRF: ${scoreData.details.preference}</span>
        `;

        if (els.reportArea) {
            els.prosList.innerHTML = scoreData.report.pros.length > 0
                ? scoreData.report.pros.map(p => `<li class="flex gap-2 items-start"><i class="fas fa-plus text-green-500 mt-1"></i> <span>${p}</span></li>`).join('')
                : '<li class="text-cinema-400 italic">暂无突出亮点</li>';

            els.consList.innerHTML = scoreData.report.cons.length > 0
                ? scoreData.report.cons.map(c => `<li class="flex gap-2 items-start"><i class="fas fa-minus text-accent-red mt-1"></i> <span>${c}</span></li>`).join('')
                : '<li class="text-cinema-400 italic">暂无明显缺点</li>';
        }

        els.results.classList.remove('hidden');

    } catch (err) {
        if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError")) {
             els.errorMsg.textContent = "Unable to connect to Cloudflare Worker. Make sure the API_BASE is correctly configured and the Worker is deployed.";
        } else {
             els.errorMsg.textContent = err.message;
        }
        els.error.classList.remove('hidden');
    } finally {
        els.loading.classList.add('hidden');
    }
}

els.input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        els.input.blur();
        handleSearch();
    }
});
