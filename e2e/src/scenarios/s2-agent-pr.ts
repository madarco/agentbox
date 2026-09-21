import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxSh, queueAgentBox, waitForBoxCommit } from '../lib/box.js';
import { E2E_HOME, REAL_HOME } from '../lib/env.js';
import { ab, abJson, run } from '../lib/exec.js';
import {
  branchHeadMessage,
  cloneTestRepo,
  createBaseBranch,
  fileOnBranch,
  makeDirty,
  prForHead,
} from '../lib/github.js';
import { hubBox, hubBoxes } from '../lib/hub.js';
import type { Ctx, ScenarioDef, StepDef } from '../lib/runner.js';

const CARRY_SRC = '~/.agentbox/e2e-carry/marker.txt';
const CARRY_DEST = '~/carried-marker.txt';

interface S2Vars {
  repo: string;
  base: string;
  staged: string;
  untracked: string;
}

function v(ctx: Ctx): S2Vars {
  return ctx.vars as unknown as S2Vars;
}

/** Add a `carry:` entry to the clone's agentbox.yaml (an uncommitted edit, so it's dirty state too). */
function addCarry(repo: string): void {
  const file = join(repo, 'agentbox.yaml');
  const yaml = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    `carry:\n  - src: ${CARRY_SRC}\n    dest: ${CARRY_DEST}\n    mode: 0o600\n\n${yaml}`,
  );
  mkdirSync(join(E2E_HOME, '.agentbox', 'e2e-carry'), { recursive: true });
  writeFileSync(join(E2E_HOME, '.agentbox', 'e2e-carry', 'marker.txt'), 'carried by e2e\n', {
    mode: 0o600,
  });
}

/**
 * The model the host's opencode last used. The box doesn't inherit it (only the login
 * is synced), and opencode's fallback may be a provider the login doesn't cover.
 */
function hostOpencodeModel(): string[] {
  try {
    const state = JSON.parse(
      readFileSync(join(REAL_HOME, '.local', 'state', 'opencode', 'model.json'), 'utf8'),
    ) as { recent?: Array<{ providerID: string; modelID: string }> };
    const m = state.recent?.[0];
    return m ? ['--model', `${m.providerID}/${m.modelID}`] : [];
  } catch {
    return [];
  }
}

