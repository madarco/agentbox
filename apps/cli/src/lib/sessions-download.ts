// `agentbox sessions download`'s file write, split out so it is testable: the
// bytes go to `<target>.part` and are renamed into place only once the whole
// stream arrived, so an interrupted download never leaves a truncated file
// that looks complete (and never clobbers an earlier complete one).
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** Write `body` to `target` atomically; resolves with the bytes actually written. */
export async function saveStreamAtomically(
  body: ReadableStream<Uint8Array> | WebReadableStream<Uint8Array>,
  target: string,
): Promise<number> {
  const part = `${target}.part`;
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      count,
      createWriteStream(part),
    );
    await rename(part, target);
    return bytes;
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
}
