import { defineConfig } from 'tsup';

const shared = {
    format: ['esm', 'cjs'] as const,
    dts: true,
    sourcemap: true,
    minify: true,
    target: 'es2019',
    treeshake: true,
};

export default defineConfig([
    {
        ...shared,
        entry: {
            index: 'src/index.ts',
            ui: 'src/ui/index.ts',
            excalidraw: 'src/excalidraw/index.ts',
            sync: 'src/sync/index.ts',
        },
    },
    {
        ...shared,
        entry: { react: 'src/react/index.tsx' },
        // Rollup tree-shaking strips the banner below; this entry is tiny anyway.
        treeshake: false,
        external: ['react', 'react-dom', 'liteboard', 'liteboard/ui', 'liteboard/sync'],
        // Next.js app router needs the directive on the client component.
        banner: { js: "'use client';" },
    },
]);
