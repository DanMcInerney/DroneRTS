/** Recorded MCP data is untrusted JSON, never executable code. */
export const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const knownObservation = (body: any) => /^fleet-observation\/[1-5]$/.test(body?.protocol ?? '');

export function decodeContent(result: any) {
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const values: any[] = [], parsed: { index: number; value: any }[] = [], diagnostics: string[] = []; let textBytes = 0;
  for (const [index, block] of content.entries()) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    textBytes += Buffer.byteLength(block.text);
    if (/\[(?:long text truncated|nested content omitted)\]/.test(block.text)) diagnostics.push('truncated-content');
    try { const value = JSON.parse(block.text); values.push(value); parsed.push({ index, value }); } catch { /* Ordinary text is allowed. */ }
  }
  const candidates = values.filter(value => object(value) && typeof value.protocol === 'string' && value.protocol.startsWith('fleet-observation/'));
  if (candidates.length > 1) diagnostics.push('ambiguous-observation');
  const body = candidates.length === 1 && !diagnostics.length ? candidates[0] : undefined;
  if (body && !knownObservation(body)) diagnostics.push('unknown-observation-version');
  const objects = values.filter(object);
  const resultBody = body ?? (candidates.length === 0 && !diagnostics.length && objects.length === 1 ? objects[0] : undefined);
  return { body, resultBody, values, parsed, diagnostics, textBytes, imageCount: content.filter(block => block?.type === 'image').length };
}

export type ErrorAt = { message: string; path: string; domain: boolean; receiptId?: string; revision?: number };
/** Only inspect result envelopes, never arbitrary archived workspace/argument strings. */
export function extractErrors(record: any): ErrorAt[] {
  const errors: ErrorAt[] = [], value = record?.value;
  function envelope(v: any, path: string, receiptId?: string, revision?: number) {
    if (!object(v)) return;
    if (v.error || v.fault || v.isError === true || ['failed', 'unknown', 'rejected', 'not_executed'].includes(v.status) || v.rejected === true) {
      const message = typeof v.error === 'string' ? v.error : v.error?.message ?? v.fault ?? v.reason ?? v.message ?? 'Failed result';
      const code = v.error?.code;
      errors.push({ message: String(message), path, receiptId, revision,
        domain: v.rejected === true || ['rejected', 'not_executed'].includes(v.status) || ['invalid_request', 'invalid_input', 'command_conflict', 'unknown_bundle', 'expired_command'].includes(code) });
    }
    if (object(v.result)) envelope(v.result, `${path}/result`, receiptId, revision);
    for (const [i, r] of (Array.isArray(v.results) ? v.results : []).entries()) envelope(r, `${path}/results/${i}`, receiptId, revision);
    for (const [i, r] of (Array.isArray(v.nervelet?.results) ? v.nervelet.results : []).entries()) {
      envelope(r, `${path}/nervelet/results/${i}`, r?.id, r?.revision);
      envelope(r?.data, `${path}/nervelet/results/${i}/data`, r?.id, r?.revision);
    }
  }
  if (/-error$/.test(record?.type ?? '') && object(value)) {
    if (record.type === 'tool-error' && typeof value.message === 'string') {
      try { envelope(JSON.parse(value.message), '/value/message'); } catch { /* Unstructured error */ }
    }
    if (!errors.length) errors.push({ message: String(value.message ?? value.error ?? record.type), path: '/value', domain: false });
  } else {
    envelope(value, '/value');
    if (record?.type === 'agent' && object(value) && /(?:error|denied)$/.test(value.type ?? '') && !errors.length)
      errors.push({ message: String(value.message ?? value.reason ?? value.type), path: '/value', domain: value.type === 'policy-denied' });
    for (const [i, error] of (Array.isArray(value?.errors) ? value.errors : []).entries())
      errors.push({ message: String(error?.message ?? error), path: `/value/errors/${i}`, domain: false });
  }
  if (record?.type === 'agent' && value?.type === 'tool-result') {
    const decoded = decodeContent(value.result);
    // The outer isError and inner structured error describe the same appearance.
    for (const { index, value: body } of decoded.parsed) {
      const start = errors.length;
      envelope(body, '');
      // JSON inside MCP text is not a child of the raw JSONL object. Reference
      // the actual text block, not a fictitious JSON pointer through a string.
      for (const error of errors.slice(start)) error.path = `/value/result/content/${index}/text`;
    }
    if (errors.length > 1) {
      const unique = new Map(errors.filter(e => e.message !== 'Failed result').map(e => [JSON.stringify(e), e]));
      return [...unique.values()];
    }
  }
  return errors;
}
