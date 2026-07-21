import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import type { PromptRow, Store } from './store.js';
import type { StoreRpcResponse } from './store-rpc.js';

/**
 * A {@link Store} backed by a remote hosted control plane over HTTP. A federated
 * laptop relay uses this so its registry / prompts / events / status live
 * centrally (one cross-machine view) while it still executes host-local actions
 * locally. Each method is one admin-bearer `POST /admin/store {method, args}`.
 *
 * `fetch` (Node 20+) is used directly; inject one for tests.
 */
export interface RemoteStoreOptions {
  /** Base URL of the hosted control plane (e.g. https://plane.example.com). */
  baseUrl: string;
  /** Admin bearer for `/admin/store`. */
  adminToken: string;
  fetchImpl?: typeof fetch;
}

export class RemoteStore implements Store {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteStoreOptions) {
    this.url = `${opts.baseUrl.replace(/\/$/, '')}/admin/store`;
    this.token = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<R>(method: string, args: unknown[]): Promise<R> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ method, args }),
    });
    if (!res.ok) {
      throw new Error(`remote store ${method} → ${String(res.status)}`);
    }
    const body = (await res.json()) as StoreRpcResponse;
    return body.result as R;
  }

  registerBox(reg: BoxRegistration): Promise<void> {
    return this.call('registerBox', [reg]);
  }
  getBox(boxId: string): Promise<BoxRegistration | undefined> {
    return this.call<BoxRegistration | null>('getBox', [boxId]).then((r) => r ?? undefined);
  }
  authenticateBox(token: string): Promise<BoxRegistration | null> {
    return this.call('authenticateBox', [token]);
  }
  listBoxes(): Promise<BoxRegistration[]> {
    return this.call('listBoxes', []);
  }
  forgetBox(boxId: string): Promise<boolean> {
    return this.call('forgetBox', [boxId]);
  }
  countBoxes(): Promise<number> {
    return this.call('countBoxes', []);
  }

  appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent> {
    return this.call('appendEvent', [input]);
  }
  listEvents(since: number, boxId?: string): Promise<RelayEvent[]> {
    return this.call('listEvents', [since, boxId]);
  }
  countEvents(): Promise<number> {
    return this.call('countEvents', []);
  }

  setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    return this.call('setStatus', [boxId, name, projectIndex, status]);
  }
  getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined> {
    return this.call<BoxStatusSnapshot | null>('getStatus', [boxId]).then((r) => r ?? undefined);
  }
  deleteStatus(boxId: string): Promise<void> {
    return this.call('deleteStatus', [boxId]);
  }

  createPrompt(row: PromptRow): Promise<void> {
    return this.call('createPrompt', [row]);
  }
  getPrompt(promptId: string): Promise<PromptRow | null> {
    return this.call('getPrompt', [promptId]);
  }
  answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean> {
    return this.call('answerPrompt', [promptId, answer, cancelled]);
  }
  listPendingPrompts(boxId: string): Promise<PromptRow[]> {
    return this.call('listPendingPrompts', [boxId]);
  }
  setPromptResult(promptId: string, result: GitRpcResult): Promise<void> {
    return this.call('setPromptResult', [promptId, result]);
  }
}
