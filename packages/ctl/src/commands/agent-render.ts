/**
 * `agentbox-ctl agent render <id>` — push the user's `agentbox.yaml` overlay
 * into a service agent's own config file, THROUGH THE TOOL'S OWN patch command.
 *
 * IN-BOX, not host-side, for two reasons: it is then provider-uniform (nothing
 * has to be reimplemented per backend), and it can be a `tasks:` unit that
 * re-runs on `agentbox-ctl reload` — which is what makes editing the overlay in
 * `agentbox.yaml` a live operation rather than a re-create.
 *
 * The merge is NOT ours. A tool that ships `config patch --stdin` already
 * performs a validated recursive merge on its own file, knows its own format and
 * keeps working across its own config migrations. ctl only decides WHAT to send:
 *
 *   1. read the `<overlayKey>:` block out of agentbox.yaml (opaque — ctl does
 *      not know the tool's schema; the tool's `validate` is the real gate),
 *   2. diff it against `.agentbox-overlay.json`, the overlay as last applied,
 *   3. dry-run the patch, then apply it,
 *   4. run `validate` as the final gate, and record the overlay only once BOTH
 *      halves passed — the record means "fully applied and valid", so a failed
 *      gate re-runs on the next render instead of being skipped as a no-op.
 *
 * Step 2 is what makes an in-box hand edit survive: a key the user did not touch
 * in `agentbox.yaml` is not in the patch, so the tool never revisits it.
 *
 * `{{AGENTBOX_*}}` placeholders and `{{AGENTBOX_AUTO_SECRET:name}}` tokens are
 * resolved in the overlay before it is sent, sharing the exact engine
 * `agentbox-ctl render` uses — a second substitution implementation would be a
 * second set of rules to learn.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { fetchAgentDescriptorsOrThrow, type AgentRenderDescriptor } from '../agent-registry.js';
import { lintOverlaySecrets, overlayPatch, type JsonValue } from '../overlay-diff.js';
import { applyReplacements, placeholderContextFromEnv } from '../replace.js';
import { resolveAutoSecrets } from '../secret.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_DIR } from '../types.js';

/**
 * Record of the overlay AS LAST APPLIED **AND VALIDATED** — the diff's other side.
 *
 * The "and validated" half is load-bearing: the record is what makes a render
 * with an unchanged overlay a no-op, so writing it after a patch but before the
 * gate turned a failed `validate` into a permanent silent pass.
 *
 * Next to the tool's own config file rather than in ctl's state dir: it is only
 * meaningful paired with that file, so a checkpoint or a config-volume copy that
 * carries one carries the other. Losing it is not fatal — the next render simply
 * re-asserts the whole overlay, which is the safe direction.
 */
const RECORD_NAME = '.agentbox-overlay.json';

interface OverlayRecord {
  schema: 1;
  agent: string;
  appliedAt: string;
  /** The overlay exactly as it was sent, after token resolution. */
  overlay: JsonValue;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Resolve `{{AGENTBOX_*}}` and `{{AGENTBOX_AUTO_SECRET:…}}` in the overlay text. */
async function resolveTokens(
  text: string,
  stateDir: string,
  warn: (m: string) => void,
): Promise<string> {
  const replaced = applyReplacements(text, {
    env: true,
    rules: [],
    context: placeholderContextFromEnv(),
    onWarn: warn,
  });
  return resolveAutoSecrets(replaced, { stateDir, onLog: warn });
}

interface RunResult {
  code: number;
  output: string;
}

/** Run a shell command, optionally feeding it stdin, and collect both streams. */
function run(command: string, cwd: string, stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', (err) => resolve({ code: 127, output: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: out }));
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
  });
}

/**
 * Read the overlay block, with its tokens resolved and its secrets linted.
 *
 * The block is re-serialized to JSON before token resolution so the substitution
 * engine sees one text the way it does for every other render, and the yaml's
 * own quoting never leaks into a value.
 */
async function readOverlay(
  desc: AgentRenderDescriptor,
  configPath: string,
  stateDir: string,
  warn: (m: string) => void,
): Promise<JsonValue> {
  const yamlText = await readIfPresent(configPath);
  if (yamlText === null) return {};
  const doc = parseYaml(yamlText) as Record<string, unknown> | null;
  const raw = doc?.[desc.overlayKey];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${configPath}: ${desc.overlayKey} must be a mapping`);
  }
  const resolved = await resolveTokens(JSON.stringify(raw), stateDir, warn);
  const overlay = JSON.parse(resolved) as JsonValue;
  for (const path of lintOverlaySecrets(overlay)) {
    warn(
      `${desc.overlayKey}.${path} looks like a literal secret. agentbox.yaml is committed — ` +
        `carry the value into the box with a \`carry:\` entry (0600 env file) and reference it by name instead.`,
    );
  }
  return overlay;
}

