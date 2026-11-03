import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^liteboard\/ui$/, replacement: src('ui/index.ts') },
            { find: /^liteboard\/react$/, replacement: src('react/index.tsx') },
            { find: /^liteboard\/sync$/, replacement: src('sync/index.ts') },
            { find: /^liteboard\/excalidraw$/, replacement: src('excalidraw/index.ts') },
            { find: /^liteboard$/, replacement: src('index.ts') },
        ],
    },
    server: { port: 5199, host: true },
});
