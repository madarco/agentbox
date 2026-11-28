/**
 * Host-side handler for the ctl credential watcher's `credentials-updated`
 * events (see `packages/ctl/src/credentials-watcher.ts`). Claude's OAuth
 * refresh rotates the refresh token, so the moment one box refreshes, every
 * other copy (host backup, other boxes) is dead — this accepts the freshest
 * blob into `~/.agentbox/<agent>-credentials.json` (newest-wins) and fans it
 * out to all other boxes by spawning the host CLI
 * (`agentbox credentials propagate`), the same decoupling as the relay's
 * checkpoint/cp handlers.
 *
 * The payload carries a secret: callers must never append these events to the
 * event ring buffer (mirrors how `box-status` skips the ring).
 *
 * Concurrency: per-agent debounce (bursts collapse to one fan-out) + a
 * per-agent promise chain (fan-outs never overlap; a fresh accept during an
 * in-flight run schedules one more). The spawned CLI always reads the
 * *current* backup, so collapsed runs lose nothing.
 */

import { execa } from 'execa';
import { chmod, mkdir } from 'node:fs/promises';
import { tryGetMachineId } from '@agentbox/config';
import { dirname } from 'node:path';
import {
  accountCustodyPath,
  accountSecretPath,
  DEFAULT_ACCOUNT_ID,
  findAccount,
  isDefaultAccount,
  namedAccounts,
} from '@agentbox/core';
import {
  IDENTITY_MISMATCH,
  parseCredentialsUpdate,
  readCredentialBackup,
  resolveAgentSpec,
  shouldAcceptCredentialUpdate,
  STATE_DIR,
  writeCredentialBackup,
  type CredentialAgentKind,
  readAccounts,
  withAccountsLock,
  readState,
} from '@agentbox/sandbox-core';

/**
 * `boxAccountFor`'s answer when the source box's account cannot be determined
 * (the registry is unreadable). Such an update cannot be routed, so it is
 * dropped — never written to the default login.
 */
export const UNVERIFIABLE_ACCOUNT = '(unverifiable: box registry unreadable)';

/** Mirrors `CREDENTIALS_UPDATED_EVENT` in @agentbox/ctl (like `box-status`). */
export const CREDENTIALS_UPDATED_EVENT = 'credentials-updated';

export interface CredentialsFanoutDeps {
  log: (msg: string) => void;
  /** Debounce before spawning the propagate CLI. Default 3000ms. */
  debounceMs?: number;
  /** Override the fan-out spawn (tests). Default: spawn the host CLI. */
  runPropagate?: (
    agent: CredentialAgentKind,
    sourceBoxId: string,
    account: string,
  ) => Promise<void>;
  /**
   * Put `account`'s stored login back into box `boxId` (it shipped another
   * login's blob). Override for tests; default: `credentials propagate --box`.
   */
  runRepush?: (agent: CredentialAgentKind, boxId: string, account: string) => Promise<void>;
  /** Least time between two re-pushes to one box (default 60s), so a loop can't spin. */
  repushIntervalMs?: number;
  /**
   * When `agent` in box `boxId` last switched accounts (ms epoch) and the
   * account it left, or undefined. Override for tests; default: the box
   * record's `accountSwitches`.
   */
  lastSwitch?: (boxId: string, agent: CredentialAgentKind) => Promise<LastSwitch | undefined>;
  /** Override the DEFAULT account's backup path (tests; default: the registry's). */
  backupPathFor?: (agent: CredentialAgentKind) => string;
  /**
   * Override a NAMED account's backup path (tests; default: the account store's
   * `credentials/<agent>/<id>.json`).
   */
  accountBackupPathFor?: (agent: CredentialAgentKind, account: string) => string;
  /**
   * The kind of a named account in the store, or undefined when it has none
   * (tests; default: `~/.agentbox/accounts.json`). Only a `login` account takes
   * a login update.
   */
  accountKindFor?: (agent: CredentialAgentKind, account: string) => Promise<string | undefined>;
  /**
   * The control box's custody store, when this relay owns one. Present ⇒ an
   * accepted credential is mirrored into `agents/<id>/…` so the next hub create
   * seeds from a current copy rather than the last one a PC pushed.
   */
  custody?: CredentialCustodyWriter | null;
  /**
   * The account `agent` runs on in box `boxId` (from its record), or undefined
   * for `default`. Override for tests; default: `~/.agentbox/state.json`.
   */
  boxAccountFor?: (boxId: string, agent: CredentialAgentKind) => Promise<string | undefined>;
  /** Run under the accounts lock. Override for tests; default: the store's lock. */
  accountsLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * The machine a box was built for (its registration `originMachineId`): a
   * named account belongs to that machine's store, so its custody copy is keyed
   * by it. Default: this relay's own machine.
   */
  originMachineFor?: (boxId: string) => Promise<string | undefined>;
}

