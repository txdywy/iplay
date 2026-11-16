// Ambient colour: the page's stage light takes the hue of the work's poster,
// the way streaming apps tint their detail pages.

const DEFAULT_AMBIENT = Object.freeze({ hue: 55, chroma: 0.12 });

function toLinear(channel) {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// sRGB (0-255) to OKLCH: lightness 0-1, chroma, hue in degrees.
export function rgbToOklch(r, g, b) {
    const lr = toLinear(r);
    const lg = toLinear(g);
    const lb = toLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const hue = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
    return { lightness: L, chroma: Math.hypot(A, B), hue };
}

// Picks the poster's most prominent vivid hue from RGBA pixels. Pixels are
// weighted by squared chroma and by how far they sit from black and white, so
// a coloured subject wins over a large dark background. A near-greyscale image
// keeps the default warm light.
export function pickAmbientColor(pixels) {
    if (!pixels || typeof pixels.length !== 'number' || pixels.length < 4) return { ...DEFAULT_AMBIENT };
    const bins = Array.from({ length: 24 }, () => ({ weight: 0, x: 0, y: 0, chroma: 0 }));
    let total = 0;
    for (let index = 0; index + 3 < pixels.length; index += 4) {
        if (pixels[index + 3] < 128) continue;
        const { lightness, chroma, hue } = rgbToOklch(pixels[index], pixels[index + 1], pixels[index + 2]);
        if (lightness < 0.18 || lightness > 0.95 || chroma < 0.035) continue;
        // Squared chroma lets the most vivid colour beat a larger muted one.
        const weight = chroma * chroma * (1 - Math.abs(lightness - 0.6) * 1.4);
        if (weight <= 0) continue;
        const bin = bins[Math.floor(hue / 15) % 24];
        const radians = hue * Math.PI / 180;
        bin.weight += weight;
        bin.x += Math.cos(radians) * weight;
        bin.y += Math.sin(radians) * weight;
        bin.chroma += chroma * weight;
        total += weight;
    }
    const pixelCount = pixels.length / 4;
    // Too little colour to call: keep the house light.
    if (total / pixelCount < 0.00012) return { ...DEFAULT_AMBIENT };

    // Neighbouring bins count towards a peak so a hue split across a bin edge
    // still wins.
    let best = 0;
    let bestScore = -1;
    bins.forEach((bin, index) => {
        const score = bin.weight + 0.5 * (bins[(index + 23) % 24].weight + bins[(index + 1) % 24].weight);
        if (score > bestScore) {
            bestScore = score;
            best = index;
        }
    });
    const peak = [bins[(best + 23) % 24], bins[best], bins[(best + 1) % 24]];
    const weight = peak.reduce((sum, bin) => sum + bin.weight, 0);
    const x = peak.reduce((sum, bin) => sum + bin.x, 0);
    const y = peak.reduce((sum, bin) => sum + bin.y, 0);
    const chroma = peak.reduce((sum, bin) => sum + bin.chroma, 0) / weight;
    return {
        hue: Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360),
        // The light is a tint, never a neon wash.
        chroma: Math.round(Math.min(0.16, Math.max(0.05, chroma)) * 1000) / 1000
    };
}

export { DEFAULT_AMBIENT };
