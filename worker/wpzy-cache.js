import { createHttpError } from './core.js';

// One object per credential fingerprint coordinates cache keys across edge
// locations. The cache itself remains in the Worker Cache API.
export class WpzyCacheSession {
    constructor(state) {
        this.sql = state.storage.sql;
        this.sql.exec('CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, revoked INTEGER NOT NULL)');
        this.sql.exec('INSERT OR IGNORE INTO session VALUES (1, 0, 0)');
    }

    async fetch(request) {
        if (request.method === 'POST') {
            const { generation, revoked } = await request.json();
            this.sql.exec(`UPDATE session SET generation = generation + ?, revoked = ?
                WHERE id = 1 AND generation = ? AND revoked != ?`, revoked, revoked, generation, revoked);
        }
        return Response.json(this.sql.exec('SELECT generation FROM session WHERE id = 1').one().generation);
    }
}

export function getWpzyCacheSession(binding, fingerprint) {
    const stub = binding.getByName(fingerprint);
    // A coordination outage is a temporary 503 for the visitor, not a 500.
    return async (generation, revoked) => {
        let response;
        try {
            response = await stub.fetch('https://wpzy-cache.internal/', generation === undefined ? undefined : {
                method: 'POST',
                body: JSON.stringify({ generation, revoked: Number(revoked) })
            });
        } catch {
            throw createHttpError('WPZY cache coordination unavailable', 503);
        }
        if (!response.ok) throw createHttpError('WPZY cache coordination unavailable', 503);
        const value = await response.json().catch(() => null);
        if (!Number.isInteger(value)) throw createHttpError('WPZY cache coordination unavailable', 503);
        return value;
    };
}
