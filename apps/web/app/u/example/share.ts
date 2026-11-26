import { toShare, usageFixture } from '@agentbox/usage-view';
import type { UsageShare } from '@agentbox/usage-view';

/** The design fixture as a public share: the demo page, and the OG check without a database. */
export const exampleShare = (): UsageShare => toShare(usageFixture(), 'example');
