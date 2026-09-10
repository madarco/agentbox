/**
 * The host's standing approval of a project's `carry:` file list.
 *
 * Same trust split as the host-tool grants next door (`tools.ts`): the
 * `carry:` block in a project's `agentbox.yaml` is committed, so it can only
 * *request* that host files be copied into a box. A human approves a specific
 * list once, and that approval lands here — host-side, never in the repo.
 *
 * The grant is keyed on the LIST, not on file contents: `approvedId` is a
 * digest of the resolved src→dest table minus each row's size (see
 * `carryGrantId` in @agentbox/sandbox-core, which owns the shape). So editing a
 * file that is already approved does not re-ask, while adding, removing or
 * re-pointing an entry — or a mode/kind/symlink change — does.
 *
 * `files` is stored alongside the digest deliberately: an approval a user
 * cannot read back is not auditable, and `tools.yaml` records what was granted
 * rather than an opaque hash for the same reason.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { projectCarryFile } from './paths.js';

/** One approved entry, as shown in the table the user said yes to. */
export interface CarryGrantFile {
  /** `src` exactly as written in `agentbox.yaml`. */
  src: string;
  dest: string;
  kind: string;
  /** Octal string (`'0600'`), when the entry sets one. */
  mode?: string;
  /** Numeric uid, when the entry overrides the box user. */
  user?: number;
  /** The plain-word notes the gate showed (`optional`, `folder`, …). */
  flags?: string[];
}

export interface CarryGrant {
  /** `carry-grant:<12 hex>` — the identity of the approved list. */
  approvedId: string;
  /** ISO timestamp of the approval. */
  approvedAt: string;
  /** What was approved, for reading back. Never load-bearing for the match. */
  files: CarryGrantFile[];
}

/**
 * Read a project's carry grant. Returns undefined when there is none, and also
 * when the file is unreadable or malformed — a grant that cannot be understood
 * must fail closed (ask again), never approximate an approval.
 */
export async function readCarryGrant(projectRoot: string): Promise<CarryGrant | undefined> {
  let text: string;
  try {
    text = await readFile(projectCarryFile(projectRoot), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const doc = parseYaml(text) as unknown;
    if (!doc || typeof doc !== 'object') return undefined;
    const raw = doc as Record<string, unknown>;
    const approvedId = raw['approvedId'];
    const approvedAt = raw['approvedAt'];
    if (typeof approvedId !== 'string' || approvedId.length === 0) return undefined;
    return {
      approvedId,
      approvedAt: typeof approvedAt === 'string' ? approvedAt : '',
      files: Array.isArray(raw['files']) ? (raw['files'] as CarryGrantFile[]) : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Record (or replace) a project's carry grant. Creates the per-project dir: a
 * grant has to persist for a project that has no other host-side state yet.
 * One grant per project, so this overwrites rather than merging — the approval
 * is of a whole list, and two half-lists would approve something nobody saw.
 */
export async function writeCarryGrant(projectRoot: string, grant: CarryGrant): Promise<void> {
  const file = projectCarryFile(projectRoot);
  await mkdir(dirname(file), { recursive: true });
  const header =
    '# agentbox carry grant — the file list you approved for this project.\n' +
    '# An agentbox.yaml `carry:` entry is a request until it is approved here.\n' +
    '# Change the list and the next create asks again; `--carry ask` re-asks now.\n';
  await writeFile(file, header + stringifyYaml({ ...grant }), 'utf8');
}
