/**
 * `agentbox prepare --provider e2b` — bake the E2B base template.
 *
 * Unlike Vercel/Hetzner, E2B can build templates from a build DSL (the SDK's
 * `Template` + `Template.build`). We mirror Vercel's `prepare` shape but drive
 * the build through the SDK builder API instead of booting a sandbox + running
 * `provision.sh`:
 *
 *   1. Resolve runtime assets + fingerprint the build context. Skip-fast when
 *      an up-to-date template id is already recorded.
 *   2. Stage every resolved asset under a temp `fileContextPath` directory
 *      with predictable relative names (E2B's `template.copy(src, dest)`
 *      requires sources to be RELATIVE paths inside the context dir).
 *   3. `Template({ fileContextPath })` → `.fromBaseImage()` (E2B's default
 *      Debian 12 + node 20 + git + sudo). `.copy(rel, dest)` for each asset,
 *      `.runCmd('bash /tmp/agentbox-build-template.sh', { user: 'root' })`,
 *      `.setReadyCmd('test -x /usr/local/bin/agentbox-ctl')`.
 *   4. `Template.build(t, 'agentbox-base:<tag>', { cpuCount, memoryMB,
 *      onBuildLogs })` streams logs into the spinner; returns the BuildInfo
 *      with the template id.
 *   5. Persist `{ schema:1, base: { templateId, contextSha256, cliVersion,
 *      cliCommit, createdAt } }` to ~/.agentbox/e2b-prepared.json.
 *
 * Templates on E2B are reusable named resources addressed by id+tag. Re-running
 * with the same name reuses the existing template id (E2B's documented
 * behavior). Unlike Vercel snapshots there's no per-box eviction concern; one
 * template is reused for every create.
 *
 * vCPU / RAM are template-level on E2B — set them here so per-box `create`
 * doesn't try to override them (which E2B rejects).
 */

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Provider } from '@agentbox/core';
import {
  computeContextManifest,
  readCliStamp,
  stageAllAgentStatic,
  type AgentStaticStage,
  variantFingerprint,
  normalizeAgentSet,
  agentSetArg,
  resolveAgentSpec,
  resolveAgentInstall,
  renderInstallRecipe,
  renderAptInstall,
} from '@agentbox/sandbox-core';
import { ensureE2bCredentials } from './credentials.js';
import { resolveApiKey, Template } from './sdk.js';
import {
  preparedEntryFor,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
} from './prepared-state.js';
import {
  findStagedCliRuntimeRoot,
  resolveRuntimeAssets,
  type ResolvedAsset,
} from './runtime-assets.js';

export interface PrepareE2bOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when an up-to-date template id is recorded. */
  force?: boolean;
  /**
   * Bake-time `cpu-memory` GB size (e.g. `4-8`). Wins over `cpuCount`/`memoryMB`
   * when set. A third `-disk` slot is accepted with a warning (E2B has no disk
   * knob). Resolved by the CLI from `--size` / `box.sizeE2b` / `box.size`.
   */
  size?: string;
  /** vCPUs for the baked template (default 2). E2B applies this per-sandbox at boot. */
  cpuCount?: number;
  /** Memory in MiB for the baked template (default 4096). */
  memoryMB?: number;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
  /** How build-template.sh installs Claude Code (`native` default | `npm`). */
  claudeInstall?: 'native' | 'npm';
  onLog?: (line: string) => void;
  /**
   * Agents to build into a DERIVED template on top of the agentless base.
   * Empty/absent bakes the base itself. Not just another env var into the build
   * script: the set picks which template we build, which record we write, and
   * which template a later create boots from.
   */
  agents?: string[];
}

export interface PrepareE2bResult {
  snapshotName?: string;
}

/** Template name agentbox bakes under. E2B treats `name:tag` as a single addressable build. */
const TEMPLATE_NAME = 'agentbox-base:latest';
const DEFAULT_TAG = 'latest';

/**
 * Template name for one agent set. E2B names allow `[a-zA-Z0-9-_]`, so a
 * multi-agent set joins with `-` rather than the `,` the variant key uses.
 */
function templateNameFor(variantKey: string): string {
  if (variantKey === '') return TEMPLATE_NAME;
  return `agentbox-${variantKey.replaceAll(',', '-')}:${DEFAULT_TAG}`;
}

