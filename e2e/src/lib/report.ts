import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScenarioResult, StepResult, StepStatus } from './runner.js';

export interface RunSummary {
  runId: string;
  sha: string;
  branch: string;
  cliVersion: string;
  startedAt: string;
  finishedAt: string;
  targets: string[];
  scenarios: string[];
  ok: boolean;
  results: ScenarioResult[];
  sweep: Array<{ target: string; leaks: string[] }>;
  /** Product bugs the run found, one line each (the report's headline). */
  findings: string[];
}

export function writeSummary(runDir: string, s: RunSummary): void {
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(s, null, 2)}\n`);
  writeFileSync(join(runDir, 'report.html'), renderHtml(runDir, s));
}

export function isGreen(results: ScenarioResult[]): boolean {
  return results.every((r) => r.status !== 'fail');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ICON: Record<StepStatus, string> = {
  pass: 'pass',
  fail: 'FAIL',
  skip: 'skip',
  'expected-fail': 'known',
};

function tail(runDir: string, rel: string, n = 40): string {
  const p = join(runDir, rel);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').split('\n').slice(-n).join('\n');
}

function evidenceHtml(runDir: string, rel: string): string {
  const abs = join(runDir, rel);
  if (/\.(png|jpe?g)$/i.test(rel))
    return `<img src="${esc(rel)}" alt="${esc(rel)}" loading="lazy">`;
  if (!existsSync(abs)) return `<code>${esc(rel)}</code>`;
  return `<pre>${esc(readFileSync(abs, 'utf8'))}</pre>`;
}

function stepHtml(runDir: string, st: StepResult): string {
  const judge = st.judgements
    .map(
      (j) =>
        `<li class="${j.pass ? 'pass' : 'fail'}">judge: ${esc(j.expectation)} — <em>${esc(j.reason)}</em></li>`,
    )
    .join('');
  const body = [
    st.note ? `<p class="note">${esc(st.note)}</p>` : '',
    st.error ? `<pre class="err">${esc(st.error)}</pre>` : '',
    judge ? `<ul>${judge}</ul>` : '',
    ...st.evidence.map((e) => evidenceHtml(runDir, e)),
    st.status === 'fail'
      ? `<details><summary>log tail</summary><pre>${esc(tail(runDir, st.log))}</pre></details>`
      : '',
    `<a href="${esc(st.log)}">full log</a>`,
  ].join('');
  return `<details class="step ${st.status}"${st.status === 'fail' ? ' open' : ''}><summary><span class="badge ${st.status}">${ICON[st.status]}</span> ${st.kind === 'edge' ? '<span class="edge">edge</span> ' : ''}${esc(st.name)} <span class="dur">${String(Math.round(st.durationMs / 1000))}s</span></summary><div class="body">${body}</div></details>`;
}

function renderHtml(runDir: string, s: RunSummary): string {
  const scenarioIds = [...new Set(s.results.map((r) => r.id))];
  const titles = new Map(s.results.map((r) => [r.id, r.title]));
  const cell = (target: string, id: string): ScenarioResult | undefined =>
    s.results.find((r) => r.target === target && r.id === id);

  const grid = `<table class="grid"><thead><tr><th></th>${s.targets.map((t) => `<th>${esc(t)}</th>`).join('')}</tr></thead><tbody>${scenarioIds
    .map(
      (id) =>
        `<tr><th><a href="#${id}">${esc(id.toUpperCase())}</a> ${esc(titles.get(id) ?? '')}</th>${s.targets
          .map((t) => {
            const r = cell(t, id);
            if (!r) return '<td></td>';
            const counts = r.steps.reduce<Record<string, number>>(
              (acc, st) => ({ ...acc, [st.status]: (acc[st.status] ?? 0) + 1 }),
              {},
            );
            const label =
              r.status === 'skip'
                ? 'skip'
                : `${String(counts['pass'] ?? 0)}/${String(r.steps.length)}`;
            return `<td class="${r.status}"><a href="#${id}-${t}">${label}</a></td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`;

  const sections = scenarioIds
    .map((id) => {
      const rows = s.targets
        .map((t) => cell(t, id))
        .filter((r): r is ScenarioResult => Boolean(r))
        .map(
          (r) =>
            `<section id="${id}-${r.target}"><h3><span class="badge ${r.status}">${ICON[r.status]}</span> ${esc(r.target)} <span class="dur">${String(Math.round(r.durationMs / 60000))} min</span></h3>${
              r.skipReason
                ? `<p class="note">${esc(r.skipReason)}</p>`
                : r.steps.map((st) => stepHtml(runDir, st)).join('')
            }</section>`,
        )
        .join('');
      return `<h2 id="${id}">${esc(id.toUpperCase())}. ${esc(titles.get(id) ?? '')}</h2>${rows}`;
    })
    .join('');

  const sweep = s.sweep
    .map(
      (w) =>
        `<li class="${w.leaks.length ? 'fail' : 'pass'}">${esc(w.target)}: ${w.leaks.length ? esc(w.leaks.join(', ')) : 'nothing left behind'}</li>`,
    )
    .join('');
  const findings = s.findings.length
    ? `<h2>Findings</h2><ul>${s.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentBox e2e ${esc(s.runId)}</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--pass:#1a7f37;--fail:#cf222e;--skip:#8c8c8c;--known:#9a6700;--code:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--pass:#3fb950;--fail:#f85149;--skip:#6e7681;--known:#d29922;--code:#161b22}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px}
a{color:inherit}h1{font-size:20px}h2{margin-top:32px;border-bottom:1px solid var(--line)}h3{font-size:15px;margin:16px 0 4px}
.meta{color:var(--muted)}.grid{border-collapse:collapse;width:100%;overflow-x:auto;display:block}
.grid th,.grid td{border:1px solid var(--line);padding:6px 10px;text-align:left;white-space:nowrap}
td.pass{color:var(--pass)}td.fail{color:var(--fail);font-weight:600}td.skip{color:var(--skip)}
.badge{display:inline-block;min-width:38px;text-align:center;border-radius:4px;font-size:11px;font-weight:600;padding:1px 4px;color:#fff}
.badge.pass{background:var(--pass)}.badge.fail{background:var(--fail)}.badge.skip{background:var(--skip)}.badge.expected-fail{background:var(--known)}
.step summary{cursor:pointer;padding:2px 0}.step .body{padding:4px 0 8px 46px}.dur{color:var(--muted);font-size:12px}
.edge{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:0 3px}
pre{background:var(--code);padding:8px;overflow-x:auto;font-size:12px;max-height:420px}pre.err{color:var(--fail)}
img{max-width:100%;border:1px solid var(--line)}.note{color:var(--muted);margin:2px 0}li.pass{color:var(--pass)}li.fail{color:var(--fail)}
</style></head><body>
<h1>AgentBox e2e run ${esc(s.runId)} — ${s.ok ? 'green' : 'RED'}</h1>
<p class="meta">${esc(s.branch)} @ ${esc(s.sha.slice(0, 10))} · CLI ${esc(s.cliVersion)} · ${esc(s.startedAt)} → ${esc(s.finishedAt)}</p>
${findings}${grid}<h2>Leftovers</h2><ul>${sweep}</ul>${sections}
<p class="meta">Summary: <a href="summary.json">summary.json</a> · progress: <a href="progress.log">progress.log</a> · run dir ${esc(relative(process.cwd(), runDir))}</p>
</body></html>
`;
}
