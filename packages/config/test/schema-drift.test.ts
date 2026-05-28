import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseUserConfig } from '../src/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '..', 'schema', 'user-config.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

interface Fixture {
  name: string;
  yaml: string;
}

const VALID: Fixture[] = [
  { name: 'empty', yaml: '' },
  { name: 'box only', yaml: 'box:\n  hostSnapshot: true\n' },
  { name: 'box defaultCheckpoint', yaml: 'box:\n  defaultCheckpoint: warm-1\n' },
  { name: 'checkpoint maxLayers', yaml: 'checkpoint:\n  maxLayers: 3\n' },
  { name: 'engine override', yaml: 'engine:\n  kind: orbstack\n' },
  {
    name: 'kitchen sink',
    yaml: `
box:
  hostSnapshot: false
  defaultCheckpoint: warm-2
  withPlaywright: true
  withEnv: true
  vnc: true
  isolateClaudeConfig: false
  image: agentbox/box:dev
  memory: 2048
  cpus: 4
  pidsLimit: 512
  disk: 10G
claude:
  sessionName: claude
code:
  ide: cursor
  wait: true
  timeoutMs: 60000
  autoTerminals: false
shell:
  user: vscode
  login: true
checkpoint:
  maxLayers: 5
engine:
  kind: orbstack
browser:
  default: playwright
relay:
  port: 8787
vnc:
  containerPort: 6080
portless:
  enabled: true
  stateDir: /tmp/portless
autopause:
  enabled: false
  maxRunningBoxes: 4
  idleMinutes: 30
maintenance:
  pruneProjectConfigs: false
  pruneProjectConfigsEvery: 25
`,
  },
  {
    name: 'box resource limits',
    yaml: 'box:\n  memory: 1024\n  cpus: 2\n  pidsLimit: 256\n',
  },
  { name: 'autopause only', yaml: 'autopause:\n  enabled: true\n' },
  { name: 'queue only', yaml: 'queue:\n  enabled: true\n' },
  {
    name: 'queue full',
    yaml: 'queue:\n  enabled: true\n  maxConcurrent: 5\n  maxWorking: 3\n  idleGraceSeconds: 20\n',
  },
  { name: 'maintenance only', yaml: 'maintenance:\n  pruneProjectConfigs: true\n' },
  { name: 'portless only', yaml: 'portless:\n  enabled: true\n' },
  { name: 'portless stateDir', yaml: 'portless:\n  enabled: false\n  stateDir: /tmp/portless\n' },
];

const INVALID: Fixture[] = [
  {
    name: 'unknown branch',
    yaml: 'foo:\n  bar: 1\n',
  },
  {
    name: 'unknown leaf',
    yaml: 'box:\n  snorshot: true\n',
  },
  {
    name: 'wrong type for bool',
    yaml: 'box:\n  hostSnapshot: yes\n', // yaml parses bare yes as bool, but YAML 1.2 returns string
  },
  {
    name: 'renamed key box.snapshot',
    yaml: 'box:\n  snapshot: true\n',
  },
  {
    name: 'wrong type for string',
    yaml: 'box:\n  image: 42\n',
  },
  {
    name: 'wrong type for int',
    yaml: 'code:\n  timeoutMs: "120000"\n',
  },
  {
    name: 'box.memory wrong type',
    yaml: 'box:\n  memory: "2g"\n',
  },
  {
    name: 'box.cpu unknown sibling',
    yaml: 'box:\n  cpu: 2\n',
  },
  {
    name: 'unknown enum value',
    yaml: 'engine:\n  kind: podman\n',
  },
  {
    name: 'unknown browser value',
    yaml: 'browser:\n  default: firefox\n',
  },
  {
    name: 'autopause wrong type for int',
    yaml: 'autopause:\n  idleMinutes: "30"\n',
  },
  {
    name: 'autopause unknown leaf',
    yaml: 'autopause:\n  idleMins: 30\n',
  },
  {
    name: 'queue wrong type for int',
    yaml: 'queue:\n  maxWorking: "3"\n',
  },
  {
    name: 'queue unknown leaf',
    yaml: 'queue:\n  maxWorkers: 3\n',
  },
  {
    name: 'maintenance wrong type for int',
    yaml: 'maintenance:\n  pruneProjectConfigsEvery: "50"\n',
  },
  {
    name: 'maintenance unknown leaf',
    yaml: 'maintenance:\n  pruneProjectDirs: true\n',
  },
  {
    name: 'portless wrong type for bool',
    yaml: 'portless:\n  enabled: 1\n',
  },
  {
    name: 'portless unknown leaf',
    yaml: 'portless:\n  enable: true\n',
  },
];

describe('user-config: parser ↔ JSON schema agreement', () => {
  describe('VALID fixtures accepted by both', () => {
    for (const f of VALID) {
      it(f.name, () => {
        // Parser accepts.
        const fromParser = parseUserConfig(f.yaml, `<test:${f.name}>`);
        expect(fromParser).toBeTypeOf('object');
        // Schema accepts the parsed YAML doc (or {} for empty).
        const doc = parseYaml(f.yaml) ?? {};
        const ok = validate(doc);
        expect({ name: f.name, ok, errors: validate.errors }).toMatchObject({ ok: true });
      });
    }
  });

  describe('INVALID fixtures rejected by both', () => {
    for (const f of INVALID) {
      it(f.name, () => {
        // Parser rejects.
        expect(() => parseUserConfig(f.yaml, `<test:${f.name}>`)).toThrow();
        // Schema rejects.
        const doc = parseYaml(f.yaml) ?? {};
        const ok = validate(doc);
        // Note: YAML 1.2 disallows the YAML 1.1 `yes`/`no` shorthand for
        // booleans, so `box: { snapshot: yes }` parses to the string "yes".
        // Both parser and schema must reject (string != boolean).
        expect({ name: f.name, ok }).toMatchObject({ ok: false });
      });
    }
  });
});
