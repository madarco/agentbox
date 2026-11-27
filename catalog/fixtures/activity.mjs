/* The activity ledger and the Usage page's stats on the Acme fixtures.

   GET /api/v1/activity lists `ledger` (box lifecycle, pushes, PR states), and
   GET /api/v1/usage/stats runs the real aggregation (`buildUsageStats` from
   packages/usage-view, so its dist must be built) over the same story:

   - acme.mjs's recorded SESSIONS: the boxes on the dashboard today, the ones
     destroyed this week after their PR merged, and the host sessions
     (planning, a nightly check);
   - around them, six weeks of two-week sprints at Acme, generated from a
     seeded random walk: quiet weekends, a ramp to each sprint's last
     Thursday, and a short PR per box. Their token rows join GET /usage
     (`tokenRows`), so both views count the same tokens. */
import {
  addDays,
  buildUsageStats,
  concurrency,
  dayKey,
  dayStart,
  hoursSaved,
  lanesFromSessions,
  totalMs,
  clipSpans,
} from '../../packages/usage-view/dist/index.js';
import { MACHINES, NOW, boxes as liveBoxes, sessions as recorded, usageRows } from './acme.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const today0 = NOW - (NOW % DAY);
const BACK = 45;

let seed = 20261124;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const hexOf = (n, len) => n.toString(16).padStart(len, '0').slice(-len);
let idSeq = 0x5a17;
const newId = () => hexOf((idSeq = (idSeq * 48271) % 2147483647), 12).replace(/^0/, 'c');

/* Tokens per busy hour, by agent: Claude Code lives off cache reads. */
const TOKENS_PER_HOUR = { claude: 3_400_000, codex: 2_100_000, opencode: 1_300_000 };
const REPOS = {
  'acme/storefront-web': { next: 380, provider: ['vercel', 'docker', 'docker'] },
  'acme/checkout-api': { next: 271, provider: ['hetzner', 'docker'] },
  'acme/payments-worker': { next: 388, provider: ['docker', 'e2b'] },
  'acme/docs-site': { next: 154, provider: ['docker'] },
  'acme/ios-app': { next: 96, provider: ['docker'] },
  'acme/android-app': { next: 81, provider: ['hetzner'] },
};
const TITLES = {
  'acme/storefront-web': [
    'Lazy-load product carousel images',
    'Fix hydration warning on the PDP',
    'Add Apple Pay to express checkout',
    'Move cart state to a server action',
    'Skeletons for the search results grid',
    'Locale-aware price formatting',
    'Wishlist sync across devices',
    'Drop the legacy jQuery slider',
    'Prefetch category pages on hover',
    'Store locator map clustering',
    'Gift card balance check',
    'Fix focus trap in the size picker',
    'Recently viewed products rail',
    'Compress hero images with AVIF',
    'Sticky add-to-bag bar on mobile',
    'Size guide modal per brand',
    'Fix double submit on the payment step',
    'Cache-bust the CMS banner slots',
    'Promo code field validation',
    'Back-in-stock email sign-up',
    'Breadcrumbs from the category tree',
    'Fix CLS on the product grid',
    'Saved addresses picker',
    'Order confirmation page redesign',
    'Track checkout funnel events',
    'Replace moment with date-fns',
  ],
  'acme/checkout-api': [
    'Idempotency keys on POST /orders',
    'Tax quote cache per postcode',
    'Split order totals into line items',
    'Rate-limit coupon redemption',
    'Address validation for UK postcodes',
    'Return reasons on refunds',
    'Paginate GET /orders by cursor',
    'Expire abandoned carts after 30 days',
    'Signed URLs for invoice PDFs',
    'Webhook for shipment status',
    'Currency rounding for JPY',
    'Partial captures for split shipments',
    'Fraud score on high-value orders',
    'Retry Klarna session creation',
    'OpenAPI spec for v2 orders',
    'Store credit as a payment method',
    'Fix race on concurrent coupon use',
  ],
  'acme/payments-worker': [
    'Dead-letter queue for failed captures',
    'Reconcile payouts nightly',
    'Backfill ledger entries for October',
    'SEPA mandate renewals',
    'Retry 3DS challenges once',
    'Alert on payout drift over 0.5%',
    'Move FX rates to the shared cache',
    'Batch refunds in one Stripe call',
    'Payout report CSV export',
    'Chargeback evidence upload',
    'Shard the capture queue by merchant',
    'Metrics for queue lag',
  ],
  'acme/docs-site': [
    'Versioned API reference',
    'Search across changelog entries',
    'Code tabs remember the language',
    'Fix broken anchors in the guides',
    'Dark mode for code blocks',
    'Migration guide for API v2',
    'Copy button on CLI snippets',
  ],
  'acme/ios-app': [
    'Order tracking live activity',
    'Offline cart with sync on reconnect',
    'Haptics on add to cart',
    'Apple Pay sheet on the PDP',
    'Fix crash on empty wishlist',
  ],
  'acme/android-app': [
    'Predictive back on checkout',
    'Fix ANR in the image cache',
    'Material 3 bottom sheet for filters',
    'Baseline profiles for startup',
    'Deep links to order details',
  ],
};
const AGENTS = [
  ['claude', 'work'],
  ['claude', 'work'],
  ['claude', 'work'],
  ['codex', 'team'],
  ['codex', 'personal'],
  ['opencode', 'default'],
];
const PROJECT_WEIGHT = [
  ['acme/storefront-web', 5],
  ['acme/checkout-api', 3],
  ['acme/payments-worker', 3],
  ['acme/docs-site', 1],
  ['acme/ios-app', 1],
  ['acme/android-app', 1],
];
const projectPick = () => {
  let r = rnd() * PROJECT_WEIGHT.reduce((a, [, w]) => a + w, 0);
  for (const [p, w] of PROJECT_WEIGHT) if ((r -= w) < 0) return p;
  return PROJECT_WEIGHT[0][0];
};
const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'on',
  'of',
  'in',
  'with',
  'from',
  'after',
  'by',
  'per',
  'as',
  'and',
  'over',
  'across',
  'once',
  'when',
]);
const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((w) => w && !STOP.has(w))
    .slice(0, 3)
    .join('-');

