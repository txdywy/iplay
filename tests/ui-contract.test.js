import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { RELEASE_VERSION } from '../js/release.js';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const mainJs = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
const versionFile = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lockInfo = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const jsDirectory = new URL('../js/', import.meta.url);
const moduleSources = await Promise.all((await readdir(jsDirectory))
    .filter(name => name.endsWith('.js'))
    .map(async name => ({ name, source: await readFile(new URL(name, jsDirectory), 'utf8') })));

test('static shell keeps project-site assets relative and exposes recovery regions', () => {
    assert.match(indexHtml, /href="\.\/favicon\.ico"/);
    assert.match(indexHtml, /href="\.\/css\/output\.css\?v=/);
    assert.match(indexHtml, /id="candidatePicker"/);
    assert.match(indexHtml, /id="retrySearchButton"/);
    assert.match(indexHtml, /id="errorHint"/);
    assert.match(indexHtml, /id="dataNotice"/);
    assert.match(indexHtml, /id="resourcesSection"/);
    assert.match(indexHtml, /id="resourcesNotice"/);
    assert.match(indexHtml, /id="actorResultsArea"/);
    assert.match(indexHtml, /id="actorCreditList"/);
    assert.match(indexHtml, /id="actorCandidatePicker"/);
    assert.match(indexHtml, /id="actorFilters"/);
    assert.match(indexHtml, /id="actorLoadMore"/);
    assert.match(indexHtml, /id="showCover"[^>]*width="400"[^>]*height="600"[^>]*loading="eager"[^>]*decoding="async"[^>]*fetchpriority="high"/);
    assert.match(indexHtml, /id="searchButton"[^>]*>[\s\S]*?<svg/);
});

test('release versions and cache-busted static imports stay consistent', () => {
    assert.equal(RELEASE_VERSION, versionFile);
    assert.equal(packageInfo.version, versionFile);
    assert.equal(lockInfo.version, versionFile);
    assert.equal(lockInfo.packages[''].version, versionFile);
    assert.ok(indexHtml.includes(`./css/output.css?v=${versionFile}`));
    assert.ok(indexHtml.includes(`./assets/app.min.js?v=${versionFile}`));
    const moduleNames = new Set(moduleSources.map(module => module.name));
    for (const { name, source } of moduleSources) {
        const imports = [...source.matchAll(/\b(?:from|import)\s*['"](\.\/[^'"]+)['"]/g)].map(match => match[1]);
        for (const imported of imports) {
            assert.ok(imported.endsWith(`?v=${versionFile}`), `${name}: ${imported} must use the release version`);
            assert.ok(moduleNames.has(imported.split('?')[0].slice(2)), `${name}: ${imported} must resolve to a shipped module`);
        }
    }
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
    assert.match(mainJs, /PosterAPI\.getPoster\(enrichmentQuery, candidate\.year, identity\)/);
    assert.match(mainJs, /new AbortController\(\)/);
    assert.match(mainJs, /资源扫描部分完成/);
    assert.match(mainJs, /海报加载失败，正在查找备用海报/);
    assert.match(mainJs, /TmdbAPI\.searchPerson\(query, options\)/);
    assert.match(mainJs, /dataset\.actorName = name/);
    assert.match(mainJs, /pushState\(\{ kind: 'actor'/);
    assert.match(mainJs, /addEventListener\('popstate'/);
    assert.match(mainJs, /mediaType: mediaType \|\| undefined/);
    const enrichmentBlock = mainJs.slice(mainJs.indexOf('function startEnrichments'), mainJs.indexOf('async function loadCandidateDetails'));
    assert.doesNotMatch(enrichmentBlock, /loadResources\(/);
    assert.doesNotMatch(mainJs, /document\.createElement\('i'\)/);
});
