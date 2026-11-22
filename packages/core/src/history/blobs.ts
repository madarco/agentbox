import { createHash } from 'node:crypto';

/**
 * Content-addressed large-string extraction (Phase 0: strings >= 4 KB are 53% of
 * claude's bytes and a third of all bytes are repeats). A JSON string literal at
 * least `minBytes` long is replaced, between its quotes, by a marker naming the
 * sha256 of its raw (still-escaped) bytes; `restoreLargeStrings` puts it back
 * byte for byte. A chunk that already contains the marker prefix is not
 * deduplicated at all (`deduped: false`), and the caller records that so a
 * transcript quoting a marker is never restored.
 */

export const BLOB_MIN_BYTES = 4096;
const MARKER_PREFIX = Buffer.from('@@agentbox-blob:', 'latin1');
const MARKER_SUFFIX = Buffer.from('@@', 'latin1');
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;

export interface ExtractedBlob {
  sha256: string;
  bytes: Buffer;
}

export function extractLargeStrings(
  input: Uint8Array,
  minBytes = BLOB_MIN_BYTES,
): { bytes: Buffer; blobs: ExtractedBlob[]; deduped: boolean } {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.includes(MARKER_PREFIX)) return { bytes: Buffer.from(buf), blobs: [], deduped: false };
  const out: Buffer[] = [];
  const blobs = new Map<string, Buffer>();
  let copied = 0;
  let lineStart = 0;
  while (lineStart < buf.length) {
    let lineEnd = buf.indexOf(NEWLINE, lineStart);
    if (lineEnd === -1) lineEnd = buf.length;
    if (lineEnd - lineStart >= minBytes) {
      let i = lineStart;
      while (i < lineEnd) {
        if (buf[i] !== QUOTE) {
          i++;
          continue;
        }
        const open = i;
        i++;
        while (i < lineEnd && buf[i] !== QUOTE) i += buf[i] === BACKSLASH ? 2 : 1;
        const close = i; // index of the closing quote (or lineEnd if unterminated)
        if (close < lineEnd && close - open - 1 >= minBytes) {
          const body = buf.subarray(open + 1, close);
          const sha = createHash('sha256').update(body).digest('hex');
          if (!blobs.has(sha)) blobs.set(sha, Buffer.from(body));
          out.push(buf.subarray(copied, open + 1), MARKER_PREFIX, Buffer.from(sha), MARKER_SUFFIX);
          copied = close;
        }
        i = close + 1;
      }
    }
    lineStart = lineEnd + 1;
  }
  if (blobs.size === 0) return { bytes: Buffer.from(buf), blobs: [], deduped: true };
  out.push(buf.subarray(copied));
  return {
    bytes: Buffer.concat(out),
    blobs: [...blobs].map(([sha256, bytes]) => ({ sha256, bytes })),
    deduped: true,
  };
}

/** Shas a stored chunk references, without restoring it. */
export function referencedBlobs(input: Uint8Array): string[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const shas = new Set<string>();
  let i = buf.indexOf(MARKER_PREFIX);
  while (i !== -1) {
    const s = i + MARKER_PREFIX.length;
    shas.add(buf.subarray(s, s + 64).toString('latin1'));
    i = buf.indexOf(MARKER_PREFIX, s + 64);
  }
  return [...shas];
}

export function restoreLargeStrings(
  input: Uint8Array,
  lookup: (sha256: string) => Uint8Array | undefined,
): Buffer {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const out: Buffer[] = [];
  let copied = 0;
  let i = buf.indexOf(MARKER_PREFIX);
  while (i !== -1) {
    const s = i + MARKER_PREFIX.length;
    const sha = buf.subarray(s, s + 64).toString('latin1');
    const end = s + 64 + MARKER_SUFFIX.length;
    const blob = lookup(sha);
    if (!blob) throw new Error(`history blob ${sha} is missing`);
    out.push(buf.subarray(copied, i), Buffer.from(blob));
    copied = end;
    i = buf.indexOf(MARKER_PREFIX, end);
  }
  if (copied === 0) return Buffer.from(buf);
  out.push(buf.subarray(copied));
  return Buffer.concat(out);
}
