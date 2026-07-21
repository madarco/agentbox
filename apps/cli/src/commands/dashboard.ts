import { spawn } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveBoxImage,
  resolveDefaultCheckpoint,
} from '@agentbox/config';
import {
  buildDashboardAttachArgv,
  buildShellSessionAttachArgv,
  claudeSessionInfo,
  createBox,
  DEFAULT_CODEX_SESSION,
  DEFAULT_OPENCODE_SESSION,
  DEFAULT_RELAY_PORT,
  destroyBox,
  ensureBoxBrowser,
  ensureCodexInstalled,
  ensureOpencodeInstalled,
  listBoxes,
  pauseBox,
  rebuildPluginNativeDeps,
  seedCodexHooks,
  SHARED_CLAUDE_VOLUME,
  shellSessionInfo,
  startBox,
  startClaudeSession,
  startCodexSession,
  startOpencodeSession,
  startShellSession,
  stopBox,
  syncClaudeCredentials,
  unpauseBox,
  waitForTmuxPaneContent,
  type ListedBox,
} from '@agentbox/sandbox-docker';
import { hostOpenCommand, readState } from '@agentbox/sandbox-core';
import type { BoxRecord } from '@agentbox/core';
import { resolveBoxOrExit } from '../box-ref.js';
import { resolveClaudeAuth } from '../auth.js';
import { resolveLimits } from '../limits.js';
import { Compositor, type RightTarget } from '../dashboard/compositor.js';
import { loadPtyBackend, type PtySpawn, type TerminalCtor } from '../pty/pty-backend.js';
import { restoreAgentSessions } from '../agent-sessions.js';
import { providerForBox } from '../provider/registry.js';
import { NEW_BOX_ID, NEW_BOX_LABEL, type SidebarBox } from '../dashboard/sidebar.js';
import { buildCloudAttachInnerCommand } from './_cloud-attach.js';
import { handleLifecycleError } from './_errors.js';
import { applyClaudeSkipPermissions, applyCodexSkipPermissions } from '../lib/skip-permissions.js';

interface DashboardOptions {
  project?: boolean;
}

/**
 * Whether the dashboard should keep a box's attach session alive (pooled)
 * across box switches rather than re-spawning it each time. Worth it only for
 * providers with no persistent connection where reconnecting is expensive and
 * the attach has no per-call cleanup to defer — currently Vercel (no SSH; each
 * `sbx exec` pays a credential refresh + SDK handshake + remote tmux attach).
 * Docker (local exec) and hetzner (SSH ControlMaster) reconnect cheaply;
 * daytona mints+revokes a per-call SSH token, so pooling it would change token
 * lifetime semantics. Add future no-SSH providers here.
 */
function providerSupportsKeepAlive(provider: BoxRecord['provider']): boolean {
  return provider === 'vercel' || provider === 'e2b' || provider === 'tenki';
}

/**
 * Sidebar / switch order: group by project (so the global view doesn't
 * interleave per-project indices), then projectIndex, then name.
 */
