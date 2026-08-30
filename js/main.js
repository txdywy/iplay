import { TmdbAPI, DoubanAPI, WikiAPI, ResourceAPI, PosterAPI, OmdbAPI } from './api.js';
import { calculateRecommendationScore, getRecommendationLabel } from './scorer.js';
import { copyQuarkShare, formatQuarkCopyText } from './quark.js';
import { formatRating, toFiniteNumber } from './format.js';
import {
    findBestMatch,
    pickBestTmdbMatch,
    rankTmdbCandidates,
    shouldConfirmTmdbCandidate
} from './match.js';
import { formatSeasonEpisodeCounts, formatSeasonTotals } from './seasons.js';

const els = {
    input: document.getElementById('searchInput'),
    searchForm: document.getElementById('searchForm'),
    searchButton: document.getElementById('searchButton'),
    loading: document.getElementById('loadingState'),
    error: document.getElementById('errorState'),
    errorMsg: document.getElementById('errorMsg'),
    errorHint: document.getElementById('errorHint'),
    retrySearchButton: document.getElementById('retrySearchButton'),
    candidatePicker: document.getElementById('candidatePicker'),
    candidatePickerTitle: document.getElementById('candidatePickerTitle'),
    candidatePickerQuery: document.getElementById('candidatePickerQuery'),
    candidateList: document.getElementById('candidateList'),
    results: document.getElementById('resultsArea'),
    searchStatus: document.getElementById('searchStatus'),
    dataNotice: document.getElementById('dataNotice'),
    wikiStatus: document.getElementById('wikiStatus'),
    omdbStatus: document.getElementById('omdbStatus'),
    resourceSection: document.getElementById('resourcesSection'),
    resourceNotice: document.getElementById('resourcesNotice'),

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
    tmdbProfileLabel: document.getElementById('tmdbProfileLabel'),
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
    resourceStatus: document.getElementById('resourcesStatus'),
    resourceList: document.getElementById('resourceList'),
    wpzysResourceList: document.getElementById('wpzysResourceList'),
    quarkUrlList: document.getElementById('quarkUrlList'),
    toast: document.getElementById('toast')
};

let toastTimer = null;
function showToast(msg) {
    if (!els.toast) return;
    clearTimeout(toastTimer);
    els.toast.textContent = msg;
    els.toast.style.transform = 'translateY(0)';
    els.toast.style.opacity = '1';
    toastTimer = setTimeout(() => {
        els.toast.style.transform = 'translateY(20px)';
        els.toast.style.opacity = '0';
    }, 3000);
}

function setSearchStatus(message) {
    setText(els.searchStatus, message);
}

function hideDataNotice() {
    if (!els.dataNotice) return;
    clearNode(els.dataNotice);
    els.dataNotice.classList.add('hidden');
}

function showDataNotice({ title, detail, actionLabel = '', onAction = null, tone = 'warning' }) {
    if (!els.dataNotice) return;
    clearNode(els.dataNotice);
    els.dataNotice.className = `rounded-2xl border p-4 text-sm ${tone === 'error' ? 'border-accent-red/40 bg-accent-red/10' : 'border-accent-gold/40 bg-accent-gold/10'}`;
    els.dataNotice.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    els.dataNotice.setAttribute('aria-live', 'polite');

    const row = document.createElement('div');
    row.className = 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between';

    const copy = document.createElement('div');
    copy.className = 'min-w-0';
    const heading = document.createElement('p');
    heading.className = `font-mono text-xs uppercase tracking-[0.2em] ${tone === 'error' ? 'text-accent-red' : 'text-accent-gold'}`;
    heading.textContent = title;
    const description = document.createElement('p');
    description.className = 'mt-1 text-cinema-100/80';
    description.textContent = detail;
    copy.appendChild(heading);
    copy.appendChild(description);
    row.appendChild(copy);

    if (actionLabel && typeof onAction === 'function') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'shrink-0 min-h-11 rounded-full border border-cinema-400/60 px-4 py-2 font-mono text-xs text-cinema-100 transition-colors hover:border-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-60';
        button.textContent = actionLabel;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await onAction();
            } catch (error) {
                if (error?.name !== 'AbortError') showToast('操作失败，请稍后重试');
            } finally {
                button.disabled = false;
            }
        });
        row.appendChild(button);
    }

    els.dataNotice.appendChild(row);
    els.dataNotice.classList.remove('hidden');
}

function hideCandidatePicker() {
    if (!els.candidatePicker) return;
    clearNode(els.candidateList);
    els.candidatePicker.classList.add('hidden');
}

function candidateTypeLabel(candidate) {
    if (candidate?.mediaType === 'tv' || candidate?.type === 'tv') return '剧集';
    if (candidate?.mediaType === 'movie' || candidate?.type === 'movie') return '电影';
    return '影视';
}

function candidateMatchLabel(candidate) {
    const confidence = String(candidate?.matchConfidence || '').toLowerCase();
    if (confidence === 'high') return '高匹配';
    if (confidence === 'medium') return '需确认';
    if (confidence === 'low') return '低匹配';
    return '候选结果';
}

function renderCandidatePicker(candidates, query, onSelect) {
    if (!els.candidatePicker || !els.candidateList) return;
    clearNode(els.candidateList);
    setText(els.candidatePickerQuery, `“${query}”`);

    const ranked = rankTmdbCandidates(candidates).filter(candidate => candidate?.id).slice(0, 6);
    setText(els.candidatePickerTitle, ranked.length > 1 ? '搜索到多个可能的影视条目' : '请确认这个影视条目');
    const fragment = document.createDocumentFragment();
    ranked.forEach(candidate => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'group rounded-2xl border border-cinema-700 bg-cinema-900/60 p-4 text-left transition-[transform,background-color,border-color] hover:-translate-y-0.5 hover:border-accent-red/70 hover:bg-cinema-800/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red';

        const title = document.createElement('span');
        title.className = 'block text-base font-bold leading-snug text-cinema-100 group-hover:text-white';
        title.textContent = candidate.title || candidate.originalTitle || '未命名条目';

        const originalTitle = candidate.originalTitle && candidate.originalTitle !== candidate.title
            ? document.createElement('span')
            : null;
        if (originalTitle) {
            originalTitle.className = 'mt-1 block truncate text-xs text-cinema-400';
            originalTitle.textContent = candidate.originalTitle;
        }

        const meta = document.createElement('span');
        meta.className = 'mt-3 block text-xs font-mono uppercase tracking-[0.18em] text-cinema-400';
        meta.textContent = [candidate.year || '年份未知', candidateTypeLabel(candidate), candidateMatchLabel(candidate)].join(' · ');

        const score = Number(candidate.matchScore);
        const scoreText = Number.isFinite(score) ? `匹配度 ${Math.round(score * 100)}%` : 'TMDB 候选';
        const scoreNode = document.createElement('span');
        scoreNode.className = 'mt-2 block text-xs font-mono text-accent-gold';
        scoreNode.textContent = scoreText;

        button.appendChild(title);
        if (originalTitle) button.appendChild(originalTitle);
        button.appendChild(meta);
        button.appendChild(scoreNode);
        button.addEventListener('click', () => onSelect(candidate));
        fragment.appendChild(button);
    });

    els.candidateList.appendChild(fragment);
    els.candidatePicker.classList.toggle('hidden', ranked.length === 0);
}

function matchesMedia(query) {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

function scrollToVisible(element) {
    if (!element || !matchesMedia('(max-width: 767px)')) return;
    requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        if (rect.top < 0 || rect.top > window.innerHeight * 0.85) {
            element.scrollIntoView({
                behavior: matchesMedia('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth',
                block: 'start'
            });
        }
    });
}

