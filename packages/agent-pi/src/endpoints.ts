/**
 * Where Pi keeps model endpoints: `~/.pi/agent/models.json`, per provider
 * (`providers.<id>.baseUrl`) and per model (`providers.<id>.models[].baseUrl`)
 * (#403). `rel` is the file's place in the docker volume, which mirrors
 * `~/.pi/agent`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const PI_ENDPOINT_PATHS = [
  ['providers', '*', 'baseUrl'],
  ['providers', '*', 'models', '*', 'baseUrl'],
] as const;

export function piEndpointFiles(hostHome: string = homedir()): {
  src: string;
  rel: string;
  paths: typeof PI_ENDPOINT_PATHS;
  source: string;
}[] {
  return [
    {
      src: join(hostHome, '.pi', 'agent', 'models.json'),
      rel: 'models.json',
      paths: PI_ENDPOINT_PATHS,
      source: '~/.pi/agent/models.json',
    },
  ];
}
