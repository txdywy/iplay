import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import worker from '../worker/_worker.js';
import { WPZY_EMPTY_SEARCH_HTML } from './fixtures/wpzy-search.js';

const { Response, Request } = globalThis;

// Fixed synthetic upstream latencies exercise scheduler cost through the public
// Worker route. No public network, production credentials or provider load.
const measurements = [];
const fetchBefore = globalThis.fetch;
const cachesBefore = globalThis.caches;
try {
    for (let run = 0; run < 3; run++) {
        let active = 0;
        let peak = 0;
        const started = [];
        const began = performance.now();
        globalThis.caches = { default: { match: async () => null, put: async () => {} } };
        globalThis.fetch = async input => {
            const url = new URL(input);
            if (url.hostname === 'wpzy.org') return new Response(WPZY_EMPTY_SEARCH_HTML);
            if (url.pathname === '/api/discussions') return Response.json({ data: Array.from({length:12}, (_,i)=>({id:String(i+1),attributes:{title:'Performance Movie 夸克'}})) });
            const page = Number(url.pathname.split('/').at(-1));
            active++;
            peak = Math.max(peak, active);
            started.push({page,at:performance.now()-began});
            await new Promise(resolve => setTimeout(resolve, page === 1 || page === 7 ? 600 : 30));
            active--;
            return new Response(`https://pan.quark.cn/s/performance-${page}`);
        };
        const response = await worker.fetch(new Request('https://worker.test/api/resource?q=Performance%20Movie&refresh=1', {
            headers:{'cf-connecting-ip':`performance-run-${run}`}
        }), {}, {waitUntil(){}});
        assert.equal(response.status,200);
        const data = await response.json();
        assert.equal(data.resourceMeta.attemptedPages,12);
        assert.equal(data.quarkUrls.length,12);
        assert.ok(peak<=6);
        assert.deepEqual(data.quarkUrls.map(item=>item.url),Array.from({length:12},(_,i)=>`https://pan.quark.cn/s/performance-${i+1}`));
        measurements.push({duration:performance.now()-began,peak,started});
    }
    const report = {profile:'12 pages; pages 1/7=600ms, other pages=30ms; no real network',measurements};
    if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT,JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
} finally {
    globalThis.fetch = fetchBefore;
    globalThis.caches = cachesBefore;
}
