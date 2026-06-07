import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseConfig } from '../src/config.js';

// The schema lives outside src/, so resolve via the test file location.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '..', 'schema', 'agentbox.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

interface Fixture {
  name: string;
  yaml: string;
  // `runtimeOnly` are the cross-field rules JSON Schema can't express (e.g.
  // max_ms >= initial_ms). The runtime validator rejects them, the schema
  // accepts them. Those rows are documented here but skipped from the agreement
  // assertion.
  runtimeOnly?: true;
  // `schemaOnly` is the mirror image: the JSON schema rejects, but the runtime
  // supervisor accepts. Used for `carry:` — the supervisor only whitelists the
  // top-level key (the host CLI parses its contents), so it never validates
  // carry item shape, while the schema does.
  schemaOnly?: true;
}

const VALID: Fixture[] = [
  { name: 'empty doc', yaml: '' },
  { name: 'empty services map', yaml: 'services: {}' },
  {
    name: 'minimal shell-string service',
    yaml: `services:\n  web:\n    command: pnpm dev\n`,
  },
  {
    name: 'argv command + cwd + env + restart + backoff',
    yaml: `
services:
  worker:
    command: ["node", "worker.js"]
    cwd: apps/worker
    env:
      LOG_LEVEL: debug
      PORT: 4000
      VERBOSE: true
    restart: always
    autostart: false
    backoff:
      initial_ms: 1000
      max_ms: 60000
      factor: 3
`,
  },
  {
    name: 'tasks-only config',
    yaml: `tasks:\n  install:\n    command: pnpm install\n`,
  },
  {
    name: 'task with needs on another task',
    yaml: `
tasks:
  install:
    command: pnpm install
  build:
    command: pnpm build
    needs: [install]
`,
  },
  {
    name: 'service with needs on task',
    yaml: `
tasks:
  build:
    command: pnpm build
services:
  api:
    command: pnpm dev
    needs: [build]
`,
  },
  {
    name: 'service with port probe',
    yaml: `
services:
  api:
    command: pnpm dev
    ready_when:
      port: 3000
`,
  },
  {
    name: 'service with expose (explicit as: 80)',
    yaml: `
services:
  dev:
    command: pnpm dev
    ready_when:
      port: 3000
    expose:
      port: 3000
      as: 80
`,
  },
  {
    name: 'service with expose (as defaulted)',
    yaml: `
services:
  dev:
    command: pnpm dev
    expose:
      port: 3000
`,
  },
  {
    name: 'service with port probe + host + intervals',
    yaml: `
services:
  api:
    command: pnpm dev
    ready_when:
      port: 3000
      host: 0.0.0.0
      interval_ms: 250
      initial_delay_ms: 1000
      timeout_ms: 120000
      on_timeout: mark_unhealthy
`,
  },
  {
    name: 'service with log_match probe',
    yaml: `
services:
  api:
    command: pnpm dev
    ready_when:
      log_match: "Server listening on \\\\d+"
      timeout_ms: 30000
`,
  },
  {
    name: 'service with http probe + expect_status',
    yaml: `
services:
  api:
    command: pnpm dev
    ready_when:
      http: "http://127.0.0.1:3000/health"
      expect_status: 200
      timeout_ms: 45000
`,
  },
  {
    name: 'mixed config with tasks, services, deps, probes, ide block',
    yaml: `
tasks:
  install:
    command: pnpm install
  build:
    command: pnpm build
    needs: [install]
services:
  api:
    command: pnpm dev
    needs: [build]
    ready_when:
      port: 3000
      timeout_ms: 90000
    ide:
      tail: false
ide:
  auto_open_terminals: true
`,
  },
  // Top-level `defaults:` block — host-side @agentbox/config consumes it; the
  // ctl parser only confirms it's a mapping (so typos at the top level still
  // surface). See packages/config/test/schema-drift.test.ts for strict leaf
  // validation of the `defaults:` body.
  {
    name: 'empty defaults block',
    yaml: 'defaults: {}\nservices: {}\n',
  },
  {
    name: 'defaults with leaves (ctl is permissive)',
    yaml: `
defaults:
  box:
    snapshot: true
  engine:
    kind: orbstack
services:
  web:
    command: pnpm dev
`,
  },
  // Top-level `carry:` block — host-applied (read by the agentbox CLI, not the
  // supervisor). The schema documents/validates the item shape; the supervisor
  // only whitelists the key (see schemaOnly fixtures below).
  {
    name: 'carry shorthand string entry',
    yaml: `carry:\n  - ~/.agentbox/secrets.env\n`,
  },
  {
    name: 'carry mapping with dest + exclude',
    yaml: `
carry:
  - src: ./legacy
    dest: ~/legacy
    exclude: ["*/cache", ".git"]
    optional: true
`,
  },
  {
    name: 'carry mapping with mode + user',
    yaml: `
carry:
  - src: ~/.agentbox/secrets.env
    dest: ~/.agentbox/secrets.env
    mode: "0600"
    user: 1000
`,
  },
  {
    name: 'task with idempotent: true',
    yaml: `tasks:\n  install:\n    command: pnpm install\n    idempotent: true\n`,
  },
  {
    name: 'task with idempotent check',
    yaml: `
tasks:
  seed:
    command: pnpm db:seed
    idempotent:
      check: "psql -tAc 'select 1' | grep -q 1"
`,
  },
  {
    name: 'top-level replacements block',
    yaml: `
replacements:
  box-host:
    - from: '\\.optima\\.localhost'
      to: '.{{AGENTBOX_BOX_NAME}}.localhost'
      regex: true
services:
  web:
    command: pnpm dev
`,
  },
  {
    name: 'carry mapping with replaceEnvs + replace + rules',
    yaml: `
replacements:
  box-host:
    - from: optima.localhost
      to: '{{AGENTBOX_BOX_HOST}}'
carry:
  - src: ~/secrets/.env.prod
    dest: /workspace/apps/saas/.env
    replaceEnvs: true
    rules: [box-host]
    replace:
      - from: PLACEHOLDER
        to: '{{AGENTBOX_BOX_NAME}}'
`,
  },
];

