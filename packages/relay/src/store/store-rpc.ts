import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import type { PromptRow, Store } from './store.js';

/**
 * A tiny RPC envelope over the {@link Store} interface, so a federated laptop
 * relay can back its state with a remote (hosted) Store over HTTP. The hosted
 * plane exposes `POST /admin/store` (admin-gated) and applies the op via
 * {@link applyStoreOp}; {@link RemoteStore} is the client that posts these.
 *
 * Generic-but-typed: a single switch keeps the dispatch type-safe (no `any`)
 * and the method names are an explicit allow-list — the endpoint can never
 * invoke an arbitrary property of the store object.
 */
export interface StoreRpcRequest {
  method: string;
  args: unknown[];
}

export interface StoreRpcResponse {
  /** Method return value (already JSON-safe — every Store method returns plain data). */
  result: unknown;
}

/** True when `method` is a dispatchable Store op. */
export function isStoreRpcMethod(method: string): boolean {
  return STORE_RPC_METHODS.has(method);
}

const STORE_RPC_METHODS = new Set<string>([
  'registerBox',
  'getBox',
  'authenticateBox',
  'listBoxes',
  'forgetBox',
  'countBoxes',
  'appendEvent',
  'listEvents',
  'countEvents',
  'setStatus',
  'getStatus',
  'deleteStatus',
  'listStatuses',
  'createPrompt',
  'getPrompt',
  'answerPrompt',
  'listPendingPrompts',
  'setPromptResult',
]);

/** Apply a store op by name with typed argument coercion. Throws on unknown method. */
export function applyStoreOp(store: Store, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'registerBox':
      return store.registerBox(args[0] as BoxRegistration);
    case 'getBox':
      return store.getBox(args[0] as string);
    case 'authenticateBox':
      return store.authenticateBox(args[0] as string);
    case 'listBoxes':
      return store.listBoxes();
    case 'forgetBox':
      return store.forgetBox(args[0] as string);
    case 'countBoxes':
      return store.countBoxes();
    case 'appendEvent':
      return store.appendEvent(args[0] as Omit<RelayEvent, 'id' | 'receivedAt'>);
    case 'listEvents':
      return store.listEvents(args[0] as number, args[1] as string | undefined);
    case 'countEvents':
      return store.countEvents();
    case 'setStatus':
      return store.setStatus(
        args[0] as string,
        args[1] as string,
        args[2] as number | undefined,
        args[3] as BoxStatusSnapshot,
      );
    case 'getStatus':
      return store.getStatus(args[0] as string);
    case 'deleteStatus':
      return store.deleteStatus(args[0] as string);
    case 'listStatuses':
      return store.listStatuses();
    case 'createPrompt':
      return store.createPrompt(args[0] as PromptRow);
    case 'getPrompt':
      return store.getPrompt(args[0] as string);
    case 'answerPrompt':
      return store.answerPrompt(
        args[0] as string,
        args[1] as 'y' | 'n',
        args[2] as boolean | undefined,
      );
    case 'listPendingPrompts':
      return store.listPendingPrompts(args[0] as string);
    case 'setPromptResult':
      return store.setPromptResult(args[0] as string, args[1] as GitRpcResult);
    default:
      throw new Error(`unknown store op: ${method}`);
  }
}
