import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HistoryShipper,
  createRedactor,
  extractLargeStrings,
  parseBindingLog,
  restoreLargeStrings,
  type HistoryBinding,
  type HistoryFileSource,
  type HistoryFrame,
  type HistoryIngestResult,
  type ShippedAgent,
} from '../src/index.js';

const red = (s: string, secrets: string[] = []): string =>
  Buffer.from(createRedactor({ secrets }).redact(Buffer.from(s, 'latin1')).bytes).toString(
    'latin1',
  );

describe('redactor', () => {
  it('masks exact secret values, length-preserving', () => {
    const secret = 'hubtoken-0123456789abcdef';
    const line = `{"out":"token is ${secret} ok"}`;
    const out = red(line, [secret]);
    expect(out).not.toContain(secret);
    expect(out.length).toBe(line.length);
    expect(out).toContain('[REDACTED:secret]');
  });

  it('masks known formats', () => {
    const cases = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ];
    for (const c of cases) {
      const out = red(`x ${c} y`);
      expect(out, c).not.toContain(c);
      expect(out.length).toBe(c.length + 4);
    }
  });

  it('masks only the value of a compound format, and keeps placeholders and local URLs', () => {
    expect(red('Authorization: Bearer abcdef0123456789ABCDEFxyz')).toMatch(
      /^Authorization: Bearer \[REDACTED:bearer\]\**$/,
    );
    const real = 'postgres://app:S3cr3tPassw0rdXyZ@db.example.com/x';
    expect(red(real)).not.toContain('S3cr3tPassw0rdXyZ');
    expect(red(real)).toContain('postgres://app:');
    expect(red('postgres://app:password@db.example.com/x')).toContain(':password@');
    expect(red('postgres://app:S3cr3tPassw0rd@localhost:5432/x')).toContain('S3cr3tPassw0rd');
  });

  it('applies entropy only to assignment values', () => {
    expect(red('API_TOKEN=q8Zr2LxP0vK7mN4tB9wE')).not.toContain('q8Zr2LxP0vK7mN4tB9wE');
    expect(red('API_TOKEN=refresh_token_value')).toContain('refresh_token_value');
    expect(red('GITHUB_TOKEN=$GITHUB_TOKEN_FROM_ENV')).toContain('$GITHUB_TOKEN');
    // Free-floating high-entropy ids (tool ids, hashes) are left alone.
    expect(red('toolu_01AbCdEfGhIjKlMnOpQrStUv and 9f86d081884c7d659a2feaa0c55ad015')).toBe(
      'toolu_01AbCdEfGhIjKlMnOpQrStUv and 9f86d081884c7d659a2feaa0c55ad015',
    );
  });

  it('never changes the byte length of multi-byte text', () => {
    const line = Buffer.from(
      '{"t":"caffè ☕ sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"}',
      'utf8',
    );
    const out = createRedactor().redact(line);
    expect(out.bytes.length).toBe(line.length);
    expect(Buffer.from(out.bytes).toString('utf8')).toContain('caffè ☕');
  });
});

describe('large-string extraction', () => {
  it('round-trips byte for byte and dedupes repeats', () => {
    const big = 'A'.repeat(5000);
    const esc = `x\\"${'b'.repeat(4500)}`;
    const text = `{"a":"${big}","b":"small"}\n{"c":"${big}","d":"${esc}"}\npartial`;
    const ex = extractLargeStrings(Buffer.from(text));
    expect(ex.deduped).toBe(true);
    expect(ex.blobs).toHaveLength(2);
    expect(ex.bytes.length).toBeLessThan(text.length / 4);
    const blobs = new Map(ex.blobs.map((b) => [b.sha256, b.bytes]));
    expect(restoreLargeStrings(ex.bytes, (s) => blobs.get(s)).toString()).toBe(text);
  });

  it('leaves a chunk that already quotes the marker untouched', () => {
    const text = `{"a":"@@agentbox-blob:${'0'.repeat(64)}@@","b":"${'z'.repeat(5000)}"}\n`;
    const ex = extractLargeStrings(Buffer.from(text));
    expect(ex.deduped).toBe(false);
    expect(ex.bytes.toString()).toBe(text);
  });
});

