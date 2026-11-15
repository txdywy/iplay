import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, css] = await Promise.all([
    readFile('index.html', 'utf8'), readFile('js/main.js', 'utf8'), readFile('css/input.css', 'utf8')
]);

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

test('the three resource sources are told apart by colour, icon and count', () => {
    const columns = [['res-quark', 'quarkUrlList', 'quarkCount'], ['res-posts', 'resourceList', 'postsCount'], ['res-forum', 'wpzysResourceList', 'forumCount']];
    for (const [accent, list, count] of columns) {
        assert.match(html, new RegExp(`class="[^"]*res-col ${accent}"`));
        assert.match(html, new RegExp(`id="${list}" class="link-list" data-count-target="${count}"`));
        assert.match(css, new RegExp(`\\.${accent} \\{ --res-accent: oklch\\(`));
    }
    assert.equal((html.match(/class="res-badge"/g) || []).length, 3);
    assert.match(main, /iconName: 'cloud',\n\s+iconClass: 'res-icon/);
    assert.match(main, /function setResourceCount\(container, count\)/);
});

test('the cast and facts stay open on desktop with portraits and roles', () => {
    assert.match(html, /<details id="profilePanel" class="card-row profile-panel">/);
    assert.match(main, /function syncProfileDisclosure\(\)/);
    assert.match(main, /els\.profilePanel\.open = stickyHeaderMedia\.matches/);
    assert.match(main, /role\.textContent = `饰 \$\{character\}`/);
    assert.match(main, /img\.loading = 'lazy'/);
    assert.match(main, /'Returning Series': '连载中'/);
    assert.match(css, /\.profile-panel\.is-pinned > \.disclosure::after \{ display: none; \}/);
    assert.match(css, /\.cast-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});