function agentSteps(agent: string, first: boolean): StepDef[] {
  const token = `${agent}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `e2e-${agent}.txt`;
  const subject = `e2e: ${agent} ${token}`;
  const boxOf = (ctx: Ctx) => ctx.box(agent === 'claude' ? '' : agent.slice(0, 2));

  const steps: StepDef[] = [
    {
      name: `${agent}: create the box and start a turn with -i`,
      covers:
        agent === 'claude'
          ? ['CLAUDE-001', 'CREATE-001', 'CREATE-002', 'CREATE-003']
          : [`${agent.toUpperCase()}-001`],
      fn: async (ctx) => {
        await queueAgentBox(ctx, {
          agent,
          name: boxOf(ctx),
          cwd: v(ctx).repo,
          prompt:
            `Create a file named ${file} whose only content is the line "${token}". ` +
            `Then commit ONLY that file by running exactly: git commit -m "${subject}" ${file} ` +
            `(after git add ${file}). Do not commit or modify any other file. Then stop.`,
          agentArgs: agent === 'opencode' ? hostOpencodeModel() : [],
        });
        if (agent === 'opencode')
          ctx.note(`opencode model pinned: ${hostOpencodeModel().join(' ') || 'none'}`);
      },
    },
    ...(first
      ? [
          {
            name: 'the staged, untracked and carried files reached the box',
            covers: ['CREATE-010', 'CREATE-013'],
            fn: async (ctx: Ctx) => {
              const { staged, untracked } = v(ctx);
              const r = await boxSh(
                ctx,
                boxOf(ctx),
                `git diff --cached --name-only; echo ---; test -f ${untracked} && echo untracked-ok; ` +
                  `echo ---; stat -c '%a %U' ${CARRY_DEST} && cat ${CARRY_DEST}`,
              );
              const [cached = '', untr = '', carry = ''] = r.stdout.split('---');
              if (!cached.includes(staged))
                throw new Error(`staged file ${staged} is not staged in the box:\n${cached}`);
              if (!untr.includes('untracked-ok'))
                throw new Error(`untracked file ${untracked} missing in the box`);
              if (!/600 vscode/.test(carry) || !carry.includes('carried by e2e'))
                throw new Error(
                  `carried file wrong (want mode 600, owner vscode, content): ${carry.trim()}`,
                );
            },
          },
        ]
      : []),
    {
      name: `${agent}: the agent committed its change`,
      covers: ['CLAUDE-001'],
      fn: async (ctx) => {
        await waitForBoxCommit(ctx, boxOf(ctx), subject);
        const r = await boxSh(ctx, boxOf(ctx), `git show --stat --format=%s HEAD`);
        if (!r.stdout.includes(file)) throw new Error(`HEAD does not touch ${file}:\n${r.stdout}`);
        if (r.stdout.includes(v(ctx).staged))
          ctx.note('the agent also committed the pre-staged file');
      },
    },
    {
      name: `${agent}: push the box branch through the host relay`,
      covers: ['RELAY-008'],
      fn: async (ctx) => {
        await ab(['git', 'push', boxOf(ctx)], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 300_000,
        });
        const msg = await branchHeadMessage(`agentbox/${boxOf(ctx)}`, ctx.log);
        if (msg?.split('\n')[0]?.trim() !== subject)
          throw new Error(
            `GitHub branch agentbox/${boxOf(ctx)} head is "${msg ?? '(missing)'}", want "${subject}"`,
          );
      },
    },
    {
      name: `${agent}: open and merge a PR from the box`,
      fn: async (ctx) => {
        const head = `agentbox/${boxOf(ctx)}`;
        await ab(
          [
            'git',
            'pr',
            'create',
            boxOf(ctx),
            '--base',
            v(ctx).base,
            '--title',
            subject,
            '--body',
            'Automated AgentBox e2e run.',
          ],
          { cwd: v(ctx).repo, log: ctx.log, timeoutMs: 180_000 },
        );
        const pr = await prForHead(head, ctx.log);
        if (!pr) throw new Error(`no PR found for head ${head}`);
        await ab(['git', 'pr', 'merge', boxOf(ctx), String(pr.number), '--squash'], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 180_000,
        });
        const after = await prForHead(head, ctx.log);
        if (after?.state !== 'MERGED')
          throw new Error(`PR #${String(pr.number)} is ${after?.state ?? 'missing'}, want MERGED`);
        const content = await fileOnBranch(v(ctx).base, file, ctx.log);
        if (content?.trim() !== token)
          throw new Error(
            `${file} on ${v(ctx).base} is "${content ?? '(missing)'}", want "${token}"`,
          );
        ctx.note(`PR ${after.url}`);
      },
    },
    {
      name: `${agent}: the hub and \`ls -j\` report the box`,
      covers: ['LS-001', 'LS-002', 'LS-003'],
      fn: async (ctx) => {
        const b = await hubBox(boxOf(ctx));
        if (!b) throw new Error(`${boxOf(ctx)} missing from GET /api/v1/boxes`);
        const problems: string[] = [];
        if ((b.state ?? b.status) !== 'running')
          problems.push(`state ${String(b.state ?? b.status)}`);
        if (b.branch !== `agentbox/${boxOf(ctx)}`) problems.push(`branch ${String(b.branch)}`);
        if (b.agent !== agent) problems.push(`agent ${String(b.agent)}`);
        if (b.provider !== ctx.target.provider) problems.push(`provider ${b.provider}`);
        if (b.managerId)
          problems.push(
            `managerId ${b.managerId} (a box created from a plain terminal has no manager)`,
          );
        const ls = await abJson<Array<{ name?: string; branch?: string }>>(['ls', '-g', '-j'], {
          log: ctx.log,
        });
        const row = ls.find((x) => x.name === boxOf(ctx));
        if (!row) problems.push('missing from `ls -g -j`');
        else if (row.branch !== b.branch)
          problems.push(`ls branch ${String(row.branch)} != hub ${String(b.branch)}`);
        if (problems.length) throw new Error(problems.join('; '));
        writeFileSync(
          join(ctx.dir, `boxes-${agent}.json`),
          `${JSON.stringify(await hubBoxes(), null, 2)}\n`,
        );
      },
    },
    ...(first
      ? []
      : [
          {
            name: `${agent}: destroy the box`,
            covers: ['DESTROY-001'],
            fn: async (ctx: Ctx) => {
              await ab(['destroy', '-y', boxOf(ctx)], { log: ctx.log, timeoutMs: 600_000 });
              if (await hubBox(boxOf(ctx))) throw new Error('box still listed after destroy');
            },
          },
        ]),
  ];
  return steps.map((st) => ({ ...st, group: agent }));
}

