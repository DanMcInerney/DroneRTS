import type { CockpitSnapshot, CockpitEvent } from '../shared/cockpit';
import { json, outgoingSendAttempts, record, timestamp } from './cockpit-model';
import { CockpitWorkspaceView } from './cockpit-workspace';
import { formatBytes } from './onboard-presentation';

export interface CockpitCardContext { snapshot: CockpitSnapshot; events: CockpitEvent[] }
export interface CockpitCardDefinition {
  id: string; label: string; title: string; className?: string;
  /** Only redraw when a card's evidence changes, preserving scroll and open details. */
  evidence(context: CockpitCardContext): unknown;
  render(host: HTMLElement, context: CockpitCardContext): void;
  dispose?(host: HTMLElement): void;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function note(text: string) { return node('p', 'cockpit-note', text); }
function empty(host: HTMLElement, title: string, text: string, icon = '⌁') {
  const block = node('div', 'cockpit-empty'); block.append(node('span', 'cockpit-empty-icon', icon), node('strong', '', title), node('p', '', text)); host.replaceChildren(block);
}
function detail(label: string, value: unknown, open = false) {
  const details = node('details', 'cockpit-json'); details.open = open;
  details.append(node('summary', '', label), node('pre', '', json(value))); return details;
}
function metadata(entries: Array<[string, unknown]>) {
  const list = node('dl', 'cockpit-metadata');
  for (const [label, value] of entries) { const item = node('div'); item.append(node('dt', '', label), node('dd', '', value === undefined || value === null ? '—' : String(value))); list.append(item); }
  return list;
}
function sensorBundle(context: CockpitCardContext) { return record(context.snapshot.lastDelivery?.bundle?.sensors); }
const reading = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(2))) : value === undefined ? '—' : String(value);