/* Sprints end on a Friday; the busiest day is the Thursday before. */
const SPRINT_END = Date.parse('2026-11-20T00:00:00Z');
function dayWeight(dayMs) {
  const dow = new Date(dayMs).getUTCDay();
  if (dow === 0 || dow === 6) return rnd() < 0.3 ? 0.12 : 0;
  const intoSprint = ((((dayMs - SPRINT_END) / DAY) % 14) + 14 + 13) % 14; // 0 = first Monday-ish, 13 = the Friday
  return 0.35 + 0.65 * Math.pow(intoSprint / 13, 1.6) + (rnd() - 0.5) * 0.2;
}

/* ---- the boxes and sessions ---- */
const history = []; // { box, sessions: [{ sessionId, agent, account, spans }] }
const spansOnDay = (dayMs, hours, { from = dayMs + 8 * HOUR, to = dayMs + 19 * HOUR } = {}) => {
  const n = Math.max(1, Math.round(hours / 1.3));
  const out = [];
  let left = hours * HOUR;
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? left : (left / (n - i)) * (0.6 + rnd() * 0.8);
    left -= len;
    const slot = (to - from) / n;
    const start = from + slot * i + rnd() * Math.max(0, slot - len);
    out.push({ start: Math.round(start), end: Math.round(Math.min(to, start + len)) });
  }
  return out;
};

