/**
 * `agentbox credentials` — this machine's subscriptions and keys
 * (docs/credentials-tui-plan.md): list, add, renew, make default, remove,
 * move a box. Bare on a terminal it is one table screen (cli-kit `tableSelect`):
 * the accounts as selectable rows under the add/defaults actions; every action
 * is also a subcommand for scripts. An account has one name, its id.
 *
 * Every action drives the LOCAL hub's `/api/v1/accounts` (the store is per
 * machine, so a configured remote control box is not asked). Signing a login
 * in is the one step that is not an API call: the agent's own OAuth flow runs
 * in a throwaway container here, as `agentbox <agent> login` does.
 */
import { cancel, confirm, isCancel, log, note, outro, select, spinner, text } from '@clack/prompts';
import {
  accountConfigVolume,
  accountIdProblem,
  isDefaultAccount,
  normalizeAccountName,
} from '@agentbox/core';
import { tableSelect } from '@agentbox/cli-kit';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { withHubClient } from '../control-plane/with-hub.js';
import type {
  HubApiAccount,
  HubApiAccountList,
  HubApiClient,
} from '../control-plane/hub-api-client.js';
import { agentLoginSpec, runAgentLogin } from '../agents/command/login.js';
import { PASTED_KIND_NOUN, readPastedSecret } from '../lib/account-login.js';
import { fanOutLogin } from '../lib/login-fanout.js';
import {
  ACCOUNT_HEADERS,
  KIND_TEXT,
  accountCells,
  identityText,
  limitsText,
  parseAccountRef,
  renderAccountsTable,
  renderDefaultsTable,
  sortAccounts,
  statusText,
  statusTone,
} from '../lib/credentials-view.js';

type Kind = HubApiAccount['kind'];

const LOCAL = { preferLocal: true } as const;

