'use client';

// /usage: the work view (`UsageView` over /api/v1/usage/stats), and at
// `?view=tokens` the AI usage view (the token breakdown over /api/v1/usage). The
// header's switch flips `view` and keeps every other param, `?subscription=` (the
// Subscriptions cards link here with it) and `?range=`. The tray opens this URL
// from its header pill: keep it stable.

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { TokenUsage } from './token-usage';
import { UsageDashboard } from './usage-dashboard';
import { parseUsageView } from './usage-header';

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
  return parseUsageView(params.get('view')) === 'tokens' ? <TokenUsage /> : <UsageDashboard />;
}
