import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The overlay record must only advance once the WHOLE render succeeded — the
 * patch AND `validate`.
 *
 * The bug: the record was written straight after a successful patch, before the
 * gate ran. So a failed `validate` left the record already advanced, and the
 * NEXT render saw no overlay diff, returned early at "no overlay changes since
 * the last apply", and never re-ran the gate. A failed first gate silently
 * became a success, with the tool's invalid config still in place.
 *
 * The sequence below is exactly that: render -> validate fails -> render again
 * with an unchanged overlay -> must still fail.
 *
 * Real subprocesses (the tool is a shell script in a tmpdir), no network: the
 * descriptor normally arrives over `agents.list`, which is stubbed.
 */

const fetchAgentDescriptorsOrThrow = vi.fn();
vi.mock('../src/agent-registry.js', () => ({ fetchAgentDescriptorsOrThrow }));

const { agentCommand } = await import('../src/commands/agent-render.js');

let dir: string;
let configPath: string;
let toolConfig: string;
let recordPath: string;
/** Flipped by the test to make the tool's `validate` pass or fail. */
let validateFlag: string;

/**
 * A minimal stand-in for a real tool: `patch` merges stdin into its own JSON
 * file, `validate` passes or fails depending on a control file the test owns.
 */
function writeTool(): string {
  const tool = join(dir, 'tool');
  writeFileSync(
    tool,
    `#!/usr/bin/env node
const fs = require('node:fs');
const FILE = ${JSON.stringify(toolConfig)};
const FLAG = ${JSON.stringify(validateFlag)};
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (b, p) => {
  const out = { ...b };
  for (const [k, v] of Object.entries(p)) {
    if (v === null) { delete out[k]; continue; }
    if (isObj(v) && isObj(out[k])) { out[k] = merge(out[k], v); continue; }
    out[k] = v;
  }
  return out;
};
const argv = process.argv.slice(2);
if (argv[0] === 'patch') {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    const next = merge(read(), JSON.parse(raw));
    if (!argv.includes('--dry-run')) fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    console.log('patched');
    process.exit(0);
  });
} else if (argv[0] === 'validate') {
  if (fs.readFileSync(FLAG, 'utf8').trim() === 'fail') {
    console.error('tool: config rejected');
    process.exit(7);
  }
  console.log('tool: config valid');
  process.exit(0);
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  chmodSync(tool, 0o755);
  return tool;
}

/** Run `agentbox-ctl agent render <agent>` in-process. */
function render(...extra: string[]): Promise<unknown> {
  return agentCommand.parseAsync(
    ['render', 'demo', '--config', configPath, '--state-dir', dir, ...extra],
    { from: 'user' },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-render-gate-'));
  configPath = join(dir, 'agentbox.yaml');
  toolConfig = join(dir, 'tool.json');
  recordPath = join(dir, '.agentbox-overlay.json');
  validateFlag = join(dir, 'validate-flag');
  writeFileSync(validateFlag, 'fail\n');
  writeFileSync(toolConfig, JSON.stringify({ gateway: { port: 1 } }, null, 2));
  writeFileSync(configPath, 'demo:\n  gateway:\n    port: 8080\n');
  const tool = writeTool();
  fetchAgentDescriptorsOrThrow.mockResolvedValue({
    files: [],
    sessions: [],
    units: [],
    renders: [
      {
        agent: 'demo',
        file: toolConfig,
        overlayKey: 'demo',
        applyCmd: `${tool} patch`,
        dryRunFlag: '--dry-run',
        validate: `${tool} validate`,
      },
    ],
  });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('agent render — the overlay record only advances past a passing gate', () => {
  it('a failed validate does not record, so an unchanged overlay re-runs the gate', async () => {
    // 1. First render: the patch lands, then `validate` fails.
    await expect(render()).rejects.toThrow(/validate failed/);
    // The patch really was applied — this is not a "nothing happened" case.
    expect(JSON.parse(readFileSync(toolConfig, 'utf8')).gateway.port).toBe(8080);
    // THE FIX: no record, because the render as a whole did not succeed.
    expect(existsSync(recordPath), 'record must not advance past a failed gate').toBe(false);

    // 2. Second render, overlay UNCHANGED. The bug made this return early with
    //    "no overlay changes since the last apply" and exit 0.
    await expect(render()).rejects.toThrow(/validate failed/);
    expect(existsSync(recordPath)).toBe(false);

    // 3. Fix whatever validate was unhappy about; the same render now completes
    //    and only NOW is the overlay recorded.
    writeFileSync(validateFlag, 'pass\n');
    await render();
    expect(existsSync(recordPath), 'a fully successful render must record').toBe(true);
    expect(JSON.parse(readFileSync(recordPath, 'utf8')).overlay).toEqual({
      gateway: { port: 8080 },
    });
  });

  it('once recorded, an unchanged overlay is a no-op — the early return still works', async () => {
    writeFileSync(validateFlag, 'pass\n');
    await render();
    const first = readFileSync(recordPath, 'utf8');

    // Make the tool's validate fail. A second render must NOT run it, because
    // there is genuinely nothing to apply — the early return is the whole point
    // of the record and must survive the fix.
    writeFileSync(validateFlag, 'fail\n');
    await expect(render()).resolves.toBeDefined();
    expect(readFileSync(recordPath, 'utf8')).toBe(first);
  });

  it('--skip-validate records: the user opted out of the gate, not out of the render', async () => {
    writeFileSync(validateFlag, 'fail\n');
    await render('--skip-validate');
    expect(existsSync(recordPath)).toBe(true);
  });

  it('a failed patch records nothing either — the pre-existing half of the rule', async () => {
    // The dry-run gate rejects before anything is written; nothing to record.
    writeFileSync(configPath, 'demo: not-a-mapping\n');
    await expect(render()).rejects.toThrow(/must be a mapping/);
    expect(existsSync(recordPath)).toBe(false);
  });
});