/* Generated history: boxes that started before today (the last 8 days add to the recorded ones). */
for (let ago = BACK; ago >= 0; ago--) {
  const dayMs = today0 - ago * DAY;
  const w = Math.max(0, dayWeight(dayMs));
  /* Today: a few boxes that merged their PR this morning and are gone. */
  const fresh = ago === 0 ? 6 : Math.round((w * 3.2 + rnd() * 0.8 - 0.3) * (ago <= 8 ? 0.6 : 1));
  for (let i = 0; i < fresh; i++) {
    const repo = projectPick();
    if (!TITLES[repo].length) continue;
    const title = TITLES[repo].splice(Math.floor(rnd() * TITLES[repo].length), 1)[0];
    const [agent, account] = pick(AGENTS);
    const days = [];
    for (let d = 0, len = 1 + Math.floor(rnd() * 3); d < len && ago - d >= 0; d++) {
      const dm = dayMs + d * DAY;
      if ([0, 6].includes(new Date(dm).getUTCDay())) continue;
      days.push(dm);
    }
    if (!days.length) continue;
    const box = {
      id: newId(),
      name: slug(title),
      title,
      repo,
      agent,
      account,
      provider: pick(REPOS[repo].provider),
      start: days[0] + (8 + rnd() * 3) * HOUR,
    };
    /* Today's work stops by mid-morning: those boxes are done before NOW. */
    const dayEnd = (dm) => (dm === today0 ? dm + 12.5 * HOUR : dm + 19 * HOUR);
    const spans = days.flatMap((dm, k) =>
      spansOnDay(dm, Math.min((2.2 + rnd() * 3.8) * (0.6 + w * 0.6), dm === today0 ? 3 : 24), {
        from: k === 0 ? box.start : dm + 8 * HOUR,
        to: dayEnd(dm),
      }),
    );
    box.end = Math.max(...spans.map((s) => s.end)) + (10 + rnd() * 40) * MIN;
    box.merged = rnd() < 0.86 ? box.end - 5 * MIN : null;
    box.pr = REPOS[repo].next++;
    history.push({ box, sessions: [{ sessionId: `${agent}:${box.id}-s`, agent, account, spans }] });
  }
}

/* The last 8 days: acme.mjs's recorded sessions, at about 30 responses an hour. */
const liveByName = Object.fromEntries(
  liveBoxes.filter((b) => b.name && !b.id.startsWith('job:')).map((b) => [b.name, b]),
);
const RECENT_MERGE = {
  'refund-api': 5,
  'stripe-sdk-v17': 5,
  'sitemap-split': 4,
  'eu-vat-rules': 1,
  'ios-push-tokens': 3,
  'anr-crash': 1,
  'release-1-14': 12,
  'ledger-backfill': 18,
  'a11y-pass': 25,
};
const RECENT_PROVIDER = {
  'refund-api': 'hetzner',
  'stripe-sdk-v17': 'docker',
  'sitemap-split': 'vercel',
  'eu-vat-rules': 'hetzner',
  'ios-push-tokens': 'docker',
  'anr-crash': 'hetzner',
  'release-1-14': 'docker',
  'ledger-backfill': 'docker',
  'a11y-pass': 'vercel',
};
const hostSessions = [];
for (const s of recorded) {
  const spans = [];
  for (const [ago, responses] of s.days) {
    const hours = responses / 30;
    const dm = today0 - ago * DAY;
    if (ago === 0) {
      const live = s.box && liveByName[s.box];
      const born = live ? live.createdAt : dm + 8 * HOUR;
      const idle = live && live.agentStatus?.[live.agent]?.state === 'idle';
      const end = idle ? live.lastActivity : NOW;
      spans.push(
        ...spansOnDay(dm, Math.min(hours, ((end - born) / HOUR) * 0.85), {
          from: Math.max(born, dm + 8 * HOUR),
          to: end,
        }),
      );
    } else spans.push(...spansOnDay(dm, hours));
  }
  const session = { sessionId: s.session, agent: s.agent, account: s.account.split('/')[1], spans };
  if (!s.box) {
    hostSessions.push(session);
    continue;
  }
  let h = history.find((x) => x.box.name === s.box);
  if (!h) {
    const live = liveByName[s.box];
    const repo = s.project;
    const box = live
      ? {
          id: live.id,
          name: live.name,
          title: live.task,
          repo,
          agent: live.agent,
          account: s.account.split('/')[1],
          provider: live.provider,
          start: live.createdAt,
          live,
          managerId: live.managerId,
        }
      : {
          id: s.boxId,
          name: s.box,
          title: s.title,
          repo,
          agent: s.agent,
          account: s.account.split('/')[1],
          provider: RECENT_PROVIDER[s.box] ?? 'docker',
          start: Math.min(...spans.map((x) => x.start)) - 12 * MIN,
        };
    if (!live) {
      box.end = Math.max(...spans.map((x) => x.end)) + 25 * MIN;
      box.merged = RECENT_MERGE[s.box] !== undefined ? box.end - 6 * MIN : null;
      box.pr = REPOS[repo].next++;
    }
    h = { box, sessions: [] };
    history.push(h);
  }
  h.sessions.push(session);
}
/* A live box's PR (acme.mjs) keeps its number. */
for (const h of history) if (h.box.live?.pr) h.box.pr = h.box.live.pr.number;

