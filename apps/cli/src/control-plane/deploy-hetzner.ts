import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deployControlPlaneToHetzner, readHetznerCredStatus } from '@agentbox/sandbox-hetzner';

/**
 * CLI wrapper for the Hetzner control-plane deploy: precheck the token, run the
 * provisioning in `@agentbox/sandbox-hetzner`, and persist the deploy record so
 * a later command (or the user) can find / tear down the VPS.
 */
export interface HetznerDeployOptions {
  /** Path to the setup-written control-plane.env (scp'd to the VPS as `.env`). */
  envPath: string;
  /** Branch / tag / sha of the agentbox repo to deploy (default `main`). */
  repoRef?: string;
  /** Git repo the VPS clones (default the public agentbox repo). */
  repoUrl?: string;
  log: (line: string) => void;
}

export async function runHetznerDeploy(opts: HetznerDeployOptions): Promise<{ url: string }> {
  if (readHetznerCredStatus().source === 'none') {
    throw new Error('no HCLOUD_TOKEN configured — run `agentbox hetzner login` first');
  }
  const envContent = await readFile(opts.envPath, 'utf8');
  const result = await deployControlPlaneToHetzner({
    envContent,
    repoRef: opts.repoRef,
    repoUrl: opts.repoUrl,
    onLog: opts.log,
  });
  const deployPath = join(homedir(), '.agentbox', 'control-plane', 'deploy.json');
  await writeFile(
    deployPath,
    JSON.stringify({ provider: 'hetzner', ...result }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return { url: result.url };
}
