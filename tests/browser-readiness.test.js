import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { waitForHttp, waitForJson } from './helpers/browser-readiness.js';

function readinessClock(t) {
    let nowMs = 0;
    t.mock.method(Date, 'now', () => nowMs);
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        nowMs += delay;
        globalThis.queueMicrotask(callback);
        return 0;
    });
    return () => nowMs;
}

const page = { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1234/page' };
const hasPage = value => Array.isArray(value) && value.some(target => target.type === 'page' && target.webSocketDebuggerUrl);

test('browser readiness tolerates a healthy Chrome cold start longer than 15 seconds', async t => {
    const now = readinessClock(t);
    t.mock.method(globalThis, 'fetch', async () => {
        if (now() < 20000) throw new TypeError('Chrome is still starting');
        return Response.json([page]);
    });
    assert.deepEqual(await waitForJson('http://127.0.0.1:1234/json/list', hasPage), [page]);
    assert.equal(now(), 20000);
});

test('browser readiness fails immediately when the launched Chrome process exits', async t => {
    readinessClock(t);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests += 1; return Response.json([page]); });
    await assert.rejects(waitForJson('http://127.0.0.1:1234/json/list', hasPage, {
        child: { exitCode: 1, signalCode: null }
    }), /Chrome exited before browser readiness.*1/u);
    assert.equal(requests, 0);
});

test('browser readiness remains bounded and never accepts missing debug targets', async t => {
    const now = readinessClock(t);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests += 1;
        assert.ok(options.signal instanceof globalThis.AbortSignal);
        return Response.json([]);
    });
    await assert.rejects(waitForJson('http://127.0.0.1:1234/json/list', hasPage, {
        timeoutMs: 350,
        child: { exitCode: null, signalCode: null }
    }), /Timed out waiting/u);
    assert.equal(now(), 350);
    assert.equal(requests, 4);
});

test('HTTP readiness releases the unread response and reports an exited static server', async t => {
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        assert.ok(options.signal instanceof globalThis.AbortSignal);
        return new Response(new globalThis.ReadableStream({ cancel() { cancelled = true; } }));
    });
    await waitForHttp('http://127.0.0.1:1234/index.html');
    assert.equal(cancelled, true);
    await assert.rejects(waitForHttp('http://127.0.0.1:1234/index.html', {
        child: { exitCode: 1, signalCode: null }
    }), /Static server exited before browser readiness/);
});

test('HTTP and CDP readiness abort stalled response headers and JSON bodies', { timeout: 5000 }, async t => {
    const sockets = new Set();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', request => {
            if (request.toString().includes('/stalled-body')) {
                socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n[');
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}/never-respond`;
    for (const wait of [
        () => waitForHttp(url, { timeoutMs: 100 }),
        () => waitForJson(url, hasPage, { timeoutMs: 100 }),
        () => waitForJson(url.replace('/never-respond', '/stalled-body'), hasPage, { timeoutMs: 100 })
    ]) {
        const startedAt = Date.now();
        await assert.rejects(wait(), /Timed out waiting/);
        assert.ok(Date.now() - startedAt < 2000, 'stalled headers must respect the startup deadline');
    }
});
