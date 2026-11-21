/**
 * Where OpenCode keeps model endpoints: `provider.<id>.options.baseURL` in the
 * global config, which OpenCode reads from any of these names in
 * `~/.config/opencode/` (#403). `rel` is the file's place in the docker volume,
 * whose `config/` dir is the relocated config dir.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const OPENCODE_ENDPOINT_PATHS = [['provider', '*', 'options', 'baseURL']] as const;

const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc', 'config.json'] as const;

export function opencodeEndpointFiles(hostHome: string = homedir()): {
  src: string;
  rel: string;
  paths: typeof OPENCODE_ENDPOINT_PATHS;
  source: string;
}[] {
  return CONFIG_NAMES.map((name) => ({
    src: join(hostHome, '.config', 'opencode', name),
    rel: `config/${name}`,
    paths: OPENCODE_ENDPOINT_PATHS,
    source: `~/.config/opencode/${name}`,
  }));
}
