'use client';

import { useEffect, useState } from 'react';
import { fmtAgo } from '@/lib/boxes/format';

// Hydration-safe relative time. Server + first client render show a stable
// absolute date (no Date.now()); after mount we swap to live "Xm ago".
export function Ago({ ms }: { ms: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <span suppressHydrationWarning>{mounted ? fmtAgo(ms) : new Date(ms).toLocaleDateString()}</span>;
}
