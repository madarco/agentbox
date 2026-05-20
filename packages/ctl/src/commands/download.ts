import { Command } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';

interface DownloadRpcParams {
  kind: 'workspace' | 'env' | 'config' | 'claude';
  hostPath?: string;
}

const KINDS = ['workspace', 'env', 'config', 'claude'] as const;
type Kind = (typeof KINDS)[number];

function isKind(v: string): v is Kind {
  return (KINDS as readonly string[]).includes(v);
}

/**
 * `agentbox-ctl download [kind]` — ask the host (via relay) to pull box
 * contents to the host. Kinds map to the host CLI subcommands:
 *   workspace  -> `agentbox download <box>`              (default)
 *   env        -> `agentbox download env <box>`
 *   config     -> `agentbox download config <box>`
 *   claude     -> `agentbox download claude <box>`
 *
 * The user is prompted on the host wrapper to confirm; denials come back
 * as exit 10 with `denied by user` on stderr. `hostPath` is reserved in
 * the wire shape but ignored by the v1 relay — the host CLI uses its
 * own defaults (the box's workspacePath, or `~/.claude`).
 */
export const downloadCommand = new Command('download')
  .description(
    "Download box contents to the host (gated by user prompt). Kinds: workspace (default), env, config, claude",
  )
  .argument('[kind]', `one of: ${KINDS.join(', ')}`, 'workspace')
  .action(async (kindArg: string) => {
    if (!isKind(kindArg)) {
      process.stderr.write(
        `agentbox-ctl download: unknown kind "${kindArg}"; expected one of: ${KINDS.join(', ')}\n`,
      );
      process.exit(64);
    }
    const params: DownloadRpcParams = { kind: kindArg };
    const code = await postRpcAndExit(`download.${kindArg}`, params, {
      errorPrefix: 'agentbox-ctl download',
    });
    process.exit(code);
  });
