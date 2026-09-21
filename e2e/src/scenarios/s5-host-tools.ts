import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxSh, createBox } from '../lib/box.js';
import { E2E_PREFIX, e2eEnv } from '../lib/env.js';
import { ab, poll } from '../lib/exec.js';
import { cloneTestRepo } from '../lib/github.js';
import { readSecretsEnv } from '../lib/home.js';
import { hubJson } from '../lib/hub.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';

/** A host-only binary: exists on the host PATH the hub spawns with, never in a box image. */
const TOOL = 'e2e-hosttool';

function installHostTool(): void {
  const p = join(E2E_PREFIX, 'bin', TOOL);
  writeFileSync(p, `#!/bin/sh\necho "hello from host $(uname -s) args:$*"\n`);
  chmodSync(p, 0o755);
}

interface Approval {
  id: string;
  message?: string;
  detail?: string;
  boxId?: string;
  boxName?: string;
  context?: { argv?: string[]; command?: string };
  [k: string]: unknown;
}

const v = (ctx: Ctx) => ctx.vars as { repo: string };

async function answerApproval(ctx: Ctx, match: (a: Approval) => boolean): Promise<Approval> {
  const a = await poll(
    'the tool request to show up in /api/v1/approvals',
    async () => {
      const r = await hubJson<{ approvals?: Approval[] }>('/api/v1/approvals');
      return (r.approvals ?? []).find(match);
    },
    { timeoutMs: 120_000, intervalMs: 2000 },
  );
  await hubJson(`/api/v1/approvals/${encodeURIComponent(a.id)}/answer`, { body: { answer: 'y' } });
  return a;
}

export const s5: ScenarioDef = {
  id: 's5',
  title: 'Host tools, approvals and secrets',
  covers: [
    'TOOLS-001',
    'TOOLS-002',
    'TOOLS-003',
    'TOOLS-004',
    'TOOLS-005',
    'TOOLS-007',
    'TOOLS-009',
  ],
  boxes: 1,
  steps: [
    {
      name: 'create a box',
      fn: async (ctx) => {
        installHostTool();
        const repo = join(ctx.dir, 'repo');
        await cloneTestRepo(repo, ctx.log);
        Object.assign(ctx.vars, { repo });
        await createBox(ctx, ctx.box(), repo);
      },
    },
    {
      name: 'an ungranted host tool is refused, and the error names both remedies',
      covers: ['TOOLS-001', 'TOOLS-002'],
      fn: async (ctx) => {
        const list = await boxSh(ctx, ctx.box(), 'agentbox-ctl tool list', { allowFail: true });
        if (list.stdout.includes(TOOL)) throw new Error(`tool list shows the ungranted ${TOOL}`);
        const r = await boxSh(ctx, ctx.box(), `agentbox-ctl tool run ${TOOL} -- hi`, {
          allowFail: true,
        });
        const text = r.stdout + r.stderr;
        if (r.exitCode === 0) throw new Error(`ungranted ${TOOL} ran: ${text}`);
        if (!/tools add/.test(text) || !/tool request/.test(text))
          throw new Error(`refusal lacks the remedies:\n${text}`);
        ctx.note(`exit ${String(r.exitCode)}`);
      },
    },
    {
      name: 'a requested tool, approved through /api/v1, works at once',
      covers: ['TOOLS-004'],
      fn: async (ctx) => {
        // The request blocks until answered, so it runs detached in the box.
        await boxSh(
          ctx,
          ctx.box(),
          `nohup agentbox-ctl tool request ${TOOL} --reason "e2e" > /tmp/e2e-req.out 2>&1; echo "exit=$?" >> /tmp/e2e-req.out &`,
        );
        const a = await answerApproval(ctx, (x) => JSON.stringify(x).includes(TOOL));
        ctx.note(`approved ${a.id}: ${a.message ?? ''}`);
        await poll(
          'the in-box request to return',
          async () =>
            /exit=0/.test(
              (await boxSh(ctx, ctx.box(), 'cat /tmp/e2e-req.out', { allowFail: true })).stdout,
            ),
          { timeoutMs: 60_000, intervalMs: 2000 },
        );
        const r = await boxSh(ctx, ctx.box(), `${TOOL} one two`);
        if (!/hello from host .* args:one two/.test(r.stdout))
          throw new Error(`${TOOL} output: ${r.stdout}`);
      },
    },
    {
      name: 'the built-in credential deny list refuses `gh auth token`',
      covers: ['TOOLS-005'],
      fn: async (ctx) => {
        const r = await boxSh(ctx, ctx.box(), 'gh auth token', { allowFail: true });
        const token = e2eEnv()['GH_TOKEN'] ?? '';
        if (token && (r.stdout + r.stderr).includes(token))
          throw new Error('the host GitHub token reached the box');
        if (r.exitCode === 0) throw new Error(`gh auth token exited 0: ${r.stdout.slice(0, 80)}`);
      },
    },
    {
      name: 'no host credential is visible inside the box',
      covers: ['TOOLS-009'],
      fn: async (ctx) => {
        // Pull the box's env and credential-ish files to the host and search them
        // here: sending the secrets into the box to grep would be the leak itself.
        const r = await boxSh(
          ctx,
          ctx.box(),
          'env; git config -l 2>/dev/null; cat ~/.config/gh/hosts.yml ~/.git-credentials ~/.netrc 2>/dev/null; ' +
            'cat ~/.agentbox/*.env /run/agentbox/* 2>/dev/null',
          { allowFail: true },
        );
        const secrets = readSecretsEnv();
        const needles: Array<[string, string]> = [['GH_TOKEN', e2eEnv()['GH_TOKEN'] ?? '']];
        for (const k of ['HCLOUD_TOKEN', 'E2B_API_KEY', 'DAYTONA_API_KEY', 'VERCEL_TOKEN'])
          needles.push([k, secrets.get(k) ?? '']);
        const leaked = needles
          .filter(([, val]) => val.length >= 12 && r.stdout.includes(val))
          .map(([k]) => k);
        if (leaked.length)
          throw new Error(`host credentials visible in the box: ${leaked.join(', ')}`);
      },
    },
    {
      name: 'revoking the grant removes the tool',
      covers: ['TOOLS-007'],
      fn: async (ctx) => {
        await ab(['tools', 'rm', TOOL], { cwd: v(ctx).repo, log: ctx.log });
        const r = await boxSh(ctx, ctx.box(), `agentbox-ctl tool run ${TOOL} -- hi`, {
          allowFail: true,
        });
        if (r.exitCode === 0) throw new Error(`${TOOL} still runs after tools rm: ${r.stdout}`);
      },
    },
  ],
  edges: [
    {
      name: 'requesting a binary the host lacks fails fast, without a prompt',
      covers: ['TOOLS-003'],
      needs: ['create a box'],
      fn: async (ctx) => {
        const r = await boxSh(
          ctx,
          ctx.box(),
          'agentbox-ctl tool request no-such-binary-e2e --reason e2e',
          {
            allowFail: true,
            timeoutMs: 60_000,
          },
        );
        if (r.exitCode === 0) throw new Error('request for a missing binary succeeded');
        const pending = await hubJson<{ approvals?: Approval[] }>('/api/v1/approvals');
        if (JSON.stringify(pending).includes('no-such-binary-e2e'))
          throw new Error('a prompt was raised for a missing binary');
        ctx.note(`exit ${String(r.exitCode)} in ${String(Math.round(r.durationMs / 1000))}s`);
      },
    },
  ],
};
