// Switching a box's agent to another LLM account (hub settings Phase 3c).
//
// Two shapes, decided by the target account's kind:
//   - a pasted token (setup token, API key) is an env var: the box record moves,
//     the agent's tmux session is restarted with the token set and the other
//     auth vars cleared, and it resumes its conversation. Every provider whose
//     agent starts through exec takes this path (docker reads the record at the
//     exec, a cloud box gets its agent env file rewritten first).
//   - a login is written into the box's OWN credential file (docker: the
//     per-box host file over the agent's path; cloud: the box-local file), so
//     no other box moves and nothing is rebuilt. An agent that re-reads the file
//     on every request (claude, `credential.liveReload`) keeps running; leaving a
//     token still restarts it, since the token's env var has to go
//     (docs/hot-switch-subscriptions-plan.md).
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
  /**
   * Write `account`'s stored login into the box's own credential file for
   * `agent`. Throws with a message a person can act on.
   */
  writeLogin(box: BoxRecord, agent: string, account: string): Promise<void>;
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

/**
 * Why `box` cannot take another login for `agent` in `state`, or null. Pure.
 * Docker writes a host file, so any state will do, but only a box created with
 * its own credential file has one. A cloud box is written over its transport,
 * so it must be up.
 */
export function loginSwitchRefusal(
  box: Pick<BoxRecord, 'name' | 'provider' | 'credentialFiles'>,
  spec: Pick<AgentSyncSpec, 'id' | 'credential'>,
  state: string,
): string | null {
  const agent = spec.id;
  if ((box.provider ?? 'docker') === 'docker') {
    if (!spec.credential?.bindMountable) {
      return `a docker box's ${agent} cannot switch to another login yet; use an API key`;
    }
    return box.credentialFiles?.includes(agent)
      ? null
      : `${box.name} was created before boxes had their own ${agent} login file; destroy and create it again to switch its login`;
  }
  return state === 'running'
    ? null
    : `${box.name} is ${state}; start it before switching its login`;
}

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
  // A switch restarts the agent unless it is login to login and the agent
  // re-reads its credential file on its own.
  let restart = true;
  if (kind === 'login') {
    const refusal = loginSwitchRefusal(box, spec, state);
    if (refusal) return { kind: 'refused', error: refusal };
    how = 'file';
    const fromKind = isDefaultAccount(from) ? 'login' : await deps.accountKind(agent, from);
    restart = !spec.credential?.liveReload || fromKind !== 'login';
  } else {
    const envKey = spec.accountEnv?.[kind];
    if (!envKey) return { kind: 'invalid', error: `${agent} has no ${kind} accounts` };
    const inject = await deps.accountInject(agent, to);
    const problem = tokenShapeProblem(spec, kind, inject[envKey]);
    if (problem) return { kind: 'invalid', error: problem };
  }

  const putBack = async (): Promise<void> => {
    const back = (await deps.revertSwitch(box.id, box.accounts).catch(() => undefined)) ?? box;
    await deps.reregister(back).catch(() => undefined);
    if (how === 'file') {
      await deps.writeLogin(back, agent, from).catch(() => undefined);
    }
    if (running && restart) {
      try {
        if (!isDocker) await deps.rewriteCloudEnv(back);
        await deps.restartAgent(back, agent);
      } catch {
        /* reported by the caller */
      }
    }
  };

  try {
    const entry: AccountSwitchRecord = {
      at: deps.now().toISOString(),
      agent,
      from,
      to,
      how,
      reason,
    };
    // The record moves before the file: a refresh the box ships in between is
    // then credited to the new account, and one of the old login is refused by
    // its identity (credentials-fanout).
    const current = (await deps.recordSwitch(box.id, entry)) ?? box;
    await deps.reregister(current).catch((err: unknown) => {
      deps.log(`relay re-registration failed: ${errText(err)}`);
    });

    if (how === 'file') {
      try {
        await deps.writeLogin(current, agent, to);
      } catch (err) {
        await putBack();
        return {
          kind: 'error',
          error: `could not write the ${to} login into ${box.name}, so it stays on ${from}: ${errText(err)}`,
        };
      }
    }

    // A box that is not running picks the record up at its next start.
    let restarted = false;
    if (running && restart) {
      try {
        if (!isDocker) await deps.rewriteCloudEnv(current);
        await deps.restartAgent(current, agent);
      } catch (err) {
        await putBack();
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
