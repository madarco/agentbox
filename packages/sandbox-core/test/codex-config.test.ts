import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
  isHostOnlyPath,
  mergeCodexConfigForBox,
  sanitizeCodexConfigForBox,
  MINIMAL_TRUSTED_CODEX_CONFIG,
} from '../src/sync/codex-config.js';

const HOST_HOME = '/Users/marco';

// Mirrors the shape of a real macOS host ~/.codex/config.toml: a desktop
// Codex.app MCP server, a host-path notify helper, and a local-source
// marketplace with a dependent plugin — all unreachable inside a Linux box.
const HOST_CONFIG = `model = "gpt-5.5"
model_reasoning_effort = "high"

notify = ["/Users/marco/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/Client", "turn-ended"]

[features]
js_repl = false

[marketplaces.openai-bundled]
source_type = "local"
source = "/Users/marco/.codex/.tmp/bundled-marketplaces/openai-bundled"

[marketplaces.claude-plugins-official]
source_type = "git"
source = "https://github.com/anthropics/claude-plugins-official.git"

[plugins."browser@openai-bundled"]
enabled = true

[plugins."code-review@claude-plugins-official"]
enabled = false

[projects."/Users/marco/Projects/AgentBox/agentbox"]
trust_level = "trusted"

[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/node_repl"
args = []

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/marco/.codex"

[mcp_servers.ripgrep]
command = "rg-mcp"
args = ["--server"]
`;

describe('isHostOnlyPath', () => {
  it('flags absolute paths under host-only roots', () => {
    expect(isHostOnlyPath('/Users/marco/.codex/x', HOST_HOME)).toBe(true);
    expect(isHostOnlyPath('/Applications/Codex.app/Contents/Resources/node_repl', HOST_HOME)).toBe(
      true,
    );
    expect(isHostOnlyPath('/opt/homebrew/bin/foo', HOST_HOME)).toBe(true);
    expect(isHostOnlyPath('/Library/x', HOST_HOME)).toBe(true);
  });

  it('keeps PATH-resolved bare names and Linux-plausible absolutes', () => {
    expect(isHostOnlyPath('node', HOST_HOME)).toBe(false);
    expect(isHostOnlyPath('npx', HOST_HOME)).toBe(false);
    expect(isHostOnlyPath('/usr/bin/python3', HOST_HOME)).toBe(false);
    expect(isHostOnlyPath('/bin/sh', HOST_HOME)).toBe(false);
    expect(isHostOnlyPath('', HOST_HOME)).toBe(false);
    expect(isHostOnlyPath(undefined, HOST_HOME)).toBe(false);
  });
});

describe('sanitizeCodexConfigForBox', () => {
  it('strips host-only entries and preserves the rest', () => {
    const { text, changed } = sanitizeCodexConfigForBox(HOST_CONFIG, HOST_HOME);
    expect(changed).toBe(true);
    const cfg = parse(text) as Record<string, unknown>;
    const obj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

    // host-only mcp server gone; PATH-resolved one kept
    expect(obj(cfg['mcp_servers'])['node_repl']).toBeUndefined();
    expect(obj(cfg['mcp_servers'])['ripgrep']).toBeDefined();

    // host-path notify removed
    expect(cfg['notify']).toBeUndefined();

    // local-source marketplace + its plugin removed; git one + its plugin kept
    expect(obj(cfg['marketplaces'])['openai-bundled']).toBeUndefined();
    expect(obj(cfg['marketplaces'])['claude-plugins-official']).toBeDefined();
    expect(obj(cfg['plugins'])['browser@openai-bundled']).toBeUndefined();
    expect(obj(cfg['plugins'])['code-review@claude-plugins-official']).toBeDefined();

    // unrelated settings untouched
    expect(cfg['model']).toBe('gpt-5.5');
    expect(cfg['model_reasoning_effort']).toBe('high');
    expect(obj(cfg['features'])['js_repl']).toBe(false);
    expect(
      obj(obj(cfg['projects'])['/Users/marco/Projects/AgentBox/agentbox'])['trust_level'],
    ).toBe('trusted');
    // existing host-project trust preserved AND /workspace pre-trusted
    expect(obj(obj(cfg['projects'])['/workspace'])['trust_level']).toBe('trusted');
  });

  it('pre-trusts /workspace even when nothing host-only is present', () => {
    const clean = 'model = "gpt-5.5"\n\n[mcp_servers.ripgrep]\ncommand = "rg-mcp"\n';
    const { text, changed } = sanitizeCodexConfigForBox(clean, HOST_HOME);
    // changed because the workspace-trust entry was injected
    expect(changed).toBe(true);
    const cfg = parse(text) as Record<string, unknown>;
    const obj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
    expect(obj(obj(cfg['projects'])['/workspace'])['trust_level']).toBe('trusted');
    // unrelated settings preserved
    expect(cfg['model']).toBe('gpt-5.5');
    expect(obj(cfg['mcp_servers'])['ripgrep']).toBeDefined();
  });

  it('leaves changed=false when /workspace is already trusted and nothing host-only', () => {
    const trusted = '[projects."/workspace"]\ntrust_level = "trusted"\n';
    const { text, changed } = sanitizeCodexConfigForBox(trusted, HOST_HOME);
    expect(changed).toBe(false);
    expect(text).toBe(trusted);
  });

  it('throws on invalid TOML so callers can fall back to the raw copy', () => {
    expect(() => sanitizeCodexConfigForBox('this is = = not toml', HOST_HOME)).toThrow();
  });

  it('reports the marketplaces kept after the local-source drop', () => {
    expect(sanitizeCodexConfigForBox(HOST_CONFIG, HOST_HOME).keptMarketplaces).toEqual([
      'claude-plugins-official',
    ]);
    expect(sanitizeCodexConfigForBox('model = "gpt-5.5"\n', HOST_HOME).keptMarketplaces).toEqual(
      [],
    );
  });
});

