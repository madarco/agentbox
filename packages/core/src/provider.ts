/**
 * `Provider` — the top-level abstraction the CLI routes every box command
 * through. One implementation per backend: `DockerProvider` for local Docker
 * containers, a cloud-backed provider per cloud (Daytona, ...). The CLI never
 * talks to a backend directly; it resolves a `Provider` from a box's
 * `provider` discriminator (or, for `create`, from config/flags) and calls it.
 */

import type { BoxRecord, ProviderName } from './box-record.js';
import type { BoxEndpoints } from './endpoints.js';
import type { BoxResourceStats } from './types.js';

/** Coarse lifecycle state, identical across providers. */
export type BoxRuntimeState = 'running' | 'paused' | 'stopped' | 'missing';

/** Resource ceilings requested for a new box. `null` means unlimited/unset. */
export interface CreateBoxLimits {
  memoryBytes: number | null;
  cpus: number | null;
  pidsLimit: number | null;
  disk: string | null;
}

export interface CreateBoxRequest {
  workspacePath: string;
  name?: string;
  /** Project root (nearest ancestor with agentbox.yaml, else workspacePath). */
  projectRoot: string;
  /** Override the base image / snapshot. */
  image?: string;
  /** Start from this checkpoint ref instead of a cold image. */
  checkpointRef?: string;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** Workspace-relative host file paths to seed into /workspace at create. */
  envFilesToImport?: string[];
  vnc?: { enabled: boolean };
  limits?: CreateBoxLimits;
  /** Provider-specific knobs (docker: sharedCache/portless; daytona: resources/region). */
  providerOptions?: Record<string, unknown>;
  onLog?: (line: string) => void;
}

export interface CreatedBox {
  record: BoxRecord;
  /** True when the provider had to build/provision the base image just now. */
  imageBuilt?: boolean;
}

export interface InspectedBox {
  record: BoxRecord;
  state: BoxRuntimeState;
  endpoints: BoxEndpoints;
  /** Provider-native raw inspect payload, opaque to the CLI (debug output only). */
  raw?: unknown;
}

export interface ExecOptions {
  user?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** What kind of interactive session the CLI wants an attach argv for. */
export type AttachKind = 'shell' | 'agent' | 'logs';

/** An interactive session the CLI's PTY wrapper attaches to. */
export interface AttachSpec {
  /** argv the wrapper spawns locally to attach to the box. */
  argv: string[];
  /** Optional cleanup invoked after the PTY detaches. */
  cleanup?: () => Promise<void>;
}

export interface BuildAttachOptions {
  sessionName?: string;
  user?: string;
  /** For `logs`: which service to tail. */
  service?: string;
  tail?: number;
  follow?: boolean;
  /**
   * For `agent`/`shell`: the inner command tmux should spawn when no session
   * is running yet. E.g. `'/home/vscode/.local/bin/claude'` for the claude
   * agent attach, `'bash -l'` for a plain shell. Cloud `buildAttach` runs it
   * via `tmux new-session -A -s <sessionName> '<command>'` so an existing
   * session attaches and a fresh one starts the right program.
   */
  command?: string;
  /** Plain (non-tmux) attach: skip the tmux wrap, just run `command` directly. */
  noTmux?: boolean;
}

/** Optional checkpoint capability — not every provider supports it. */
export interface ProviderCheckpoint {
  create(box: BoxRecord, name: string): Promise<{ ref: string }>;
  list(projectRoot: string): Promise<{ ref: string; createdAt: string }[]>;
  remove(projectRoot: string, ref: string): Promise<void>;
}

export interface Provider {
  readonly name: ProviderName;

  // ---- lifecycle ----
  create(req: CreateBoxRequest): Promise<CreatedBox>;
  /** Bring a stopped/paused box back; returns the record with refreshed fields. */
  start(box: BoxRecord): Promise<BoxRecord>;
  pause(box: BoxRecord): Promise<void>;
  resume(box: BoxRecord): Promise<void>;
  stop(box: BoxRecord): Promise<void>;
  destroy(box: BoxRecord, opts?: { keepSnapshot?: boolean }): Promise<void>;

  // ---- query ----
  inspect(box: BoxRecord): Promise<InspectedBox>;
  /** Cheap state probe used by `list` in a tight loop. */
  probeState(box: BoxRecord): Promise<BoxRuntimeState>;
  stats?(box: BoxRecord): Promise<BoxResourceStats>;

  // ---- exec / sessions ----
  exec(box: BoxRecord, argv: string[], opts?: ExecOptions): Promise<ExecResult>;

  // ---- url / endpoints ----
  resolveUrl(box: BoxRecord, opts?: { loopback?: boolean }): Promise<string>;

  // ---- optional capabilities (the CLI feature-detects these) ----
  /** Build the argv the CLI's PTY wrapper attaches to (shell/agent/logs). */
  buildAttach?(box: BoxRecord, kind: AttachKind, opts?: BuildAttachOptions): Promise<AttachSpec>;
  uploadPath?(box: BoxRecord, hostSrc: string, boxDst: string): Promise<{ finalPath: string }>;
  downloadPath?(box: BoxRecord, boxSrc: string, hostDst: string): Promise<{ finalPath: string }>;
  /**
   * Pull the *contents* of an in-box directory into a host directory —
   * `/workspace/*` → `<hostDst>/*`, not `<hostDst>/<srcBasename>/*`. Used by
   * `agentbox download` for the bulk workspace pull. Docker providers don't
   * need this (the rsync path in `pullToHost` already handles it); cloud
   * providers do because their `downloadPath` matches docker-cp semantics.
   */
  downloadDirContents?(box: BoxRecord, boxSrc: string, hostDst: string): Promise<{ finalPath: string }>;
  checkpoint?: ProviderCheckpoint;
}
