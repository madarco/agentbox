import { homedir } from 'node:os';
import { loadEffectiveConfig, tryGetMachineId } from '@agentbox/config';
import {
  HistoryShipper,
  createRedactor,
  type HistoryFrame,
  type HistoryIngestResult,
  type HistoryIngestSink,
  type HistoryOrigin,
  type Redactor,
  type ShipStats,
  type ShippedAgent,
} from '@agentbox/core';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import type { BoxRegistration } from '../types.js';
import { dockerHistorySource, type DockerRunner } from './docker-source.js';
import { collectHostSecrets } from './host-secrets.js';

/**
 * The relay's half of session history (docs/agent-history-plan.md, Phase 1):
 *
 *  - ships docker boxes itself, reading each box over `docker exec`;
 *  - answers the in-box shipper's `history.config` / `history.chunk` RPCs for
 *    every other provider (server.ts `/rpc` and the cloud executor both land
 *    here, so the two paths cannot drift);
 *  - redacts every frame with the host's exact secret values before the sink.
 *
 * The sink is the hub's history service, handed in by the hub's server. A relay
 * with no sink (one running without a hub) answers `disabled`.
 */

/** Box paths are fixed: the box user is always `vscode`. */
const BOX_PROJECT_KEY = '-workspace';
const SECRETS_TTL_MS = 5 * 60_000;
const CAPTURE_TTL_MS = 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface HistoryConfigReply {
  enabled: boolean;
  reason?: string;
  agents: ShippedAgent[];
  credentialFiles: string[];
}

export interface HistoryRelayDeps {
  sink: HistoryIngestSink;
  listBoxes(): Promise<BoxRegistration[]>;
  log(line: string): void;
  intervalMs?: number;
  /** Tests: docker CLI and project-config seams. */
  dockerRun?: DockerRunner;
  captureEnabled?: (reg: BoxRegistration) => Promise<boolean>;
  hostSecrets?: () => Promise<string[]>;
}

/** Every agent whose registry row declares a `history` block. */
export function shippedAgents(): ShippedAgent[] {
  const out: ShippedAgent[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    const dir = spec.staticPaths[0]?.boxDir;
    if (!spec.history || !dir) continue;
    out.push({ agent: spec.id, configDir: dir, projectKey: BOX_PROJECT_KEY, spec: spec.history });
  }
  return out;
}

export function isDockerBox(reg: BoxRegistration): boolean {
  return reg.kind !== 'cloud' && typeof reg.containerName === 'string' && reg.containerName !== '';
}

function originOf(reg: BoxRegistration): HistoryOrigin {
  const hostId = tryGetMachineId();
  return {
    boxId: reg.boxId,
    boxName: reg.name,
    provider: isDockerBox(reg) ? 'docker' : (reg.backend ?? 'cloud'),
    ...(hostId ? { hostId } : {}),
    ...(reg.originUrl ? { projectRepoUrl: reg.originUrl } : {}),
  };
}

const captureCache = new Map<string, { at: number; value: boolean }>();

/** `history.capture` for the box's project (the opt-out), else the global default. */
export async function projectCaptureEnabled(reg: BoxRegistration): Promise<boolean> {
  const root = reg.worktrees?.[0]?.hostMainRepo || homedir();
  const hit = captureCache.get(root);
  if (hit && Date.now() - hit.at < CAPTURE_TTL_MS) return hit.value;
  let value = true;
  try {
    value = (await loadEffectiveConfig(root)).effective.history.capture !== false;
  } catch {
    /* unreadable config: keep the default (on) */
  }
  captureCache.set(root, { at: Date.now(), value });
  return value;
}

export class HistoryRelay {
  private readonly shippers = new Map<
    string,
    { container: string; source: ReturnType<typeof dockerHistorySource>; shipper: HistoryShipper }
  >();
  private redactor: Redactor = createRedactor();
  private redactorAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly captureEnabled: (reg: BoxRegistration) => Promise<boolean>;

  constructor(private readonly deps: HistoryRelayDeps) {
    this.captureEnabled = deps.captureEnabled ?? projectCaptureEnabled;
  }

