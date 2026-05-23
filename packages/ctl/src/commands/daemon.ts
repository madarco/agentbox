import { Command } from 'commander';
import {
  DEFAULT_RELAY_PORT,
  startRelayServer,
  type RelayServerHandle,
} from '@agentbox/relay';
import { loadConfig } from '../config.js';
import { Supervisor } from '../supervisor.js';
import { startServer } from '../socket.js';
import { StatusReporter } from '../status-reporter.js';
import {
  DEFAULT_CLAUDE_SESSION_NAME,
  DEFAULT_CONFIG_PATH,
  DEFAULT_LOG_DIR,
  DEFAULT_SOCKET_PATH,
} from '../types.js';

interface DaemonOptions {
  socket: string;
  config: string;
  logDir: string;
  workspace: string;
}

export const daemonCommand = new Command('daemon')
  .description('Run the agentbox-ctl supervisor in the foreground')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--config <path>', 'path to agentbox.yaml', DEFAULT_CONFIG_PATH)
  .option('--log-dir <path>', 'where per-service log files are written', DEFAULT_LOG_DIR)
  .option('--workspace <path>', 'cwd for service processes', '/workspace')
  .action(async (opts: DaemonOptions) => {
    const cfg = await loadConfig(opts.config);
    const sup = new Supervisor({ workspace: opts.workspace, logDir: opts.logDir });
    await sup.init(cfg);
    const reporter = new StatusReporter({
      supervisor: sup,
      relay: sup.relayClient,
      boxId: process.env.AGENTBOX_BOX_ID ?? '',
      sessionName: DEFAULT_CLAUDE_SESSION_NAME,
    });
    reporter.start();
    const server = await startServer({
      socketPath: opts.socket,
      supervisor: sup,
      logDir: opts.logDir,
      configPath: opts.config,
      reporter,
    });

    process.stdout.write(`agentbox-ctl: listening on ${opts.socket}\n`);
    process.stdout.write(
      `agentbox-ctl: ${String(cfg.services.length)} service(s), ${String(cfg.tasks.length)} task(s) configured\n`,
    );

    // In a cloud sandbox the supervisor's relay client posts to
    // http://127.0.0.1:8787 — which means an in-sandbox relay must be
    // running on that port to receive events and serve the host poller. We
    // import startRelayServer in-process so a relay bind failure is
    // contained (the supervisor keeps running; status push is just a no-op).
    let inBoxRelay: RelayServerHandle | null = null;
    if (process.env.AGENTBOX_BOX_KIND === 'cloud') {
      const bridgeToken = process.env.AGENTBOX_BRIDGE_TOKEN ?? '';
      const boxId = process.env.AGENTBOX_BOX_ID ?? '';
      const boxName = process.env.AGENTBOX_BOX_NAME ?? boxId;
      const boxToken = process.env.AGENTBOX_RELAY_TOKEN ?? '';
      if (bridgeToken.length === 0 || boxId.length === 0 || boxToken.length === 0) {
        process.stderr.write(
          'agentbox-ctl: AGENTBOX_BOX_KIND=cloud but AGENTBOX_BRIDGE_TOKEN / AGENTBOX_BOX_ID / AGENTBOX_RELAY_TOKEN unset; skipping in-sandbox relay\n',
        );
      } else {
        try {
          // Bind 0.0.0.0 so the Daytona preview proxy can reach /bridge/*
          // from outside the sandbox; in-box clients still reach it on
          // 127.0.0.1 via AGENTBOX_RELAY_URL.
          inBoxRelay = await startRelayServer({
            port: DEFAULT_RELAY_PORT,
            host: '0.0.0.0',
            mode: 'box',
            bridgeToken,
            logger: (line) => process.stdout.write(`relay(box): ${line}\n`),
          });
          // Register this box in the in-sandbox relay's BoxRegistry so its
          // own /events and /rpc bearer checks find the token.
          inBoxRelay.registry.register({
            boxId,
            token: boxToken,
            name: boxName,
            kind: 'cloud',
            registeredAt: new Date().toISOString(),
          });
          process.stdout.write(
            `agentbox-ctl: in-sandbox relay (mode=box) listening on :${String(DEFAULT_RELAY_PORT)}\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`agentbox-ctl: in-sandbox relay failed to start: ${msg}\n`);
        }
      }
    }

    const shutdown = async (signal: string): Promise<void> => {
      process.stdout.write(`agentbox-ctl: ${signal} — shutting down\n`);
      reporter.stop();
      reporter.flush();
      server.close();
      await sup.stopAll();
      if (inBoxRelay) await inBoxRelay.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  });
