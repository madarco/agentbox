'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Subscribes to the /api/events SSE stream and calls router.refresh() on each
// message so the force-dynamic dashboard layout re-reads box state + approvals.
// `change` events (approvals, hub-initiated lifecycle) push instantly; the 15s
// `ping` heartbeat catches box changes made outside the hub. Refreshes are
// debounced and paused while the tab is hidden. EventSource reconnects natively.
export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (): void => {
      if (document.hidden) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 250);
    };

    const es = new EventSource('/api/events');
    es.addEventListener('change', refresh);
    es.addEventListener('ping', refresh);

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, [router]);

  return null;
}
