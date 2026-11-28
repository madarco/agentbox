/**
 * `agentbox agent add|list|remove` — externally-installed agents.
 *
 * The provider twin of `agentbox plugin add`, and deliberately the same shape:
 * load the package once, validate what it exports, then SNAPSHOT the spec into
 * `~/.agentbox/agents.json` so nothing afterwards has to import the package to
 * know the agent exists.
 *
 * It is simpler than the provider version for one reason: an agent's descriptor
 * IS its `AgentSyncSpec`, which is already pure JSON — the spec has never been
 * allowed to hold a function, because it is shipped into boxes whose
 * `agentbox-ctl` predates the agent. So there is nothing to derive.
 */
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import {
  addAgentPluginRecord,
  agentSpecProblem,
  builtinAgentIds,
  BUILTIN_AGENT_SPECS,
  isSupportedAgentApiVersion,
  readAgentRegistrySync,
  removeAgentPluginRecord,
  SUPPORTED_AGENT_API_VERSIONS,
} from '@agentbox/agent-registry';
import type { AgentSyncSpec } from '@agentbox/core';
import { confirm, log } from '@agentbox/cli-kit';
import { accountConfigVolume } from '@agentbox/core';
import {
  boxesOnAccount,
  purgeAgentAccounts,
  readState,
  storedAccountIds,
} from '@agentbox/sandbox-core';
import { execa } from 'execa';
import { resolvePackage } from './plugin.js';

/** Names a plugin may not claim: every built-in id AND every built-in alias. */
function builtinNames(): Set<string> {
  return new Set(BUILTIN_AGENT_SPECS.flatMap((s) => [s.id, ...s.aliases]));
}

async function loadAndValidate(
  entryPath: string,
  packageName: string,
  declaredApiVersion?: number,
): Promise<{ specs: Record<string, AgentSyncSpec>; apiVersion: number }> {
  const mod = (await import(pathToFileURL(entryPath).href)) as {
    agentSpec?: AgentSyncSpec;
    agentSpecs?: AgentSyncSpec[];
    AGENT_API_VERSION?: number;
    apiVersion?: number;
  };
  const all = mod.agentSpecs ?? (mod.agentSpec ? [mod.agentSpec] : []);
  if (all.length === 0) {
    throw new Error(
      `package "${packageName}" does not export an \`agentSpec\` (or \`agentSpecs\`) — it is not an AgentBox agent package`,
    );
  }

  const apiVersion = declaredApiVersion ?? mod.apiVersion ?? mod.AGENT_API_VERSION ?? 1;
  if (!isSupportedAgentApiVersion(apiVersion)) {
    throw new Error(
      `package "${packageName}" targets agent API v${String(apiVersion)}; this AgentBox supports v${SUPPORTED_AGENT_API_VERSIONS.join(', v')}`,
    );
  }

  const taken = builtinNames();
  const specs: Record<string, AgentSyncSpec> = {};
  for (const spec of all) {
    // Validate here rather than at box-create time: this is the moment someone
    // can actually fix the package.
    const problem = agentSpecProblem(spec);
    if (problem !== null) {
      throw new Error(`package "${packageName}" exports an unusable agent spec: ${problem}`);
    }
    for (const name of [spec.id, ...spec.aliases]) {
      if (taken.has(name)) {
        throw new Error(
          `package "${packageName}" tries to register "${name}", which is a built-in agent (or one of its aliases) — a plugin cannot shadow a built-in`,
        );
      }
    }
    specs[spec.id] = spec;
  }
  return { specs, apiVersion };
}

/**
 * `agent remove`: unregister the package and, when asked (or `--purge-accounts`),
 * delete its agents' named accounts. Never under a box that still records one
 * (the `credentials rm` rule): re-adding the name later would inherit that box.
 */