function pickBestDoubanMatch(results, query) {
    return findBestMatch(results, query, item => item.title);
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ICON_PATHS = Object.freeze({
    cloud: 'M7 18a4 4 0 1 1 .6-7.95A5.5 5.5 0 0 1 18 12.5h.5a3.5 3.5 0 1 1 0 7H7Z',
    comments: 'M5 5h14v10H9l-4 3v-3H5V5Z',
    external: 'M14 4h6v6m0-6-8 8M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4',
    link: 'M10 13a5 5 0 0 0 7.07 0l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15m3.15 5.93a5 5 0 0 0-7.07 0l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15',
    minus: 'M5 12h14',
    plus: 'M12 5v14M5 12h14'
});
const RESOURCE_OBSERVER_ROOT_MARGIN = '320px 0px';
const RESOURCE_IDLE_TIMEOUT_MS = 1400;
const RESOURCE_TIMER_FALLBACK_MS = 1200;
const POSTER_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='600' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%23141417'/%3E%3Ctext x='50%25' y='50%25' fill='%23333333' font-family='monospace' font-size='28' text-anchor='middle' dominant-baseline='middle'%3ENO POSTER%3C/text%3E%3C/svg%3E";

let posterLoadToken = 0;
let activePosterContext = null;

function createIcon(name, className = '') {
    const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.8');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    if (className) icon.setAttribute('class', className);

    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.link);
    icon.appendChild(path);
    return icon;
}

function getTmdbPosterSourceSet(posterUrl) {
    if (typeof posterUrl !== 'string') return '';
    const match = posterUrl.match(/^(https:\/\/image\.tmdb\.org\/t\/p\/)w500(\/[^?]+)(?:\?.*)?$/);
    if (!match) return '';
    return `${match[1]}w300${match[2]} 300w, ${posterUrl} 500w`;
}

function pickPosterFallback(posterResult, failedSource) {
    const candidates = [
        posterResult?.omdb?.poster,
        posterResult?.poster
    ];
    return candidates
        .map(value => toSafeHttpUrl(value))
        .find(value => value && value !== failedSource) || null;
}

function handlePosterLoadError() {
    if (!els.cover) return;
    const failedSource = els.cover.getAttribute('src');
    const token = Number(els.cover.dataset.posterToken);
    const context = activePosterContext;

    els.cover.setAttribute('aria-busy', 'false');
    if (failedSource === POSTER_PLACEHOLDER) return;
    if (!context || context.token !== token || context.source !== failedSource) return;

    if (context.fallbackAttempted || !context.searchOptions || !context.viewModel) {
        loadPoster(null, context.title, { ...context, fallbackAttempted: true });
        return;
    }

    context.fallbackAttempted = true;
    setEnrichmentStatus(els.omdbStatus, '海报加载失败，正在查找备用海报…', true);
    const { viewModel, searchId, loadId, searchOptions } = context;

    void PosterAPI.getPoster(context.enrichmentQuery || context.title, context.year, searchOptions, { refresh: true })
        .then(posterResult => {
            if (!isActiveSearch(searchId, loadId) || posterLoadToken !== token) return;
            const fallbackPoster = pickPosterFallback(posterResult, failedSource);
            if (fallbackPoster) {
                viewModel.posterUrl = fallbackPoster;
                loadPoster(fallbackPoster, viewModel.title, { ...context, fallbackAttempted: true });
                renderTmdbProfile(viewModel);
                setEnrichmentStatus(els.omdbStatus, posterResult?.omdb ? '已补充 OMDb 数据并更换海报' : '已找到备用海报');
                return;
            }

            loadPoster(null, viewModel.title, { ...context, fallbackAttempted: true });
            setEnrichmentStatus(els.omdbStatus, viewModel.omdbProfile ? '已补充 OMDb 数据，暂无可用海报' : '暂无可用海报');
        })
        .catch(error => {
            if (error?.name === 'AbortError') return;
            if (!isActiveSearch(searchId, loadId) || posterLoadToken !== token) return;
            loadPoster(null, viewModel.title, { ...context, fallbackAttempted: true });
            setEnrichmentStatus(els.omdbStatus, '备用海报暂时不可用');
            console.debug('Broken poster fallback skipped:', error);
        });
}

if (els.cover) {
    els.cover.addEventListener('error', handlePosterLoadError);
    els.cover.addEventListener('load', () => els.cover.setAttribute('aria-busy', 'false'));
}

function loadPoster(posterUrl, title = '', context = {}) {
    if (!els.cover) return;
    const nextSource = posterUrl || POSTER_PLACEHOLDER;
    const previous = activePosterContext;
    const loadKey = context.loadKey || '';
    const fallbackAttempted = context.fallbackAttempted ?? (
        previous?.loadKey === loadKey && previous.source === nextSource
            ? previous.fallbackAttempted
            : false
    );
    const token = ++posterLoadToken;
    activePosterContext = {
        ...context,
        title,
        source: nextSource,
        posterUrl: posterUrl || null,
        fallbackAttempted,
        token
    };

    els.cover.dataset.posterToken = String(token);
    els.cover.alt = title ? `${title} 海报` : '影视海报';
    els.cover.setAttribute('srcset', getTmdbPosterSourceSet(posterUrl));
    els.cover.setAttribute('sizes', posterUrl ? '(min-width: 1024px) 300px, min(100vw - 3rem, 260px)' : '');
    els.cover.setAttribute('aria-busy', String(Boolean(posterUrl)));
    if (els.cover.getAttribute('src') === nextSource) return;
    els.cover.setAttribute('src', nextSource);
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
    const text = formatRating(value);
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
    const numericValue = toFiniteNumber(value);
    if (numericValue !== null && numericValue > 0) {
        els.doubanBackupRating.textContent = formatRating(numericValue);
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
    const numericValue = toFiniteNumber(value);
    if (numericValue === null || numericValue <= 0) return '—';
    return new Intl.NumberFormat('en-US').format(numericValue);
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
        subtitle: `${source.year || candidate?.year || '????'} // ${(source.mediaType || source.type) === 'movie' ? 'FILM' : (source.mediaType || source.type) === 'tv' ? 'SERIES' : 'TMDB'} // TMDB:${source.id || candidate?.id || '—'}`,
        summary: source.summary || (wikiResult && wikiResult.extract) || candidate?.summary || '',
        genres: Array.isArray(source.genres) && source.genres.length > 0 ? source.genres : [],
        rating: source.tmdbRating ?? candidate?.tmdbRating ?? 0,
        votes: source.tmdbVotes ?? candidate?.tmdbVotes ?? candidate?.votes ?? 0,
        posterUrl: source.poster || candidate?.poster || (posterResult && !posterResult.tmdb ? posterResult.poster : null),
        omdbProfile,
        overviewSource: wikiResult && wikiResult.extract ? 'ZH.WIKIPEDIA' : source.summary ? 'TMDB' : 'NO DATA'
    };
}

