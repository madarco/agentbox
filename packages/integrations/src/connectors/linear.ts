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
    'issue.mine': {
      // The v2-native read for "issues assigned to me" — the README directs
      // users here in place of the older `issue list --me`. Listed as a
      // separate op so the shim doesn't reject the canonical form.
      write: false,
      buildArgv: (args) => ['issue', 'mine', ...args],
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
      // Maps to `linear issue comment add` — `@schpet/linear-cli` v2 uses
      // `add` (not `create`); `add`'s sibling subcommands are `list`,
      // `update`, `delete`.
      write: true,
      buildArgv: (args) => ['issue', 'comment', 'add', ...args],
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
 * argument and accepts `--variable key=value` (repeatable; the value may
 * be `@/path` to load from a host file — see below), `--variables-json
 * <json>`, `--paginate`, and `--silent`. We:
 *
 *   1. Refuse `--variable key=@<path>` (and the `=` and `--variable=`
 *      glued forms) because they would let the box trigger arbitrary
 *      host-file reads — the file contents become GraphQL variables and
 *      can be echoed back through the response, an exfiltration channel.
 *   2. Refuse `--input` for parity with `refuseApiNonGet`, even though
 *      `linear api` doesn't currently accept it — if a future version
 *      adds it, the guard pre-empts the stdin/file-body shape.
 *   3. Walk argv consuming value-bearing flags (`--variable`,
 *      `--variables-json`) so their JSON/key=value payload isn't
 *      misread as an operation keyword.
 *   4. For every remaining positional (non-flag) token, strip leading
 *      whitespace + `# …` line comments and reject the call if the
 *      first identifier is `mutation` or `subscription`.
 *
 * `query …` and the anonymous `{ … }` shorthand pass. Empty/flag-only
 * argv passes (the host CLI emits its own usage error).
 */
function refuseGraphqlNonQuery(args: readonly string[]): IntegrationOpRefusal | null {
  const refuse = (reason: string): IntegrationOpRefusal => ({
    exitCode: 65,
    stderr: `linear api: ${reason}\n`,
  });
  // `--variable` and `--variables-json` each take the next argv token as
  // their value — the loop consumes them explicitly below so a JSON
  // payload starting with `mutation`/`subscription` isn't misread as the
  // GraphQL operation.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--input' || arg.startsWith('--input=')) {
      return refuse("'--input' (stdin/file body) isn't supported through the relay");
    }
    // `--variable key=@/host/path` reads from a host file — refuse the
    // `@`-prefixed value form regardless of split/glued/equals shape.
    if (arg === '--variable') {
      const next = args[i + 1] ?? '';
      if (variableValueIsFileLoad(next)) {
        return refuse(
          "'--variable key=@<path>' (host-file load) isn't supported through the relay",
        );
      }
      i++; // consume the value
      continue;
    }
    if (arg.startsWith('--variable=')) {
      if (variableValueIsFileLoad(arg.slice('--variable='.length))) {
        return refuse(
          "'--variable=key=@<path>' (host-file load) isn't supported through the relay",
        );
      }
      continue;
    }
    if (arg === '--variables-json') {
      i++; // consume the JSON value; don't treat it as a positional
      continue;
    }
    if (arg.startsWith('--variables-json=')) {
      continue;
    }
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
 * True when a `--variable` value uses linear-cli's `@<path>` host-file load
 * syntax. The value shape is `key=@<path>`; bare `@<path>` (no `key=`) is
 * also refused defensively in case a future linear-cli release widens the
 * syntax.
 */
function variableValueIsFileLoad(value: string): boolean {
  const eq = value.indexOf('=');
  if (eq === -1) return value.startsWith('@');
  return value.slice(eq + 1).startsWith('@');
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
