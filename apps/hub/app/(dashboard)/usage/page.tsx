'use client';

// /usage: the usage dashboard (`UsageView` over /api/v1/usage/stats), and at
// `?view=tokens` the token breakdown over /api/v1/usage. Both keep
// `?subscription=` (the Subscriptions cards link here with it). The tray opens
// this URL from its header pill: keep it stable.

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { TokenUsage } from './token-usage';
import { UsageDashboard } from './usage-dashboard';

// useSearchParams needs a Suspense boundary for the static build.
export default function UsagePage() {
  return (
    <Suspense fallback={null}>
      <UsageRoutes />
    </Suspense>
  );
}

function UsageRoutes() {
  const params = useSearchParams();
  // Switching views keeps the subscription filter and the dashboard's range.
  const keep = new URLSearchParams();
  for (const k of ['subscription', 'range']) {
    const v = params.get(k)?.trim();
    if (v) keep.set(k, v);
  }
  const rest = keep.toString();
  if (params.get('view') === 'tokens') {
    return <TokenUsage overviewHref={rest ? `/usage?${rest}` : '/usage'} />;
  }
  return <UsageDashboard tokensHref={`/usage?view=tokens${rest ? `&${rest}` : ''}`} />;
}
