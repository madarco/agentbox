import { Command } from 'commander';
import {
  DEFAULT_BOX_RELAY_PORT,
  startRelayServer,
  type RelayServerHandle,
} from '@agentbox/relay';
import { loadConfig } from '../config.js';
import { startCodexScraper, type CodexScraperHandle } from '../codex-scraper.js';
import { startClaudeScraper, type ClaudeScraperHandle } from '../claude-scraper.js';
import { Supervisor } from '../supervisor.js';
import { startServer } from '../socket.js';
import { StatusReporter } from '../status-reporter.js';
import {
  startBoxRelayForwarder,
  type BoxRelayForwarderHandle,
} from '../box-relay-forwarder.js';
import {
  DEFAULT_CLAUDE_SESSION_NAME,
  DEFAULT_CONFIG_PATH,
  DEFAULT_LOG_DIR,
  DEFAULT_STATE_DIR,
  DEFAULT_SOCKET_PATH,
} from '../types.js';

function resolveBoxRelayPort(): number {
  const raw = process.env.AGENTBOX_BOX_RELAY_PORT;
  if (raw === undefined || raw.length === 0) return DEFAULT_BOX_RELAY_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    process.stderr.write(
      `agentbox-ctl: AGENTBOX_BOX_RELAY_PORT=${raw} is not a valid port; falling back to ${String(DEFAULT_BOX_RELAY_PORT)}\n`,
    );
    return DEFAULT_BOX_RELAY_PORT;
  }
  return n;
}

interface DaemonOptions {
  socket: string;
  config: string;
  logDir: string;
  stateDir: string;
  workspace: string;
}

export const daemonCommand = new Command('daemon')
  .description('Run the agentbox-ctl supervisor in the foreground')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--config <path>', 'path to agentbox.yaml', DEFAULT_CONFIG_PATH)
  .option('--log-dir <path>', 'where per-service log files are written', DEFAULT_LOG_DIR)
  .option('--state-dir <path>', 'where idempotent-task markers are written', DEFAULT_STATE_DIR)
  .option('--workspace <path>', 'cwd for service processes', '/workspace')
  .action(async (opts: DaemonOptions) => {
    const cfg = await loadConfig(opts.config);
    // Cloud backends that can't expose port 80 (Vercel) set AGENTBOX_WEB_PROXY_PORT
    // so the WebProxy binds a reachable non-privileged port. Unset → default 80.
    const webProxyPort = Number(process.env.AGENTBOX_WEB_PROXY_PORT) || undefined;
    const sup = new Supervisor({
      workspace: opts.workspace,
      logDir: opts.logDir,
      stateDir: opts.stateDir,
      webProxyPort,
    });
    await sup.init(cfg);
    const reporter = new StatusReporter({
      supervisor: sup,
      relay: sup.relayClient,
      boxId: process.env.AGENTBOX_BOX_ID ?? '',
      sessionName: DEFAULT_CLAUDE_SESSION_NAME,
    });
    reporter.start();

    // Codex's JSON-hook firing is unreliable in 0.134.0 (see
    // packages/sandbox-docker/scripts/agentbox-codex-hooks.json header). Run a
    // cheap tmux-pane scraper as the actual state-reporting mechanism. Cost
    // is one `tmux capture-pane -p` per second; no-ops when no codex session.
    let codexScraper: CodexScraperHandle | null = null;
    try {
      codexScraper = startCodexScraper({ reporter });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agentbox-ctl: codex scraper failed to start: ${msg}\n`);
    }

    // Promote-only safety net for Claude: if its hooks miss a prompt (MCP
    // dialogs, a dropped Notification hook), the tmux pane shows it — flip a
    // stuck `working`→`waiting` so `agent wait-for input-needed` still wakes.
    let claudeScraper: ClaudeScraperHandle | null = null;
    try {
      claudeScraper = startClaudeScraper({ reporter });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agentbox-ctl: claude scraper failed to start: ${msg}\n`);
    }

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

    // The in-box ctl client always posts to http://127.0.0.1:<boxRelayPort>
    // (default 8788) so the env contract is symmetric across providers.
    // - cloud sandboxes: embed a real `mode: 'box'` relay so the host's
    //   CloudBoxPoller can long-poll /bridge/* for queued host-only RPCs.
    // - docker sandboxes: bind a small forwarder that proxies to the host
    //   relay at host.docker.internal:8787. This frees :8787 inside the
    //   box for a nested agentbox CLI to claim (dog-fooding).
    // Bind failures are contained: the supervisor keeps running and the
    // in-box client surfaces a clear "no relay configured" error.
    const boxRelayPort = resolveBoxRelayPort();
    let inBoxRelay: RelayServerHandle | null = null;
    let inBoxForwarder: BoxRelayForwarderHandle | null = null;
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
            port: boxRelayPort,
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
            `agentbox-ctl: in-sandbox relay (mode=box) listening on :${String(boxRelayPort)}\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`agentbox-ctl: in-sandbox relay failed to start: ${msg}\n`);
        }
      }
    } else {
      const upstreamUrl =
        process.env.AGENTBOX_HOST_RELAY_URL ?? 'http://host.docker.internal:8787';
      try {
        inBoxForwarder = await startBoxRelayForwarder({
          port: boxRelayPort,
          upstream: new URL(upstreamUrl),
          logger: (line) => process.stdout.write(`relay(fwd): ${line}\n`),
        });
        process.stdout.write(
          `agentbox-ctl: in-box relay forwarder listening on :${String(boxRelayPort)} -> ${upstreamUrl}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agentbox-ctl: in-box relay forwarder failed to start: ${msg}\n`);
      }
    }

    const shutdown = async (signal: string): Promise<void> => {
      process.stdout.write(`agentbox-ctl: ${signal} — shutting down\n`);
      if (codexScraper) codexScraper.stop();
      if (claudeScraper) claudeScraper.stop();
      reporter.stop();
      reporter.flush();
      server.close();
      await sup.stopAll();
      if (inBoxRelay) await inBoxRelay.close();
      if (inBoxForwarder) await inBoxForwarder.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  });
