import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execa } from 'execa';
import { ConfigError, loadConfig } from '@agentbox/ctl';
import { buildClaudeMounts, ensureClaudeVolume, resolveClaudeVolume } from './claude.js';
import {
  containerExists,
  dockerInfo,
  ensureVolume,
  publishedHostPort,
  runBox,
} from './docker.js';
import { generateVncPassword, launchVncDaemon, VNC_CONTAINER_PORT } from './vnc.js';
import { createBoxWorktree, detectGitRepos } from './git-worktree.js';
import { CONTAINER_EXPORT_MERGED, CONTAINER_EXPORT_UPPER, boxRunDirFor } from './host-export.js';
import { DEFAULT_BOX_IMAGE, ensureImage } from './image.js';
import {
  mountOverlay,
  verifyOverlay,
  type NestedWorktreeBind,
  type OverlayCheck,
} from './overlay.js';
import { readState, recordBox, type BoxRecord, type GitWorktreeRecord } from './state.js';
import { createSnapshot, snapshotPathFor } from './snapshot.js';
import { launchCtlDaemon } from './ctl.js';
import {
  ensureRelay,
  generateRelayToken,
  registerBoxWithRelay,
  rehydrateRelayRegistry,
} from './relay.js';
import {
  buildIdeMounts,
  cursorServerVolumeName,
  ensureIdeVolumes,
  repairIdeOwnership,
  vscodeServerVolumeName,
} from './vscode.js';

export interface CreateBoxOptions {
  workspacePath: string;
  name?: string;
  useSnapshot: boolean;
  image?: string;
  onLog?: (line: string) => void;
  /**
   * Claude Code config volume. When omitted, defaults to `{ isolate: false }` —
   * every box mounts the shared `agentbox-claude-config` volume at
   * /home/vscode/.claude so auth / skills / plugins persist across boxes.
   */
  claudeConfig?: { isolate: boolean };
  /** Extra env vars forwarded to the container (merged on top of claude env forwarding). */
  claudeEnv?: Record<string, string>;
  /**
   * When true, run `npm install -g @playwright/cli@latest` inside the box after
   * the overlay is mounted. agent-browser is always installed in the image; this
   * flag adds the Playwright CLI on top for boxes that need it.
   */
  withPlaywright?: boolean;
  /**
   * VNC stack (Xvnc on :1 + websockify serving noVNC on container :6080).
   * Defaults to enabled. The CLI exposes `--no-vnc` for opt-out. Disabling
   * skips port mapping + password generation + the in-container supervisor
   * launch; the apt-installed binaries stay in the image but are unused.
   */
  vnc?: { enabled: boolean };
}

export interface CreatedBox {
  record: BoxRecord;
  overlayChecks: OverlayCheck[];
  imageBuilt: boolean;
}

function generateBoxId(): string {
  return randomBytes(4).toString('hex');
}

export function sanitizeBasename(workspacePath: string): string {
  const raw = basename(resolve(workspacePath));
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 30)
    .replace(/[-._]+$/, '');
}