const INVALID: Fixture[] = [
  { name: 'empty command string', yaml: `services:\n  web:\n    command: ""\n` },
  { name: 'empty argv', yaml: `services:\n  web:\n    command: []\n` },
  { name: 'argv element not a string', yaml: `services:\n  web:\n    command: ["node", 42]\n` },
  { name: 'missing command', yaml: `services:\n  web:\n    cwd: apps/web\n` },
  {
    name: 'unknown restart enum',
    yaml: `services:\n  web:\n    command: foo\n    restart: maybe\n`,
  },
  {
    name: 'env value is an object',
    yaml: `services:\n  web:\n    command: foo\n    env:\n      K:\n        nested: 1\n`,
  },
  {
    name: 'service name has spaces',
    yaml: `services:\n  "bad name":\n    command: foo\n`,
  },
  {
    name: 'unknown top-level key',
    yaml: `extra: 1\nservices:\n  web:\n    command: foo\n`,
  },
  {
    name: 'typo of defaults (defualts) is rejected as unknown top-level key',
    yaml: `defualts:\n  box:\n    snapshot: true\n`,
  },
  {
    name: 'defaults that is not a mapping',
    yaml: `defaults: 42\n`,
  },
  {
    name: 'unknown service key',
    yaml: `services:\n  web:\n    command: foo\n    restartt: always\n`,
  },
  {
    name: 'unknown backoff key',
    yaml: `services:\n  web:\n    command: foo\n    backoff:\n      jitter_ms: 100\n`,
  },
  {
    name: 'autostart wrong type',
    yaml: `services:\n  web:\n    command: foo\n    autostart: yes-please\n`,
  },
  {
    name: 'factor < 1',
    yaml: `services:\n  web:\n    command: foo\n    backoff:\n      factor: 0.5\n`,
  },
  {
    name: 'task with restart field',
    yaml: `tasks:\n  build:\n    command: pnpm build\n    restart: always\n`,
  },
  {
    name: 'task with autostart field',
    yaml: `tasks:\n  build:\n    command: pnpm build\n    autostart: false\n`,
  },
  {
    name: 'task with ready_when',
    yaml: `tasks:\n  build:\n    command: pnpm build\n    ready_when:\n      port: 3000\n`,
  },
  {
    name: 'task with backoff',
    yaml: `tasks:\n  build:\n    command: pnpm build\n    backoff:\n      initial_ms: 100\n`,
  },
  {
    name: 'ready_when with both port and http',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      port: 3000
      http: "http://localhost:3000"
`,
  },
  {
    name: 'ready_when with both port and log_match',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      port: 3000
      log_match: "ready"
`,
  },
  {
    name: 'ready_when missing port/log_match/http',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      timeout_ms: 30000
`,
  },
  {
    name: 'ready_when unknown probe key',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      probe_via_tcp: 3000
`,
  },
  {
    name: 'ready_when port out of range',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      port: 99999
`,
  },
  {
    name: 'ready_when on_timeout invalid enum',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      port: 3000
      on_timeout: maybe
`,
  },
  {
    name: 'needs not an array',
    yaml: `
services:
  api:
    command: foo
    needs: build
`,
  },
  {
    name: 'needs element not a string',
    yaml: `
services:
  api:
    command: foo
    needs: [42]
`,
  },
  {
    name: 'task name with spaces',
    yaml: `tasks:\n  "bad name":\n    command: foo\n`,
  },
  // Cross-field rules the schema cannot express.
  {
    name: 'max_ms < initial_ms (validator-only)',
    yaml: `services:\n  web:\n    command: foo\n    backoff:\n      initial_ms: 5000\n      max_ms: 100\n`,
    runtimeOnly: true,
  },
  {
    name: 'cyclic needs (validator-only)',
    yaml: `
tasks:
  a:
    command: echo a
    needs: [b]
  b:
    command: echo b
    needs: [a]
`,
    runtimeOnly: true,
  },
  {
    name: 'needs references unknown unit (validator-only)',
    yaml: `
services:
  api:
    command: foo
    needs: [ghost]
`,
    runtimeOnly: true,
  },
  {
    name: 'task and service share a name (validator-only)',
    yaml: `
tasks:
  api:
    command: pnpm build
services:
  api:
    command: pnpm dev
`,
    runtimeOnly: true,
  },
  {
    name: 'log_match invalid regex (validator-only)',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      log_match: "(unclosed"
`,
    runtimeOnly: true,
  },
  {
    name: 'self-dependency (validator-only)',
    yaml: `
services:
  api:
    command: foo
    needs: [api]
`,
    runtimeOnly: true,
  },
  {
    name: 'http url with unsupported scheme (validator-only)',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      http: "ftp://example.com/health"
`,
    runtimeOnly: true,
  },
  {
    name: 'port probe with expect_status (validator-only)',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      port: 3000
      expect_status: 200
`,
    runtimeOnly: true,
  },
  {
    name: 'log_match probe with interval_ms (validator-only)',
    yaml: `
services:
  api:
    command: foo
    ready_when:
      log_match: "ready"
      interval_ms: 250
`,
    runtimeOnly: true,
  },
  {
    name: 'expose missing required port',
    yaml: `
services:
  dev:
    command: pnpm dev
    expose:
      as: 80
`,
  },
  {
    name: 'expose with unknown key',
    yaml: `
services:
  dev:
    command: pnpm dev
    expose:
      port: 3000
      host: 127.0.0.1
`,
  },
  {
    name: 'two services with expose (cross-field, validator-only)',
    yaml: `
services:
  web:
    command: pnpm dev
    expose:
      port: 3000
  api:
    command: pnpm api
    expose:
      port: 4000
`,
    runtimeOnly: true,
  },
  {
    name: 'expose.as not 80 (cross-field, validator-only)',
    yaml: `
services:
  dev:
    command: pnpm dev
    expose:
      port: 3000
      as: 8080
`,
    runtimeOnly: true,
  },
  // carry: the schema validates item shape; the supervisor only whitelists the
  // top-level key, so it accepts these (schema-only rejections).
  {
    name: 'carry item missing src (schema-only)',
    yaml: `carry:\n  - dest: ~/x\n`,
    schemaOnly: true,
  },
  {
    name: 'carry item with unknown key (schema-only)',
    yaml: `carry:\n  - src: ./a\n    dest: ~/a\n    bogus: 1\n`,
    schemaOnly: true,
  },
  {
    name: 'carry exclude not an array (schema-only)',
    yaml: `carry:\n  - src: ./a\n    dest: ~/a\n    exclude: "nope"\n`,
    schemaOnly: true,
  },
  {
    name: 'carry not an array (schema-only)',
    yaml: `carry: 42\n`,
    schemaOnly: true,
  },
  {
    name: 'idempotent as a string',
    yaml: `tasks:\n  build:\n    command: pnpm build\n    idempotent: "yes"\n`,
  },
  {
    name: 'idempotent object with unknown key',
    yaml: `tasks:\n  build:\n    command: pnpm build\n    idempotent:\n      probe: foo\n`,
  },
  {
    name: 'replacements rule missing to',
    yaml: `replacements:\n  r:\n    - from: a\n`,
  },
  {
    name: 'replacements rule unknown key',
    yaml: `replacements:\n  r:\n    - from: a\n      to: b\n      bogus: 1\n`,
  },
  {
    name: 'replacements invalid regex (validator-only)',
    yaml: `replacements:\n  r:\n    - from: "(unclosed"\n      to: b\n      regex: true\n`,
    runtimeOnly: true,
  },
  {
    name: 'carry replace rule missing to (schema-only)',
    yaml: `carry:\n  - src: ./a\n    dest: ~/a\n    replace:\n      - from: x\n`,
    schemaOnly: true,
  },
  {
    name: 'carry replaceEnvs wrong type (schema-only)',
    yaml: `carry:\n  - src: ./a\n    dest: ~/a\n    replaceEnvs: "yes"\n`,
    schemaOnly: true,
  },
];

function runtimeAccepts(yaml: string): boolean {
  try {
    parseConfig(yaml);
    return true;
  } catch {
    return false;
  }
}

function schemaAccepts(yaml: string): boolean {
  const doc = parseYaml(yaml);
  return validate(doc ?? {});
}

describe('JSON Schema ↔ runtime validator agreement', () => {
  for (const f of VALID) {
    it(`accepts: ${f.name}`, () => {
      expect(runtimeAccepts(f.yaml), 'runtime rejected a valid fixture').toBe(true);
      expect(schemaAccepts(f.yaml), 'schema rejected a valid fixture').toBe(true);
    });
  }

  for (const f of INVALID) {
    if (f.runtimeOnly) {
      it(`runtime-only reject: ${f.name}`, () => {
        expect(runtimeAccepts(f.yaml)).toBe(false);
        // Schema accepts — documented gap (cross-field rule).
        expect(schemaAccepts(f.yaml)).toBe(true);
      });
      continue;
    }
    if (f.schemaOnly) {
      it(`schema-only reject: ${f.name}`, () => {
        // Runtime accepts — the supervisor whitelists `carry:` but never
        // validates its item shape (the host CLI does, separately).
        expect(runtimeAccepts(f.yaml)).toBe(true);
        expect(schemaAccepts(f.yaml)).toBe(false);
      });
      continue;
    }
    it(`rejects: ${f.name}`, () => {
      expect(runtimeAccepts(f.yaml), 'runtime accepted an invalid fixture').toBe(false);
      expect(schemaAccepts(f.yaml), 'schema accepted an invalid fixture').toBe(false);
    });
  }
});
