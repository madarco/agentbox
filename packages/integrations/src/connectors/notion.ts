import type { IntegrationConnector, IntegrationOpRefusal } from '../types.js';

/**
 * Notion connector — wraps the official `ntn` CLI (beta, first-party).
 *
 * The op allowlist is intentionally minimal (start conservative, widen as
 * real agent flows surface needs). Two read passthroughs (`ntn whoami` and
 * `ntn api …` against the v1 REST surface) plus two gated writes. The `api`
 * passthrough is read-only — `refuseUnsafeApiCall` allows GET to any endpoint
 * and POST only to Notion's read-by-POST endpoints (`v1/search`, database /
 * data-source `/query`), and refuses everything else, so an agent can't slip a
 * write past the "read" classification.
 *
 * Comment creation is intentionally absent: `ntn` exposes no top-level
 * `comment` subcommand (the official surface is `api datasources files
 * pages login logout whoami workers`), and Notion's REST POST `/v1/comments`
 * takes a structured JSON body that doesn't trivially map from CLI flags.
 * Adding it is tracked as a focused follow-up — see `docs/notion_backlog.md`.
 *
 * No `env` override: the relay runs the host's `ntn` with its own default
 * auth (the macOS keychain after `ntn login`), matching what `agentbox
 * doctor` probes and what the public docs tell users to do. The carry-based
 * nested-box dev path (a Linux box hosting a relay) needs file-based auth
 * instead; that's an internal-dev concern documented in
 * `docs/development.md`, not something the connector forces on every host.
 */
export const notionConnector: IntegrationConnector = {
  service: 'notion',
  hostBin: 'ntn',
  detect: {
    versionArgs: ['--version'],
    authArgs: ['api', 'v1/users/me'],
    installHint: 'install ntn: https://developers.notion.com/reference/notion-cli',
    loginHint: 'ntn login',
  },
  ops: {
    whoami: {
      write: false,
      buildArgv: (args) => ['whoami', ...args],
    },
    api: {
      write: false,
      buildArgv: (args) => ['api', ...args],
      refuseCall: refuseUnsafeApiCall,
    },
    'page.create': {
      write: true,
      buildArgv: (args) => ['pages', 'create', ...args],
    },
    'page.update': {
      write: true,
      buildArgv: (args) => ['pages', 'update', ...args],
    },
  },
};

/**
 * Notion's read-by-POST endpoints — the only POSTs `ntn api` may proxy.
 * Anchored, leading-slash-tolerant, and `[^/?]+` for the id segment so a
 * query string or extra path component can't smuggle a different endpoint.
 */
const READ_POST_ENDPOINTS: readonly RegExp[] = [
  /^\/?v1\/search$/,
  /^\/?v1\/databases\/[^/?]+\/query$/,
  /^\/?v1\/data_sources\/[^/?]+\/query$/,
];

/**
 * The only flags `ntn api` accepts that take NO value and are safe for a
 * read-only proxy. The gate is fail-closed: every other flag is refused, so an
 * unrecognized value-consuming flag can't have its value misparsed as the
 * endpoint (see `refuseUnsafeApiCall`). Value-consuming flags (`-X/--method`,
 * `-d/--data`, `--notion-version`, `--file`) are handled explicitly before this.
 */
const SAFE_API_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--spec',
  '--docs',
  '-h',
  '--help',
  '-v',
  '--verbose',
  '-V',
  '--version',
]);

/**
 * Reject any `ntn api` call that isn't a read. A read is: GET to any endpoint,
 * or POST to one of {@link READ_POST_ENDPOINTS} (search + database/data-source
 * `/query` — POST in the Notion API but semantically reads). Everything else —
 * writes (`v1/pages`, `v1/comments`, …), PATCH/PUT/DELETE, POST to a
 * non-read endpoint — is refused; writes go through `page.create`/`page.update`.
 *
 * `ntn api`'s real surface (verified via `ntn api --help`): method is inferred
 * from endpoint + body; `-X`/`--method` overrides; body sources are `-d`/`--data
 * <JSON>` and inline assignments (`path=value`, `path:=json`) — NOT `gh`-style
 * `-f`/`-F` (which `ntn` doesn't have). We classify any body source as non-GET
 * so a write can't slip through as a body-less "GET". `--input` (stdin/file
 * body) and `--file` (host-file upload) read host state and can't traverse the
 * relay, so both are refused outright.
 *
 * Kept here (next to the op declaration) — not exported — because the test
 * surface is "does notion.api refuse this call", not the parser shape.
 */
