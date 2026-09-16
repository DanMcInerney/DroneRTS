import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditRun, exitCode, writeReport } from './audit/report.ts';

/** One post-close seam; no artifact creation/pruning or cleanup ownership. */
export async function auditClosedTrial(directory: string, result: { cleanup?: string; failures: unknown[] },
  analyze: () => Promise<number> = async () => { const report = await auditRun(directory, { closedByRunner: true }); await writeReport(directory, report); return exitCode(report); }) {
  let code: number = 2, reason: string | undefined;
  if (result.cleanup !== 'complete') reason = 'Audit skipped: owned writers did not close successfully';
  else try { code = await analyze(); } catch (error) { reason = `Audit failed: ${String(error)}`; }
  // Separate derived status avoids changing result.json after it was hashed.
  await writeFile(resolve(directory, 'audit-status.json'), JSON.stringify({ exitCode: code, ...(reason ? { reason } : {}) }, null, 2));
  return result.failures.length || result.cleanup !== 'complete' ? 1 : code;
}

/** Focused runner finalization order, testable without starting a host or actors. */
export async function finalizeFocusedTrial(directory: string, result: Record<string, any>,
  host: { close(): Promise<void>; failures: string[]; warnings: string[]; game: { state: { running: boolean }; sessionIdentity: string } },
  artifacts: { collectNetwork(session: string): void }, analyze?: () => Promise<number>) {
  result.cleanup = 'pending';
  // Even a failed pending-snapshot write must not prevent owned host cleanup.
  try { await writeFile(resolve(directory, 'result.json'), JSON.stringify({ ...result, failures: [...result.failures, ...host.failures], warnings: host.warnings }, null, 2)); }
  catch (error) { result.failures.push(`Pending evidence: ${error}`); }
  try { await host.close(); result.cleanup = 'complete'; }
  catch (error) { result.cleanup = 'failed'; result.failures.push(`Cleanup: ${error}`); }
  result.failures.push(...host.failures); result.warnings = host.warnings;
  result.stopped = !host.game.state.running; result.completedAt = new Date().toISOString();
  if (result.cleanup === 'complete') try { artifacts.collectNetwork(host.game.sessionIdentity); }
  catch (error) { result.failures.push(`Archive collection: ${error}`); }
  try {
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
    return await auditClosedTrial(directory, result as { cleanup: string; failures: unknown[] }, analyze);
  } catch (error) {
    console.error(`Could not save offline audit: ${error}`);
    return result.failures.length || result.cleanup !== 'complete' ? 1 : 2;
  }
}
