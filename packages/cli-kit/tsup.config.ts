import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // Both are optional, native, and reached through a guarded dynamic import.
  // Listing them keeps esbuild from walking node-pty's prebuilt-binary probing
  // (`../build/Debug/pty.node`), which is not resolvable at build time and is
  // never meant to be bundled — the same reason `apps/cli/tsup.config.ts`
  // externalizes them.
  external: ['@homebridge/node-pty-prebuilt-multiarch', '@xterm/headless'],
});
