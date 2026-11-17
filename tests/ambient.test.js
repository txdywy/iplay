import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_AMBIENT, pickAmbientColor, rgbToOklch } from '../js/ambient.js';

function image(colors) {
    const pixels = new Uint8ClampedArray(colors.reduce((sum, [, count]) => sum + count, 0) * 4);
    let offset = 0;
    for (const [[r, g, b, a = 255], count] of colors) {
        for (let index = 0; index < count; index += 1) {
            pixels.set([r, g, b, a], offset);
            offset += 4;
        }
    }
    return pixels;
}

test('sRGB converts to OKLCH', () => {
    const white = rgbToOklch(255, 255, 255);
    assert.ok(Math.abs(white.lightness - 1) < 0.001);
    assert.ok(white.chroma < 0.001);
    const red = rgbToOklch(255, 0, 0);
    assert.ok(Math.abs(red.lightness - 0.628) < 0.002);
    assert.ok(Math.abs(red.chroma - 0.2577) < 0.002);
    assert.ok(Math.abs(red.hue - 29.23) < 0.2);
});

test('the ambient light takes the poster\'s most vivid hue over a dark background', () => {
    const poster = image([[[8, 10, 14], 600], [[30, 90, 200], 120], [[120, 120, 120], 100]]);
    const { hue, chroma } = pickAmbientColor(poster);
    assert.ok(hue > 240 && hue < 275, `blue hue, got ${hue}`);
    assert.ok(chroma >= 0.05 && chroma <= 0.16);
});

test('a vivid accent beats a larger muted area', () => {
    const poster = image([[[150, 170, 190], 500], [[230, 60, 160], 80]]);
    const { hue } = pickAmbientColor(poster);
    assert.ok(hue > 330 || hue < 10, `magenta hue, got ${hue}`);
});

test('greyscale, transparent and empty images keep the house light', () => {
    assert.deepEqual(pickAmbientColor(image([[[40, 40, 40], 300], [[200, 200, 200], 300]])), DEFAULT_AMBIENT);
    assert.deepEqual(pickAmbientColor(image([[[255, 0, 0, 0], 300]])), DEFAULT_AMBIENT);
    assert.deepEqual(pickAmbientColor(new Uint8ClampedArray()), DEFAULT_AMBIENT);
    assert.deepEqual(pickAmbientColor(null), DEFAULT_AMBIENT);
});

test('ambient colours support reduced motion and decorative heading labels', async () => {
    const [css, html] = await Promise.all([
        readFile('css/input.css', 'utf8'), readFile('index.html', 'utf8')
    ]);
    assert.match(css, /@property --ambient-h \{ syntax: "<number>"; inherits: true; initial-value: 55; \}/);
    assert.match(css, /transition: --ambient-h 1\.4s/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{ :root \{ transition: none; \} \}/);
    assert.match(css, /content: attr\(data-eyebrow\) \/ "";/);
    for (const eyebrow of ['SYNOPSIS', 'CAST &amp; DETAILS', 'WHERE TO WATCH', 'FOR YOU']) {
        assert.ok(html.includes(`data-eyebrow="${eyebrow}"`), eyebrow);
    }
});