export function fail(err: unknown): never {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** The agent's canonical id, or a message (an unknown name). */
function agentId(name: string): string {
  return resolveAgentSpec(name).id;
}

/**
 * The hub's list, or undefined when the hub could not answer (already
 * reported). `project` marks this folder's defaults too.
 */
/** The list; a config the hub can't read is a warning (no default marks then). */
async function loadList(project?: string): Promise<HubApiAccountList | undefined> {
  const list = await withHubClient(LOCAL, (client) =>
    client.listAccounts(project ? { project } : {}),
  );
  if (list?.defaultsError) log.warn(`${list.defaultsError}; defaults are not shown`);
  if (list?.storeError) log.warn(`${list.storeError}. Only the default logins are listed.`);
  return list;
}

// ---- list ------------------------------------------------------------------

export async function listCommand(opts: { json?: boolean }): Promise<void> {
  const list = await loadList(process.cwd());
  if (!list) return;
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          accounts: list.accounts,
          ...(list.defaults ? { defaults: list.defaults } : { defaultsError: list.defaultsError }),
          ...(list.storeError ? { storeError: list.storeError } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (list.accounts.length === 0) {
    log.info(
      'No accounts yet. Sign in with `agentbox <agent> login`, or add a named one with `agentbox credentials add <agent>/<name>`.',
    );
    return;
  }
  process.stdout.write(renderAccountsTable(list.accounts) + '\n');
}

// ---- add -------------------------------------------------------------------

export interface AddOpts {
  replace?: boolean;
  login?: boolean;
  setupToken?: boolean;
  apiKey?: boolean;
  headless?: boolean;
  code?: string;
}

function kindOf(opts: AddOpts): Kind | undefined {
  const picked = [
    opts.login ? 'login' : null,
    opts.setupToken ? 'setup-token' : null,
    opts.apiKey ? 'api-key' : null,
  ].filter((k): k is Kind => k !== null);
  if (picked.length > 1) throw new Error('pick one of --login, --setup-token, --api-key');
  return picked[0];
}

/** Store a pasted kind through the hub. Returns false when nothing was stored. */
async function addPasted(
  agent: string,
  id: string,
  kind: Exclude<Kind, 'login'>,
  replace = false,
): Promise<boolean> {
  const noun = PASTED_KIND_NOUN[kind];
  const token = await readPastedSecret(replace ? `new ${noun}` : noun);
  if (token === null) return false;
  if (!token) throw new Error(`no ${noun} given`);
  const stored = await withHubClient(LOCAL, (client) =>
    client.addPastedAccount({
      agent,
      id,
      kind,
      token,
      ...(replace ? { replace: true } : {}),
    }),
  );
  if (!stored) return false;
  if (!replace) {
    log.success(`saved the ${noun} as ${agent}/${id}`);
  } else {
    log.success(`replaced the ${noun} of ${agent}/${id}`);
    if (stored.boxes.length > 0) {
      // The token reaches an agent as an env var at its start.
      log.info(
        `${stored.boxes.join(', ')} pick${stored.boxes.length === 1 ? 's' : ''} it up when the agent restarts (\`agentbox <agent> start <box>\` after stopping its session, or restart the box)`,
      );
    }
  }
  return true;
}

/** Sign a login in on this machine (the agent's own flow) as a named account. */
async function addLogin(
  agent: string,
  id: string,
  opts: Pick<AddOpts, 'headless' | 'code'>,
): Promise<void> {
  const spec = agentLoginSpec(agent);
  if (!spec) throw new Error(`${agent} has no login`);
  await runAgentLogin(spec, [], {
    account: { id },
    extra: loginExtra(opts),
  });
}

function loginExtra(opts: Pick<AddOpts, 'headless' | 'code'>): Record<string, unknown> {
  return {
    ...(opts.headless ? { headless: true } : {}),
    ...(opts.code !== undefined ? { code: opts.code } : {}),
  };
}

/**
 * The stored name for a typed one: an existing account's name as is (older
 * ones may hold '-'), a new one normalized ("Work Max" -> work_max). Throws a
 * message for a name that can't be one.
 */
export function accountNameFor(typed: string, existing: readonly string[]): string {
  const raw = typed.trim();
  if (existing.includes(raw) && accountIdProblem(raw) === null) return raw;
  const n = normalizeAccountName(raw);
  if (n.problem !== undefined) throw new Error(n.problem);
  return n.name;
}

/**
 * `default` is the agent's own login file, so a pasted token cannot live
 * there: it goes under a name, which can then be made the default.
 */
export function defaultPastedMessage(agent: string, flag: '--setup-token' | '--api-key'): string {
  return (
    `the default account is ${agent}'s own login, so a ${flag === '--api-key' ? 'API key' : 'setup token'} needs a name: ` +
    `\`agentbox credentials add ${agent}/<name> ${flag}\`, then make it the default for new boxes with ` +
    `\`agentbox credentials use ${agent}/<name> --global\``
  );
}

export async function addCommand(ref: string, opts: AddOpts): Promise<void> {
  const { agent: name, id: typed } = parseAccountRef(ref);
  const agent = agentId(name);
  // The list decides whether the name is an existing one (kept as is) or a new
  // one (normalized); without it a '-' name would silently become another
  // account, so stop (the hub failure is already reported).
  const list = await loadList();
  if (!list) {
    process.exitCode ||= 1;
    return;
  }
  const known = list.accounts.filter((a) => a.agent === agent);
  const id = accountNameFor(
    typed,
    known.map((a) => a.id),
  );
  if (isDefaultAccount(id)) {
    const pasted = opts.setupToken ? '--setup-token' : opts.apiKey ? '--api-key' : undefined;
    throw new Error(
      pasted
        ? defaultPastedMessage(agent, pasted)
        : `the default account is the agent's own login: \`agentbox ${agent} login\` signs it in`,
    );
  }
  if (id !== typed.trim()) {
    // Off a terminal stdout is for results a script reads; the notice goes to stderr.
    if (interactive()) log.info(`name: ${agent}/${id}`);
    else process.stderr.write(`name: ${agent}/${id}\n`);
  }
  let kind = kindOf(opts);
  if (!kind) {
    if (!interactive()) throw new Error('pick a kind: --login, --setup-token or --api-key');
    const kinds = list.agents.find((a) => a.id === agent)?.kinds ?? [];
    if (kinds.length === 0) throw new Error(`${agent} cannot hold named accounts`);
    const picked = await select({
      message: `What kind of ${agent} account?`,
      options: kinds.map((k) => ({ value: k, label: KIND_TEXT[k] })),
    });
    if (isCancel(picked)) return;
    kind = picked;
  }
  if (kind === 'login') {
    if (opts.replace) throw new Error('--replace is for a setup token or API key; renew a login');
    // Signing an existing login in again here would skip the push to its boxes.
    const existing = known.find((a) => a.id === id);
    if (existing) {
      throw new Error(
        existing.kind === 'login'
          ? `${agent}/${id} already exists; sign it in again with \`agentbox credentials renew ${agent}/${id}\``
          : `${agent}/${id} already exists as a ${KIND_TEXT[existing.kind]}; remove it first`,
      );
    }
    await addLogin(agent, id, opts);
  } else if (!(await addPasted(agent, id, kind, opts.replace === true))) {
    process.exitCode = 1;
  }
}

// ---- renew -----------------------------------------------------------------

export interface RenewOpts {
  skipSignIn?: boolean;
  headless?: boolean;
  code?: string;
}

/**
 * Sign a login in again, then fan it out to every box on the account (the
 * relay's `credentials propagate`, run by the hub). A box signed out by another
 * box's refresh ("Login expired · Please run /login") works again after it.
 */
export async function renewCommand(ref: string, opts: RenewOpts): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  const agent = agentId(name);
  const list = await loadList();
  if (!list) return;
  const account = list.accounts.find((a) => a.agent === agent && a.id === id);
  if (!account) throw new Error(`no account ${agent}/${id} (see \`agentbox credentials\`)`);
  if (account.kind !== 'login') {
    // A pasted kind is renewed by pasting its new token over it.
    if (!(await addPasted(agent, id, account.kind, true))) process.exitCode = 1;
    return;
  }
  if (!opts.skipSignIn) {
    const spec = agentLoginSpec(agent);
    if (!spec) throw new Error(`${agent} has no login`);
    // A login protocol of its own (claude) without a terminal or with
    // --headless only PRINTS the URL; the sign-in finishes with --code. Fanning
    // out now would push the old, dead login.
    const startsOnly =
      Boolean(spec.runtime.loginCommand?.run) &&
      opts.code === undefined &&
      (opts.headless === true || !process.stdin.isTTY);
    await runAgentLogin(spec, [], {
      ...(isDefaultAccount(id) ? {} : { account: { id } }),
      // Finishing through `renew` again is what pushes the new login out.
      extra: {
        ...loginExtra(opts),
        finishCommand: `agentbox credentials renew ${agent}/${id} --code <CODE>`,
      },
    });
    if (startsOnly) return;
  }
  await fanOutLogin(agent, id);
}

// ---- rm / label / switch ----------------------------------------------------

export async function removeCommand(ref: string, opts: { yes?: boolean }): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  const agent = agentId(name);
  if (isDefaultAccount(id)) {
    throw new Error(
      `the default account is the agent's own login; sign in again with \`agentbox ${agent} login\` to replace it`,
    );
  }
  // Fail before the prompt on a typo or an account in use. Decided OUTSIDE the
  // hub callback, whose errors read as "can't reach the hub".
  const list = await loadList();
  if (!list) return;
  const found = list.accounts.find((a) => a.agent === agent && a.id === id);
  if (!found) throw new Error(`no account ${agent}/${id} (see \`agentbox credentials\`)`);
  if (found.boxes.length > 0) {
    const boxes = found.boxes;
    throw new Error(
      `${agent}/${id} is still used by ${boxes.join(', ')}; destroy ${boxes.length === 1 ? 'that box' : 'those boxes'} or move ${boxes.length === 1 ? 'it' : 'them'} to another account first`,
    );
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error('refusing to remove without a terminal; pass --yes');
    const ok = await confirm({
      message: `Remove ${agent}/${id} and its stored login?`,
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      log.info('kept');
      return;
    }
  }
  // The hub refuses while a box still records the account, and removes the
  // account's docker volume with it.
  await withHubClient(LOCAL, async (client) => {
    const r = await client.removeAccount(agent, id);
    log.success(
      r.volumeRemoved
        ? `removed ${agent}/${id} and its volume ${accountConfigVolume(resolveAgentSpec(agent).dockerVolume, id)}`
        : `removed ${agent}/${id}`,
    );
    if (r.volumeError) log.warn(r.volumeError);
    if (r.defaultsError) log.warn(r.defaultsError);
    if (r.defaultsCleared?.length) {
      log.info(
        `new ${agent} boxes there now use ${agent}/default: ${r.defaultsCleared.map((d) => (d === 'global' ? 'the global setting' : d)).join(', ')}`,
      );
    }
  });
}

export async function switchCommand(box: string, ref: string): Promise<void> {
  const { agent: name, id } = parseAccountRef(ref);
  const agent = agentId(name);
  await withHubClient(LOCAL, async (client) => {
    const r = await client.switchBoxAccount(box, { agent, account: id });
    const how = r.restarted ? ' (agent restarted)' : r.how === 'file' ? ' (no restart)' : '';
    log.success(`${r.agent} in ${box} moved from '${r.from}' to '${r.to}'${how}`);
    if (!r.restarted && r.how !== 'file') {
      log.info('the box is not running: the account applies at its next start');
    }
  });
}

// ---- use -------------------------------------------------------------------

export interface UseOpts {
  global?: boolean;
  clear?: boolean;
  json?: boolean;
}

/**
 * `credentials use`: no ref shows what a new box here gets per agent and where
 * it comes from; `use claude/work` sets this project's account (`--global`:
 * every project's); `use claude --clear` drops the setting.
 */
export async function useCommand(ref: string | undefined, opts: UseOpts): Promise<void> {
  const project = process.cwd();
  if (!ref) {
    if (opts.clear)
      throw new Error('name the agent to clear, e.g. `credentials use claude --clear`');
    const list = await loadList(project);
    if (!list) return;
    if (!list.defaults) {
      process.exitCode = 1;
      return;
    }
    const defaults = list.defaults;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ defaults }, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderDefaultsTable(defaults) + '\n');
    return;
  }
  const scope = opts.global ? 'global' : 'project';
  let agent: string;
  let account: string | null;
  if (opts.clear) {
    if (ref.includes('/'))
      throw new Error('--clear takes the agent alone, e.g. `use claude --clear`');
    agent = agentId(ref);
    account = null;
  } else {
    const parsed = parseAccountRef(ref);
    agent = agentId(parsed.agent);
    account = parsed.id;
  }
  await setDefault(agent, account, scope, project);
}

