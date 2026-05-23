/**
 * Provider-neutral box-resolution errors. Thrown by the box-ref resolver and
 * caught by the CLI's lifecycle error handler. They carry the query (and, for
 * the ambiguous case, the candidate records) so the CLI can render a useful
 * hint.
 */

import type { BoxRecord } from './box-record.js';

export class BoxNotFoundError extends Error {
  constructor(public readonly query: string) {
    super(`no agentbox matches "${query}"`);
    this.name = 'BoxNotFoundError';
  }
}

export class AmbiguousBoxError extends Error {
  constructor(
    public readonly query: string,
    public readonly matches: BoxRecord[],
  ) {
    const ids = matches.map((m) => m.id).join(', ');
    super(`"${query}" matches multiple boxes: ${ids}`);
    this.name = 'AmbiguousBoxError';
  }
}