export const s2: ScenarioDef = {
  id: 's2',
  title: 'Agent round trip to a merged PR',
  covers: [
    'CLAUDE-001',
    'CODEX-001',
    'OPENCODE-001',
    'CREATE-010',
    'CREATE-013',
    'CREATE-015',
    'RELAY-008',
    'LS-001',
    'CTL-002',
  ],
  boxes: 2,
  steps: (t, opts) => [
    {
      name: 'prepare a dirty clone of the test repo',
      fn: async (ctx) => {
        const repo = join(ctx.dir, 'repo');
        await cloneTestRepo(repo, ctx.log);
        const dirty = makeDirty(repo, ctx.opts.runId);
        await run('git', ['add', dirty.staged], { cwd: repo, log: ctx.log });
        addCarry(repo);
        const base = `e2e/${ctx.opts.runId}/${ctx.target.slug}-s2`;
        await createBaseBranch(base, ctx.log);
        Object.assign(ctx.vars, { repo, base, ...dirty } satisfies S2Vars);
      },
    },
    ...opts.agentsFor(t).flatMap((agent, i) => agentSteps(agent, i === 0)),
  ],
  edges: [
    {
      name: 'the claude session is live in the box',
      covers: ['ATTACH-001'],
      needs: ['claude: create the box and start a turn with -i'],
      fn: async (ctx) => {
        const st = await abJson<{ sessionRunning?: boolean; state?: string }>(
          ['agent', 'state', ctx.box(), '--json'],
          {
            log: ctx.log,
          },
        );
        if (!st.sessionRunning) throw new Error(`no live agent session: ${JSON.stringify(st)}`);
        ctx.note(`agent state: ${String(st.state)}`);
      },
    },
    {
      name: 'carry: on a non-TTY without opt-in fails loud and creates nothing',
      covers: ['CREATE-015'],
      needs: ['prepare a dirty clone of the test repo'],
      fn: async (ctx) => {
        const name = ctx.box('nc');
        const r = await ab(['create', '--provider', ctx.target.providerArg, '-y', '-n', name], {
          cwd: v(ctx).repo,
          log: ctx.log,
          allowFail: true,
          timeoutMs: 300_000,
        });
        if (r.exitCode === 0) {
          ctx.trackBox(name);
          throw new Error('create with a carry: block succeeded on a non-TTY without --carry-yes');
        }
        if (!/carry/i.test(r.stdout + r.stderr))
          throw new Error('the failure does not mention carry');
        if (await hubBox(name)) throw new Error('a box was registered anyway');
      },
    },
    {
      name: 'an invalid agentbox.yaml aborts before creating anything',
      covers: ['CTL-002'],
      needs: ['prepare a dirty clone of the test repo'],
      fn: async (ctx) => {
        const bad = join(ctx.dir, 'repo-bad-yaml');
        cpSync(v(ctx).repo, bad, { recursive: true });
        copyFileSync(join(v(ctx).repo, 'agentbox.yaml'), join(bad, 'agentbox.yaml.orig'));
        writeFileSync(
          join(bad, 'agentbox.yaml'),
          'services:\n  web:\n    command: 42\n    ready_when: [not, a, map]\n',
        );
        const name = ctx.box('by');
        const r = await ab(
          ['create', '--provider', ctx.target.providerArg, '-y', '-n', name, '--carry', 'skip'],
          {
            cwd: bad,
            log: ctx.log,
            allowFail: true,
            timeoutMs: 300_000,
          },
        );
        if (r.exitCode === 0) {
          ctx.trackBox(name);
          throw new Error('create succeeded with an invalid agentbox.yaml');
        }
        if (await hubBox(name)) throw new Error('a box was registered anyway');
      },
    },
  ],
};
