import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    external: ['uWebSockets.js', 'pg'],
});
