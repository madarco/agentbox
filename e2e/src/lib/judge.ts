import { appendFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { execa } from 'execa';
import { REAL_HOME } from './env.js';
import type { Ctx } from './runner.js';

const SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/;

/**
 * Ask a headless Claude a yes/no question about one piece of evidence (a screenshot
 * or a terminal screen dump). Scripted assertions stay the gate; the judge covers the
 * checks a regex can't make ("does this menu show the box with its PR label?").
 * The verdict lands in the step result; a `pass: false` fails the step.
 */
export async function judge(ctx: Ctx, evidencePath: string, expectation: string): Promise<void> {
  ctx.evidence(evidencePath);
  if (!ctx.opts.judge) {
    ctx.note('judge disabled (--no-judge)');
    return;
  }
  const prompt = [
    `You are checking one piece of evidence from an automated end-to-end test of AgentBox,`,
    `a CLI + macOS menu-bar app that runs coding agents in sandboxes ("boxes").`,
    `Read the file ./${basename(evidencePath)} (an image or a terminal screen dump).`,
    ``,
    `Expectation: ${expectation}`,
    ``,
    `Judge ONLY whether the evidence meets the expectation. Ignore cosmetic details the`,
    `expectation doesn't mention. Reply with exactly one line of JSON and nothing else:`,
    `{"pass": true|false, "reason": "<one sentence citing what you saw>"}`,
  ].join('\n');

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SESSION_ENV.test(k)) env[k] = v;
  env['HOME'] = REAL_HOME;

  const r = await execa(
    'claude',
    ['-p', '--output-format', 'json', '--allowedTools', 'Read', prompt],
    {
      cwd: dirname(evidencePath),
      env,
      extendEnv: false,
      timeout: 5 * 60_000,
      reject: false,
      stdin: 'ignore',
    },
  );
  appendFileSync(ctx.log, `\n[judge] ${expectation}\n${String(r.stdout)}\n${String(r.stderr)}\n`);
  let verdict: { pass: boolean; reason: string } | undefined;
  try {
    const outer = JSON.parse(String(r.stdout)) as { result?: string };
    const m = /\{[^{}]*"pass"[^{}]*\}/.exec(outer.result ?? '');
    if (m) verdict = JSON.parse(m[0]) as { pass: boolean; reason: string };
  } catch {
    verdict = undefined;
  }
  ctx.judgements.push({
    pass: verdict?.pass === true,
    reason: verdict?.reason ?? `judge returned no verdict (exit ${String(r.exitCode)})`,
    expectation,
    evidence: evidencePath,
  });
}
