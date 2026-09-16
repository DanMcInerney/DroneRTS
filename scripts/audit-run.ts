/** Offline CLI: intentionally owns neither actors nor artifact retention. */
import { resolve } from 'node:path';
import { auditRun, exitCode, writeReport } from './audit/report.ts';

try {
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) throw new Error('Usage: node --import tsx scripts/audit-run.ts <saved-trial-directory>');
  const directory = resolve(process.argv[2]), report = await auditRun(directory);
  await writeReport(directory, report);
  process.exitCode = exitCode(report);
  console.log(`${report.verdict}: ${report.checks.filter(c => c.status === 'fail').length} failed, ${report.checks.filter(c => c.required && c.status === 'inconclusive').length} required inconclusive checks, ${report.checks.filter(c => !c.required && c.status === 'inconclusive').length} optional evidence gaps. ${resolve(directory, 'audit-report.json')}`);
} catch (error) { console.error(`Offline audit unavailable: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