function createInfoCard(label, value, { wide = false, muted = false } = {}) {
    const card = document.createElement('div');
    card.className = `${wide ? 'md:col-span-2' : ''} rounded-2xl border border-cinema-700 bg-cinema-900/35 p-3 md:p-4`;

    const meta = document.createElement('div');
    meta.className = 'text-xs uppercase tracking-[0.35em] text-cinema-400';
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
    const seasonTotals = mediaType === 'tv' ? formatSeasonTotals(detail.totalSeasons, detail.totalEpisodes) : '';
    const seasonEpisodes = mediaType === 'tv' ? formatSeasonEpisodeCounts(detail.seasons) : '';

    setText(els.tmdbProfileLabel, mediaType === 'movie' ? 'Movie profile' : mediaType === 'tv' ? 'Series profile' : 'Media profile');

    appendInfoCards(els.tmdbFacts, [
        createInfoCard('Title', viewModel?.title || candidate.title),
        createInfoCard('Original', detail.originalTitle || candidate.originalTitle),
        createInfoCard('Type', mediaType === 'movie' ? 'FILM' : mediaType === 'tv' ? 'SERIES' : mediaType),
        createInfoCard('Year', detail.year || candidate.year),
        createInfoCard('TMDB ID', detail.id ? `#${detail.id}` : candidate.id ? `#${candidate.id}` : '—'),
        createInfoCard('IMDb ID', detail.imdbId || candidate.imdbId || '—'),
        createInfoCard('Votes', formatCount(detail.tmdbVotes || candidate.tmdbVotes || candidate.votes || 0)),
        createInfoCard('Popularity', typeof detail.popularity === 'number' ? detail.popularity.toFixed(1) : typeof candidate.popularity === 'number' ? candidate.popularity.toFixed(1) : '—'),
        seasonTotals ? createInfoCard('Seasons / Episodes', seasonTotals) : null,
        seasonEpisodes ? createInfoCard('Episodes / Season', seasonEpisodes, { wide: true }) : null
    ].filter(Boolean));

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
    const genres = Array.isArray(vm.genres) ? vm.genres : [];
    const cast = Array.isArray(detail.cast) ? detail.cast : [];
    const directors = Array.isArray(detail.director) ? detail.director : [];
    const writers = Array.isArray(detail.writer) ? detail.writer : [];
    const omdb = vm.omdbProfile && typeof vm.omdbProfile === 'object' ? vm.omdbProfile : null;
    const omdbGenres = Array.isArray(omdb?.genres) ? omdb.genres : [];
    const tmdbRating = toFiniteNumber(detail.tmdbRating);
    const omdbRating = toFiniteNumber(omdb?.imdb);
    const rottenTomatoes = toFiniteNumber(omdb?.rottenTomatoes);
    const seasonTotals = detail.mediaType === 'tv' ? formatSeasonTotals(detail.totalSeasons, detail.totalEpisodes) : '';
    const seasonEpisodes = detail.mediaType === 'tv' ? formatSeasonEpisodeCounts(detail.seasons) : '';

    appendInfoCards(els.omdbFields, [
        createInfoCard('Runtime', detail.runtime ? `${detail.runtime} min` : '—'),
        seasonTotals ? createInfoCard('Seasons / Episodes', seasonTotals) : null,
        createInfoCard('Status', detail.status || '—'),
        createInfoCard('Language', detail.originalLanguage || '—'),
        detail.imdbId ? createInfoCard('IMDb ID', detail.imdbId) : null,
        tmdbRating !== null && tmdbRating > 0 ? createInfoCard('TMDB Score', `${formatRating(tmdbRating)}/10`) : null
    ].filter(Boolean));

    appendInfoCards(els.omdbFields, [
        genres.length > 0 ? createInfoCard('Genres', genres, { wide: true }) : null,
        detail.productionCompanies && detail.productionCompanies.length > 0 ? createInfoCard('Production Companies', detail.productionCompanies, { wide: true }) : null,
        detail.productionCountries && detail.productionCountries.length > 0 ? createInfoCard('Production Countries', detail.productionCountries, { wide: true }) : null,
        cast.length > 0 ? createInfoCard('Cast', cast, { wide: true }) : null,
        directors.length > 0 ? createInfoCard('Director', directors, { wide: true }) : null,
        writers.length > 0 ? createInfoCard('Writer', writers, { wide: true }) : null,
        seasonEpisodes ? createInfoCard('Episodes / Season', seasonEpisodes, { wide: true }) : null,
    ].filter(Boolean));

    appendInfoCards(els.omdbFields, omdb ? [
        omdbRating !== null && omdbRating > 0 ? createInfoCard('IMDb Rating', `${formatRating(omdbRating)}/10`) : null,
        omdb.imdbVotes ? createInfoCard('IMDb Votes', omdb.imdbVotes) : null,
        rottenTomatoes !== null && rottenTomatoes >= 0 ? createInfoCard('Rotten Tomatoes', `${rottenTomatoes}%`) : null,
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
    if (omdbRating !== null && omdbRating > 0 && els.imdbRating && els.imdbRatingBox) {
        els.imdbRating.textContent = formatRating(omdbRating);
        els.imdbRating.className = 'text-2xl font-mono font-bold text-accent-gold';
        els.imdbRatingBox.classList.remove('hidden');
    }

    if (rottenTomatoes !== null && rottenTomatoes >= 0 && els.rottenRating && els.rottenRatingBox) {
        els.rottenRating.textContent = `${rottenTomatoes}%`;
        els.rottenRating.className = `text-2xl font-mono font-bold ${rottenTomatoes >= 75 ? 'text-green-500' : rottenTomatoes >= 60 ? 'text-yellow-500' : 'text-accent-red'}`;
        els.rottenRatingBox.classList.remove('hidden');
    }
}

function renderSynopsis(sourceLabel, text) {
    if (!els.wikiSummary) return;
    els.wikiSummary.setAttribute('aria-busy', 'false');
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

function setEnrichmentStatus(element, message, isPending = false) {
    if (!element) return;
    element.textContent = message;
    element.setAttribute('aria-busy', String(isPending));
    element.classList.toggle('animate-pulse', isPending);
}

function setResourceStatus(message, isPending = false) {
    setEnrichmentStatus(els.resourceStatus, message, isPending);
}

function hideResourceNotice() {
    if (!els.resourceNotice) return;
    clearNode(els.resourceNotice);
    els.resourceNotice.classList.add('hidden');
}

function renderResourceNotice(resourceResult, onRetry) {
    if (!els.resourceNotice) return;
    clearNode(els.resourceNotice);

    const meta = resourceResult?.resourceMeta || {};
    const providers = meta.providers || {};
    const failedProviders = Object.entries(providers)
        .filter(([, status]) => status === 'failed')
        .map(([provider]) => provider === 'by669' ? '资源页' : provider === 'wpzys' ? 'WPZYS' : provider);
    const failedPages = Number(meta.failedPages) || 0;
    const detail = failedProviders.length > 0
        ? `${failedProviders.join('、')}暂时没有响应，已保留其他可用结果。`
        : failedPages > 0
            ? `有 ${failedPages} 个资源页面暂时无法打开，已保留其他可用结果。`
            : '部分资源尚未完成提取，已保留当前可用结果。';

    const row = document.createElement('div');
    row.className = 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between';

    const copy = document.createElement('div');
    copy.className = 'min-w-0';
    const heading = document.createElement('p');
    heading.className = 'font-mono text-xs uppercase tracking-[0.2em] text-accent-gold';
    heading.textContent = '资源扫描部分完成';
    const description = document.createElement('p');
    description.className = 'mt-1 text-sm text-cinema-100/80';
    description.textContent = detail;
    copy.appendChild(heading);
    copy.appendChild(description);
    row.appendChild(copy);

    if (typeof onRetry === 'function') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'min-h-11 shrink-0 rounded-full border border-accent-gold/60 px-4 py-2 font-mono text-xs text-cinema-100 transition-colors hover:border-accent-gold hover:bg-accent-gold/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-60';
        button.textContent = '重试补全资源';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await onRetry();
            } catch (error) {
                if (error?.name !== 'AbortError') showToast('资源重试失败，请稍后再试');
            } finally {
                button.disabled = false;
            }
        });
        row.appendChild(button);
    }

    els.resourceNotice.appendChild(row);
    els.resourceNotice.classList.remove('hidden');
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

