function toNonNegativeInteger(value) {
    if (value === null || value === undefined || value === '') return null;

    const numericValue = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : NaN;

    return Number.isSafeInteger(numericValue) && numericValue >= 0 ? numericValue : null;
}

export function formatSeasonEpisodeCounts(seasons) {
    if (!Array.isArray(seasons)) return '';

    const seenSeasonNumbers = new Set();
    const entries = [];

    for (const season of seasons) {
        if (!season || typeof season !== 'object' || Array.isArray(season)) continue;

        const seasonNumber = toNonNegativeInteger(season.seasonNumber);
        if (seasonNumber === null || seenSeasonNumbers.has(seasonNumber)) continue;

        seenSeasonNumbers.add(seasonNumber);
        const episodeCount = toNonNegativeInteger(season.episodeCount);
        const label = seasonNumber === 0 ? '特别篇' : `第 ${seasonNumber} 季`;
        const count = episodeCount === null ? '待定' : `${episodeCount} 集`;
        entries.push({ seasonNumber, text: `${label}：${count}` });
    }

    return entries
        .sort((left, right) => left.seasonNumber - right.seasonNumber)
        .map(entry => entry.text)
        .join(' / ');
}

export function formatSeasonTotals(totalSeasons, totalEpisodes) {
    const seasonCount = toNonNegativeInteger(totalSeasons);
    const episodeCount = toNonNegativeInteger(totalEpisodes);
    if (seasonCount === null && episodeCount === null) return '';
    if (seasonCount === null) return `共 ${episodeCount} 集`;
    if (episodeCount === null) return `共 ${seasonCount} 季`;
    return `共 ${seasonCount} 季：${episodeCount} 集`;
}
