import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));

function configuredPort(name) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : 0;
}

async function findAvailablePort(preferredPort = 0) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(preferredPort, '127.0.0.1', resolve);
    });
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise(resolve => probe.close(resolve));
    if (!port) throw new Error('Could not allocate a local test port.');
    return port;
}

async function canExecute(path) {
    if (!path) return false;
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function findChrome() {
    const candidates = [
        process.env.CHROME_BIN,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (await canExecute(candidate)) return candidate;
    }

    for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
        for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
            const candidate = join(directory, name);
            if (await canExecute(candidate)) return candidate;
        }
    }

    throw new Error('Chrome/Chromium executable not found. Set CHROME_BIN to run browser smoke tests.');
}

function startProcess(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        ...options
    });
    child.on('error', error => {
        console.error(command + ' failed:', error.message);
    });
    return child;
}

async function stopProcess(child) {
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
        const timer = globalThis.setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
        }, 2000);
        child.once('exit', () => {
            globalThis.clearTimeout(timer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function waitForJson(url, predicate, timeoutMs = 10000) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await globalThis.fetch(url);
            if (response.ok) {
                const value = await response.json();
                if (predicate(value)) return value;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => globalThis.setTimeout(resolve, 100));
    }
    const suffix = lastError ? ': ' + lastError.message : '';
    throw new Error('Timed out waiting for ' + url + suffix);
}

async function waitForHttp(url, timeoutMs = 10000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await globalThis.fetch(url);
            if (response.ok) return;
        } catch {
            // The server is still starting.
        }
        await new Promise(resolve => globalThis.setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for ' + url);
}

const chromePath = await findChrome();
const serverPort = await findAvailablePort(configuredPort('SMOKE_PORT'));
const debugPort = await findAvailablePort(configuredPort('SMOKE_DEBUG_PORT'));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:' + serverPort + '/';
const profileDir = await mkdtemp(join(tmpdir(), 'iplay-browser-smoke-'));
const server = startProcess('python3', ['-m', 'http.server', String(serverPort), '--bind', '127.0.0.1']);
const chrome = startProcess(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profileDir,
    'about:blank'
]);

let smoke = null;
try {
    await waitForHttp('http://127.0.0.1:' + serverPort + '/index.html');
    const targets = await waitForJson(
        'http://127.0.0.1:' + debugPort + '/json/list',
        value => Array.isArray(value) && value.some(target => target.type === 'page' && target.webSocketDebuggerUrl),
        15000
    );
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    smoke = startProcess(process.execPath, ['tests/browser-smoke.mjs'], {
        env: {
            ...process.env,
            BASE_URL: baseUrl,
            BROWSER_WS: page.webSocketDebuggerUrl
        }
    });
    const exitCode = await new Promise((resolve, reject) => {
        smoke.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
        smoke.once('error', reject);
    });
    if (exitCode !== 0) process.exitCode = exitCode;
} finally {
    await stopProcess(smoke);
    await stopProcess(chrome);
    await stopProcess(server);
    await rm(profileDir, { recursive: true, force: true }).catch(error => {
        console.warn('Could not remove temporary Chrome profile:', error.message);
    });
}