  start(): void {
    const every = this.deps.intervalMs ?? 30_000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async hostRedactor(): Promise<Redactor> {
    if (Date.now() - this.redactorAt > SECRETS_TTL_MS) {
      const boxes = await this.deps.listBoxes().catch(() => []);
      const secrets = await (this.deps.hostSecrets ?? collectHostSecrets)().catch(() => []);
      // Every box's relay token too: a transcript can quote another box's env.
      this.redactor = createRedactor({ secrets: [...secrets, ...boxes.map((b) => b.token)] });
      this.redactorAt = Date.now();
    }
    return this.redactor;
  }

  /** What the in-box shipper should do. Docker boxes are shipped host-side. */
  async config(reg: BoxRegistration): Promise<HistoryConfigReply> {
    const agents = shippedAgents();
    const credentialFiles = AGENT_SYNC_SPECS.flatMap((s) =>
      s.credential?.boxAbsPath ? [s.credential.boxAbsPath] : [],
    );
    if (isDockerBox(reg)) {
      return { enabled: false, reason: 'shipped by the host relay', agents: [], credentialFiles };
    }
    if (!(await this.captureEnabled(reg))) {
      return {
        enabled: false,
        reason: 'history.capture is off for this project',
        agents: [],
        credentialFiles,
      };
    }
    return { enabled: true, agents, credentialFiles };
  }

  /** One frame from an in-box shipper. The box id comes from its token, never the frame. */
  async chunk(reg: BoxRegistration, params: unknown): Promise<HistoryIngestResult> {
    const frame = parseFrame(params);
    if (!frame) return { ok: false, code: 'invalid', message: 'malformed history frame' };
    if (!(await this.captureEnabled(reg))) {
      return { ok: false, code: 'disabled', message: 'history.capture is off for this project' };
    }
    const red = (await this.hostRedactor()).redact(Buffer.from(frame.data, 'base64'));
    return this.deps.sink.ingest({
      ...frame,
      origin: originOf(reg),
      data: red.hits > 0 ? Buffer.from(red.bytes).toString('base64') : frame.data,
    });
  }

  /** One pass over every docker box. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const boxes = (await this.deps.listBoxes().catch(() => [])).filter(isDockerBox);
      const live = new Set(boxes.map((b) => b.boxId));
      for (const id of this.shippers.keys()) if (!live.has(id)) this.shippers.delete(id);
      for (const reg of boxes) {
        try {
          await this.shipBox(reg, false);
        } catch (e) {
          this.deps.log(`history: box ${reg.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** A destroy's final flush. Resolves with what was shipped; never throws. */
  async flushBox(boxId: string): Promise<ShipStats | null> {
    const reg = (await this.deps.listBoxes().catch(() => [])).find((b) => b.boxId === boxId);
    if (!reg || !isDockerBox(reg)) return null;
    try {
      return await this.shipBox(reg, true);
    } catch (e) {
      this.deps.log(`history: flush ${reg.name}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async shipBox(reg: BoxRegistration, final: boolean): Promise<ShipStats | null> {
    if (!(await this.captureEnabled(reg))) return null;
    await this.hostRedactor();
    const container = reg.containerName!;
    let entry = this.shippers.get(reg.boxId);
    if (!entry || entry.container !== container) {
      const source = dockerHistorySource({
        container,
        ...(this.deps.dockerRun ? { run: this.deps.dockerRun } : {}),
      });
      entry = {
        container,
        source,
        shipper: new HistoryShipper({
          origin: originOf(reg),
          agents: shippedAgents(),
          source,
          sink: this.deps.sink,
          // Delegates, so a refreshed secret list reaches a long-lived shipper.
          redactor: { redact: (b) => this.redactor.redact(b) },
          // In-process sink: no transport cap, so frames are as big as the hub
          // wants to seal anyway.
          frameMax: 4 * 1024 * 1024,
        }),
      };
      this.shippers.set(reg.boxId, entry);
    }
    // running vs paused/stopped decides exec vs a helper container; the
    // shipper keeps its cursors across passes.
    await entry.source.refreshState();
    const stats = await entry.shipper.pass({ final });
    if (stats.frames > 0 || stats.errors.length > 0) {
      this.deps.log(
        `history: box ${reg.name} shipped ${String(stats.frames)} frame(s), ${String(stats.bytes)} byte(s)${stats.errors.length ? `, errors: ${stats.errors.join('; ')}` : ''}`,
      );
    }
    return stats;
  }
}

export function parseFrame(params: unknown): HistoryFrame | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (
    typeof p.agent !== 'string' ||
    typeof p.path !== 'string' ||
    typeof p.offset !== 'number' ||
    !Number.isSafeInteger(p.offset) ||
    p.offset < 0 ||
    typeof p.sha256Prefix !== 'string' ||
    typeof p.sha256 !== 'string' ||
    typeof p.data !== 'string' ||
    p.data.length > (MAX_FRAME_BYTES * 4) / 3 + 4
  ) {
    return null;
  }
  // Relative, no traversal: the path becomes part of an archive key at the hub.
  if (p.path.startsWith('/') || p.path.split('/').some((s) => s === '..' || s === '')) return null;
  return {
    origin: { boxId: '' },
    agent: p.agent,
    path: p.path,
    offset: p.offset,
    sha256Prefix: p.sha256Prefix,
    sha256: p.sha256,
    data: p.data,
    ...(p.reset === true ? { reset: true } : {}),
  };
}
