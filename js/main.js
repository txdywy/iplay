import { TmdbAPI, DoubanAPI, WikiAPI, ResourceAPI, PosterAPI } from './api.js';
import { calculateRecommendationScore, getRecommendationLabel } from './scorer.js';

const els = {
    input: document.getElementById('searchInput'),
    searchForm: document.getElementById('searchForm'),
    searchButton: document.getElementById('searchButton'),
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
    quarkUrlList: document.getElementById('quarkUrlList'),
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
        .replace(/[\s\-_:,.!?()[\]{}'"“”‘’·、，。·/\\]/g, '');
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

    const loose = results.find(item => {
        const title = normalizeText(item.title);
        const originalTitle = normalizeText(item.originalTitle);
        return title.includes(normalizedQuery) || originalTitle.includes(normalizedQuery)
            || (title.length >= 2 && normalizedQuery.includes(title))
            || (originalTitle.length >= 2 && normalizedQuery.includes(originalTitle));
    });
    if (loose) return loose;

    const yearMatch = results.find(item => item.year && String(query).includes(String(item.year)));
    if (yearMatch) return yearMatch;

    return results[0];
}

function pickBestDoubanMatch(results, query) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const normalizedQuery = normalizeText(query);
    const exact = results.find(item => normalizeText(item.title) === normalizedQuery);
    if (exact) return exact;

    const loose = results.find(item => normalizeText(item.title).includes(normalizedQuery) || normalizedQuery.includes(normalizeText(item.title)));
    if (loose) return loose;

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

    const frag = document.createDocumentFragment();
    values.forEach(value => {
        const span = document.createElement('span');
        span.className = 'px-3 py-1 border border-cinema-700 text-cinema-100 text-xs font-mono uppercase tracking-widest rounded-full';
        span.textContent = value;
        frag.appendChild(span);
    });
    container.appendChild(frag);
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

function appendInfoCards(container, cards) {
    if (!container || !Array.isArray(cards)) return;
    const frag = document.createDocumentFragment();
    cards.forEach(card => frag.appendChild(card));
    container.appendChild(frag);
}

function buildTmdbViewModel(candidate, tmdbDetail, wikiResult, posterResult) {
    const detail = tmdbDetail && typeof tmdbDetail === 'object' ? tmdbDetail : null;
    const source = detail || candidate || {};
    const omdbProfile = posterResult && posterResult.omdb
        ? (typeof posterResult.omdb === 'object' ? posterResult.omdb : posterResult)
        : null;
    return {
        detail,
        candidate: candidate || {},
        title: source.title || candidate?.title || '—',
        subtitle: `${source.year || candidate?.year || '????'} // ${source.mediaType === 'movie' ? 'FILM' : source.mediaType === 'tv' ? 'SERIES' : 'TMDB'} // TMDB:${source.id || candidate?.id || '—'}`,
        summary: source.summary || (wikiResult && wikiResult.extract) || candidate?.summary || '',
        genres: Array.isArray(source.genres) && source.genres.length > 0 ? source.genres : [],
        rating: source.tmdbRating ?? candidate?.tmdbRating ?? 0,
        votes: source.tmdbVotes ?? candidate?.tmdbVotes ?? candidate?.votes ?? 0,
        posterUrl: source.poster || candidate?.poster || (posterResult && !posterResult.tmdb ? posterResult.poster : null),
        omdbProfile,
        overviewSource: wikiResult && wikiResult.extract ? 'ZH.WIKIPEDIA' : detail && detail.summary ? 'TMDB' : 'NO DATA'
    };
}

function createInfoCard(label, value, { wide = false, muted = false } = {}) {
    const card = document.createElement('div');
    card.className = `${wide ? 'md:col-span-2' : ''} rounded-2xl border border-cinema-700 bg-cinema-900/35 p-3 md:p-4`;

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

function renderTmdbFacts(viewModel) {
    if (!els.tmdbFacts) return;

    clearNode(els.tmdbFacts);

    const candidate = viewModel?.candidate || {};
    const detail = viewModel?.detail || {};
    const mediaType = detail.mediaType || candidate.mediaType || candidate.type || '—';

    appendInfoCards(els.tmdbFacts, [
        createInfoCard('Title', viewModel?.title || candidate.title),
        createInfoCard('Original', detail.originalTitle || candidate.originalTitle),
        createInfoCard('Type', mediaType === 'movie' ? 'FILM' : mediaType === 'tv' ? 'SERIES' : mediaType),
        createInfoCard('Year', detail.year || candidate.year),
        createInfoCard('TMDB ID', detail.id ? `#${detail.id}` : candidate.id ? `#${candidate.id}` : '—'),
        createInfoCard('IMDb ID', detail.imdbId || candidate.imdbId || '—'),
        createInfoCard('Votes', formatCount(detail.tmdbVotes || candidate.tmdbVotes || candidate.votes || 0)),
        createInfoCard('Popularity', typeof detail.popularity === 'number' ? detail.popularity.toFixed(1) : typeof candidate.popularity === 'number' ? candidate.popularity.toFixed(1) : '—')
    ]);

    if (els.tmdbOverview) {
        els.tmdbOverview.textContent = viewModel?.summary && viewModel.summary.trim() ? viewModel.summary : '暂无 TMDB 概述';
        els.tmdbOverview.classList.toggle('italic', !viewModel?.summary || !viewModel.summary.trim());
        els.tmdbOverview.classList.toggle('text-cinema-400', !viewModel?.summary || !viewModel.summary.trim());
    }
}

function renderTmdbProfile(viewModel) {
    if (!els.omdbPanel || !els.omdbFields) return;

    const vm = viewModel && typeof viewModel === 'object' ? viewModel : null;
    clearNode(els.omdbFields);

    if (!vm) {
        els.omdbPanel.classList.add('hidden');
        if (els.imdbRatingBox) els.imdbRatingBox.classList.add('hidden');
        if (els.rottenRatingBox) els.rottenRatingBox.classList.add('hidden');
        return;
    }

    const detail = vm.detail || {};
    const candidate = vm.candidate || {};
    const genres = Array.isArray(vm.genres) ? vm.genres : [];
    const cast = Array.isArray(detail.cast) ? detail.cast : [];
    const directors = Array.isArray(detail.director) ? detail.director : [];
    const writers = Array.isArray(detail.writer) ? detail.writer : [];
    const omdb = vm.omdbProfile && typeof vm.omdbProfile === 'object' ? vm.omdbProfile : null;
    const omdbGenres = Array.isArray(omdb?.genres) ? omdb.genres : [];

    appendInfoCards(els.omdbFields, [
        createInfoCard('Title', vm.title || candidate.title),
        createInfoCard('Original', detail.originalTitle || candidate.originalTitle),
        createInfoCard('Type', detail.mediaType === 'movie' ? 'FILM' : detail.mediaType === 'tv' ? 'SERIES' : formatValue(detail.mediaType || candidate.type)),
        createInfoCard('Year', detail.year || candidate.year),
        createInfoCard('TMDB ID', detail.id ? `#${detail.id}` : candidate.id ? `#${candidate.id}` : '—'),
        createInfoCard('Runtime', detail.runtime ? `${detail.runtime} min` : '—'),
        createInfoCard('Status', detail.status || '—'),
        createInfoCard('Language', detail.originalLanguage || '—'),
        createInfoCard('Votes', formatCount(vm.votes)),
        createInfoCard('Popularity', typeof detail.popularity === 'number' ? detail.popularity.toFixed(1) : typeof candidate.popularity === 'number' ? candidate.popularity.toFixed(1) : '—')
    ]);

    appendInfoCards(els.omdbFields, [
        vm.summary ? createInfoCard('Overview', vm.summary, { wide: true }) : null,
        genres.length > 0 ? createInfoCard('Genres', genres, { wide: true }) : null,
        detail.productionCompanies && detail.productionCompanies.length > 0 ? createInfoCard('Production Companies', detail.productionCompanies, { wide: true }) : null,
        detail.productionCountries && detail.productionCountries.length > 0 ? createInfoCard('Production Countries', detail.productionCountries, { wide: true }) : null,
        cast.length > 0 ? createInfoCard('Cast', cast, { wide: true }) : null,
        directors.length > 0 ? createInfoCard('Director', directors, { wide: true }) : null,
        writers.length > 0 ? createInfoCard('Writer', writers, { wide: true }) : null,
        detail.imdbId ? createInfoCard('IMDb ID', detail.imdbId) : null,
        detail.tmdbRating ? createInfoCard('TMDB Score', `${detail.tmdbRating.toFixed(1)}/10`) : null
    ].filter(Boolean));

    appendInfoCards(els.omdbFields, omdb ? [
        omdb.imdb ? createInfoCard('IMDb Rating', `${omdb.imdb.toFixed(1)}/10`) : null,
        omdb.imdbVotes ? createInfoCard('IMDb Votes', omdb.imdbVotes) : null,
        omdb.rottenTomatoes ? createInfoCard('Rotten Tomatoes', `${omdb.rottenTomatoes}%`) : null,
        omdb.rated ? createInfoCard('Rated', omdb.rated) : null,
        omdb.released ? createInfoCard('Released', omdb.released) : null,
        omdb.runtime ? createInfoCard('OMDb Runtime', omdb.runtime) : null,
        omdbGenres.length > 0 ? createInfoCard('OMDb Genres', omdbGenres, { wide: true }) : null,
        omdb.director ? createInfoCard('OMDb Director', omdb.director) : null,
        omdb.writer ? createInfoCard('OMDb Writer', omdb.writer, { wide: true }) : null,
        omdb.actors ? createInfoCard('Actors', omdb.actors, { wide: true }) : null,
        omdb.language ? createInfoCard('Language', omdb.language) : null,
        omdb.country ? createInfoCard('Country', omdb.country) : null,
        omdb.awards ? createInfoCard('Awards', omdb.awards, { wide: true }) : null,
        omdb.boxOffice ? createInfoCard('Box Office', omdb.boxOffice) : null,
        omdb.production ? createInfoCard('Production', omdb.production, { wide: true }) : null,
        omdb.metascore ? createInfoCard('Metascore', `${omdb.metascore}/100`) : null,
        omdb.plot ? createInfoCard('Plot', omdb.plot, { wide: true }) : null
    ].filter(Boolean) : []);

    const hasProfileData = Boolean(
        vm.title || detail.originalTitle || vm.summary || genres.length > 0 || cast.length > 0 || directors.length > 0 || writers.length > 0 || detail.imdbId || detail.tmdbRating || detail.tmdbVotes || detail.popularity || omdb || omdbGenres.length > 0
    );
    els.omdbPanel.classList.toggle('hidden', !hasProfileData);

    if (els.imdbRatingBox) els.imdbRatingBox.classList.add('hidden');
    if (els.rottenRatingBox) els.rottenRatingBox.classList.add('hidden');

    renderPrimaryRating(vm.rating, 'TMDB');
    if (vm.omdbProfile && vm.omdbProfile.imdb && els.imdbRating && els.imdbRatingBox) {
        els.imdbRating.textContent = vm.omdbProfile.imdb.toFixed(1);
        els.imdbRating.className = 'text-2xl font-mono font-bold text-accent-gold';
        els.imdbRatingBox.classList.remove('hidden');
    }

    if (vm.omdbProfile && vm.omdbProfile.rottenTomatoes && els.rottenRating && els.rottenRatingBox) {
        els.rottenRating.textContent = `${vm.omdbProfile.rottenTomatoes}%`;
        els.rottenRating.className = `text-2xl font-mono font-bold ${vm.omdbProfile.rottenTomatoes >= 75 ? 'text-green-500' : vm.omdbProfile.rottenTomatoes >= 60 ? 'text-yellow-500' : 'text-accent-red'}`;
        els.rottenRatingBox.classList.remove('hidden');
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

function safeHostname(url) {
    const safeUrl = toSafeHttpUrl(url);
    if (!safeUrl) return '—';
    try {
        return new URL(safeUrl).hostname.replace(/^www\./, '');
    } catch {
        return '—';
    }
}

function toSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function renderLinkCards(container, items, { emptyLabel, itemClass, cardClass, iconClass, metaClass, metaText, titleText, sourceText, limit }) {
    if (!container) return;
    clearNode(container);

    const safeItems = Array.isArray(items)
        ? items
            .map(item => ({ ...item, url: toSafeHttpUrl(item?.url) }))
            .filter(item => item.url)
        : [];

    if (safeItems.length === 0) {
        const li = document.createElement('li');
        li.className = 'p-4 text-sm font-mono text-cinema-400';
        li.textContent = emptyLabel;
        container.appendChild(li);
        return;
    }

    const frag = document.createDocumentFragment();
    safeItems.slice(0, limit).forEach(item => {
        const li = document.createElement('li');
        li.className = itemClass;

        const a = document.createElement('a');
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = cardClass;

        const row = document.createElement('div');
        row.className = 'flex items-start justify-between gap-3';

        const content = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'text-sm font-medium text-cinema-100 leading-snug';
        title.textContent = titleText(item);

        const meta = document.createElement('div');
        meta.className = metaClass;
        meta.textContent = metaText(item);

        content.appendChild(title);
        content.appendChild(meta);

        if (sourceText) {
            const source = document.createElement('div');
            source.className = 'mt-2 text-[10px] font-mono uppercase tracking-[0.3em] text-accent-gold/80';
            source.textContent = sourceText(item);
            content.appendChild(source);
        }

        const icon = document.createElement('i');
        icon.className = iconClass;

        row.appendChild(content);
        row.appendChild(icon);
        a.appendChild(row);
        li.appendChild(a);
        frag.appendChild(li);
    });
    container.appendChild(frag);
}

function renderResourceList(resources) {
    renderLinkCards(els.resourceList, resources, {
        emptyLabel: 'No raw resources detected.',
        itemClass: 'p-3',
        cardClass: 'block rounded-2xl border border-cinema-700 bg-cinema-900/30 p-4 transition-all hover:border-cinema-500/70 hover:bg-cinema-800/50 hover:-translate-y-0.5',
        iconClass: 'fas fa-external-link-alt text-[#0099ff] mt-1 opacity-70',
        metaClass: 'mt-2 text-[10px] font-mono uppercase tracking-[0.28em] text-cinema-400',
        metaText: item => safeHostname(item.url),
        titleText: item => item.title,
        limit: 6
    });
}

function renderQuarkUrls(quarkUrls) {
    renderLinkCards(els.quarkUrlList, quarkUrls, {
        emptyLabel: 'No Quark links extracted yet.',
        itemClass: 'p-3',
        cardClass: 'block rounded-2xl border border-cinema-700 bg-cinema-900/45 p-4 transition-all hover:border-accent-red/60 hover:bg-cinema-800/60 hover:-translate-y-0.5',
        iconClass: 'fas fa-cloud text-accent-red mt-1 opacity-80',
        metaClass: 'mt-2 text-[10px] font-mono uppercase tracking-[0.28em] text-cinema-400 break-all',
        metaText: item => item.url.replace(/^https?:\/\//, ''),
        titleText: item => item.title || 'Quark link',
        sourceText: item => item.sourceTitle ? `FROM ${item.sourceTitle}` : 'FROM RESOURCE PAGE',
        limit: 50
    });
}

function renderScore(data, sourceLabel, isUpdate = false) {
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

    if (!isUpdate) {
        els.recBar.style.animation = 'none';
        els.recBar.offsetHeight;
        els.recBar.classList.add('progress-bar');
    } else {
        els.recBar.classList.remove('progress-bar');
        els.recBar.style.transition = 'width 0.5s ease-out, background-color 0.5s ease-out, box-shadow 0.5s ease-out';
    }

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

async function safeTmdbSearch(query, options = {}) {
    try {
        return await TmdbAPI.search(query, options);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn('TMDB search failed:', error);
        return null;
    }
}

function resetRatingBoxes() {
    if (els.imdbRatingBox) els.imdbRatingBox.classList.add('hidden');
    if (els.rottenRatingBox) els.rottenRatingBox.classList.add('hidden');
    if (els.doubanBackupBox) els.doubanBackupBox.classList.add('hidden');
}

function setSearching(isSearching) {
    if (!els.searchButton) return;
    els.searchButton.disabled = isSearching;
    els.searchButton.setAttribute('aria-busy', String(isSearching));
    els.searchButton.classList.toggle('opacity-60', isSearching);
    els.searchButton.classList.toggle('cursor-wait', isSearching);
}

let currentSearchId = 0;
let currentAbortController = null;

async function handleSearch() {
    const query = els.input.value.trim();
    if (!query) return;

    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    const searchOptions = { signal: currentAbortController.signal };

    const searchId = ++currentSearchId;

    els.error.classList.add('hidden');
    els.results.classList.add('hidden');
    els.loading.classList.remove('hidden');
    resetRatingBoxes();
    setSearching(true);

    els.results.querySelectorAll('.fade-up').forEach(el => {
        el.style.animation = 'none';
        el.offsetHeight;
        el.style.animation = null;
    });

    try {
        const tmdbSearch = await safeTmdbSearch(query, searchOptions);
        if (searchId !== currentSearchId) return;

        const tmdbResults = tmdbSearch && Array.isArray(tmdbSearch.results) ? tmdbSearch.results : [];

        if (tmdbResults.length === 0) {
            throw new Error(`TMDB 未找到“${query}”的结果`);
        }

        const candidate = pickBestTmdbMatch(tmdbResults, query);
        if (!candidate) throw new Error(`TMDB 未找到“${query}”的匹配结果`);

        showToast('Signal locked. Initiating deep scan...');

        const tmdbDetail = await TmdbAPI.getDetail(candidate.id, candidate.mediaType, searchOptions).catch(e => {
            if (e.name === 'AbortError') throw e;
            return null;
        });
        if (searchId !== currentSearchId) return;

        let viewModel = buildTmdbViewModel(candidate, tmdbDetail, null, null);

        setText(els.title, viewModel.title);
        setText(els.subTitle, viewModel.subtitle);
        renderGenres(viewModel.genres);
        renderSynopsis(viewModel.overviewSource, viewModel.summary);
        loadPoster(viewModel.posterUrl);
        renderTmdbFacts(viewModel);
        renderTmdbProfile(viewModel);

        renderScore({
            rating: viewModel.rating,
            votes: viewModel.votes,
            genres: viewModel.genres,
            hasWiki: false,
            summary: viewModel.summary,
            source: 'tmdb'
        }, 'TMDB');

        els.results.classList.remove('hidden');
        els.loading.classList.add('hidden');
        if (searchId === currentSearchId) setSearching(false);

        DoubanAPI.search(query, searchOptions).then(async doubanSearchResult => {
            if (searchId !== currentSearchId) return;
            const doubanCandidates = Array.isArray(doubanSearchResult) ? doubanSearchResult : [];
            const doubanMatch = pickBestDoubanMatch(doubanCandidates, query);
            if (doubanMatch && doubanMatch.id) {
                const doubanResult = await DoubanAPI.getDetail(doubanMatch.id, searchOptions).catch(e => {
                    if (e.name === 'AbortError') throw e;
                    return null;
                });
                if (searchId !== currentSearchId || !doubanResult) return;
                viewModel.doubanRating = doubanResult.rating;
                renderBackupDoubanRating(viewModel.doubanRating);
            }
        }).catch(e => { if (e.name !== 'AbortError') console.debug('Douban enrichment skipped:', e); });

        WikiAPI.getSummary(candidate.title, searchOptions).then(wikiResult => {
            if (searchId !== currentSearchId || !wikiResult) return;
            viewModel.summary = wikiResult.extract || viewModel.summary;
            viewModel.overviewSource = wikiResult.extract ? 'ZH.WIKIPEDIA' : viewModel.overviewSource;
            renderSynopsis(viewModel.overviewSource, viewModel.summary);
            
            renderScore({
                rating: viewModel.rating,
                votes: viewModel.votes,
                genres: viewModel.genres,
                hasWiki: Boolean(wikiResult && wikiResult.extract),
                summary: viewModel.summary,
                source: 'tmdb'
            }, 'TMDB', true);
        }).catch(e => { if (e.name !== 'AbortError') console.debug('Wiki enrichment skipped:', e); });

        ResourceAPI.search(candidate.title, searchOptions).then(resourceResult => {
            if (searchId !== currentSearchId || !resourceResult) return;
            renderResourceList(Array.isArray(resourceResult.resources) ? resourceResult.resources : []);
            renderQuarkUrls(Array.isArray(resourceResult.quarkUrls) ? resourceResult.quarkUrls : []);
        }).catch(e => { if (e.name !== 'AbortError') console.debug('Resource enrichment skipped:', e); });

        PosterAPI.getPoster(candidate.title, candidate.year, searchOptions).then(posterResult => {
            if (searchId !== currentSearchId || !posterResult) return;
            viewModel.omdbProfile = posterResult.omdb ? (typeof posterResult.omdb === 'object' ? posterResult.omdb : posterResult) : viewModel.omdbProfile;
            viewModel.posterUrl = posterResult.poster || viewModel.posterUrl;
            loadPoster(viewModel.posterUrl);
            renderTmdbProfile(viewModel);
        }).catch(e => { if (e.name !== 'AbortError') console.debug('Poster enrichment skipped:', e); });

    } catch (err) {
        if (err.name === 'AbortError') return;
        if (searchId !== currentSearchId) return;
        if (err && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
            els.errorMsg.textContent = 'Unable to connect to Cloudflare Worker. Make sure the API_BASE is correctly configured and the Worker is deployed.';
        } else {
            els.errorMsg.textContent = err && err.message ? err.message : 'Unknown error';
        }
        els.error.classList.remove('hidden');
        els.loading.classList.add('hidden');
        setSearching(false);
    } finally {
        if (searchId === currentSearchId) setSearching(false);
    }
}

if (els.searchForm) {
    els.searchForm.addEventListener('submit', e => {
        e.preventDefault();
        els.input.blur();
        handleSearch();
    });
}