const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 4096;

/**
 * Parse a `cpu-memory` GB size spec (e.g. `4-8`) into E2B's
 * `{ cpuCount, memoryMB }`. A third `-disk` slot is accepted but ignored with a
 * warning (E2B's `Template.build` has no disk knob). Returns `undefined` for an
 * empty/unset spec (caller keeps its defaults); throws on a malformed spec so
 * `prepare` surfaces it rather than silently baking the default size.
 *
 * Exported for unit tests.
 */
export function parseE2bSize(
  spec: string | undefined,
  warn?: (msg: string) => void,
): { cpuCount: number; memoryMB: number } | undefined {
  const trimmed = (spec ?? '').trim();
  if (trimmed === '') return undefined;
  const parts = trimmed.split('-');
  const bad = (): never => {
    throw new Error(`invalid --size '${trimmed}' for e2b: expected 'cpu-memory' GB, e.g. '4-8'.`);
  };
  if (parts.length < 2 || parts.length > 3) bad();
  const nums = parts.map((p) => Number(p));
  // Every present slot must be a positive integer (rejects '4-8-', 'a-b', '0-8').
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) bad();
  if (parts.length === 3) {
    warn?.(
      `e2b: ignoring the disk slot in size '${trimmed}' — E2B templates have no disk knob; ` +
        `only cpu-memory (${String(nums[0])}-${String(nums[1])}) is applied.`,
    );
  }
  return { cpuCount: nums[0]!, memoryMB: nums[1]! * 1024 };
}

/** Normalize a parsed E2B size back to a canonical `cpu-memGB` key for the prepared state. */
function e2bSizeKey(parsed: { cpuCount: number; memoryMB: number }): string {
  return `${String(parsed.cpuCount)}-${String(parsed.memoryMB / 1024)}`;
}

