// Print the LIVE Vercel status of an agentbox box, matched by its
// `agentbox.name` tag (set in backend.provision). Used by the live e2e harness
// (scripts/vercel-live-e2e.sh).
//
// WHY this is needed: `agentbox list` reports cloud boxes as optimistically
// 'running' with no live SDK probe (sandbox-docker/src/lifecycle.ts — "tracked
// for Phase 6"), so it can never observe a stopped/paused cloud box. A
// stop/resume test must read the provider directly.
//
// Lives under test/ (not scripts/) so it isn't mistaken for a box runtime asset
// and so `@vercel/sandbox` resolves from the package's node_modules. vitest
// ignores it (discovery is *.test.ts).
//
// Usage: VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
//          node packages/sandbox-vercel/test/live-state.mjs <box-name>
// Prints one of: running | stopping | stopped | pending | snapshotting | absent
import { Sandbox } from '@vercel/sandbox';

const creds = {
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
};
const want = process.argv[2];
if (!want) {
  process.stderr.write('usage: live-state.mjs <box-name>\n');
  process.exit(2);
}
const page = await Sandbox.list({ ...creds });
const items = await page.toArray();
const hit = items.find((sb) => (sb.tags?.['agentbox.name'] ?? sb.name) === want);
process.stdout.write(hit ? String(hit.status) : 'absent');
