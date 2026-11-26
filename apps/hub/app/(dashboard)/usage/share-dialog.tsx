'use client';

// The Usage page's Share (usage dashboard Phase 6): a preview of the exact
// `UsageShare` the hub will post (rendered by the same `UsageView`, public
// variant), an optional name to show, then the public URL; below, the shares this
// hub made, each with Delete. PURE REST CLIENT: the hub posts to and deletes on
// agent-box.sh, the browser only calls /api/v1/usage/share.

import { SHARE_NAME_RE, type RangeId, type UsageShare } from '@agentbox/usage-view';
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
}
interface Posted {
  url: string;
  id: string;
  createdAt: string;
}
interface PastShare {
  id: string;
  url: string;
  origin: string;
  createdAt: string;
}
interface Settings {
  endpoint: string | null;
  endpointError?: string;
  shares: PastShare[];
  lastName: string | null;
}

async function api<T>(method: 'GET' | 'POST' | 'DELETE', body?: unknown, id?: string): Promise<T> {
  const r = await fetch(`/api/v1/usage/share${id ? `/${encodeURIComponent(id)}` : ''}`, {
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

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

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
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // A delete takes a public page down for good: the first click arms it.
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const today = useRef(localDay()).current;

  const refresh = useCallback(async (): Promise<Settings> => {
    const s = await api<Settings>('GET');
    setSettings(s);
    return s;
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const s = await refresh();
        if (!live) return;
        setName((n) => n || s.lastName || '');
        // The name is the share's only string: the preview swaps in the one typed.
        const p = await api<Preview>(
          'POST',
          usageShareBody(range, today, tz, subscription, '', true),
        );
        if (live) setPreview(p);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [range, tz, subscription, today, refresh]);

  const valid = name === '' || SHARE_NAME_RE.test(name);
  const shown: UsageShare | null = preview
    ? name && valid
      ? { ...preview.share, name }
      : preview.share
    : null;

  const submit = useCallback(async () => {
    if (!valid || posting) return;
    setPosting(true);
    setError(null);
    try {
      setPosted(
        await api<Posted>('POST', usageShareBody(range, today, tz, subscription, name, false)),
      );
      await refresh().catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }, [valid, posting, range, today, tz, subscription, name, refresh]);

  const remove = async (id: string): Promise<void> => {
    if (deleting) return;
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    setDeleting(id);
    setError(null);
    try {
      await api<{ id: string; deleted: boolean }>('DELETE', undefined, id);
      if (posted?.id === id) setPosted(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

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
  const past = settings?.shares ?? [];

  return (
    <Dialog onClose={onClose} className="max-w-[min(1240px,calc(100vw-48px))]">
      <div className="border-b border-border/70 px-5 pb-4 pt-5 pr-14">
        <div className="text-base font-semibold leading-tight tracking-tight">
          {posted ? 'Shared' : `Share on ${site}`}
        </div>
        <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
          {posted
            ? 'Anyone with the link can see this page. It does not change when your usage does; delete it below to take it down.'
            : 'Only the numbers below leave this hub, with the name you type if any: hours, counts, dates, and agent and provider names. No box, project, branch, pull request or session name, and no code or transcript. The page gets a random link.'}
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
        </div>
      ) : (
        <>
          <div className="max-h-[min(52vh,700px)] overflow-y-auto border-b border-border/70 bg-background">
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
            <label htmlFor="share-name" className="text-[13px] font-medium">
              Name to show <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <Input
                id="share-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().trim())}
                placeholder="your-name"
                maxLength={39}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!valid}
                aria-describedby="share-name-hint"
                className="h-9 min-w-0 flex-1 font-mono"
              />
              <Button type="submit" disabled={!valid || !preview || posting}>
                {posting ? 'Sharing…' : 'Share'}
              </Button>
            </div>
            <p
              id="share-name-hint"
              className={`mt-1.5 text-xs ${valid ? 'text-muted-foreground' : 'text-destructive'}`}
            >
              {valid
                ? 'Shown as “shared by …” on the page. Plain text, not an account: anyone can type any name.'
                : 'Lowercase letters, digits and dashes, up to 39.'}
            </p>
          </form>
        </>
      )}

      {error && (
        <p role="alert" className="px-5 pb-3 text-[13px] text-destructive">
          {error}
        </p>
      )}

      {past.length > 0 && (
        <div className="border-t border-border/70 px-5 py-4">
          <div className="text-[13px] font-medium">Shared from this hub</div>
          <ul className="mt-2 divide-y divide-border/70">
            {past.map((s) => (
              <li key={s.id} className="flex min-w-0 items-center gap-3 py-2 text-sm">
                <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">
                  {day(s.createdAt)}
                </span>
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate font-mono text-[13px] hover:underline"
                  >
                    {s.url}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground">
                    {s.id} on {host(s.origin)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={deleting !== null}
                  onClick={() => void remove(s.id)}
                  aria-label={`Delete share ${s.id}`}
                >
                  <Icons.trash />
                  {deleting === s.id ? 'Deleting…' : armed === s.id ? 'Delete for good?' : 'Delete'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <DialogFooter className="sm:hidden">
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
