import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2022',
    dts: true,
    sourcemap: true,
  },
  {
    entry: { react: 'src/react.tsx' },
    format: ['esm'],
    target: 'es2022',
    dts: true,
    sourcemap: true,
    external: ['react', 'react/jsx-runtime'],
    // The components hold UI state (toggles, tooltip), so Next must treat them as client code.
    banner: { js: "'use client';" },
    onSuccess: async () => {
      mkdirSync('dist', { recursive: true });
      copyFileSync('src/usage.css', 'dist/usage.css');
    },
  },
]);
