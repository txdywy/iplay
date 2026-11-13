import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, css] = await Promise.all([
    readFile('index.html', 'utf8'), readFile('js/main.js', 'utf8'), readFile('css/input.css', 'utf8')
]);

test('the detail hero is lit by the work\'s still through CSS variables, not inline HTML styles', () => {
    assert.match(html, /<div id="heroBackdrop" class="hero-backdrop" aria-hidden="true"><\/div>/);
    assert.match(main, /heroBackdrop\.style\.setProperty\('--hero-image', `url\("\$\{image\}"\)`\)/);
    assert.match(main, /const still = toSafeHttpUrl\(viewModel\?\.detail\?\.backdrop\)/, 'only http(s) URLs reach the stylesheet');
    assert.doesNotMatch(html, /\sstyle="/, 'the CSP forbids inline style attributes');
});

test('the score ring keeps the existing score elements and adds a tier', () => {
    assert.match(html, /id="scoreRing" class="score-ring">\s*<span id="recScore"/);
    assert.match(html, /id="recBar"/);
    assert.match(main, /scoreRing\.dataset\.tier = /);
    assert.match(css, /conic-gradient\(var\(--ring\) calc\(var\(--score, 0\) \* 360deg\)/);
});

test('motion is optional and the sticky bar never overflows the page', () => {
    assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{ @supports \(animation-timeline: view\(\)\)/);
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(declarations, /100vw/, '100vw includes a classic scrollbar and causes horizontal overflow');
    assert.doesNotMatch(css, /^html \{[^}]*scroll-behavior: smooth/m, 'scripted scrolls choose their own behaviour');
});
