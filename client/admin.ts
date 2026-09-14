import './admin.css';

import { DIAGNOSTIC_CATEGORIES as categories, type DiagnosticEvent as Event, type DiagnosticPage as Page, type DiagnosticSession as Session, type DiagnosticStatus as Status } from '../shared/diagnostics';
import { dronePresentation } from './drone-presentation';
import { ReplayViewer } from './replay';
import { auditReplayTime } from './replay-model';

const sizes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const roleName = (role: string) => role.startsWith('drone-') ? dronePresentation(role).label : role.replace(/^parent$/, 'Relay').replace(/^operator$/, 'Operator');
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value || 'Time unavailable' : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

/** The game remains mounted and supplies camera captures behind this route. */
export function mountAdmin() {
  const panel = document.createElement('section'); panel.className = 'admin-page'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Fleet diagnostics');
  panel.innerHTML = `
    <header class="admin-top"><a class="admin-back" href="#" id="admin-back">← <span>Back to flight deck</span></a><span class="admin-wordmark">FLEET <b>/</b> OBSERVATORY</span><span class="admin-local"><i></i> LOCAL DIAGNOSTICS</span></header>
    <div class="admin-content">
      <div class="admin-heading"><div><div class="admin-kicker">BEHIND THE FLIGHT</div><h1>Every signal. One place.</h1><p>Trace the conversation, inspect the wire, understand the session.</p></div><div class="admin-now"><span id="admin-live-state">CONNECTING</span><small id="admin-updated">Waiting for simulator</small></div></div>
      <div id="admin-error" class="admin-error" role="alert" hidden></div>
      <section class="admin-overview" aria-label="Live fleet on this server">
        <article class="admin-stat"><span>CURRENT FLEET</span><strong id="admin-runtime">—</strong><small id="admin-model">Luna / xhigh</small></article>
        <article class="admin-stat"><span>RADIO NETWORK</span><strong id="admin-peer-count">— <em>/ — online</em></strong><small id="admin-network-state">Zenoh peer mode</small></article>
        <article class="admin-stat"><span>DELIVERY QUEUE</span><strong id="admin-pending">—</strong><small>Messages awaiting acknowledgement</small></article>
        <article class="admin-stat"><span>MODEL USAGE</span><strong id="admin-usage">—</strong><small>Recorded tokens · current fleet</small></article>
      </section>
      <section class="admin-peers" id="admin-peers" aria-label="Current peer connectivity"></section>
      <section class="admin-console" aria-label="Session event explorer">
        <div class="admin-console-top"><div><div class="admin-kicker">SESSION EXPLORER</div><h2>Follow the evidence.</h2></div><div class="admin-session-actions"><button id="admin-export" class="admin-button" type="button">↓ Export log</button><button id="admin-follow" class="admin-button admin-follow active" type="button" aria-pressed="true"><span>Ⅱ</span> Pause feed</button></div></div>
        <div class="admin-session-bar"><label>SESSION<select id="admin-session" aria-label="Session log"><option value="">Loading sessions…</option></select></label><span id="admin-session-info">Local audit files</span><button id="admin-refresh" class="admin-text-button" type="button">Jump to latest ↗</button></div>
        <div id="admin-replay-host"></div>
        <div class="admin-filterbar"><nav class="admin-tabs" aria-label="Event categories">${categories.map(([id, label]) => `<button data-category="${id}" class="${id === 'all' ? 'selected' : ''}" type="button" aria-pressed="${id === 'all'}">${label}</button>`).join('')}</nav><div class="admin-searchbar"><label class="admin-search"><span aria-hidden="true">⌕</span><input id="admin-search" type="search" placeholder="Search payload, message or tool…" maxlength="200" aria-label="Search recorded events" /></label><select id="admin-role" aria-label="Filter actor"><option value="all">Every actor</option><option value="parent">Relay</option><option value="operator">Operator</option><option value="player">Player</option></select></div></div>
        <div class="admin-evidence-note" id="admin-evidence-note">Events are recorded evidence. Expand a row for the redacted source JSON. Opening a row pauses the feed.</div>
        <div class="admin-timeline-header"><span>TIME / ACTOR</span><span>EVENT & PAYLOAD</span><span id="admin-event-count">0 events loaded</span></div>
        <div class="admin-timeline" id="admin-timeline" aria-label="Recorded session events"></div>
        <div class="admin-console-footer"><button id="admin-older" class="admin-button" type="button" disabled>↑ Load earlier events</button><span id="admin-window">Up to 600 events in this view</span><button id="admin-export-view" class="admin-text-button" type="button">Export visible JSONL</button></div>
      </section>
      <footer class="admin-footnote"><span><b>What is captured</b> Zenoh application envelopes and acknowledgements; sampled, CRC-validated MAVLink packet hex and decoded fields; tool calls, results and runtime-provided reasoning summaries. New sessions also record bounded match replays and acquired camera images.</span><span><b>What is unavailable</b> Hidden model reasoning is not exposed. Older sessions may lack replay, summaries or packet bytes. Credentials and inline audit images are omitted. Peer payloads are not a TCP packet capture. Recording and sampling limits appear beside the evidence.</span></footer>
    </div>`;
  document.body.append(panel);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => panel.querySelector<T>(`#${id}`)!;
  const session = el<HTMLSelectElement>('admin-session'), role = el<HTMLSelectElement>('admin-role'), search = el<HTMLInputElement>('admin-search');
  const timeline = el('admin-timeline'), follow = el<HTMLButtonElement>('admin-follow');
  let visible = false, live = true, busy = false, generation = 0, category = 'all', events: Event[] = [], next = 0, before = 0, hasOlder = false;
  let sessions: Session[] = [], activeSession: string | null = null, sessionRefresh = 0, timer: ReturnType<typeof setTimeout> | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
  let restoreFocus: HTMLElement | null = null, previousOverflow = '', previousHash = '';
  const opened = new Set<number>();
  const replay = new ReplayViewer(el('admin-replay-host'));
  let requests = new AbortController();
  const error = (message = '') => { el('admin-error').textContent = message; el('admin-error').hidden = !message; };
  async function request<T>(path: string): Promise<T> {
    const response = await fetch(`/api/diagnostics${path}`, { cache: 'no-store', signal: requests.signal });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Diagnostics request failed.'); return value;
  }
  function setLive(value: boolean) { live = value; follow.classList.toggle('active', value); follow.setAttribute('aria-pressed', String(value)); follow.textContent = value ? 'Ⅱ Pause feed' : '▶ Resume feed'; }
  function empty(message: string, detail: string) {
    const block = document.createElement('div'); block.className = 'admin-empty';
    const symbol = document.createElement('span'); symbol.textContent = '⌁';
    const title = document.createElement('strong'); title.textContent = message;
    const body = document.createElement('p'); body.textContent = detail; block.append(symbol, title, body); timeline.replaceChildren(block);
  }
  function preview(event: Event) {
    const value = event.value as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return String(value ?? '');
    if (Array.isArray(value.summary)) return value.summary.join(' ') || String(value.availability ?? 'No summary recorded.');
    if (value.type === 'recorded-reasoning-summary') return String(value.availability ?? 'No summary recorded.');
    for (const key of ['text', 'message', 'reason', 'error', 'availability']) if (typeof value[key] === 'string') return value[key] as string;
    if (value.message && typeof value.message === 'object' && 'text' in value.message) return String(value.message.text);
    if (value.arguments) return `${value.name ?? value.tool ?? ''}(${JSON.stringify(value.arguments)})`;
    if (value.hex) return `${value.direction ?? ''} · ${value.bytes ?? ''} bytes · ${value.validation ?? 'wire record'}`;
    if (value.payload) return `${value.direction ?? ''} · ${value.topic ?? ''}`;
    return JSON.stringify(value);
  }
  function addActors(actors: string[]) {
    const known = new Set(Array.from(role.options, option => option.value));
    for (const actor of actors) if (actor && !known.has(actor)) {
      const option = document.createElement('option'); option.value = actor; option.textContent = roleName(actor); role.append(option); known.add(actor);
    }
  }
  function renderEvents() {
    addActors(events.map(event => event.role));
    el('admin-event-count').textContent = `${events.length} events loaded`;
    el<HTMLButtonElement>('admin-older').disabled = !hasOlder || busy;
    el<HTMLButtonElement>('admin-export').disabled = !session.value;
    el<HTMLButtonElement>('admin-export-view').disabled = !events.length;
    if (!events.length) { empty(session.value ? 'No matching events in this window.' : 'Your next session starts here.', session.value ? 'Try another category or actor, clear your search, or load earlier events.' : 'Launch the fleet from the flight deck to create a session log. Historical local sessions appear here too.'); return; }
    const oldScroll = timeline.scrollTop, fragment = document.createDocumentFragment();
    for (const event of events) {
      const row = document.createElement('details'); row.className = `admin-event category-${event.category}`; row.open = opened.has(event.offset);
      const summary = document.createElement('summary');
      const meta = document.createElement('div'); meta.className = 'admin-event-meta';
      const time = document.createElement('time'); time.dateTime = event.wallTime; time.textContent = date(event.wallTime);
      const actor = document.createElement('span'); actor.className = `admin-actor ${event.role}`; actor.textContent = roleName(event.role);
      if (event.role.startsWith('drone-')) actor.style.color = dronePresentation(event.role).color;
      meta.append(time, actor);
      const body = document.createElement('div'); body.className = 'admin-event-body';
      const title = document.createElement('strong'); title.textContent = event.title;
      const text = document.createElement('p'); text.textContent = preview(event).slice(0, 260);
      body.append(title, text);
      const badge = document.createElement('span'); badge.className = 'admin-category'; badge.textContent = event.category;
      summary.append(meta, body, badge);
      const details = document.createElement('div'); details.className = 'admin-event-detail';
      const label = document.createElement('span'); label.textContent = `RECORDED SOURCE · BYTE ${event.offset.toLocaleString()} · REDACTED`;
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ wallTime: event.wallTime, type: event.type, value: event.value }, null, 2);
      details.append(label, pre); row.append(summary, details);
      const replayTime = auditReplayTime(event.value);
      if (replayTime !== undefined) {
        summary.title = `Seek replay to ${replayTime.toFixed(2)} simulation seconds`;
        summary.addEventListener('click', () => replay.seek(replayTime));
      }
      row.addEventListener('toggle', () => { if (row.open) { opened.add(event.offset); setLive(false); } else opened.delete(event.offset); }); fragment.append(row);
    }
    timeline.replaceChildren(fragment); timeline.scrollTop = live ? timeline.scrollHeight : oldScroll;
  }
  function renderStatus(status: Status) {
    activeSession = status.activeSession;
    el('admin-runtime').textContent = status.runtime.status.replaceAll('_', ' ');
    el('admin-runtime').title = status.runtime.message;
    el('admin-model').textContent = `${status.runtime.model.replace('gpt-5.6-', '')} / ${status.runtime.effort} · mission ${status.mission}`;
    const ids = new Set(status.drones.map(drone => drone.id));
    const peers = status.network?.peers.filter(peer => ids.has(peer.id)) ?? [];
    el('admin-peer-count').replaceChildren(document.createTextNode(`${peers.filter(peer => peer.online).length} `));
    const suffix = document.createElement('em'); suffix.textContent = `/ ${status.drones.length} online`; el('admin-peer-count').append(suffix);
    el('admin-network-state').textContent = `Zenoh · ${status.network?.status ?? 'offline'} · MAVLink 2 UDP`;
    el('admin-pending').textContent = String(peers.reduce((sum, peer) => sum + peer.pending, status.network?.pendingMissions ?? 0));
    el('admin-usage').textContent = typeof status.runtime.usage === 'number' ? status.runtime.usage.toLocaleString() : '—';
    el('admin-live-state').textContent = status.running ? 'FLEET ACTIVE' : 'FLEET STANDBY';
    el('admin-live-state').classList.toggle('running', status.running);
    el('admin-updated').textContent = `Live server · ${new Date(status.serverTime).toLocaleTimeString()}`;
    const peersById = new Map(peers.map(peer => [peer.id, peer]));
    addActors(status.drones.map(drone => drone.id));
    const fragments = status.drones.map(drone => {
      const peer = peersById.get(drone.id), identity = dronePresentation(drone.id);
      const card = document.createElement('div'); card.className = `admin-peer ${drone.id}`; card.dataset.droneId = drone.id;
      const icon = document.createElement('span'); icon.className = 'admin-peer-icon'; icon.textContent = identity.shortLabel; icon.style.color = identity.color;
      const text = document.createElement('div'), title = document.createElement('strong'), info = document.createElement('small'); title.textContent = identity.label.toUpperCase();
      info.textContent = peer ? `${peer.peers} peers · ${peer.pending} pending · ${peer.inbox} inbox` : 'Radio bridge offline'; text.append(title, info);
      const state = document.createElement('span'); state.className = `admin-peer-state ${peer?.online ? 'online' : ''}`; state.textContent = peer?.online ? 'CONNECTED' : 'OFFLINE'; card.append(icon, text, state); return card;
    }); el('admin-peers').replaceChildren(...fragments);
    sessionInfo();
  }
  function sessionInfo() {
    const selected = sessions.find(item => item.id === session.value);
    el('admin-session-info').textContent = selected ? `${selected.id === activeSession ? 'CURRENT SESSION' : 'HISTORICAL SESSION'} · ${sizes(selected.bytes)}` : 'No local audit files';
    replay.setSession(session.value, session.value === activeSession);
  }
  async function refreshSessions() {
    const version = generation;
    const data = await request<{ sessions: Session[]; activeSession: string | null }>('/sessions');
    if (!visible || version !== generation) return false;
    const selected = session.value; sessions = data.sessions; activeSession = data.activeSession;
    session.replaceChildren(...sessions.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = `${date(item.updatedAt)}${item.id === data.activeSession ? ' · LIVE' : ''} · ${sizes(item.bytes)}`; return option; }));
    if (!sessions.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No sessions recorded yet'; session.append(option); }
    session.value = sessions.some(item => item.id === selected) ? selected : data.activeSession ?? sessions[0]?.id ?? '';
    sessionInfo(); sessionRefresh = Date.now();
    return selected !== session.value;
  }
  async function load(mode: 'latest' | 'older' | 'tail') {
    if (!visible) return;
    if (!session.value) { events = []; renderEvents(); return; }
    const version = generation, id = session.value;
    const params = new URLSearchParams({ limit: '150', category, role: role.value, q: search.value });
    if (mode === 'older') params.set('before', String(before));
    if (mode === 'tail') params.set('after', String(next));
    const page = await request<Page>(`/sessions/${encodeURIComponent(id)}/events?${params}`);
    if (version !== generation || id !== session.value || !visible) return;
    if (mode === 'latest') { events = page.events; opened.clear(); next = page.next; before = page.before; hasOlder = page.hasOlder; }
    if (mode === 'older') { events = [...page.events, ...events].slice(0, 600); before = page.before; hasOlder = page.hasOlder; }
    if (mode === 'tail') {
      const offsets = new Set(events.map(item => item.offset)); events = [...events, ...page.events.filter(item => !offsets.has(item.offset))].slice(-600); next = page.next;
      before = events[0]?.offset ?? page.before; hasOlder = before > 0;
    }
    el('admin-window').textContent = page.skipped ? `${page.skipped} oversized records omitted · 600-event view limit` : page.hasMore && mode === 'tail' ? 'Catching up with the session…' : 'Bounded event window · credentials and images omitted';
    if (mode === 'tail' && !page.events.length) return;
    renderEvents();
  }
  async function refresh(mode: 'latest' | 'older' | 'tail' = 'tail') {
    if (busy || !visible) return;
    const version = generation;
    busy = true; el<HTMLButtonElement>('admin-older').disabled = true;
    try {
      const results = await Promise.allSettled([request<Status>('/status').then(status => { if (visible && version === generation) renderStatus(status); }), Date.now() - sessionRefresh > 10_000 ? refreshSessions() : Promise.resolve(false)]);
      if (!visible || version !== generation) return;
      const selectionChanged = results[1].status === 'fulfilled' && results[1].value;
      if (live || mode !== 'tail' || selectionChanged) await load(selectionChanged ? 'latest' : mode);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status !== 'rejected' || !(failed.reason instanceof DOMException && failed.reason.name === 'AbortError')) error(failed?.status === 'rejected' ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '');
    } catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) error(failure instanceof Error ? failure.message : 'Could not read diagnostics.'); }
    finally { busy = false; el<HTMLButtonElement>('admin-older').disabled = !hasOlder; }
  }
  function filters() {
    requests.abort(); requests = new AbortController();
    generation++; events = []; next = 0; before = 0; hasOlder = false;
    const notes: Record<string, string> = { network: 'Zenoh application payloads, durable receipts, link changes and retries. Open payload records for topics and envelopes. This is not a TCP packet capture.', mavlink: 'Actual received MAVLink 2 datagrams with CRC validation, hexadecimal bytes and decoded fields. Telemetry and burst logging are sampled; records state their limits.', agents: 'Recorded agent messages, runtime events and runtime-provided reasoning summaries. Hidden reasoning is unavailable; older sessions may have no summaries.' };
    el('admin-evidence-note').textContent = notes[category] ?? 'Events are recorded evidence. Expand a row for the redacted source JSON. Opening a row pauses the feed.';
    renderEvents(); void latestWhenReady();
  }
  async function latestWhenReady() { if (!visible) return; if (busy) { setTimeout(() => void latestWhenReady(), 100); return; } await refresh('latest'); }
  panel.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(button => button.addEventListener('click', () => {
    category = button.dataset.category!; panel.querySelectorAll('[data-category]').forEach(item => { const selected = (item as HTMLElement).dataset.category === category; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', String(selected)); }); filters();
  }));
  session.addEventListener('change', () => { setLive(session.value === activeSession); sessionInfo(); filters(); });
  role.addEventListener('change', filters); search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(filters, 250); });
  follow.addEventListener('click', () => { setLive(!live); if (live) void latestWhenReady(); });
  el('admin-refresh').addEventListener('click', () => { setLive(true); void latestWhenReady(); });
  el('admin-older').addEventListener('click', () => { setLive(false); void refresh('older'); });
  function download(blob: Blob, name: string) { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
  el('admin-export-view').addEventListener('click', () => download(new Blob(events.map(event => JSON.stringify({ wallTime: event.wallTime, type: event.type, value: event.value }) + '\n'), { type: 'application/x-ndjson' }), `visible-${session.value}`));
  el('admin-export').addEventListener('click', async () => {
    const button = el<HTMLButtonElement>('admin-export'); button.disabled = true; button.textContent = 'Exporting…';
    try { const response = await fetch(`/api/diagnostics/sessions/${encodeURIComponent(session.value)}/download`); if (!response.ok) throw new Error((await response.json()).error); download(await response.blob(), session.value); }
    catch (failure) { error(failure instanceof Error ? failure.message : 'Export failed.'); }
    finally { button.disabled = false; button.textContent = '↓ Export log'; }
  });
  function close() { location.hash = previousHash; }
  el('admin-back').addEventListener('click', event => { event.preventDefault(); close(); });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(panel.querySelectorAll<HTMLElement>('a,button:not(:disabled),select,input,summary'));
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
  });
  async function poll() { await refresh(); if (visible) timer = setTimeout(() => void poll(), 1500); }
  function route() {
    const open = location.hash === '#admin'; if (open === visible) return;
    visible = open; panel.hidden = !open; generation++;
    requests.abort(); requests = new AbortController(); replay.setVisible(open);
    const app = document.querySelector<HTMLElement>('#app'); if (app) app.inert = open;
    clearTimeout(timer);
    if (open) {
      restoreFocus = document.activeElement as HTMLElement; previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden'; el('admin-back').focus(); sessionRefresh = 0;
      void refresh('latest').then(() => { if (visible) timer = setTimeout(() => void poll(), 1500); });
    } else { document.body.style.overflow = previousOverflow; restoreFocus?.focus(); previousHash = location.hash; }
  }
  window.addEventListener('hashchange', route); if (location.hash !== '#admin') previousHash = location.hash; route();
  return { open: () => { location.hash = 'admin'; }, close };
}
