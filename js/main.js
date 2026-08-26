import { TmdbAPI, DoubanAPI, WikiAPI, ResourceAPI, PosterAPI } from './api.js';
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
    retrySearchButton: document.getElementById('retrySearchButton'),
    candidatePicker: document.getElementById('candidatePicker'),
    candidatePickerTitle: document.getElementById('candidatePickerTitle'),
    candidatePickerQuery: document.getElementById('candidatePickerQuery'),
    candidateList: document.getElementById('candidateList'),
    results: document.getElementById('resultsArea'),
    searchStatus: document.getElementById('searchStatus'),
    dataNotice: document.getElementById('dataNotice'),

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
        button.className = 'shrink-0 rounded-full border border-cinema-400/60 px-4 py-2 font-mono text-xs text-cinema-100 transition-colors hover:border-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-60';
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

const POSTER_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='600' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%23141417'/%3E%3Ctext x='50%25' y='50%25' fill='%23333333' font-family='monospace' font-size='28' text-anchor='middle' dominant-baseline='middle'%3ENO POSTER%3C/text%3E%3C/svg%3E";

if (els.cover) {
    els.cover.addEventListener('error', () => {
        if (els.cover.src !== POSTER_PLACEHOLDER) els.cover.src = POSTER_PLACEHOLDER;
    });
}