/**
 * Fails CLOSED: when the box registry cannot be read, the update is treated as
 * coming from a named account and dropped. A box that cannot be checked must
 * not be able to overwrite the default login everywhere; a default box simply
 * re-posts on its next refresh.
 */
export async function stateBoxAccount(boxId: string, agent: string): Promise<string | undefined> {
  let state;
  try {
    state = await readState();
  } catch {
    return UNVERIFIABLE_ACCOUNT;
  }
  const box = state.boxes.find((b) => b.id === boxId);
  return namedAccounts(box?.accounts)?.[agent];
}

/**
 * The account `agent` runs on in box `boxId`: the box's REGISTRATION first,
 * then `state.json`. A registration store that fails to answer is not "no
 * registration" (#442 review): the update is unverifiable, so it can never
 * route a named box's login into the default account. An absent registration
 * (a docker box the PC hub never registered) falls through to `state.json`.
 */
export async function registrationBoxAccount(
  store: { getBox(boxId: string): Promise<{ accounts?: Record<string, string> } | undefined> },
  boxId: string,
  agent: string,
): Promise<string | undefined> {
  let reg: { accounts?: Record<string, string> } | undefined;
  try {
    reg = await store.getBox(boxId);
  } catch {
    return UNVERIFIABLE_ACCOUNT;
  }
  return namedAccounts(reg?.accounts)?.[agent] ?? (await stateBoxAccount(boxId, agent));
}

/** How long after a switch a mismatched login is taken for a refresh race. */
export const SWITCH_RACE_WINDOW_MS = 10 * 60_000;

export interface LastSwitch {
  at: number;
  from: string;
}

async function stateLastSwitch(boxId: string, agent: string): Promise<LastSwitch | undefined> {
  const box = (await readState()).boxes.find((b) => b.id === boxId);
  const last = (box?.accountSwitches ?? []).filter((s) => s.agent === agent).at(-1);
  const at = last ? Date.parse(last.at) : NaN;
  return last && Number.isFinite(at) ? { at, from: last.from } : undefined;
}

/** The single write this needs from a custody store (structural: no import cycle). */
export interface CredentialCustodyWriter {
  put(path: string, data: Buffer): Promise<unknown>;
}

export interface CredentialsHandleResult {
  accepted: boolean;
  reason: string;
}

