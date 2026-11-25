// Switching a box's agent to another LLM account (hub settings Phase 3c).
//
// Two shapes, decided by the target account's kind:
//   - a pasted token (setup token, API key) is an env var: the box record moves,
//     the agent's tmux session is restarted with the token set and the other
//     auth vars cleared, and it resumes its conversation. Every provider whose
//     agent starts through exec takes this path (docker reads the record at the
//     exec, a cloud box gets its agent env file rewritten first).
//   - a login lives in the account's config volume. A docker box is rebuilt on
//     that volume (`recreateBoxOnAccount`); a cloud box is refused for now.
// The token's shape is checked first: claude ignores a malformed OAuth token and
// reads as logged out, with nothing saying why.
import {
  isDefaultAccount,
  primaryAgent,
  type AccountSwitchRecord,
  type AgentSyncSpec,
  type BoxRecord,
  type LlmAccountKind,
} from '@agentbox/core';

export type SwitchReason = AccountSwitchRecord['reason'];

export interface AccountSwitchDeps {
  findBox(ref: string): Promise<BoxRecord | null>;
  agentSpec(agent: string): AgentSyncSpec | undefined;
  /** The account's kind, or null when the store has no such account. */
  accountKind(agent: string, account: string): Promise<LlmAccountKind | null>;
  /** The env a box on `account` gets for `agent` (the token, for a pasted kind). */
  accountInject(agent: string, account: string): Promise<Record<string, string>>;
  /** The box's runtime state (`running`, `paused`, `stopped`, ...). */
  boxState(box: BoxRecord): Promise<string>;
  /** The agent's current session id in the box, when known. */
  sessionId(box: BoxRecord, agent: string): Promise<string | undefined>;
  /** Docker: rebuild the box on the account's volume (`recreated: false` = same volume). */
  recreate(
    box: BoxRecord,
    o: { agent: string; account: string; sessionId?: string; onLog: (l: string) => void },
  ): Promise<{ record: BoxRecord; recreated: boolean }>;
  /** Cloud: rewrite the agent env file from the (already moved) record. */
  rewriteCloudEnv(box: BoxRecord): Promise<void>;
  /** Kill the agent's session and start it again, resuming its conversation. */
  restartAgent(box: BoxRecord, agent: string): Promise<void>;
  recordSwitch(boxId: string, entry: AccountSwitchRecord): Promise<BoxRecord | undefined>;
  /** Undo the last `recordSwitch`: `accounts` back to `previous`, the entry dropped. */
  revertSwitch(
    boxId: string,
    previous: Record<string, string> | undefined,
  ): Promise<BoxRecord | undefined>;
  /** Re-register the box with the relay from its record (its `accounts`). */
  reregister(box: BoxRecord): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface SwitchRequest {
  agent?: string;
  account: string;
  reason?: SwitchReason;
}

export type SwitchResult =
  | {
      kind: 'ok';
      boxId: string;
      agent: string;
      from: string;
      to: string;
      how: AccountSwitchRecord['how'];
      /** False when the box was not running: the switch applies at its next start. */
      restarted: boolean;
    }
  | { kind: 'not_found' }
  | { kind: 'invalid'; error: string }
  | { kind: 'refused'; error: string }
  | { kind: 'error'; error: string };

const CLOUD_LOGIN_REFUSAL =
  'switching a cloud box to another login is not supported yet; use a setup token or API key';

/**
 * Why `token` is not a usable `kind` token for `spec`, or null. Pure. Never
 * echoes the token.
 */
export function tokenShapeProblem(
  spec: Pick<AgentSyncSpec, 'id' | 'accountTokenPattern'>,
  kind: Exclude<LlmAccountKind, 'login'>,
  token: string | undefined,
): string | null {
  if (!token) return `the ${kind} for this ${spec.id} account is missing; paste it again`;
  const pattern = spec.accountTokenPattern?.[kind];
  if (!pattern) return null;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  return re.test(token)
    ? null
    : `the stored ${kind} does not look like a ${spec.id} ${kind} (${spec.id} would ignore it); paste it again`;
}

/** The account `agent` ran on when the box was created. Pure. */
export function createdOn(
  box: Pick<BoxRecord, 'accounts' | 'accountSwitches'>,
  agent: string,
): string {
  return (
    (box.accountSwitches ?? []).find((s) => s.agent === agent)?.from ??
    box.accounts?.[agent] ??
    'default'
  );
}

/**
 * A registration carrying the record's accounts and nothing older: a box back
 * on `default` must not keep the named account it left, or the relay would
 * file its next login refresh under that account. Pure.
 */
export function withRecordAccounts<T extends { accounts?: Record<string, string> }>(
  reg: T,
  box: Pick<BoxRecord, 'accounts'>,
): T {
  const out = { ...reg };
  if (box.accounts && Object.keys(box.accounts).length > 0) out.accounts = { ...box.accounts };
  else delete out.accounts;
  return out;
}

/** True while a switch of `boxId` runs; lifecycle actions wait for it to end. */
export function isSwitchingAccount(boxId: string): boolean {
  return switching.has(boxId);
}

/** Boxes with a switch in progress: a second one (a click while the limit watch moves it) is refused. */
const switching = new Set<string>();

export async function switchBoxAccount(
  deps: AccountSwitchDeps,
  ref: string,
  req: SwitchRequest,
): Promise<SwitchResult> {
  const box = await deps.findBox(ref);
  if (!box) return { kind: 'not_found' };
  if (switching.has(box.id)) {
    return { kind: 'refused', error: `${box.name} is already switching accounts` };
  }
  switching.add(box.id);
  try {
    return await switchLocked(deps, box, req);
  } finally {
    switching.delete(box.id);
  }
}

async function switchLocked(
  deps: AccountSwitchDeps,
  box: BoxRecord,
  req: SwitchRequest,
): Promise<SwitchResult> {
  const agent = req.agent ?? primaryAgent(box);
  if (!agent || agent === 'none') return { kind: 'invalid', error: 'the box runs no agent' };
  const spec = deps.agentSpec(agent);
  if (!spec) return { kind: 'invalid', error: `unknown agent: ${agent}` };
  if (box.agents && !box.agents.includes(agent)) {
    return { kind: 'invalid', error: `${box.name} does not run ${agent}` };
  }
  const to = req.account.trim();
  if (!to) return { kind: 'invalid', error: 'account is required' };
  const from = box.accounts?.[agent] ?? 'default';
  if (from === to) return { kind: 'invalid', error: `${agent} already runs on ${to}` };

  // `default` is a login even when the store has no row for it yet.
  const kind = (await deps.accountKind(agent, to)) ?? (isDefaultAccount(to) ? 'login' : null);
  if (!kind) return { kind: 'invalid', error: `no ${agent} account '${to}'` };

  const provider = box.provider ?? 'docker';
  const isDocker = provider === 'docker';
  const state = await deps.boxState(box);
  if (state === 'missing') return { kind: 'refused', error: 'the box is missing' };
  const running = state === 'running';
  const reason = req.reason ?? 'manual';

  let how: AccountSwitchRecord['how'] = 'env';
  let current = box;
  try {
    if (kind === 'login' && !isDocker) {
      // The one login a cloud box can go back to is the one it was created on
      // and still holds: `default`, after a switch to a token.
      if (!isDefaultAccount(to) || !isDefaultAccount(createdOn(box, agent))) {
        return { kind: 'refused', error: CLOUD_LOGIN_REFUSAL };
      }
    } else if (kind === 'login') {
      if (state === 'paused') {
        return {
          kind: 'refused',
          error: 'the box is paused; resume it before switching its login',
        };
      }
      const sessionId = running ? await deps.sessionId(box, agent) : undefined;
      const r = await deps.recreate(box, { agent, account: to, sessionId, onLog: deps.log });
      if (r.recreated) {
        how = 'recreate';
        current = r.record;
      }
    } else {
      const envKey = spec.accountEnv?.[kind];
      if (!envKey) return { kind: 'invalid', error: `${agent} has no ${kind} accounts` };
      const inject = await deps.accountInject(agent, to);
      const problem = tokenShapeProblem(spec, kind, inject[envKey]);
      if (problem) return { kind: 'invalid', error: problem };
    }

    const entry: AccountSwitchRecord = {
      at: deps.now().toISOString(),
      agent,
      from,
      to,
      how,
      reason,
    };
    current = (await deps.recordSwitch(box.id, entry)) ?? current;
    await deps.reregister(current).catch((err: unknown) => {
      deps.log(`relay re-registration failed: ${errText(err)}`);
    });

    // A recreate restarted the box; its agent still has to come back. A box
    // that is not running picks the record up at its next start.
    let restarted = false;
    if (running) {
      try {
        if (!isDocker) await deps.rewriteCloudEnv(current);
        await deps.restartAgent(current, agent);
      } catch (err) {
        // A token switch changed nothing but the record: put it back and bring
        // the agent back on the old account. A rebuilt box IS on the new
        // volume, so its record stays.
        if (how === 'recreate') {
          return {
            kind: 'error',
            error: `${box.name} now runs on ${to}, but ${agent} did not restart: ${errText(err)}`,
          };
        }
        const back = (await deps.revertSwitch(box.id, box.accounts).catch(() => undefined)) ?? box;
        await deps.reregister(back).catch(() => undefined);
        try {
          if (!isDocker) await deps.rewriteCloudEnv(back);
          await deps.restartAgent(back, agent);
        } catch {
          /* reported below */
        }
        return {
          kind: 'error',
          error: `could not restart ${agent} on ${to}, so the box stays on ${from}: ${errText(err)}`,
        };
      }
      restarted = true;
    }
    return { kind: 'ok', boxId: box.id, agent, from, to, how, restarted };
  } catch (err) {
    return { kind: 'error', error: errText(err) };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
