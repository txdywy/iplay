import { DoubanAPI, WikiAPI, ResourceAPI } from './api.js';
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
    tags: document.getElementById('showTags'),

    recScore: document.getElementById('recScore'),
    recLabel: document.getElementById('recLabel'),
    recBar: document.getElementById('recBar'),
    scoreDetails: document.getElementById('scoreDetails'),

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

// Main Process
async function handleSearch() {
    const query = els.input.value.trim();
    if (!query) return;

    els.error.classList.add('hidden');
    els.results.classList.add('hidden');
    els.loading.classList.remove('hidden');

    // Reset Animations
    els.results.querySelectorAll('.fade-up').forEach(el => {
        el.style.animation = 'none';
        el.offsetHeight; /* trigger reflow */
        el.style.animation = null;
    });

    try {
        // 1. 豆瓣基础搜索 (经由 Worker)
        const searchData = await DoubanAPI.search(query);
        if (!searchData || searchData.length === 0) {
            throw new Error(`Satellite signal lost: No matching records for "${query}"`);
        }
        const show = searchData[0];

        els.title.textContent = show.title;
        els.subTitle.textContent = `${show.year} // ${show.type === 'movie' ? 'FILM' : 'SERIES'} // ID:${show.id}`;
        if (show.img) els.cover.src = show.img.replace('s_ratio_poster', 'l_ratio_poster');

        showToast("Signal locked. Initiating deep scan...");

        // 2. 并行获取详情数据
        const [doubanDetailResult, wikiData, resourceData] = await Promise.allSettled([
            DoubanAPI.getDetail(show.id), // 现在直接返回解析好的 JSON
            WikiAPI.getSummary(show.title),
            ResourceAPI.search(show.title) // 也是返回解析好的 JSON Array
        ]);

        // 3. 处理豆瓣详情
        let doubanDetail = { rating: 0, votes: 0, genres: [] };
        if (doubanDetailResult.status === 'fulfilled' && doubanDetailResult.value) {
            doubanDetail = doubanDetailResult.value;
            els.doubanRating.textContent = doubanDetail.rating > 0 ? doubanDetail.rating.toFixed(1) : '-.-';
        } else {
            console.warn("Douban detail fetch failed");
            els.doubanRating.textContent = '?';
            showToast("Warning: Douban node unstable");
        }

        if (doubanDetail.genres && doubanDetail.genres.length > 0) {
            els.tags.innerHTML = doubanDetail.genres.map(g =>
                `<span class="px-3 py-1 border border-cinema-700 text-cinema-100 text-xs font-mono uppercase tracking-widest rounded-full">${g}</span>`
            ).join('');
        } else {
            els.tags.innerHTML = `<span class="px-3 py-1 border border-cinema-700 text-cinema-400 text-xs font-mono uppercase tracking-widest rounded-full">UNKNOWN CLASS</span>`;
        }

        // 4. 处理 Wiki
        let hasWiki = false;
        if (wikiData.status === 'fulfilled' && wikiData.value && wikiData.value.extract) {
            els.wikiSummary.textContent = wikiData.value.extract;
            hasWiki = true;
        } else {
            els.wikiSummary.textContent = doubanDetail.summary || "Classified file. No synopsis available in current sector.";
        }

        // 5. 处理资源 (by669)
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

        // 6. 计算推荐指数
        const scoreData = calculateRecommendationScore({
            ...doubanDetail,
            hasWiki
        });

        // 渲染推荐指数
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

        els.results.classList.remove('hidden');

    } catch (err) {
        // 判断是否是 Worker 连接失败
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