import type { IntegrationConnector, IntegrationOpRefusal } from '../types.js';

/**
 * Linear connector — wraps `@schpet/linear-cli` (the `linear` binary, v2).
 *
 * The op allowlist is intentionally minimal (start conservative, widen as
 * real agent flows surface needs). Reads cover identity/listing/lookup
 * (`whoami`, `issue list/view/query`, `team list`) plus a GraphQL
 * passthrough (`api`), and writes are limited to issue create/update and a
 * gated comment. The `api` passthrough is query-only —
 * `refuseGraphqlNonQuery` rejects any operation whose first non-whitespace
 * keyword is `mutation` or `subscription`, so the GraphQL endpoint can't
 * be used to slip a write past the read classification (the GraphQL
 * analogue of `notion.api`'s `refuseApiNonGet`).
 *
 * Three subcommands are deliberately absent from the allowlist for
 * security reasons:
 *   - `auth token` — PRINTS the raw API token to stdout; proxying it
 *     through the relay would expose the host credential to the box.
 *     The only `auth` op we expose is `auth whoami` (identity only), via
 *     the `whoami` op.
 *   - `auth login` / `auth logout` / `auth migrate` / `auth default` —
 *     the host owns auth; relaying these would mutate host state.
 *   - `issue delete` / `team delete` / `team create` — destructive and
 *     unnecessary for the documented agent flows. Add deliberately, as
 *     gated writes, only when a real flow needs them.
 *
 * No `env` override is needed. Linear stores plaintext credentials at
 * `~/.config/linear/credentials.toml` and keychain mode is opt-in, not
 * the default — so unlike `ntn` (which forces `NOTION_KEYRING=0`),
 * `linear` already reads file-based auth on every host without any
 * env shaping. The carry block in `agentbox.yaml` ships that file
 * into nested boxes that run their own relay.
 */
export const linearConnector: IntegrationConnector = {
  service: 'linear',
  hostBin: 'linear',
  detect: {
    versionArgs: ['--version'],
    authArgs: ['auth', 'whoami'],
    installHint: 'install @schpet/linear-cli: npm i -g @schpet/linear-cli',
    loginHint: 'linear auth login',
  },
  ops: {
    whoami: {
      write: false,
      buildArgv: (args) => ['auth', 'whoami', ...args],
    },
    'issue.list': {
      write: false,
      buildArgv: (args) => ['issue', 'list', ...args],
    },
    'issue.view': {
      write: false,
      buildArgv: (args) => ['issue', 'view', ...args],
    },
    'issue.query': {
      write: false,
      buildArgv: (args) => ['issue', 'query', ...args],
    },
    'team.list': {
      write: false,
      buildArgv: (args) => ['team', 'list', ...args],
    },
    api: {
      write: false,
      buildArgv: (args) => ['api', ...args],
      refuseCall: refuseGraphqlNonQuery,
    },
    'issue.create': {
      write: true,
      buildArgv: (args) => ['issue', 'create', ...args],
    },
    'issue.update': {
      write: true,
      buildArgv: (args) => ['issue', 'update', ...args],
    },
    'issue.comment': {
      write: true,
      buildArgv: (args) => ['issue', 'comment', 'create', ...args],
    },
  },
};

/**
 * Reject any `linear api` call whose GraphQL source declares a `mutation`
 * or `subscription` operation. The Linear `api` op is a single POST that
 * serves both reads and writes — without this guard, the "read"
 * classification would be a hole the agent could slip writes through.
 *
 * `linear-cli`'s `api` subcommand takes the GraphQL query as a positional
 * argument. We scan every positional (any non-flag arg), strip leading
 * whitespace and `# …` line comments, and if the first remaining keyword
 * resolves to `mutation` or `subscription` we refuse. `query …` and the
 * anonymous `{ … }` shorthand pass.
 *
 * `--input` (stdin/file body) can't traverse the relay anyway — we refuse
 * it with a clearer message, matching `refuseApiNonGet`.
 */
function refuseGraphqlNonQuery(args: readonly string[]): IntegrationOpRefusal | null {
  const refuse = (reason: string): IntegrationOpRefusal => ({
    exitCode: 65,
    stderr: `linear api: ${reason}\n`,
  });
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--input' || arg.startsWith('--input=')) {
      return refuse("'--input' (stdin/file body) isn't supported through the relay");
    }
  }
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const op = firstGraphqlOperationKeyword(arg);
    if (op === 'mutation' || op === 'subscription') {
      return refuse(
        `only GraphQL queries are proxied (use issue.create / issue.update / issue.comment for writes); detected operation '${op}'`,
      );
    }
  }
  return null;
}

/**
 * Extract the first GraphQL operation keyword from a source string after
 * stripping leading whitespace and `# …` line comments. Returns the
 * keyword (`query` | `mutation` | `subscription`) when one is found,
 * `'anonymous'` for the `{ … }` shorthand, or `null` for an empty/
 * unparseable source. Only the prefix matters — the rest of the source
 * is not validated; we're not a GraphQL parser, just a write-shape
 * detector.
 */
function firstGraphqlOperationKeyword(source: string): string | null {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    break;
  }
  if (i >= n) return null;
  if (source[i] === '{') return 'anonymous';
  let j = i;
  while (j < n) {
    const c = source[j]!;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      j++;
    } else {
      break;
    }
  }
  if (j === i) return null;
  return source.slice(i, j).toLowerCase();
}
