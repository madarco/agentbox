/**
 * Interactive host registration for the `agentbox install` wizard.
 *
 * remote-docker has no credential to log in with — what it needs instead is a
 * host: an alias name + an SSH connection string. This drives that prompt flow
 * (the interactive twin of `remote-docker add`), registers the alias, and pins it
 * as the default host so the wizard's subsequent bake step + plain `agentbox
 * claude` target it.
 *
 * Install-only on purpose: it must NOT hang off `providerModule.ensureCredentials`,
 * which `getProvider()` runs on every create AND every box lifecycle op — a prompt
 * there would fire constantly. The wizard calls this directly instead.
 */

import * as p from '@clack/prompts';
import { setConfigValue } from '@agentbox/config';
import { probeRemoteEngine } from './remote-docker.js';
import { assertValidAlias, getHostAlias, listHostAliases, upsertHostAlias } from './hosts-registry.js';

/**
 * Prompt for an alias + SSH connection, probe it, register it, and set it as the
 * default host (`box.remoteDockerHost`, global). Returns the alias, or `null` if
 * there's no TTY or the user backs out. Never throws.
 */
export async function interactiveRegisterHost(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    p.log.warn(
      'remote-docker needs a host — run `agentbox remote-docker add <alias> <[user@]host[:port]>` to register one',
    );
    return null;
  }

  const alias = await p.text({
    message: 'Name this remote host (a short alias)',
    placeholder: 'buildbox',
    validate: (value) => {
      const v = (value ?? '').trim();
      if (!v) return 'required';
      try {
        assertValidAlias(v);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (getHostAlias(v)) return `'${v}' is already registered`;
      return undefined;
    },
  });
  if (p.isCancel(alias)) return null;
  const name = alias.trim();

  // Prompt + probe in a loop so a bad connection can be corrected without
  // restarting the wizard.
  for (;;) {
    const ssh = await p.text({
      message: 'SSH connection (an ~/.ssh/config alias or [user@]host[:port])',
      placeholder: 'user@host',
      validate: (value) => ((value ?? '').trim() ? undefined : 'required'),
    });
    if (p.isCancel(ssh)) return null;
    const conn = ssh.trim();

    const s = p.spinner();
    s.start(`probing ${conn}`);
    const res = await probeRemoteEngine(conn);
    if (!res.ok) {
      s.stop(`${conn}: unusable`);
      p.log.error(res.error ?? 'remote engine unusable');
      const retry = await p.confirm({
        message: 'Try a different SSH connection?',
        initialValue: true,
      });
      if (p.isCancel(retry) || !retry) return null;
      continue;
    }
    s.stop(`${conn}: docker ${res.version} (${res.os}/${res.arch})`);

    upsertHostAlias(name, conn);
    p.log.success(`registered '${name}' → ${conn}`);
    // Machine-level default, matching how the wizard pins box.provider global.
    await setConfigValue('global', 'box.remoteDockerHost', name, process.cwd(), { raw: true });
    // With more than one host registered, remind how to target a specific one.
    const hostCount = listHostAliases().length;
    if (hostCount > 1) {
      p.log.info(
        `you have ${String(hostCount)} remote hosts — run \`agentbox docker:${name} claude\` to use this one`,
      );
    }
    return name;
  }
}
