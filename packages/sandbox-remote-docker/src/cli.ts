/**
 * `agentbox remote-docker` — the provider's own commands.
 *
 * There is no `login` here, unlike every other cloud: the provider has no
 * credential of its own, it just uses your ssh. A host is registered by a short
 * ALIAS (`add <alias> <ssh>`); boxes are created against the alias and it's the
 * alias — not the connection string — that gets baked into a box's id, so
 * `update <alias> <new-ssh>` retargets existing boxes after an IP change.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { loadEffectiveConfig, setConfigValue, unsetConfigValue } from '@agentbox/config';
import { statusBadge, type CheckResult } from '@agentbox/sandbox-core';
import { probeRemoteEngine } from './remote-docker.js';
import { prepareRemoteDocker } from './prepare.js';
import { readPreparedState, removePreparedHost } from './prepared-state.js';
import {
  assertValidAlias,
  getHostAlias,
  listHostAliases,
  removeHostAlias,
  upsertHostAlias,
} from './hosts-registry.js';

export const remoteDockerCommand = new Command('remote-docker')
  .description('Remote Docker provider — run boxes on your own machine over SSH')
  .addCommand(
    new Command('add')
      .description('Register a host alias (name → SSH connection) for `--provider docker:<alias>`')
      .argument('<alias>', 'a short name for the host (letters, digits, `.`, `_`, `-`)')
      .argument('<ssh>', 'the SSH connection: `~/.ssh/config` alias or `[user@]host[:port]`')
      .option('-d, --default', 'also set it as the default host (box.remoteDockerHost) for this project')
      .option('-g, --global', 'set it as the default host, written to global config (implies --default)')
      .option('-n, --no-bake', 'skip baking the box image on the host (it builds lazily on first create)')
      .action(
        async (
          alias: string,
          ssh: string,
          opts: { default?: boolean; global?: boolean; bake?: boolean },
        ) => {
          try {
            assertValidAlias(alias);
          } catch (err) {
            p.log.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
            return;
          }
          if (getHostAlias(alias)) {
            p.log.error(
              `host alias '${alias}' already exists — change its connection with \`agentbox remote-docker update ${alias} <ssh>\``,
            );
            process.exitCode = 1;
            return;
          }
          const s = p.spinner();
          s.start(`probing ${ssh}`);
          const res = await probeRemoteEngine(ssh);
          if (!res.ok) {
            s.stop(`${ssh}: unusable`);
            p.log.error(res.error ?? 'remote engine unusable');
            process.exitCode = 1;
            return;
          }
          s.stop(`${ssh}: docker ${res.version} (${res.os}/${res.arch})`);
          upsertHostAlias(alias, ssh);
          p.log.success(`registered '${alias}' → ${ssh}`);

          if (opts.default || opts.global) {
            const scope = opts.global ? 'global' : 'project';
            await setConfigValue(scope, 'box.remoteDockerHost', alias, process.cwd(), {
              raw: true,
            });
            p.log.success(`'${alias}' is now the default remote-docker host (${scope})`);
          } else {
            p.log.info(
              `use it with \`agentbox docker:${alias} claude\` (add \`--default\` to skip the prefix)`,
            );
          }

          // Bake the box image on the host now (unless --no-bake), so the first
          // create is instant. A GHCR pull is fast; a registry-miss build is slow.
          // Best-effort: a failure leaves the alias registered and the image
          // builds lazily on first create.
          if (opts.bake !== false) {
            const cfg = await loadEffectiveConfig(process.cwd());
            const claudeInstall = cfg.effective.box.claudeInstall;
            const bs = p.spinner();
            bs.start(`baking the box image on ${alias} (first time can take a few minutes)`);
            try {
              await prepareRemoteDocker({
                host: alias,
                ...(claudeInstall ? { claudeInstall } : {}),
                onLog: (line) => bs.message(line.slice(0, 80)),
              });
              bs.stop(`box image ready on ${alias}`);
            } catch (err) {
              bs.stop('box image bake failed');
              p.log.warn(
                `${err instanceof Error ? err.message : String(err)} — it will build on first create, or run \`agentbox prepare --provider docker:${alias}\``,
              );
            }
          }

          // With more than one host registered, the default is ambiguous — remind
          // how to target a specific one.
          const hostCount = listHostAliases().length;
          if (hostCount > 1) {
            p.log.info(
              `you have ${String(hostCount)} remote hosts — run \`agentbox docker:${alias} claude\` to use this one`,
            );
          }
        },
      ),
  )
  .addCommand(
    new Command('update')
      .description('Change the SSH connection string for an existing host alias')
      .argument('<alias>', 'the alias to retarget')
      .argument('<ssh>', 'the new SSH connection: `~/.ssh/config` alias or `[user@]host[:port]`')
      .action(async (alias: string, ssh: string) => {
        if (!getHostAlias(alias)) {
          p.log.error(
            `no such host alias '${alias}' — register it with \`agentbox remote-docker add ${alias} ${ssh}\``,
          );
          process.exitCode = 1;
          return;
        }
        const s = p.spinner();
        s.start(`probing ${ssh}`);
        const res = await probeRemoteEngine(ssh);
        if (!res.ok) {
          s.stop(`${ssh}: unusable`);
          p.log.error(res.error ?? 'remote engine unusable');
          process.exitCode = 1;
          return;
        }
        s.stop(`${ssh}: docker ${res.version} (${res.os}/${res.arch})`);
        upsertHostAlias(alias, ssh);
        p.log.success(`updated '${alias}' → ${ssh} (existing boxes now use this connection)`);
      }),
  )
  .addCommand(
    new Command('remove')
      .alias('rm')
      .description('Forget a host alias: drop it, clear the default, and its baked image record')
      .argument('<alias>', 'the alias to forget')
      .action(async (alias: string) => {
        // No probe: you must be able to remove a host that's now unreachable/dead.
        const droppedAlias = removeHostAlias(alias);

        const cfg = await loadEffectiveConfig(process.cwd());
        const clearedScopes: string[] = [];
        for (const scope of ['project', 'global'] as const) {
          if (cfg.layers[scope].values.box?.remoteDockerHost === alias) {
            await unsetConfigValue(scope, 'box.remoteDockerHost', process.cwd());
            clearedScopes.push(scope);
          }
        }
        const inWorkspace = cfg.layers.workspace.values.box?.remoteDockerHost === alias;
        const forgotBake = removePreparedHost(alias);

        if (!droppedAlias && clearedScopes.length === 0 && !inWorkspace && !forgotBake) {
          p.log.info(`'${alias}' is not a registered, configured, or baked remote-docker host`);
          return;
        }
        const cleared: string[] = [];
        if (droppedAlias) cleared.push('alias');
        if (clearedScopes.length > 0) cleared.push(`${clearedScopes.join(' + ')} default`);
        if (forgotBake) cleared.push('baked image record');
        p.log.success(`removed ${alias}${cleared.length ? ` (${cleared.join(', ')})` : ''}`);

        const boxes = boxesUsingAlias(alias);
        if (boxes.length > 0) {
          p.log.warn(
            `${boxes.length} box(es) were created against '${alias}' and are now unreachable — ` +
              `re-add it with \`agentbox remote-docker add ${alias} <ssh>\`: ${boxes.join(', ')}`,
          );
        }
        if (inWorkspace) {
          p.log.warn(
            `'${alias}' is also set as box.remoteDockerHost in this project's agentbox.yaml — remove it there too`,
          );
        }
      }),
  )
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('List your registered host aliases (and any baked-but-unregistered hosts)')
      .action(async () => {
        const aliases = listHostAliases();
        const baked = readPreparedState()?.hosts ?? {};
        const configured = (await configuredHost()).trim();

        if (aliases.length === 0 && Object.keys(baked).length === 0) {
          p.log.info(
            'no host aliases yet — add one with `agentbox remote-docker add <alias> <[user@]host[:port]>`',
          );
          return;
        }
        for (const { alias, entry } of aliases) {
          const bakedInfo = baked[alias];
          const bakePart = bakedInfo ? `  [${bakedInfo.imageRef}]` : '  (not baked yet)';
          const dflt = alias === configured ? '  (default)' : '';
          p.log.info(`${alias}  →  ${entry.ssh}${bakePart}${dflt}`);
        }
        // Baked hosts with no matching alias — legacy ids created before the
        // registry, or a host whose alias was removed. Surface so `list` is total.
        for (const [host, info] of Object.entries(baked)) {
          if (aliases.some((a) => a.alias === host)) continue;
          p.log.info(`${host}  (unregistered)  [${info.imageRef}]`);
        }
      }),
  )
  .addCommand(
    new Command('doctor')
      .description('Check whether a host can run boxes (ssh reachable + docker present)')
      .argument('[host]', 'a registered alias OR a raw `[user@]host[:port]` (default: box.remoteDockerHost)')
      .action(async (host?: string) => {
        const name = (host ?? (await configuredHost())).trim();
        if (!name) {
          p.log.error(
            'no host — pass one (`agentbox remote-docker doctor <alias|ssh>`) or set a default with `agentbox remote-docker add`',
          );
          process.exitCode = 1;
          return;
        }
        // doctor is a read-only compatibility probe: run it against a registered
        // alias OR a raw connection string, so you can vet a host BEFORE `add`ing
        // it. Alias-only strictness belongs to create/prepare, not diagnostics.
        const entry = getHostAlias(name);
        const connection = entry ? entry.ssh : name;

        const probe = await probeRemoteEngine(connection);
        const rows: CheckResult[] = probe.steps.map((step) => ({
          label: step.label,
          status: step.ok ? 'ok' : 'fail',
          detail: step.detail,
          ...(step.hint ? { hint: step.hint } : {}),
        }));
        // Bake status is a local record — only meaningful once the engine is reachable.
        if (probe.ok) {
          const bakedInfo = readPreparedState()?.hosts[name];
          rows.push(
            bakedInfo
              ? {
                  label: 'box image',
                  status: 'ok',
                  detail: `${bakedInfo.imageRef} (${bakedInfo.cliVersion ?? '—'})`,
                }
              : {
                  label: 'box image',
                  status: 'info',
                  detail: 'not baked yet',
                  hint: `first create bakes it, or \`agentbox prepare --provider docker:${name}\``,
                },
          );
        }
        // A usable-but-unregistered host is fine to probe — just remind that a box
        // can only be created against a registered alias.
        if (!entry) {
          rows.push({
            label: 'alias',
            status: 'warn',
            detail: 'not registered',
            hint: `register to create boxes here: \`agentbox remote-docker add <alias> ${connection}\``,
          });
        }
        // Render like `agentbox doctor`: one badged row per check.
        const header = entry ? `${name} → ${entry.ssh}` : name;
        process.stdout.write(`remote-docker: ${header}\n`);
        for (const r of rows) {
          const label = r.label.padEnd(10);
          const tail = r.hint ? `  (${r.hint})` : '';
          process.stdout.write(`  ${statusBadge(r.status)} ${label} ${r.detail}${tail}\n`);
        }
        // Exit non-zero only when the host is actually unusable; "not registered"
        // is a heads-up, not a failure.
        if (!probe.ok) process.exitCode = 1;
      }),
  );

/** Box names whose sandbox id was baked against `alias` (i.e. `"<alias>/…"`). */
function boxesUsingAlias(alias: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.agentbox', 'state.json'), 'utf8')) as {
      boxes?: Array<{ name?: string; provider?: string; cloud?: { sandboxId?: string } }>;
    };
    return (raw.boxes ?? [])
      .filter(
        (b) =>
          b.provider === 'remote-docker' &&
          typeof b.cloud?.sandboxId === 'string' &&
          b.cloud.sandboxId.startsWith(`${alias}/`),
      )
      .map((b) => b.name ?? '(unnamed)');
  } catch {
    return [];
  }
}

async function configuredHost(): Promise<string> {
  const cfg = await loadEffectiveConfig(process.cwd());
  return cfg.effective.box.remoteDockerHost || '';
}
