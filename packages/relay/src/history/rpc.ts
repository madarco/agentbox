import type { BoxRegistration } from '../types.js';
import type { HistoryRelay } from './history-relay.js';

export interface HistoryRpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `history.config` / `history.chunk` for one authenticated box. The single
 * handler behind server.ts `/rpc` and the cloud executor. Always exit 0 with a
 * JSON answer, so the shipper can tell "disabled" from a transport failure.
 */
export async function runHistoryRpc(
  relay: HistoryRelay | null,
  reg: BoxRegistration,
  method: string,
  params: unknown,
): Promise<HistoryRpcResult> {
  const reply = (v: unknown): HistoryRpcResult => ({
    exitCode: 0,
    stdout: JSON.stringify(v),
    stderr: '',
  });
  if (method === 'history.config') {
    return reply(
      relay
        ? await relay.config(reg)
        : { enabled: false, reason: 'this relay has no hub', agents: [], credentialFiles: [] },
    );
  }
  if (method === 'history.chunk') {
    return reply(
      relay
        ? await relay.chunk(reg, params)
        : { ok: false, code: 'disabled', message: 'this relay has no hub' },
    );
  }
  return { exitCode: 64, stdout: '', stderr: `unknown history method '${method}'\n` };
}
