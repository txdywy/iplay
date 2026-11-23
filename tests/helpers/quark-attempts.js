import { DatabaseSync } from 'node:sqlite';
import { QuarkPasscodeAttempts } from '../../worker/quark-attempts.js';

export function testQuarkAttempts(t) {
    const shares = new Map();
    return {
        getByName(id) {
            if (!shares.has(id)) {
                const db = new DatabaseSync(':memory:');
                t.after(() => db.close());
                const coordinator = new QuarkPasscodeAttempts({ storage: { sql: {
                    exec(statement, ...args) {
                        const rows = db.prepare(statement).all(...args);
                        return { toArray: () => rows };
                    }
                } } });
                shares.set(id, { fetch: (url, options) => coordinator.fetch(new Request(url, options)) });
            }
            return shares.get(id);
        }
    };
}
