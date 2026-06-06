import type { IntegrationConnector, IntegrationOpRefusal } from '../types.js';

/**
 * Notion connector — wraps the official `ntn` CLI (beta, first-party).
 *
 * The op allowlist is intentionally minimal (start conservative, widen as
 * real agent flows surface needs). Two read passthroughs (`ntn whoami` and
 * `ntn api …` for GETs against the v1 REST surface) plus two gated writes.
 * The `api` passthrough is GET-only — `refuseApiNonGet` parses
 * `-X`/`--method`/`-f`/`-F` (and their glued forms) the same way
 * `refuseGhApiCall` does, so an agent can't slip a POST/PATCH/DELETE past
 * the "read" classification.
 *
 * Comment creation is intentionally absent: `ntn` exposes no top-level
 * `comment` subcommand (the official surface is `api datasources files
 * pages login logout whoami workers`), and Notion's REST POST `/v1/comments`
 * takes a structured JSON body that doesn't trivially map from CLI flags.
 * Adding it is tracked as a focused follow-up — see `docs/notion_backlog.md`.
 *
 * `NOTION_KEYRING=0` is forced in the env so `ntn` reads file-based auth
 * (`~/.config/notion/auth.json`). On the macOS host this var is harmless
 * — keychain mode is unaffected by the value, only its presence. On
 * Linux (in-box) the carried auth file IS the credential, and the var
 * is required for `ntn` to find it. See `agentbox.yaml` carry block.
 */
export const notionConnector: IntegrationConnector = {
  service: 'notion',
  hostBin: 'ntn',
  detect: {
    versionArgs: ['--version'],
    authArgs: ['api', 'v1/users/me'],
  },
  env: { NOTION_KEYRING: '0' },
  ops: {
    whoami: {
      write: false,
      buildArgv: (args) => ['whoami', ...args],
    },
    api: {
      write: false,
      buildArgv: (args) => ['api', ...args],
      refuseCall: refuseApiNonGet,
    },
    'page.create': {
      write: true,
      buildArgv: (args) => ['page', 'create', ...args],
    },
    'page.update': {
      write: true,
      buildArgv: (args) => ['page', 'update', ...args],
    },
  },
};

/**
 * Reject any `ntn api` call whose argv would issue a non-GET HTTP method.
 *
 * `ntn api`'s flag surface mirrors `gh api`'s (Go pflag-style): an
 * explicit method via `-X`/`--method` (with separate, glued, or `=`-joined
 * values), or any field flag (`-f`/`-F`/`--field`/`--raw-field`) which
 * implicitly switches the request to POST. We refuse all of those.
 * `--input` (stdin/file body) can't traverse the relay anyway.
 *
 * Kept here (next to the op declaration) — not exported — because the
 * test surface is "does notion.api refuse a DELETE", not the parser
 * shape. If a second connector needs the same check, lift it.
 */
function refuseApiNonGet(args: readonly string[]): IntegrationOpRefusal | null {
  const refuse = (reason: string): IntegrationOpRefusal => ({
    exitCode: 65,
    stderr: `notion api: ${reason}\n`,
  });
  let explicitMethod: string | null = null;
  let hasFieldFlag = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-X' || arg === '--method') {
      explicitMethod = args[i + 1] ?? '';
      i++;
      continue;
    }
    if (arg.startsWith('--method=')) {
      explicitMethod = arg.slice('--method='.length);
      continue;
    }
    if (arg.startsWith('-X') && arg.length > 2) {
      explicitMethod = arg.slice(2).replace(/^=/, '');
      continue;
    }
    if (arg === '--input' || arg.startsWith('--input=')) {
      return refuse("'--input' (stdin/file body) isn't supported through the relay");
    }
    // Field flags auto-POST in gh; ntn follows the same convention. Consume
    // the spaced value so a method-looking token bound to the field (e.g.
    // `-f -X=GET`) can't downgrade the detected method on the next loop.
    if (arg === '-f' || arg === '-F' || arg === '--field' || arg === '--raw-field') {
      hasFieldFlag = true;
      i++;
      continue;
    }
    if (
      arg.startsWith('-f') ||
      arg.startsWith('-F') ||
      arg.startsWith('--field=') ||
      arg.startsWith('--raw-field=')
    ) {
      hasFieldFlag = true;
    }
  }
  const method = (explicitMethod ?? (hasFieldFlag ? 'POST' : 'GET')).toUpperCase();
  if (method === 'GET') return null;
  return refuse(
    `only GET is proxied (use page.create / page.update for writes); detected method '${method}'`,
  );
}