/** Wrap a shell snippet in single quotes for safe nesting inside `bash -lc`. */
function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export async function prepareE2b(opts: PrepareE2bOptions = {}): Promise<PrepareE2bResult> {
  await ensureE2bCredentials();
  const apiKey = resolveApiKey();
  const log = opts.onLog ?? (() => {});
  const progress = (s: string) => log(`prepare-e2b: ${s}`);

  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  const claudeInstall = opts.claudeInstall ?? 'native';
  // Keep the per-file digests, not just the fold: a later `stale` verdict can
  // then name the files that changed instead of only reporting a moved hash.
  const contextManifest = await computeContextManifest(
    assets.map((a) => ({ rel: a.name, abs: a.localPath })),
  );
  const agents = normalizeAgentSet(opts.agents);
  const variantKey = agentSetArg(agents);
  const derived = agents.length > 0;
  const templateName = templateNameFor(variantKey);
  const contextSha = variantFingerprint(contextManifest.contextSha256, { claudeInstall, agents });

  // Bake-time size. A `--size` / `box.sizeE2b` like `4-8` overrides the default
  // cpu/memory (E2B rejects per-create resources, so it MUST be baked). The
  // normalized `cpu-memGB` key gates skip-fast so a re-sized bake rebuilds.
  const parsedSize = parseE2bSize(opts.size, (m) => log(m));
  const sizeKey = parsedSize ? e2bSizeKey(parsedSize) : undefined;

  // Skip-fast: existing template + matching fingerprint.
  //
  // Probe the persisted templateId itself, not TEMPLATE_NAME. If someone
  // (or another bake) rebuilt the alias under a different id, the name still
  // resolves but the stored id is stale and `Sandbox.create({ template: <stale id> })`
  // 404s. `Template.exists` accepts both `name:tag` and `template-id:tag`
  // forms, so we pass the exact id we'd later hand to `provision`.
  const existing = readPreparedState();

  // A derived build starts FROM the agentless base, so that has to exist first.
  const baseEntry = preparedEntryFor(existing, '');
  if (derived && !baseEntry) {
    throw new Error(
      'no E2B base template to derive from — run `agentbox prepare --provider e2b` first, ' +
        'then re-run with --agents.',
    );
  }

  const existingEntry = preparedEntryFor(existing, variantKey);
  if (!opts.force && existingEntry) {
    const bakedSize = existingEntry.size;
    const label = derived ? `${variantKey} template` : 'template';
    if (existingEntry.contextSha256 === contextSha && bakedSize === sizeKey) {
      const stillThere = await templateExists(existingEntry.templateId, apiKey);
      if (stillThere) {
        progress(
          `${label} ${existingEntry.templateId} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping (pass --force to rebuild)`,
        );
        return { snapshotName: existingEntry.templateId };
      }
      progress(`recorded ${label} ${existingEntry.templateId} is gone on E2B; rebuilding`);
    } else if (existingEntry.contextSha256 === contextSha && bakedSize !== sizeKey) {
      progress(
        `size changed (was ${bakedSize ?? 'default'}, now ${sizeKey ?? 'default'}); rebuilding`,
      );
    } else {
      progress(
        `build context changed (was ${existingEntry.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding ${label}`,
      );
    }
  }

  // E2B's `template.copy(src, dest)` requires `src` to be a RELATIVE path
  // inside the Template's `fileContextPath`. Stage every resolved asset into
  // a temp dir under its logical name (asset.name) so the copy chain reads
  // from a single context root.
  const contextDir = await mkdtemp(join(tmpdir(), 'agentbox-e2b-build-'));
  let agentStages: AgentStaticStage[] = [];
  try {
    progress(`staging build context at ${contextDir}`);
    await stageAssetsInto(contextDir, assets);

    // Stage the host's per-tool static config (shared sync-layer producer) and
    // copy each tarball into the build context (E2B copy sources must be
    // relative to fileContextPath).
    agentStages = await stageAllAgentStatic({ hostWorkspace: opts.hostWorkspace });
    for (const s of agentStages) for (const w of s.staged.warnings) log(w);
    const usableStages = agentStages.filter((s) => s.staged.tarballPath !== null);
    for (const s of usableStages) {
      await copyFile(
        s.staged.tarballPath as string,
        resolve(contextDir, e2bStagePaths(s.kind).contextRel),
      );
    }

    // Build the Template via the SDK builder. fromBaseImage() starts from E2B's
    // own `e2bdev/base` (Debian 12 + node 20 + git + sudo), which halves the
    // install time vs starting from a vanilla Debian image.
    // A derived build starts FROM the recorded agentless base template and adds
    // only the agent recipe — E2B is the one provider where deriving needs no
    // boot at all, so a variant costs a build, not a VPS-minute.
    //
    // The base build stays as it was: fromBaseImage() starts from E2B's own
    // `e2bdev/base` (Debian 12 + node 20 + git + sudo), which halves the install
    // time vs a vanilla Debian image.
    progress(
      derived
        ? `assembling derived template build (fromTemplate ${baseEntry!.templateId} + ${variantKey})`
        : 'assembling template build (fromBaseImage + asset copy + runCmd)',
    );
    const template = derived
      ? Template({ fileContextPath: contextDir }).fromTemplate(baseEntry!.templateId)
      : Template({ fileContextPath: contextDir }).fromBaseImage();

    if (derived) {
      // Same AGENT_SYNC_SPECS recipes the docker derived layer, the hetzner
      // derived snapshot and `ensureAgentInstalled` use, so however an agent
      // reaches a box it is installed identically.
      for (const id of agents) {
        const spec = resolveAgentSpec(id);
        const install = resolveAgentInstall(spec.install, claudeInstall);
        progress(`  install ${spec.id}`);
        if (install.apt && install.apt.length > 0) {
          template.runCmd(renderAptInstall(install.apt), { user: 'root' });
        }
        const recipe = renderInstallRecipe(install.recipe);
        // `runAs: 'box-user'` is load-bearing: the native installers write into
        // the INVOKING user's ~/.local/bin, so as root the binary lands in
        // /root and the box user never sees it. E2B's runCmd takes a `user`,
        // but we go through `sudo -u vscode -H bash -lc` for the same reason
        // hetzner does — a login shell, and one form across providers.
        template.runCmd(
          install.runAs === 'box-user'
            ? `sudo -u vscode -H bash -lc ${shellSingleQuote(recipe)}`
            : recipe,
          { user: 'root' },
        );
        if (install.postInstall) template.runCmd(install.postInstall, { user: 'root' });
      }
    } else {
      for (const a of assets) {
        progress(`  copy ${a.name} -> ${a.remotePath}`);
        template.copy(a.name, a.remotePath, {
          forceUpload: true,
          mode: a.remoteMode,
          user: 'root',
        });
      }
      template.runCmd('bash /tmp/agentbox-build-template.sh 2>&1', { user: 'root' });
    }

    // Seed the host's static agent config ON TOP of the built box (the vscode
    // user + home dirs exist only after build-template.sh). Copy each staged
    // tarball into the build, then one root pass extracts + chowns them —
    // mirrors Vercel/Hetzner/Daytona's host-static bake.
    // On a derived build, stage only THIS variant's agent config: putting
    // codex/opencode settings into a claude-only template would ship config for
    // agents that template will never run. `agents` (shared skills, not auth) is
    // always staged. The agentless base still carries all three, so an agent
    // installed at runtime still finds its plugins and settings.
    const wantsStage = (kind: AgentStaticStage['kind']): boolean =>
      !derived || kind === 'agents' || agents.includes(kind);
    const stagesForBuild = usableStages.filter((s) => wantsStage(s.kind));
    for (const s of stagesForBuild) {
      const { contextRel, remoteTar } = e2bStagePaths(s.kind);
      progress(`  seed ${s.kind} static -> ${s.extractDir}`);
      template.copy(contextRel, remoteTar, { forceUpload: true, mode: 0o644, user: 'root' });
    }
    if (stagesForBuild.length > 0) {
      const extract =
        stagesForBuild
          .map(
            (s) =>
              `mkdir -p ${s.extractDir} && tar -xzf ${e2bStagePaths(s.kind).remoteTar} -C ${s.extractDir} --no-same-permissions --no-same-owner -m`,
          )
          .join(' && ') +
        // Guard each chown: with an agentless base and per-variant staging,
        // any of these dirs can legitimately be absent (the agent that owns it
        // was never installed here), and an unguarded chown fails the build.
        ' && for d in /home/vscode/.claude /home/vscode/.codex /home/vscode/.local /home/vscode/.agents;' +
        ' do [ -e "$d" ] && chown -R vscode:vscode "$d"; done' +
        ' ; rm -f /tmp/agentbox-seed-*.tar.gz';
      template.runCmd(extract, { user: 'root' });
    }
    // setReadyCmd flips the builder into TemplateFinal — required for build().
    // The base checks the ctl bundle the script's last `install` step lands; a
    // variant additionally proves its agent is on the BOX USER's PATH, which is
    // the thing that actually breaks (a native installer that writes to /root
    // exits 0 and leaves the box unusable).
    const readyCmd = derived
      ? agents
          .map(
            (id) =>
              `sudo -u vscode -H bash -lc 'command -v ${resolveAgentSpec(id).binary} >/dev/null'`,
          )
          .concat('test -x /usr/local/bin/agentbox-ctl')
          .join(' && ')
      : 'test -x /usr/local/bin/agentbox-ctl';
    const finalTemplate = template.setReadyCmd(readyCmd);

    // Parsed `--size` wins over the explicit cpuCount/memoryMB options, which
    // win over the built-in defaults.
    const cpuCount = parsedSize?.cpuCount ?? opts.cpuCount ?? DEFAULT_CPU;
    const memoryMB = parsedSize?.memoryMB ?? opts.memoryMB ?? DEFAULT_MEMORY_MB;
    progress(
      `running Template.build('${templateName}', { cpuCount: ${String(cpuCount)}, memoryMB: ${String(memoryMB)} })`,
    );
    const info = await Template.build(finalTemplate, templateName, {
      apiKey,
      cpuCount,
      memoryMB,
      onBuildLogs: (entry: LogEntryLike) => {
        // LogEntry exposes timestamp / level / message; stream the human form.
        log(`[build] ${formatBuildLog(entry)}`);
      },
    });
    progress(`template built: id=${info.templateId} build=${info.buildId} name=${info.name}`);

    // Persist. `Sandbox.create({ template })` auto-appends `:default` when no
    // tag is given (and 404s if that tag wasn't built), so we MUST store the
    // tagged form. `info.templateId` is just the raw id with no tag; use the
    // first tag we built with (`latest`) or fall back to `info.tags[0]`.
    const tag = info.tags?.[0] ?? DEFAULT_TAG;
    const cliStamp = readCliStamp();
    const taggedId = `${info.templateId}:${tag}`;
    const entry = {
      templateId: taggedId,
      // info.name is the full `name:tag` pair Template.build() was called
      // with (e.g. `agentbox-base:latest`). Earlier code re-appended `:${tag}`
      // and produced `agentbox-base:latest:latest` in the status display.
      templateName: info.name,
      contextSha256: contextSha,
      files: contextManifest.files,
      ...(sizeKey ? { size: sizeKey } : {}),
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
      createdAt: new Date().toISOString(),
    };
    const prior = readPreparedState();
    writePreparedState({
      schema: 2,
      // Merge, never replace: each variant keeps its own record, so building
      // the codex template doesn't invalidate the claude one.
      variants: { ...prior.variants, [variantKey]: entry },
      // `base` stays the AGENTLESS base, never the newest build — the
      // provider-generic readers (freshness, bake sharing, custody adoption)
      // reach straight for `base.contextSha256` and assume it describes the
      // agentless build context.
      ...(derived ? (prior.base ? { base: prior.base } : {}) : { base: entry }),
    });
    progress(`wrote ${preparedStatePath()}`);

    // No GC here, unlike hetzner. E2B templates are NAMED resources: rebuilding
    // `agentbox-claude:latest` moves the tag, so a rebuild replaces rather than
    // orphans, and the SDK exposes no template delete to reap an id with.
    progress(
      `prepare complete — ${derived ? `${variantKey} template` : 'base template'} ${taggedId}`,
    );
    return { snapshotName: taggedId };
  } finally {
    await Promise.all(agentStages.map((s) => s.staged.cleanup())).catch(() => {
      // best-effort: staged-tarball cleanup failures are noise.
    });
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      // best-effort: temp dir cleanup failures are noise, not errors.
    });
  }
}

