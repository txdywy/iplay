import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Local image-byte model, not an external CDN latency benchmark. No copyrighted
// image is committed. Download the three public JPEG variants before running:
//   mkdir -p /tmp/iplay-image-fixture
//   for size in 185 342 500; do
//     curl --fail --location --output /tmp/iplay-image-fixture/w${size}.jpg \
//       https://image.tmdb.org/t/p/w${size}/eMurN09rDC2qeEv3npkUbcJfIXN.jpg
//   done
//   IMAGE_FIXTURE_DIR=/tmp/iplay-image-fixture PERF_OUTPUT=/tmp/images.json \
//     node tests/browser-smoke-runner.mjs tests/browser-image-performance.mjs
// Export a release's static files and set SMOKE_SITE_ROOT for historical runs.
// Three cards share one image, so request coalescing is the same in both builds.
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const fixtureDirectory = process.env.IMAGE_FIXTURE_DIR || join(tmpdir(), 'iplay-image-fixture');
const imagePath = '/eMurN09rDC2qeEv3npkUbcJfIXN.jpg';
const imageBase = 'https://image.tmdb.org/t/p';
const cases = [
    { name: 'mobile-1x', width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    { name: 'mobile-2x', width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    { name: 'mobile-3x', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    { name: 'desktop-1x', width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    { name: 'desktop-2x', width: 1280, height: 900, deviceScaleFactor: 2, mobile: false }
];

function jpegSize(data) {
    assert.equal(data.readUInt16BE(0), 0xffd8, 'image fixtures must be JPEG files');
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    for (let offset = 2; offset + 8 < data.length;) {
        assert.equal(data[offset], 0xff, 'invalid JPEG fixture marker');
        while (data[offset + 1] === 0xff) offset += 1;
        const marker = data[offset + 1];
        if (frameMarkers.has(marker)) return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
        const length = data.readUInt16BE(offset + 2);
        assert.ok(length >= 2, 'invalid JPEG fixture segment');
        offset += 2 + length;
    }
    throw new Error('JPEG fixture has no supported frame header');
}

const fixtures = new Map();
for (const width of [185, 342, 500]) {
    let bytes;
    try {
        bytes = await readFile(join(fixtureDirectory, `w${width}.jpg`));
    } catch (error) {
        throw new Error(`Missing image fixture w${width}.jpg in ${fixtureDirectory}. Download the public variants using the commands at the top of this script.`, { cause: error });
    }
    const dimensions = jpegSize(bytes);
    assert.equal(dimensions.width, width, 'a width descriptor must match the real fixture pixels');
    fixtures.set(width, {
        ...dimensions,
        bytes,
        base64: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: `${imageBase}/w${width}${imagePath}`
    });
}

const socket = new globalThis.WebSocket(process.env.BROWSER_WS);
const pending = new Map();
const interceptionTasks = new Set();
const exceptions = [];
const interceptionErrors = [];
let nextId = 0;
let activeRequests = new Map();

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

async function fulfilImage(params) {
    const url = new URL(params.request.url);
    const match = url.pathname.match(/^\/t\/p\/w(185|342|500)\/eMurN09rDC2qeEv3npkUbcJfIXN\.jpg$/);
    const fixture = match ? fixtures.get(Number(match[1])) : null;
    if (!fixture) {
        interceptionErrors.push(`Unexpected image URL: ${url.href}`);
        await command('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 404, body: '' });
        return;
    }
    const request = activeRequests.get(params.networkId) || { url: url.href };
    request.fulfilledBodyBytes = fixture.bytes.length;
    request.fixtureWidth = fixture.width;
    activeRequests.set(params.networkId || params.requestId, request);
    await command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
            { name: 'Content-Type', value: 'image/jpeg' },
            { name: 'Content-Length', value: String(fixture.bytes.length) },
            { name: 'Cache-Control', value: 'no-store' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Timing-Allow-Origin', value: '*' }
        ],
        body: fixture.base64
    });
}

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    if (message.method === 'Fetch.requestPaused') {
        const task = fulfilImage(message.params).catch(error => interceptionErrors.push(error.message));
        interceptionTasks.add(task);
        void task.finally(() => interceptionTasks.delete(task));
    }
    if (message.method === 'Network.requestWillBeSent' && new URL(message.params.request.url).hostname === 'image.tmdb.org') {
        activeRequests.set(message.params.requestId, { ...activeRequests.get(message.params.requestId), url: message.params.request.url });
    }
    const networkRequest = activeRequests.get(message.params?.requestId);
    if (networkRequest) {
        if (message.method === 'Network.responseReceived') {
            Object.assign(networkRequest, {
                status: message.params.response.status,
                mimeType: message.params.response.mimeType,
                fromDiskCache: Boolean(message.params.response.fromDiskCache)
            });
        }
        if (message.method === 'Network.requestServedFromCache') networkRequest.servedFromCache = true;
        if (message.method === 'Network.loadingFinished') networkRequest.encodedDataLength = message.params.encodedDataLength;
        if (message.method === 'Network.loadingFailed') networkRequest.failure = message.params.errorText;
    }
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
    throw new Error(`Image performance scenario timed out: ${expression}`);
}

try {
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] });
    await command('Fetch.enable', { patterns: [{ urlPattern: 'https://image.tmdb.org/*', requestStage: 'Request' }] });
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const json = data => Response.json(data);
        window.fetch = async input => {
            const url = new URL(input, location.href);
            if (url.pathname === '/api/tmdb/search') return json({results: []});
            if (url.pathname === '/api/tmdb/person') return json({
                person: {id: 900, name: 'Image Performance Actor', matchScore: 1, matchConfidence: 'high'},
                credits: Array.from({length: 3}, (_, index) => ({
                    id: 1000 + index, mediaType: 'tv', title: 'Image Fixture ' + index,
                    year: '2024', tmdbRating: 8, poster: ${JSON.stringify(`${imageBase}/w500${imagePath}`)}
                })),
                totalResults: 3, offset: 0, limit: 36, hasMore: false, counts: {tv: 3, movie: 0}
            });
            throw new Error('Unexpected image fixture API: ' + url.pathname);
        };
    })()` });
    const browser = await command('Browser.getVersion');
    const scenarios = [];
    for (const scenario of cases) {
        await command('Page.navigate', { url: 'about:blank' });
        await command('Network.clearBrowserCache');
        await command('Emulation.setDeviceMetricsOverride', {
            width: scenario.width,
            height: scenario.height,
            deviceScaleFactor: scenario.deviceScaleFactor,
            mobile: scenario.mobile
        });
        activeRequests = new Map();
        await command('Page.navigate', { url: baseUrl });
        await waitFor("document.readyState === 'complete' && history.state?.kind === 'home'");
        await evaluate("document.querySelector('#searchInput').value = 'Image Performance Actor'; document.querySelector('#searchForm').requestSubmit()");
        await waitFor("document.querySelectorAll('#actorCreditList img').length === 3");
        await evaluate("document.querySelector('#actorCreditList img').scrollIntoView({block:'start',behavior:'instant'})");
        await waitFor("Array.from(document.querySelectorAll('#actorCreditList img')).every(image => image.complete && image.naturalWidth > 0)");
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await Promise.all(interceptionTasks);
        const cards = await evaluate(`Array.from(document.querySelectorAll('#actorCreditList img')).map(image => ({
            actualCardWidth: image.getBoundingClientRect().width,
            currentSrc: image.currentSrc,
            src: image.getAttribute('src'),
            srcset: image.getAttribute('srcset'),
            sizes: image.getAttribute('sizes'),
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            loading: image.loading
        }))`);
        for (const card of cards) {
            const selectedWidth = Number(new URL(card.currentSrc).pathname.match(/\/w(\d+)\//)?.[1]);
            assert.ok(fixtures.has(selectedWidth), 'the browser must select a real fixture variant');
            assert.equal(card.loading, 'lazy', 'actor cards must retain lazy loading');
            card.selectedBitmapWidth = selectedWidth;
            card.requestedDevicePixels = card.actualCardWidth * scenario.deviceScaleFactor;
            card.pixelCoverageRatio = selectedWidth / Math.min(500, card.requestedDevicePixels);
            assert.ok(card.pixelCoverageRatio >= 0.85, 'selected image must reasonably cover its rendered device pixels');
        }
        const requests = [...activeRequests.values()];
        assert.ok(requests.length > 0, 'the image must be fulfilled after clearing the cache');
        assert.ok(requests.every(request => request.status === 200 && !request.failure && request.fulfilledBodyBytes > 0), 'all fixture image requests must finish successfully');
        assert.ok(requests.every(request => !request.fromDiskCache && !request.servedFromCache), 'each scenario must load uncached fixture bytes');
        scenarios.push({
            ...scenario,
            cards,
            imageRequestCount: requests.length,
            fulfilledBodyBytes: requests.reduce((sum, request) => sum + request.fulfilledBodyBytes, 0),
            observedEncodedDataLength: requests.reduce((sum, request) => sum + (request.encodedDataLength || 0), 0),
            requests
        });
    }
    assert.deepEqual(exceptions, [], 'the page must have no runtime exceptions');
    assert.deepEqual(interceptionErrors, [], 'all intercepted images must match the byte model');
    const report = {
        model: 'Local CDP fulfilment of real JPEG bytes; no external CDN timing claim. Three cards share one image. Cache disabled and cleared for each scenario.',
        encodedDataLengthNote: 'CDP fulfilment may report zero encodedDataLength. fulfilledBodyBytes is the exact supplied JPEG payload model, separate from observed network accounting. naturalWidth is density-corrected by responsive image selection.',
        browser: browser.product,
        fonts: 'blocked',
        imageFixtures: [...fixtures.values()].map(({ width, height, bytes, sha256, source }) => ({width, height, bodyBytes: bytes.length, sha256, source})),
        scenarios
    };
    if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally {
    socket.close();
}
