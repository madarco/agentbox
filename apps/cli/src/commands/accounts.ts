/**
 * `agentbox accounts` — the named LLM accounts on this host
 * (docs/llm-accounts-plan.md, Phase 2).
 *
 * Reads and edits the host store (`~/.agentbox/accounts.json` + the secret
 * files). Logins happen through `agentbox <agent> login --account <name>`;
 * which account a box uses is Phase 3 (`<agent>.account`, `--account`).
 */
import { Command } from 'commander';
import { confirm, isCancel, log } from '@agentbox/cli-kit';
import { accountConfigVolume, isDefaultAccount } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { withHubClient } from '../control-plane/with-hub.js';
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
  // This machine's accounts, through its own hub (`/api/v1/accounts`): the
  // store is per machine, so a configured remote control box is not asked.
  await withHubClient({ preferLocal: true }, async (client) => {
    const { accounts } = await client.listAccounts();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ accounts }, null, 2) + '\n');
      return;
    }
    if (accounts.length === 0) {
      log.info(
        'No accounts yet. Sign in with `agentbox <agent> login`, or add a named one with `--account <name>`.',
      );
      return;
    }
    renderTable(
      ['AGENT', 'ACCOUNT', 'KIND', 'LABEL', 'IDENTITY', 'SECRET', 'BOXES'],
      accounts.map((r) => [
        r.agent,
        r.id,
        r.kind,
        r.label ?? '',
        describeIdentity(r.identity).replace(/^ \((.*)\)$/, '$1'),
        r.hasSecret ? 'stored' : 'missing',
        r.boxes.length > 0 ? r.boxes.join(', ') : '',
      ]),
    );
  });
}

async function removeAccountCommand(ref: string, opts: { yes?: boolean }): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  if (isDefaultAccount(id)) {
    throw new Error(
      `the default account is the agent's own login; sign in again with \`agentbox ${name} login\` to replace it`,
    );
  }
  const spec = resolveAgentSpec(name);
  // Fail before the prompt on a typo or an account in use. Decided OUTSIDE the
  // hub callback, whose errors read as "can't reach the hub".
  const found = await withHubClient({ preferLocal: true }, async (client) => ({
    account: (await client.listAccounts()).accounts.find((a) => a.agent === spec.id && a.id === id),
  }));
  if (!found) return;
  if (!found.account)
    throw new Error(`no account '${id}' for ${spec.id} (see \`agentbox accounts\`)`);
  if (found.account.boxes.length > 0) {
    const boxes = found.account.boxes;
    throw new Error(
      `${spec.id} account '${id}' is still used by ${boxes.join(', ')}; destroy ${boxes.length === 1 ? 'that box' : 'those boxes'} first`,
    );
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
  // The hub refuses while a box still records the account, and removes the
  // account's docker volume with it.
  await withHubClient({ preferLocal: true }, async (client) => {
    const r = await client.removeAccount(spec.id, id);
    log.success(
      r.volumeRemoved
        ? `removed ${spec.id} account '${id}' and its volume ${accountConfigVolume(spec.dockerVolume, id)}`
        : `removed ${spec.id} account '${id}'`,
    );
    if (r.volumeError) log.warn(r.volumeError);
  });
}

async function labelAccountCommand(
  ref: string,
  label: string | undefined,
  opts: { clear?: boolean },
): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  const spec = resolveAgentSpec(name);
  const text = label?.trim();
  if (!opts.clear && !text) throw new Error('give a label, or --clear to remove it');
  await withHubClient({ preferLocal: true }, async (client) => {
    const next = await client.labelAccount(spec.id, id, opts.clear ? null : (text ?? null));
    log.success(
      next.label
        ? `labelled ${spec.id}/${id} '${next.label}'`
        : `cleared the label of ${spec.id}/${id}`,
    );
  });
}

async function switchAccountCommand(box: string, ref: string): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  const spec = resolveAgentSpec(name);
  await withHubClient({ preferLocal: true }, async (client) => {
    const r = await client.switchBoxAccount(box, { agent: spec.id, account: id });
    const how = r.how === 'recreate' ? ' (box rebuilt on its volume)' : '';
    log.success(`${r.agent} in ${box} moved from '${r.from}' to '${r.to}'${how}`);
    if (!r.restarted) log.info('the box is not running: the account applies at its next start');
  });
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
    new Command('switch')
      .description(
        "move a box's agent to another account: a setup token or API key restarts the agent with it, a login rebuilds a docker box on that account's volume; the conversation resumes",
      )
      .argument('<box>', 'box id or name')
      .argument('<agent/account>', 'e.g. claude/work, or claude/default')
      .action((box: string, ref: string) => switchAccountCommand(box, ref).catch(fail)),
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