async function removeAgentPackage(
  packageName: string,
  opts: { purgeAccounts?: boolean; keepAccounts?: boolean },
): Promise<void> {
  const record = readAgentRegistrySync().agents.find((r) => r.packageName === packageName);
  const specs = Object.values(record?.specs ?? {});
  let stored: { agent: string; id: string }[] = [];
  try {
    stored = await storedAccountIds(specs.map((s) => s.id));
  } catch (err) {
    // A damaged accounts.json: nothing can be purged, so say so up front.
    if (opts.purgeAccounts) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  const boxes = stored.length > 0 ? (await readState().catch(() => null))?.boxes : [];
  const inUse = boxes
    ? stored.flatMap((a) =>
        boxesOnAccount(boxes, a.agent, a.id).map((b) => `${b.name} (${a.agent}/${a.id})`),
      )
    : ['(the box registry cannot be read)'];
  let purge = opts.purgeAccounts === true;
  if (purge && inUse.length > 0) {
    log.error(
      `not unregistering: its accounts are still used by ${inUse.join(', ')}; destroy those boxes first, or pass --keep-accounts`,
    );
    process.exitCode = 1;
    return;
  }
  if (stored.length > 0 && inUse.length === 0 && !purge && !opts.keepAccounts) {
    if (process.stdin.isTTY) {
      const ok = await confirm({
        message: `Also delete its ${String(stored.length)} named account(s) (${stored.map((a) => `${a.agent}/${a.id}`).join(', ')}) and their secrets?`,
        initialValue: false,
      });
      purge = ok === true;
    }
  }
  if (!(await removeAgentPluginRecord(packageName))) {
    process.stderr.write(`no registered agent package named "${packageName}"\n`);
    process.exitCode = 1;
    return;
  }
  log.success(`unregistered ${packageName}`);
  if (stored.length === 0) return;
  if (!purge) {
    log.info(
      `kept ${String(stored.length)} named account(s) of its agents in ~/.agentbox/accounts.json (hidden until the package is added again); delete them with \`agentbox agent rm ${packageName} --purge-accounts\` before unregistering next time`,
    );
    return;
  }
  const removed = await purgeAgentAccounts(specs.map((s) => s.id));
  log.success(`deleted ${String(removed.length)} named account(s) and their secrets`);
  for (const a of removed) {
    const spec = specs.find((s) => s.id === a.agent);
    if (!spec?.dockerVolume) continue;
    const volume = accountConfigVolume(spec.dockerVolume, a.id);
    const r = await execa('docker', ['volume', 'rm', volume], { reject: false });
    const err = String(r.stderr ?? '').trim();
    if (r.exitCode !== 0 && !/no such volume/i.test(err)) {
      log.warn(`could not remove ${volume}: ${err || `exit ${String(r.exitCode)}`}`);
    }
  }
}

export const agentPluginCommands = (): Command[] => {
  const add = new Command('add')
    .argument('<package>', 'installed package name or a path to its directory')
    .option('-y, --yes', 'skip the trust confirmation prompt')
    .description('register an installed agent package so `agentbox <agent>` can use it')
    .action(async (packageArg: string, opts: { yes?: boolean }) => {
      let pkg: ReturnType<typeof resolvePackage>;
      try {
        pkg = resolvePackage(packageArg);
      } catch (err) {
        // A bad package name / unreadable dir is the user's problem to fix, not
        // a crash to read a stack trace out of.
        log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      // Registering runs the package's module in this process. That is a real
      // trust decision, so it is confirmed the way `plugin add` confirms it.
      if (!opts.yes && process.stdin.isTTY) {
        const ok = await confirm({
          message: `Register ${pkg.packageName}@${pkg.version}? Its code will be loaded by agentbox.`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }
      let validated: { specs: Record<string, AgentSyncSpec>; apiVersion: number };
      try {
        validated = await loadAndValidate(pkg.entryPath, pkg.packageName, pkg.agentboxApiVersion);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const { specs, apiVersion } = validated;
      await addAgentPluginRecord({
        packageName: pkg.packageName,
        resolvedEntry: pkg.entryPath,
        version: pkg.version,
        specs,
        apiVersion,
        addedAt: new Date().toISOString(),
      });
      log.success(
        `registered ${Object.keys(specs).join(', ')} from ${pkg.packageName}@${pkg.version}`,
      );
    });

  const list = new Command('list')
    .description('list agents this build knows about, built-in and installed')
    .action(() => {
      for (const id of builtinAgentIds()) process.stdout.write(`${id.padEnd(20)} built-in\n`);
      for (const r of readAgentRegistrySync().agents) {
        for (const id of Object.keys(r.specs ?? {})) {
          process.stdout.write(
            `${id.padEnd(20)} ${r.packageName}@${r.version} (agent API v${String(r.apiVersion)})\n`,
          );
        }
      }
    });

  const remove = new Command('remove')
    .alias('rm')
    .argument('<package>', 'package name to unregister')
    .option(
      '--purge-accounts',
      "also delete the package's agents' named accounts: their rows, secrets and docker volumes",
    )
    .option('--keep-accounts', "keep the package's agents' named accounts (for a re-add)")
    .description('unregister an agent package (does not uninstall it)')
    .action(removeAgentPackage);

  return [add, list, remove];
};