describe('mergeCodexConfigForBox', () => {
  const obj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
  // A sanitized host base, as reconcileVolumeCodexConfig would produce it.
  const HOST_BASE = `model = "gpt-5.5"

[marketplaces.claude-plugins-official]
source_type = "git"
source = "https://github.com/anthropics/claude-plugins-official.git"

[plugins."code-review@claude-plugins-official"]
enabled = false

[projects."/workspace"]
trust_level = "trusted"
`;
  // What an in-box codex accumulates: a plugin install from the shared
  // marketplace, a self-added marketplace + plugin, an mcp server, a project
  // trust, an enable flip of a host-listed plugin, and a model pick that
  // conflicts with the host's.
  const BOX_CONFIG = `model = "gpt-5.5-codex"
approval_policy = "never"

[marketplaces.claude-plugins-official]
source_type = "git"
source = "https://example.com/stale-box-copy.git"

[marketplaces.my-market]
source_type = "git"
source = "https://example.com/my-market.git"

[plugins."code-review@claude-plugins-official"]
enabled = true

[plugins."context7@claude-plugins-official"]
enabled = true

[plugins."tool@my-market"]
enabled = true

[mcp_servers.echo]
command = "npx"
args = ["echo-mcp"]

[projects."/workspace"]
trust_level = "trusted"

[projects."/workspace/sub"]
trust_level = "trusted"
`;

  it('folds box-only entries into the host base; host wins on overlap', () => {
    const { text, marketplaces, mergedFromBox } = mergeCodexConfigForBox(HOST_BASE, BOX_CONFIG);
    expect(mergedFromBox).toBe(true);
    const cfg = parse(text) as Record<string, unknown>;

    // box-only marketplace / plugins / mcp server / project trust survive
    expect(obj(obj(cfg['marketplaces'])['my-market'])['source']).toBe(
      'https://example.com/my-market.git',
    );
    expect(obj(cfg['plugins'])['context7@claude-plugins-official']).toBeDefined();
    expect(obj(cfg['plugins'])['tool@my-market']).toBeDefined();
    expect(obj(obj(cfg['mcp_servers'])['echo'])['command']).toBe('npx');
    expect(obj(obj(cfg['projects'])['/workspace/sub'])['trust_level']).toBe('trusted');
    // box-only top-level key survives (e.g. approval_policy)
    expect(cfg['approval_policy']).toBe('never');

    // host wins on overlap: model, the shared marketplace's source, and the
    // in-box enable flip of a host-listed plugin all revert (host-authoritative
    // sync model — locked-in behavior)
    expect(cfg['model']).toBe('gpt-5.5');
    expect(obj(obj(cfg['marketplaces'])['claude-plugins-official'])['source']).toBe(
      'https://github.com/anthropics/claude-plugins-official.git',
    );
    expect(obj(obj(cfg['plugins'])['code-review@claude-plugins-official'])['enabled']).toBe(false);

    // keep-set is the merged union
    expect(marketplaces.sort()).toEqual(['claude-plugins-official', 'my-market']);
  });

  it('returns the host text verbatim for a null or unparseable box config', () => {
    for (const boxText of [null, 'not = = toml']) {
      const { text, marketplaces, mergedFromBox } = mergeCodexConfigForBox(HOST_BASE, boxText);
      expect(text).toBe(HOST_BASE);
      expect(mergedFromBox).toBe(false);
      expect(marketplaces).toEqual(['claude-plugins-official']);
    }
  });

  it('returns the host text verbatim when the box adds nothing new', () => {
    const { text, mergedFromBox } = mergeCodexConfigForBox(HOST_BASE, HOST_BASE);
    expect(text).toBe(HOST_BASE);
    expect(mergedFromBox).toBe(false);
  });

  it('merging into the minimal config keeps /workspace trust and box state', () => {
    const { text, marketplaces } = mergeCodexConfigForBox(
      MINIMAL_TRUSTED_CODEX_CONFIG,
      BOX_CONFIG,
    );
    const cfg = parse(text) as Record<string, unknown>;
    expect(obj(obj(cfg['projects'])['/workspace'])['trust_level']).toBe('trusted');
    // with no host config, the box's own model pick survives
    expect(cfg['model']).toBe('gpt-5.5-codex');
    expect(marketplaces.sort()).toEqual(['claude-plugins-official', 'my-market']);
  });

  it('throws on an unparseable host base (caller catch handles the fallback)', () => {
    expect(() => mergeCodexConfigForBox('not = = toml', BOX_CONFIG)).toThrow();
  });
});
