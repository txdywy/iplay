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
    return async (generation, revoked) => {
        const response = await stub.fetch('https://wpzy-cache.internal/', generation === undefined ? undefined : {
            method: 'POST',
            body: JSON.stringify({ generation, revoked: Number(revoked) })
        });
        if (!response.ok) throw new Error('WPZY cache coordination unavailable');
        return response.json();
    };
}
