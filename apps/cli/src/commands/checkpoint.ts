import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import {
  defaultCheckpointConfigKey,
  findProjectRoot,
  setConfigValue,
  unsetConfigValue,
  type ProviderKind,
} from '@agentbox/config';
import { resolveBoxOrExit } from '../box-ref.js';
import type {
  HubApiCheckpointCreate,
  HubApiCheckpointItem,
  HubApiClient,
} from '../control-plane/hub-api-client.js';
import { boxOwningHubIsLocal, withHubClient, withOwningHub } from '../control-plane/with-hub.js';
import { handleLifecycleError } from './_errors.js';
import { listProviderDescriptors, resolveProviderDescriptor } from '@agentbox/sandbox-core';

/**
 * `agentbox checkpoint` — capture and manage the warm box states new boxes start
 * from. `create` / `ls` / `rm` run through the hub's public `/api/v1`
 * (`POST /boxes/:id/checkpoint`, `GET|DELETE /checkpoints`); `set-default` stays a
 * local project-config write (there is no `/api/v1/config` surface) but validates
 * the ref against the hub's listing so it agrees with `ls`/`rm`.
 *
 * WHICH HUB: `create` is box-scoped, so it uses `withOwningHub` (docker/
 * remote-docker → local hub, cloud → the configured hub). `ls` / `rm` /
 * `set-default` are project-scoped and prefer the LOCAL hub (`preferLocal`), which
 * is the same hub docker `create` writes to AND the only one whose store the
 * project's path resolves against: checkpoint stores are keyed by a hash of the
 * project's ABSOLUTE PATH, which only matches the local filesystem — a remote
 * control box hashes a different path, so listing by this machine's project root
 * there would find nothing anyway. On a co-located hub (local or `hub expose`d —
 * both the same machine) `preferLocal` IS the one hub, so this is identical to the
 * default there. (Cloud checkpoints created on a genuinely-remote control box are
 * not listable from a thin laptop by path — an accepted cross-machine limitation
 * of path-hash-keyed stores, not a routing gap.)
 */

/**
 * Providers `set-default --provider` accepts: every runtime provider — built-in
 * or registered plugin — that supports checkpoints at all. Read from the
 * descriptor rather than a hardcoded list, so a community provider with a
 * `checkpoint` capability can carry a project default like any built-in.
 */
function checkpointProviders(): string[] {
  return listProviderDescriptors()
    .filter((d) => d.capabilities.checkpoints)
    .map((d) => d.name);
}

/** Whether capturing a checkpoint stops and reboots the box (vercel, daytona). */
function checkpointReboots(name: string): boolean {
  return resolveProviderDescriptor(name)?.capabilities.checkpointReboots ?? false;
}

interface CreateOpts {
  name?: string;
  merged?: boolean;
  setDefault?: boolean;
  replace?: boolean;
  yes?: boolean;
}