interface RenderOptions {
  config: string;
  stateDir: string;
  dryRun?: boolean;
  force?: boolean;
  skipValidate?: boolean;
}

const renderSubcommand = new Command('render')
  .description(
    "Apply the agentbox.yaml overlay to a service agent's config through the " +
      "agent's own patch command (only the keys the overlay changed).",
  )
  .argument('<agent>', 'agent id, as `agents.list` reports it')
  .option('--config <path>', 'agentbox.yaml to read the overlay block from', DEFAULT_CONFIG_PATH)
  .option(
    '--state-dir <path>',
    'where named {{AGENTBOX_AUTO_SECRET:x}} secrets persist',
    DEFAULT_STATE_DIR,
  )
  .option('--dry-run', 'print the patch and run the agent’s own check, but write nothing')
  .option('--force', 're-send the whole overlay, ignoring the last-applied record')
  .option('--skip-validate', "don't run the agent's validate command")
  .action(async (agent: string, opts: RenderOptions) => {
    const warn = (m: string): void =>
      void process.stderr.write(`agentbox-ctl agent render: ${m}\n`);
    const say = (m: string): void => void process.stdout.write(`agentbox-ctl agent render: ${m}\n`);

    const { renders } = await fetchAgentDescriptorsOrThrow();
    const desc = renders.find((r) => r.agent === agent);
    if (!desc) {
      throw new Error(
        `agent "${agent}" declares no configRender (known: ${renders.map((r) => r.agent).join(', ') || 'none'})`,
      );
    }

    const overlay = await readOverlay(desc, opts.config, opts.stateDir, warn);

    const recordPath = join(dirname(desc.file), RECORD_NAME);
    let previous: JsonValue | undefined;
    if (!opts.force) {
      const recordText = await readIfPresent(recordPath);
      if (recordText !== null) {
        try {
          previous = (JSON.parse(recordText) as OverlayRecord).overlay;
        } catch {
          warn(`${recordPath} is unreadable; re-applying the whole overlay`);
        }
      }
    }

    const { patch, paths, removed } = overlayPatch(previous, overlay);
    if (paths.length === 0) {
      say(`${desc.overlayKey}: no overlay changes since the last apply`);
      return;
    }
    const payload = JSON.stringify(patch, null, 2);
    const cwd = dirname(desc.file);

    if (opts.dryRun) process.stdout.write(payload + '\n');

    // The dry run is a gate, not a preview: it is what stops a malformed overlay
    // from being half-written into the tool's own config.
    if (desc.dryRunFlag) {
      const check = await run(`${desc.applyCmd} ${desc.dryRunFlag}`, cwd, payload);
      if (check.code !== 0) {
        throw new Error(
          `${desc.applyCmd} ${desc.dryRunFlag} rejected the overlay (exit ${String(check.code)}):\n${check.output.trim()}`,
        );
      }
    }
    if (opts.dryRun) {
      say(`would apply ${String(paths.length)} key(s): ${paths.join(', ')}`);
      return;
    }

    const applied = await run(desc.applyCmd, cwd, payload);
    if (applied.code !== 0) {
      throw new Error(
        `${desc.applyCmd} failed (exit ${String(applied.code)}):\n${applied.output.trim()}`,
      );
    }
    if (applied.output.trim().length > 0) process.stdout.write(applied.output);
    say(
      `${desc.file}: applied ${String(paths.length)} key(s)` +
        (removed.length > 0 ? ` (${String(removed.length)} removed)` : '') +
        `: ${paths.join(', ')}`,
    );

    if (desc.validate && !opts.skipValidate) {
      const { code, output } = await run(desc.validate, cwd);
      if (code !== 0) {
        // Loud and fatal: a service that starts on an invalid config fails later,
        // in a log nobody is watching.
        //
        // Thrown BEFORE the record is written, on purpose. Advancing it here
        // would make the next render see no overlay diff, return early, and
        // never re-run validate — a failed gate quietly becoming a success with
        // the invalid config still in place. Leaving the record behind costs one
        // idempotent re-send of the same patch and re-runs the gate every time
        // until it passes.
        throw new Error(
          `validate failed (\`${desc.validate}\` exited ${String(code)}):\n${output.trim()}`,
        );
      }
    }

    // LAST, and only once the whole render succeeded — the patch AND the gate.
    // The record's meaning is "this overlay is fully applied and valid"; anything
    // weaker makes the early-return above skip work that still needs doing.
    //
    // A re-send after a failed gate re-asserts keys the overlay names, so a hand
    // fix to one of THOSE keys is overwritten. That is the same direction a lost
    // record takes, and the alternative — trusting a config that failed its own
    // validator — is worse.
    const record: OverlayRecord = {
      schema: 1,
      agent,
      appliedAt: new Date().toISOString(),
      overlay,
    };
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  });

export const agentCommand = new Command('agent')
  .description('Per-agent in-box operations')
  .addCommand(renderSubcommand);
