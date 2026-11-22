/**
 * `agentbox accounts` — the named LLM accounts on this host
 * (docs/llm-accounts-plan.md, Phase 2).
 *
 * Reads and edits the host store (`~/.agentbox/accounts.json` + the secret
 * files). Logins happen through `agentbox <agent> login --account <name>`;
 * which account a box uses is Phase 3 (`<agent>.account`, `--account`).
 */
import { Command } from 'commander';
import { execa } from 'execa';
import { confirm, isCancel, log } from '@agentbox/cli-kit';
import {
  accountConfigVolume,
  findAccount,
  isDefaultAccount,
  type LlmAccount,
} from '@agentbox/core';
import {
  readAccounts,
  readAccountSecret,
  removeAccount,
  resolveAgentSpec,
  upsertAccount,
} from '@agentbox/sandbox-core';
import { renderTable } from '../lib/text-table.js';
import { describeIdentity } from '../lib/account-login.js';

/** `<agent>/<id>` → its parts, or a message for the user. */
export function parseAccountRef(ref: string): { agent: string; id: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1 || ref.indexOf('/', slash + 1) !== -1) {
    throw new Error(`expected <agent>/<account>, e.g. claude/work (got '${ref}')`);
  }
  return { agent: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function fail(err: unknown): never {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function listAccounts(opts: { json?: boolean }): Promise<void> {
  const { accounts } = await readAccounts();
  const rows = await Promise.all(
    accounts.map(async (a) => ({
      ...a,
      hasSecret: (await readAccountSecret(a.agent, a.id)) !== null,
    })),
  );
  if (opts.json) {
    process.stdout.write(JSON.stringify({ accounts: rows }, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    log.info(
      'No accounts yet. Sign in with `agentbox <agent> login`, or add a named one with `--account <name>`.',
    );
    return;
  }
  renderTable(
    ['AGENT', 'ACCOUNT', 'KIND', 'LABEL', 'IDENTITY', 'SECRET'],
    rows.map((r) => [
      r.agent,
      r.id,
      r.kind,
      r.label ?? '',
      describeIdentity(r.identity).replace(/^ \((.*)\)$/, '$1'),
      r.hasSecret ? 'stored' : 'missing',
    ]),
  );
}

async function removeAccountCommand(ref: string, opts: { yes?: boolean }): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  if (isDefaultAccount(id)) {
    throw new Error(
      `the default account is the agent's own login; sign in again with \`agentbox ${name} login\` to replace it`,
    );
  }
  const spec = resolveAgentSpec(name);
  if (!findAccount(await readAccounts(), spec.id, id)) {
    throw new Error(`no account '${id}' for ${spec.id} (see \`agentbox accounts\`)`);
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error('refusing to remove without a terminal; pass --yes');
    const ok = await confirm({
      message: `Remove ${spec.id} account '${id}' and its stored login?`,
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      log.info('kept');
      return;
    }
  }
  await removeAccount(spec.id, id);
  // The account's docker config volume (a `login` account signed in there).
  // `docker volume rm` refuses a volume a container still mounts; say so
  // rather than force it out from under a running box.
  const volume = accountConfigVolume(spec.dockerVolume, id);
  const rm = await execa('docker', ['volume', 'rm', volume], { reject: false });
  if (rm.exitCode === 0) {
    log.success(`removed ${spec.id} account '${id}' and its volume ${volume}`);
  } else if (/no such volume/i.test(rm.stderr ?? '')) {
    log.success(`removed ${spec.id} account '${id}'`);
  } else {
    log.success(`removed ${spec.id} account '${id}'`);
    log.warn(`could not remove its volume ${volume}: ${(rm.stderr ?? '').trim() || 'docker failed'}`);
  }
}

async function labelAccountCommand(
  ref: string,
  label: string | undefined,
  opts: { clear?: boolean },
): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  const spec = resolveAgentSpec(name);
  const existing = findAccount(await readAccounts(), spec.id, id);
  if (!existing) throw new Error(`no account '${id}' for ${spec.id} (see \`agentbox accounts\`)`);
  const next: LlmAccount = { ...existing };
  const text = label?.trim();
  if (opts.clear || !text) {
    if (!opts.clear) throw new Error('give a label, or --clear to remove it');
    delete next.label;
  } else {
    next.label = text;
  }
  await upsertAccount(next);
  log.success(
    next.label ? `labelled ${spec.id}/${id} '${next.label}'` : `cleared the label of ${spec.id}/${id}`,
  );
}

const listCmd = new Command('list')
  .description('list the LLM accounts on this host (no secrets)')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => listAccounts(opts).catch(fail));

export const accountsCommand = new Command('accounts')
  .description(
    'named LLM accounts (logins, setup tokens, API keys) per agent; add one with `agentbox <agent> login --account <name>`',
  )
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => listAccounts(opts).catch(fail))
  .addCommand(listCmd)
  .addCommand(
    new Command('rm')
      .description('remove a named account: its stored login and its docker volume')
      .argument('<agent/account>', 'e.g. claude/work')
      .option('-y, --yes', 'do not ask for confirmation')
      .action((ref: string, opts: { yes?: boolean }) =>
        removeAccountCommand(ref, opts).catch(fail),
      ),
  )
  .addCommand(
    new Command('label')
      .description("set or clear an account's display label")
      .argument('<agent/account>', 'e.g. claude/work')
      .argument('[label]', 'the new label')
      .option('--clear', 'remove the label')
      .action((ref: string, label: string | undefined, opts: { clear?: boolean }) =>
        labelAccountCommand(ref, label, opts).catch(fail),
      ),
  );