/**
 * Copy every asset into `contextDir` under its logical `name`. Preserves the
 * source mode on the copy (E2B's `template.copy` also accepts a `mode`
 * override, but the on-disk mode keeps the local stage representative).
 */
async function stageAssetsInto(contextDir: string, assets: ResolvedAsset[]): Promise<void> {
  for (const a of assets) {
    const dest = resolve(contextDir, a.name);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(a.localPath, dest);
  }
}

/** E2B build paths for a staged tool (derived from its kind). E2B copy sources
 *  must be RELATIVE to the Template `fileContextPath`, so the tarball is staged
 *  into the context dir under `contextRel` then copied to `remoteTar`. */
function e2bStagePaths(kind: AgentStaticStage['kind']): { contextRel: string; remoteTar: string } {
  return {
    contextRel: `agentbox-seed-${kind}.tar.gz`,
    remoteTar: `/tmp/agentbox-seed-${kind}.tar.gz`,
  };
}

/**
 * Check if a named template is bootable on E2B. Returns true on a 'ready'
 * build, false on anything else (deleted, errored, never built). Used by the
 * skip-fast path to detect a template that was deleted out-of-band.
 */
async function templateExists(name: string, apiKey: string): Promise<boolean> {
  try {
    return await Template.exists(name, { apiKey });
  } catch {
    return false;
  }
}

/**
 * E2B's `LogEntry` shape (timestamp, level, message). We treat the SDK's
 * type loosely here so the line-stream doesn't bind us to internal class
 * shapes — only the `.toString()` plus `.message` are documented.
 */
interface LogEntryLike {
  message?: string;
  level?: string;
  timestamp?: Date;
  toString(): string;
}

function formatBuildLog(entry: LogEntryLike): string {
  // The SDK's LogEntry.toString() emits a `[level] timestamp message` form.
  // For the spinner we only want the message — and clip overly long lines.
  const raw = typeof entry.message === 'string' ? entry.message : entry.toString();
  const cleaned = raw.replace(/\r?\n+$/, '');
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
}

/** Provider-level binding used by the CLI's `prepare` command. */
export const prepareE2bProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareE2b({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    size: req.size,
    claudeInstall: req.claudeInstall,
    ...(req.agents ? { agents: req.agents } : {}),
    onLog: req.onLog,
  });
