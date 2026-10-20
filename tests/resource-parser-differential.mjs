import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Manual old/new differential analysis, not a copy of the parser algorithm.
// The private export exists only in these in-memory analysis modules; the
// production Worker and its public API remain unchanged. No network is used.
const root = fileURLToPath(new URL('..', import.meta.url));
const baselineRef = process.env.PERF_BASE_REF || '9a533773767ec6db4c6cd81bcd9c32a7d06c11be';
const baselineSource = execFileSync('git', ['show', `${baselineRef}:worker/_worker.js`], {
    cwd: root,
    encoding: 'utf8'
});
const currentSource = await readFile(new URL('../worker/_worker.js', import.meta.url), 'utf8');

async function loadParser(source) {
    const sha = createHash('sha256').update(source).digest('hex');
    const importPattern = /import \{ RELEASE_VERSION \} from '[^']+';/;
    assert.match(source, importPattern);
    const moduleSource = source.replace(importPattern, "const RELEASE_VERSION='differential';")
        + '\nexport {collectQuarkEntries};';
    const module = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
    return { parse: module.collectQuarkEntries, sha };
}

const baseline = await loadParser(baselineSource);
const current = await loadParser(currentSource);
const CASE_COUNT = 30000;
const EXPECTED_INPUT_SHA256 = '844642c3d783dc219e7973005e89dee4182d19b1e16d77a1b001b2d0cbd8debc';
const caps = [0, 1, 25, 100, Number.POSITIVE_INFINITY];

let seed = 0x10202026;
function random(limit) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % limit;
}

function pick(values) {
    return values[random(values.length)];
}

const separators = [
    '', ' ', '\n', '\r\n', '\n\n', '<p>', '</p>', '<br>', '<br/>',
    '<div>', '</div>', '</td><td>', '<section>', '</section>',
    '<span class="x">', '</span>',
    '<a href="https://else.example/download">下载</a>',
    'x'.repeat(159), 'x'.repeat(160), 'x'.repeat(161)
];
const codes = [
    'ab12', 'AB12', 'cd34', 'a1', 'AbCdEfGh1234', 'abcdefghijklmnop',
    'http', 'https', '12345', '&amp;ab12', '<b>ab12</b>'
];
const labels = [
    '提取码', '密码', '访问码', '百度提取码', '百度网盘密码', '阿里云盘密码',
    '迅雷提取码', 'UC网盘密码', '115网盘密码', '提取码：<code>', '访问码：<span>'
];
const tokens = [
    'alpha', 'Alpha', 'beta', 'gamma', 'dupe', 'x_1', 'z-2',
    'a'.repeat(128), 'b'.repeat(129)
];
const origins = [
    'https://pan.quark.cn/s/', 'https://drive.quark.cn/s/',
    'pan.quark.cn/s/', 'drive.quark.cn/s/', 'HTTPS://PAN.QUARK.CN/s/',
    'https://pan.baidu.com/s/', 'https://foreign.example/s/',
    'https://x/', 'http://pan.quark.cn/s/'
];

function createUrl() {
    const prefix = pick(origins) + (random(3) === 0 ? `dynamic-${random(300)}` : pick(tokens));
    // Keep evaluation order stable: even unselected password options consume
    // random values. The input digest below detects accidental generator drift.
    return prefix + pick([
        '', `?pwd=${pick(codes)}`, `?password=${pick(codes)}`,
        '?pwd=ab12&password=cd34', '#pwd=cd34', '?note=提取码：ab12',
        '?note=提取码ab12&pwd=cd34', '?pwd=ab12&amp;pwd=cd34',
        '?code=ab12#password=cd34', '?pwd=badbadbadbadbadbad',
        `?n=${'n'.repeat(2100)}`
    ]);
}

function createAtom() {
    switch (random(11)) {
        case 0:
        case 1:
        case 2:
            return createUrl();
        case 3:
            return `<a href="${createUrl()}">点击下载</a>`;
        case 4:
            return `<a href='${createUrl()}'><strong>${createUrl()}</strong></a>`;
        case 5:
            return createUrl().replaceAll('/', '\\/');
        case 6:
            return pick(labels) + pick(['：', ':', '=', ' ', '']) + pick(codes);
        case 7:
            return `${pick(labels)}：${pick(codes)} ${pick(labels)}：${pick(codes)}`;
        case 8:
            return pick([
                '<div>', '<footer>', '<script>', '<meta name="',
                '</tr><tr>', '<p>', '</p>', '</td><td>'
            ]);
        case 9:
            return `https%3a//pan.quark.cn/s/${pick(tokens)}\\n密码${pick(codes)}`;
        default:
            return pick([
                '&lt;p&gt;', '&#x20;', '&#10;', '\\u5bc6\\u7801',
                '中文说明', '百度网盘', '<', '<'.repeat(30), ''
            ]);
    }
}

function createPage(index) {
    let text = '';
    const count = index % 200 === 0 ? 180 : 1 + random(35);
    for (let atom = 0; atom < count; atom++) text += pick(separators) + createAtom();
    if (index % 200 === 0) text += 'https://pan.quark.cn/s/alpha?pwd=late1';
    if (index % 2000 === 0) {
        // Ensure both finite production caps are crossed before later duplicate
        // evidence arrives. Random token reuse alone would not reach 100 URLs.
        for (let token = 0; token < 150; token++) {
            text += `<p>https://pan.quark.cn/s/cap-${token}?pwd=${pick(codes)}</p>`;
        }
        text += '<p>https://pan.quark.cn/s/cap-0?pwd=changed1</p>'
            + '<p>https://pan.quark.cn/s/cap-99?pwd=changed2</p>';
    }
    return text;
}

let comparisons = 0;
let largestInputBytes = 0;
const started = performance.now();
const inputHash = createHash('sha256');
for (let index = 0; index < CASE_COUNT; index++) {
    const text = createPage(index);
    largestInputBytes = Math.max(largestInputBytes, Buffer.byteLength(text));
    inputHash.update(text);
    for (const cap of caps) {
        const before = baseline.parse(text, cap);
        const after = current.parse(text, cap);
        try {
            assert.deepEqual(after, before);
        } catch {
            const fixturePath = join(tmpdir(), 'iplay-resource-parser-differential-failure.json');
            await writeFile(fixturePath, `${JSON.stringify({
                index, cap: String(cap), seed: seed >>> 0, text, before, after
            }, null, 2)}\n`);
            throw new Error(`Parser differential mismatch at case ${index}, cap ${cap}. Fixture: ${fixturePath}`);
        }
        comparisons++;
    }
}

const inputsSha256 = inputHash.digest('hex');
assert.equal(inputsSha256, EXPECTED_INPUT_SHA256, 'the deterministic input corpus must remain reproducible');
const report = {
    profile: 'Independent deterministic old-v17 versus current private parser differential; no network',
    baselineRef,
    nodeVersion: process.version,
    initialSeed: '0x10202026',
    generator: 'xorshift32; URL/password/HTML/foreign-provider/escape tokens; 30000 generated pages',
    cases: CASE_COUNT,
    caps: caps.map(String),
    comparisons,
    mismatches: 0,
    largestInputBytes,
    durationMs: performance.now() - started,
    inputsSha256,
    sourceSha256: { baseline: baseline.sha, current: current.sha }
};
if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
