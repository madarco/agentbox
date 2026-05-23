import { log } from '@clack/prompts';
import {
  inspectBox,
  projectCheckpointImageBytes,
  readBoxStatus,
  type BoxRecord,
  type InspectedBox,
} from '@agentbox/sandbox-docker';
import { renderEndpointLines } from '../endpoints-render.js';
import { fmtBytes } from '../fmt.js';
import { providerForBox } from '../provider/registry.js';
import { watchRender } from '../watch.js';
import { handleLifecycleError } from './_errors.js';

export interface InspectRunOptions {
  json?: boolean;
  watch?: boolean;
  interval?: string;
}

function fmtLimit(n: number | null | undefined, unit: string): string {
  return n && n > 0 ? `${String(n)}${unit}` : 'unlimited';
}

async function renderText(i: InspectedBox): Promise<string> {
  const lim = i.record.resourceLimits;
  // checkpoint image size only when this box was started from one; otherwise
  // skip the row (no image -> no number to show, and projectCheckpointImageBytes
  // needs an explicit checkpoint name to resolve).
  const ckptName = i.record.checkpointSource?.ref;
  const projectRoot = i.record.projectRoot ?? i.record.workspacePath;
  const ckptBytes = ckptName ? await projectCheckpointImageBytes(projectRoot, ckptName) : null;
  const lines: string[] = [
    `id            ${i.record.id}`,
    `name          ${i.record.name}`,
    `container     ${i.record.container}`,
    `image         ${i.record.image}`,
    `state         ${i.state}`,
    `workspace     ${i.record.workspacePath}  (container fs at /workspace)`,
    `project       ${i.record.projectRoot ?? '(unset — pre-feature box)'}`,
    `n             ${typeof i.record.projectIndex === 'number' ? String(i.record.projectIndex) : '(none)'}`,
    `claude config ${i.record.claudeConfigVolume ?? '(none)'}`,
    `claude session ${renderClaudeSession(i)}`,
    `claude activity ${renderClaudeActivity(i)}`,
    `codex config  ${i.record.codexConfigVolume ?? '(none)'}`,
    `codex session ${renderCodexSession(i)}`,
    `codex activity ${renderCodexActivity(i)}`,
    `opencode cfg  ${i.record.opencodeConfigVolume ?? '(none)'}`,
    `opencode sess ${renderOpencodeSession(i)}`,
    `shells        ${renderShells(i)}`,
    `persisted     ${renderPersisted(i)}`,
    `playwright    ${i.record.withPlaywright ? 'yes' : 'no'}`,
    `env files     ${i.record.withEnv ? 'yes' : 'no'}`,
    'endpoints',
    ...renderEndpoints(i),
    `mem limit     ${lim?.memoryBytes ? fmtBytes(lim.memoryBytes) : 'unlimited'}`,
    `cpu limit     ${fmtLimit(lim?.cpus, '')}`,
    `pids limit    ${fmtLimit(lim?.pidsLimit, '')}`,
    `disk limit    ${lim?.disk ? `${lim.disk} (best-effort; no-op on overlay2/macOS)` : 'unlimited'}`,
    `snapshot dir  ${i.record.snapshotDir ?? '(none)'}`,
    `snapshot size ${fmtBytes(i.snapshotSizeBytes)}`,
    `checkpoint    ${renderCheckpoint(i, ckptBytes)}`,
    `host export   ${i.hostPaths.mergedExport}  (run \`agentbox open\` to refresh)`,
    `created       ${i.record.createdAt}`,
  ];
  return lines.join('\n');
}

function renderCheckpoint(i: InspectedBox, sizeBytes: number | null): string {
  const src = i.record.checkpointSource;
  if (!src || !i.record.checkpointImage) return '(none)';
  const sizePart = sizeBytes !== null ? ` ${fmtBytes(sizeBytes)}` : '';
  return `${src.ref} (${src.type}, chain ${src.chain.length}) → ${i.record.checkpointImage}${sizePart}`;
}

function renderClaudeSession(i: InspectedBox): string {
  if (i.claudeSession === null) return '(n/a — box not running)';
  if (!i.claudeSession.running) return `not running ("${i.claudeSession.sessionName}")`;
  const since = i.claudeSession.startedAt ? ` since ${i.claudeSession.startedAt}` : '';
  return `running ("${i.claudeSession.sessionName}")${since}`;
}

function renderCodexSession(i: InspectedBox): string {
  if (i.codexSession === null) return '(n/a — box not running)';
  if (!i.codexSession.running) return `not running ("${i.codexSession.sessionName}")`;
  const since = i.codexSession.startedAt ? ` since ${i.codexSession.startedAt}` : '';
  const title = i.persistedStatus?.codex?.sessionTitle;
  return `running ("${i.codexSession.sessionName}")${since}${title ? ` — ${title}` : ''}`;
}

function renderCodexActivity(i: InspectedBox): string {
  const c = i.persistedStatus?.codex;
  if (!c) return '(none)';
  return `${c.state}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''}`;
}

function renderOpencodeSession(i: InspectedBox): string {
  if (i.opencodeSession === null) return '(n/a — box not running)';
  if (!i.opencodeSession.running) return `not running ("${i.opencodeSession.sessionName}")`;
  const since = i.opencodeSession.startedAt ? ` since ${i.opencodeSession.startedAt}` : '';
  const title = i.persistedStatus?.opencode?.sessionTitle;
  return `running ("${i.opencodeSession.sessionName}")${since}${title ? ` — ${title}` : ''}`;
}

