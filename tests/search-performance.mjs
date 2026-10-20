import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_SEARCH_QUERY, searchPerformanceResults, searchPerformanceAlias } from './fixtures/search-performance.js';

const { Request, Response } = globalThis;

// Public-route, Node-only synthetic CPU comparison. Upstreams and the edge
// cache are mocked: this does not measure workerd CPU, network, or real traffic.
const root = fileURLToPath(new URL('..', import.meta.url));
const baseRef = process.env.PERF_BASE_REF || '9a533773767ec6db4c6cd81bcd9c32a7d06c11be';
const baselineSource = execFileSync('git', ['show', `${baseRef}:worker/_worker.js`], { cwd: root, encoding: 'utf8' });
const currentSource = await readFile(new URL('../worker/_worker.js', import.meta.url), 'utf8');
const releaseUrl = new URL('../js/release.js', import.meta.url).href;

async function loadWorker(source, instrument = false) {
    let moduleSource = source.replace(/from ['"]\.\.\/js\/release\.js['"]/, `from '${releaseUrl}'`);
    if (instrument) {
        const needle = 'function scoreSearchText(query, candidate) {';
        assert.ok(moduleSource.includes(needle));
        moduleSource = moduleSource.replace(needle, `${needle}\n    globalThis.__IPLAY_SCORING_PROBE__();`);
    }
    return (await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)).default;
}

const workers = { baseline: await loadWorker(baselineSource), optimized: await loadWorker(currentSource) };
const previous = { fetch: globalThis.fetch, caches: globalThis.caches, probe: globalThis.__IPLAY_SCORING_PROBE__ };
const env = { TMDB_API_KEY: 'synthetic-only', API_RATE_LIMITER: { limit: async () => ({ success: true }) } };
async function run(worker) {
    const requests = [];
    let attempt = 0;
    const writes = [];
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    globalThis.fetch = async input => {
        const url = new URL(input);
        requests.push(`${url.hostname}${url.pathname}?${url.searchParams.get('query') || url.searchParams.get('q')}`);
        return url.hostname === 'movie.douban.com'
            ? Response.json(searchPerformanceAlias(url.searchParams.get('q')))
            : Response.json({ results: searchPerformanceResults(++attempt) });
    };
    const start = performance.now();
    const response = await worker.fetch(new Request(`https://worker.test/api/tmdb/search?q=${encodeURIComponent(PERFORMANCE_SEARCH_QUERY)}`), env, {
        waitUntil(promise) { writes.push(promise); }
    });
    const data = await response.json();
    await Promise.all(writes);
    const durationMs = performance.now() - start;
    assert.equal(response.status, 200);
    assert.equal(data.searchMeta.attempts, 6);
    assert.equal(attempt, 6);
    assert.equal(requests.length, 7);
    assert.equal(data.results.length, 20);
    return { durationMs, data, requests };
}

try {
    let reference;
    const durations = { baseline: [], optimized: [] };
    // Warm both implementations before alternating measured order.
    for (let index = 0; index < 3; index++) {
        for (const worker of Object.values(workers)) await run(worker);
    }
    for (let index = 0; index < 15; index++) {
        const order = index % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized'];
        for (const kind of order) {
            const result = await run(workers[kind]);
            reference ||= result;
            assert.deepEqual(result.data, reference.data, 'all response fields must remain identical');
            assert.deepEqual(result.requests, reference.requests, 'upstream request sequence and budget must remain identical');
            durations[kind].push(result.durationMs);
        }
    }
    const scoreCalculations = {};
    for (const [kind, source] of [['baseline', baselineSource], ['optimized', currentSource]]) {
        let count = 0;
        globalThis.__IPLAY_SCORING_PROBE__ = () => { count++; };
        const result = await run(await loadWorker(source, true));
        assert.deepEqual(result.data, reference.data);
        scoreCalculations[kind] = count;
    }
    assert.ok(scoreCalculations.optimized < scoreCalculations.baseline);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const report = {
        profile: 'Node public Worker route; six sequential TMDB fallbacks, 20 results each, repeated bilingual titles; mocked network/cache',
        limitations: 'Synthetic local Node elapsed time, including parsing/normalization/serialization; not workerd CPU, production latency or field Core Web Vitals.',
        baselineRef: baseRef,
        nodeVersion: process.version,
        runs: 15,
        durationMs: { baseline: durations.baseline, optimized: durations.optimized },
        medianMs: { baseline: median(durations.baseline), optimized: median(durations.optimized) },
        textScoreCalculations: scoreCalculations,
        verification: {
            identicalResponses: true, identicalUpstreamRequests: true, tmdbRequests: 6, doubanRequests: 1,
            responseSha256: createHash('sha256').update(JSON.stringify(reference.data)).digest('hex'),
            resultIds: reference.data.results.map(item => item.id),
            searchMeta: reference.data.searchMeta
        }
    };
    if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
} finally {
    globalThis.fetch = previous.fetch;
    globalThis.caches = previous.caches;
    if (previous.probe === undefined) delete globalThis.__IPLAY_SCORING_PROBE__;
    else globalThis.__IPLAY_SCORING_PROBE__ = previous.probe;
}