/* ---- the ledger ---- */
export const ledger = [];
const ev = (type, at, b, extra = {}) =>
  ledger.push({
    id: `${type}:${b.id}:${at}`,
    type,
    at: new Date(Math.round(at)).toISOString(),
    actor: type.startsWith('pr.') ? 'github' : type === 'git.push' ? 'box' : 'human',
    boxId: b.id,
    boxName: b.name,
    provider: b.provider,
    agent: b.agent,
    account: `${b.agent}/${b.account}`,
    repoUrl: `https://github.com/${b.repo}.git`,
    projectKey: `github.com/${b.repo}`,
    ...(b.managerId ? { managerId: b.managerId, workspaceId: 'fx-commerce' } : {}),
    branch: b.live?.branch ?? `agentbox/${b.name}`,
    source: 'live',
    ...extra,
  });
for (const { box: b, sessions } of history) {
  const jobId = `job-${b.id.slice(0, 6)}`;
  ev('box.created', b.start - 2 * MIN, b, { jobId });
  ev('box.ready', b.start, b, { jobId });
  const spans = sessions.flatMap((s) => s.spans).sort((x, y) => x.start - y.start);
  /* Pushes: after about every second busy span, a few commits. */
  spans.forEach((sp, i) => {
    if (i % 2 === 1 || i === spans.length - 1) {
      const commits = 1 + Math.floor(rnd() * 4);
      const additions = commits * (18 + Math.floor(rnd() * 90));
      ev('git.push', sp.end + 2 * MIN, b, {
        commits,
        filesChanged: 1 + Math.floor(rnd() * 6),
        additions,
        deletions: Math.floor(additions * (0.1 + rnd() * 0.5)),
      });
    }
  });
  /* Overnight the box pauses; it resumes on the next busy span. */
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start - spans[i - 1].end > 10 * HOUR) {
      ev('box.paused', spans[i - 1].end + 30 * MIN, b, { actor: 'autopause' });
      ev('box.resumed', spans[i].start - 3 * MIN, b);
    }
  }
  if (b.pr && (b.merged || b.live?.pr)) {
    const pr = { repo: b.repo, number: b.pr, url: `https://github.com/${b.repo}/pull/${b.pr}` };
    const opened = b.merged
      ? b.merged - (40 + rnd() * 200) * MIN
      : Math.min(spans[spans.length - 1].end, NOW - 50 * MIN);
    const openedAt = Math.min(Math.max(b.start + 20 * MIN, opened), NOW - 30 * MIN);
    ev('pr.opened', openedAt, b, { pr });
    if (b.live?.pr?.state === 'ready')
      ev('pr.ready', Math.min(openedAt + 20 * MIN, NOW - 10 * MIN), b, { pr });
    if (b.merged) ev('pr.merged', b.merged, b, { pr });
  }
  if (b.live) {
    if (b.live.status === 'paused')
      ev('box.paused', Math.min(b.live.lastActivity + 5 * MIN, NOW - MIN), b, {
        actor: 'autopause',
      });
    if (b.live.status === 'stopped')
      ev('box.stopped', Math.min(b.live.lastActivity + 5 * MIN, NOW - MIN), b);
  } else ev('box.destroyed', b.end, b);
}
/* The create that failed this morning (acme.mjs's refund-limits). */
for (const j of liveBoxes.filter((b) => b.id.startsWith('job:'))) {
  ledger.push({
    id: `box.created:${j.id}`,
    type: 'box.created',
    at: new Date(j.createdAt).toISOString(),
    actor: 'manager',
    boxName: j.name,
    jobId: j.id.slice(4),
    provider: j.provider,
    agent: j.agent,
    projectKey: `github.com/acme/${j.repo}`,
    source: 'live',
  });
  if (j.status === 'error')
    ledger.push({
      id: `box.failed:${j.id}`,
      type: 'box.failed',
      at: new Date(j.createdAt + 50_000).toISOString(),
      actor: 'hub',
      boxName: j.name,
      jobId: j.id.slice(4),
      provider: j.provider,
      agent: j.agent,
      projectKey: `github.com/acme/${j.repo}`,
      source: 'live',
    });
}
ledger.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
const atMs = (e) => Date.parse(e.at);
/* Each box's rows up to NOW, and its pushed line totals: read per request. */
const rowsByBox = new Map();
for (const e of ledger) {
  if (!e.boxId || atMs(e) > NOW) continue;
  rowsByBox.set(e.boxId, [...(rowsByBox.get(e.boxId) ?? []), e]);
}
const linesOf = (boxId) =>
  (rowsByBox.get(boxId) ?? [])
    .filter((x) => x.type === 'git.push')
    .reduce(
      (a, x) => ({ additions: a.additions + x.additions, deletions: a.deletions + x.deletions }),
      { additions: 0, deletions: 0 },
    );