function renderLinkCards(container, items, {
    emptyLabel, itemClass, cardClass, iconName, iconClass, metaClass, metaText, titleText,
    detailText, sourceText, actionLabel, onAction, limit, initialLimit = 6
}) {
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

    const maxItems = Number.isFinite(Number(limit)) ? Math.min(Number(limit), safeItems.length) : safeItems.length;
    const firstPageSize = Math.min(Math.max(Number(initialLimit) || 1, 1), maxItems);

    const renderVisibleItems = (visibleLimit, restoreControlFocus = false) => {
        clearNode(container);
        const frag = document.createDocumentFragment();
        safeItems.slice(0, visibleLimit).forEach(item => {
            const li = document.createElement('li');
            li.className = itemClass;

            const resolvedActionLabel = typeof actionLabel === 'function' ? actionLabel(item) : actionLabel;
            const hasAction = Boolean(resolvedActionLabel && typeof onAction === 'function');
            const card = document.createElement(hasAction ? 'div' : 'a');
            card.className = `${cardClass} ${hasAction ? '' : 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red'}`;

            const link = hasAction ? document.createElement('a') : card;
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            if (hasAction) link.className = 'block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red';

            const row = document.createElement('div');
            row.className = 'flex items-start justify-between gap-3';

            const content = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'text-sm font-medium leading-snug text-cinema-100';
            title.textContent = titleText(item);

            const meta = document.createElement('div');
            meta.className = metaClass;
            meta.textContent = metaText(item);

            content.appendChild(title);
            content.appendChild(meta);

            const detail = detailText ? detailText(item) : '';
            if (detail) {
                const detailNode = document.createElement('div');
                detailNode.className = 'mt-2 text-xs font-mono font-semibold tracking-wider text-accent-gold';
                detailNode.textContent = detail;
                content.appendChild(detailNode);
            }

            if (sourceText) {
                const source = document.createElement('div');
                source.className = 'mt-2 text-xs font-mono uppercase tracking-[0.3em] text-accent-gold/80';
                source.textContent = sourceText(item);
                content.appendChild(source);
            }

            const icon = createIcon(iconName, iconClass);

            row.appendChild(content);
            row.appendChild(icon);
            link.appendChild(row);

            if (hasAction) {
                card.appendChild(link);

                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'mt-3 min-h-11 w-full rounded-xl border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-xs font-mono tracking-wider text-cinema-100 transition-colors hover:border-accent-red/70 hover:bg-accent-red/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-70';
                button.textContent = resolvedActionLabel;
                button.setAttribute('aria-live', 'polite');
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        await onAction(item);
                        button.textContent = '已复制';
                        showToast('提取码已复制');
                        setTimeout(() => { button.textContent = resolvedActionLabel; }, 1600);
                    } catch {
                        showToast('复制失败，请手动复制密码');
                    } finally {
                        button.disabled = false;
                    }
                });
                card.appendChild(button);
            }

            li.appendChild(card);
            frag.appendChild(li);
        });

        if (visibleLimit < maxItems) {
            const li = document.createElement('li');
            li.className = 'p-3';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'min-h-11 w-full rounded-xl border border-cinema-700 px-3 py-3 text-xs font-mono tracking-wider text-cinema-400 transition-colors hover:border-cinema-400 hover:text-cinema-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red';
            button.textContent = `显示更多（剩余 ${maxItems - visibleLimit} 条）`;
            button.addEventListener('click', () => renderVisibleItems(maxItems, true));
            li.appendChild(button);
            frag.appendChild(li);
        } else if (visibleLimit > firstPageSize) {
            const li = document.createElement('li');
            li.className = 'p-3';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'min-h-11 w-full rounded-xl border border-cinema-700 px-3 py-3 text-xs font-mono tracking-wider text-cinema-400 transition-colors hover:border-cinema-400 hover:text-cinema-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red';
            button.textContent = '收起列表';
            button.addEventListener('click', () => renderVisibleItems(firstPageSize, true));
            li.appendChild(button);
            frag.appendChild(li);
        }

        container.appendChild(frag);
        if (restoreControlFocus) {
            requestAnimationFrame(() => {
                const controls = container.querySelectorAll('button');
                controls[controls.length - 1]?.focus({ preventScroll: true });
            });
        }
    };

    renderVisibleItems(firstPageSize);
}

function renderResourceStatus(container, { title, detail, iconName, iconClass, progressClass, isLoading = true, actionLabel = '', onAction = null }) {
    if (!container) return;
    clearNode(container);

    const li = document.createElement('li');
    li.className = 'p-3';

    const panel = document.createElement('div');
    panel.className = 'rounded-2xl border border-cinema-700 bg-cinema-900/45 p-4';
    panel.setAttribute('aria-live', 'polite');
    panel.setAttribute('aria-busy', String(isLoading));

    const row = document.createElement('div');
    row.className = 'flex items-start gap-3';

    const icon = createIcon(iconName, `h-5 w-5 shrink-0 ${iconClass} mt-1 opacity-80`);

    const content = document.createElement('div');
    content.className = 'min-w-0 flex-1';

    const heading = document.createElement('div');
    heading.className = 'text-sm font-medium text-cinema-100 leading-snug';
    heading.textContent = title;

    const copy = document.createElement('div');
    copy.className = 'mt-2 text-xs font-mono uppercase tracking-[0.28em] text-cinema-400 leading-relaxed';
    copy.textContent = detail;

    content.appendChild(heading);
    content.appendChild(copy);
    row.appendChild(icon);
    row.appendChild(content);
    panel.appendChild(row);

    if (isLoading) {
        const progress = document.createElement('div');
        progress.className = `resource-progress-track ${progressClass} mt-4`;
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-label', title);
        panel.appendChild(progress);
    }

    if (!isLoading && actionLabel && typeof onAction === 'function') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mt-4 min-h-11 rounded-full border border-cinema-400/60 px-4 py-2 text-xs font-mono text-cinema-100 transition-colors hover:border-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-60';
        button.textContent = actionLabel;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await onAction();
            } finally {
                button.disabled = false;
            }
        });
        panel.appendChild(button);
    }

    li.appendChild(panel);
    container.appendChild(li);
}

function renderResourceLoadingStates(title) {
    hideResourceNotice();
    setResourceStatus('正在扫描资源…', true);
    renderResourceStatus(els.quarkUrlList, {
        title: '正在提取夸克直链',
        detail: `正在扫描“${title}”的资源页面`,
        iconName: 'cloud',
        iconClass: 'text-accent-red',
        progressClass: 'resource-progress-red'
    });
    renderResourceStatus(els.resourceList, {
        title: '正在收集资源页面',
        detail: '正在检查资源索引和论坛帖子',
        iconName: 'link',
        iconClass: 'text-[#0099ff]',
        progressClass: 'resource-progress-blue'
    });
    renderResourceStatus(els.wpzysResourceList, {
        title: '正在搜索 WPZYS 论坛',
        detail: '正在筛选包含夸克资源的匹配帖子',
        iconName: 'comments',
        iconClass: 'text-accent-gold',
        progressClass: 'resource-progress-gold'
    });
}