const createSub = new Command('create')
  .description('Capture a box state as a project checkpoint (<box-name>-<n>)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--name <name>', 'checkpoint name (default: <box-name>-<next>)')
  .option('--merged', 'flatten lower+upper into one tree instead of a layered delta')
  .option('--set-default', 'mark this checkpoint as the project default for new boxes')
  .option(
    '--replace',
    "if a checkpoint with the same name exists, rm it first (idempotent recapture; safe to retry when the previous run's stdout was lost)",
  )
  .option('-y, --yes', 'skip the vercel/daytona "box will reboot" confirmation prompt')
  .action(async (idOrName: string | undefined, opts: CreateOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const providerName = box.provider ?? 'docker';

      if (opts.merged && providerName !== 'docker') {
        log.warn('--merged is Docker-only (cloud snapshots are always flattened); ignoring');
      }

      // The vercel/daytona snapshot stops + reboots the box (the live agent process
      // doesn't survive). Confirm here on the laptop before yanking it — a TTY
      // interaction that must stay client-side; -y skips it.
      if (checkpointReboots(providerName) && !opts.yes && process.stdin.isTTY) {
        const ok = await confirm({
          message: `Create checkpoint? The ${providerName} box will stop and reboot.`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }
      if (providerName !== 'docker') {
        log.info(`capturing ${providerName} snapshot (this may take a few minutes)`);
      }

      let created: HubApiCheckpointCreate | undefined;
      const r = await withOwningHub(box, async (client) => {
        const info = await client.createCheckpoint(box.id, {
          name: opts.name,
          merged: opts.merged === true,
          setDefault: opts.setDefault === true,
          replace: opts.replace === true,
        });
        created = info;
        log.success(
          `checkpoint ${info.name} (${info.kind})` +
            (info.dir ? ` -> ${info.dir}` : ` (${info.provider} snapshot)`) +
            (info.setDefaultKey ? '  [project default]' : ''),
        );
        if (!info.setDefaultKey) {
          const hint =
            providerName === 'docker'
              ? `agentbox checkpoint set-default ${info.name}`
              : `agentbox checkpoint set-default --provider ${providerName} ${info.name}`;
          log.info(`make it the default for new boxes: ${hint}`);
        }
      });
      if (r === 'not-found') {
        log.error(`box ${box.name} was not found on any hub AgentBox knows.`);
        process.exit(2);
      }
      // `--set-default` wrote the default-checkpoint config on the HUB's host. When
      // the owning hub is REMOTE (a cloud box on a control box), mirror the pin into
      // THIS machine's project config too — otherwise a later local `agentbox
      // create` here resolves the stale default (the removed inline cloud path wrote
      // it locally; standalone `set-default` still does). Skipped for a local-owned
      // box (docker/remote-docker), whose hub IS this machine so the write already
      // landed here. Idempotent + best-effort.
      if (r === 'ok' && created?.setDefaultKey && !boxOwningHubIsLocal(box)) {
        const projectRoot = box.projectRoot ?? (await findProjectRoot(box.workspacePath)).root;
        await setConfigValue('project', created.setDefaultKey, created.ref, projectRoot).catch(
          () => {},
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** One checkpoint row, marked ` *default` when the server resolved it as the default. */
function itemRow(c: HubApiCheckpointItem): string {
  const label = c.provider === 'docker' ? `docker (${c.kind})` : `${c.provider} (${c.kind})`;
  const flag = c.isDefault ? ' *default' : '';
  return `${c.name}  ${label}  from ${c.sourceBoxName}  ${c.createdAt}${flag}`;
}

const lsSub = new Command('ls')
  .description("List this project's checkpoints (both docker and cloud); -g for all projects")
  .option('-g, --global', 'include checkpoints from all projects')
  .action(async (opts: { global?: boolean }) => {
    try {
      const project = opts.global ? undefined : (await findProjectRoot(process.cwd())).root;
      await withHubClient({ preferLocal: true }, async (client) => {
        const listing = await client.listCheckpoints({ project, global: opts.global });
        if (opts.global) {
          if (listing.projects.every((p) => p.items.length === 0)) {
            process.stdout.write('no checkpoints found\n');
            return;
          }
          let first = true;
          for (const p of listing.projects) {
            if (p.items.length === 0) continue;
            const loc = p.projectRoot ?? '(project config not found)';
            process.stdout.write(`${first ? '' : '\n'}${p.label}  (${loc})\n`);
            first = false;
            for (const c of p.items) process.stdout.write(`  ${itemRow(c)}\n`);
          }
          return;
        }
        const items = listing.projects[0]?.items ?? [];
        if (items.length === 0) {
          process.stdout.write(`no checkpoints for ${project ?? '(this project)'}\n`);
          return;
        }
        for (const c of items) process.stdout.write(`${itemRow(c)}\n`);
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** Whether the hub's listing for this project has a checkpoint `ref` (optionally for `provider`). */
async function checkpointExists(
  client: HubApiClient,
  project: string,
  ref: string,
  provider?: string,
): Promise<boolean> {
  const listing = await client.listCheckpoints({ project });
  const items = listing.projects[0]?.items ?? [];
  return items.some((c) => c.name === ref && (provider === undefined || c.provider === provider));
}

const setDefaultSub = new Command('set-default')
  .description('Pin a checkpoint as the project default (box.defaultCheckpoint)')
  .argument('[ref]', 'checkpoint name (omit with --clear)')
  .option('--clear', 'unset the project default instead of setting one')
  .option(
    '--provider <name>',
    'set the default for only this provider; without it, sets the cross-provider fallback',
  )
  .action(async (ref: string | undefined, opts: { clear?: boolean; provider?: string }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      const providerArg = opts.provider as ProviderKind | undefined;
      if (providerArg !== undefined && !checkpointProviders().includes(providerArg)) {
        throw new Error(
          `unknown provider '${opts.provider ?? ''}' (known: ${checkpointProviders().join(', ')})`,
        );
      }
      const configKey = defaultCheckpointConfigKey(providerArg);
      // Only BUILT-IN providers have a `box.defaultCheckpoint<P>` key; for a
      // plugin, `defaultCheckpointConfigKey` falls back to the generic
      // `box.defaultCheckpoint`, which EVERY provider without its own default
      // reads. Writing that silently under a `--provider` flag would hand a
      // plugin's snapshot to docker boxes, so say so instead of implying a
      // per-provider write happened.
      const perProvider = configKey !== 'box.defaultCheckpoint';
      if (providerArg !== undefined && !perProvider) {
        log.warn(
          `${providerArg} is a plugin provider, which has no per-provider default key — ` +
            `this sets the cross-provider ${configKey}, used by every provider without its own default.`,
        );
      }
      const label =
        providerArg && perProvider
          ? `${providerArg} default checkpoint`
          : 'project default checkpoint';
      if (opts.clear) {
        if (ref !== undefined) throw new Error('pass either a <ref> or --clear, not both');
        // Pure local config write — no hub round-trip needed to CLEAR a pointer.
        const rr = await unsetConfigValue('project', configKey, projectRoot);
        process.stdout.write(
          rr.existed
            ? `cleared ${label}   (wrote ${rr.path})\n`
            : `no ${label} was set   (${rr.path})\n`,
        );
        return;
      }
      if (ref === undefined)
        throw new Error('missing <ref> (or pass --clear to unset the default)');
      // Validate the ref against the hub's listing (agrees with `ls`/`rm`), then
      // write the pointer into the LOCAL project config (there is no config route;
      // for a co-located hub the store the hub lists IS this machine's).
      await withHubClient({ preferLocal: true }, async (client) => {
        const exists = await checkpointExists(client, projectRoot, ref, providerArg);
        if (!exists) {
          // Don't throw a plain Error here — withHubClient's mapper would render it
          // as a "can't reach the hub" transport failure. Report + set the exit
          // code directly (the ref genuinely resolved to nothing).
          log.error(`checkpoint not found: ${ref} (see \`agentbox checkpoint ls\`)`);
          process.exitCode = 2;
          return;
        }
        const rr = await setConfigValue('project', configKey, ref, projectRoot);
        process.stdout.write(`${label} = ${ref}   (wrote ${rr.path})\n`);
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const rmSub = new Command('rm')
  .description('Delete a checkpoint (any provider that has it)')
  .argument('<ref>', 'checkpoint name')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--provider <name>', "delete only from this provider's store (default: all)")
  .action(async (ref: string, opts: { yes?: boolean; provider?: string }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      if (!opts.yes) {
        const ok = await confirm({ message: `Delete checkpoint ${ref}?`, initialValue: false });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }
      await withHubClient({ preferLocal: true }, async (client) => {
        const res = await client.deleteCheckpoint({
          project: projectRoot,
          ref,
          provider: opts.provider,
        });
        for (const p of res.removed) process.stdout.write(`removed ${p} checkpoint ${ref}\n`);
        for (const key of res.clearedKeys) log.info(`cleared project ${key} (was ${ref})`);
        for (const key of res.warnedKeys) {
          log.warn(
            `${key} = ${ref} is set outside the per-project config (global or agentbox.yaml defaults) — clear it manually`,
          );
        }
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const checkpointCommand = new Command('checkpoint')
  .alias('checkpoints')
  .description('List and manage project checkpoints (warm box state new boxes can start from)')
  .addCommand(createSub)
  .addCommand(lsSub, { isDefault: true })
  .addCommand(setDefaultSub)
  .addCommand(rmSub);
