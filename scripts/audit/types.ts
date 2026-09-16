/** Offline evidence only. No runtime or actor imports. */
export type Status = 'pass' | 'fail' | 'inconclusive' | 'not-applicable';
export type Ref = { file: string; line?: number; pointer?: string };
export type RecordAt = { data: any; ref: Ref; order: number };
export type Issue = { kind: string; ref: Ref; detail: string };
export type Input = { file: string; bytes?: number; sha256?: string; state: 'read' | 'missing' | 'limited'; records?: number; invalid?: number };
export type Run = {
  directory: string; result: any; manifest: any; replayStatus: any; cleanup: any;
  audit: RecordAt[]; replay: RecordAt[]; inputs: Input[]; issues: Issue[];
  sessionFile?: string; replayDirectory?: string;
};
export type Check = {
  id: string; status: Status; required: boolean; severity: 'error' | 'warning' | 'info';
  rules: string[]; summary: string; measurements: Record<string, unknown>;
  prerequisites: string[]; evidence: Ref[]; evidenceTotal: number; examplesOmitted: number; limitations: string[];
};
export type Finding = {
  category: 'domain-rejection' | 'lifecycle-cancellation' | 'unexpected-failure' | 'unclassified-error';
  actor: string; operation?: string; message: string; appearances: Ref[]; boundary?: Ref;
};
export type Report = {
  schema: 'fleet-offline-audit/1'; reportId: string; verdict: 'pass' | 'fail' | 'inconclusive';
  run: Record<string, unknown>; analyzer: { version: string; sha256: string; files: Record<string, string> };
  inputs: Input[]; coverage: Record<string, unknown>; checks: Check[];
  metrics: Record<string, unknown>; findings: Finding[]; limitations: string[];
};
