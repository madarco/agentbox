/**
 * `agentbox herdr <sub>` — internal entry points invoked by the Herdr plugin
 * (`agentbox install herdr`). Not part of the user-facing surface.
 *
 *   - `herdr new`  — open a new box session in a fresh Herdr tab (the
 *                    `prefix+shift+a` shortcut). Reuses the phase-1 Herdr spawn.
 *   - `herdr link` — handle a Ctrl+click on an `agentbox://…` link (the
 *                    `[[link_handlers]]` route). Opens the box's web app, or
 *                    notifies when the box exposes none.
 */

import { spawnSync } from 'node:child_process';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import { listBoxes } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { spawnInNewTerminal } from '../terminal/host.js';
import { herdrSend } from '../terminal/herdr-socket.js';

/** A parsed `agentbox://<verb>/<box>` link. `null` for anything that doesn't match. */
export interface HerdrLink {
  verb: string;
  box: string;
}

/** Parse an `agentbox://<verb>/<box>` URI. Pure — unit-tested. */
export function parseHerdrLink(uri: string | undefined): HerdrLink | null {
  if (!uri) return null;
  const m = uri.match(/^agentbox:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const verb = m[1];
  const rawBox = m[2];
  if (!verb || !rawBox) return null;
  try {
    return { verb, box: decodeURIComponent(rawBox) };
  } catch {
    return { verb, box: rawBox };
  }
}

/** Best-effort cwd for a new box: the Herdr pane/workspace dir, else process cwd. */
function herdrContextCwd(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['HERDR_PLUGIN_CONTEXT_JSON'];
  if (raw) {
    try {
      const ctx = JSON.parse(raw) as Record<string, Record<string, unknown> | undefined>;
      const cwd = ctx['pane']?.['cwd'] ?? ctx['workspace']?.['cwd'];
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch {
      // fall through
    }
  }
  return process.cwd();
}

const newCommand = new Command('new')
  .description('Open a new box session in a fresh Herdr tab (used by the plugin shortcut)')
  .option('--agent <agent>', 'agent to launch (claude|codex|opencode)', 'claude')
  .action(async (opts: { agent?: string }) => {
    const agent = opts.agent ?? 'claude';
    const cwd = herdrContextCwd();
    const r = await spawnInNewTerminal({
      host: 'herdr',
      mode: 'tab',
      argv: [process.execPath, process.argv[1] ?? 'agentbox', agent],
      cwd,
      title: `agentbox ${agent}`,
    });
    if (r.launched) process.stdout.write(r.note + '\n');
    else if (r.error) process.stderr.write(r.error + '\n');
  });

const linkCommand = new Command('link')
  .description('Handle a Ctrl+click on an agentbox:// link (used by the plugin link handler)')
  .argument('[uri]', 'the clicked URI; defaults to $HERDR_PLUGIN_CLICKED_URL')
  .action(async (uriArg: string | undefined) => {
    const link = parseHerdrLink(uriArg ?? process.env['HERDR_PLUGIN_CLICKED_URL']);
    if (!link) return;
    if (link.verb !== 'web') return;

    // The link carries the box's unique id (see list --herdr), so resolve by id.
    const boxes = await listBoxes();
    const box = boxes.find((b) => b.id === link.box);
    if (!box) {
      herdrSend('notification.show', {
        title: 'AgentBox',
        body: `box ${link.box} no longer exists`,
        sound: 'request',
      });
      return;
    }
    const webUrl = box.endpoints.endpoints.find((e) => e.kind === 'web' && e.url)?.url;
    if (webUrl) {
      spawnSync(hostOpenCommand(), [webUrl], { stdio: 'ignore' });
      return;
    }
    // No resolved web URL. A paused/stopped box can't serve one until it's up —
    // say so rather than implying it has no web app. (We don't auto-resume from a
    // click; `agentbox url <box>` does that explicitly.)
    if (box.state !== 'running') {
      herdrSend('notification.show', {
        title: box.name,
        body: `box is ${box.state} — start it, then click again`,
        sound: 'request',
      });
      return;
    }
    // Box is running but exposes no web app: notify and do nothing.
    herdrSend('notification.show', {
      title: box.name,
      body: 'no web app exposed (add a service `expose:` in agentbox.yaml)',
      sound: 'request',
    });
  });

export const herdrCommand = new Command('herdr')
  .description('Internal: Herdr plugin entry points (see `agentbox install herdr`)')
  .addCommand(newCommand)
  .addCommand(linkCommand);
