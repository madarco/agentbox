import { Command } from 'commander';
import { ALL_CONNECTORS, type IntegrationConnector } from '@agentbox/integrations';
import { postRpcAndExit } from '../relay-rpc.js';

interface IntegrationRpcParams {
  path: string;
  args?: string[];
}

/**
 * In-box surface for the integrations foundation: one commander subtree
 * per connector descriptor in `@agentbox/integrations`. Each op's action
 * forwards verbatim argv to the relay (`integration.<service>.<op>`),
 * where the host-side dispatcher classifies read/write and gates writes
 * via askPrompt before shelling out to the connector's host CLI.
 *
 * Mirrors `commands/gh.ts` exactly — descriptor-driven so a new
 * connector is one file in `@agentbox/integrations` and no surgery here.
 */
export const integrationCommand = new Command('integration').description(
  'Ticketing/knowledge CLIs routed through the host relay (host runs the real CLI with host creds; box never sees a token)',
);

for (const connector of ALL_CONNECTORS) {
  integrationCommand.addCommand(buildConnectorCommand(connector));
}

function buildConnectorCommand(connector: IntegrationConnector): Command {
  const cmd = new Command(connector.service).description(
    `${connector.service} CLI operations via the host \`${connector.hostBin}\` (requires \`${connector.hostBin}\` installed and authenticated on the host)`,
  );
  for (const [opName, op] of Object.entries(connector.ops)) {
    const description = op.write
      ? `Run \`${connector.hostBin} ${opName}\` on the host (prompted; write op).`
      : `Run \`${connector.hostBin} ${opName}\` on the host (read-only; no prompt).`;
    const errorPrefix = `agentbox-ctl integration ${connector.service} ${opName}`;
    const method = `integration.${connector.service}.${opName}`;
    cmd.addCommand(
      new Command(opName)
        .description(description)
        .option(
          '--cwd <path>',
          'container path identifying which registered worktree to use (default: cwd)',
        )
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .argument(
          '[args...]',
          `extra args forwarded to \`${connector.hostBin} ${opName}\` verbatim`,
        )
        .action(async (args: string[], opts: { cwd?: string }) => {
          const params: IntegrationRpcParams = { path: opts.cwd ?? process.cwd() };
          if (args.length > 0) params.args = args;
          const code = await postRpcAndExit(method, params, { errorPrefix });
          process.exit(code);
        }),
    );
  }
  return cmd;
}
