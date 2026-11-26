// Build/dev prestep: Vercel builds only this app (`next build`), so the workspace
// package's dist is missing there. Build it when absent; locally turbo's `^build`
// already did, and rebuilding here would race other packages reading that dist.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/usage-view');
const outputs = ['dist/index.js', 'dist/react.js', 'dist/usage.css'];
if (!outputs.every((f) => existsSync(resolve(pkg, f)))) {
  console.log('[ensure-usage-view] building @agentbox/usage-view');
  execFileSync('pnpm', ['run', 'build'], { cwd: pkg, stdio: 'inherit' });
}
