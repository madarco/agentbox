import { maxOf } from './aggregate.js';
import type {
  AgentId,
  DailyStats,
  GanttDayStats,
  LaneStats,
  ProviderId,
  SplitValues,
  UsageStats,
  WallDay,
} from './schema.js';

/**
 * The approved mockup's sample month (November 2026, today the 26th), rebuilt with the
 * mockup's own seeded generator so the components can be compared with it side by side.
 * Sample data only: the totals in the hero are the mockup's, not sums of the days.
 */
export function usageFixture(): UsageStats {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const TODAY = 26;
  const iso = (m: number, d: number, y = 2026): string =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const r2 = (n: number): number => Math.round(n * 100) / 100;

  const AGENTS: AgentId[] = ['claude', 'codex', 'pi', 'opencode'];
  const PROVIDERS: ProviderId[] = [
    'docker',
    'hetzner',
    'daytona',
    'vercel',
    'e2b',
    'remote-docker',
  ];
  const PROJECTS = ['agentbox', 'agentbox-tray', 'checkout-api', 'docs-site'];
  const SHARE = {
    agent: [0.74, 0.17, 0.06, 0.03],
    provider: [0.46, 0.22, 0.12, 0.09, 0.07, 0.04],
    project: [0.58, 0.2, 0.15, 0.07],
  };
  const SHAPE = [
    0, 0.05, 0.04, 0.03, 0.06, 0.09, 0.04, 0.02, 0.05, 0.08, 0.1, 0.12, 0.07, 0.05, 0.22, 0.42,
    0.38, 0.55, 0.92, 1, 0.12, 0.04, 0.03, 0.26, 0.1, 0.06, 0.03,
  ];
  const novDow = (d: number): number => new Date(Date.UTC(2026, 10, d)).getUTCDay();

  const daily: DailyStats[] = [];
  // The mockup draws 30 days (4 forecast); the forecast rows still consume the generator.
  for (let d = 1; d <= 30; d++) {
    const s = d <= TODAY ? SHAPE[d]! : 0.24;
    const tokens = Math.round(s * 32.6e6 + 0.6e6 + rnd() * 0.5e6);
    const hours = Math.round(s * 46 + 9 + rnd() * 6);
    let commits = Math.round(s * 70 + 5 + rnd() * 8 - (novDow(d) % 6 === 0 ? 3 : 0));
    let prs = Math.max(0, Math.round(s * 8.5 + rnd() * 1.4 - 0.3));
    const add = Math.round(prs * (520 + rnd() * 700));
    const del = Math.round(add * (0.18 + rnd() * 0.3));
    const peak = d === 19 ? 9 : Math.max(1, Math.min(8, Math.round(1.5 + s * 7 + rnd() * 1.5)));
    const avg = Math.min(peak, 1.1 + s * 2.6 + rnd() * 0.5);
    const split: Record<keyof typeof SHARE, number[]> = { agent: [], provider: [], project: [] };
    for (const k of Object.keys(SHARE) as (keyof typeof SHARE)[]) {
      const w = SHARE[k].map((p) => p * (0.75 + rnd() * 0.5));
      const t = w.reduce((a, b) => a + b, 0);
      split[k] = w.map((x) => x / t);
    }
    if (d > TODAY) continue;
    if (d === 19) {
      commits = 94;
      prs = 9;
    }
    const bucket = (p: number): SplitValues => ({
      tokens: Math.round(tokens * p),
      agentHours: r2(hours * p),
      commits: Math.round(commits * p),
    });
    const rec = <K extends string>(ids: readonly K[], ps: number[]): Record<K, SplitValues> =>
      Object.fromEntries(ids.map((id, i) => [id, bucket(ps[i]!)])) as Record<K, SplitValues>;
    daily.push({
      date: iso(10, d),
      tokens,
      agentHours: hours,
      wallHours: r2(hours / avg),
      boxHours: hours,
      peak,
      avgAtOnce: r2(avg),
      commits,
      prsMerged: prs,
      additions: add,
      deletions: del,
      files: Math.round(commits * 1.5),
      byAgent: rec(AGENTS, split.agent),
      byProvider: rec(PROVIDERS, split.provider),
      byProject: rec(PROJECTS, split.project),
    });
  }

  const wall: WallDay[] = [];
  const end = Date.UTC(2026, 10, 26);
  const endDow = new Date(end).getUTCDay();
  const firstBox = Date.UTC(2026, 3, 14);
  for (let t = end - (52 * 7 + endDow) * 864e5; t <= end; t += 864e5) {
    const day = new Date(t);
    const nov =
      day.getUTCMonth() === 10 && day.getUTCDate() <= TODAY ? daily[day.getUTCDate() - 1]! : null;
    let v = 0;
    if (t >= firstBox) {
      const age = (t - firstBox) / 864e5;
      const ramp = Math.min(1, 0.25 + age / 150);
      const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
      const off = rnd() < (weekend ? 0.42 : 0.08);
      v = off ? 0 : Math.round((weekend ? 6 : 14) * ramp * (0.4 + rnd() * 1.6) + rnd() * 4);
      if (nov) v = Math.round(nov.commits * 0.9 + nov.prsMerged * 2);
    }
    const commits = Math.round(v * 0.86);
    const peak = nov ? nov.peak : v ? Math.max(1, Math.min(7, Math.round(v / 9 + rnd() * 1.5))) : 0;
    const prs = Math.round(v / 14 + (v > 0 && rnd() < 0.3 ? 1 : 0));
    const hours = v ? Math.round(v * 0.8 + 3 + rnd() * 4) : 0;
    const tokens = Math.round(v * (0.24e6 + rnd() * 0.2e6));
    wall.push({
      date: iso(day.getUTCMonth(), day.getUTCDate(), day.getUTCFullYear()),
      all: v,
      peak,
      commits,
      prs,
      agentHours: hours,
      tokens,
    });
  }

  // [box, agent, provider, intervals, PR]
  type L = [string, AgentId, ProviderId, [number, number][], string | null];
  const DAY19: L[] = [
    ['fix-account-switch', 'claude', 'hetzner', [[8.5, 15.2]], 'agentbox#486'],
    [
      'tray-approvals',
      'codex',
      'docker',
      [
        [9.0, 12.4],
        [13.1, 17.8],
      ],
      'agentbox-tray#92',
    ],
    ['skills-upload', 'claude', 'daytona', [[10.2, 16.5]], 'agentbox#483'],
    ['hub-usage-page', 'claude', 'docker', [[11.0, 19.3]], 'agentbox#488'],
    ['fix-webhooks', 'opencode', 'vercel', [[12.5, 16.0]], 'checkout-api#58'],
    ['brand-icons', 'claude', 'e2b', [[13.4, 15.9]], 'agentbox#484'],
    ['docs-search', 'claude', 'e2b', [[14.0, 18.6]], null],
    ['node-pty-bundle', 'claude', 'docker', [[14.6, 16.2]], 'agentbox#487'],
    [
      'box-list-status',
      'codex',
      'hetzner',
      [
        [15.0, 17.4],
        [18.0, 20.4],
      ],
      'agentbox#485',
    ],
    ['timeline-lanes', 'claude', 'daytona', [[15.3, 17.0]], null],
    ['e2e-run', 'claude', 'remote-docker', [[17.5, 23.8]], null],
    ['release-notes', 'pi', 'docker', [[19.0, 21.2]], 'agentbox#489'],
    ['night-refactor', 'claude', 'hetzner', [[21.5, 26.0]], null],
  ];
  const DAY18: L[] = DAY19.filter((_, i) => i % 4 !== 3).map((l, i) => [
    l[0],
    l[1],
    l[2],
    l[3].map(([a, b]) => [a - 1 + (i % 3) * 0.6, b - 1.4 + (i % 2)] as [number, number]),
    i % 3 === 1 ? null : l[4],
  ]);
  const DAY16: L[] = DAY19.filter((_, i) => i % 2 === 0).map((l, i) => [
    l[0],
    l[1],
    l[2],
    l[3].map(([a, b]) => [a + i * 0.9, a + i * 0.9 + (b - a) * 0.7] as [number, number]),
    i % 2 ? l[4] : null,
  ]);
  const lanes = (ls: L[]): LaneStats[] =>
    ls.map(([box, agent, provider, intervals, pr]) => ({ box, agent, provider, intervals, pr }));
  const gantt: GanttDayStats[] = [
    { date: '2026-11-19', lanes: lanes(DAY19) },
    { date: '2026-11-18', lanes: lanes(DAY18) },
    { date: '2026-11-16', lanes: lanes(DAY16) },
  ];

  // The mockup's punchcard rows run Mon..Sun; UsageStats indexes by weekday, 0 = Sunday.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const raw = order.map((dow) =>
    Array.from({ length: 24 }, (_, h) => {
      const dayPart = h >= 9 && h <= 19 ? 1 : h >= 20 || h <= 1 ? 0.55 : 0.32;
      const wk = dow === 0 || dow === 6 ? 0.35 : 1;
      return Math.max(0, dayPart * wk * (0.6 + rnd() * 0.8));
    }),
  );
  const max = maxOf(raw.flat());
  const punchcard: number[][] = Array.from({ length: 7 }, () => []);
  order.forEach((dow, ri) => {
    punchcard[dow] = raw[ri]!.map((v) => Math.round((v / max) * 90) / 10);
  });

  return {
    version: 1,
    generatedAt: '2026-11-26T15:30:00.000Z',
    range: {
      id: 'month',
      since: '2026-11-01',
      until: '2026-11-30',
      today: '2026-11-26',
      tzOffset: 60,
    },
    hero: {
      agentHours: 612,
      wallHours: 211,
      speedup: 2.9,
      peakAtOnce: 9,
      peakDate: '2026-11-19',
      parallelHours: 401,
      maxPrsInSession: 6,
      sessionsWith3Plus: 14,
      streakDays: 19,
      prsMerged: 47,
      commits: 812,
      additions: 38214,
      deletions: 11402,
      files: 1204,
      boxes: 64,
      bestDayPrs: 9,
      bestDayCommits: 94,
      biggestPrAdditions: 1842,
    },
    kpis: {
      peak: { value: 9, delta: 4, runningNow: 4 },
      speedup: { value: 2.9, delta: 0.8 },
      prs: { value: 47, delta: 9, waitingReview: 3 },
      boxHours: { value: 612, deltaPct: 24, boxes: 64, tokens: 126.4e6 },
    },
    daily,
    wall,
    streaks: {
      current: 19,
      best: 23,
      activeDays: 187,
      daysSinceFirst: 226,
      firstDate: '2026-04-14',
      busiestWeekday: 3,
      busiestWeekdayShare: 0.28,
      bestDay: { date: '2026-11-19', commits: 94 },
    },
    gantt,
    sessions: [
      {
        title: 'Subscriptions: switch at the limit',
        project: 'agentbox',
        agent: 'claude',
        provider: 'hetzner',
        boxes: 11,
        peak: 6,
        prsMerged: 6,
        minutes: 580,
      },
      {
        title: 'Tray v3 redesign',
        project: 'agentbox-tray',
        agent: 'codex',
        provider: 'docker',
        boxes: 8,
        peak: 5,
        prsMerged: 4,
        minutes: 425,
      },
      {
        title: 'Release e2e fixes',
        project: 'agentbox',
        agent: 'claude',
        provider: 'remote-docker',
        boxes: 6,
        peak: 6,
        prsMerged: 2,
        minutes: 190,
      },
      {
        title: 'Skills in the hub, phase 2',
        project: 'agentbox',
        agent: 'claude',
        provider: 'daytona',
        boxes: 7,
        peak: 4,
        prsMerged: 4,
        minutes: 680,
      },
      {
        title: 'Webhook hardening',
        project: 'checkout-api',
        agent: 'opencode',
        provider: 'vercel',
        boxes: 5,
        peak: 3,
        prsMerged: 3,
        minutes: 270,
      },
    ],
    punchcard,
    providers: [
      { id: 'docker', note: 'this Mac', hours: 282, boxes: 31 },
      { id: 'hetzner', note: 'cx23 · nbg1', hours: 134, boxes: 12 },
      { id: 'daytona', note: 'cloud', hours: 74, boxes: 8 },
      { id: 'vercel', note: 'sandbox', hours: 55, boxes: 6 },
      { id: 'e2b', note: 'sandbox', hours: 43, boxes: 5 },
      { id: 'remote-docker', note: 'devbox', hours: 24, boxes: 2 },
    ],
    feed: [
      {
        title: 'Switch a box’s agent to another account at the limit',
        repo: 'agentbox',
        number: 486,
        box: 'fix-account-switch',
        agent: 'claude',
        provider: 'hetzner',
        additions: 1842,
        deletions: 311,
        mergedAt: '2026-11-26T13:30:00.000Z',
      },
      {
        title: 'Keep node-pty external in the standalone bundle',
        repo: 'agentbox',
        number: 487,
        box: 'hub-pty',
        agent: 'claude',
        provider: 'docker',
        additions: 38,
        deletions: 12,
        mergedAt: '2026-11-26T12:30:00.000Z',
      },
      {
        title: 'Approval cards with a proper Details window',
        repo: 'agentbox-tray',
        number: 92,
        box: 'tray-approvals',
        agent: 'codex',
        provider: 'docker',
        additions: 611,
        deletions: 140,
        mergedAt: '2026-11-26T10:30:00.000Z',
      },
      {
        title: 'Store a skill upload only when it arrived whole',
        repo: 'agentbox',
        number: 483,
        box: 'skills-upload',
        agent: 'claude',
        provider: 'daytona',
        additions: 247,
        deletions: 88,
        mergedAt: '2026-11-25T16:00:00.000Z',
      },
      {
        title: 'Retry webhook deliveries with backoff',
        repo: 'checkout-api',
        number: 58,
        box: 'fix-webhooks',
        agent: 'opencode',
        provider: 'vercel',
        additions: 402,
        deletions: 36,
        mergedAt: '2026-11-25T11:00:00.000Z',
      },
      {
        title: 'Real agent brand icons in the box list',
        repo: 'agentbox',
        number: 484,
        box: 'brand-icons',
        agent: 'claude',
        provider: 'e2b',
        additions: 129,
        deletions: 74,
        mergedAt: '2026-11-24T09:00:00.000Z',
      },
    ],
    feedTotal: 47,
    boxes: [
      {
        name: 'fix-account-switch',
        project: 'agentbox',
        agent: 'claude',
        provider: 'hetzner',
        hours: 71,
        tokens: 18.2e6,
        prs: 6,
        additions: 6120,
        deletions: 1210,
      },
      {
        name: 'tray-approvals',
        project: 'agentbox-tray',
        agent: 'codex',
        provider: 'docker',
        hours: 58,
        tokens: 9.1e6,
        prs: 5,
        additions: 4380,
        deletions: 960,
      },
      {
        name: 'skills-upload',
        project: 'agentbox',
        agent: 'claude',
        provider: 'daytona',
        hours: 49,
        tokens: 14.6e6,
        prs: 4,
        additions: 3912,
        deletions: 1544,
      },
      {
        name: 'fix-webhooks',
        project: 'checkout-api',
        agent: 'opencode',
        provider: 'vercel',
        hours: 44,
        tokens: 5.3e6,
        prs: 4,
        additions: 2980,
        deletions: 402,
      },
      {
        name: 'hub-usage-page',
        project: 'agentbox',
        agent: 'claude',
        provider: 'docker',
        hours: 38,
        tokens: 11.9e6,
        prs: 3,
        additions: 2641,
        deletions: 733,
      },
      {
        name: 'docs-search',
        project: 'docs-site',
        agent: 'claude',
        provider: 'e2b',
        hours: 27,
        tokens: 4.4e6,
        prs: 3,
        additions: 1870,
        deletions: 512,
      },
    ],
    projects: [
      { name: 'agentbox', prs: 31, commits: 512, additions: 22400 },
      { name: 'agentbox-tray', prs: 9, commits: 168, additions: 8100 },
      { name: 'checkout-api', prs: 5, commits: 92, additions: 5200 },
      { name: 'docs-site', prs: 2, commits: 40, additions: 2500 },
    ],
    subscriptions: [
      { agent: 'claude', label: 'personal · max', tokens: 93.5e6, cost: null },
      { agent: 'claude', label: 'work · max', tokens: 21.5e6, cost: null },
      { agent: 'codex', label: 'personal · pro', tokens: 8.6e6, cost: null },
      { agent: 'opencode', label: 'API key', tokens: 2.8e6, cost: 31.4 },
    ],
  };
}
