export function toFiniteNumber(value, fallback = null) {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function formatRating(value, fallback = '-.-') {
    const number = toFiniteNumber(value);
    return number !== null && number > 0 ? number.toFixed(1) : fallback;
}