function loadPoster(posterUrl, title = '') {
    els.cover.alt = title ? `${title} 海报` : '影视海报';
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
        overviewSource: wikiResult && wikiResult.extract ? 'ZH.WIKIPEDIA' : detail && detail.summary ? 'TMDB' : 'NO DATA'
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

function renderLinkCards(container, items, {
    emptyLabel, itemClass, cardClass, iconClass, metaClass, metaText, titleText,
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

    const renderVisibleItems = visibleLimit => {
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

            const icon = document.createElement('i');
            icon.className = iconClass;
            icon.setAttribute('aria-hidden', 'true');

            row.appendChild(content);
            row.appendChild(icon);
            link.appendChild(row);

            if (hasAction) {
                card.appendChild(link);

                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'mt-3 w-full rounded-xl border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-xs font-mono tracking-wider text-cinema-100 transition-colors hover:border-accent-red/70 hover:bg-accent-red/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-70';
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
            button.className = 'w-full rounded-xl border border-cinema-700 px-3 py-3 text-xs font-mono tracking-wider text-cinema-400 transition-colors hover:border-cinema-400 hover:text-cinema-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red';
            button.textContent = `显示更多（剩余 ${maxItems - visibleLimit} 条）`;
            button.addEventListener('click', () => renderVisibleItems(maxItems));
            li.appendChild(button);
            frag.appendChild(li);
        } else if (visibleLimit > firstPageSize) {
            const li = document.createElement('li');
            li.className = 'p-3';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'w-full rounded-xl border border-cinema-700 px-3 py-3 text-xs font-mono tracking-wider text-cinema-400 transition-colors hover:border-cinema-400 hover:text-cinema-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red';
            button.textContent = '收起列表';
            button.addEventListener('click', () => renderVisibleItems(firstPageSize));
            li.appendChild(button);
            frag.appendChild(li);
        }

        container.appendChild(frag);
    };

    renderVisibleItems(firstPageSize);
}

function renderResourceStatus(container, { title, detail, iconClass, progressClass, isLoading = true, actionLabel = '', onAction = null }) {
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

    const icon = document.createElement('i');
    icon.className = `${iconClass} mt-1 opacity-80`;
    icon.setAttribute('aria-hidden', 'true');

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
        button.className = 'mt-4 rounded-full border border-cinema-400/60 px-4 py-2 text-xs font-mono text-cinema-100 transition-colors hover:border-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-red disabled:cursor-wait disabled:opacity-60';
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
    renderResourceStatus(els.quarkUrlList, {
        title: '正在提取夸克直链',
        detail: `正在扫描“${title}”的资源页面`,
        iconClass: 'fas fa-cloud text-accent-red',
        progressClass: 'resource-progress-red'
    });
    renderResourceStatus(els.resourceList, {
        title: '正在收集资源页面',
        detail: '正在检查资源索引和论坛帖子',
        iconClass: 'fas fa-link text-[#0099ff]',
        progressClass: 'resource-progress-blue'
    });
    renderResourceStatus(els.wpzysResourceList, {
        title: '正在搜索 WPZYS 论坛',
        detail: '正在筛选包含夸克资源的匹配帖子',
        iconClass: 'fas fa-comments text-accent-gold',
        progressClass: 'resource-progress-gold'
    });
}

function renderResourceErrorStates(onRetry) {
    renderResourceStatus(els.quarkUrlList, {
        title: '夸克直链暂时不可用',
        detail: '资源扫描没有完成，其他影视信息仍可正常使用',
        iconClass: 'fas fa-cloud text-accent-red',
        progressClass: 'resource-progress-red',
        isLoading: false,
        actionLabel: '重试资源扫描',
        onAction: onRetry
    });
    renderResourceStatus(els.resourceList, {
        title: '资源来源暂时没有响应',
        detail: '上方影视详情仍可使用，你可以重新扫描资源',
        iconClass: 'fas fa-link text-[#0099ff]',
        progressClass: 'resource-progress-blue',
        isLoading: false,
        actionLabel: '重试资源扫描',
        onAction: onRetry
    });
    renderResourceStatus(els.wpzysResourceList, {
        title: 'WPZYS 扫描已暂停',
        detail: '论坛结果可能暂时不可用，你可以稍后重试',
        iconClass: 'fas fa-comments text-accent-gold',
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
        iconClass: 'fas fa-external-link-alt text-[#0099ff] mt-1 opacity-70',
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
        iconClass: 'fas fa-comments text-accent-gold mt-1 opacity-80',
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
        iconClass: 'fas fa-cloud text-accent-red mt-1 opacity-80',
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
                const icon = document.createElement('i');
                icon.className = 'fas fa-plus text-green-500 mt-1';
                icon.setAttribute('aria-hidden', 'true');
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
                const icon = document.createElement('i');
                icon.className = 'fas fa-minus text-accent-red mt-1';
                icon.setAttribute('aria-hidden', 'true');
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

function showSearchError(error, query, searchId) {
    if (!isActiveSearch(searchId)) return;
    const message = getSearchErrorMessage(error);
    setText(els.errorMsg, message);
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

async function loadResources(candidate, searchId, searchOptions, loadId) {
    if (!isActiveSearch(searchId, loadId)) return;
    renderResourceLoadingStates(candidate.title || candidate.originalTitle || '当前影视');

    try {
        const resourceResult = await ResourceAPI.search(candidate.title || candidate.originalTitle, searchOptions);
        if (!resourceResult) throw new Error('资源服务返回了空结果');
        if (!isActiveSearch(searchId, loadId)) return;
        renderResourceList(Array.isArray(resourceResult.resources) ? resourceResult.resources : []);
        renderWpzysResourceList(Array.isArray(resourceResult.wpzysResources) ? resourceResult.wpzysResources : []);
        renderQuarkUrls(Array.isArray(resourceResult.quarkUrls) ? resourceResult.quarkUrls : []);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        if (!isActiveSearch(searchId, loadId)) return;
        renderResourceErrorStates(() => loadResources(candidate, searchId, searchOptions, loadId));
        console.debug('Resource enrichment skipped:', error);
    }
}

function startEnrichments(candidate, query, viewModel, searchId, searchOptions, loadId) {
    const enrichmentQuery = candidate.title || candidate.originalTitle || query;

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
        if (!isActiveSearch(searchId, loadId) || !wikiResult) return;
        viewModel.summary = wikiResult.extract || viewModel.summary;
        viewModel.overviewSource = wikiResult.extract ? 'ZH.WIKIPEDIA' : viewModel.overviewSource;
        renderSynopsis(viewModel.overviewSource, viewModel.summary);
        renderScore({
            rating: viewModel.rating,
            votes: viewModel.votes,
            genres: viewModel.genres,
            hasWiki: Boolean(wikiResult.extract),
            summary: viewModel.summary,
            source: 'tmdb'
        }, 'TMDB', true);
    }).catch(error => { if (error?.name !== 'AbortError') console.debug('Wiki enrichment skipped:', error); });

    void loadResources(candidate, searchId, searchOptions, loadId);

    PosterAPI.getPoster(candidate.title || candidate.originalTitle, candidate.year, searchOptions).then(posterResult => {
        if (!isActiveSearch(searchId, loadId) || !posterResult) return;
        viewModel.omdbProfile = posterResult.omdb
            ? (typeof posterResult.omdb === 'object' ? posterResult.omdb : posterResult)
            : viewModel.omdbProfile;
        viewModel.posterUrl = posterResult.poster || viewModel.posterUrl;
        loadPoster(viewModel.posterUrl, viewModel.title);
        renderTmdbProfile(viewModel);
    }).catch(error => { if (error?.name !== 'AbortError') console.debug('Poster enrichment skipped:', error); });
}

async function loadCandidateDetails(candidate, query, searchId, searchOptions, { isRetry = false } = {}) {
    if (!isActiveSearch(searchId)) return;

    const loadId = ++currentCandidateLoadId;
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

    let tmdbDetail = null;
    let detailError = null;
    try {
        tmdbDetail = await TmdbAPI.getDetail(selectedCandidate.id, selectedCandidate.mediaType, searchOptions);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        detailError = error;
    }

    if (!isActiveSearch(searchId, loadId)) return;

    const viewModel = buildTmdbViewModel(selectedCandidate, tmdbDetail, null, null);
    setText(els.title, viewModel.title);
    setText(els.subTitle, viewModel.subtitle);
    renderGenres(viewModel.genres);
    renderSynopsis(viewModel.overviewSource, viewModel.summary);
    loadPoster(viewModel.posterUrl, viewModel.title);
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
    setSearchStatus(`已找到“${viewModel.title}”，${detailError ? '基础信息已加载' : '详情已加载'}`);

    if (detailError) {
        showDataNotice({
            title: 'TMDB 详情暂时不可用',
            detail: '当前显示搜索结果中的基础信息，评分和季集数据可能不完整。',
            actionLabel: '重试详情',
            onAction: () => loadCandidateDetails(candidate, query, searchId, searchOptions, { isRetry: true }),
            tone: 'error'
        });
    } else {
        hideDataNotice();
    }

    setSearching(false);
    scrollToVisible(els.results);
    startEnrichments(selectedCandidate, query, viewModel, searchId, searchOptions, loadId);
}

async function handleSearch() {
    const query = els.input.value.trim();
    if (!query) return;

    lastSearchQuery = query;

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
