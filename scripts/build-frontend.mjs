import { build } from 'esbuild';
import { fileURLToPath, URL } from 'node:url';

await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['js/main.js'],
    outfile: 'assets/app.min.js',
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    charset: 'utf8',
    logLevel: 'info'
});
