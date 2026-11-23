// Each share has one coordinator across all edge locations and callers.
const WINDOW_MS = 3600_000;
const MAX_ATTEMPTS = 2;

export class QuarkPasscodeAttempts {
    constructor(state) {
        this.sql = state.storage.sql;
        this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    }

    async fetch(request) {
        if (request.method === 'DELETE') {
            this.sql.exec('DELETE FROM attempts WHERE id = ?', await request.text());
            return new Response(null, { status: 204 });
        }
        const now = Date.now();
        const id = globalThis.crypto.randomUUID();
        this.sql.exec('DELETE FROM attempts WHERE expires <= ?', now);
        // A single conditional insert reserves capacity before contacting Quark.
        const reserved = this.sql.exec(`INSERT INTO attempts SELECT ?, ?
            WHERE (SELECT COUNT(*) FROM attempts) < ? RETURNING id`, id, now + WINDOW_MS, MAX_ATTEMPTS).toArray();
        return Response.json(reserved[0]?.id ?? null);
    }
}

export async function reserveQuarkAttempt(binding, id, timeoutMs) {
    if (!binding) return null;
    const stub = binding.getByName(id);
    const endpoint = 'https://quark-attempts.internal/';
    const response = await stub.fetch(endpoint, { method: 'POST', signal: globalThis.AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error('Quark attempt coordination unavailable');
    const reservation = await response.json();
    return typeof reservation === 'string' ? async () => {
        await stub.fetch(endpoint, { method: 'DELETE', body: reservation, signal: globalThis.AbortSignal.timeout(3000) });
    } : null;
}