describe('binding log', () => {
  it('keeps well-formed lines and drops torn ones', () => {
    const b = parseBindingLog(
      '{"ts":"t","boxId":"bx","agent":"claude","sessionId":"aaaaaaaa-1"}\n{"agent":"claude","sess\n',
    );
    expect(b).toEqual([{ ts: 't', boxId: 'bx', agent: 'claude', sessionId: 'aaaaaaaa-1' }]);
  });
});

// --- shipper engine over an in-memory box ---------------------------------

const CFG = '/home/vscode/.claude';
const AGENT: ShippedAgent = {
  agent: 'claude',
  configDir: CFG,
  projectKey: '-workspace',
  spec: {
    transcripts: [
      {
        root: 'projects/<projectKey>',
        format: 'jsonl',
        mode: 'append',
        sessionFiles: ['<sessionId>.jsonl', '<sessionId>/subagents/*.jsonl'],
      },
    ],
  },
};

class MemBox implements HistoryFileSource {
  files = new Map<string, Buffer>();
  bindings: HistoryBinding[] = [];
  readBindings = async (): Promise<HistoryBinding[]> => this.bindings;
  size = async (p: string): Promise<number | null> => this.files.get(p)?.length ?? null;
  read = async (p: string, o: number, l: number): Promise<Uint8Array> =>
    (this.files.get(p) ?? Buffer.alloc(0)).subarray(o, o + l);
  list = async (dir: string): Promise<string[] | null> => {
    const names = [...this.files.keys()]
      .filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
      .map((k) => k.slice(dir.length + 1));
    return names.length ? names : null;
  };
}

/** A minimal hub: offset + prefix hash per path, bytes kept. */
class MemHub {
  files = new Map<string, { bytes: Buffer; sha: string }>();
  frames: HistoryFrame[] = [];
  async ingest(f: HistoryFrame): Promise<HistoryIngestResult> {
    this.frames.push(f);
    const cur = this.files.get(f.path);
    const data = Buffer.from(f.data, 'base64');
    if (f.reset && f.offset === 0) {
      this.files.set(f.path, { bytes: data, sha: f.sha256 });
      return { ok: true, offset: data.length, sha256: f.sha256 };
    }
    const have = cur?.bytes.length ?? 0;
    if (f.offset !== have || (have > 0 && f.sha256Prefix !== cur!.sha)) {
      return {
        ok: false,
        code: 'offset_mismatch',
        message: 'x',
        offset: have,
        sha256: cur?.sha ?? '',
      };
    }
    const bytes = Buffer.concat([cur?.bytes ?? Buffer.alloc(0), data]);
    this.files.set(f.path, { bytes, sha: f.sha256 });
    return { ok: true, offset: bytes.length, sha256: f.sha256 };
  }
}

const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
const main = `${CFG}/projects/-workspace/${sid}.jsonl`;
const sub = `${CFG}/projects/-workspace/${sid}/subagents/agent-1.jsonl`;
const other = `${CFG}/projects/-workspace/bbbbbbbb-unbound.jsonl`;

function setup(frameMax = 1024): { box: MemBox; hub: MemHub; shipper: HistoryShipper } {
  const box = new MemBox();
  const hub = new MemHub();
  box.bindings = [{ ts: '', boxId: 'box1', agent: 'claude', sessionId: sid }];
  const shipper = new HistoryShipper({
    origin: { boxId: 'box1' },
    agents: [AGENT],
    source: box,
    sink: hub,
    redactor: createRedactor({ secrets: ['SUPERSECRETVALUE1'] }),
    frameMax,
  });
  return { box, hub, shipper };
}

