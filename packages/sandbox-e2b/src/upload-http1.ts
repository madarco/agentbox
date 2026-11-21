import { Agent } from 'undici';

/**
 * Run `fn` with the E2B SDK's template file uploads forced onto HTTP/1.1.
 *
 * `Template.build` PUTs every COPY source to a signed storage.googleapis.com URL
 * all at once. Node >= 26 (bundled undici 8) negotiates HTTP/2 for global
 * `fetch`, so the whole burst is multiplexed on one connection and GCS resets
 * the streams with NGHTTP2_ENHANCE_YOUR_CALM — surfaced by the SDK only as
 * `FileUploadError: Failed to upload file: TypeError: fetch failed`. Over
 * HTTP/1.1 each upload gets its own connection, which is what older Node did.
 *
 * Only PUTs are rerouted: the SDK's one PUT is that upload, and its API calls
 * are left on the default dispatcher.
 */
export async function withHttp1Uploads<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const agent = new Agent({ allowH2: false });
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    init?.method === 'PUT'
      ? original(input, { ...init, dispatcher: agent } as unknown as RequestInit)
      : original(input, init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    // Not awaited: on a failed build the SDK's sibling uploads may still be in
    // flight, and a graceful close would hold the error until they finish.
    void agent.close().catch(() => {});
  }
}
