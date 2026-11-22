/**
 * The shared half of `<agent> login --account …` (llm-accounts Phase 2): the
 * pasted kinds (`--api-key`, `--setup-token`) and the capture step every
 * named `login` ends with. Agent-neutral — each agent contributes only its
 * `runtime.accountIdentity` reader.
 */
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { isCancel, log, outro, password } from '@agentbox/cli-kit';
import { findAccount, type LlmAccountIdentity, type LlmAccountKind } from '@agentbox/core';
import {
  encodePastedSecret,
  pastedSecretProblem,
  readAccounts,
  removeAccount,
  resolveAgentSpec,
  upsertAccount,
  writeAccountSecret,
  type LoginAccountRequest,
} from '@agentbox/sandbox-core';
import { captureVolumeLogin, dockerVolumeFileReader } from '@agentbox/sandbox-docker';

export function describeIdentity(identity: LlmAccountIdentity | undefined): string {
  if (!identity) return '';
  const parts = [identity.email, identity.org, identity.plan].filter(
    (p): p is string => typeof p === 'string',
  );
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Store the login a named account's volume now holds; print the outcome. */
export async function captureAccountLogin(
  a: AgentCliSpec,
  o: { account: { id: string; label?: string }; volume: string; image: string },
): Promise<void> {
  const res = await captureVolumeLogin({
    spec: resolveAgentSpec(a.id),
    account: o.account,
    read: dockerVolumeFileReader(o.volume, o.image),
    ...(a.runtime.accountIdentity ? { identity: a.runtime.accountIdentity } : {}),
  });
  const who = describeIdentity(res.identity);
  if (res.written) {
    outro(`signed in as account '${o.account.id}'${who} — saved for boxes that select it`);
  } else {
    outro(`account '${o.account.id}'${who} is already up to date (${res.reason})`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

const KIND_NOUN: Record<Exclude<LlmAccountKind, 'login'>, string> = {
  'api-key': 'API key',
  'setup-token': 'setup token',
};

/**
 * Read a pasted secret: a hidden prompt on a terminal, otherwise stdin. Never
 * argv — a token on the command line lands in shell history and `ps`.
 */
async function readPastedSecret(noun: string): Promise<string | null> {
  if (process.stdin.isTTY) {
    const v = await password({ message: `Paste the ${noun}` });
    if (isCancel(v)) return null;
    return String(v).trim();
  }
  return (await readStdin()).trim();
}

/** `<agent> login --account <name> --api-key | --setup-token`. */
export async function runPastedAccountLogin(
  a: AgentCliSpec,
  req: LoginAccountRequest & { kind: Exclude<LlmAccountKind, 'login'> },
): Promise<void> {
  const noun = KIND_NOUN[req.kind];
  const token = await readPastedSecret(noun);
  if (token === null) {
    outro('cancelled');
    process.exit(1);
  }
  const problem = pastedSecretProblem(token);
  if (problem) {
    log.error(problem);
    process.exit(1);
  }
  const existing = findAccount(await readAccounts(), a.id, req.id);
  if (existing && existing.kind !== req.kind) {
    log.error(
      `account '${req.id}' is a ${existing.kind} account; remove it first (\`agentbox accounts rm ${a.id}/${req.id}\`)`,
    );
    process.exit(1);
  }
  const label = req.label ?? existing?.label;
  await upsertAccount({
    agent: a.id,
    id: req.id,
    kind: req.kind,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(label ? { label } : {}),
  });
  try {
    await writeAccountSecret(a.id, req.id, encodePastedSecret({ kind: req.kind, token }));
  } catch (err) {
    if (!existing) await removeAccount(a.id, req.id).catch(() => {});
    throw err;
  }
  outro(`saved the ${noun} as ${a.id} account '${req.id}'`);
}