describe('HistoryShipper', () => {
  it('ships only bound sessions and their subagent children, complete lines only', async () => {
    const { box, hub, shipper } = setup();
    box.files.set(main, Buffer.from('{"a":1}\n{"b":2}\n{"partial'));
    box.files.set(sub, Buffer.from('{"s":1}\n'));
    box.files.set(other, Buffer.from('{"other":1}\n'));
    await shipper.pass();
    expect([...hub.files.keys()].sort()).toEqual([
      `projects/-workspace/${sid}.jsonl`,
      `projects/-workspace/${sid}/subagents/agent-1.jsonl`,
    ]);
    expect(hub.files.get(`projects/-workspace/${sid}.jsonl`)!.bytes.toString()).toBe(
      '{"a":1}\n{"b":2}\n',
    );
    await shipper.pass({ final: true });
    expect(hub.files.get(`projects/-workspace/${sid}.jsonl`)!.bytes.toString()).toBe(
      '{"a":1}\n{"b":2}\n{"partial',
    );
  });

  it('hashes raw bytes but ships redacted ones of the same length', async () => {
    const { box, hub, shipper } = setup();
    const raw = Buffer.from('{"env":"SUPERSECRETVALUE1"}\n');
    box.files.set(main, raw);
    await shipper.pass();
    const got = hub.files.get(`projects/-workspace/${sid}.jsonl`)!;
    expect(got.bytes.toString()).not.toContain('SUPERSECRETVALUE1');
    expect(got.bytes.length).toBe(raw.length);
    expect(got.sha).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('splits into frames on line boundaries and appends incrementally', async () => {
    const { box, hub, shipper } = setup(64);
    const lines = Array.from({ length: 20 }, (_, i) => `{"i":${String(i)},"pad":"xxxxxxxx"}\n`);
    box.files.set(main, Buffer.from(lines.slice(0, 10).join('')));
    await shipper.pass();
    box.files.set(main, Buffer.from(lines.join('')));
    await shipper.pass();
    expect(hub.files.get(`projects/-workspace/${sid}.jsonl`)!.bytes.toString()).toBe(
      lines.join(''),
    );
    for (const f of hub.frames)
      expect(Buffer.from(f.data, 'base64').toString().endsWith('\n')).toBe(true);
  });

  it('fast-forwards a fresh edge to what the hub already holds', async () => {
    const { box, hub, shipper } = setup();
    box.files.set(main, Buffer.from('{"a":1}\n'));
    await shipper.pass();
    box.files.set(main, Buffer.from('{"a":1}\n{"b":2}\n'));
    // A restarted edge: new shipper, same hub.
    const again = new HistoryShipper({
      origin: { boxId: 'box1' },
      agents: [AGENT],
      source: box,
      sink: hub,
      redactor: createRedactor(),
      frameMax: 1024,
    });
    await again.pass();
    expect(hub.files.get(`projects/-workspace/${sid}.jsonl`)!.bytes.toString()).toBe(
      '{"a":1}\n{"b":2}\n',
    );
    expect(hub.frames.some((f) => f.reset)).toBe(false);
  });

  it('re-ships from 0 as a reset when the file was rewritten', async () => {
    const { box, hub, shipper } = setup();
    box.files.set(main, Buffer.from('{"a":1}\n{"b":2}\n'));
    await shipper.pass();
    box.files.set(main, Buffer.from('{"z":9}\n'));
    await shipper.pass();
    expect(hub.files.get(`projects/-workspace/${sid}.jsonl`)!.bytes.toString()).toBe('{"z":9}\n');
    expect(hub.frames.at(-1)!.reset).toBe(true);
  });

  it('stops for good on disabled', async () => {
    const box = new MemBox();
    box.bindings = [{ ts: '', boxId: 'b', agent: 'claude', sessionId: sid }];
    box.files.set(main, Buffer.from('{"a":1}\n'));
    const shipper = new HistoryShipper({
      origin: { boxId: 'b' },
      agents: [AGENT],
      source: box,
      sink: { ingest: async () => ({ ok: false, code: 'disabled', message: 'off' }) },
      redactor: createRedactor(),
      frameMax: 1024,
    });
    expect((await shipper.pass()).disabled).toBe(true);
    expect(shipper.isDisabled).toBe(true);
  });
});

describe('checkpoint-carried bindings (review B1)', () => {
  it("ships only this box's own binding lines, never foreign or unstamped ones", async () => {
    const { box, hub, shipper } = setup();
    const foreign = 'cccccccc-1111-2222-3333-444444444444';
    const legacy = 'dddddddd-1111-2222-3333-444444444444';
    box.bindings = [
      { ts: '', boxId: 'source-box', agent: 'claude', sessionId: foreign },
      { ts: '', agent: 'claude', sessionId: legacy },
      { ts: '', boxId: 'box1', agent: 'claude', sessionId: sid },
    ];
    for (const id of [foreign, legacy, sid]) {
      box.files.set(`${CFG}/projects/-workspace/${id}.jsonl`, Buffer.from('{"a":1}\n'));
    }
    await shipper.pass();
    expect([...hub.files.keys()]).toEqual([`projects/-workspace/${sid}.jsonl`]);
  });
});

describe('batched scan (review B2)', () => {
  it('uses one scan per pass and reads only files that grew', async () => {
    const { box, hub } = setup();
    box.bindings = [{ ts: '', boxId: 'box1', agent: 'claude', sessionId: sid }];
    box.files.set(main, Buffer.from('{"a":1}\n'));
    box.files.set(sub, Buffer.from('{"s":1}\n'));
    const calls: string[] = [];
    const scanning: HistoryFileSource = {
      readBindings: async () => {
        calls.push('readBindings');
        return box.bindings;
      },
      size: async (p) => {
        calls.push('size');
        return box.size(p);
      },
      list: async (d) => {
        calls.push('list');
        return box.list(d);
      },
      read: async (p, o, l) => {
        calls.push(`read ${p.slice(p.lastIndexOf('/') + 1)}`);
        return box.read(p, o, l);
      },
      scan: async (roots) => {
        calls.push(`scan ${roots.join(',')}`);
        return {
          bindings: box.bindings,
          sizes: new Map([...box.files].map(([k, v]) => [k, v.length])),
        };
      },
    };
    const shipper = new HistoryShipper({
      origin: { boxId: 'box1' },
      agents: [AGENT],
      source: scanning,
      sink: hub,
      redactor: createRedactor(),
      frameMax: 1024,
    });
    await shipper.pass();
    expect(calls.filter((c) => !c.startsWith('read'))).toEqual([`scan ${CFG}/projects/-workspace`]);
    expect(hub.files.size).toBe(2);
    calls.length = 0;
    await shipper.pass(); // idle: nothing grew
    expect(calls).toEqual([`scan ${CFG}/projects/-workspace`]);
    box.files.set(sub, Buffer.from('{"s":1}\n{"s":2}\n'));
    calls.length = 0;
    await shipper.pass();
    expect(calls).toEqual([`scan ${CFG}/projects/-workspace`, 'read agent-1.jsonl']);
  });
});

describe('private-key rule stays inside one line (review L3)', () => {
  it('never masks across real newlines', () => {
    const text =
      '{"a":"-----BEGIN RSA PRIVATE KEY----- truncated"}\n{"keep":"this line survives"}\n{"b":"-----END RSA PRIVATE KEY-----"}\n';
    const out = red(text);
    expect(out).toBe(text);
    expect(out.split('\n')).toHaveLength(4);
  });

  it('still masks a key escaped inside one JSONL line', () => {
    const line =
      '{"t":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----"}\n';
    const out = red(line);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(out.length).toBe(line.length);
  });
});