function refuseUnsafeApiCall(args: readonly string[]): IntegrationOpRefusal | null {
  const refuse = (reason: string): IntegrationOpRefusal => ({
    exitCode: 65,
    stderr: `notion api: ${reason}\n`,
  });

  let explicitMethod: string | null = null;
  let hasBody = false;
  let endpoint: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';

    // Explicit method (split, glued, or `=`-joined).
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

    // Raw JSON body — implies a write-class request unless the endpoint is read.
    if (arg === '-d' || arg === '--data') {
      hasBody = true;
      i++;
      continue;
    }
    if (arg.startsWith('--data=') || (arg.startsWith('-d') && arg.length > 2)) {
      hasBody = true;
      continue;
    }

    // Host-file / stdin bodies: can't traverse the relay, and `--file` reads an
    // arbitrary host file. Refuse both regardless of endpoint.
    if (arg === '--file' || arg.startsWith('--file=')) {
      return refuse("'--file' (host-file upload) isn't supported through the relay");
    }
    if (arg === '--input' || arg.startsWith('--input=')) {
      return refuse("'--input' (stdin/file body) isn't supported through the relay; use -d <JSON>");
    }

    // `--notion-version <VERSION>` — value-consuming; forwarded unchanged.
    if (arg === '--notion-version') {
      i++;
      continue;
    }
    if (arg.startsWith('--notion-version=')) continue;

    // Remaining flags are fail-closed: only a known-safe boolean set passes.
    // Anything else is refused rather than ignored, so an unrecognized
    // value-consuming flag — e.g. ntn's global `--workers-config-file <path>`
    // or the hidden `--env <env>`, both accepted after `api` — can't have its
    // value silently misread as the endpoint and smuggle a write past the gate
    // (`api --workers-config-file v1/search v1/pages` POSTs to v1/pages).
    if (arg.startsWith('-')) {
      if (SAFE_API_BOOLEAN_FLAGS.has(arg)) continue;
      return refuse(
        `unsupported option '${arg}' (read-only api accepts a path, inline inputs, ` +
          `-d <JSON>, -X GET/POST, --notion-version, --spec, --docs)`,
      );
    }

    // First bare positional is the API path; the rest are inline inputs.
    if (endpoint === null) {
      endpoint = arg;
      continue;
    }
    if (isBodyAssignment(arg)) hasBody = true;
  }

  const method = (
    explicitMethod && explicitMethod.length > 0 ? explicitMethod : hasBody ? 'POST' : 'GET'
  ).toUpperCase();

  if (method === 'GET') return null;
  if (method !== 'POST') {
    return refuse(
      `only GET and read-only POST are proxied (use page.create / page.update for writes); detected method '${method}'`,
    );
  }
  if (endpoint === null) {
    return refuse('could not determine the API endpoint for a non-GET call');
  }
  // Defense in depth: ntn resolves `.`/`..` before routing, so reject any
  // traversal segment rather than trusting the anchored regexes alone.
  if (endpoint.split('/').some((seg) => seg === '.' || seg === '..')) {
    return refuse(`path traversal segments ('.' / '..') are not allowed in '${endpoint}'`);
  }
  if (READ_POST_ENDPOINTS.some((re) => re.test(endpoint!))) return null;
  return refuse(
    `POST is only proxied for read endpoints (v1/search, v1/databases/{id}/query, ` +
      `v1/data_sources/{id}/query); '${endpoint}' is not one (use page.create / page.update for writes)`,
  );
}

/**
 * Whether an inline-input token is a request-BODY assignment (so it implies a
 * write-class request). `ntn` inline syntax: `path:=json` (typed body) and
 * `path=value` (string body) are bodies; `name==value` (query param) and
 * `Header:Value` (header) are not.
 */
function isBodyAssignment(token: string): boolean {
  if (token.includes(':=')) return true;
  if (token.includes('==')) return false;
  return token.includes('=');
}
