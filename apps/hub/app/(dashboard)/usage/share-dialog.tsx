'use client';

// The Usage page's Share (usage dashboard Phase 6): a preview of the exact
// `UsageShare` the hub will post (rendered by the same `UsageView`, public
// variant), a handle field, then the public URL. PURE REST CLIENT: the hub posts
// to agent-box.sh, the browser only calls /api/v1/usage/share.

import { HANDLE_RE, type RangeId, type UsageShare } from '@agentbox/usage-view';
import { UsageView } from '@agentbox/usage-view/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { localDay, usageShareBody } from '@/lib/usage-page';

interface Preview {
  share: UsageShare;
  endpoint: string;
  bytes: number;
  claimed: boolean;
}
interface Posted {
  url: string;
  handle: string;
  n: number;
  claimedNow: boolean;
}
interface Settings {
  endpoint: string;
  handles: string[];
  lastHandle: string | null;
}

async function api<T>(method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const r = await fetch('/api/v1/usage/share', {
    method,
    credentials: 'same-origin',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(json.error?.message ?? `request failed (${String(r.status)})`);
  return json;
}

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The handle the preview is built with until a valid one is typed. */
const PLACEHOLDER = 'you';

export function ShareDialog({
  range,
  tz,
  subscription,
  onClose,
}: {
  range: RangeId;
  tz: string;
  subscription: string | undefined;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [handle, setHandle] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const today = useRef(localDay()).current;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const s = await api<Settings>('GET');
        if (!live) return;
        setSettings(s);
        setHandle((h) => h || s.lastHandle || '');
        const p = await api<Preview>(
          'POST',
          usageShareBody(range, today, tz, subscription, s.lastHandle ?? PLACEHOLDER, true),
        );
        if (live) setPreview(p);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [range, tz, subscription, today]);

  const valid = HANDLE_RE.test(handle);
  // The handle is the share's only string; the preview shows the one typed.
  const shown = preview ? { ...preview.share, handle: valid ? handle : PLACEHOLDER } : null;
  const claimed = settings?.handles.includes(handle) ?? false;

  const submit = useCallback(async () => {
    if (!valid || posting) return;
    setPosting(true);
    setError(null);
    try {
      setPosted(
        await api<Posted>('POST', usageShareBody(range, today, tz, subscription, handle, false)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }, [valid, posting, range, today, tz, subscription, handle]);

  const copy = async (): Promise<void> => {
    if (!posted) return;
    try {
      await navigator.clipboard.writeText(posted.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed: select the link and copy it by hand.');
    }
  };

  const site = host(preview?.endpoint ?? settings?.endpoint ?? 'https://agent-box.sh');

  return (
    <Dialog onClose={onClose} className="max-w-[1240px]">
      <div className="border-b border-border/70 px-5 pb-4 pt-5 pr-14">
        <div className="text-base font-semibold leading-tight tracking-tight">
          {posted ? 'Shared' : `Share on ${site}`}
        </div>
        <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
          {posted
            ? 'Anyone with the link can see this page. It does not change when your usage does.'
            : 'Only the numbers below leave this hub, with your handle: hours, counts, dates, and agent and provider names. No box, project, branch, pull request or session name, and no code or transcript.'}
        </p>
      </div>

      {posted ? (
        <div className="px-5 py-5">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <a
              href={posted.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground hover:underline"
            >
              {posted.url}
            </a>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => void copy()}>
                {copied ? <Icons.check /> : <Icons.copy />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <Button href={posted.url} target="_blank" rel="noreferrer">
                <Icons.ext />
                Open
              </Button>
            </div>
          </div>
          {posted.claimedNow && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              This hub now holds the handle <b className="text-foreground">{posted.handle}</b> on{' '}
              {site}. Later shares from this hub use it; another hub can’t.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-destructive">
              {error}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="max-h-[min(62vh,760px)] overflow-y-auto border-b border-border/70 bg-background">
            {shown ? (
              <div className="pointer-events-none select-none" aria-label="Preview of the share">
                <UsageView
                  data={shown}
                  footer={`Preview · ${(preview!.bytes / 1024).toFixed(1)} KB sent to ${site}`}
                />
              </div>
            ) : (
              <div
                className="grid h-48 place-items-center text-sm text-muted-foreground"
                aria-busy={!error}
              >
                {error ? 'No preview.' : 'Building the preview…'}
              </div>
            )}
          </div>
          <form
            className="px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="share-handle" className="text-[13px] font-medium">
              Handle
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-card pl-3 text-sm text-muted-foreground focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15">
                <span className="shrink-0 font-mono">{site}/u/</span>
                <Input
                  id="share-handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase().trim())}
                  placeholder="your-name"
                  maxLength={39}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={handle !== '' && !valid}
                  aria-describedby="share-handle-hint"
                  className="h-9 border-0 bg-transparent pl-0.5 font-mono text-foreground shadow-none focus-visible:ring-0"
                />
              </div>
              <Button type="submit" disabled={!valid || !preview || posting}>
                {posting ? 'Sharing…' : 'Share'}
              </Button>
            </div>
            <p
              id="share-handle-hint"
              className={`mt-1.5 text-xs ${handle !== '' && !valid ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {handle !== '' && !valid
                ? 'Lowercase letters, digits and dashes, up to 39.'
                : claimed
                  ? 'This hub already holds this handle: the share is added to its page.'
                  : 'The first share of a handle claims it for this hub.'}
            </p>
            {error && (
              <p role="alert" className="mt-2 text-[13px] text-destructive">
                {error}
              </p>
            )}
          </form>
        </>
      )}
      <DialogFooter className="sm:hidden">
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