function sortBoxes(boxes: ListedBox[]): ListedBox[] {
  return [...boxes].sort((a, b) => {
    const ap = a.projectRoot ?? '';
    const bp = b.projectRoot ?? '';
    if (ap !== bp) return ap.localeCompare(bp);
    const ai = a.projectIndex ?? Number.POSITIVE_INFINITY;
    const bi = b.projectIndex ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

function scoped(all: boolean, projectRoot: string, boxes: ListedBox[]): ListedBox[] {
  return sortBoxes(all ? boxes : boxes.filter((b) => b.projectRoot === projectRoot));
}

/**
 * Pick the box's primary agent and return its activity + session title for the
 * sidebar. A box runs one agent in practice; priority is claude > codex >
 * opencode. `unknown` activity is not positive evidence (the supervisor seeds
 * it for every box), so it never pins claude over a running codex/opencode.
 */
function resolveAgent(b: ListedBox): { activity?: string; sessionTitle?: string } {
  const real = (s?: string): boolean => !!s && s !== 'unknown';
  if (real(b.claudeActivity) || b.claudeSessionTitle) {
    return { activity: b.claudeActivity, sessionTitle: b.claudeSessionTitle };
  }
  if (b.codexSession?.running || real(b.codexActivity)) {
    return { activity: b.codexActivity, sessionTitle: b.codexSessionTitle };
  }
  if (b.opencodeSession?.running) {
    // OpenCode reports no activity (no plugin) — title only.
    return { sessionTitle: b.opencodeSessionTitle };
  }
  // No positive evidence — fall back to claude's fields, matching today's
  // behavior for a plain box (`? unknown`, name shown).
  return { activity: b.claudeActivity, sessionTitle: b.claudeSessionTitle };
}

function toSidebar(b: ListedBox): SidebarBox {
  const agent = resolveAgent(b);
  return {
    id: b.id,
    name: b.name,
    state: b.state,
    activity: agent.activity,
    sessionTitle: agent.sessionTitle,
    index: b.projectIndex,
    project: b.projectRoot,
    // Only claude reports an AskUserQuestion payload; gated on claudeActivity
    // === 'question' upstream (lifecycle.listBoxes) so it's undefined otherwise.
    claudeQuestion: b.claudeQuestion,
  };
}

export const dashboardCommand = new Command('dashboard')
  .description('Box list + the selected box live Agent session')
  .argument('[box]', 'initial box (default: first running box; -p restricts to the cwd project)')
  .option('-p, --project', "only this project's boxes (default: all boxes globally)")
  .action(async (idOrName: string | undefined, opts: DashboardOptions) => {
    try {
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        log.error('agentbox dashboard needs an interactive terminal');
        process.exit(2);
      }

      // node-pty is an optionalDependency and @xterm/headless is CJS — both are
      // dynamic-imported via the shared backend loader so a missing native
      // prebuild (or the CJS named export issue) degrades only the dashboard,
      // never the rest of the CLI. Same loader is used by wrapped-pty.
      const backend = await loadPtyBackend();
      let ptySpawn: PtySpawn;
      let termCtor: TerminalCtor;
      if (backend) {
        ptySpawn = backend.ptySpawn;
        termCtor = backend.termCtor;
      } else {
        log.error(
          'agentbox dashboard is unavailable here (native terminal backend failed to load)',
        );
        log.info('use `agentbox claude` / `agentbox attach` instead');
        process.exit(2);
      }

      const project = await findProjectRoot(process.cwd());
      let showAll = !opts.project; // default: every box globally; -p scopes to cwd project
      const full = await listBoxes();
      const scoped0 = scoped(showAll, project.root, full);

      let initialId: string;
      if (idOrName !== undefined) {
        const picked = await resolveBoxOrExit(idOrName);
        // Cloud boxes are surfaced read-only in the sidebar — selecting one
        // shows a "live panels are docker-only" placeholder via
        // resolveTarget. Don't refuse the ref here.
        initialId = picked.id;
        if (!scoped0.some((b) => b.id === picked.id)) showAll = true; // widen so it shows
      } else if (scoped0.length === 0) {
        // No boxes yet — land on the synthetic create entry instead of bailing.
        initialId = NEW_BOX_ID;
      } else {
        initialId = (scoped0.find((b) => b.state === 'running') ?? scoped0[0]!).id;
      }

      const newBoxEntry: SidebarBox = { id: NEW_BOX_ID, name: NEW_BOX_LABEL, state: 'new' };
      const listCandidates = async (): Promise<SidebarBox[]> => [
        newBoxEntry,
        ...scoped(showAll, project.root, await listBoxes()).map(toSidebar),
      ];

      const resolveTarget = async (boxId: string): Promise<RightTarget> => {
        if (boxId === NEW_BOX_ID) return { kind: 'create-menu', where: project.root };
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return { kind: 'placeholder', lines: ['', '  box not found'] };
        if (box.state === 'paused' || box.state === 'stopped') {
          return { kind: 'lifecycle-menu', state: box.state };
        }
        if (box.state !== 'running') {
          return {
            kind: 'placeholder',
            lines: [
              '',
              `  box ${box.name} is ${box.state}.`,
              `  Start it: agentbox start ${box.name}`,
            ],
          };
        }
        // Cloud boxes: probe the box's live tmux sessions over SSH and pick
        // the highest-priority agent (claude > codex > opencode) — mirrors
        // the docker branch below. One round-trip per selection; cheap with
        // the hetzner ControlMaster warm. Falls back to the menu if no
        // session is up (or the probe failed).
        if ((box.provider ?? 'docker') !== 'docker') {
          const record = await loadBoxRecord(box.id);
          const sessions = await probeCloudSessions(record);
          for (const which of ['claude', 'codex', 'opencode'] as const) {
            if (sessions.has(which)) {
              return buildCloudAttachTarget(record, which);
            }
          }
          return { kind: 'menu' };
        }
        // Docker: probe whichever agent session is live — priority
        // claude > codex > opencode. claude needs a fresh probe (not in
        // listBoxes()); codex / opencode were already live-probed by listBoxes().
        const claude = await claudeSessionInfo(box.container);
        if (claude.running) {
          return {
            kind: 'attach',
            command: 'docker',
            args: buildDashboardAttachArgv(box.container, claude.sessionName),
            mode: 'claude',
          };
        }
        if (box.codexSession?.running) {
          return {
            kind: 'attach',
            command: 'docker',
            args: buildDashboardAttachArgv(box.container, box.codexSession.sessionName),
            mode: 'codex',
          };
        }
        if (box.opencodeSession?.running) {
          return {
            kind: 'attach',
            command: 'docker',
            args: buildDashboardAttachArgv(box.container, box.opencodeSession.sessionName),
            mode: 'opencode',
          };
        }
        return { kind: 'menu' };
      };

      const findBox = async (boxId: string): Promise<ListedBox> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) throw new Error('box not found');
        if (box.state !== 'running') throw new Error(`box is ${box.state}`);
        return box;
      };

      // The cloud attach path needs the full BoxRecord (sandboxId, ssh control
      // socket path, etc.) — ListedBox is the enriched view used for the
      // sidebar and lifecycle ops only.
      const loadBoxRecord = async (boxId: string): Promise<BoxRecord> => {
        const rec = (await readState()).boxes.find((b) => b.id === boxId);
        if (!rec) throw new Error('box not found');
        return rec;
      };

      // Cloud equivalent of buildDashboardAttachArgv. Reuses the same
      // base64-launcher inner-command pattern as `agentbox claude/codex/
      // opencode` so positional args (wizard prompts) survive every quoting
      // layer. For `shell`, attach to/create the box's tracked `shell` tmux
      // session so the dashboard's shell pane is the same detachable session
      // `agentbox shell` sees from the CLI — matching the docker UX.
      const buildCloudAttachTarget = async (
        record: BoxRecord,
        which: 'claude' | 'codex' | 'opencode' | 'shell',
      ): Promise<RightTarget> => {
        const provider = await providerForBox(record);
        if (!provider.buildAttach) {
          throw new Error(`provider '${provider.name}' does not support interactive attach`);
        }
        const sessionName = which;
        const kind = which === 'shell' ? 'shell' : 'agent';
        // `bash -l` for shell — login shell so /etc/profile.d/agentbox.sh
        // exports AGENTBOX_BOX_* env. For agents, the base64 launcher
        // (extraArgs is always [] from the dashboard — no `--` passthrough).
        const innerCommand = which === 'shell' ? 'bash -l' : buildCloudAttachInnerCommand(which);
        const spec = await provider.buildAttach(record, kind, {
          sessionName,
          command: innerCommand,
        });
        return {
          kind: 'attach',
          command: spec.argv[0]!,
          args: spec.argv.slice(1),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.initialInput ? { initialInput: spec.initialInput } : {}),
          ...(spec.cleanup ? { cleanup: spec.cleanup } : {}),
          mode: which,
          ...(providerSupportsKeepAlive(record.provider) ? { keepAlive: true } : {}),
        };
      };

      const isCloudBox = (box: ListedBox): boolean => (box.provider ?? 'docker') !== 'docker';

      // Cloud equivalent of claudeSessionInfo / box.codexSession.running for
      // the docker path: probe the box over SSH for live tmux sessions, so
      // resolveTarget can land directly on the running agent's pane instead
      // of the menu. One round-trip per box selection; cheap once the
      // hetzner ControlMaster is warm.
      const probeCloudSessions = async (record: BoxRecord): Promise<Set<string>> => {
        try {
          const provider = await providerForBox(record);
          const r = await provider.exec(record, ['tmux', 'list-sessions', '-F', '#{session_name}']);
          if (r.exitCode !== 0) return new Set();
          return new Set(
            r.stdout
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          );
        } catch {
          return new Set();
        }
      };

      const startClaude = async (boxId: string): Promise<RightTarget> => {
        const box = await findBox(boxId);
        if (isCloudBox(box)) {
          return buildCloudAttachTarget(await loadBoxRecord(boxId), 'claude');
        }
        // Idempotent + marker-gated: needed the first time a box that never ran
        // Claude starts one; a no-op afterwards. (No host ~/.claude re-sync —
        // already synced at `agentbox create`; == `claude start --no-sync-config`.)
        await rebuildPluginNativeDeps(box.container, {
          volume: box.claudeConfigVolume,
        });
        // Mirror the in-box OAuth credentials with the host backup.
        const claudeVolume = box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME;
        await syncClaudeCredentials(
          { volume: claudeVolume },
          { image: box.image, isolate: claudeVolume !== SHARED_CLAUDE_VOLUME },
        );
        const claudeCfg = await loadEffectiveConfig(box.workspacePath);
        await startClaudeSession({
          container: box.container,
          claudeArgs: applyClaudeSkipPermissions([], claudeCfg.effective),
          boxName: box.name,
        });
        const info = await claudeSessionInfo(box.container);
        // Attach only once the agent TUI has drawn — see waitForTmuxPaneContent.
        await waitForTmuxPaneContent(box.container, info.sessionName);
        return {
          kind: 'attach',
          command: 'docker',
          args: buildDashboardAttachArgv(box.container, info.sessionName),
          mode: 'claude',
        };
      };

      const startCodex = async (boxId: string): Promise<RightTarget> => {
        const box = await findBox(boxId);
        if (isCloudBox(box)) {
          return buildCloudAttachTarget(await loadBoxRecord(boxId), 'codex');
        }
        // Install codex if the box image lacks it (checkpoint predating Codex).
        await ensureCodexInstalled(box.container);
        if (box.codexConfigVolume) await seedCodexHooks(box.codexConfigVolume, box.image);
        const codexCfg = await loadEffectiveConfig(box.workspacePath);
        await startCodexSession({
          container: box.container,
          codexArgs: applyCodexSkipPermissions([], codexCfg.effective),
        });
        await waitForTmuxPaneContent(box.container, DEFAULT_CODEX_SESSION);
        return {
          kind: 'attach',
          command: 'docker',
          args: buildDashboardAttachArgv(box.container, DEFAULT_CODEX_SESSION),
          mode: 'codex',
        };
      };

      const startOpencode = async (boxId: string): Promise<RightTarget> => {
        const box = await findBox(boxId);
        if (isCloudBox(box)) {
          return buildCloudAttachTarget(await loadBoxRecord(boxId), 'opencode');
        }
        await ensureOpencodeInstalled(box.container);
        await startOpencodeSession({ container: box.container, opencodeArgs: [] });
        await waitForTmuxPaneContent(box.container, DEFAULT_OPENCODE_SESSION);
        return {
          kind: 'attach',
          command: 'docker',
          args: buildDashboardAttachArgv(box.container, DEFAULT_OPENCODE_SESSION),
          mode: 'opencode',
        };
      };

      const openShell = async (boxId: string): Promise<RightTarget> => {
        const box = await findBox(boxId);
        if (isCloudBox(box)) {
          return buildCloudAttachTarget(await loadBoxRecord(boxId), 'shell');
        }
        // Start-or-attach the box's tracked tmux `shell` session, so a shell
        // opened from the dashboard is the same detachable session the CLI
        // sees (`agentbox shell` / `agentbox shell ls`), not a throwaway exec.
        const info = await shellSessionInfo(box.container);
        if (!info.running) {
          await startShellSession({ container: box.container });
        }
        return {
          kind: 'attach',
          command: 'docker',
          args: buildShellSessionAttachArgv(box.container),
          mode: 'shell',
        };
      };

      // Non-interactive box creation from the "+ New box" entry: config
      // defaults only (no CLI overrides, no wizard, no setup-token prompt —
      // the TUI can't prompt). Mirrors the `agentbox <agent>` create block.
      const createNewBox = async (
        agent: 'claude' | 'codex' | 'opencode' | undefined,
        onProgress: (line: string) => void,
      ): Promise<{ boxId: string; attach?: RightTarget }> => {
        const cfg = await loadEffectiveConfig(project.root);
        const auth = await resolveClaudeAuth(process.env);
        // Dashboard create flow is docker-only — use the docker per-provider
        // default with the global fallback.
        const dockerDefault = resolveDefaultCheckpoint(cfg.effective, 'docker');
        const checkpointRef = dockerDefault.length > 0 ? dockerDefault : undefined;
        const result = await createBox({
          workspacePath: project.root,
          useSnapshot: cfg.effective.box.hostSnapshot ?? true,
          checkpointRef,
          image: resolveBoxImage(cfg.effective, 'docker'),
          claudeConfig: { isolate: cfg.effective.box.isolateClaudeConfig },
          claudeEnv: auth.env,
          // Pass the agent's config so createBox mounts + syncs its volume
          // (codex/opencode mount on detection too, but this makes it explicit
          // and applies the `--isolate-*-config` preference).
          ...(agent === 'codex'
            ? { codexConfig: { isolate: cfg.effective.box.isolateCodexConfig } }
            : {}),
          ...(agent === 'opencode'
            ? { opencodeConfig: { isolate: cfg.effective.box.isolateOpencodeConfig } }
            : {}),
          withPlaywright:
            cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser',
          withEnv: cfg.effective.box.withEnv,
          vnc: { enabled: cfg.effective.box.vnc },
          docker: { sharedCache: cfg.effective.box.dockerCacheShared },
          limits: resolveLimits(cfg.effective.box, {}),
          projectRoot: project.root,
          onLog: onProgress,
        });
        const ctr = result.record.container;
        if (!agent) return { boxId: result.record.id };
        if (agent === 'codex') {
          await ensureCodexInstalled(ctr, { onProgress });
          await startCodexSession({
            container: ctr,
            codexArgs: applyCodexSkipPermissions([], cfg.effective),
          });
          // Attach only once the agent TUI has drawn — see waitForTmuxPaneContent.
          await waitForTmuxPaneContent(ctr, DEFAULT_CODEX_SESSION);
          return {
            boxId: result.record.id,
            attach: {
              kind: 'attach',
              command: 'docker',
              args: buildDashboardAttachArgv(ctr, DEFAULT_CODEX_SESSION),
              mode: 'codex',
            },
          };
        }
        if (agent === 'opencode') {
          await ensureOpencodeInstalled(ctr, { onProgress });
          await startOpencodeSession({ container: ctr, opencodeArgs: [] });
          await waitForTmuxPaneContent(ctr, DEFAULT_OPENCODE_SESSION);
          return {
            boxId: result.record.id,
            attach: {
              kind: 'attach',
              command: 'docker',
              args: buildDashboardAttachArgv(ctr, DEFAULT_OPENCODE_SESSION),
              mode: 'opencode',
            },
          };
        }
        await rebuildPluginNativeDeps(ctr, { volume: result.record.claudeConfigVolume });
        await startClaudeSession({
          container: ctr,
          claudeArgs: applyClaudeSkipPermissions([], cfg.effective),
          boxName: result.record.name,
        });
        const info = await claudeSessionInfo(ctr);
        await waitForTmuxPaneContent(ctr, info.sessionName);
        return {
          boxId: result.record.id,
          attach: {
            kind: 'attach',
            command: 'docker',
            args: buildDashboardAttachArgv(ctr, info.sessionName),
            mode: 'claude',
          },
        };
      };

      // Detached + stdio ignored: never blocks the dashboard loop and can't
      // write into the alt-screen. (`open` mirrors url.ts but not
      // spawnSync/inherit, which would corrupt the TUI.)
      const detach = (cmd: string, args: string[]): void => {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      };

      const findEndpointUrl = async (
        boxId: string,
        kind: 'vnc' | 'web',
      ): Promise<{ name: string; url: string | null }> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return { name: boxId, url: null };
        const ep = box.endpoints.endpoints.find((e) => e.kind === kind);
        return { name: box.name, url: ep && ep.reachable && ep.url ? ep.url : null };
      };

      // The box web-app URL plus whether a service actually declares `expose:`
      // (engine-independent: the `web` endpoint is only reachable+url'd when a
      // service is exposed and the host port is resolved). On OrbStack prefer
      // the stable <container>.orb.local domain (routes to :80; WebProxy
      // forwards to the exposed service) over the loopback port, which Docker
      // reallocates on every restart. Mirrors `agentbox url`. Other
      // engines have no `.local` DNS, so use the published loopback endpoint.
      const webTarget = (box: ListedBox): { url: string; exposed: boolean } => {
        const ep = box.endpoints.endpoints.find((e) => e.kind === 'web');
        const exposed = Boolean(ep && ep.reachable && ep.url);
        const url = box.endpoints.domainIsOrb
          ? `http://${box.endpoints.domain}`
          : exposed && ep?.url
            ? ep.url
            : `http://${box.endpoints.domain}`;
        return { url, exposed };
      };

      const openScreen = async (boxId: string): Promise<string> => {
        const { url } = await findEndpointUrl(boxId, 'vnc');
        if (!url) return 'VNC not available for this box';
        let exposedWebUrl: string | null = null;
        try {
          const box = await findBox(boxId);
          const web = webTarget(box);
          if (web.exposed) exposedWebUrl = web.url;
          // Show the app inside the VNC desktop on the same URL the host uses;
          // ensureBoxBrowser routes a Portless `.localhost` URL via the host proxy.
          const br = await ensureBoxBrowser(
            box.container,
            undefined,
            web.exposed ? web.url : 'about:blank',
          );
          if (!br.up) return `VNC: in-box browser unavailable (${br.reason ?? 'box not running?'})`;
        } catch {
          // Best-effort — still open the viewer even if the box isn't running.
        }
        detach(hostOpenCommand(), [url]);
        if (exposedWebUrl) {
          detach(hostOpenCommand(), [exposedWebUrl]);
          return 'Opening VNC + web in browser…';
        }
        return 'Opening VNC in browser…';
      };

      const openUrl = async (boxId: string): Promise<string> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return 'box not found';
        const { url } = webTarget(box);
        detach(hostOpenCommand(), [url]);
        return `Opening ${url.replace(/^https?:\/\//, '')}…`;
      };

      const openCode = async (boxId: string): Promise<string> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return 'box not found';
        // Reuse the real `agentbox code` out-of-process (IDE detection,
        // code→cursor fallback) without its up-to-120s wait-ready blocking us.
        detach(process.execPath, [process.argv[1]!, 'code', box.name, '--no-wait']);
        return 'Launching VS Code / Cursor…';
      };

      // Lifecycle actions dispatch on provider: docker boxes go through the
      // sandbox-docker helpers (rich container/volume teardown for destroy,
      // etc.); cloud boxes go through `Provider.{pause,stop,start,resume,
      // destroy}(record)`. Mirrors the docker-vs-cloud split in `commands/
      // destroy.ts:46-75`.
      const resumeBox = async (boxId: string): Promise<void> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) throw new Error('box not found');
        if (isCloudBox(box)) {
          const record = await loadBoxRecord(boxId);
          const provider = await providerForBox(record);
          if (box.state === 'paused') await provider.resume(record);
          else await provider.start(record);
          // Cloud resume/start reboots the sandbox — the agent tmux session is
          // gone, so restore it (silent: the dashboard attaches to its pane).
          await restoreAgentSessions(record, provider);
          return;
        }
        if (box.state === 'paused') {
          // Docker unpause is a cgroup thaw — the agent session survives.
          await unpauseBox(box.id);
          return;
        }
        await startBox(box.id);
        // Docker stop→start killed the agent tmux session — restore it.
        const record = await loadBoxRecord(boxId);
        await restoreAgentSessions(record, await providerForBox(record));
      };

      const pauseBoxAction = async (boxId: string): Promise<void> => {
        const record = await loadBoxRecord(boxId);
        if ((record.provider ?? 'docker') !== 'docker') {
          const provider = await providerForBox(record);
          await provider.pause(record);
          return;
        }
        await pauseBox(boxId);
      };

      const stopBoxAction = async (boxId: string): Promise<void> => {
        const record = await loadBoxRecord(boxId);
        if ((record.provider ?? 'docker') !== 'docker') {
          const provider = await providerForBox(record);
          await provider.stop(record);
          return;
        }
        await stopBox(boxId);
      };

      const destroyBoxAction = async (boxId: string): Promise<void> => {
        const record = await loadBoxRecord(boxId);
        if ((record.provider ?? 'docker') !== 'docker') {
          const provider = await providerForBox(record);
          await provider.destroy(record);
          return;
        }
        await destroyBox(boxId);
      };

      const compositor = new Compositor(
        {
          ptySpawn,
          termCtor,
          // Host-side loopback URL the per-box SSE subscriptions connect to.
          // The relay binds 0.0.0.0; loopback is the admin/* path's required
          // source. Same constant the wrapped-pty wrappers use.
          relayBaseUrl: `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`,
          listCandidates,
          resolveTarget,
          startClaude,
          startCodex,
          startOpencode,
          openShell,
          createNewBox,
          resumeBox,
          pauseBox: pauseBoxAction,
          stopBox: stopBoxAction,
          destroyBox: destroyBoxAction,
          openScreen,
          openCode,
          openUrl,
        },
        initialId,
      );
      await compositor.run();
      process.exit(0);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
