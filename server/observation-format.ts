import type { ToolResult } from '../shared/types.ts';

// Symbols survive host object spreads but are never serialized into pilot input.
export const resultSubmission = Symbol('fleet-result-submission');
export type ResultSubmission = { submitted(): void; failed(error: unknown): void };
export type SubmittedResult = ToolResult & { [resultSubmission]?: ResultSubmission };
export const FLEET_OUTPUT_LIMITS = { text: 640 * 1024, media: 512 * 1024, images: 1 } as const;
/** Exact JSON-RPC result envelope; encoded pixels have their own decoded byte quota. */
export function verifyFleetResult(result: ToolResult, requestId: unknown = 'x'.repeat(128)) {
  let mediaBytes = 0, encodedMediaBytes = 0, images = 0;
  const content = result.content.map(item => {
    if (item.type !== 'image') return item;
    images++; mediaBytes += Buffer.byteLength(item.data, 'base64'); encodedMediaBytes += Buffer.byteLength(JSON.stringify(item.data)) - 2;
    return { ...item, data: '' };
  });
  const textBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { ...result, content } }));
  if (textBytes > FLEET_OUTPUT_LIMITS.text || mediaBytes > FLEET_OUTPUT_LIMITS.media || images > FLEET_OUTPUT_LIMITS.images)
    throw new Error(`Fleet result exceeds capacity (${textBytes} text bytes, ${mediaBytes} media bytes, ${images} images); observe for recovery, never replay uncertain commands.`);
  return { textBytes, mediaBytes, wireBytes: textBytes + encodedMediaBytes };
}

// Wire-codebook only: exact signed unit directions, ordered X, then Y, then Z.
// A nonstandard direction is always sent explicitly, never rounded to this grid.
const xyz26 = [-1, 0, 1].flatMap(x => [-1, 0, 1].flatMap(y =>
  [-1, 0, 1].filter(z => x || y || z).map(z => {
    const n = Math.hypot(x, y, z); return [x / n, y / n, z / n];
  })));
const keysAre = (value: any, keys: string[]) => value && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const sharedOrArray = (values: any[]) => values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : values;

/** A lossless wire format for the repeated finite sensor rows. Physics, guest
 * telemetry and player evidence keep their native objects. No readings omitted. */
export function compactObservation(result: ToolResult): ToolResult {
  return { ...result, content: result.content.map(item => {
    if (item.type !== 'text') return item;
    let body: any;
    try { body = JSON.parse(item.text); } catch { return item; }
    return { ...item, text: JSON.stringify(compactObservationValue(body)) };
  }) };
}

/** Keep typed observation data until the final transport encoding. */
export function compactObservationValue<T>(body: T): T {
    if ((body as any)?.protocol !== 'fleet-observation/2') return body;
    const value: any = body;
    const pack = (ranges: any) => {
      if (!Array.isArray(ranges?.proximity) || !ranges.proximity.length || !ranges.proximity.every((r: any) =>
        keysAre(r, ['direction', 'distance', 'validity', 'coverage'])
        && keysAre(r.direction, ['x', 'y', 'z']) && keysAre(r.coverage, ['shape', 'radius', 'maxDistance'])
        && r.coverage.shape === 'swept-sphere')) return ranges;
      const { proximity, ...metadata } = ranges;
      const directions = proximity.map((r: any) => [r.direction.x, r.direction.y, r.direction.z]);
      return { ...metadata, proximity: {
        directions: JSON.stringify(directions) === JSON.stringify(xyz26) ? 'xyz26' : directions,
        shape: 'swept-sphere',
        distance: sharedOrArray(proximity.map((r: any) => r.distance)),
        validity: sharedOrArray(proximity.map((r: any) => r.validity)),
        radius: sharedOrArray(proximity.map((r: any) => r.coverage.radius)),
        maxDistance: sharedOrArray(proximity.map((r: any) => r.coverage.maxDistance)),
      } };
    };
    value.protocol = 'fleet-observation/5';
    value.sensors.ranges = pack(value.sensors.ranges);
    if (value.currentTelemetry?.ranges) value.currentTelemetry.ranges = pack(value.currentTelemetry.ranges);
    const captured = value.sensors.ranges?.proximity, current = value.currentTelemetry?.ranges?.proximity;
    // Fresh acquisitions often measure identical tables. Share only exact
    // values within this result; each sample keeps its own origin, identity,
    // timestamp, freshness and downward reading. Never reuse an earlier bundle.
    if (captured?.directions && current?.directions && JSON.stringify(captured) === JSON.stringify(current)) {
      value.currentTelemetry.ranges.proximity = { sameAs: 'sensors.ranges.proximity' };
    }
    return body;
}
