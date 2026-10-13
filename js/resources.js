const PROVIDER_LISTS = { by669: 'resources', wpzys: 'wpzysResources' };
const MAX_QUARK_LINKS = 100;
const asArray = value => Array.isArray(value) ? value : [];
const pageKey = page => JSON.stringify([page.source || '', page.url || '']);

export function resourceQueryKey(candidate) {
    return JSON.stringify([
        candidate?.mediaType || candidate?.type || 'media',
        candidate?.id || '',
        candidate?.title || candidate?.originalTitle || '',
        candidate?.year || ''
    ]);
}

function mergeLists(previous, incoming) {
    const byUrl = new Map();
    for (const item of [...asArray(previous), ...asArray(incoming)]) {
        if (item?.url) byUrl.set(item.url, { ...item });
    }
    return [...byUrl.values()];
}

function legacyPages(result, previous) {
    const sources = new Map(Object.entries(PROVIDER_LISTS).flatMap(([source, field]) =>
        asArray(result[field]).map(item => [item.url, source])));
    const pages = new Map();
    const oldPasswordUrls = new Set(asArray(previous?.pages)
        .flatMap(page => asArray(page.quarkUrls))
        .filter(item => item.password || item.passwordConflict)
        .map(item => item.url));
    for (const item of asArray(result.quarkUrls)) {
        if (!item?.url) continue;
        const url = item.sourceUrl || '';
        const source = sources.get(url) || item.source || '';
        const key = pageKey({ source, url });
        if (!pages.has(key)) pages.set(key, { url, source, status: 'ok', quarkUrls: [] });
        const evidence = { ...item };
        // Legacy responses omit both evidence confidence and some conflicts.
        // Unknown confidence cannot be treated as weaker than a URL password;
        // an omitted password must also invalidate any retained same-share code.
        if (evidence.password || evidence.passwordConflict) {
            if (![1, 2].includes(Number(evidence.passwordRank))) {
                evidence.passwordRank = 1;
                evidence._passwordRankUnknown = true;
            }
        } else if (oldPasswordUrls.has(item.url)) {
            evidence.passwordRank = 1;
            evidence.passwordConflict = true;
            evidence._passwordRankUnknown = true;
        }
        pages.get(key).quarkUrls.push(evidence);
    }
    return [...pages.values()];
}

function combineShares(pages) {
    const byUrl = new Map();
    for (const page of pages) {
        for (const item of asArray(page.quarkUrls)) {
            if (!item?.url) continue;
            if (!byUrl.has(item.url)) {
                if (byUrl.size >= MAX_QUARK_LINKS) continue;
                byUrl.set(item.url, { known: null, unknown: [], first: null });
            }
            const evidence = byUrl.get(item.url);
            const next = { ...item, sourceUrl: item.sourceUrl || page.url, sourceTitle: item.sourceTitle || page.title };
            evidence.first ||= next;
            if (item._passwordRankUnknown) {
                evidence.unknown.push(next);
                continue;
            }
            const rank = Number(item.passwordRank) || (item.password || item.passwordConflict ? 1 : 0);
            const existing = evidence.known;
            if (!existing || rank > existing.passwordRank) {
                next.passwordRank = rank;
                if (next.passwordConflict) delete next.password;
                evidence.known = next;
                continue;
            }
            if (rank && rank === existing.passwordRank && (existing.passwordConflict || next.passwordConflict || existing.password !== next.password)) {
                existing.passwordConflict = true;
                delete existing.password;
            }
        }
    }
    return [...byUrl.values()].map(({ known, unknown, first }) => {
        // Resolve known URL/prose priority before comparing unknown evidence,
        // so iteration order cannot make a weaker known password win or stick.
        const chosen = known?.passwordRank ? known : unknown[0] || known || first;
        const result = { ...chosen };
        if (unknown.some(item => item.passwordConflict || item.password !== chosen.password)) {
            result.passwordConflict = true;
            delete result.password;
        }
        delete result.passwordRank;
        delete result._passwordRankUnknown;
        return result;
    });
}

// Keep page evidence separate from the deduplicated display result. Otherwise a
// conflict hidden in one scan can resurrect an older password on the next retry.
export function mergeResourceState(previous, incoming) {
    const partial = Boolean(incoming.partial || incoming.resourceMeta?.partial);
    const providers = incoming.resourceMeta?.providers || {};
    const hasPageEvidence = Array.isArray(incoming.resourceMeta?.pages);
    const currentPages = hasPageEvidence ? incoming.resourceMeta.pages : legacyPages(incoming, previous);
    const expiredSources = new Set(currentPages.filter(page => page.status === 'login_required').map(page => page.source));
    const pageUpdates = new Map(currentPages.map(page => [pageKey(page), page]));
    const lists = {};
    for (const [source, field] of Object.entries(PROVIDER_LISTS)) {
        lists[field] = providers[source] === 'failed' || (partial && !providers[source])
            ? mergeLists(previous?.result?.[field], incoming[field])
            : mergeLists([], incoming[field]);
    }
    const sourceUrls = new Map(Object.entries(PROVIDER_LISTS).map(([source, field]) =>
        [source, new Set(asArray(incoming[field]).map(item => item.url))]));
    const pages = new Map();
    for (const page of asArray(previous?.pages)) {
        if (expiredSources.has(page.source) || incoming.resourceMeta?.providerIssues?.[page.source] === 'login_required') continue;
        const status = providers[page.source];
        const update = pageUpdates.get(pageKey(page));
        if (['ok', 'restricted', 'login_required'].includes(update?.status)) continue;
        const retain = status === 'failed'
            || (partial && !status)
            || (sourceUrls.get(page.source)?.has(page.url) && (hasPageEvidence || partial));
        if (retain) pages.set(pageKey(page), page);
    }
    for (const page of currentPages) {
        if (page?.status !== 'ok') continue;
        const evidence = { ...page, quarkUrls: asArray(page.quarkUrls).map(item => ({ ...item })) };
        pages.set(pageKey(page), evidence);
    }
    const evidencePages = [...pages.values()];
    return {
        pages: evidencePages,
        result: { ...incoming, ...lists, quarkUrls: combineShares(evidencePages) }
    };
}