export function defaultBoxName(workspacePath: string, id: string): string {
  const base = sanitizeBasename(workspacePath);
  return base.length > 0 ? `${base}-${id}` : id;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ~/.claude is intentionally NOT in this list: it lives in the named volume
// `agentbox-claude-config` (see resolveClaudeVolume / ensureClaudeVolume) so
// auth persists inside the container without leaking host state. Only
// non-claude identity files are bind-mounted from the host.
async function buildIdentityMounts(): Promise<string[]> {
  const home = homedir();
  const candidates: Array<{ src: string; dst: string; readOnly: boolean }> = [
    { src: join(home, '.codex'), dst: '/home/vscode/.codex', readOnly: false },
    { src: join(home, '.gitconfig'), dst: '/home/vscode/.gitconfig', readOnly: true },
  ];
  const out: string[] = [];
  for (const c of candidates) {
    if (await pathExists(c.src)) {
      out.push(`${c.src}:${c.dst}${c.readOnly ? ':ro' : ''}`);
    }
  }
  return out;
}

export async function createBox(opts: CreateBoxOptions): Promise<CreatedBox> {
  const log = opts.onLog ?? (() => {});
  const workspace = resolve(opts.workspacePath);
  if (!(await pathExists(workspace))) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }

  // Pre-flight agentbox.yaml validation on the host so the user sees the real
  // ConfigError instead of an opaque "socket did not appear" timeout from the
  // detached daemon exec later. The daemon re-validates inside the box anyway
  // — defence in depth, and necessary because the file lives in the overlay
  // and can be edited after create.
  const cfgPath = join(workspace, 'agentbox.yaml');
  if (await pathExists(cfgPath)) {
    try {
      const cfg = await loadConfig(cfgPath);
      log(`agentbox.yaml validated (${String(cfg.services.length)} service(s))`);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new Error(`agentbox.yaml validation failed:\n  ${err.message}`);
      }
      throw err;
    }
  }

  await dockerInfo();
  log('docker daemon reachable');

  const imageRef = opts.image ?? DEFAULT_BOX_IMAGE;
  const { built } = await ensureImage(imageRef, {
    onProgress: (line) => log(`[image] ${line}`),
  });
  log(built ? `built image ${imageRef}` : `using cached image ${imageRef}`);

  // Bring up the host relay before the box so the box can post events
  // immediately on boot. Best-effort — a relay outage shouldn't block create.
  // Always re-push known box tokens after ensure: the relay's registry is
  // in-memory, so a daemon restart or `docker restart agentbox-relay` between
  // CLI invocations leaves it empty. Repushing is idempotent and cheap.
  let relayUp = false;
  try {
    await ensureRelay({ onLog: log });
    const existing = await readState();
    await rehydrateRelayRegistry(existing.boxes);
    relayUp = true;
  } catch (err) {
    log(`relay unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const id = generateBoxId();
  const name = opts.name ?? defaultBoxName(workspace, id);
  const containerName = `agentbox-${name}`;
  if (await containerExists(containerName)) {
    throw new Error(`container ${containerName} already exists; remove it first`);
  }

  // Detect host git repos at workspace root + 1st-level subdirs and create a
  // dedicated worktree per repo on a fresh `agentbox/<box-name>` branch. The
  // host's working tree stays untouched; uncommitted (tracked + untracked)
  // state is carried into the worktree so the agent picks up where the user
  // left off. The root worktree (if any) replaces the box's overlay lower so
  // /workspace is the agent's editable working tree; nested worktrees are
  // staged on a side path and bind-mounted on top of /workspace/<subpath>
  // after the FUSE overlay is up (see mountOverlay).
  const worktreesRoot = join(boxRunDirFor(id), 'worktrees');
  await mkdir(worktreesRoot, { recursive: true });
  const gitWorktreeRecords: GitWorktreeRecord[] = [];
  const nestedWorktreeBinds: NestedWorktreeBind[] = [];
  const repos = await detectGitRepos(workspace);
  if (repos.length > 0) {
    log(
      `detected ${String(repos.length)} git repo(s): ` +
        repos.map((r) => `${r.kind}${r.relPathFromWorkspace ? '@' + r.relPathFromWorkspace : ''}`).join(', '),
    );
  }
  for (const r of repos) {
    const worktreeDir = join(worktreesRoot, r.relPathFromWorkspace || 'root');
    const branchBase =
      r.kind === 'root'
        ? `agentbox/${name}`
        : `agentbox/${name}--${r.relPathFromWorkspace.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const result = await createBoxWorktree({
      hostMainRepo: r.hostMainRepo,
      branchName: branchBase,
      worktreeDir,
      onLog: log,
    });
    const containerPath = r.kind === 'root' ? '/workspace' : `/workspace/${r.relPathFromWorkspace}`;
    gitWorktreeRecords.push({
      kind: r.kind,
      hostMainRepo: r.hostMainRepo,
      hostWorktreeDir: worktreeDir,
      containerPath,
      branch: result.branchName,
      relPathFromWorkspace: r.relPathFromWorkspace,
    });
    if (r.kind === 'nested') {
      nestedWorktreeBinds.push({
        containerPath,
        mountFromPath: `/agentbox-worktrees/${r.relPathFromWorkspace}`,
      });
    }
  }

  let lowerPath = workspace;
  const rootWorktree = gitWorktreeRecords.find((w) => w.kind === 'root');
  if (rootWorktree) {
    lowerPath = rootWorktree.hostWorktreeDir;
    log(`using worktree as overlay lower: ${lowerPath}`);
  }

  let snapshotDir: string | null = null;
  if (opts.useSnapshot) {
    snapshotDir = snapshotPathFor(id);
    log(`cloning workspace to ${snapshotDir} (APFS clone where available)`);
    const snap = await createSnapshot({ source: lowerPath, destination: snapshotDir });
    log(`pruned ${snap.prunedPaths.length} platform-dependent dirs from snapshot`);
    lowerPath = snapshotDir;
  }

  const upperVolume = `agentbox-upper-${id}`;
  const nodeModulesVolume = `agentbox-nm-${id}`;
  await ensureVolume(upperVolume);
  await ensureVolume(nodeModulesVolume);
  await ensureIdeVolumes(id);
  log(
    `prepared volumes ${upperVolume}, ${nodeModulesVolume}, ${vscodeServerVolumeName(id)}, ${cursorServerVolumeName(id)}`,
  );
  const ide = buildIdeMounts(id);

  // Claude Code config volume. Shared by default so users sign in once across
  // every box; --isolate-claude-config opts into a per-box volume. Either way,
  // the host's ~/.claude is the authoritative source: we rsync host -> volume
  // on every create so updates on the host (new login, new skills, new MCP)
  // flow into the next box. Sync is additive — box-only state (session logs,
  // etc.) is preserved.
  const claudeSpec = resolveClaudeVolume({
    isolate: opts.claudeConfig?.isolate ?? false,
    boxId: id,
  });
  const claudeEnsured = await ensureClaudeVolume(claudeSpec, {
    syncFromHost: true,
    image: imageRef,
    hostWorkspace: workspace,
  });
  if (claudeEnsured.synced) {
    log(`synced ${claudeSpec.volume} from ~/.claude`);
    if ((claudeEnsured.filteredHookCount ?? 0) > 0) {
      log(
        `filtered ${String(claudeEnsured.filteredHookCount)} host-path hook(s) (paths under ~/)`,
      );
    }
    if (claudeEnsured.clearedInstallMethod) {
      log("cleared host's installMethod from synced .claude.json (box uses the native installer)");
    }
    if (claudeEnsured.aliasedProjectKey) {
      log(`aliased project state for ${workspace} -> /workspace in synced .claude.json`);
    }
  } else if (claudeEnsured.created) {
    log(`created empty volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
  } else {
    log(`reusing volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
  }
  const claudeMounts = buildClaudeMounts(claudeSpec, process.env);

  const boxDir = boxRunDirFor(id);
  const socketDir = join(boxDir, 'run');
  const socketPath = join(socketDir, 'ctl.sock');
  // Per-box host dirs that `agentbox open` / `agentbox path` refresh into.
  // We bind these in at create time so a later `docker exec rsync` can write
  // straight to the host filesystem — no container restart needed.
  const mergedExportDir = join(boxDir, 'workspace');
  const upperExportDir = join(boxDir, 'upper');
  await mkdir(socketDir, { recursive: true });
  await mkdir(mergedExportDir, { recursive: true });
  await mkdir(upperExportDir, { recursive: true });

  const extraVolumes = await buildIdentityMounts();
  extraVolumes.push(...claudeMounts.extraVolumes);
  extraVolumes.push(...ide.extraVolumes);
  extraVolumes.push(`${socketDir}:/run/agentbox`);
  extraVolumes.push(`${mergedExportDir}:${CONTAINER_EXPORT_MERGED}`);
  extraVolumes.push(`${upperExportDir}:${CONTAINER_EXPORT_UPPER}`);
  // Bind-mount each main repo's `.git/` at its identical absolute host path,
  // RW. Worktree pointer files (`<worktree>/.git`) and the back-reference at
  // `<main>/.git/worktrees/<name>/gitdir` contain absolute paths; both must
  // resolve to the same path on host and inside the container or git breaks
  // on one side.
  for (const w of gitWorktreeRecords) {
    extraVolumes.push(`${w.hostMainRepo}/.git:${w.hostMainRepo}/.git`);
  }
  // Stage nested worktrees on a side path so mountOverlay() can bind-mount
  // them on top of /workspace/<subpath> after the FUSE overlay is up.
  for (const w of gitWorktreeRecords) {
    if (w.kind === 'nested') {
      extraVolumes.push(`${w.hostWorktreeDir}:/agentbox-worktrees/${w.relPathFromWorkspace}`);
    }
  }
  for (const v of extraVolumes) log(`mounting agent dir: ${v}`);

  // Per-box bearer token for the host relay. Register *before* runBox so the
  // box's supervisor can post on boot. Skip if the relay isn't reachable —
  // the box still works, it just won't deliver events to the host.
  const relayToken = generateRelayToken();
  if (relayUp) {
    try {
      await registerBoxWithRelay({
        boxId: id,
        token: relayToken,
        name,
        worktrees: gitWorktreeRecords,
      });
      log(`registered box token with relay`);
    } catch (err) {
      log(`relay register failed: ${err instanceof Error ? err.message : String(err)}`);
      relayUp = false;
    }
  }
  const relayEnv: Record<string, string> = relayUp
    ? {
        // host.docker.internal resolves to the host (where the relay node
        // process is running). The matching `--add-host` is set in runBox.
        AGENTBOX_RELAY_URL: `http://host.docker.internal:8787`,
        AGENTBOX_RELAY_TOKEN: relayToken,
      }
    : {};

  // VNC stack defaults on; the CLI surfaces `--no-vnc` for opt-out. Generate
  // the password and the port mapping up front so they're baked into the
  // container's env + `-p` flags before `docker run` — both must be set at
  // create time (env survives stop/start; port mappings are immutable).
  const vncEnabled = opts.vnc?.enabled !== false;
  const vncPassword = vncEnabled ? generateVncPassword() : undefined;
  const vncEnv: Record<string, string> = vncEnabled && vncPassword
    ? { AGENTBOX_VNC_PASSWORD: vncPassword }
    : {};
  const vncPortMappings = vncEnabled
    ? [{ hostPort: 0, containerPort: VNC_CONTAINER_PORT, hostIp: '127.0.0.1' }]
    : [];

  await runBox({
    name: containerName,
    image: imageRef,
    lowerPath,
    upperVolume,
    nodeModulesVolume,
    extraVolumes,
    portMappings: vncPortMappings,
    env: {
      AGENTBOX_BOX_ID: id,
      ...claudeMounts.env,
      ...relayEnv,
      ...vncEnv,
      ...(opts.claudeEnv ?? {}),
    },
  });
  log(`container ${containerName} started`);

  try {
    await mountOverlay(containerName, { nestedWorktrees: nestedWorktreeBinds });
    log('fuse-overlayfs mounted at /workspace');
    if (nestedWorktreeBinds.length > 0) {
      log(`bind-mounted ${String(nestedWorktreeBinds.length)} nested worktree(s) over /workspace`);
    }
  } catch (err) {
    log(`overlay mount failed; leaving container ${containerName} running so you can inspect it`);
    throw err;
  }

  const overlayChecks = await verifyOverlay(containerName);
  const failed = overlayChecks.filter((c) => !c.ok);
  if (failed.length > 0) {
    const detail = failed.map((c) => `  - ${c.name}: ${c.detail}`).join('\n');
    throw new Error(`overlay verification failed:\n${detail}`);
  }
  log('overlay verified');

  await repairIdeOwnership(containerName);
  log('.vscode-server + .cursor-server ownership verified');

  const ctl = await launchCtlDaemon(containerName, socketPath);
  if (ctl.up) log('agentbox-ctl daemon up');
  else log(`agentbox-ctl daemon did not become reachable: ${ctl.reason}`);

  if (opts.withPlaywright) {
    log('installing @playwright/cli@latest (--with-playwright)');
    // npm-global writes to /usr/lib/node_modules/, so we need root. The
    // resulting binary lives in /usr/bin and persists in the container's
    // writable layer across pause/stop/start — no need to reinstall on start.
    const result = await execa(
      'docker',
      [
        'exec',
        '--user',
        'root',
        containerName,
        'bash',
        '-lc',
        'npm install -g @playwright/cli@latest 2>&1',
      ],
      { reject: false },
    );
    for (const line of (result.stdout ?? '').split('\n')) {
      if (line.trim().length > 0) log(`[playwright] ${line}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `failed to install @playwright/cli (exit ${String(result.exitCode)}): ${(result.stderr ?? '').toString().slice(0, 400)}`,
      );
    }
    log('@playwright/cli installed');
  }

  // VNC daemon (Xvnc + websockify). Best-effort, like launchCtlDaemon. The
  // host port mapping was wired into runBox above (hostPort=0 → random); we
  // resolve the assigned port here for storage. If the daemon fails to come
  // up we still record vncEnabled so `agentbox start` will retry the launch
  // — the failure is usually transient (apt-running, fs slow).
  let vncHostPort: number | null = null;
  if (vncEnabled) {
    const vnc = await launchVncDaemon(containerName);
    if (vnc.up) log('vnc stack up (Xvnc + websockify + noVNC)');
    else log(`vnc stack did not become reachable: ${vnc.reason}`);
    vncHostPort = await publishedHostPort(containerName, VNC_CONTAINER_PORT);
    if (vncHostPort) log(`vnc web on host 127.0.0.1:${String(vncHostPort)}`);
  }

  const record: BoxRecord = {
    id,
    name,
    container: containerName,
    image: imageRef,
    workspacePath: workspace,
    lowerPath,
    upperVolume,
    nodeModulesVolume,
    snapshotDir,
    socketPath,
    claudeConfigVolume: claudeSpec.volume,
    vscodeServerVolume: vscodeServerVolumeName(id),
    cursorServerVolume: cursorServerVolumeName(id),
    relayToken: relayUp ? relayToken : undefined,
    gitWorktrees: gitWorktreeRecords.length > 0 ? gitWorktreeRecords : undefined,
    withPlaywright: opts.withPlaywright ? true : undefined,
    vncEnabled: vncEnabled ? true : undefined,
    vncContainerPort: vncEnabled ? VNC_CONTAINER_PORT : undefined,
    vncHostPort: vncHostPort ?? undefined,
    vncPassword: vncPassword,
    createdAt: new Date().toISOString(),
  };
  await recordBox(record);

  return { record, overlayChecks, imageBuilt: built };
}
