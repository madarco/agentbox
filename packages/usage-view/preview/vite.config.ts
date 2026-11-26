import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-only preview of the components on the fixture: `pnpm --filter @agentbox/usage-view preview`.
// Not part of the package build; tsup only bundles src/.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
});
