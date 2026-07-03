'use client';

import { useEffect, useRef, useState } from 'react';

// Streams a create job's log via the per-job SSE route into a scrolling panel.
// Read-only — this is the create/build log, not an interactive agent terminal.
export function JobLogStream({
  jobId,
  onDone,
  onStatus,
}: {
  jobId: string;
  onDone?: (status: string) => void;
  // Fired with 'streaming' on (re)connect and the terminal status on end, so the
  // parent can render a live working/done indicator in the modal header.
  onStatus?: (status: string) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
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

  useEffect(() => {
    onStatusRef.current?.('streaming');
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/logs`);
    es.addEventListener('log', (e) => {
      const line = JSON.parse((e as MessageEvent).data) as string;
      setLines((prev) => [...prev, line]);
    });
    es.addEventListener('end', (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as { status: string };
      onStatusRef.current?.(payload.status);
      onDoneRef.current?.(payload.status);
      es.close();
    });
    // EventSource auto-reconnects on transient errors; nothing to do here.
    return () => es.close();
  }, [jobId]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      ref={preRef}
      className="max-h-[440px] min-h-[220px] overflow-auto whitespace-pre rounded-lg bg-[#16181c] p-3 font-mono text-[11.5px] leading-relaxed text-[#d6d9de]"
    >
      {lines.length === 0 ? 'starting…' : lines.join('\n')}
    </pre>
  );
}
