import type { ToolResult } from '../shared/types.ts';

/** A lossless wire format for the repeated finite sensor rows. Physics, guest
 * telemetry and player evidence keep their native objects. No readings omitted. */
export function compactObservation(result: ToolResult): ToolResult {
  return { ...result, content: result.content.map(item => {
    if (item.type !== 'text') return item;
    let body: any;
    try { body = JSON.parse(item.text); } catch { return item; }
    if (body?.protocol !== 'fleet-observation/2') return item;
    const pack = (ranges: any) => {
      if (!Array.isArray(ranges?.proximity) || !ranges.proximity.every((r: any) => r.coverage?.shape === 'swept-sphere')) return ranges;
      const { proximity, ...metadata } = ranges;
      return { ...metadata, proximity: {
        columns: ['dx', 'dy', 'dz', 'distance', 'validity', 'radius', 'maxDistance'],
        shape: 'swept-sphere',
        rows: proximity.map((r: any) => [r.direction.x, r.direction.y, r.direction.z,
          r.distance, r.validity, r.coverage.radius, r.coverage.maxDistance]),
      } };
    };
    body.protocol = 'fleet-observation/3';
    body.sensors.ranges = pack(body.sensors.ranges);
    if (body.currentTelemetry?.ranges) body.currentTelemetry.ranges = pack(body.currentTelemetry.ranges);
    return { ...item, text: JSON.stringify(body) };
  }) };
}