async function setDefault(
  agent: string,
  account: string | null,
  scope: 'global' | 'project',
  project: string,
): Promise<void> {
  await withHubClient(LOCAL, async (client) => {
    const defaults = await client.setAccountDefault({
      agent,
      account,
      scope,
      ...(scope === 'project' ? { project } : {}),
    });
    const d = defaults[agent];
    const where = scope === 'global' ? 'every project' : 'this project';
    log.success(
      account === null
        ? `cleared the ${scope} ${agent} account; new boxes here use ${agent}/${d?.account ?? 'default'}`
        : `new ${agent} boxes in ${where} use ${agent}/${account}`,
    );
    if (scope === 'global' && d?.source === 'project') {
      log.info(`this project keeps its own setting (${agent}/${d.account})`);
    }
  });
}

// ---- the TUI ---------------------------------------------------------------

function detailNote(a: HubApiAccount): string {
  return [
    `kind      ${KIND_TEXT[a.kind]}`,
    `identity  ${identityText(a) || '-'}`,
    `status    ${statusText(a)}`,
    `limits    ${limitsText(a) || '-'}`,
    `boxes     ${a.boxes.join(', ') || '-'}`,
  ].join('\n');
}

const KIND_NAME: Record<Kind, string> = {
  login: 'work',
  'setup-token': 'setup_token',
  'api-key': 'api_key',
};

