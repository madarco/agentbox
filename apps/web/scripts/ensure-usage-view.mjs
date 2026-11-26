// Build/dev prestep: Vercel builds only this app (`next build`), so the workspace
// package's dist is missing there. Build it when absent or older than its sources;
// after turbo's `^build` it is current, so this never rebuilds under other packages
// reading that dist.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/usage-view');
const outputs = ['dist/index.js', 'dist/react.js', 'dist/usage.css'].map((f) => join(pkg, f));

const newest = (dir) =>
  Math.max(
    ...readdirSync(dir, { withFileTypes: true }).map((e) =>
      e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs,
    ),
  );

const built = outputs.every((f) => existsSync(f));
const stale =
  built && Math.min(...outputs.map((f) => statSync(f).mtimeMs)) < newest(join(pkg, 'src'));
if (!built || stale) {
  console.log(`[ensure-usage-view] building @agentbox/usage-view (${built ? 'stale' : 'missing'})`);
  execFileSync('pnpm', ['run', 'build'], { cwd: pkg, stdio: 'inherit' });
}
