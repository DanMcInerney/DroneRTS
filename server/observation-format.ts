import type { ToolResult } from '../shared/types.ts';

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
    if (body?.protocol !== 'fleet-observation/2') return item;
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
    body.protocol = 'fleet-observation/5';
    body.sensors.ranges = pack(body.sensors.ranges);
    if (body.currentTelemetry?.ranges) body.currentTelemetry.ranges = pack(body.currentTelemetry.ranges);
    const captured = body.sensors.ranges?.proximity, current = body.currentTelemetry?.ranges?.proximity;
    // Fresh acquisitions often measure identical tables. Share only exact
    // values within this result; each sample keeps its own origin, identity,
    // timestamp, freshness and downward reading. Never reuse an earlier bundle.
    if (captured?.directions && current?.directions && JSON.stringify(captured) === JSON.stringify(current)) {
      body.currentTelemetry.ranges.proximity = { sameAs: 'sensors.ranges.proximity' };
    }
    return { ...item, text: JSON.stringify(body) };
  }) };
}
