import { readSecretsEnv } from './home.js';
import { hubJson } from './hub.js';
import { run } from './exec.js';
import { LINUX_VM_ALIAS, type Target } from './targets.js';

export interface Leak {
  kind: 'container' | 'volume' | 'sandbox';
  id: string;
  name: string;
}

interface PruneView {
  orphans?: Array<{ sandboxId: string; name?: string; state?: string }>;
}

function prefixFor(runId: string, t: Target): string {
  return `e2e-${runId}-${t.slug}-`;
}

async function dockerLeaks(prefix: string, log: string, ssh?: string): Promise<Leak[]> {
  const docker = (args: string[]) =>
    ssh
      ? run('ssh', [ssh, 'docker', ...args], { log, allowFail: true })
      : run('docker', args, { log, allowFail: true });
  const leaks: Leak[] = [];
  const ps = await docker(['ps', '-a', '--format', '{{.ID}} {{.Names}}']);
  for (const line of ps.stdout.split('\n')) {
    const [id, name] = line.trim().split(/\s+/);
    if (id && name?.includes(prefix)) leaks.push({ kind: 'container', id, name });
  }
  const vols = await docker(['volume', 'ls', '--format', '{{.Name}}']);
  for (const name of vols.stdout.split('\n').map((s) => s.trim())) {
    if (name.includes(prefix)) leaks.push({ kind: 'volume', id: name, name });
  }
  return leaks;
}

/**
 * Everything of this run still alive on a target. Cloud targets ask the e2e hub for
 * sandboxes it doesn't track (`dryRun: true` is load-bearing: without it the hub
 * DELETES every untracked sandbox on the account, including the user's real ones).
 */
export async function findLeaks(t: Target, runId: string, log: string): Promise<Leak[]> {
  const prefix = prefixFor(runId, t);
  if (t.kind === 'docker') return dockerLeaks(prefix, log);
  if (t.kind === 'remote-docker') return dockerLeaks(prefix, log, LINUX_VM_ALIAS);
  const view = await hubJson<PruneView>('/api/v1/prune', {
    body: { provider: t.provider, dryRun: true },
  });
  return (view.orphans ?? [])
    .filter((o) => (o.name ?? '').includes(prefix))
    .map((o) => ({ kind: 'sandbox' as const, id: o.sandboxId, name: o.name ?? o.sandboxId }));
}

/** Best-effort removal of leaked resources; returns what could not be removed. */
export async function removeLeaks(t: Target, leaks: Leak[], log: string): Promise<Leak[]> {
  const left: Leak[] = [];
  const secrets = readSecretsEnv();
  for (const l of leaks) {
    let ok = false;
    try {
      if (l.kind !== 'sandbox') {
        const args = l.kind === 'container' ? ['rm', '-f', l.id] : ['volume', 'rm', '-f', l.id];
        const r =
          t.kind === 'remote-docker'
            ? await run('ssh', [LINUX_VM_ALIAS, 'docker', ...args], { log, allowFail: true })
            : await run('docker', args, { log, allowFail: true });
        ok = r.exitCode === 0;
      } else if (t.provider === 'e2b') {
        const { Sandbox } = await import('e2b');
        ok = await Sandbox.kill(l.id, { apiKey: secrets.get('E2B_API_KEY') });
      } else if (t.provider === 'daytona') {
        const { Daytona } = await import('@daytona/sdk');
        const d = new Daytona({
          apiKey: secrets.get('DAYTONA_API_KEY'),
          ...(secrets.get('DAYTONA_API_URL') ? { apiUrl: secrets.get('DAYTONA_API_URL') } : {}),
        });
        await d.delete(await d.get(l.id));
        ok = true;
      } else if (t.provider === 'hetzner') {
        const res = await fetch(`https://api.hetzner.cloud/v1/servers/${l.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${secrets.get('HCLOUD_TOKEN') ?? ''}` },
        });
        ok = res.ok;
      }
    } catch {
      ok = false;
    }
    if (!ok) left.push(l);
  }
  return left;
}

/** Hetzner firewalls outlive a failed create; list the ones this run labelled. */
export async function hetznerFirewallLeaks(
  runId: string,
): Promise<Array<{ id: number; name: string }>> {
  const token = readSecretsEnv().get('HCLOUD_TOKEN');
  if (!token) return [];
  const res = await fetch('https://api.hetzner.cloud/v1/firewalls?per_page=50', {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    firewalls?: Array<{ id: number; name: string; labels: Record<string, string> }>;
  };
  return (body.firewalls ?? [])
    .filter((f) => (f.labels['agentbox.box'] ?? f.name).includes(`e2e-${runId}-`))
    .map((f) => ({ id: f.id, name: f.name }));
}
