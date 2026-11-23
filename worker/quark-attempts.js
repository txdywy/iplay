// Each share has one coordinator across all edge locations and callers.
const WINDOW_MS = 3600_000;
// An attempt Quark never answered (a timeout, an outage) may or may not have
// reached it. It is held for a shorter time, so a slow hour on Quark's side
// does not lock a share's passcode check for everyone until the hour is out.
const UNANSWERED_WINDOW_MS = 600_000;
const MAX_ATTEMPTS = 2;
export const QUARK_ATTEMPT_HOST = 'quark-attempts.internal';

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
        if (request.method === 'PATCH') {
            this.sql.exec('UPDATE attempts SET expires = MIN(expires, ?) WHERE id = ?', Date.now() + UNANSWERED_WINDOW_MS, await request.text());
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

// Resolves to null when no attempt may be made, or to the reservation's
// `release` (the attempt settled without a refusal: give the slot back) and
// `unanswered` (keep the slot, for the shorter window only).
export async function reserveQuarkAttempt(binding, id, timeoutMs) {
    if (!binding) return null;
    const stub = binding.getByName(`quark-share:${id}`);
    const endpoint = `https://${QUARK_ATTEMPT_HOST}/`;
    const response = await stub.fetch(endpoint, { method: 'POST', signal: globalThis.AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error('Quark attempt coordination unavailable');
    const reservation = await response.json();
    if (typeof reservation !== 'string') return null;
    const settle = method => async () => {
        await stub.fetch(endpoint, { method, body: reservation, signal: globalThis.AbortSignal.timeout(3000) });
    };
    return { release: settle('DELETE'), unanswered: settle('PATCH') };
}
