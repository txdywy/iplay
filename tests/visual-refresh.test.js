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

test('the cast and facts include a desktop heading and a mobile disclosure', () => {
    assert.match(html, /<details id="profilePanel" class="card-row profile-panel">/);
    assert.match(html, /<summary class="disclosure">演职员与作品资料<\/summary>/);
    assert.match(html, /<h3 class="profile-heading"[^>]*>演职员与作品资料<\/h3>/);
    assert.match(main, /role\.textContent = `饰 \$\{character\}`/);
    assert.match(main, /img\.loading = 'lazy'/);
    assert.match(main, /'Returning Series': '连载中'/);
});

test('resource links are numbered, remember being opened and can hide opened ones', () => {
    assert.match(html, /id="resourceToolbar" class="res-toolbar" role="group" aria-label="资源筛选" hidden/);
    assert.match(html, /data-resource-filter="unopened" aria-pressed="false">只看未打开</);
    assert.match(html, /id="resourceClearOpened"/);
    assert.match(main, /position\.textContent = String\(item\._position\)\.padStart\(2, '0'\)/);
    assert.match(main, /safeItems\.filter\(item => !openedLinks\.has\(item\.url\)\)/);
    assert.match(main, /link\.addEventListener\('auxclick'/);
    assert.match(main, /const RESOURCE_FILTER_KEY = 'iplay_resource_filter'/);
    assert.doesNotMatch(main, /trackOpened/);
    assert.match(css, /\.is-opened \.link-opened \{\s*display: inline-block;/);
});