/* A box's running time: from ready or resumed to paused, stopped or destroyed. */
const UP = new Set(['box.ready', 'box.resumed', 'box.started']);
const DOWN = new Set(['box.paused', 'box.stopped', 'box.destroyed']);
function runsOf(b) {
  const runs = [];
  let up = null;
  for (const e of rowsByBox.get(b.id) ?? []) {
    if (UP.has(e.type) && up === null) up = atMs(e);
    if (DOWN.has(e.type) && up !== null) {
      runs.push({ boxId: b.id, provider: b.provider, start: up, end: atMs(e) });
      up = null;
    }
  }
  if (up !== null) runs.push({ boxId: b.id, provider: b.provider, start: up, end: NOW });
  return runs;
}

/* ---- GET /api/v1/activity ---- */
export function activity(q) {
  const t = (raw) => {
    const rel = /^(\d+)([mhdw])$/.exec(raw);
    return rel
      ? NOW - Number(rel[1]) * { m: MIN, h: HOUR, d: DAY, w: 7 * DAY }[rel[2]]
      : Date.parse(raw);
  };
  const since = q.get('since') ? t(q.get('since')) : -Infinity;
  const until = q.get('until') ? t(q.get('until')) : Infinity;
  const types = (q.get('type') || '').split(',').filter(Boolean);
  const limit = Number(q.get('limit') || 1000);
  let rows = ledger.filter(
    (e) =>
      atMs(e) >= since &&
      atMs(e) < until &&
      atMs(e) <= NOW &&
      (!types.length || types.includes(e.type)) &&
      (!q.get('box') || e.boxId === q.get('box')),
  );
  rows = q.get('order') === 'desc' ? rows.slice(-limit) : rows.slice(0, limit);
  return {
    since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    until: Number.isFinite(until) ? new Date(until).toISOString() : null,
    events: rows,
    truncated: rows.length === limit,
  };
}

/* ---- GET /api/v1/usage/stats ---- */
const RANGE_IDS = ['7d', '30d', 'month', '90d', 'year'];
export function usageStatsQuery(input) {
  /* A share body is any JSON: only strings count, as in the real route. */
  const raw = Object.fromEntries(
    Object.entries(input).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  );
  const tz = raw.tz || 'UTC';
  const today = dayKey(NOW, tz);
  const until = raw.until || today;
  const rel = /^(\d{1,4})([dw])$/.exec(raw.since || '30d');
  const since = rel
    ? addDays(until, -(Number(rel[1]) * (rel[2] === 'w' ? 7 : 1) - 1))
    : /^\d{4}-\d{2}-\d{2}$/.test(raw.since)
      ? raw.since
      : addDays(until, -29);
  const days = Math.round((Date.parse(until) - Date.parse(since)) / DAY) + 1;
  const id = RANGE_IDS.includes(raw.range)
    ? raw.range
    : days <= 7
      ? '7d'
      : days <= 31
        ? since.endsWith('-01') && since.slice(0, 7) === until.slice(0, 7)
          ? 'month'
          : '30d'
        : days <= 92
          ? '90d'
          : 'year';
  return {
    id,
    since,
    until,
    today: until < today ? until : today,
    tz,
    subscription: raw.subscription || undefined,
  };
}

