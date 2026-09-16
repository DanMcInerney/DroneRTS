import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hash, loadRun, safePath } from './load-run.ts';
import { correlate } from './correlate.ts';
import { evaluate } from './checks.ts';
import type { Report, Ref } from './types.ts';

export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(v => canonical(v ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function analyzerIdentity() {
  const directory = new URL('.', import.meta.url);
  const paths = (await readdir(directory)).filter(f => f.endsWith('.ts')).map(f => `scripts/audit/${f}`)
    .concat(['scripts/analysis-boundaries.ts', 'scripts/audit-run.ts', 'scripts/finalize-focused-trial.ts']).sort();
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = hash(await readFile(new URL(`../../${path}`, directory)));
  return { version: '1', sha256: hash(canonical(files)), files };
}
export function exitCode(report: Report): 0 | 1 | 2 { return report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2; }

export async function auditRun(directory: string, options: { closedByRunner?: boolean } = {}): Promise<Report> {
  const run = await loadRun(directory, options), joined = correlate(run), evaluated = evaluate(run, joined);
  const required = evaluated.checks.filter(c => c.required);
  const verdict = evaluated.checks.some(c => c.status === 'fail') ? 'fail' : evaluated.supported && required.length > 0
    && required.every(c => c.status === 'pass' || c.status === 'not-applicable') ? 'pass' : 'inconclusive';
  const report: Report = {
    schema: 'fleet-offline-audit/1', reportId: '', verdict,
    run: { scenario: run.result.scenario ?? null, session: run.result.sessionId ?? null, revision: run.result.revision ?? null,
      manifestSha256: run.result.manifestSha256 ?? null, rulesVersion: evaluated.header?.rulesVersion ?? null,
      replayProtocol: evaluated.header?.protocol ?? null, observationProtocols: [...new Set(joined.bundles.map(b => b.body.protocol))].sort(),
      roster: evaluated.roster, trialWallSeconds: run.result.seconds ?? null, startedAt: run.result.startedAt ?? null, completedAt: run.result.completedAt ?? null },
    analyzer: await analyzerIdentity(), inputs: run.inputs,
    coverage: { issues: run.issues, joins: joined.issues, clockAnomalies: evaluated.clockAnomalies,
      unknownAuditRecords: evaluated.unknownAudit, unknownReplayRecords: evaluated.unknownReplay,
      families: Object.fromEntries(evaluated.checks.map(c => [c.id, c.status])),
      requiredChecks: required.map(c => c.id), aggregateRule: 'Any confirmed violation fails; otherwise every required check in a supported profile must pass or be explicitly inapplicable.' },
    checks: evaluated.checks, metrics: evaluated.metrics, findings: evaluated.findings,
    limitations: ['Offline recorded evidence only; no inference, network access or archived code execution.',
      'Integrity checks do not establish perception, strategy, model understanding, autonomy or hardware readiness.',
      'Raw acquisition, assembly, submission, native completion, acknowledgement and gameplay execution are distinct boundaries.'],
  };
  report.reportId = hash(canonical({ ...report, reportId: undefined }));
  return report;
}
const label = (ref: Ref) => `${ref.file}${ref.line ? `:${ref.line}` : ''}${ref.pointer ?? ''}`;
const escape = (s: string) => s.replace(/[\r\n|]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function markdown(report: Report) {
  const lines = [`# Offline audit: ${report.verdict}`, '', `Report ID: \`${report.reportId}\``, '',
    `Scenario: ${escape(String(report.run.scenario))}. Session: ${escape(String(report.run.session))}.`, '',
    '| Check | Status | Scope |', '| --- | --- | --- |', ...report.checks.map(c => `| ${c.id} | ${c.status} | ${escape(c.summary)} |`), '',
    '## Evidence and limits', ''];
  for (const c of report.checks) {
    const measurement = escape(JSON.stringify(c.measurements));
    lines.push(`- **${c.id}**: ${measurement.slice(0, 1200)}${measurement.length > 1200 ? `… (${measurement.length - 1200} characters omitted; see JSON)` : ''}`);
    if (c.evidence.length) lines.push(`  Evidence: ${c.evidence.map(r => `\`${label(r)}\``).join(', ')}. ${c.examplesOmitted} examples omitted.`);
    if (c.limitations.length) lines.push(`  ${c.limitations.map(escape).join(' ')}`);
  }
  lines.push('', `## Error incidents (${report.findings.length})`, '');
  for (const f of report.findings.slice(0, 12)) lines.push(`- ${f.category} · ${escape(f.actor)} · ${escape(f.message).slice(0, 400)} (${f.appearances.length} appearances; ${f.appearances.slice(0, 3).map(label).join(', ')})`);
  lines.push('', `${Math.max(0, report.findings.length - 12)} incidents omitted here; JSON retains all linked appearances.`, '', ...report.limitations, '');
  return lines.join('\n');
}

/** Two atomic file replacements, with one shared ID to detect interrupted pairs. */
export async function writeReport(directory: string, report: Report) {
  const outputs = [['audit-report.json', JSON.stringify(JSON.parse(canonical(report)), null, 2) + '\n'], ['audit-report.md', markdown(report)]];
  const staged: { temporary: string; target: string }[] = [];
  try {
    for (const [name, content] of outputs) {
      const target = await safePath(directory, name), temporary = await safePath(directory, `.${name}.${randomUUID()}.tmp`);
      await writeFile(temporary, content, { flag: 'wx' }); staged.push({ target, temporary });
    }
    for (const { temporary, target } of staged) await rename(temporary, target);
  } finally { for (const { temporary } of staged) await unlink(temporary).catch(() => {}); }
}