function renderClaudeActivity(i: InspectedBox): string {
  const c = i.persistedStatus?.claude;
  if (!c) return '(none)';
  return `${c.state}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''}`;
}

function renderShells(i: InspectedBox): string {
  if (i.state !== 'running') return '(n/a — box not running)';
  const s = i.shellSessions;
  if (s.length === 0) return 'none';
  return `${String(s.length)} (${s.map((x) => x.label).join(', ')})`;
}

function renderPersisted(i: InspectedBox): string {
  const s = i.persistedStatus;
  if (!s) return '(none)';
  return (
    `${s.timestamp} ` +
    `(${String(s.services.length)} svc, ${String(s.tasks.length)} tasks, ${String(s.ports.length)} ports)`
  );
}

function renderEndpoints(i: InspectedBox): string[] {
  const lines = renderEndpointLines(i.endpoints, process.stdout);
  return lines.length > 0 ? lines : ['  (none)'];
}

/**
 * `agentbox inspect` for cloud boxes: skips the Docker-specific probes
 * (`docker exec`, `docker inspect`, tmux session info) and renders what the
 * cloud provider can cheaply give us — state via probeState, endpoints from
 * preview URLs, persisted box-status snapshot mirrored from the in-sandbox
 * relay.
 */
async function renderCloudText(box: BoxRecord): Promise<string> {
  const provider = await providerForBox(box);
  const state = await provider.probeState(box);
  const persisted = await readBoxStatus(box);
  const lim = box.resourceLimits;
  const lines: string[] = [
    `id            ${box.id}`,
    `name          ${box.name}`,
    `provider      ${box.provider ?? 'docker'}`,
    `sandboxId     ${box.cloud?.sandboxId ?? '(none)'}`,
    `image         ${box.image}`,
    `state         ${state}`,
    `workspace     ${box.workspacePath}  (sandbox fs at /workspace)`,
    `project       ${box.projectRoot ?? '(unset)'}`,
    `n             ${typeof box.projectIndex === 'number' ? String(box.projectIndex) : '(none)'}`,
    `claude activity ${renderClaudeActivityCloud(persisted)}`,
    `codex activity ${renderCodexActivityCloud(persisted)}`,
    `web port      ${box.cloud?.webPort ?? '(none)'}`,
    `web preview   ${webPreviewLine(box)}`,
    `relay preview ${box.cloud?.relayPreviewUrl ?? '(unresolved)'}`,
    `bridge token  ${box.cloud?.bridgeToken ? '(set)' : '(unset)'}`,
    `playwright    ${box.withPlaywright ? 'yes' : 'no'}`,
    `env files     ${box.withEnv ? 'yes' : 'no'}`,
    `mem limit     ${lim?.memoryBytes ? fmtBytes(lim.memoryBytes) : 'unlimited'}`,
    `cpu limit     ${fmtLimit(lim?.cpus, '')}`,
    `pids limit    ${fmtLimit(lim?.pidsLimit, '')}`,
    `persisted     ${persisted ? `${persisted.timestamp} (${String(persisted.services.length)} svc, ${String(persisted.tasks.length)} tasks, ${String(persisted.ports.length)} ports)` : '(none)'}`,
    `created       ${box.createdAt}`,
  ];
  return lines.join('\n');
}

function webPreviewLine(box: BoxRecord): string {
  const port = box.cloud?.webPort;
  if (port === undefined) return '(none)';
  const url = box.cloud?.previewUrls?.[port];
  return url ?? '(unresolved — re-run `agentbox url` to refresh)';
}

function renderClaudeActivityCloud(persisted: Awaited<ReturnType<typeof readBoxStatus>>): string {
  const c = persisted?.claude;
  if (!c) return '(none — host poller hasn\'t mirrored status yet)';
  return `${c.state}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''}`;
}

function renderCodexActivityCloud(persisted: Awaited<ReturnType<typeof readBoxStatus>>): string {
  const c = persisted?.codex;
  if (!c) return '(none)';
  return `${c.state}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''}`;
}

// `agentbox inspect` was folded into `agentbox status --inspect`; this is the
// extracted body, called by status.ts with an already-resolved box.
export async function runInspect(box: BoxRecord, opts: InspectRunOptions): Promise<void> {
  try {
    if (opts.json && opts.watch) {
      log.error('cannot combine --json with --watch');
      process.exit(2);
    }
    const isCloud = (box.provider ?? 'docker') !== 'docker';
    if (opts.watch) {
      await watchRender(
        async () =>
          isCloud ? await renderCloudText(box) : await renderText(await inspectBox(box.id)),
        opts.interval,
      );
      return;
    }
    if (isCloud) {
      // Provider-level inspect gives us state + endpoints; for JSON we surface
      // the box record + a probeState (cheap), avoiding heavy SDK round-trips.
      if (opts.json) {
        const provider = await providerForBox(box);
        const state = await provider.probeState(box);
        const persisted = await readBoxStatus(box);
        process.stdout.write(
          JSON.stringify({ record: box, state, persistedStatus: persisted }, null, 2) + '\n',
        );
      } else {
        process.stdout.write((await renderCloudText(box)) + '\n');
      }
      return;
    }
    const result = await inspectBox(box.id);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write((await renderText(result)) + '\n');
    }
  } catch (err) {
    handleLifecycleError(err);
  }
}
