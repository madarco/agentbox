import { Command } from 'commander';
import { getMachineId } from '@agentbox/config';
import {
  runModelAuthIngest,
  findAgentSpec,
  isRealAgentCredential,
  planPropagateTargets,
  pushCredentialToBox,
  readCredentialBackup,
  readState,
  resolveAgentSpec,
  STATE_DIR,
  type AgentId,
} from '@agentbox/sandbox-core';
import { DEFAULT_BOX_IMAGE, volumeSettingsTarget } from '@agentbox/sandbox-docker';
import {
  accountCustodyPath,
  accountIdProblem,
  accountSecretPath,
  agentConfigVolume,
  DEFAULT_ACCOUNT_ID,
  isDefaultAccount,
  requireAgentCredential,
} from '@agentbox/core';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';
import {
  addCommand,
  credentialsInteractive,
  fail,
  labelCommand,
  listCommand,
  removeCommand,
  renewCommand,
  runCredentialsTui,
  switchCommand,
  useCommand,
  type AddOpts,
  type RenewOpts,
  type UseOpts,
} from './credentials-manage.js';

interface PropagateOpts {
  json?: boolean;
  agent: string;
  sourceBox?: string;
  account?: string;
}

/**
 * `agentbox credentials propagate` — push the host credential backup
 * (`~/.agentbox/<agent>-credentials.json`) into every other box: the docker
 * config volumes via helper containers (covers paused boxes too — the volume
 * is the box's credential store) and each *running* cloud box over its
 * provider transport. Paused/stopped cloud boxes are reconciled on resume.
 *
 * Hidden: the relay spawns it (debounced) whenever a box reports a refreshed
 * credential — claude's OAuth refresh rotates the refresh token, so every
 * other copy dies the moment one box refreshes. Also usable manually for
 * recovery. All mechanics live in the sync layer (`pushCredentialToBox`,
 * `planPropagateTargets`, `volumeSettingsTarget`).
 */
