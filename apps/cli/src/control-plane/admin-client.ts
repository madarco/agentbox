/**
 * The PC's admin-bearer client for a configured control box. It reads
 * cross-machine shared state (registry, statuses) through the relay's generic
 * `/admin/store` RPC (via {@link RemoteStore}), lists + answers approvals through
 * `/admin/prompts` (block-mode, reachable non-loopback with the admin bearer),
 * and reaps a box's control-box state through `DELETE /remote/boxes/:boxId`.
 *
 * Docker boxes are never here: they register on the laptop loopback relay and
 * stay entirely local. This client only ever talks to the remote control box.
 */
import { RemoteStore } from '@agentbox/relay';
import type { BoxRegistration, PromptAskEvent } from '@agentbox/relay';

export interface ControlPlaneTarget {
  url: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
}

/** One pending approval, tagged with the box that raised it. */
export interface PendingPrompt {
  boxId: string;
  boxName: string;
  prompt: PromptAskEvent;
}

export interface ReapResult {
  boxId: string;
  removed: boolean;
  custodyRemoved: number;
}

export class ControlPlaneAdminClient {
  readonly store: RemoteStore;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(target: ControlPlaneTarget) {
    this.base = target.url.replace(/\/+$/, '');
    this.token = target.adminToken;
    this.fetchImpl = target.fetchImpl ?? fetch;
    this.store = new RemoteStore({
      baseUrl: this.base,
      adminToken: this.token,
      fetchImpl: this.fetchImpl,
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  /** All boxes registered on the control box. */
  listBoxes(): Promise<BoxRegistration[]> {
    return this.store.listBoxes();
  }

  getBox(boxId: string): Promise<BoxRegistration | undefined> {
    return this.store.getBox(boxId);
  }

  /** Pending approvals for one box (block-mode; `/admin/prompts?boxId=`). */
  async promptsForBox(boxId: string): Promise<PromptAskEvent[]> {
    const res = await this.fetchImpl(
      `${this.base}/admin/prompts?boxId=${encodeURIComponent(boxId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`list prompts for ${boxId} failed: ${res.status} ${await safeText(res)}`);
    return ((await res.json()) as { prompts: PromptAskEvent[] }).prompts;
  }

  /** Every pending approval across all control-plane boxes, tagged with its box. */
  async pendingPrompts(): Promise<PendingPrompt[]> {
    const boxes = await this.listBoxes();
    const out: PendingPrompt[] = [];
    for (const box of boxes) {
      const prompts = await this.promptsForBox(box.boxId).catch(() => []);
      for (const prompt of prompts) out.push({ boxId: box.boxId, boxName: box.name, prompt });
    }
    return out;
  }

  /** Answer a pending approval by id. Returns true when it resolved a pending row. */
  async answerPrompt(id: string, answer: 'y' | 'n', cancelled = false): Promise<boolean> {
    const res = await this.fetchImpl(`${this.base}/admin/prompts/answer`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ id, answer, cancelled }),
    });
    if (res.status === 204) return true;
    if (res.status === 404) return false;
    throw new Error(`answer prompt ${id} failed: ${res.status} ${await safeText(res)}`);
  }

  /** Reap a box's control-box state (registration + status + SSH-key custody). */
  async reapBox(boxId: string): Promise<ReapResult> {
    const res = await this.fetchImpl(`${this.base}/remote/boxes/${encodeURIComponent(boxId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return { boxId, removed: false, custodyRemoved: 0 };
    if (!res.ok) throw new Error(`reap box ${boxId} failed: ${res.status} ${await safeText(res)}`);
    return (await res.json()) as ReapResult;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
