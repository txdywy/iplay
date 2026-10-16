import assert from 'node:assert/strict';
import { unstable_readConfig as readConfig } from 'wrangler';

// These are production policy assertions, not a second runtime configuration.
// Miniflare must receive the values Wrangler will actually deploy.
export function loadProductionRuntimeConfig(configPath) {
    const config = readConfig({ config: configPath }, { hideWarnings: true });
    assert.equal(config.vars.ENVIRONMENT, 'production', 'Worker configuration must enable production safeguards');
    assert.equal(config.keep_vars, true, 'Production deployment must preserve optional Dashboard variables');
    const ratelimits = Object.fromEntries(config.ratelimits.map(binding => [binding.name, binding]));
    for (const [name, namespace, limit] of [
        ['API_RATE_LIMITER', '1001', 60],
        ['RESOURCE_RATE_LIMITER', '1002', 10]
    ]) {
        const binding = ratelimits[name];
        assert.ok(binding, `Production configuration is missing ${name}`);
        assert.equal(binding.namespace_id, namespace, `${name}: preserve the production counter namespace`);
        assert.equal(binding.simple.limit, limit, `${name}: unexpected production quota`);
        assert.equal(binding.simple.period, 60, `${name}: unexpected production quota period`);
    }
    assert.ok(config.main, 'Production configuration must specify a Worker entry point');
    assert.ok(config.compatibility_date, 'Production configuration must specify its compatibility date');
    return {
        main: config.main,
        bindings: config.vars,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        ratelimits
    };
}
