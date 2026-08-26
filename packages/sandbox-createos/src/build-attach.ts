/**
 * `buildCreateosAttach` - the CreateOS provider's override of
 * `Provider.buildAttach`.
 *
 * CreateOS has no AgentBox-managed SSH transport. The generic cloud scaffold's
 * SSH-style attach path is therefore unusable. Instead we drive the official
 * `createos` CLI's managed PTY command, mirroring the Vercel provider's CLI
 * attach shape.
 */

import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@agentbox/core';
import { hostTermForCloud, renderInnerCommand } from '@agentbox/sandbox-cloud';
import { detectCreateosCli } from './createos-cli.js';
import { readCreateOsCredStatus } from './credentials.js';

export function buildCreateosAttachArgv(args: {
  bin: string;
  sandboxId: string;
  kind: AttachKind;
  inner: string;
  detached?: boolean;
}): string[] {
  const interactive = (args.kind === 'shell' || args.kind === 'agent') && !args.detached;
  return [
    args.bin,
    'sandbox',
    'process',
    'run',
    '--cwd',
    '/workspace',
    ...(interactive ? ['--pty'] : []),
    args.sandboxId,
    '--',
    'sudo',
    '-u',
    'vscode',
    '-H',
    'bash',
    '-lc',
    args.inner,
  ];
}

export async function buildCreateosAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`createos box ${box.name} has no sandboxId - record is malformed`);
  }

  const det = detectCreateosCli();
  if (!det.installed || !det.bin) {
    throw new Error(
      'CreateOS interactive attach needs the `createos` CLI on PATH. Install it, then run `agentbox createos login`.',
    );
  }

  const cred = readCreateOsCredStatus();
  if (!cred.token) {
    throw new Error('CreateOS credentials not configured. Run `agentbox createos login` or set CREATEOS_API_KEY.');
  }

  const envPrelude = `export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=${hostTermForCloud()}; `;
  const inner = envPrelude + renderInnerCommand(kind, opts);

  return {
    argv: buildCreateosAttachArgv({
      bin: det.bin,
      sandboxId,
      kind,
      inner,
      detached: opts?.detached,
    }),
    env: { CREATEOS_API_KEY: cred.token },
  };
}

