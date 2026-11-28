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
  o: { account: { id: string }; volume: string; image: string },
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

/**
 * Read a secret off a pipe. Ends at EOF, or once a full line has arrived and
 * the pipe then stays quiet for `idleMs`: a driver that writes the token and
 * never closes its end would otherwise hang the command forever. A pipe that
 * sends nothing within `firstByteMs` is an error rather than a hang.
 */
export function readSecretFromStream(
  stream: NodeJS.ReadableStream,
  opts: { idleMs?: number; firstByteMs?: number } = {},
): Promise<string> {
  const idleMs = opts.idleMs ?? 1_500;
  const firstByteMs = opts.firstByteMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const finish = (err?: Error): void => {
      if (timer) clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.pause();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.from(chunk));
      if (timer) clearTimeout(timer);
      if (Buffer.concat(chunks).includes(0x0a)) timer = setTimeout(() => finish(), idleMs);
    };
    const onEnd = (): void => finish();
    const onError = (err: Error): void => finish(err);
    timer = setTimeout(
      () =>
        finish(
          new Error(
            'no secret on stdin: pipe it in (`... < token.txt`) or run on a terminal for a hidden prompt',
          ),
        ),
      firstByteMs,
    );
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}

function readStdin(): Promise<string> {
  // Destroyed after: a still-open pipe would otherwise keep the process alive.
  return readSecretFromStream(process.stdin).finally(() => process.stdin.destroy());
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
