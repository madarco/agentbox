/**
 * The shared half of `agentbox credentials add` (llm-accounts Phase 2,
 * docs/credentials-tui-plan.md): reading a pasted secret and the capture step
 * every named login ends with. Agent-neutral — each agent contributes only its
 * `runtime.accountIdentity` reader.
 */
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { isCancel, outro, password } from '@agentbox/cli-kit';
import { type LlmAccountIdentity, type LlmAccountKind } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
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

export const PASTED_KIND_NOUN: Record<Exclude<LlmAccountKind, 'login'>, string> = {
  'api-key': 'API key',
  'setup-token': 'setup token',
};

/**
 * Read a pasted secret: a hidden prompt on a terminal, otherwise stdin. Never
 * argv — a token on the command line lands in shell history and `ps`. Null
 * when the prompt was cancelled.
 */
export async function readPastedSecret(noun: string): Promise<string | null> {
  if (process.stdin.isTTY) {
    const v = await password({ message: `Paste the ${noun}` });
    if (isCancel(v)) return null;
    return String(v).trim();
  }
  return (await readStdin()).trim();
}