/** The name a new account of `kind` is offered: the kind's, made free. */
export function suggestName(kind: Kind, taken: readonly string[]): string {
  const base = KIND_NAME[kind];
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.includes(`${base}_${String(i)}`)) return `${base}_${String(i)}`;
  }
}

async function tuiAdd(list: HubApiAccountList): Promise<void> {
  const agents = list.agents.filter((a) => a.kinds.length > 0);
  if (agents.length === 0) {
    log.info('No agent here can hold named accounts.');
    return;
  }
  const agent = await select({
    message: 'Which agent?',
    options: agents.map((a) => ({ value: a.id, label: a.id })),
  });
  if (isCancel(agent)) return;
  const kinds = agents.find((a) => a.id === agent)!.kinds;
  const kind = await select({
    message: 'What kind?',
    options: kinds.map((k) => ({
      value: k,
      label: KIND_TEXT[k],
      hint:
        k === 'login'
          ? 'sign in with the browser; boxes on it share one refreshing login'
          : k === 'setup-token'
            ? 'never refreshes, so several boxes can use it at once'
            : 'billed per token',
    })),
  });
  if (isCancel(kind)) return;
  const taken = list.accounts.filter((a) => a.agent === agent).map((a) => a.id);
  const typed = await text({
    message: 'Name (letters, digits and spaces; saved lowercase with _)',
    initialValue: suggestName(kind, taken),
    validate: (v) => {
      const n = normalizeAccountName(v ?? '');
      if (n.problem !== undefined) return n.problem;
      if (isDefaultAccount(n.name)) return "default is the agent's own login";
      if (taken.includes(n.name)) return `${agent}/${n.name} already exists`;
      return undefined;
    },
  });
  if (isCancel(typed)) return;
  const id = normalizeAccountName(typed).name!;
  log.step(`Name: ${agent}/${id}`);
  if (kind === 'login') await addLogin(agent, id, {});
  else await addPasted(agent, id, kind);
}

