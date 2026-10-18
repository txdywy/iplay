import assert from 'node:assert/strict';
import { open, writeFile } from 'node:fs/promises';

// Controlled lab measurements. API fixtures and blocked fonts deliberately
// isolate application cost; these are not field Core Web Vitals or API timings.
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const desktop = process.env.PERF_PROFILE === 'desktop';
const viewport = desktop ? { width: 1280, height: 900 } : { width: 390, height: 844 };
const latencyMs = desktop ? 40 : 300;
const downloadKiB = desktop ? 1536 : 96;
const cpuSlowdown = desktop ? 1 : 6;
const socket = new globalThis.WebSocket(process.env.BROWSER_WS);
const pending = new Map();
const exceptions = [];
let nextId = 0;
let traceStream;
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    if (message.method === 'Tracing.tracingComplete') traceStream = message.params.stream;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    globalThis.clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});
function command(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
        }, 20000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
}
async function waitFor(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Performance scenario timed out: ${expression}`);
}
const afterPaint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function search(query) {
    await evaluate(`document.querySelector('#searchInput').value = ${JSON.stringify(query)}; document.querySelector('#searchForm').requestSubmit()`);
}

try {
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    await command('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] });
    await command('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: !desktop });
    await command('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    await command('Network.emulateNetworkConditions', { offline: false, latency: latencyMs, downloadThroughput: downloadKiB * 1024, uploadThroughput: downloadKiB * 512, connectionType: desktop ? 'wifi' : 'cellular3g' });
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        window.__perf = { longTasks: [], actorCreated: 0, actorRemoved: 0 };
        new PerformanceObserver(list => { window.__perf.lcp = list.getEntries().at(-1)?.startTime; }).observe({type:'largest-contentful-paint',buffered:true});
        new PerformanceObserver(list => { window.__perf.cls = (window.__perf.cls || 0) + list.getEntries().filter(e => !e.hadRecentInput).reduce((a,e) => a+e.value,0); }).observe({type:'layout-shift',buffered:true});
        new PerformanceObserver(list => { window.__perf.longTasks.push(...list.getEntries().map(e => e.duration)); }).observe({type:'longtask',buffered:true});
        const image = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        const candidate = id => ({ id, title: 'Performance Movie ' + id, originalTitle: 'Performance Movie ' + id, mediaType: id % 2 ? 'tv' : 'movie', year: '2024', poster: image, summary: 'A detailed performance fixture synopsis.', tmdbRating: 8.2, tmdbVotes: 1200, matchScore: 1, matchConfidence: 'high' });
        const json = data => Response.json(data);
        window.fetch = async input => {
            const url = new URL(input, location.href);
            if (url.pathname === '/api/tmdb/search') return json({ results: url.searchParams.get('q') === 'Performance Actor' ? [] : [candidate(100)] });
            if (url.pathname === '/api/tmdb/person') {
                const offset = Number(url.searchParams.get('offset') || 0);
                const credits = Array.from({length: 36}, (_, i) => ({...candidate(1000 + offset + i), character: 'Performance Role'}));
                return json({person:{id:900,name:'Performance Actor',matchScore:1,matchConfidence:'high'},credits,totalResults:720,offset,limit:36,hasMore:offset+36<720,counts:{tv:360,movie:360}});
            }
            if (url.pathname === '/api/tmdb/detail') return json({...candidate(100),genres:['Drama'],cast:[],castDetails:[],director:[],writer:[],imdbId:''});
            if (url.pathname === '/api/douban/search') return json([]);
            if (url.pathname === '/api/wiki/zh') return json({extract:''});
            if (url.pathname === '/api/poster') return json({tmdb:true,tmdbId:100,mediaType:'movie',poster:image});
            if (url.pathname === '/api/resource') return json({resources:[],wpzysResources:[],quarkUrls:Array.from({length:100},(_,i)=>({title:'Resource ' + i + ' ' + 'ReleaseFilename'.repeat(15),url:'https://pan.quark.cn/s/perf-'+i,password:'abcd'}))});
            throw new Error('Unexpected performance fixture: ' + url.pathname);
        };
    })()` });
    const browser = await command('Browser.getVersion');
    const cold = [];
    for (let run = 0; run < 3; run++) {
        await command('Network.clearBrowserCache');
        await command('Page.navigate', { url: baseUrl });
        await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
        await new Promise(resolve => setTimeout(resolve, 1100));
        cold.push(await evaluate(`({lcp:window.__perf.lcp,cls:window.__perf.cls||0,ready:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,js:performance.getEntriesByType('resource').filter(e=>e.initiatorType==='script' || /\\/js\\/|app\\.min\\.js/.test(e.name)).map(e=>({name:e.name.split('/').at(-1),start:e.startTime,end:e.responseEnd,bytes:e.transferSize})),longTasks:window.__perf.longTasks})`));
    }
    await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if (process.env.PERF_TRACE) await command('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,v8', transferMode: 'ReturnAsStream' });
    await evaluate(`(() => {
        const seen = new WeakSet();
        const cards = nodes => Array.from(nodes).flatMap(node => [
            ...(node.matches?.('button[data-media-id]') ? [node] : []),
            ...Array.from(node.querySelectorAll?.('button[data-media-id]') || [])
        ]);
        new MutationObserver(records => {
            for (const record of records) {
                for (const card of cards(record.addedNodes)) {
                    if (!seen.has(card)) { seen.add(card); window.__perf.actorCreated++; }
                }
                window.__perf.actorRemoved += cards(record.removedNodes).length;
            }
        }).observe(document.querySelector('#actorCreditList'),{childList:true,subtree:true});
    })()`);
    await search('Performance Actor');
    await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id]').length === 36");
    const pagination = [];
    for (let page = 2; page <= 8; page++) {
        await evaluate("window.__perf.clickStart = performance.now(); document.querySelector('#actorLoadMore').click()");
        await waitFor(`document.querySelectorAll('#actorCreditList button[data-media-id]').length === ${page * 36} && !document.querySelector('#actorLoadMore').disabled`);
        await afterPaint();
        pagination.push(await evaluate('performance.now() - window.__perf.clickStart'));
    }
    const actor = await evaluate('({created:window.__perf.actorCreated,removed:window.__perf.actorRemoved,cards:document.querySelectorAll("#actorCreditList button[data-media-id]").length,longTasks:window.__perf.longTasks})');
    assert.equal(actor.cards, 288);
    // Event Timing from a trusted browser input complements programmatic render
    // timings. A single lab click is not a field INP percentile.
    const actorPoint = await evaluate(`(() => {
        const button = document.querySelector('#actorLoadMore');
        button.scrollIntoView({block:'center'});
        const rect = button.getBoundingClientRect();
        window.__perf.events = [];
        new PerformanceObserver(list => window.__perf.events.push(...list.getEntries().filter(e=>e.interactionId).map(e=>({name:e.name,duration:e.duration,interactionId:e.interactionId})))).observe({type:'event',durationThreshold:16});
        return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    })()`);
    await afterPaint();
    await command('Input.dispatchMouseEvent', {type:'mousePressed',...actorPoint,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent', {type:'mouseReleased',...actorPoint,button:'left',clickCount:1});
    await waitFor("document.querySelectorAll('#actorCreditList button[data-media-id]').length === 324");
    await afterPaint();
    await new Promise(resolve => setTimeout(resolve, 100));
    const actorInteraction = await evaluate('window.__perf.events');
    await search('Performance Movie');
    await waitFor("document.querySelector('#showTitle').textContent === 'Performance Movie 100'");
    await evaluate("document.querySelector('#resourcesSection').scrollIntoView({block:'start'})");
    await waitFor("document.querySelectorAll('#quarkUrlList a').length === 6");
    await evaluate("window.__perf.expandStart=performance.now(); Array.from(document.querySelectorAll('#quarkUrlList button')).find(b=>b.textContent.startsWith('显示更多')).click()");
    await waitFor("document.querySelectorAll('#quarkUrlList a').length === 100");
    await afterPaint();
    const expand = await evaluate('({duration:performance.now()-window.__perf.expandStart,nodes:document.querySelectorAll("#quarkUrlList *").length,width:document.documentElement.scrollWidth})');
    assert.ok(expand.width <= viewport.width + 1, 'resource expansion must fit the viewport');
    assert.deepEqual(exceptions, []);
    if (process.env.PERF_TRACE) {
        await command('Tracing.end');
        const traceDeadline = Date.now() + 15000;
        while (!traceStream && Date.now() < traceDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.ok(traceStream, 'Chrome must finish the performance trace');
        const file = await open(process.env.PERF_TRACE, 'w');
        try {
            for (;;) {
                const part = await command('IO.read', { handle: traceStream, size: 100000 });
                await file.write(part.base64Encoded ? globalThis.Buffer.from(part.data, 'base64') : part.data);
                if (part.eof) break;
            }
        } finally { await file.close(); await command('IO.close', { handle: traceStream }); }
    }
    const report = { profile: { viewport: `${viewport.width}x${viewport.height}`, latencyMs, downloadKiB, cpuSlowdown, api: 'fixtures', fonts: 'blocked', browser: browser.product }, cold, actor: { ...actor, pagination, interaction: actorInteraction }, resourceExpansion: expand };
    if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally { socket.close(); }
