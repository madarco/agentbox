import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOX_CLAUDE_PLANS_DIR, resolvePlanTeleport } from '../src/session-teleport/plan.js';
import { TeleportError } from '../src/session-teleport/types.js';

const HOST_CWD = '/Users/marco/Projects/AgentBox/agentbox';

describe('resolvePlanTeleport', () => {
  it('errors when the plan file does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plan-test-'));
    await expect(
      resolvePlanTeleport({
        planPath: join(home, '.claude', 'plans', 'missing.md'),
        hostCwd: HOST_CWD,
        hostHome: home,
      }),
    ).rejects.toBeInstanceOf(TeleportError);
  });

  it('stages the plan and rewrites the host workspace path to /workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plan-test-'));
    const plansDir = join(home, '.claude', 'plans');
    await mkdir(plansDir, { recursive: true });
    const planFile = join(plansDir, 'my-plan.md');
    await writeFile(
      planFile,
      `# Plan\n\nEdit ${HOST_CWD}/apps/cli/src/commands/fork.ts and run tests.\n`,
      'utf8',
    );

    const r = await resolvePlanTeleport({
      planPath: '~/.claude/plans/my-plan.md',
      hostCwd: HOST_CWD,
      hostHome: home,
    });

    expect(r.agent).toBe('claude');
    expect(r.sessionId).toBe('my-plan.md');
    expect(r.boxParentDir).toBe(BOX_CLAUDE_PLANS_DIR);
    expect(r.boxPath).toBe(`${BOX_CLAUDE_PLANS_DIR}/my-plan.md`);
    expect(r.forwardArgs).toEqual([]);

    const staged = await readFile(r.hostFile, 'utf8');
    expect(staged).toContain('/workspace/apps/cli/src/commands/fork.ts');
    expect(staged).not.toContain(HOST_CWD);
  });

  it('resolves a relative hostCwd to absolute so it does not double the rewrite', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plan-test-'));
    const planFile = join(home, 'rel-plan.md');
    const absCwd = process.cwd();
    await writeFile(planFile, `Edit ${absCwd}/src/foo.ts.\n`, 'utf8');

    // Pass the workspace as a path relative to process.cwd() (here: '.').
    const r = await resolvePlanTeleport({ planPath: planFile, hostCwd: '.', hostHome: home });

    const staged = await readFile(r.hostFile, 'utf8');
    expect(staged).toBe('Edit /workspace/src/foo.ts.\n');
    expect(staged).not.toContain('//workspace');
  });

  it('accepts an absolute path and copies content verbatim when no host path appears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plan-test-'));
    const planFile = join(home, 'standalone-plan.md');
    await writeFile(planFile, '# Standalone\n\nNo workspace references here.\n', 'utf8');

    const r = await resolvePlanTeleport({
      planPath: planFile,
      hostCwd: HOST_CWD,
      hostHome: home,
    });

    const staged = await readFile(r.hostFile, 'utf8');
    expect(staged).toBe('# Standalone\n\nNo workspace references here.\n');
  });
});