async function tuiMoveBox(client: HubApiClient, a: HubApiAccount): Promise<void> {
  const boxes = (await client.listBoxes()).filter((b) => {
    const agents = b.agents ?? (b.lastAgent ? [b.lastAgent] : []);
    return agents.includes(a.agent) && (b.accounts?.[a.agent] ?? 'default') !== a.id;
  });
  if (boxes.length === 0) {
    log.info(`No ${a.agent} box runs on another account.`);
    return;
  }
  const box = await select({
    message: `Move which box to ${a.agent}/${a.id}?`,
    options: boxes.map((b) => ({
      value: b.name ?? b.id,
      label: b.name ?? b.id,
      hint: `now on ${a.agent}/${b.accounts?.[a.agent] ?? 'default'}`,
    })),
  });
  if (isCancel(box)) return;
  await switchCommand(box, `${a.agent}/${a.id}`);
}

/** `canDefault`: the agent has an `<agent>.account` setting (opencode has none). */
async function tuiAccount(
  client: HubApiClient,
  a: HubApiAccount,
  canDefault: boolean,
): Promise<void> {
  note(detailNote(a), `${a.agent}/${a.id}`);
  const named = !isDefaultAccount(a.id);
  const options: Array<{ value: string; label: string; hint?: string }> = [];
  options.push(
    a.kind === 'login'
      ? { value: 'renew', label: 'Renew', hint: 'sign in again, then push the login to its boxes' }
      : { value: 'renew', label: 'Replace its token', hint: `paste a new ${KIND_TEXT[a.kind]}` },
  );
  if (canDefault && !a.default?.project) {
    options.push({ value: 'project', label: 'Use for this project' });
  }
  if (canDefault && !a.default?.global)
    options.push({ value: 'global', label: 'Use everywhere', hint: 'the global default' });
  if (canDefault) options.push({ value: 'move', label: 'Move a box to this account' });
  if (named) {
    options.push({
      value: 'rm',
      label: 'Remove',
      ...(a.boxes.length > 0 ? { hint: `used by ${a.boxes.join(', ')}` } : {}),
    });
  }
  options.push({ value: 'back', label: 'Back' });
  const action = await select({ message: `${a.agent}/${a.id}`, options });
  if (isCancel(action) || action === 'back') return;
  const ref = `${a.agent}/${a.id}`;
  try {
    switch (action) {
      case 'renew':
        await renewCommand(ref, {});
        return;
      case 'project':
        await setDefault(a.agent, a.id, 'project', process.cwd());
        return;
      case 'global':
        await setDefault(a.agent, isDefaultAccount(a.id) ? null : a.id, 'global', process.cwd());
        return;
      case 'move':
        await tuiMoveBox(client, a);
        return;
      case 'rm':
        if (a.boxes.length > 0) {
          log.warn(`${ref} is used by ${a.boxes.join(', ')}; move or destroy those boxes first`);
          return;
        }
        await removeCommand(ref, {});
        return;
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
  }
}

export async function runCredentialsTui(): Promise<void> {
  await withHubClient(LOCAL, async (client) => {
    let cursorAt: string | undefined;
    try {
      for (;;) {
        const s = spinner();
        s.start('Reading subscriptions');
        const list = await client.listAccounts({ project: process.cwd() });
        s.stop('Subscriptions read');
        const revoked = list.accounts.filter((a) => a.auth?.state === 'revoked').length;
        const accounts = sortAccounts(list.accounts);
        const now = Date.now();
        const picked = await tableSelect<string>({
          title: 'Subscriptions',
          subtitle: `${String(list.accounts.length)} account(s)${revoked > 0 ? `, ${String(revoked)} revoked` : ''}`,
          actions: [
            { value: '+add', label: 'Add an account…' },
            { value: '+use', label: 'What do new boxes here use?' },
          ],
          headers: ACCOUNT_HEADERS,
          // NAME, STATUS, KIND, DEFAULT, BOXES, LIMITS, IDENTITY: what a narrow terminal keeps.
          priority: [0, 3, 1, 5, 6, 4, 2],
          rows: accounts.map((a) => ({
            value: `${a.agent}/${a.id}`,
            cells: accountCells(a, now),
            tones: [undefined, undefined, undefined, statusTone(a)],
          })),
          emptyText:
            'No accounts yet. Sign in with `agentbox <agent> login`, or add a named one above.',
          ...(cursorAt ? { cursorAt } : {}),
        });
        if (picked.kind === 'quit') {
          outro('done');
          return;
        }
        if (picked.kind === 'cancel') {
          cancel('Cancelled.');
          process.exitCode = 130;
          return;
        }
        cursorAt = picked.value;
        if (picked.value === '+add') {
          await tuiAdd(list).catch((err: unknown) =>
            log.error(err instanceof Error ? err.message : String(err)),
          );
          continue;
        }
        if (picked.value === '+use') {
          note(renderDefaultsTable(list.defaults ?? {}), 'New boxes in this project');
          continue;
        }
        const a = list.accounts.find((x) => `${x.agent}/${x.id}` === picked.value);
        if (a)
          await tuiAccount(
            client,
            a,
            list.agents.some((g) => g.id === a.agent),
          );
      }
    } catch (err) {
      cancel(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
}

export { interactive as credentialsInteractive };