const cameraCard: CockpitCardDefinition = {
  id: 'camera', label: '01 / OPTICAL MEMORY', title: 'Last image seen', className: 'cockpit-camera-card',
  evidence: ({ snapshot }) => [snapshot.lastImage, snapshot.lastDelivery?.sequence],
  render(host, { snapshot }) {
    host.replaceChildren();
    const image = snapshot.lastImage;
    if (!image) {
      const omitted = snapshot.lastDelivery?.omissions.filter(message => /image/i.test(message)) ?? [];
      empty(host, omitted.length ? 'Camera evidence was omitted' : 'Awaiting a camera delivery', omitted.length ? omitted.join(' ') : 'The first image returned to this agent appears here.', '⌖');
      return;
    }
    const figure = node('figure', 'cockpit-camera');
    const picture = node('img'); picture.alt = `Last camera image delivered to ${snapshot.droneId}`;
    const url = new URL(image.url, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/cockpit/')) picture.src = url.href;
    const failure = node('p', 'cockpit-image-error', 'Recorded image unavailable. Waiting for the next delivery.'); failure.hidden = true;
    picture.addEventListener('error', () => { picture.hidden = true; failure.hidden = false; });
    const stale = image.deliverySequence !== snapshot.lastDelivery?.sequence;
    const badge = node('figcaption', stale ? 'cockpit-image-badge previous' : 'cockpit-image-badge', stale ? 'PREVIOUS DELIVERY' : 'DELIVERED FRAME');
    figure.append(picture, failure, badge); host.append(figure);
    host.append(metadata([['Captured', timestamp(image.capturedAt)], ['Tool response recorded', timestamp(image.receivedAt)], ['Simulation time', image.simTime === null ? '—' : `${image.simTime} s`]]));
    if (stale) {
      const latestHadImage = snapshot.lastDelivery?.result.content.some(content => content.type === 'image') || snapshot.lastDelivery?.omissions.some(message => /image omitted/i.test(message));
      host.append(note(latestHadImage ? 'The latest tool response contained an image that could not be retained. Showing the previous recorded frame.' : 'The latest tool response contained no image. Showing the last recorded camera frame.'));
    }
    if (snapshot.lastDelivery?.omissions.length) host.append(note(snapshot.lastDelivery.omissions.join(' ')));
  },
};
const sensorsCard: CockpitCardDefinition = {
  id: 'sensors', label: '02 / LAST SENSOR BATCH', title: 'Position & heading', className: 'cockpit-sensors-card',
  evidence: ({ snapshot }) => snapshot.lastDelivery,
  render(host, context) {
    const { lastDelivery } = context.snapshot, sensors = sensorBundle(context);
    if (!Object.keys(sensors).length) { empty(host, 'No sensor batch yet', lastDelivery ? 'The latest tool result did not contain sensors.' : 'Readings appear after the agent receives a tool result.'); return; }
    host.replaceChildren();
    const position = record(sensors.position), heading = record(sensors.heading), time = record(sensors.timestamp), camera = record(sensors.camera);
    const readings = node('div', 'cockpit-readings');
    for (const axis of ['x', 'y', 'z']) { const item = node('div'); item.append(node('span', '', axis.toUpperCase()), node('strong', '', reading(position[axis]))); readings.append(item); }
    const headingBlock = node('div', 'cockpit-heading-reading'); headingBlock.append(node('span', '', 'HEADING'), node('strong', '', heading.degrees === undefined ? '—' : `${reading(heading.degrees)}°`));
    host.append(node('p', 'cockpit-mini-label', 'LOCAL POSITION / XYZ'), readings, headingBlock);
    host.append(metadata([['Acquired', timestamp(time.capturedAt)], ['Delivered', timestamp(lastDelivery?.bundle?.deliveredAt)], ['Camera', camera.available === true ? 'Image available' : 'Unavailable'], ...(typeof sensors.validity === 'string' ? [['Sensor validity', sensors.validity] as [string, unknown]] : [])]));
    host.append(detail('Exact sensor payload', sensors));
    if (lastDelivery?.bundle?.currentTelemetry) host.append(detail('Current telemetry in this delivery', lastDelivery.bundle.currentTelemetry));
  },
};
const inboxCard: CockpitCardDefinition = {
  id: 'inbox', label: '03 / RECEIVED', title: 'Last inbox batch', className: 'cockpit-inbox-card',
  evidence: ({ snapshot }) => snapshot.lastDelivery,
  render(host, { snapshot }) {
    const delivery = snapshot.lastDelivery, batch = delivery?.bundle?.events;
    if (!Array.isArray(batch)) { empty(host, 'No inbox delivery yet', delivery ? 'The latest result did not contain an inbox batch.' : 'Peer mail and controller events appear together exactly as delivered.', '↙'); return; }
    host.replaceChildren();
    const heading = node('div', 'cockpit-batch-heading'); heading.append(node('strong', '', `${batch.length} ${batch.length === 1 ? 'event' : 'events'}`), node('span', '', `CURSOR ${delivery?.bundle?.cursor ?? '—'}`)); host.append(heading);
    if (!batch.length) { const blank = node('div'); empty(blank, 'Inbox was empty', 'The last tool result delivered an empty batch.', '∅'); host.append(blank); }
    else {
      const list = node('div', 'cockpit-inbox-list');
      for (const value of batch) {
        const event = record(value), message = record(event.message), row = node('article', 'cockpit-message');
        const meta = node('div'); meta.append(node('strong', '', String(message.from ?? event.type ?? 'Event')), node('span', '', String(message.kind ?? `#${event.cursor ?? '—'}`)));
        const body = message.text ?? event.text ?? event.instruction;
        row.append(meta); if (typeof body === 'string') row.append(node('p', '', body)); row.append(detail('Delivered event', value)); list.append(row);
      }
      host.append(list);
    }
    host.append(note(`Batch delivered ${timestamp(delivery?.bundle?.deliveredAt)} · mission ${delivery?.bundle?.mission ?? '—'}`));
    if (delivery?.bundle?.hasMore) host.append(note('More unread events remain for a later tool delivery.'));
    host.append(detail('Exact inbox batch', batch));
  },
};
const interactionCard: CockpitCardDefinition = {
  id: 'interaction', label: '04 / CONTROLLER', title: 'Last tool exchange', className: 'cockpit-interaction-card',
  evidence: ({ snapshot }) => [snapshot.lastCall, snapshot.lastDelivery],
  render(host, { snapshot }) {
    const { lastCall: call, lastDelivery: delivery } = snapshot;
    if (!call && !delivery) { empty(host, 'No tool calls yet', 'Arguments and returned content will appear after the agent interacts.', '↔'); return; }
    host.replaceChildren();
    if (call) {
      const header = node('div', 'cockpit-tool-heading'); header.append(node('strong', '', call.name), node('span', '', timestamp(call.startedAt))); host.append(header, detail('Latest call · arguments', call.arguments, true));
    }
    if (delivery) {
      const pending = call && call.sequence > delivery.sequence;
      host.append(note(pending ? 'Latest call is awaiting its result. The receipt below belongs to the previous exchange.' : `Receipt · ${delivery.tool} · ${timestamp(delivery.receivedAt)}${delivery.isError ? ' · ERROR' : ''}`));
      host.append(detail('Returned content', delivery.result));
      if (delivery.omissions.length) host.append(note(delivery.omissions.join(' ')));
    } else host.append(note('Awaiting the first tool result.'));
  },
};
const outboxCard: CockpitCardDefinition = {
  id: 'outbox', label: '05 / OUTGOING', title: 'Radio outbox', className: 'cockpit-outbox-card',
  evidence: ({ events }) => outgoingSendAttempts(events),
  render(host, { events }) {
    const sends = outgoingSendAttempts(events);
    if (!sends.length) { empty(host, 'No sends in this window', 'Outgoing send attempts, including exchange batches, appear here. Delivery receipts remain in tool results.', '↗'); return; }
    const list = node('div', 'cockpit-outbox-list');
    for (const send of [...sends].reverse()) {
      const args = send.arguments;
      const row = node('article', 'cockpit-message');
      const meta = node('div'); meta.append(node('strong', '', `→ ${args.to ?? 'TEAM'}`), node('span', '', timestamp(send.at))); row.append(meta);
      if (typeof args.text === 'string') row.append(node('p', '', args.text));
      row.append(detail('Send arguments', args), detail('Source call', { sequence: send.sequence, ...send.source })); list.append(row);
    }
    host.replaceChildren(list, note('Send attempts in the retained event window. An attempt alone does not confirm acceptance or delivery; check tool results for receipts.'));
  },
};
const workspaceViews = new WeakMap<HTMLElement, CockpitWorkspaceView>();
const workspaceCard: CockpitCardDefinition = {
  id: 'workspace', label: '06 / LOCAL WORKSPACE', title: 'Files & automations', className: 'cockpit-workspace-card',
  evidence: ({ snapshot }) => [snapshot.droneId, snapshot.sessionId, snapshot.workspace],
  render(host, { snapshot }) {
    let view = workspaceViews.get(host);
    if (!view) { view = new CockpitWorkspaceView(host); workspaceViews.set(host, view); }
    view.update(snapshot);
  },
  dispose(host) { workspaceViews.get(host)?.dispose(); workspaceViews.delete(host); },
};
const environmentCard: CockpitCardDefinition = {
  id: 'environment', label: '07 / EXECUTION ENVIRONMENT', title: 'Tools & libraries', className: 'cockpit-environment-card',
  evidence: ({ snapshot }) => [snapshot.workspace.compute, snapshot.workspace.tools, snapshot.workspace.libraries, snapshot.workspace.optionalGuestLibraries],
  render(host, { snapshot }) {
    const { compute, libraries, tools } = snapshot.workspace; host.replaceChildren();
    host.append(node('p', 'cockpit-model-name', `${compute.model} / ${compute.effort}`));
    const flags = node('div', 'cockpit-compute-flags');
    for (const [label, available] of [['Onboard files', compute.filesystem], ['Scripts', compute.codeExecution], ['Host files', compute.hostFilesystem], ['Shell', compute.shell], ['Web', compute.web]] as const) flags.append(node('span', available ? 'available' : '', `${available ? '✓' : '×'} ${label}`));
    host.append(flags, node('p', 'cockpit-mini-label', 'CURRENTLY PERMITTED CONTROLLER TOOLS'));
    const toolList = node('div', 'cockpit-tool-list'); for (const name of tools) toolList.append(node('code', '', name)); host.append(toolList);
    host.append(note(`${compute.executionEngine} · ${formatBytes(compute.heapBytes)} heap · ${compute.cpuMsPerSecond} ms CPU/s · ${compute.maxRoutineMs / 1000} s per routine. Files: ${compute.filesystemScope}. Host sandbox: ${compute.sandbox}.`));
    const details = node('details', 'cockpit-libraries'); details.append(node('summary', '', `Runtime & bridge libraries · ${libraries.length}`));
    for (const library of libraries) { const row = node('div'); row.append(node('strong', '', library.name), node('span', '', library.purpose), node('small', '', library.access)); details.append(row); }
    const optional = snapshot.workspace.optionalGuestLibraries;
    details.append(note(`Optional guest libraries: ${optional.length ? optional.join(', ') : 'none installed'}. Host bridge packages are outside guest imports.`));
    host.append(details);
  },
};

/** Add, remove or reorder a card here; polling and navigation are independent. */
export const COCKPIT_CARDS: readonly CockpitCardDefinition[] = [cameraCard, sensorsCard, inboxCard, interactionCard, outboxCard, workspaceCard, environmentCard];

export function mountCockpitCards(host: HTMLElement, definitions: readonly CockpitCardDefinition[] = COCKPIT_CARDS) {
  const cards = definitions.map(definition => {
    const card = node('article', `cockpit-card ${definition.className ?? ''}`); card.dataset.card = definition.id;
    const header = node('header'); header.append(node('span', 'cockpit-mini-label', definition.label), node('h2', '', definition.title));
    const body = node('div', 'cockpit-card-body'); empty(body, 'Waiting for agent evidence', 'Connecting to the cockpit recorder.'); card.append(header, body); host.append(card);
    return { definition, body, signature: '' };
  });
  return {
    update(context: CockpitCardContext) {
      for (const card of cards) { const signature = json(card.definition.evidence(context)); if (signature === card.signature) continue; card.signature = signature; card.definition.render(card.body, context); }
    },
    reset() { for (const card of cards) { card.signature = ''; card.definition.dispose?.(card.body); empty(card.body, 'Waiting for agent evidence', 'Connecting to the cockpit recorder.'); } },
  };
}
