import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

const { Request, Response, performance } = globalThis;

const moduleUrl = process.env.PERF_WORKER_MODULE
    ? pathToFileURL(resolve(process.env.PERF_WORKER_MODULE))
    : new URL('../worker/_worker.js', import.meta.url);
const { default: worker } = await import(moduleUrl.href);
const original = { fetch: globalThis.fetch, caches: globalThis.caches };
const cases = [
    { name: 'ordinary-page', foreignLinks: 40 },
    { name: 'near-body-limit-foreign-links', foreignLinks: 200000 }
];
const measurements = [];

try {
    for (const scenario of cases) {
        const body = 'https://x '.repeat(scenario.foreignLinks)
            + '<p>https://pan.quark.cn/s/parser-late 提取码：a1B2</p>';
        const bodyBytes = globalThis.Buffer.byteLength(body);
        assert.ok(bodyBytes < 2 * 1024 * 1024);
        globalThis.caches = { default: { match: async () => null, put: async () => {} } };
        globalThis.fetch = async input => {
            const url = new URL(input);
            if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
            if (url.pathname === '/api/discussions') return Response.json({ data: [
                { id: '1', attributes: { title: 'Parser Performance 夸克' } }
            ] });
            assert.equal(url.href, 'https://by669.org/d/1');
            return new Response(body);
        };
        const runs = [];
        for (let run = 0; run < 9; run++) {
            globalThis.gc?.();
            const heapBefore = process.memoryUsage().heapUsed;
            const start = performance.now();
            const response = await worker.fetch(new Request('https://worker.test/api/resource?q=Parser%20Performance&refresh=1', {
                headers: { 'cf-connecting-ip': `parser-${scenario.name}-${run}` }
            }), {}, { waitUntil() {} });
            assert.equal(response.status, 200);
            const data = await response.json();
            assert.equal(data.resourceMeta.attemptedPages, 1);
            assert.deepEqual(data.quarkUrls.map(({ url, password }) => ({ url, password })), [
                { url: 'https://pan.quark.cn/s/parser-late', password: 'a1B2' }
            ]);
            runs.push({ durationMs: performance.now() - start, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore });
        }
        measurements.push({ ...scenario, bodyBytes, runs });
    }
    const report = {
        profile: 'Node public Worker route; fixed responses, no network; heap delta is an instantaneous process sample, not peak memory or workerd CPU',
        node: process.version,
        gcBeforeEachRun: typeof globalThis.gc === 'function',
        warmupRuns: 2,
        measurements
    };
    if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally {
    Object.assign(globalThis, original);
}