const propagateCommand = new Command('propagate')
  .description('Push the host credential backup for an agent into all other boxes')
  .requiredOption('--agent <agent>', 'claude|codex|opencode')
  .option('--source-box <id>', 'box the update came from (skipped as a target)')
  .option(
    '--account <name>',
    "the LLM account whose login to fan out (default: the agent's default login); only boxes on that account are targets",
  )
  .option('--json', 'end with a `{"pushed","failed"}` JSON line')
  .action(async (opts: PropagateOpts) => {
    try {
      const spec = resolveAgentSpec(opts.agent);
      const agent = spec.id;
      // An agent that declares no credential has nothing to propagate and no
      // backup path to name in the error, so say the real reason.
      const cred = spec.credential;
      if (!cred) {
        throw new Error(`${agent} has no host-side credential — there is nothing to propagate`);
      }
      // One account per run (llm-accounts Phase 4): its own copy is the source
      // and only its boxes are targets, so two accounts never cross.
      const account = opts.account ?? DEFAULT_ACCOUNT_ID;
      const problem = accountIdProblem(account);
      if (problem) throw new Error(`--account: ${problem}`);
      const backupPath = isDefaultAccount(account)
        ? cred.hostBackup
        : accountSecretPath(spec, account, STATE_DIR)!;
      const content = await readCredentialBackup(agent, { backupPath });
      if (content === null || !isRealAgentCredential(agent, content)) {
        throw new Error(`no usable ${agent} credential at ${backupPath}; nothing to propagate`);
      }

      const state = await readState();
      const sourceBox = state.boxes.find((b) => b.id === opts.sourceBox);
      // The source box's own store already holds the fresh blob: its docker
      // volume IS the file the watcher saw change; a cloud source box wrote it
      // to its own FS. Excluding the source volume skips a guaranteed no-op.
      const excludeVolume =
        sourceBox && (sourceBox.provider ?? 'docker') === 'docker'
          ? (agentConfigVolume(sourceBox, agent) ?? spec.dockerVolume)
          : undefined;
      const plan = planPropagateTargets(state.boxes, {
        agent,
        sourceBoxId: opts.sourceBox ?? '',
        scope: 'all',
        excludeVolume,
        account,
      });

      let pushed = 0;
      let failed = 0;
      const image = sourceBox?.image || DEFAULT_BOX_IMAGE;
      for (const vol of plan.dockerVolumes) {
        try {
          await volumeSettingsTarget(vol.volume, image, vol.volume).writeText(
            cred.boxRelPath,
            content,
            { mode: 0o600 },
          );
          pushed += 1;
          process.stdout.write(
            `pushed ${agent} credential to volume ${vol.volume} (${vol.boxNames.join(', ')})\n`,
          );
        } catch (err) {
          failed += 1;
          process.stderr.write(
            `volume ${vol.volume}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      for (const target of plan.cloudBoxes) {
        try {
          const provider = await providerForBox(target);
          if (!provider.syncTransport) {
            process.stdout.write(`${target.name}: no transport; skipped\n`);
            continue;
          }
          const insp = await provider.inspect(target);
          if (insp.state !== 'running') {
            process.stdout.write(`${target.name}: ${insp.state}; skipped (reconciled on resume)\n`);
            continue;
          }
          await pushCredentialToBox(provider.syncTransport(target), agent, content);
          pushed += 1;
          process.stdout.write(`pushed ${agent} credential to ${target.name}\n`);
        } catch (err) {
          failed += 1;
          process.stderr.write(
            `${target.name}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      // Boxes that BORROW this login as model auth (an OpenClaw box on the
      // user's Codex account). No volume to write: the blob goes to the
      // canonical path over the transport, then the consuming agent's ingest
      // task re-runs — a no-op while its own imported profile is still usable,
      // a re-import once that profile has died.
      for (const target of plan.borrowingBoxes) {
        try {
          const provider = await providerForBox(target);
          if (!provider.syncTransport) {
            process.stdout.write(`${target.name}: no transport; skipped\n`);
            continue;
          }
          const insp = await provider.inspect(target);
          if (insp.state !== 'running') {
            process.stdout.write(`${target.name}: ${insp.state}; skipped (borrowed login)\n`);
            continue;
          }
          await pushCredentialToBox(provider.syncTransport(target), agent, content);
          pushed += 1;
          process.stdout.write(`pushed ${agent} credential to ${target.name} (borrowed)\n`);
          // EVERY consuming agent on the box, not just the first: a box can run
          // more than one, and `.find()` here silently left the rest holding a
          // dead profile after a refresh.
          for (const id of target.agents ?? []) {
            const consumer = findAgentSpec(id);
            if (!consumer) continue;
            await runModelAuthIngest(
              consumer,
              async (argv) => {
                const r = await provider.exec(target, argv, { user: 'vscode' });
                return {
                  exitCode: r.exitCode ?? 0,
                  stdout: r.stdout ?? '',
                  stderr: r.stderr ?? '',
                };
              },
              { force: true, onLog: (line) => process.stdout.write(`${line}\n`) },
            );
          }
        } catch (err) {
          failed += 1;
          process.stderr.write(
            `${target.name}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      process.stdout.write(
        `propagated ${agent} credential to ${String(pushed)} target(s)` +
          (failed > 0 ? `, ${String(failed)} failed` : '') +
          '\n',
      );
      // The machine-readable summary the hub's renew route reads.
      if (opts.json) process.stdout.write(`${JSON.stringify({ pushed, failed })}\n`);

      // Opportunistically mirror the refreshed backup up to the control box's
      // custody store, so a hub-created box (phase 3) logs in with the same
      // credential. Best-effort + hash-skipped: a no-op when no control plane
      // is configured or the blob is unchanged, and never fails propagate.
      await pushCredentialToCustody(agent, account, content);

      if (failed > 0) process.exitCode = 1;
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * Push one agent's backup to custody if — and only if — a control plane URL and
 * an admin token are both configured. Silent no-op otherwise; the CustodyClient
 * hash-skips an unchanged value. Failures are logged to stderr, never thrown.
 */
async function pushCredentialToCustody(
  agent: AgentId,
  account: string,
  content: string,
): Promise<void> {
  try {
    // Only when a control box is configured (remoteOnly). Pushing an agent
    // credential is a write, so it needs the hub API key alone — no admin token.
    const { resolveCustodyApiTarget } = await import('./control-plane.js');
    const target = await resolveCustodyApiTarget(undefined, { quiet: true, remoteOnly: true });
    if (!target) return;
    const { CustodyClient, planCredentialPush } =
      await import('../control-plane/custody-client.js');
    const client = new CustodyClient(target);
    const path = accountCustodyPath(
      agent,
      account,
      requireAgentCredential(resolveAgentSpec(agent)).boxRelPath,
      // A named account belongs to THIS machine's store.
      isDefaultAccount(account) ? undefined : getMachineId(),
    );
    const item = { path, data: Buffer.from(content, 'utf8') };
    const manifest = await client.list('agents');
    const [decision] = await planCredentialPush([item], manifest, (p) => client.get(p));
    if (decision!.action === 'skip') {
      if (decision!.reason !== 'hash match') {
        process.stdout.write(`control box custody kept its ${agent} login (${decision!.reason})\n`);
      }
      return;
    }
    await client.put(path, item.data);
    process.stdout.write(`pushed ${agent} credential to control box custody\n`);
  } catch (err) {
    process.stderr.write(
      `custody push skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

const withRef =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  (...args: A): Promise<void> =>
    fn(...args).catch(fail);

export const credentialsCommand = new Command('credentials')
  .description(
    'Subscriptions and keys per agent (logins, setup tokens, API keys): list, add, renew, make default, move a box. Bare on a terminal: an interactive menu',
  )
  .option('--json', 'print the list as JSON (no menu)')
  // Without it the parent swallows a subcommand's own options (`list --json`).
  .enablePositionalOptions()
  .action(async (opts: { json?: boolean }) => {
    if (!opts.json && credentialsInteractive()) await runCredentialsTui();
    else await listCommand(opts).catch(fail);
  })
  .addCommand(
    new Command('list')
      .description('list the accounts on this machine (no secrets)')
      .option('--json', 'machine-readable output')
      .action(withRef((opts: { json?: boolean }) => listCommand(opts))),
  )
  .addCommand(
    new Command('add')
      .description(
        'add a named account: sign a login in here, or store a setup token / API key (read from a hidden prompt or stdin, never argv)',
      )
      .argument('<agent/name>', 'e.g. claude/work')
      .option('--login', 'sign in with the browser (the OAuth login)')
      .option('--setup-token', 'store a long-lived setup token (never refreshes; fine for many boxes at once)')
      .option('--api-key', 'store an API key')
      .option('--label <text>', 'display label')
      .option('--replace', "paste a new token over an existing setup token or API key (boxes on it keep it)")
      .option('--headless', 'login without a terminal: print the URL, then finish with --code')
      .option('--code <code>', 'finish a --headless login with the OAuth code')
      .action(withRef((ref: string, opts: AddOpts) => addCommand(ref, opts))),
  )
  .addCommand(
    new Command('renew')
      .description(
        "sign a login in again, then push it to every box on the account (a box showing 'Login expired' works again); for a setup token or API key, paste its new token",
      )
      .argument('<agent/account>', 'e.g. claude/default, claude/work')
      .option('--skip-sign-in', 'push the stored login as it is (only a box lost it)')
      .option('--headless', 'login without a terminal: print the URL, then finish with --code')
      .option('--code <code>', 'finish a --headless login with the OAuth code, then push it')
      .action(withRef((ref: string, opts: RenewOpts) => renewCommand(ref, opts))),
  )
  .addCommand(
    new Command('use')
      .description(
        'which account new boxes get: no argument shows it per agent for this project; <agent/account> sets it for this project (--global: everywhere)',
      )
      .argument('[agent/account]', 'e.g. claude/work; with --clear, the agent alone')
      .option('--global', 'the global default instead of this project')
      .option('--clear', 'remove the setting (this project, or with --global the global one)')
      .option('--json', 'with no argument: machine-readable output')
      .action(withRef((ref: string | undefined, opts: UseOpts) => useCommand(ref, opts))),
  )
  .addCommand(
    new Command('rm')
      .description('remove a named account: its stored login and its docker volume')
      .argument('<agent/account>', 'e.g. claude/work')
      .option('-y, --yes', 'do not ask for confirmation')
      .action(withRef((ref: string, opts: { yes?: boolean }) => removeCommand(ref, opts))),
  )
  .addCommand(
    new Command('label')
      .description("set or clear an account's display label")
      .argument('<agent/account>', 'e.g. claude/work')
      .argument('[label]', 'the new label')
      .option('--clear', 'remove the label')
      .action(
        withRef((ref: string, label: string | undefined, opts: { clear?: boolean }) =>
          labelCommand(ref, label, opts),
        ),
      ),
  )
  .addCommand(
    new Command('switch')
      .description(
        "move a box's agent to another account: a setup token or API key restarts the agent with it, a login rebuilds a docker box on that account's volume; the conversation resumes",
      )
      .argument('<box>', 'box id or name')
      .argument('<agent/account>', 'e.g. claude/work, or claude/default')
      .action(withRef((box: string, ref: string) => switchCommand(box, ref))),
  )
  .addCommand(propagateCommand, { hidden: true });
