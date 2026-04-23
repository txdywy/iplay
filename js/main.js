import { TmdbAPI, DoubanAPI, WikiAPI, ResourceAPI, GlobalRatingAPI, PosterAPI } from './api.js';
import { calculateRecommendationScore, getRecommendationLabel } from './scorer.js';

const els = {
    input: document.getElementById('searchInput'),
    loading: document.getElementById('loadingState'),
    error: document.getElementById('errorState'),
    errorMsg: document.getElementById('errorMsg'),
    results: document.getElementById('resultsArea'),

    cover: document.getElementById('showCover'),
    title: document.getElementById('showTitle'),
    subTitle: document.getElementById('showSubTitle'),

    primaryRating: document.getElementById('doubanRating'),
    primaryRatingLabel: document.getElementById('doubanRatingLabel'),
    doubanBackupBox: document.getElementById('doubanBackupBox'),
    doubanBackupRating: document.getElementById('doubanBackupRating'),

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
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.style.transform = 'translateY(0)';
    els.toast.style.opacity = '1';
    setTimeout(() => {
        els.toast.style.transform = 'translateY(20px)';
        els.toast.style.opacity = '0';
    }, 3000);
}

function normalizeText(value) {
    return (value || '')
        .toLowerCase()
        .replace(/[\s\-_:,.!?()\[\]{}'"“”‘’·、，。·/\\]/g, '');
}

function pickBestTmdbMatch(results, query) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const normalizedQuery = normalizeText(query);
    const exact = results.find(item => {
        const title = normalizeText(item.title);
        const originalTitle = normalizeText(item.originalTitle);
        return title === normalizedQuery || originalTitle === normalizedQuery;
    });
    if (exact) return exact;

    const yearMatch = results.find(item => item.year && String(query).includes(String(item.year)));
    if (yearMatch) return yearMatch;

    return results[0];
}

const POSTER_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='600' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%23141417'/%3E%3Ctext x='50%25' y='50%25' fill='%23333333' font-family='monospace' font-size='28' text-anchor='middle' dominant-baseline='middle'%3ENO POSTER%3C/text%3E%3C/svg%3E";

function loadPoster(posterUrl) {
    if (posterUrl) {
        els.cover.src = posterUrl;
    } else {
        els.cover.src = POSTER_PLACEHOLDER;
    }
}

function setText(el, value) {
    if (!el) return;
    el.textContent = value;
}

function clearNode(node) {
    if (!node) return;
    node.textContent = '';
}

function appendBadgeList(container, values, emptyLabel) {
    if (!container) return;
    clearNode(container);
    if (!values || values.length === 0) {
        const span = document.createElement('span');
        span.className = 'px-3 py-1 border border-cinema-700 text-cinema-400 text-xs font-mono uppercase tracking-widest rounded-full';
        span.textContent = emptyLabel;
        container.appendChild(span);
        return;
    }

    values.forEach(value => {
        const span = document.createElement('span');
        span.className = 'px-3 py-1 border border-cinema-700 text-cinema-100 text-xs font-mono uppercase tracking-widest rounded-full';
        span.textContent = value;
        container.appendChild(span);
    });
}

function renderPrimaryRating(value, sourceLabel) {
    if (!els.primaryRating) return;
    els.primaryRating.textContent = value > 0 ? value.toFixed(1) : '-.-';
    els.primaryRating.className = `text-2xl font-mono font-bold ${sourceLabel === 'TMDB' ? 'text-accent-gold' : 'text-green-500'}`;
    if (els.primaryRatingLabel) {
        els.primaryRatingLabel.textContent = sourceLabel;
    }
}

function renderBackupDoubanRating(value) {
    if (!els.doubanBackupBox || !els.doubanBackupRating) return;
    if (value > 0) {
        els.doubanBackupRating.textContent = value.toFixed(1);
        els.doubanBackupBox.classList.remove('hidden');
    } else {
        els.doubanBackupBox.classList.add('hidden');
    }
}

function renderGenres(genres) {
    appendBadgeList(els.tags, genres, 'UNKNOWN CLASS');
}

function renderSynopsis(sourceLabel, text) {
    if (!els.wikiSummary) return;
    els.wikiSummary.textContent = '';

    const source = document.createElement('span');
    source.className = 'text-xs border border-cinema-700 px-2 py-1 rounded text-cinema-400 mb-2 inline-block';
    source.textContent = sourceLabel;
    els.wikiSummary.appendChild(source);
    els.wikiSummary.appendChild(document.createElement('br'));

    if (text && text.trim()) {
        const body = document.createElement('div');
        body.className = 'whitespace-pre-wrap';
        body.textContent = text;
        els.wikiSummary.appendChild(body);
    } else {
        const empty = document.createElement('span');
        empty.className = 'text-cinema-400 italic';
        empty.textContent = '暂无剧情简介';
        els.wikiSummary.appendChild(empty);
    }
}

function renderResources(links) {
    if (!els.resourceList) return;
    clearNode(els.resourceList);

    if (Array.isArray(links) && links.length > 0) {
        links.slice(0, 5).forEach(link => {
            const li = document.createElement('li');
            li.className = 'p-3 hover:bg-cinema-800 transition-colors group';

            const a = document.createElement('a');
            a.href = link.url;
            a.target = '_blank';
            a.className = 'flex items-start gap-3';

            const icon = document.createElement('i');
            icon.className = 'fas fa-link text-[#0099ff] mt-1 opacity-70 group-hover:opacity-100';

            const title = document.createElement('span');
            title.className = 'text-cinema-100 group-hover:text-white line-clamp-2 text-sm leading-snug';
            title.textContent = link.title;

            a.appendChild(icon);
            a.appendChild(title);
            li.appendChild(a);
            els.resourceList.appendChild(li);
        });
    } else {
        const li = document.createElement('li');
        li.className = 'p-4 text-sm font-mono text-cinema-400';
        li.textContent = 'No raw resources detected.';
        els.resourceList.appendChild(li);
    }
}

function renderScore(data, sourceLabel) {
    const scoreData = calculateRecommendationScore({
        rating: data.rating,
        votes: data.votes,
        genres: data.genres,
        hasWiki: data.hasWiki,
        summary: data.summary,
        source: data.source
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

    clearNode(els.scoreDetails);
    [
        `SRC: ${sourceLabel}`,
        `BAS: ${scoreData.details.base}`,
        `POP: ${scoreData.details.heat}`,
        `PRF: ${scoreData.details.preference}`
    ].forEach(text => {
        const span = document.createElement('span');
        span.textContent = text;
        els.scoreDetails.appendChild(span);
    });

    if (els.reportArea) {
        clearNode(els.prosList);
        clearNode(els.consList);

        if (scoreData.report.pros.length > 0) {
            scoreData.report.pros.forEach(p => {
                const li = document.createElement('li');
                li.className = 'flex gap-2 items-start';
                const icon = document.createElement('i');
                icon.className = 'fas fa-plus text-green-500 mt-1';
                const span = document.createElement('span');
                span.textContent = p;
                li.appendChild(icon);
                li.appendChild(span);
                els.prosList.appendChild(li);
            });
        } else {
            const li = document.createElement('li');
            li.className = 'text-cinema-400 italic';
            li.textContent = '暂无突出亮点';
            els.prosList.appendChild(li);
        }

        if (scoreData.report.cons.length > 0) {
            scoreData.report.cons.forEach(c => {
                const li = document.createElement('li');
                li.className = 'flex gap-2 items-start';
                const icon = document.createElement('i');
                icon.className = 'fas fa-minus text-accent-red mt-1';
                const span = document.createElement('span');
                span.textContent = c;
                li.appendChild(icon);
                li.appendChild(span);
                els.consList.appendChild(li);
            });
        } else {
            const li = document.createElement('li');
            li.className = 'text-cinema-400 italic';
            li.textContent = '暂无明显缺点';
            els.consList.appendChild(li);
        }
    }
}

async function safeTmdbSearch(query) {
    try {
        return await TmdbAPI.search(query);
    } catch (error) {
        console.warn('TMDB search failed:', error);
        return null;
    }
}

async function safeDoubanFallback(query) {
    try {
        const searchData = await DoubanAPI.search(query);
        if (!searchData || searchData.length === 0) return null;

        const show = searchData[0];
        const detail = await DoubanAPI.getDetail(show.id).catch(() => null);
        return { show, detail };
    } catch (error) {
        console.warn('Douban fallback failed:', error);
        return null;
    }
}

function resetRatingBoxes() {
    if (els.imdbRatingBox) els.imdbRatingBox.classList.add('hidden');
    if (els.rottenRatingBox) els.rottenRatingBox.classList.add('hidden');
    if (els.doubanBackupBox) els.doubanBackupBox.classList.add('hidden');
}

async function handleSearch() {
    const query = els.input.value.trim();
    if (!query) return;

    els.error.classList.add('hidden');
    els.results.classList.add('hidden');
    els.loading.classList.remove('hidden');
    resetRatingBoxes();

    els.results.querySelectorAll('.fade-up').forEach(el => {
        el.style.animation = 'none';
        el.offsetHeight;
        el.style.animation = null;
    });

    try {
        const tmdbSearch = await safeTmdbSearch(query);
        const tmdbResults = tmdbSearch && Array.isArray(tmdbSearch.results) ? tmdbSearch.results : [];

        if (tmdbResults.length > 0) {
            const candidate = pickBestTmdbMatch(tmdbResults, query);
            if (!candidate) throw new Error(`Satellite signal lost: No matching records for "${query}"`);

            showToast('Signal locked. Initiating deep scan...');
            setText(els.title, candidate.title);
            setText(els.subTitle, `${candidate.year || '????'} // ${candidate.mediaType === 'movie' ? 'FILM' : 'SERIES'} // TMDB:${candidate.id}`);

            const [tmdbDetailResult, wikiData, resourceData, posterData, doubanSearchResult] = await Promise.allSettled([
                TmdbAPI.getDetail(candidate.id, candidate.mediaType),
                WikiAPI.getSummary(candidate.title),
                ResourceAPI.search(candidate.title),
                PosterAPI.getPoster(candidate.title, candidate.year),
                DoubanAPI.search(query)
            ]);

            const tmdbDetail = tmdbDetailResult.status === 'fulfilled' && tmdbDetailResult.value && !tmdbDetailResult.value.error
                ? tmdbDetailResult.value
                : null;

            let doubanDetail = null;
            const doubanSearchData = doubanSearchResult.status === 'fulfilled' ? doubanSearchResult.value : null;
            const needsDoubanFallback = !tmdbDetail || !tmdbDetail.summary || !tmdbDetail.genres || tmdbDetail.genres.length === 0 || !tmdbDetail.tmdbRating;
            if (needsDoubanFallback && Array.isArray(doubanSearchData) && doubanSearchData.length > 0) {
                doubanDetail = await DoubanAPI.getDetail(doubanSearchData[0].id).catch(() => null);
            }

            const wikiResult = wikiData.status === 'fulfilled' ? wikiData.value : null;
            const resourceResult = resourceData.status === 'fulfilled' ? resourceData.value : [];
            const posterResult = posterData.status === 'fulfilled' ? posterData.value : null;

            const summary = (tmdbDetail && tmdbDetail.summary) || (wikiResult && wikiResult.extract) || (doubanDetail && doubanDetail.summary) || candidate.summary || '';
            const genres = tmdbDetail && tmdbDetail.genres && tmdbDetail.genres.length > 0
                ? tmdbDetail.genres
                : doubanDetail && doubanDetail.genres ? doubanDetail.genres : [];
            const rating = (tmdbDetail && tmdbDetail.tmdbRating) || (doubanDetail && doubanDetail.rating) || candidate.tmdbRating || 0;
            const votes = (tmdbDetail && tmdbDetail.tmdbVotes) || (doubanDetail && doubanDetail.votes) || candidate.tmdbVotes || 0;
            const imdbId = (tmdbDetail && tmdbDetail.imdbId) || (doubanDetail && doubanDetail.imdbId) || candidate.imdbId || null;
            const posterUrl = (tmdbDetail && tmdbDetail.poster) || candidate.poster || (posterResult && !posterResult.tmdb ? posterResult.poster : null);

            renderPrimaryRating(rating, 'TMDB');
            renderBackupDoubanRating(doubanDetail && doubanDetail.rating ? doubanDetail.rating : 0);
            renderGenres(genres);
            renderSynopsis(wikiResult && wikiResult.extract ? 'ZH.WIKIPEDIA' : tmdbDetail && tmdbDetail.summary ? 'TMDB' : doubanDetail && doubanDetail.summary ? 'DOUBAN' : 'NO DATA', summary);
            renderResources(resourceResult);
            loadPoster(posterUrl);

            let externalRatings = null;
            if (imdbId) {
                externalRatings = await GlobalRatingAPI.getRatings(imdbId, tmdbDetail ? tmdbDetail.originalTitle : candidate.originalTitle, tmdbDetail ? tmdbDetail.year : candidate.year).catch(() => null);
            }

            const posterIsTmdb = Boolean(posterResult && posterResult.tmdb);
            const imdbScore = externalRatings && externalRatings.imdb
                ? externalRatings.imdb
                : !posterIsTmdb && posterResult && posterResult.imdb
                    ? posterResult.imdb
                    : null;
            const rottenScore = externalRatings && externalRatings.rottenTomatoes
                ? externalRatings.rottenTomatoes
                : !posterIsTmdb && posterResult && posterResult.rottenTomatoes
                    ? posterResult.rottenTomatoes
                    : null;

            if (imdbScore && els.imdbRatingBox) {
                els.imdbRating.textContent = imdbScore.toFixed(1);
                els.imdbRatingBox.classList.remove('hidden');
            }
            if (rottenScore && els.rottenRatingBox) {
                els.rottenRating.textContent = `${rottenScore}%`;
                els.rottenRating.className = rottenScore >= 60
                    ? 'text-red-500 font-bold'
                    : 'text-green-500 font-bold';
                els.rottenRatingBox.classList.remove('hidden');
            }

            renderScore({
                rating,
                votes,
                genres,
                hasWiki: Boolean(wikiResult && wikiResult.extract),
                summary,
                source: 'tmdb'
            }, 'TMDB');

            els.results.classList.remove('hidden');
            return;
        }

        const doubanFallback = await safeDoubanFallback(query);
        if (!doubanFallback || !doubanFallback.show) {
            throw new Error(`Satellite signal lost: No matching records for "${query}"`);
        }

        const show = doubanFallback.show;
        const doubanDetail = doubanFallback.detail && !doubanFallback.detail.error ? doubanFallback.detail : { rating: 0, votes: 0, genres: [], summary: '', imdbId: '' };

        showToast('TMDB unavailable. Falling back to Douban...');
        setText(els.title, show.title);
        setText(els.subTitle, `${show.year || '????'} // ${show.type === 'movie' ? 'FILM' : 'SERIES'} // DOUBAN:${show.id}`);

        const [wikiData, resourceData, posterData] = await Promise.allSettled([
            WikiAPI.getSummary(show.title),
            ResourceAPI.search(show.title),
            PosterAPI.getPoster(show.title, show.year)
        ]);

        const wikiResult = wikiData.status === 'fulfilled' ? wikiData.value : null;
        const resourceResult = resourceData.status === 'fulfilled' ? resourceData.value : [];
        const posterResult = posterData.status === 'fulfilled' ? posterData.value : null;
        const summary = (wikiResult && wikiResult.extract) || doubanDetail.summary || '';
        const posterUrl = posterResult && posterResult.poster ? posterResult.poster : null;

        renderPrimaryRating(doubanDetail.rating || 0, 'DOUBAN');
        renderBackupDoubanRating(0);
        renderGenres(doubanDetail.genres || []);
        renderSynopsis(wikiResult && wikiResult.extract ? 'ZH.WIKIPEDIA' : doubanDetail.summary ? 'DOUBAN' : 'NO DATA', summary);
        renderResources(resourceResult);
        loadPoster(posterUrl);

        if (posterResult && posterResult.imdb && els.imdbRatingBox) {
            els.imdbRating.textContent = posterResult.imdb.toFixed(1);
            els.imdbRatingBox.classList.remove('hidden');
        }
        if (posterResult && posterResult.rottenTomatoes && els.rottenRatingBox) {
            els.rottenRating.textContent = `${posterResult.rottenTomatoes}%`;
            els.rottenRating.className = posterResult.rottenTomatoes >= 60
                ? 'text-red-500 font-bold'
                : 'text-green-500 font-bold';
            els.rottenRatingBox.classList.remove('hidden');
        }

        renderScore({
            rating: doubanDetail.rating || 0,
            votes: doubanDetail.votes || 0,
            genres: doubanDetail.genres || [],
            hasWiki: Boolean(wikiResult && wikiResult.extract),
            summary,
            source: 'douban'
        }, 'DOUBAN');

        els.results.classList.remove('hidden');
    } catch (err) {
        if (err && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
            els.errorMsg.textContent = 'Unable to connect to Cloudflare Worker. Make sure the API_BASE is correctly configured and the Worker is deployed.';
        } else {
            els.errorMsg.textContent = err && err.message ? err.message : 'Unknown error';
        }
        els.error.classList.remove('hidden');
    } finally {
        els.loading.classList.add('hidden');
    }
}

els.input.addEventListener('keypress', e => {
    if (e.key === 'Enter') {
        els.input.blur();
        handleSearch();
    }
});
