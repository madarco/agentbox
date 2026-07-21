'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Claude re-login sub-state surfaced on the create job (see JobLoginView / QueueJobLogin).
export interface JobLoginState {
  required: boolean;
  phase: 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'error';
  url?: string;
  error?: string;
  lastError?: string;
}

// Streams a create job's log via the per-job SSE route into a scrolling panel.
// Read-only — this is the create/build log, not an interactive agent terminal.
// When the worker needs a Claude re-login it emits a `login` event; we render a
// banner (clickable sign-in link + code input) above the verbatim log.
export function JobLogStream({
  jobId,
  endpoint,
  onDone,
  onStatus,
  onLogin,
}: {
  jobId: string;
  // SSE route to tail. Defaults to the internal same-origin route (used by the
  // create modal). The Providers settings UI passes the public `/api/v1/...`
  // route so it stays a pure REST client (works unchanged when the hub is remote).
  endpoint?: string;
  onDone?: (status: string) => void;
  // Fired with 'streaming' on (re)connect and the terminal status on end, so the
  // parent can render a live working/done indicator in the modal header.
  onStatus?: (status: string) => void;
  // Fired when the Claude re-login sub-state changes (for the header badge).
  onLogin?: (login: JobLoginState | null) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [login, setLogin] = useState<JobLoginState | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  // Keep the latest callbacks in refs so the EventSource effect depends ONLY on
  // jobId. Callers pass a fresh `() => router.refresh()` each render, and
  // dashboard refreshes (LiveRefresh / queue onStatusChange) re-render this
  // component mid-stream — if a callback were an effect dep, the stream would
  // tear down and reopen from offset 0, replaying and duplicating the whole tail.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onLoginRef = useRef(onLogin);
  onLoginRef.current = onLogin;

  useEffect(() => {
    onStatusRef.current?.('streaming');
    const url = endpoint ?? `/api/jobs/${encodeURIComponent(jobId)}/logs`;
    const es = new EventSource(url);
    es.addEventListener('log', (e) => {
      const line = JSON.parse((e as MessageEvent).data) as string;
      setLines((prev) => [...prev, line]);
    });
    es.addEventListener('login', (e) => {
      const state = JSON.parse((e as MessageEvent).data) as JobLoginState;
      setLogin(state);
      onLoginRef.current?.(state);
    });
    es.addEventListener('end', (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as { status: string };
      onStatusRef.current?.(payload.status);
      onDoneRef.current?.(payload.status);
      es.close();
    });
    // EventSource auto-reconnects on transient errors; nothing to do here.
    return () => es.close();
  }, [jobId, endpoint]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="flex flex-col gap-3">
      {login && login.phase !== 'done' ? <LoginBanner jobId={jobId} login={login} /> : null}
      <pre
        ref={preRef}
        className="max-h-[440px] min-h-[220px] overflow-auto whitespace-pre rounded-lg bg-[#16181c] p-3 font-mono text-[11.5px] leading-relaxed text-[#d6d9de]"
      >
        {lines.length === 0 ? 'starting…' : lines.join('\n')}
      </pre>
    </div>
  );
}

// The Claude re-login prompt. Shows the clickable OAuth link and a field to paste
// the approval code back (claude.ai's flow isn't link-only). Posts the code to the
// public API; the create worker consumes it and continues the box create.
function LoginBanner({ jobId, login }: { jobId: string; login: JobLoginState }) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const exchanging = login.phase === 'exchanging';

  const submit = async (): Promise<void> => {
    const trimmed = code.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/login-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setSubmitError(body?.error?.message ?? `request failed (${res.status})`);
        return;
      }
      setCode('');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="text-sm font-semibold text-amber-200">Claude login required</div>
      <p className="text-xs text-amber-100/80">
        Your saved Claude login is expired. Open the sign-in page, approve access, then paste the code Claude
        shows you.
      </p>
      {login.url ? (
        <a
          href={login.url}
          target="_blank"
          rel="noreferrer"
          className="w-fit rounded-md bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-100 underline decoration-amber-400/50 underline-offset-2 hover:bg-amber-500/30"
        >
          Open Claude sign-in ↗
        </a>
      ) : (
        <span className="text-xs text-amber-100/60">waiting for the sign-in link…</span>
      )}
      <div className="mt-1 flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="Paste approval code"
          disabled={exchanging}
          className="flex-1 font-mono text-xs"
        />
        <Button type="button" onClick={() => void submit()} disabled={!code.trim() || submitting || exchanging}>
          {exchanging ? 'Verifying…' : submitting ? 'Submitting…' : 'Submit'}
        </Button>
      </div>
      {login.lastError ? <p className="text-xs text-amber-300">{login.lastError}</p> : null}
      {login.phase === 'error' && login.error ? (
        <p className="text-xs text-red-400">{login.error}</p>
      ) : null}
      {submitError ? <p className="text-xs text-red-400">{submitError}</p> : null}
    </div>
  );
}
