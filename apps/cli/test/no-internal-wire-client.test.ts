import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: the CLI holds NO client call to the internal relay wire (`/admin/*` or
 * `/remote/*`). After the `/api/v1` consolidation those wires exist for box→hub
 * and hub-internal traffic ONLY — the CLI is a pure `/api/v1` client. A new
 * command that reaches for `/admin/...` (the old "second implementation" habit)
 * fails this test.
 *
 * A tiny hand-rolled allowlist covers the handful of paths that are genuinely
 * NOT the box/fleet client wire this step retired. Each is a specific (file →
 * path-prefix) pair with a reason, so a DIFFERENT `/admin/...` call — even inside
 * an allowlisted file — still fails. Keep this list short; adding to it is a
 * decision, not a formality.
 */
const ALLOWLIST: Record<string, { prefixes: string[]; reason: string }> = {
  // Step 10's credential-gated custody byte-read fallback. When a machine holds
  // the relay ADMIN token but no `/api/v1` API key (e.g. a via-hub-create host),
  // the fallback is the ONLY way it can pull per-box SSH keys — without it the
  // pull silently no-ops and `attach`/`cp` break later with a confusing missing-key
  // error. It cannot move to `/api/v1`: that surface is gated by the hub API key at
  // the proxy first, so a token-less machine can't reach it at all. Fail-closed +
  // loopback-peer-gated (see apps/hub/lib/custody-auth.ts, peer.ts).
  'control-plane/custody-client.ts': {
    prefixes: ['/admin/custody'],
    reason:
      'Step 10 custody admin-token fallback (see hub-api-single-path-plan.md Step 10/11 notes)',
  },
  // A local poke to THIS machine's relay scheduler so a queued background `-i` job
  // starts without waiting for the next periodic tick. Not a box/fleet hub op — the
  // agent launchers still run their own local file queue (their create-flow onto
  // `/api/v1` is the deferred launcher conversion; see Step 11 notes). The manifest
  // is on local disk regardless; the poke is best-effort.
  'lib/queue/submit.ts': {
    prefixes: ['/admin/queue/enqueue'],
    reason:
      "local relay scheduler poke for the launchers' background -i file queue (deferred launcher conversion)",
  },
  // GitHub-App install probe for a project's repo, part of the git-leasing setup
  // flow — not a box or fleet operation.
  'control-plane/ensure-repo-installed.ts': {
    prefixes: ['/admin/app/repo-installed'],
    reason: 'GitHub-App install check for git leasing setup (not a box/fleet op)',
  },
};

/** Strip comments while PRESERVING string/template contents, so a `/admin/` in a
 *  comment is ignored but one in a real path literal is caught. `://` in a URL
 *  string is safe (it lives inside a string, which the scanner keeps). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type Quote = "'" | '"' | '`';
  let quote: Quote | null = null;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        // keep the escaped char verbatim
        if (i + 1 < n) out += src[i + 1]!;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c as Quote;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const WIRE_RE = /\/(?:admin|remote)\/[A-Za-z0-9/_.:${}-]*/g;

describe('no internal-wire (/admin, /remote) client call in apps/cli', () => {
  it('finds no unallowlisted /admin/ or /remote/ path in CLI source', () => {
    const violations: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const rel = relative(SRC_DIR, file).split(sep).join('/');
      const code = stripComments(readFileSync(file, 'utf8'));
      const allow = ALLOWLIST[rel];
      for (const match of code.matchAll(WIRE_RE)) {
        const path = match[0];
        const ok = allow?.prefixes.some((p) => path.startsWith(p)) ?? false;
        if (!ok) violations.push(`${rel}: ${path}`);
      }
    }
    expect(
      violations,
      `The CLI must call the hub only through /api/v1, never the internal /admin//remote wire.\n` +
        `Unexpected internal-wire path(s):\n  ${violations.join('\n  ')}\n` +
        `If a new call is genuinely internal (not a box/fleet client op), add it to ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  it('has an allowlist that stays minimal and points at real files', () => {
    // A drifted allowlist (an entry whose file no longer exists) is itself a smell —
    // it would silently permit a future reintroduction in that path.
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(() => statSync(join(SRC_DIR, rel)), `allowlisted file missing: ${rel}`).not.toThrow();
    }
  });
});