export function usageStats(q) {
  const sub = q.subscription;
  const keep = (agent, account) => !sub || `${agent}/${account}` === sub;
  const lastDay = q.today < q.until ? q.today : q.until;
  const from = dayStart(q.since, q.tz);
  const to = dayStart(addDays(lastDay, 1), q.tz);
  const clipNow = (spans) =>
    spans
      .map((s) => ({ start: s.start, end: Math.min(s.end, NOW) }))
      .filter((s) => s.end > s.start);

  const sessions = [];
  const tokens = [];
  const subs = new Map();
  const boxInfo = [];
  const boxRuns = [];
  const events = [];
  const boxesOfSub = new Set();
  for (const { box: b, sessions: ss } of history) {
    const mine = ss.filter((s) => keep(s.agent, s.account));
    if (!mine.length) continue;
    boxesOfSub.add(b.id);
    boxInfo.push({
      boxId: b.id,
      name: b.name,
      project: b.repo,
      agent: b.agent,
      provider: b.provider,
      ...(b.managerId ? { managerId: b.managerId } : {}),
    });
    for (const s of mine) {
      sessions.push({
        sessionId: s.sessionId,
        boxId: b.id,
        agent: s.agent,
        provider: b.provider,
        managerId: b.managerId ?? null,
        turns: [],
        spans: clipNow(s.spans),
      });
    }
    boxRuns.push(...runsOf(b));
  }
  for (const s of hostSessions.filter((x) => keep(x.agent, x.account))) {
    sessions.push({
      sessionId: s.sessionId,
      boxId: null,
      agent: s.agent,
      provider: 'host',
      managerId: null,
      turns: [],
      spans: clipNow(s.spans),
    });
  }
  const byBox = new Map(history.map((h) => [h.box.id, h.box]));
  /* Tokens: the very rows GET /usage serves, so the Work and AI usage views agree. */
  for (const r of tokenRows()) {
    if (sub && r.account !== sub) continue;
    const n = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    const b = r.box ? byBox.get(r.box) : undefined;
    tokens.push({
      at: r.at,
      agent: r.agent,
      provider: b ? b.provider : 'host',
      project: r.project.slice('github.com/'.length),
      boxId: r.box ?? null,
      ...(r.box ? {} : { sessionId: r.session }),
      tokens: n,
    });
    if (r.at >= from && r.at < to) {
      /* The API-key account pays per token; plans include theirs. */
      const cur = subs.get(r.account) ?? {
        tokens: 0,
        cost: r.account === 'codex/personal' ? 0 : null,
      };
      cur.tokens += n;
      if (cur.cost !== null) cur.cost += n * 1.1e-6;
      subs.set(r.account, cur);
    }
  }
  for (const e of ledger) {
    if (atMs(e) > NOW || !e.boxId || !boxesOfSub.has(e.boxId)) continue;
    if (e.type === 'git.push')
      events.push({
        type: 'git.push',
        at: atMs(e),
        boxId: e.boxId,
        project: e.projectKey.slice('github.com/'.length),
        commits: e.commits,
        files: e.filesChanged,
        additions: e.additions,
        deletions: e.deletions,
      });
    if (e.type === 'pr.merged') {
      const b = byBox.get(e.boxId);
      const { additions, deletions } = linesOf(e.boxId);
      events.push({
        type: 'pr.merged',
        at: atMs(e),
        boxId: e.boxId,
        project: b.repo,
        repo: e.pr.repo,
        number: e.pr.number,
        title: b.title,
        additions,
        deletions,
      });
    }
  }

  /* The previous window of the same length, for the KPI deltas (as the hub does it). */
  const windowDays = Math.round((to - from) / DAY);
  const prevFrom = dayStart(addDays(q.since, -windowDays), q.tz);
  const c = concurrency(lanesFromSessions(sessions), prevFrom, from);
  const previous = {
    peak: c.peak,
    speedup: c.wallMs > 0 ? Math.round((c.agentMs / c.wallMs) * 100) / 100 : 0,
    hoursSaved: hoursSaved({ agentHours: c.agentMs / HOUR, wallHours: c.wallMs / HOUR }),
    prsMerged: events.filter((e) => e.type === 'pr.merged' && e.at >= prevFrom && e.at < from)
      .length,
    boxHours:
      Math.round(
        (boxRuns.reduce(
          (a, r) => a + totalMs(clipSpans([{ start: r.start, end: r.end }], prevFrom, from)),
          0,
        ) /
          HOUR) *
          10,
      ) / 10,
  };
  const live = q.until >= dayKey(NOW, q.tz);
  const running = liveBoxes.filter((b) => b.status === 'running' && boxesOfSub.has(b.id)).length;
  const reviewing = liveBoxes.filter(
    (b) => b.pr && ['open', 'ready'].includes(b.pr.state) && boxesOfSub.has(b.id),
  ).length;

  return buildUsageStats({
    range: { id: q.id, since: q.since, until: q.until, today: q.today, tz: q.tz },
    now: NOW,
    sessions,
    events,
    tokens,
    boxes: boxInfo,
    boxRuns,
    subscriptions: [...subs]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([key, s]) => ({
        agent: key.split('/')[0],
        label: key,
        tokens: Math.round(s.tokens),
        cost: s.cost === null ? null : Math.round(s.cost * 100) / 100,
      })),
    previous,
    runningNow: live ? running : 0,
    waitingReview: live ? reviewing : 0,
  });
}

