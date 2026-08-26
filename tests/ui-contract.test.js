import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('static shell keeps project-site assets relative and exposes recovery regions', () => {
    assert.match(indexHtml, /href="\.\/favicon\.ico"/);
    assert.match(indexHtml, /href="\.\/css\/output\.css"/);
    assert.match(indexHtml, /id="candidatePicker"/);
    assert.match(indexHtml, /id="retrySearchButton"/);
    assert.match(indexHtml, /id="dataNotice"/);
    assert.match(indexHtml, /id="searchButton"[^>]*>[\s\S]*?<svg/);
});

test('decorative icons are hidden from screen readers and toast does not block clicks', () => {
    const iconTags = [...indexHtml.matchAll(/<i\b[^>]*>/g)].map(match => match[0]);
    assert.ok(iconTags.length > 0);
    assert.ok(iconTags.every(tag => /aria-hidden="true"/.test(tag)));
    assert.match(indexHtml, /id="toast"[^>]*pointer-events-none/);
});