export class CredentialsFanout {
  private readonly log: (msg: string) => void;
  private readonly debounceMs: number;
  private readonly runPropagate: (
    agent: CredentialAgentKind,
    sourceBoxId: string,
    account: string,
  ) => Promise<void>;
  private readonly backupPathFor?: (agent: CredentialAgentKind) => string;
  private readonly accountBackupPathFor: (agent: CredentialAgentKind, account: string) => string;
  private readonly originMachineFor: (boxId: string) => Promise<string | undefined>;
  private readonly accountKindFor: (
    agent: CredentialAgentKind,
    account: string,
  ) => Promise<string | undefined>;
  private readonly custody: CredentialCustodyWriter | null;
  private readonly boxAccountFor: (
    boxId: string,
    agent: CredentialAgentKind,
  ) => Promise<string | undefined>;
  private readonly runRepush: (
    agent: CredentialAgentKind,
    boxId: string,
    account: string,
  ) => Promise<void>;
  private readonly repushIntervalMs: number;
  private readonly lastRepush = new Map<string, number>();
  private readonly lastSwitch: (
    boxId: string,
    agent: CredentialAgentKind,
  ) => Promise<LastSwitch | undefined>;
  private readonly accountsLock: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: CredentialsFanoutDeps) {
    this.log = deps.log;
    this.debounceMs = deps.debounceMs ?? 3_000;
    this.runPropagate = deps.runPropagate ?? defaultRunPropagate;
    this.runRepush = deps.runRepush ?? defaultRunRepush;
    this.repushIntervalMs = deps.repushIntervalMs ?? 60_000;
    this.lastSwitch = deps.lastSwitch ?? stateLastSwitch;
    this.backupPathFor = deps.backupPathFor;
    this.accountKindFor =
      deps.accountKindFor ??
      (async (agent, account) => findAccount(await readAccounts(), agent, account)?.kind);
    this.accountBackupPathFor =
      deps.accountBackupPathFor ??
      ((agent, account) => {
        const path = accountSecretPath(resolveAgentSpec(agent), account, STATE_DIR);
        if (!path) throw new Error(`agent '${agent}' declares no credential`);
        return path;
      });
    this.custody = deps.custody ?? null;
    this.accountsLock = deps.accountsLock ?? ((fn) => withAccountsLock(fn));
    this.boxAccountFor = deps.boxAccountFor ?? stateBoxAccount;
    this.originMachineFor = deps.originMachineFor ?? (() => Promise.resolve(undefined));
  }

  /**
   * Validate, newest-wins-gate, persist the host backup, and schedule the
   * fan-out. Fast (no box I/O); the propagate CLI does the slow work detached.
   */
  async handle(sourceBoxId: string, payload: unknown): Promise<CredentialsHandleResult> {
    const update = parseCredentialsUpdate(payload);
    if (!update) return { accepted: false, reason: 'invalid payload' };
    // Route by the SOURCE box's account (llm-accounts Phase 4): a box on a
    // named account holds that account's login, so it updates that account's
    // copy and fans out to that account's boxes only. ctl never names the
    // account — this lookup is why old images route correctly.
    const named = await this.boxAccountFor(sourceBoxId, update.agent);
    if (named === UNVERIFIABLE_ACCOUNT) {
      this.log(
        `credentials: ignored ${update.agent} update from box ${sourceBoxId} (its account cannot be verified)`,
      );
      return { accepted: false, reason: 'account unverifiable' };
    }
    const account = named ?? DEFAULT_ACCOUNT_ID;
    const verdict = await this.acceptFor(update.agent, account, update.content, sourceBoxId);
    if (verdict.reason === IDENTITY_MISMATCH) {
      await this.onIdentityMismatch(update.agent, sourceBoxId, account, update.content);
    }
    return verdict;
  }

  /**
   * Gate `content` against `account`'s stored copy and, when it wins, store it,
   * mirror it into custody and schedule the account's fan-out.
   */
  private async acceptFor(
    agent: CredentialAgentKind,
    account: string,
    content: string,
    sourceBoxId: string,
  ): Promise<CredentialsHandleResult> {
    const isDefault = isDefaultAccount(account);
    // A named account's row check and its write are one step under the
    // accounts lock, so an `accounts rm` cannot land between them and leave a
    // secret with no row (the store's own writer takes the same lock).
    const stored = await (isDefault
      ? this.storeLogin(agent, account, content, sourceBoxId)
      : this.accountsLock(() => this.storeLogin(agent, account, content, sourceBoxId)));
    if (!stored.accepted) return stored;
    const verdict = stored;
    await this.recordInCustody(agent, account, content, sourceBoxId);
    const label = isDefault ? agent : `${agent} account '${account}'`;
    this.log(
      `credentials: accepted ${label} update from box ${sourceBoxId} (${verdict.reason}); fan-out in ${String(this.debounceMs)}ms`,
    );
    this.schedule(agent, account, sourceBoxId);
    return { accepted: true, reason: verdict.reason };
  }

  /**
   * Gate `content` against the account's stored copy and write it when it wins.
   * Only a LOGIN account takes a login: a pasted-kind account's secret is its
   * token (a login there would replace it and break every box on it), and an
   * account the store no longer has must not be re-created by a late update
   * (`credentials rm` already removed it).
   */
  private async storeLogin(
    agent: CredentialAgentKind,
    account: string,
    content: string,
    sourceBoxId: string,
  ): Promise<CredentialsHandleResult> {
    const isDefault = isDefaultAccount(account);
    if (!isDefault) {
      const kind = await this.accountKindFor(agent, account).catch(() => undefined);
      if (kind !== 'login') {
        this.log(
          `credentials: ignored ${agent} update from box ${sourceBoxId} (account '${account}' is ${kind ?? 'not in the store'})`,
        );
        return { accepted: false, reason: `account '${account}' is ${kind ?? 'unknown'}` };
      }
    }
    const backupPath = isDefault
      ? this.backupPathFor?.(agent)
      : this.accountBackupPathFor(agent, account);
    const existing = await readCredentialBackup(agent, { backupPath });
    const verdict = shouldAcceptCredentialUpdate(agent, content, existing);
    if (!verdict.accept) return { accepted: false, reason: verdict.reason };
    if (!isDefault && backupPath) {
      // The account store's dir is owner-only, like `writeAccountSecret`'s.
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(backupPath), 0o700).catch(() => {});
    }
    await writeCredentialBackup(agent, content, { backupPath });
    return { accepted: true, reason: verdict.reason };
  }

  /**
   * Mirror the accepted blob into custody, on a control box.
   *
   * Without this the freshest token lives ONLY in the host backup, and the next
   * hub create re-seeds that backup from custody — a copy that is only as new as
   * the last PC push. Since a refresh rotates the token, every box built after
   * that came up with a dead credential. Writing here is what makes custody
   * self-healing: the boxes refreshing their own tokens keep it current with no
   * PC involvement.
   *
   * Best-effort by design — a custody failure must not cost us the fan-out,
   * which is the part that fixes the boxes that are already running.
   */
  private async recordInCustody(
    agent: CredentialAgentKind,
    account: string,
    content: string,
    sourceBoxId: string,
  ): Promise<void> {
    if (!this.custody) return;
    try {
      const spec = resolveAgentSpec(agent);
      // An agent that declares no credential has nothing to mirror. Unreachable
      // via `handle` (`parseCredentialsUpdate` rejects such an agent), but this
      // is the write to custody -- the copy every later create seeds from -- so
      // it checks rather than trusting its caller.
      if (!spec.credential) return;
      const machine = isDefaultAccount(account)
        ? undefined
        : ((await this.originMachineFor(sourceBoxId).catch(() => undefined)) ?? tryGetMachineId());
      await this.custody.put(
        accountCustodyPath(agent, account, spec.credential.boxRelPath, machine),
        Buffer.from(content, 'utf8'),
      );
    } catch (err) {
      this.log(
        `credentials: could not record ${agent} in custody: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The box holds another login than its record's account. Shortly after a
   * switch, a blob of the account it LEFT is a refresh of that login written
   * back by a request in flight: it is credited to that account (its refresh
   * token rotated, so the stored copy is now dead) and the record's account
   * goes back in, because the record is what the user chose. Any other login
   * is a person's own sign-in inside the box, which it keeps; it just never
   * reaches the account's other boxes.
   */
  private async onIdentityMismatch(
    agent: CredentialAgentKind,
    boxId: string,
    account: string,
    content: string,
  ): Promise<void> {
    const last = await this.lastSwitch(boxId, agent).catch(() => undefined);
    if (last && Date.now() - last.at <= SWITCH_RACE_WINDOW_MS && last.from !== account) {
      const r = await this.acceptFor(agent, last.from, content, boxId);
      // Accepted, unchanged or older: it is the left account's login either way.
      if (r.reason !== IDENTITY_MISMATCH && !r.reason.startsWith('account ')) {
        this.repush(agent, boxId, account);
        return;
      }
    }
    this.log(
      `credentials: box ${boxId} signed in another ${agent} login than account '${account}'; not fanned out`,
    );
  }

  private repush(agent: CredentialAgentKind, boxId: string, account: string): void {
    const key = `${agent}\u0000${boxId}`;
    const now = Date.now();
    if (now - (this.lastRepush.get(key) ?? -Infinity) < this.repushIntervalMs) return;
    this.lastRepush.set(key, now);
    this.log(
      `credentials: box ${boxId} holds another ${agent} login than account '${account}'; putting the account's back`,
    );
    this.runRepush(agent, boxId, account).catch((err: unknown) => {
      this.log(
        `credentials: ${agent} re-push to box ${boxId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Debounce + serialize per (agent, account): two accounts never share a chain. */
  private schedule(agent: CredentialAgentKind, account: string, sourceBoxId: string): void {
    const key = `${agent}\u0000${account}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      const prev = this.chains.get(key) ?? Promise.resolve();
      const next = prev
        .then(() => this.runPropagate(agent, sourceBoxId, account))
        .catch((err: unknown) => {
          this.log(
            `credentials: ${agent} (${account}) fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      this.chains.set(key, next);
    }, this.debounceMs);
    timer.unref();
    this.pending.set(key, timer);
  }

  /** Pending debounce timers + in-flight chain, for tests/shutdown. */
  async flush(): Promise<void> {
    for (const [agent, timer] of this.pending) {
      clearTimeout(timer);
      this.pending.delete(agent);
      void agent;
    }
    await Promise.all([...this.chains.values()]);
  }
}

/**
 * Spawn `agentbox credentials propagate` via the CLI entry the daemon was
 * started with — the CLI owns provider resolution and per-box transports
 * (same pattern as the checkpoint/cp host actions).
 */
async function defaultRunPropagate(
  agent: CredentialAgentKind,
  sourceBoxId: string,
  account: string,
): Promise<void> {
  await runPropagateCli(agent, ['--source-box', sourceBoxId], account);
}

async function defaultRunRepush(
  agent: CredentialAgentKind,
  boxId: string,
  account: string,
): Promise<void> {
  await runPropagateCli(agent, ['--box', boxId], account);
}

async function runPropagateCli(
  agent: CredentialAgentKind,
  target: string[],
  account: string,
): Promise<void> {
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) {
    throw new Error('AGENTBOX_CLI_ENTRY not set; cannot run credential propagate host-side');
  }
  const result = await execa(
    process.execPath,
    [
      entry,
      'credentials',
      'propagate',
      '--agent',
      agent,
      ...target,
      // Only for a named account: an older CLI then still parses a default
      // fan-out, which is the only kind it can route.
      ...(isDefaultAccount(account) ? [] : ['--account', account]),
    ],
    { reject: false, timeout: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `credentials propagate exited ${String(result.exitCode)}: ${String(result.stderr).slice(-300)}`,
    );
  }
}
