import { Command } from 'commander';
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

    const shutdown = async (signal: string): Promise<void> => {
      process.stdout.write(`agentbox-ctl: ${signal} — shutting down\n`);
      reporter.stop();
      reporter.flush();
      server.close();
      await sup.stopAll();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  });
