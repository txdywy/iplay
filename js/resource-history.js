export const OPENED_LINKS_KEY = 'iplay_opened_links';
export const OPENED_LINK_COUNTS_KEY = 'iplay_opened_link_counts_v1';
export const STARRED_LINKS_KEY = 'iplay_starred_links';
const LIMIT = 1000;

// The empty key lets existing readers keep treating this as an array of
// URL/count pairs. It records which legacy write this snapshot reconciled.
const SNAPSHOT_KEY = '';

function readArray(raw) {
    try {
        const data = JSON.parse(raw || '[]');
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function readMarks(raw) {
    const marks = new Map();
    for (const entry of readArray(raw).slice(-LIMIT)) {
        const [url, count] = typeof entry === 'string' ? [entry, 1] : Array.isArray(entry) ? entry : [];
        if (typeof url === 'string' && url) marks.set(url, Number.isSafeInteger(count) && count > 0 ? count : 1);
    }
    return marks;
}

function trimEntries(entries) {
    while (entries.size > LIMIT) entries.delete(entries.keys().next().value);
    return entries;
}

export function createResourceHistory(getStorage) {
    let savedOpens = new Map();
    let savedStars = new Set();
    const pendingOpens = new Map();
    const pendingStars = new Map();

    function opens() {
        const result = new Map(savedOpens);
        for (const [url, { reset, increment }] of pendingOpens) {
            const count = Math.min(Number.MAX_SAFE_INTEGER, (reset ? 0 : result.get(url) || 0) + increment);
            result.delete(url);
            if (count) result.set(url, count);
        }
        return trimEntries(result);
    }

    function stars() {
        const result = new Set(savedStars);
        for (const [url, starred] of pendingStars) {
            result.delete(url);
            if (starred) result.add(url);
        }
        return trimEntries(result);
    }

    function readOpens(legacyChange) {
        const storage = getStorage();
        const raw = storage.getItem(OPENED_LINKS_KEY);
        const records = new Map(readArray(storage.getItem(OPENED_LINK_COUNTS_KEY)).filter(Array.isArray));
        const snapshot = records.get(SNAPSHOT_KEY);
        records.delete(SNAPSHOT_KEY);
        const mirror = JSON.stringify([...records.keys()]);
        const matchesSnapshot = snapshot && (raw === snapshot.observed || raw === mirror);
        // The old tab may already have reopened the link by the time this
        // event arrives. Compare the clear with the last committed URL list.
        let removed = [];
        if (legacyChange?.oldValue === mirror && legacyChange.newValue !== raw) {
            const remaining = readMarks(legacyChange.newValue);
            removed = [...records.keys()].filter(url => !remaining.has(url));
        }
        if (matchesSnapshot) {
            for (const url of removed) records.set(url, 1);
            savedOpens = records;
            return { raw, changed: removed.length > 0 };
        }
        for (const url of removed) records.delete(url);

        savedOpens = readMarks(raw);
        for (const [url, count] of savedOpens) {
            const previous = records.get(url);
            if (!Number.isSafeInteger(previous) || previous < 1) continue;
            // Older count writers start at one after reading the URL mirror.
            const merged = snapshot ? previous + count - 1 : Math.max(previous, count);
            savedOpens.set(url, Math.min(merged, Number.MAX_SAFE_INTEGER));
        }
        return { raw, changed: raw !== null || records.size > 0 || Boolean(snapshot) };
    }

    function syncOpens({ increment, clear, legacyChange, persist = false } = {}) {
        let observed;
        try {
            observed = readOpens(legacyChange);
        } catch {
            // Keep the last readable snapshot and local pending operations.
        }

        let cleared = 0;
        if (clear) {
            const current = opens();
            for (const url of clear) {
                if (!current.has(url)) continue;
                pendingOpens.delete(url);
                pendingOpens.set(url, { reset: true, increment: 0 });
                cleared++;
            }
        }
        if (increment) {
            const pending = pendingOpens.get(increment) || { reset: false, increment: 0 };
            pendingOpens.delete(increment);
            pendingOpens.set(increment, { ...pending, increment: pending.increment + 1 });
        }

        if (observed && persist && (observed.changed || pendingOpens.size)) {
            const next = opens();
            const mirror = JSON.stringify([...next.keys()]);
            try {
                const storage = getStorage();
                const needsMirror = observed.raw !== mirror;
                const snapshot = needsMirror ? { observed: observed.raw } : {};
                storage.setItem(OPENED_LINK_COUNTS_KEY, JSON.stringify([...next, [SNAPSHOT_KEY, snapshot]]));
                savedOpens = next;
                pendingOpens.clear();
                if (needsMirror) {
                    storage.setItem(OPENED_LINKS_KEY, mirror);
                    storage.setItem(OPENED_LINK_COUNTS_KEY, JSON.stringify([...next, [SNAPSHOT_KEY, {}]]));
                }
            } catch {
                // A failed mirror write leaves the already committed counts readable.
            }
        }
        return { marks: opens(), cleared };
    }

    function syncStars(toggle) {
        let storage;
        try {
            storage = getStorage();
            savedStars = new Set(readArray(storage.getItem(STARRED_LINKS_KEY)).filter(url => typeof url === 'string').slice(-LIMIT));
        } catch {
            storage = null;
        }
        if (toggle) {
            const starred = !stars().has(toggle);
            pendingStars.delete(toggle);
            pendingStars.set(toggle, starred);
        }
        const next = stars();
        if (storage && pendingStars.size) {
            try {
                storage.setItem(STARRED_LINKS_KEY, JSON.stringify([...next]));
                savedStars = next;
                pendingStars.clear();
            } catch {
                // Retry only these local changes against the next readable snapshot.
            }
        }
        return next;
    }

    return { syncOpens, syncStars };
}