function renderResourceDeferredStates(title, onStart) {
    hideResourceNotice();
    setResourceStatus('资源扫描待启动，资源区接近视口或点击按钮后开始');
    renderResourceStatus(els.quarkUrlList, {
        title: '资源扫描待启动',
        detail: `滚动到这里或点击按钮，开始扫描“${title}”`,
        iconName: 'cloud',
        iconClass: 'text-accent-red',
        progressClass: 'resource-progress-red',
        isLoading: false,
        actionLabel: '开始扫描资源',
        onAction: onStart
    });
    renderResourceStatus(els.resourceList, {
        title: '资源页面待加载',
        detail: '资源扫描会在影视详情先显示后开始',
        iconName: 'link',
        iconClass: 'text-[#0099ff]',
        progressClass: 'resource-progress-blue',
        isLoading: false,
        actionLabel: '开始扫描资源',
        onAction: onStart
    });
    renderResourceStatus(els.wpzysResourceList, {
        title: '论坛结果待加载',
        detail: '需要时再扫描论坛，减少首屏等待和无效请求',
        iconName: 'comments',
        iconClass: 'text-accent-gold',
        progressClass: 'resource-progress-gold',
        isLoading: false,
        actionLabel: '开始扫描资源',
        onAction: onStart
    });
}

function renderResourceErrorStates(onRetry) {
    hideResourceNotice();
    setResourceStatus('资源扫描失败，可重试');
    renderResourceStatus(els.quarkUrlList, {
        title: '夸克直链暂时不可用',
        detail: '资源扫描没有完成，其他影视信息仍可正常使用',
        iconName: 'cloud',
        iconClass: 'text-accent-red',
        progressClass: 'resource-progress-red',
        isLoading: false,
        actionLabel: '重试资源扫描',
        onAction: onRetry
    });
    renderResourceStatus(els.resourceList, {
        title: '资源来源暂时没有响应',
        detail: '上方影视详情仍可使用，你可以重新扫描资源',
        iconName: 'link',
        iconClass: 'text-[#0099ff]',
        progressClass: 'resource-progress-blue',
        isLoading: false,
        actionLabel: '重试资源扫描',
        onAction: onRetry
    });
    renderResourceStatus(els.wpzysResourceList, {
        title: 'WPZYS 扫描已暂停',
        detail: '论坛结果可能暂时不可用，你可以稍后重试',
        iconName: 'comments',
        iconClass: 'text-accent-gold',
        progressClass: 'resource-progress-gold',
        isLoading: false,
        actionLabel: '重试资源扫描',
        onAction: onRetry
    });
}

function renderResourceList(resources) {
    renderLinkCards(els.resourceList, resources, {
        emptyLabel: '暂未发现资源页面',
        itemClass: 'p-3',
        cardClass: 'block rounded-2xl border border-cinema-700 bg-cinema-900/30 p-4 transition-[transform,background-color,border-color] hover:border-cinema-400/70 hover:bg-cinema-800/50 hover:-translate-y-0.5',
        iconName: 'external',
        iconClass: 'h-5 w-5 shrink-0 text-[#0099ff] mt-1 opacity-70',
        metaClass: 'mt-2 text-xs font-mono uppercase tracking-[0.28em] text-cinema-400',
        metaText: item => safeHostname(item.url),
        titleText: item => item.title,
        limit: 12,
        initialLimit: 6
    });
}

function renderWpzysResourceList(resources) {
    renderLinkCards(els.wpzysResourceList, resources, {
        emptyLabel: '暂未匹配到 WPZYS 夸克资源',
        itemClass: 'p-3',
        cardClass: 'block rounded-2xl border border-cinema-700 bg-cinema-900/35 p-4 transition-[transform,background-color,border-color] hover:border-accent-gold/60 hover:bg-cinema-800/50 hover:-translate-y-0.5',
        iconName: 'comments',
        iconClass: 'h-5 w-5 shrink-0 text-accent-gold mt-1 opacity-80',
        metaClass: 'mt-2 text-xs font-mono uppercase tracking-[0.28em] text-cinema-400',
        metaText: item => safeHostname(item.url),
        titleText: item => item.title,
        limit: 12,
        initialLimit: 6
    });
}

