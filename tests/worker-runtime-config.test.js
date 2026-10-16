import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProductionRuntimeConfig } from './helpers/worker-runtime-config.js';

const configUrl = new URL('../wrangler.toml', import.meta.url);
const productionSource = await readFile(configUrl, 'utf8');

async function withConfig(t, source, run) {
    const directory = await mkdtemp(join(tmpdir(), 'iplay-runtime-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'wrangler.toml');
    await writeFile(path, source);
    return run(path);
}

test('native runtime consumes the deployed Wrangler entry point, bindings and compatibility target', () => {
    const config = loadProductionRuntimeConfig(fileURLToPath(configUrl));
    assert.equal(config.main, fileURLToPath(new URL('../worker/_worker.js', import.meta.url)));
    assert.equal(config.bindings.ENVIRONMENT, 'production');
    assert.equal(config.ratelimits.API_RATE_LIMITER.name, 'API_RATE_LIMITER');
    assert.equal(config.ratelimits.RESOURCE_RATE_LIMITER.name, 'RESOURCE_RATE_LIMITER');
});

test('a changed compatibility target reaches the native runtime instead of a hardcoded test copy', async t => {
    await withConfig(t, productionSource.replace(/compatibility_date = "[^"]+"/, 'compatibility_date = "2026-10-16"'), path => {
        assert.equal(loadProductionRuntimeConfig(path).compatibilityDate, '2026-10-16');
    });
});

test('missing or renamed production rate-limit bindings fail before workerd starts', async t => {
    for (const name of ['API_RATE_LIMITER', 'RESOURCE_RATE_LIMITER']) {
        await withConfig(t, productionSource.replace(`name = "${name}"`, `name = "${name}_TYPO"`), path => {
            assert.throws(() => loadProductionRuntimeConfig(path), new RegExp(`missing ${name}`));
        });
    }
});

test('unsafe quotas, changed counter namespaces and disabled production safeguards are rejected', async t => {
    for (const [original, replacement, message] of [
        ['limit = 60', 'limit = 600', /API_RATE_LIMITER: unexpected production quota/],
        ['limit = 10', 'limit = 100', /RESOURCE_RATE_LIMITER: unexpected production quota/],
        ['period = 60', 'period = 10', /API_RATE_LIMITER: unexpected production quota period/],
        ['namespace_id = "1001"', 'namespace_id = "9999"', /preserve the production counter namespace/],
        ['ENVIRONMENT = "production"', 'ENVIRONMENT = "development"', /enable production safeguards/],
        ['keep_vars = true', 'keep_vars = false', /preserve optional Dashboard variables/]
    ]) {
        await withConfig(t, productionSource.replace(original, replacement), path => {
            assert.throws(() => loadProductionRuntimeConfig(path), message);
        });
    }
});
