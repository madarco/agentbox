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
  { name: 'box only', yaml: 'box:\n  snapshot: true\n' },
  { name: 'engine override', yaml: 'engine:\n  kind: orbstack\n' },
  {
    name: 'kitchen sink',
    yaml: `
box:
  snapshot: false
  withPlaywright: true
  vnc: true
  isolateClaudeConfig: false
  image: agentbox/box:dev
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
engine:
  kind: orbstack
browser:
  default: playwright
relay:
  port: 8787
vnc:
  containerPort: 6080
autopause:
  enabled: false
  maxRunningBoxes: 4
  idleMinutes: 30
maintenance:
  pruneProjectConfigs: false
  pruneProjectConfigsEvery: 25
`,
  },
  { name: 'autopause only', yaml: 'autopause:\n  enabled: true\n' },
  { name: 'maintenance only', yaml: 'maintenance:\n  pruneProjectConfigs: true\n' },
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
    yaml: 'box:\n  snapshot: yes\n', // yaml parses bare yes as bool, but YAML 1.2 returns string
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
    name: 'maintenance wrong type for int',
    yaml: 'maintenance:\n  pruneProjectConfigsEvery: "50"\n',
  },
  {
    name: 'maintenance unknown leaf',
    yaml: 'maintenance:\n  pruneProjectDirs: true\n',
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