function renderQuarkUrls(quarkUrls) {
    renderLinkCards(els.quarkUrlList, quarkUrls, {
        emptyLabel: '暂未提取到夸克链接',
        itemClass: 'p-3',
        cardClass: 'block rounded-2xl border border-cinema-700 bg-cinema-900/45 p-4 transition-[transform,background-color,border-color] hover:border-accent-red/60 hover:bg-cinema-800/60 hover:-translate-y-0.5',
        iconName: 'cloud',
        iconClass: 'h-5 w-5 shrink-0 text-accent-red mt-1 opacity-80',
        metaClass: 'mt-2 text-xs font-mono uppercase tracking-[0.28em] text-cinema-400 break-all',
        metaText: item => item.url.replace(/^https?:\/\//, ''),
        titleText: item => item.title || 'Quark link',
        detailText: item => formatQuarkCopyText(item) ? `提取码：${formatQuarkCopyText(item)}` : '',
        sourceText: item => item.sourceTitle ? `FROM ${item.sourceTitle}` : 'FROM RESOURCE PAGE',
        actionLabel: item => formatQuarkCopyText(item) ? '复制密码' : '',
        onAction: item => copyQuarkShare(item, text => globalThis.navigator.clipboard.writeText(text)),
        limit: 50,
        initialLimit: 6
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

    if (els.recBar) {
        els.recBar.style.width = `${scoreData.score}%`;

        const barColor = scoreData.score >= 85 ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.5)]'
            : scoreData.score >= 70 ? 'bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]'
            : scoreData.score >= 50 ? 'bg-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.5)]'
            : 'bg-accent-red shadow-[0_0_15px_rgba(229,9,20,0.5)]';

        if (!isUpdate) {
            els.recBar.className = `h-full progress-bar ${barColor}`;
            els.recBar.style.animation = 'none';
            requestAnimationFrame(() => {
                els.recBar.style.animation = '';
            });
        } else {
            els.recBar.classList.remove('progress-bar');
            els.recBar.className = `h-full ${barColor}`;
            els.recBar.style.transition = 'width 0.5s ease-out, background-color 0.5s ease-out, box-shadow 0.5s ease-out';
        }
    }

    clearNode(els.scoreDetails);
    const detailFrag = document.createDocumentFragment();
    [
        `SRC: ${sourceLabel}`,
        `BAS: ${scoreData.details.base}`,
        `POP: ${scoreData.details.heat}`,
        `PRF: ${scoreData.details.preference}`
    ].forEach(text => {
        const span = document.createElement('span');
        span.textContent = text;
        detailFrag.appendChild(span);
    });
    els.scoreDetails.appendChild(detailFrag);

    if (els.reportArea) {
        clearNode(els.prosList);
        clearNode(els.consList);

        if (scoreData.report.pros.length > 0) {
            const prosFrag = document.createDocumentFragment();
            scoreData.report.pros.forEach(p => {
                const li = document.createElement('li');
                li.className = 'flex gap-2 items-start';
                const icon = createIcon('plus', 'h-3 w-3 shrink-0 text-green-500 mt-1');
                const span = document.createElement('span');
                span.textContent = p;
                li.appendChild(icon);
                li.appendChild(span);
                prosFrag.appendChild(li);
            });
            els.prosList.appendChild(prosFrag);
        } else {
            const li = document.createElement('li');
            li.className = 'text-cinema-400 italic';
            li.textContent = '暂无突出亮点';
            els.prosList.appendChild(li);
        }

        if (scoreData.report.cons.length > 0) {
            const consFrag = document.createDocumentFragment();
            scoreData.report.cons.forEach(c => {
                const li = document.createElement('li');
                li.className = 'flex gap-2 items-start';
                const icon = createIcon('minus', 'h-3 w-3 shrink-0 text-accent-red mt-1');
                const span = document.createElement('span');
                span.textContent = c;
                li.appendChild(icon);
                li.appendChild(span);
                consFrag.appendChild(li);
            });
            els.consList.appendChild(consFrag);
        } else {
            const li = document.createElement('li');
            li.className = 'text-cinema-400 italic';
            li.textContent = '暂无明显缺点';
            els.consList.appendChild(li);
        }
    }
}

function createPosterContext(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId) {
    return {
        candidate,
        enrichmentQuery,
        viewModel,
        searchId,
        searchOptions,
        loadId,
        loadKey: `${searchId}:${loadId}`,
        year: candidate?.year || viewModel?.detail?.year || ''
    };
}

function renderViewModel(viewModel, posterContext, { isUpdate = false } = {}) {
    setText(els.title, viewModel.title);
    setText(els.subTitle, viewModel.subtitle);
    renderGenres(viewModel.genres);
    renderSynopsis(viewModel.overviewSource, viewModel.summary);
    loadPoster(viewModel.posterUrl, viewModel.title, posterContext);
    renderTmdbFacts(viewModel);
    renderTmdbProfile(viewModel);
    renderScore({
        rating: viewModel.rating,
        votes: viewModel.votes,
        genres: viewModel.genres,
        hasWiki: viewModel.overviewSource === 'ZH.WIKIPEDIA',
        summary: viewModel.summary,
        source: 'tmdb'
    }, 'TMDB', isUpdate);
}

function focusResultHeading() {
    requestAnimationFrame(() => {
        if (els.title && typeof els.title.focus === 'function') {
            els.title.focus({ preventScroll: true });
        }
    });
}

async function safeTmdbSearch(query, options = {}) {
    try {
        return await TmdbAPI.search(query, options);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('TMDB search failed:', error);
        throw error;
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
let currentCandidateAbortController = null;
let currentCandidateAbortCleanup = null;
let currentCandidateLoadId = 0;
let lastSearchQuery = '';

function isActiveSearch(searchId, loadId = null) {
    return searchId === currentSearchId && (loadId === null || loadId === currentCandidateLoadId);
}

function getSearchErrorMessage(error) {
    if (error && (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError'))) {
        return '暂时无法连接数据服务，请检查网络或稍后重试。';
    }
    return error?.message || '搜索失败，请稍后重试。';
}

function getSearchErrorHint(error) {
    if (error?.status === 429) return '请求比较频繁，请稍等片刻后再试。';
    if (error?.status === 503) return '数据服务暂时不可用，稍后重试通常即可恢复。';
    if (error?.status === 504 || /timed out|timeout|超时/i.test(error?.message || '')) {
        return '数据源响应较慢，重试会重新发起一次请求。';
    }
    if (/未找到/.test(error?.message || '')) return '可以补充年份、季数或更完整的片名。';
    if (error && (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError'))) {
        return '请检查网络连接，确认后再重试。';
    }
    return '网络或数据源存在波动，请稍后重试。';
}

function showEmptySearchError() {
    setText(els.errorMsg, '请输入电影或剧集名称');
    setText(els.errorHint, '输入片名后按 Enter 或点击搜索。');
    els.error.classList.remove('hidden');
    els.loading.classList.add('hidden');
    els.results.classList.add('hidden');
    hideCandidatePicker();
    hideDataNotice();
    setSearchStatus('请输入电影或剧集名称');
    setSearching(false);
    els.input?.focus();
}

function showSearchError(error, query, searchId) {
    if (!isActiveSearch(searchId)) return;
    const message = getSearchErrorMessage(error);
    setText(els.errorMsg, message);
    setText(els.errorHint, getSearchErrorHint(error));
    setText(els.retrySearchButton, '重试搜索');
    els.error.classList.remove('hidden');
    els.loading.classList.add('hidden');
    els.results.classList.add('hidden');
    hideCandidatePicker();
    setSearchStatus(`搜索失败：${message}`);
    setSearching(false);
    lastSearchQuery = query;
}

function resetResultAnimation() {
    els.results.querySelectorAll('.fade-up').forEach(element => {
        element.style.animation = 'none';
    });
    requestAnimationFrame(() => {
        const fadeElements = els.results.querySelectorAll('.fade-up');
        fadeElements.forEach(element => void element.offsetHeight);
        fadeElements.forEach(element => { element.style.animation = ''; });
    });
}

let resourceScheduleCleanup = null;
let resourceLoadStarted = false;
let resourceResultState = null;

function abortCandidateRequests() {
    if (currentCandidateAbortCleanup) currentCandidateAbortCleanup();
    currentCandidateAbortCleanup = null;
    if (currentCandidateAbortController) currentCandidateAbortController.abort();
    currentCandidateAbortController = null;
}

function createCandidateRequestOptions(searchOptions = {}) {
    abortCandidateRequests();
    const controller = new AbortController();
    const parentSignal = searchOptions.signal;
    let cleanup = null;

    if (parentSignal) {
        const abortFromParent = () => controller.abort();
        if (parentSignal.aborted) controller.abort();
        else {
            parentSignal.addEventListener('abort', abortFromParent, { once: true });
            cleanup = () => parentSignal.removeEventListener('abort', abortFromParent);
        }
    }

    currentCandidateAbortController = controller;
    currentCandidateAbortCleanup = cleanup;
    return { ...searchOptions, signal: controller.signal };
}

function resourceCandidateKey(candidate) {
    return `${candidate?.mediaType || candidate?.type || 'media'}:${candidate?.id || candidate?.title || candidate?.originalTitle || ''}`;
}

function cancelResourceLoadSchedule() {
    const cleanup = resourceScheduleCleanup;
    resourceScheduleCleanup = null;
    if (cleanup) cleanup();
}

function beginResourceLoad(candidate, searchId, searchOptions, loadId, { refresh = false } = {}) {
    if (!isActiveSearch(searchId, loadId) || resourceLoadStarted) return;
    resourceLoadStarted = true;
    cancelResourceLoadSchedule();
    renderResourceLoadingStates(candidate.title || candidate.originalTitle || '当前影视');
    void loadResources(candidate, searchId, searchOptions, loadId, { refresh });
}

function scheduleResourceLoad(candidate, searchId, searchOptions, loadId) {
    cancelResourceLoadSchedule();
    if (resourceResultState?.candidateKey === resourceCandidateKey(candidate)) {
        resourceLoadStarted = true;
        return;
    }
    resourceLoadStarted = false;

    const title = candidate.title || candidate.originalTitle || '当前影视';
    const start = () => beginResourceLoad(candidate, searchId, searchOptions, loadId);
    renderResourceDeferredStates(title, start);

    let observer = null;
    let timeoutId = null;
    let idleId = null;
    const cleanup = () => {
        if (observer) observer.disconnect();
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (idleId !== null && typeof globalThis.cancelIdleCallback === 'function') {
            globalThis.cancelIdleCallback(idleId);
        }
    };
    resourceScheduleCleanup = cleanup;

    const canObserveResourceSection = els.resourceSection && typeof globalThis.IntersectionObserver === 'function';
    const idleStart = () => {
        if (isActiveSearch(searchId, loadId)) start();
    };

    if (canObserveResourceSection) {
        observer = new globalThis.IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) start();
        }, { rootMargin: RESOURCE_OBSERVER_ROOT_MARGIN });
        observer.observe(els.resourceSection);
    } else {
        if (typeof globalThis.requestIdleCallback === 'function') {
            idleId = globalThis.requestIdleCallback(idleStart, { timeout: RESOURCE_IDLE_TIMEOUT_MS });
        } else {
            timeoutId = setTimeout(idleStart, RESOURCE_TIMER_FALLBACK_MS);
        }
    }
}

async function loadResources(candidate, searchId, searchOptions, loadId, { refresh = false } = {}) {
    if (!isActiveSearch(searchId, loadId)) return;

    try {
        const resourceResult = await ResourceAPI.search(candidate.title || candidate.originalTitle, searchOptions, { refresh });
        if (!resourceResult) throw new Error('资源服务返回了空结果');
        if (!isActiveSearch(searchId, loadId)) return;
        resourceResultState = {
            candidateKey: resourceCandidateKey(candidate),
            result: resourceResult
        };
        renderResourceList(Array.isArray(resourceResult.resources) ? resourceResult.resources : []);
        renderWpzysResourceList(Array.isArray(resourceResult.wpzysResources) ? resourceResult.wpzysResources : []);
        renderQuarkUrls(Array.isArray(resourceResult.quarkUrls) ? resourceResult.quarkUrls : []);
        if (resourceResult.partial || resourceResult.resourceMeta?.partial) {
            setResourceStatus('资源扫描部分完成，可重试补全');
            renderResourceNotice(resourceResult, async () => {
                resourceResultState = null;
                resourceLoadStarted = false;
                beginResourceLoad(candidate, searchId, searchOptions, loadId, { refresh: true });
            });
        } else {
            hideResourceNotice();
            setResourceStatus('资源扫描完成');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (!isActiveSearch(searchId, loadId)) return;
        renderResourceErrorStates(() => {
            resourceResultState = null;
            resourceLoadStarted = false;
            beginResourceLoad(candidate, searchId, searchOptions, loadId, { refresh: true });
        });
        console.debug('Resource enrichment skipped:', error);
    }
}

function startPosterFallback(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId) {
    setEnrichmentStatus(els.omdbStatus, '正在查找备用海报…', true);
    const posterContext = createPosterContext(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);
    return PosterAPI.getPoster(enrichmentQuery, candidate.year, searchOptions).then(posterResult => {
        if (!isActiveSearch(searchId, loadId)) return;
        if (!posterResult) {
            setEnrichmentStatus(els.omdbStatus, viewModel.omdbProfile ? '已补充 OMDb 数据' : '暂无备用海报');
            return;
        }

        if (posterResult.omdb) {
            viewModel.omdbProfile = typeof posterResult.omdb === 'object' ? posterResult.omdb : posterResult;
        }
        if (!viewModel.posterUrl && posterResult.poster) {
            viewModel.posterUrl = posterResult.poster;
            loadPoster(viewModel.posterUrl, viewModel.title, posterContext);
        }
        renderTmdbProfile(viewModel);
        setEnrichmentStatus(
            els.omdbStatus,
            viewModel.omdbProfile ? '已补充 OMDb 数据' : posterResult.poster ? '已找到备用海报' : '暂无备用海报'
        );
    }).catch(error => {
        if (error?.name === 'AbortError') return;
        if (isActiveSearch(searchId, loadId)) setEnrichmentStatus(els.omdbStatus, '暂无备用海报');
        console.debug('Poster enrichment skipped:', error);
    });
}

async function startTitleEnrichment(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId) {
    setEnrichmentStatus(els.omdbStatus, '正在补充 OMDb 数据…', true);
    const posterContext = createPosterContext(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);

    let omdbProfile = null;
    try {
        omdbProfile = await OmdbAPI.search(enrichmentQuery, candidate.year, searchOptions);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.debug('OMDb title enrichment skipped:', error);
    }

    if (!isActiveSearch(searchId, loadId)) return;
    if (omdbProfile) {
        viewModel.omdbProfile = omdbProfile;
        if (!viewModel.posterUrl && omdbProfile.poster) {
            viewModel.posterUrl = omdbProfile.poster;
            loadPoster(viewModel.posterUrl, viewModel.title, posterContext);
        }
        renderTmdbProfile(viewModel);
    }

    if (viewModel.posterUrl) {
        setEnrichmentStatus(els.omdbStatus, omdbProfile ? '已补充 OMDb 数据' : '暂无 IMDb / OMDb 补充数据');
        return;
    }

    await startPosterFallback(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);
}

function startOmdbEnrichment(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId) {
    const imdbId = viewModel.detail?.imdbId || candidate.imdbId;
    if (!imdbId) {
        void startTitleEnrichment(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);
        return;
    }

    setEnrichmentStatus(els.omdbStatus, '正在补充 IMDb / OMDb 数据…', true);
    OmdbAPI.getById(imdbId, searchOptions).then(omdbProfile => {
        if (!isActiveSearch(searchId, loadId)) return;
        if (omdbProfile) {
            viewModel.omdbProfile = omdbProfile;
            if (!viewModel.posterUrl && omdbProfile.poster) {
                viewModel.posterUrl = omdbProfile.poster;
                loadPoster(viewModel.posterUrl, viewModel.title, createPosterContext(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId));
            }
            renderTmdbProfile(viewModel);
        }

        if (!viewModel.posterUrl) {
            void startPosterFallback(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);
            return;
        }
        setEnrichmentStatus(els.omdbStatus, omdbProfile ? '已补充 IMDb / OMDb 数据' : '暂无 IMDb / OMDb 补充数据');
    }).catch(error => {
        if (error?.name === 'AbortError') return;
        if (isActiveSearch(searchId, loadId)) {
            if (viewModel.posterUrl) setEnrichmentStatus(els.omdbStatus, '暂无 IMDb / OMDb 补充数据');
            else void startPosterFallback(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);
        }
        console.debug('OMDb enrichment skipped:', error);
    });
}

function startEnrichments(candidate, query, viewModel, searchId, searchOptions, loadId, detailPromise = Promise.resolve()) {
    const enrichmentQuery = candidate.title || candidate.originalTitle || query;
    setEnrichmentStatus(els.wikiStatus, '正在补充中文 Wikipedia 简介…', true);

    DoubanAPI.search(enrichmentQuery, searchOptions).then(async doubanSearchResult => {
        if (!isActiveSearch(searchId, loadId)) return;
        const doubanCandidates = Array.isArray(doubanSearchResult) ? doubanSearchResult : [];
        const doubanMatch = pickBestDoubanMatch(doubanCandidates, enrichmentQuery);
        if (doubanMatch && doubanMatch.id) {
            const doubanResult = await DoubanAPI.getDetail(doubanMatch.id, searchOptions).catch(error => {
                if (error?.name === 'AbortError') throw error;
                return null;
            });
            if (!isActiveSearch(searchId, loadId) || !doubanResult) return;
            viewModel.doubanRating = doubanResult.rating;
            renderBackupDoubanRating(viewModel.doubanRating);
        }
    }).catch(error => { if (error?.name !== 'AbortError') console.debug('Douban enrichment skipped:', error); });

    WikiAPI.getSummary(enrichmentQuery, searchOptions).then(wikiResult => {
        if (!isActiveSearch(searchId, loadId)) return;
        const hasWiki = Boolean(wikiResult?.extract);
        if (hasWiki) {
            viewModel.summary = wikiResult.extract;
            viewModel.overviewSource = 'ZH.WIKIPEDIA';
            renderSynopsis(viewModel.overviewSource, viewModel.summary);
            renderScore({
                rating: viewModel.rating,
                votes: viewModel.votes,
                genres: viewModel.genres,
                hasWiki: true,
                summary: viewModel.summary,
                source: 'tmdb'
            }, 'TMDB', true);
        }
        setEnrichmentStatus(els.wikiStatus, hasWiki ? '已补充中文 Wikipedia 简介' : '暂无中文 Wikipedia 补充');
    }).catch(error => {
        if (error?.name === 'AbortError') return;
        if (isActiveSearch(searchId, loadId)) setEnrichmentStatus(els.wikiStatus, '暂无中文 Wikipedia 补充');
        console.debug('Wiki enrichment skipped:', error);
    });

    scheduleResourceLoad(candidate, searchId, searchOptions, loadId);

    void detailPromise
        .then(() => {
            if (isActiveSearch(searchId, loadId)) {
                startOmdbEnrichment(candidate, enrichmentQuery, viewModel, searchId, searchOptions, loadId);
            }
        })
        .catch(error => {
            if (error?.name !== 'AbortError') console.debug('Detail enrichment gate skipped:', error);
        });
}

async function loadCandidateDetails(candidate, query, searchId, searchOptions, { isRetry = false } = {}) {
    if (!isActiveSearch(searchId)) return;

    cancelResourceLoadSchedule();
    const loadId = ++currentCandidateLoadId;
    const candidateOptions = createCandidateRequestOptions(searchOptions);
    resourceLoadStarted = false;
    if (!isRetry) resourceResultState = null;
    const selectedCandidate = {
        ...candidate,
        mediaType: candidate?.mediaType || candidate?.type || null
    };
    setSearching(true);
    hideCandidatePicker();
    els.error.classList.add('hidden');
    if (isRetry) {
        showDataNotice({
            title: '正在重新加载详情',
            detail: '保留当前结果，正在向 TMDB 请求完整资料。'
        });
    } else {
        els.results.classList.add('hidden');
        els.loading.classList.remove('hidden');
        showToast('正在加载影视详情…');
    }

    const viewModel = buildTmdbViewModel(selectedCandidate, null, null, null);
    const enrichmentQuery = selectedCandidate.title || selectedCandidate.originalTitle || query;
    const posterContext = createPosterContext(selectedCandidate, enrichmentQuery, viewModel, searchId, candidateOptions, loadId);
    renderViewModel(viewModel, posterContext);

    els.results.classList.remove('hidden');
    els.loading.classList.add('hidden');
    setSearchStatus(`已找到“${viewModel.title}”，正在补充详情`);
    setSearching(false);
    scrollToVisible(els.results);
    focusResultHeading();

    const detailPromise = TmdbAPI.getDetail(selectedCandidate.id, selectedCandidate.mediaType, candidateOptions)
        .then(tmdbDetail => {
            if (!isActiveSearch(searchId, loadId)) return null;

            const existingSummary = viewModel.overviewSource === 'ZH.WIKIPEDIA' ? viewModel.summary : '';
            const existingPoster = viewModel.posterUrl;
            const existingOmdbProfile = viewModel.omdbProfile;
            const detailViewModel = buildTmdbViewModel(selectedCandidate, tmdbDetail, null, null);
            Object.assign(viewModel, detailViewModel);
            if (existingSummary) {
                viewModel.summary = existingSummary;
                viewModel.overviewSource = 'ZH.WIKIPEDIA';
            }
            if (existingPoster) viewModel.posterUrl = existingPoster;
            if (existingOmdbProfile) viewModel.omdbProfile = existingOmdbProfile;
            renderViewModel(viewModel, posterContext, { isUpdate: true });
            setSearchStatus(`已找到“${viewModel.title}”，详情已加载`);
            hideDataNotice();
            return tmdbDetail;
        })
        .catch(error => {
            if (error?.name === 'AbortError') throw error;
            if (isActiveSearch(searchId, loadId)) {
                setSearchStatus(`已找到“${viewModel.title}”，基础信息已加载`);
                showDataNotice({
                    title: 'TMDB 详情暂时不可用',
                    detail: '当前显示搜索结果中的基础信息，评分和季集数据可能不完整。',
                    actionLabel: '重试详情',
                    onAction: () => loadCandidateDetails(candidate, query, searchId, searchOptions, { isRetry: true }),
                    tone: 'error'
                });
            }
            console.debug('TMDB detail skipped:', error);
            return null;
        });

    startEnrichments(selectedCandidate, query, viewModel, searchId, candidateOptions, loadId, detailPromise);
    await detailPromise;
}

async function handleSearch() {
    const query = els.input.value.trim();
    if (!query) {
        currentSearchId += 1;
        currentAbortController?.abort();
        abortCandidateRequests();
        cancelResourceLoadSchedule();
        resourceLoadStarted = false;
        resourceResultState = null;
        lastSearchQuery = '';
        showEmptySearchError();
        return;
    }

    lastSearchQuery = query;

    cancelResourceLoadSchedule();
    resourceLoadStarted = false;
    resourceResultState = null;
    abortCandidateRequests();
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    const searchOptions = { signal: currentAbortController.signal };

    const searchId = ++currentSearchId;

    els.error.classList.add('hidden');
    els.results.classList.add('hidden');
    hideCandidatePicker();
    hideDataNotice();
    els.loading.classList.remove('hidden');
    resetRatingBoxes();
    setSearching(true);
    setSearchStatus(`正在搜索“${query}”`);
    resetResultAnimation();

    try {
        const tmdbSearch = await safeTmdbSearch(query, searchOptions);
        if (searchId !== currentSearchId) return;

        const tmdbResults = tmdbSearch && Array.isArray(tmdbSearch.results) ? tmdbSearch.results : [];

        if (tmdbResults.length === 0) {
            throw new Error(`未找到“${query}”的可靠影视匹配，请补充年份、季数或更完整的片名`);
        }

        const rankedCandidates = rankTmdbCandidates(tmdbResults);
        const candidate = pickBestTmdbMatch(rankedCandidates, query) || (rankedCandidates.length === 1 ? rankedCandidates[0] : null);
        const requiresConfirmation = shouldConfirmTmdbCandidate(rankedCandidates) || !candidate;

        if (requiresConfirmation) {
            renderCandidatePicker(rankedCandidates, query, selectedCandidate => {
                if (!isActiveSearch(searchId)) return;
                void loadCandidateDetails(selectedCandidate, query, searchId, searchOptions).catch(error => {
                    if (error?.name !== 'AbortError') showSearchError(error, query, searchId);
                });
            });
            els.loading.classList.add('hidden');
            setSearching(false);
            setSearchStatus(`找到 ${Math.min(rankedCandidates.length, 6)} 个候选，请确认要查看的影视条目`);
            scrollToVisible(els.candidatePicker);
            return;
        }

        if (!candidate) throw new Error(`未找到“${query}”的可靠影视匹配，请补充年份、季数或更完整的片名`);
        await loadCandidateDetails(candidate, query, searchId, searchOptions);

    } catch (err) {
        if (err?.name === 'AbortError') return;
        showSearchError(err, query, searchId);
    } finally {
        if (searchId === currentSearchId) setSearching(false);
    }
}

if (els.searchForm) {
    els.searchForm.addEventListener('submit', e => {
        e.preventDefault();
        handleSearch();
    });
}

if (els.retrySearchButton) {
    els.retrySearchButton.addEventListener('click', () => {
        if (!lastSearchQuery) return;
        els.input.value = lastSearchQuery;
        void handleSearch();
    });
}
