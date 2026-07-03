'use client';

import { useEffect, useRef, useState } from 'react';

// Streams a create job's log via the per-job SSE route into a scrolling panel.
// Read-only — this is the create/build log, not an interactive agent terminal.
export function JobLogStream({ jobId, onDone }: { jobId: string; onDone?: (status: string) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<string>('streaming');
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/logs`);
    es.addEventListener('log', (e) => {
      const line = JSON.parse((e as MessageEvent).data) as string;
      setLines((prev) => [...prev, line]);
    });
    es.addEventListener('end', (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as { status: string };
      setStatus(payload.status);
      onDone?.(payload.status);
      es.close();
    });
    // EventSource auto-reconnects on transient errors; nothing to do here.
    return () => es.close();
  }, [jobId, onDone]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div>
      <pre
        ref={preRef}
        className="max-h-[320px] min-h-[160px] overflow-auto rounded-lg bg-[#16181c] p-3 font-mono text-[11.5px] leading-relaxed text-[#d6d9de]"
      >
        {lines.length === 0 ? 'starting…' : lines.join('\n')}
      </pre>
      <div className="mt-2 font-mono text-xs text-muted-foreground">
        {status === 'streaming'
          ? 'creating — the box + agent start in the background; you can close this.'
          : `job ${status}`}
      </div>
    </div>
  );
}
