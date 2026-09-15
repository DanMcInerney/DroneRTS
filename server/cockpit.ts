import { Router } from 'express';
import { MATCH_DRONE_IDS, type DroneId } from '../shared/fleet.ts';
import type { GameState, ToolResult } from '../shared/types.ts';
import type { CockpitCall, CockpitDelivery, CockpitEvent, CockpitImage, CockpitSnapshot, CockpitToolEvidence, CockpitWorkspace } from '../shared/cockpit.ts';
import { ACTOR_MODEL, ACTOR_EFFORT, DRONE_COMPUTE, DRONE_HOST_LIBRARIES } from '../shared/actor-environment.ts';

export const COCKPIT_LIMITS = { events: 256, eventBytes: 256_000, text: 24_000, deliveryBytes: 2_000_000, imageBytes: 2_000_000 } as const;
type StoredDrone = {
  cursor: number; events: CockpitEvent[]; eventBytes: number; evictedThrough: number;
  lastCall: CockpitCall | null; lastDelivery: CockpitDelivery | null; lastImage: CockpitImage | null;
  images: Map<number, { bytes: Buffer; mimeType: string }>; drafts: Map<string, string>;
};
const freshDrone = (): StoredDrone => ({ cursor: 0, events: [], eventBytes: 0, evictedThrough: 0, lastCall: null, lastDelivery: null, lastImage: null, images: new Map(), drafts: new Map() });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const redactText = (text: string) => text
  .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+=*/gi, 'Bearer [redacted]')
  .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
  .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[=:]\s*)["']?[^\s,"';]+["']?/gi, '$1[redacted]')
  .replace(/\/(mcp|policy)\/[a-f0-9]{32,}/gi, '/$1/[redacted]')
  .replace(/data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[embedded image omitted]');

/** Preserve complete normal bundles, including every unread event, while redacting credentials. */
function clean(value: unknown, notes: Set<string>, depth = 0): unknown {
  if (depth > 40) { notes.add('Deeply nested content omitted.'); return '[nested content omitted]'; }
  if (typeof value === 'string') {
    if (/^[\[{]/.test(value.trim())) {
      try {
        const parsed = JSON.parse(value), sanitized = clean(parsed, notes, depth + 1);
        return JSON.stringify(parsed) === JSON.stringify(sanitized) ? value : JSON.stringify(sanitized);
      } catch { /* Ordinary actor text. */ }
    }
    const result = redactText(value);
    if (result !== value) notes.add('Credential or embedded image content redacted.');
    return result;
  }
  if (Array.isArray(value)) return value.map(item => clean(item, notes, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    if (/(?:token|apikey|password|secret)$/.test(normalized) || /^(authorization|cookie|setcookie|credentials|encryptedcontent)$/.test(normalized)) {
      notes.add('Credential content redacted.'); return [key, '[redacted]'];
    }
    return [key, clean(item, notes, depth + 1)];
  }));
}

const workspace = (tools: string[]): CockpitWorkspace => ({
  available: false, reason: 'This actor has fleet MCP tools only. Shell, filesystem access and code execution are disabled, so it cannot create or run automation scripts.', entries: [], tools,
  compute: { model: ACTOR_MODEL, effort: ACTOR_EFFORT, sandbox: DRONE_COMPUTE.sandbox, shell: DRONE_COMPUTE.shell, filesystem: DRONE_COMPUTE.filesystem, web: DRONE_COMPUTE.web },
  libraries: DRONE_HOST_LIBRARIES.map(library => ({ name: `${library.name} ${library.version}`, purpose: library.purpose, access: 'host only' })),
});

/** Bounded, in-memory player evidence; no filesystem, mailbox drain or new sensor capture. */
export class CockpitStore {
  private sessionId: string | null = null;
  private drones = new Map<DroneId, StoredDrone>();

  reset(sessionId: string | null) { this.sessionId = sessionId; this.drones.clear(); }
  private drone(id: DroneId) {
    let drone = this.drones.get(id);
    if (!drone) { drone = freshDrone(); this.drones.set(id, drone); }
    return drone;
  }
  private active(sessionId: string, role: string): role is DroneId {
    return sessionId === this.sessionId && MATCH_DRONE_IDS.includes(role as DroneId);
  }
  private append(drone: StoredDrone, event: Omit<CockpitEvent, 'sequence' | 'at'>) {
    const next = { ...event, sequence: ++drone.cursor, at: new Date().toISOString() };
    drone.events.push(next); drone.eventBytes += byteSize(next);
    while (drone.events.length > COCKPIT_LIMITS.events || drone.eventBytes > COCKPIT_LIMITS.eventBytes) {
      const removed = drone.events.shift()!;
      drone.eventBytes -= byteSize(removed); drone.evictedThrough = removed.sequence;
    }
    return next;
  }
  recordTool(sessionId: string, event: CockpitToolEvidence) {
    if (!this.active(sessionId, event.role)) return;
    const drone = this.drone(event.role), notes = new Set<string>();
    if (event.type === 'call') {
      const args = byteSize(event.arguments) <= COCKPIT_LIMITS.text ? clean(event.arguments, notes) as Record<string, unknown> : { omitted: 'Tool arguments exceeded the cockpit size limit.' };
      const entry = this.append(drone, { kind: 'call', name: event.name, data: { arguments: args } });
      drone.lastCall = { sequence: entry.sequence, name: event.name, arguments: args, startedAt: entry.at };
      return;
    }
    // Image bytes live in a separate slot; never duplicate them in events or JSON responses.
    const rawResult: ToolResult = { ...event.result, content: event.result.content.map(item => item.type === 'image' ? { ...item, data: '[image served separately]' } : item) };
    let result: ToolResult;
    if (byteSize(rawResult) > COCKPIT_LIMITS.deliveryBytes) {
      notes.add('Tool result exceeded the cockpit size limit; the result and sensor/message bundle are omitted.');
      result = { isError: event.result.isError, content: [{ type: 'text', text: '[oversized tool result omitted]' }] };
    } else result = clean(rawResult, notes) as ToolResult;
    let bundle: Record<string, unknown> | null = null;
    for (const part of result.content) {
      if (part.type !== 'text') continue;
      try { const value: unknown = JSON.parse(part.text); if (isRecord(value) && value.protocol === 'fleet-observation/1') bundle = value; }
      catch { /* Not every tool text block is a sensor bundle. */ }
    }
    const entry = this.append(drone, { kind: 'result', name: event.name, data: { isError: Boolean(event.result.isError), observation: Boolean(bundle) } });
    const image = event.result.content.find(part => part.type === 'image');
    if (image?.type === 'image') {
      if (/^image\/(?:png|jpeg)$/.test(image.mimeType) && image.data.length <= COCKPIT_LIMITS.imageBytes && /^[A-Za-z0-9+/=]+$/.test(image.data)) {
        const sensors = isRecord(bundle?.sensors) ? bundle.sensors : undefined;
        const timestamp = isRecord(sensors?.timestamp) ? sensors.timestamp : undefined;
        drone.images.set(entry.sequence, { bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType });
        // A second slot lets an in-flight image GET finish across a new tool return.
        while (drone.images.size > 2) drone.images.delete(drone.images.keys().next().value!);
        drone.lastImage = { sequence: entry.sequence, deliverySequence: entry.sequence, mimeType: image.mimeType, receivedAt: entry.at,
          capturedAt: typeof timestamp?.capturedAt === 'string' ? timestamp.capturedAt : null, simTime: typeof timestamp?.simTime === 'number' ? timestamp.simTime : null,
          url: `/api/cockpit/${event.role}/image/${entry.sequence}?session=${encodeURIComponent(sessionId)}` };
      } else notes.add('Image omitted because its format or size was outside cockpit limits.');
    }
    drone.lastDelivery = { sequence: entry.sequence, receivedAt: entry.at, tool: event.name, isError: Boolean(event.result.isError), bundle, result, omissions: [...notes] };
  }
  recordRuntime(sessionId: string, value: unknown) {
    if (!isRecord(value) || typeof value.role !== 'string' || !this.active(sessionId, value.role)) return;
    const drone = this.drone(value.role), type = String(value.type ?? '');
    const kind = /^actor-message(?:-delta)?$/.test(type) ? 'output'
      : ['recorded-reasoning-summary', 'reasoning-summary-delta'].includes(type) ? 'summary'
      : ['recorded-reasoning', 'reasoning-text-delta'].includes(type) ? 'reasoning'
      : type === 'reasoning-availability' ? 'reasoning-status' : null;
    if (kind) {
      const itemId = typeof value.itemId === 'string' ? value.itemId.slice(0, 160) : undefined;
      let text = kind === 'summary' && Array.isArray(value.summary) ? value.summary.filter(part => typeof part === 'string').join('\n') : typeof value.text === 'string' ? value.text : '';
      if (!text) return;
      const key = itemId ? `${kind}:${itemId}` : undefined;
      if (key) {
        if (type.endsWith('-delta') && value.delta !== false) text = (drone.drafts.get(key) ?? '') + text;
        drone.drafts.set(key, text.slice(0, COCKPIT_LIMITS.text));
        while (drone.drafts.size > 16) drone.drafts.delete(drone.drafts.keys().next().value!);
      }
      const sanitized = String(clean(text.slice(0, COCKPIT_LIMITS.text), new Set()));
      this.append(drone, { kind, itemId, delta: false, streaming: typeof value.streaming === 'boolean' ? value.streaming : type.endsWith('-delta'),
        text: sanitized + (text.length > COCKPIT_LIMITS.text ? '\n[long output truncated]' : ''),
        data: kind === 'reasoning-status' ? { availability: value.availability, incomplete: value.incomplete === true } : value.incomplete === true ? { incomplete: true } : undefined });
      return;
    }
    if (['child-started', 'actor-ended', 'actor-retired', 'actor-resumed', 'catalog-turn-resumed', 'catalog-yield-requested'].includes(type)) {
      // Whitelist lifecycle fields; never persist arbitrary runtime item contents.
      this.append(drone, { kind: 'lifecycle', name: type, data: clean({ status: value.status, attempt: value.attempt, error: value.error }, new Set()) });
    }
  }
  snapshot(id: DroneId, options: { session?: string; after?: number; running?: boolean; tools?: string[] } = {}): CockpitSnapshot {
    const drone = this.drone(id), reset = (options.session ?? null) !== this.sessionId || (options.after ?? 0) > drone.cursor;
    const after = reset ? 0 : options.after ?? 0;
    return structuredClone({ protocol: 'fleet-cockpit/1', droneId: id, sessionId: this.sessionId, cursor: drone.cursor, reset,
      truncated: drone.evictedThrough > after, running: options.running ?? false, serverTime: new Date().toISOString(),
      lastCall: drone.lastCall, lastDelivery: drone.lastDelivery, lastImage: drone.lastImage, events: drone.events.filter(event => event.sequence > after), workspace: workspace(options.tools ?? []),
    });
  }
  image(id: DroneId, sessionId: string, sequence: number) {
    const image = this.drones.get(id)?.images.get(sequence);
    return sessionId === this.sessionId && image ? { bytes: Buffer.from(image.bytes), mimeType: image.mimeType } : null;
  }
}

export function cockpitRouter(options: { store: CockpitStore; state: () => GameState; tools: (id: DroneId) => string[] }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/:droneId', (req, res) => {
    const id = req.params.droneId as DroneId;
    if (!MATCH_DRONE_IDS.includes(id)) { res.status(404).json({ error: 'Unknown drone.' }); return; }
    const after = req.query.after === undefined ? undefined : Number(req.query.after);
    if ((req.query.after !== undefined && (typeof req.query.after !== 'string' || !/^\d+$/.test(req.query.after))) || (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) || (req.query.session !== undefined && (typeof req.query.session !== 'string' || req.query.session.length > 160))) {
      res.status(400).json({ error: 'Invalid cockpit cursor.' }); return;
    }
    const snapshot = options.store.snapshot(id, { session: req.query.session as string | undefined, after, running: options.state().running, tools: options.tools(id) });
    const etag = `"${snapshot.sessionId ?? 'idle'}:${id}:${snapshot.cursor}:${Number(snapshot.running)}:${snapshot.workspace.tools.join('-')}"`;
    res.set('ETag', etag);
    if (req.get('if-none-match') === etag && !snapshot.reset) { res.status(304).end(); return; }
    res.json(snapshot);
  });
  router.get('/:droneId/image/:sequence', (req, res) => {
    const id = req.params.droneId as DroneId, sequence = Number(req.params.sequence);
    if (!MATCH_DRONE_IDS.includes(id) || !/^\d+$/.test(req.params.sequence) || !Number.isSafeInteger(sequence) || typeof req.query.session !== 'string') { res.status(400).json({ error: 'Invalid cockpit image.' }); return; }
    const image = options.store.image(id, req.query.session, sequence);
    if (!image) { res.status(404).json({ error: 'This image is no longer retained.' }); return; }
    res.type(image.mimeType).send(image.bytes);
  });
  return router;
}
