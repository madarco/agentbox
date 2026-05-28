import { describe, expect, it } from 'vitest';
import {
  SUGARED_COMMANDS,
  rewriteProviderPrefix,
} from '../src/provider/argv-prefix.js';

const NODE = '/usr/local/bin/node';
const BIN = '/path/to/agentbox';

function argv(...userArgs: string[]): string[] {
  return [NODE, BIN, ...userArgs];
}

describe('rewriteProviderPrefix', () => {
  it('rewrites the canonical case', () => {
    expect(rewriteProviderPrefix(argv('daytona', 'create', '-n', 'foo'))).toEqual(
      argv('create', '--provider', 'daytona', '-n', 'foo'),
    );
  });

  it('rewrites every (provider × sugared-command) pair', () => {
    for (const provider of ['docker', 'daytona', 'hetzner'] as const) {
      for (const sub of SUGARED_COMMANDS) {
        expect(rewriteProviderPrefix(argv(provider, sub))).toEqual(
          argv(sub, '--provider', provider),
        );
      }
    }
  });

  it('leaves existing provider-group subcommands alone', () => {
    // daytona credential management
    expect(rewriteProviderPrefix(argv('daytona', 'login'))).toEqual(argv('daytona', 'login'));
    expect(rewriteProviderPrefix(argv('daytona', 'login', '--status'))).toEqual(
      argv('daytona', 'login', '--status'),
    );
    expect(rewriteProviderPrefix(argv('daytona', 'resync'))).toEqual(argv('daytona', 'resync'));
    // hetzner firewall surface
    expect(rewriteProviderPrefix(argv('hetzner', 'login'))).toEqual(argv('hetzner', 'login'));
    expect(rewriteProviderPrefix(argv('hetzner', 'firewall', 'sync', 'box1'))).toEqual(
      argv('hetzner', 'firewall', 'sync', 'box1'),
    );
  });

  it('leaves top-level commands without a provider prefix alone', () => {
    expect(rewriteProviderPrefix(argv('create'))).toEqual(argv('create'));
    expect(rewriteProviderPrefix(argv('create', '--provider', 'daytona'))).toEqual(
      argv('create', '--provider', 'daytona'),
    );
    expect(rewriteProviderPrefix(argv('list'))).toEqual(argv('list'));
  });

  it('leaves unknown two-token combinations alone', () => {
    // `agentbox fly create` — fly isn't a known provider.
    expect(rewriteProviderPrefix(argv('fly', 'create'))).toEqual(argv('fly', 'create'));
    // `agentbox daytona stop` — stop isn't sugared.
    expect(rewriteProviderPrefix(argv('daytona', 'stop'))).toEqual(argv('daytona', 'stop'));
  });

  it('rewrites `vercel <sugared>` to `--provider vercel`', () => {
    expect(rewriteProviderPrefix(argv('vercel', 'create'))).toEqual(
      argv('create', '--provider', 'vercel'),
    );
    expect(rewriteProviderPrefix(argv('vercel', 'claude'))).toEqual(
      argv('claude', '--provider', 'vercel'),
    );
  });

  it('handles short argvs without crashing', () => {
    expect(rewriteProviderPrefix([NODE, BIN])).toEqual([NODE, BIN]);
    expect(rewriteProviderPrefix(argv('daytona'))).toEqual(argv('daytona'));
  });

  it('keeps explicit --provider as the last occurrence so commander resolves it', () => {
    // `agentbox daytona create --provider hetzner -n foo` →
    //  `agentbox create --provider daytona --provider hetzner -n foo`
    // Commander applies last-one-wins on repeated options, so the resolved
    // provider must be the explicit one (hetzner), not the prefix (daytona).
    const out = rewriteProviderPrefix(
      argv('daytona', 'create', '--provider', 'hetzner', '-n', 'foo'),
    );
    expect(out).toEqual(
      argv('create', '--provider', 'daytona', '--provider', 'hetzner', '-n', 'foo'),
    );
    const lastIdx = out.lastIndexOf('--provider');
    expect(out[lastIdx + 1]).toBe('hetzner');
  });

  it('preserves --help and other trailing tokens after rewrite', () => {
    expect(rewriteProviderPrefix(argv('hetzner', 'claude', '--help'))).toEqual(
      argv('claude', '--provider', 'hetzner', '--help'),
    );
    expect(rewriteProviderPrefix(argv('docker', 'codex', '--', '--model', 'sonnet'))).toEqual(
      argv('codex', '--provider', 'docker', '--', '--model', 'sonnet'),
    );
  });
});