/* ---- GET /api/v1/usage rows for the generated boxes (acme.mjs's usageRows has the recorded ones) ---- */
const MODEL = {
  claude: ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  codex: ['gpt-5.1-codex'],
  opencode: ['claude-sonnet-4-5'],
};
/* Shares of a response's tokens, as acme.mjs's PER_RESPONSE averages them. */
const MIX = {
  claude: {
    inputTokens: 0.0006,
    outputTokens: 0.0095,
    cacheReadTokens: 0.945,
    cacheWriteTokens: 0.0449,
  },
  codex: { inputTokens: 0.157, outputTokens: 0.0187, cacheReadTokens: 0.8243, cacheWriteTokens: 0 },
  opencode: {
    inputTokens: 0.0607,
    outputTokens: 0.0166,
    cacheReadTokens: 0.8684,
    cacheWriteTokens: 0.0543,
  },
};
const HOSTS = { studio: 'studio', laptop: 'laptop' };
let allRows = null;
/* acme.mjs's recorded rows plus the generated boxes' rows: GET /usage reads these too. */
export const tokenRows = () => (allRows ??= [...usageRows, ...generatedUsageRows(MACHINES)]);

function generatedUsageRows(machines) {
  const rows = [];
  for (const { box: b, sessions } of history) {
    if (b.live || recorded.some((r) => r.box === b.name)) continue;
    const model = MODEL[b.agent][b.id.charCodeAt(0) % MODEL[b.agent].length];
    const host =
      machines[b.provider === 'docker' && b.id.charCodeAt(1) % 2 ? HOSTS.laptop : HOSTS.studio];
    for (const s of sessions) {
      const byDay = new Map();
      for (const sp of s.spans) {
        const d = sp.start - (sp.start % DAY) + 14 * HOUR;
        byDay.set(d, (byDay.get(d) ?? 0) + (sp.end - sp.start) / HOUR);
      }
      for (const [at, hours] of byDay) {
        const total = hours * TOKENS_PER_HOUR[b.agent];
        rows.push({
          at,
          session: s.sessionId,
          title: b.title,
          agent: b.agent,
          account: `${b.agent}/${b.account}`,
          box: b.id,
          boxName: b.name,
          project: `github.com/${b.repo}`,
          projectUrl: `git@github.com:${b.repo}.git`,
          host,
          model,
          ...Object.fromEntries(
            Object.entries(MIX[b.agent]).map(([k, f]) => [k, Math.round(total * f)]),
          ),
          messages: Math.round(hours * 30),
        });
      }
    }
  }
  return rows;
}
