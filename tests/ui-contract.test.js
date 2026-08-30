import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const mainJs = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');

test('static shell keeps project-site assets relative and exposes recovery regions', () => {
    assert.match(indexHtml, /href="\.\/favicon\.ico"/);
    assert.match(indexHtml, /href="\.\/css\/output\.css"/);
    assert.match(indexHtml, /id="candidatePicker"/);
    assert.match(indexHtml, /id="retrySearchButton"/);
    assert.match(indexHtml, /id="errorHint"/);
    assert.match(indexHtml, /id="dataNotice"/);
    assert.match(indexHtml, /id="resourcesSection"/);
    assert.match(indexHtml, /id="resourcesNotice"/);
    assert.match(indexHtml, /id="showCover"[^>]*width="400"[^>]*height="600"[^>]*loading="eager"[^>]*decoding="async"[^>]*fetchpriority="high"/);
    assert.match(indexHtml, /id="searchButton"[^>]*>[\s\S]*?<svg/);
});

test('inline decorative icons are hidden from screen readers and external icon fonts are absent', () => {
    const iconTags = [...indexHtml.matchAll(/<svg\b[^>]*>/g)].map(match => match[0]);
    assert.ok(iconTags.length > 0);
    assert.ok(iconTags.every(tag => /aria-hidden="true"/.test(tag)));
    assert.doesNotMatch(indexHtml, /font-awesome|cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/i);
    assert.match(indexHtml, /id="toast"[^>]*pointer-events-none/);
});

test('result enrichment keeps the critical path independent from resource scanning', () => {
    assert.match(mainJs, /scheduleResourceLoad\(candidate, searchId, searchOptions, loadId\)/);
    assert.match(mainJs, /OmdbAPI\.getById\(imdbId, searchOptions\)/);
    assert.match(mainJs, /OmdbAPI\.search\(enrichmentQuery, candidate\.year, searchOptions\)/);
    assert.match(mainJs, /new AbortController\(\)/);
    assert.match(mainJs, /资源扫描部分完成/);
    assert.match(mainJs, /海报加载失败，正在查找备用海报/);
    const enrichmentBlock = mainJs.slice(mainJs.indexOf('function startEnrichments'), mainJs.indexOf('async function loadCandidateDetails'));
    assert.doesNotMatch(enrichmentBlock, /loadResources\(/);
    assert.doesNotMatch(mainJs, /document\.createElement\('i'\)/);
});
