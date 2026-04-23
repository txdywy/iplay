import { TmdbAPI, DoubanAPI, WikiAPI, ResourceAPI, PosterAPI } from './api.js';
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

    primaryRating: document.getElementById('tmdbRatingValue'),
    primaryRatingMobile: document.getElementById('tmdbRatingValueMobile'),
    primaryRatingLabel: document.getElementById('tmdbRatingLabel'),
    primaryRatingLabelMobile: document.getElementById('tmdbRatingLabelMobile'),
    doubanBackupBox: document.getElementById('doubanBackupBox'),
    doubanBackupRating: document.getElementById('doubanBackupRating'),

    imdbRatingBox: document.getElementById('imdbRatingBox'),
    imdbRating: document.getElementById('imdbRating'),
    rottenRatingBox: document.getElementById('rottenRatingBox'),
    rottenRating: document.getElementById('rottenRating'),

    tmdbFacts: document.getElementById('tmdbFacts'),
    tmdbOverview: document.getElementById('tmdbOverview'),
    omdbPanel: document.getElementById('omdbPanel'),
    omdbFields: document.getElementById('omdbFields'),

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
    const text = value > 0 ? value.toFixed(1) : '-.-';
    const colorClass = sourceLabel === 'TMDB' ? 'text-accent-gold' : 'text-green-500';

    if (els.primaryRating) {
        els.primaryRating.textContent = text;
        els.primaryRating.className = `text-2xl font-mono font-bold ${colorClass}`;
    }

    if (els.primaryRatingMobile) {
        els.primaryRatingMobile.textContent = text;
        els.primaryRatingMobile.className = `text-2xl font-mono font-bold ${colorClass}`;
    }

    if (els.primaryRatingLabel) {
        els.primaryRatingLabel.textContent = sourceLabel;
    }

    if (els.primaryRatingLabelMobile) {
        els.primaryRatingLabelMobile.textContent = sourceLabel;
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

function formatValue(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    if (Array.isArray(value)) {
        return value.length > 0 ? value.join(' / ') : fallback;
    }
    return String(value);
}

function formatCount(value) {
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return '—';
    return new Intl.NumberFormat('en-US').format(value);
}

function createInfoCard(label, value, { wide = false, muted = false } = {}) {
    const card = document.createElement('div');
    card.className = `${wide ? 'sm:col-span-2' : ''} rounded-2xl border border-cinema-700 bg-cinema-900/35 p-3 md:p-4`;

    const meta = document.createElement('div');
    meta.className = 'text-[10px] uppercase tracking-[0.35em] text-cinema-400';
    meta.textContent = label;

    const body = document.createElement('div');
    body.className = `mt-2 text-sm leading-relaxed ${muted ? 'text-cinema-400 italic' : 'text-cinema-100'} break-words`;
    body.textContent = formatValue(value);

    card.appendChild(meta);
    card.appendChild(body);
    return card;
}

function renderGenres(genres) {
    appendBadgeList(els.tags, genres, 'UNKNOWN CLASS');
}

function renderTmdbFacts(tmdbDetail, candidate, overviewText) {
    if (!els.tmdbFacts) return;

    clearNode(els.tmdbFacts);

    const title = tmdbDetail?.title || candidate?.title || '—';
    const originalTitle = tmdbDetail?.originalTitle || candidate?.originalTitle || '—';
    const mediaType = tmdbDetail?.mediaType || candidate?.mediaType || candidate?.type || '—';
    const year = tmdbDetail?.year || candidate?.year || '—';
    const tmdbId = tmdbDetail?.id || candidate?.id || candidate?.tmdbId || '—';
    const imdbId = tmdbDetail?.imdbId || candidate?.imdbId || '—';
    const votes = formatCount(tmdbDetail?.tmdbVotes || candidate?.tmdbVotes || candidate?.votes || 0);
    const popularity = typeof tmdbDetail?.popularity === 'number'
        ? tmdbDetail.popularity.toFixed(1)
        : typeof candidate?.popularity === 'number'
            ? candidate.popularity.toFixed(1)
            : '—';

    [
        createInfoCard('Title', title),
        createInfoCard('Original', originalTitle),
        createInfoCard('Type', mediaType === 'movie' ? 'FILM' : mediaType === 'tv' ? 'SERIES' : mediaType),
        createInfoCard('Year', year),
        createInfoCard('TMDB ID', `#${tmdbId}`),
        createInfoCard('IMDb ID', imdbId),
        createInfoCard('Votes', votes),
        createInfoCard('Popularity', popularity)
    ].forEach(card => els.tmdbFacts.appendChild(card));

    if (els.tmdbOverview) {
        els.tmdbOverview.textContent = overviewText && overviewText.trim() ? overviewText : '暂无 TMDB 概述';
        els.tmdbOverview.classList.toggle('italic', !overviewText || !overviewText.trim());
        els.tmdbOverview.classList.toggle('text-cinema-400', !overviewText || !overviewText.trim());
    }
}

function renderOmdbProfile(omdbProfile) {
    if (!els.omdbPanel || !els.omdbFields) return;

    const profile = omdbProfile && typeof omdbProfile === 'object' ? omdbProfile : null;
    clearNode(els.omdbFields);

    if (!profile) {
        els.omdbPanel.classList.add('hidden');
        if (els.imdbRatingBox) els.imdbRatingBox.classList.add('hidden');
        if (els.rottenRatingBox) els.rottenRatingBox.classList.add('hidden');
        return;
    }

    const cards = [];
    const type = profile.type === 'movie' ? 'FILM' : profile.type === 'series' ? 'SERIES' : formatValue(profile.type);

    if (profile.rated || profile.released || profile.runtime) {
        cards.push(createInfoCard('Rated', profile.rated));
        cards.push(createInfoCard('Released', profile.released));
        cards.push(createInfoCard('Runtime', profile.runtime ? `${profile.runtime} min` : '—'));
    }

    if (profile.metascore) {
        cards.push(createInfoCard('Metascore', `${profile.metascore}/100`));
    }

    if (profile.genres && profile.genres.length > 0) {
        cards.push(createInfoCard('Genre', profile.genres));
    }

    cards.push(createInfoCard('Language', profile.language));
    cards.push(createInfoCard('Country', profile.country));
    cards.push(createInfoCard('Director', profile.director));
    cards.push(createInfoCard('Writer', profile.writer));
    cards.push(createInfoCard('Cast', profile.actors, { wide: true }));
    cards.push(createInfoCard('Plot', profile.plot, { wide: true }));
    cards.push(createInfoCard('Awards', profile.awards, { wide: true }));
    cards.push(createInfoCard('Box Office', profile.boxOffice));
    cards.push(createInfoCard('Production', profile.production));
    cards.push(createInfoCard('Title', profile.title));
    cards.push(createInfoCard('Year', profile.year));
    cards.push(createInfoCard('Type', type));
    cards.push(createInfoCard('IMDb ID', profile.imdbId));
    cards.push(createInfoCard('IMDb Votes', profile.imdbVotes));

    cards.forEach(card => els.omdbFields.appendChild(card));

    const hasProfileData = Boolean(
        profile.rated ||
        profile.released ||
        profile.runtime ||
        profile.metascore ||
        (profile.genres && profile.genres.length > 0) ||
        profile.language ||
        profile.country ||
        profile.director ||
        profile.writer ||
        profile.actors ||
        profile.plot ||
        profile.awards ||
        profile.boxOffice ||
        profile.production ||
        profile.imdb ||
        profile.imdbVotes ||
        profile.imdbId
    );
    els.omdbPanel.classList.toggle('hidden', !hasProfileData);

    const imdbScore = typeof profile.imdb === 'number' ? profile.imdb : null;
    if (els.imdbRatingBox && els.imdbRating) {
        if (imdbScore && imdbScore > 0) {
            els.imdbRating.textContent = imdbScore.toFixed(1);
            els.imdbRating.className = 'text-2xl font-mono font-bold text-accent-gold';
            els.imdbRatingBox.classList.remove('hidden');
        } else {
            els.imdbRatingBox.classList.add('hidden');
        }
    }

    const rottenScore = typeof profile.rottenTomatoes === 'number' ? profile.rottenTomatoes : null;
    if (els.rottenRatingBox && els.rottenRating) {
        if (rottenScore && rottenScore > 0) {
            els.rottenRating.textContent = `${rottenScore}%`;
            els.rottenRating.className = `text-2xl font-mono font-bold ${rottenScore >= 75 ? 'text-green-500' : rottenScore >= 60 ? 'text-yellow-500' : 'text-accent-red'}`;
            els.rottenRatingBox.classList.remove('hidden');
        } else {
            els.rottenRatingBox.classList.add('hidden');
        }
    }
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
    els.recLabel.textContent = labelInfo.label;

    const scoreClass = `text-5xl md:text-7xl font-black font-mono ${labelInfo.color}`;
    els.recScore.className = scoreClass;
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

            const [tmdbDetailResult, wikiData, resourceData, posterData] = await Promise.allSettled([
                TmdbAPI.getDetail(candidate.id, candidate.mediaType),
                WikiAPI.getSummary(candidate.title),
                ResourceAPI.search(candidate.title),
                PosterAPI.getPoster(candidate.title, candidate.year)
            ]);

            const tmdbDetail = tmdbDetailResult.status === 'fulfilled' && tmdbDetailResult.value && !tmdbDetailResult.value.error
                ? tmdbDetailResult.value
                : null;

            let doubanDetail = null;
            const needsDoubanFallback = !tmdbDetail || !tmdbDetail.summary || !tmdbDetail.genres || tmdbDetail.genres.length === 0 || !tmdbDetail.tmdbRating;
            if (needsDoubanFallback) {
                const doubanSearchData = await DoubanAPI.search(query).catch(() => null);
                if (Array.isArray(doubanSearchData) && doubanSearchData.length > 0) {
                    doubanDetail = await DoubanAPI.getDetail(doubanSearchData[0].id).catch(() => null);
                }
            }

            const wikiResult = wikiData.status === 'fulfilled' ? wikiData.value : null;
            const resourceResult = resourceData.status === 'fulfilled' ? resourceData.value : [];
            const posterResult = posterData.status === 'fulfilled' ? posterData.value : null;
            const omdbProfile = posterResult && posterResult.omdb ? posterResult : null;

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
            renderTmdbFacts(tmdbDetail, candidate, summary);
            renderOmdbProfile(omdbProfile);

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
        renderTmdbFacts(null, show, summary);
        renderOmdbProfile(posterResult && posterResult.omdb ? posterResult : null);

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
