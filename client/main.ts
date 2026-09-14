import './style.css';
import './explorer.css';
import { FleetScene } from './scene';
import type { Pose, WorldState } from './types';
import { mountAdmin } from './admin';
import { DRONE_IDS } from '../shared/fleet';
import { dronePresentation } from './drone-presentation';
import { FleetPanels } from './fleet-panels';

const defaultMission = 'Find the treasure chests scattered around the city. Fly close enough to inspect each chest with your camera, then report it to the fleet using a found radio message. Share discoveries and coordinate your search.';
const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="Fleet home"><span class="brand-symbol" aria-hidden="true">F</span>FLEET<span class="brand-label">CINCINNATI FIELD LAB</span></a>
    <div class="header-links"><a class="admin-link" href="#admin">Admin <span aria-hidden="true">↗</span></a><div class="connection"><span class="status-dot" id="connection-dot"></span><span id="connection-text">Connecting to simulator</span></div></div>
  </header>
  <main>
    <section class="mission-header">
      <div><div class="eyebrow">DOWNTOWN CINCINNATI <span>/</span> THE TREASURE HUNT</div><h1>A city to explore.<br class="mobile-break" /> Treasure to discover.</h1><p id="fleet-intro">A fleet of drones. Riverfront streets. A skyline full of possibilities.</p></div>
      <div class="session-controls"><button id="reset" class="button button-subtle" title="Reset the world after stopping">Reset world</button><button id="stop" class="button button-stop" disabled><span class="stop-icon" aria-hidden="true"></span>Stop fleet</button><button id="start" class="button button-primary" disabled><span class="play-icon" aria-hidden="true"></span>Launch fleet</button></div>
    </section>
    <section class="session-strip" aria-label="Session status">
      <div class="session-state"><span class="status-dot" id="runtime-dot"></span><strong id="runtime-status">STANDBY</strong><span id="runtime-message">Connect to the local server to begin.</span></div>
      <div class="session-metadata"><span class="model-chip">LUNA <span>/ XHIGH</span></span><span class="session-clock" id="clock">00:00.0</span><span class="version-label" id="mission-version">MISSION —</span></div>
    </section>
    <div id="alert" class="alert" role="alert" hidden><span id="alert-text"></span><button id="dismiss-alert" aria-label="Dismiss notice">×</button></div>
    <section class="city-progress" aria-label="Treasure hunt progress"><div><span class="treasure-emblem" aria-hidden="true">◆</span><strong>TREASURE HUNT</strong><span>Explore · inspect · share</span></div><div class="treasure-score"><strong id="treasure-found">0</strong><span>/ <span id="treasure-total">—</span> chests found</span><progress id="treasure-progress" value="0" max="1" aria-label="Chests found"></progress></div></section>
    <div class="world-views" id="world-views"><section class="fleet-feeds" id="fleet-feeds" aria-label="Drone camera views">
    </section>
    <section class="overview-panel panel" aria-label="Live overhead map">
      <header class="panel-header"><div><span class="eyebrow">A VIEW OF THE WHOLE FIELD</span><h2>Above Cincinnati <span class="map-live"><i></i> LIVE</span></h2></div><div class="map-actions"><button class="button button-stop" id="map-entire" aria-pressed="true">Entire map</button><button class="button button-stop" id="map-downtown" aria-pressed="false">Downtown</button></div></header>
      <div class="overview-body"><div class="overview-map" id="overview-map" role="button" tabindex="0" aria-label="Enter god view at this map location"><span class="map-north" aria-hidden="true">↑<br>N</span><span class="map-enter-hint">Click anywhere to explore <span>↗</span></span></div>
        <aside class="map-sidebar"><div><span class="eyebrow">YOUR EYES IN THE SKY</span><h3>Follow their flight.</h3><p>Watch the fleet cross the city, or step inside the map and explore for yourself.</p></div><div class="map-fleet-list" id="map-fleet-list"></div><div class="map-explore-help"><strong>Free to roam.</strong><p>You're an invisible observer. Fly through the city with <kbd>WASD</kbd>, look with your mouse, and hold <kbd>Shift</kbd> for speed.</p><span><kbd>Q / E</kbd> Down / up &nbsp; <kbd>Esc</kbd> Exit</span></div></aside></div>
      <footer class="map-footer"><span>North up · arrows show heading · dashed lines show destinations</span><span>Full city bounds · detailed downtown core</span></footer>
    </section></div>
    <section class="workspace-panels">
      <article class="radio-panel panel">
        <header class="panel-header"><div><span class="eyebrow">FLEET COMMUNICATIONS</span><h2>On the radio<span class="count-badge" id="radio-count">0</span></h2></div><label class="follow-toggle"><input id="follow-radio" type="checkbox" checked /> Follow live</label></header>
        <div id="radio-log" class="radio-log" role="log" aria-label="Messages sent between drones" aria-live="polite" aria-relevant="additions"></div>
        <footer class="radio-footer"><span><i></i> Zenoh peer messages</span><span>Shared goal · independent decisions</span></footer>
      </article>
      <article class="command-panel panel">
        <header class="panel-header"><div><span class="eyebrow">YOU SET THE OBJECTIVE</span><h2>Mission control</h2></div><span class="command-number">↗</span></header>
        <form id="mission-form"><label class="input-label" for="instruction">Tell the fleet what to achieve</label><textarea id="instruction" name="instruction" maxlength="4000" rows="5" placeholder="${defaultMission}">${defaultMission}</textarea><div class="input-hint"><span>Sent unchanged to every drone.</span><span>Ctrl ↵</span></div><button id="send" class="button button-send" type="submit" disabled>Send instruction <span aria-hidden="true">↗</span></button><p class="mission-feedback" id="mission-feedback" aria-live="polite">Launch the fleet, then send your first instruction.</p></form>
        <div class="speed-control"><div><label for="speed">Simulation speed</label><output id="speed-value" for="speed">1×</output></div><input id="speed" type="range" min="0.25" max="2" step="0.25" value="1" /><div class="speed-caption"><span>Give them time to think</span><span>Move faster</span></div></div>
      </article>
    </section>
    <section class="network-lab panel" aria-label="Network lab"><div class="network-heading"><div><span class="eyebrow">NETWORK LAB</span><h2>Break a link. Watch them adapt.</h2><p>Real Zenoh peers and MAVLink packets on this computer. Link interruptions simulate a mesh partition.</p></div><span id="network-status">Launch the fleet to connect.</span></div><div class="network-peers" id="network-peers"></div><p class="network-note">An isolated drone keeps sensing and following its last received mission. Peer messages and new instructions queue until reconnection or expiry. Radio range and radio interference are not simulated.</p></section>
    <footer class="page-footer"><span><span class="footer-mark">F</span> Cincinnati, simplified. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data © OpenStreetMap contributors</a><a href="https://services.arcgis.com/JyZag7oO4NteHGiq/ArcGIS/rest/services/Open_Data_Feature_Collection/FeatureServer" target="_blank" rel="noreferrer">River & city bounds: CAGIS</a></span><span id="session-id">A parent relays. The drones coordinate.</span></footer>
  </main>`;
mountAdmin();

function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const startButton = element<HTMLButtonElement>('start');
const stopButton = element<HTMLButtonElement>('stop');
const resetButton = element<HTMLButtonElement>('reset');
const sendButton = element<HTMLButtonElement>('send');
const instruction = element<HTMLTextAreaElement>('instruction');
const speedSlider = element<HTMLInputElement>('speed');
const radioLog = element('radio-log');
const panels = new FleetPanels(element('fleet-feeds'), element('map-fleet-list'), element('network-peers'), async droneId => {
  const peer = state?.network?.peers.find(peer => peer.id === droneId);
  if (peer) await command('network/link', { droneId, online: !peer.online });
});
const initialViews = panels.reconcile(DRONE_IDS)!;
let scene: FleetScene | undefined;
let state: WorldState | undefined;
let socket: WebSocket | undefined;
let connected = false;
let busy = false;
let radioSignature = '';
let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

function alertMessage(message: string) { element('alert-text').textContent = message; element('alert').hidden = false; }
try { scene = new FleetScene(element('world-views'), initialViews, element('overview-map')); }
catch (error) { alertMessage(`The 3D view could not start. Enable WebGL and reload. ${error instanceof Error ? error.message : ''}`); element('fleet-feeds').classList.add('webgl-unavailable'); }

function clock(time: number) { const minutes = Math.floor(time / 60).toString().padStart(2, '0'); return `${minutes}:${(time % 60).toFixed(1).padStart(4, '0')}`; }
function updateControls() {
  const active = Boolean(state?.running) || ['starting', 'running', 'bootstrapping', 'stopping'].includes(state?.runtime.status ?? '');
  startButton.disabled = !connected || busy || active || !scene;
  stopButton.disabled = !connected || !active;
  resetButton.disabled = !connected || busy || active;
  sendButton.disabled = !connected || busy || !state?.running || !instruction.value.trim();
  if (state) panels.update(state, connected && !busy);
}
function setConnection(value: boolean) { connected = value; element('connection-text').textContent = value ? 'Simulator connected' : 'Reconnecting to simulator'; element('connection-dot').classList.toggle('online', value); updateControls(); }

function renderRadio(messages: WorldState['radio']) {
  const signature = `${messages.length}:${messages[0]?.id}:${messages.at(-1)?.id}`;
  if (signature === radioSignature) return;
  radioSignature = signature; element('radio-count').textContent = String(messages.length);
  if (!messages.length) {
    radioLog.replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty-radio';
    empty.innerHTML = '<div class="radio-icon" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><strong>The airwaves are quiet.</strong><p>Peer messages appear here as the drones explore,<br />share discoveries, and choose their next moves.</p><span>Only messages actually sent by the fleet are shown.</span>';
    radioLog.append(empty); return;
  }
  const follow = element<HTMLInputElement>('follow-radio').checked, oldScroll = radioLog.scrollTop;
  const fragment = document.createDocumentFragment();
  messages.forEach(message => {
    const row = document.createElement('article'); row.className = `radio-message ${message.from.startsWith('drone-') ? message.from : 'system-message'}`;
    const meta = document.createElement('div'); meta.className = 'radio-meta';
    const sender = document.createElement('strong'); sender.textContent = dronePresentation(message.from).label.toUpperCase();
    if (message.from.startsWith('drone-')) sender.style.color = dronePresentation(message.from).color;
    const recipient = document.createElement('span'); recipient.textContent = `→ ${message.to === 'all' ? 'FLEET' : dronePresentation(message.to).label.toUpperCase()}`;
    const kind = document.createElement('span'); kind.className = 'message-kind'; kind.textContent = message.kind;
    const time = document.createElement('time'); time.textContent = clock(message.simTime);
    const body = document.createElement('p'); body.textContent = message.text;
    meta.append(sender, recipient, kind, time); row.append(meta, body); fragment.append(row);
  });
  radioLog.replaceChildren(fragment); radioLog.scrollTop = follow ? radioLog.scrollHeight : oldScroll;
}

function renderState(next: WorldState) {
  state = next;
  const views = panels.reconcile(next.drones.map(drone => drone.id));
  if (views) scene?.setViews(views);
  scene?.update(next);
  element('fleet-intro').textContent = `${next.drones.length} drones. Riverfront streets. A skyline full of possibilities.`;
  const treasuresFound = next.treasures.filter(treasure => treasure.found).length;
  element('treasure-found').textContent = String(treasuresFound); element('treasure-total').textContent = String(next.treasures.length);
  const progress = element<HTMLProgressElement>('treasure-progress'); progress.max = Math.max(1, next.treasures.length); progress.value = treasuresFound;
  element('clock').textContent = clock(next.simTime);
  element('mission-version').textContent = `MISSION ${next.mission ? String(next.mission).padStart(2, '0') : '—'}`;
  element('runtime-status').textContent = next.completed ? 'OBJECTIVE COMPLETE' : next.runtime.status.replaceAll('_', ' ').toUpperCase();
  element('runtime-message').textContent = next.runtime.message || (next.running ? 'Fleet session is active.' : 'Ready when you are.');
  element('runtime-dot').className = `status-dot ${next.completed ? 'complete' : next.running ? 'online' : next.runtime.status === 'error' ? 'error' : ''}`;
  element('session-id').textContent = next.runtime.threadId ? `SESSION ${next.runtime.threadId.slice(0, 8)} · LUNA / XHIGH` : 'A parent relays. The drones coordinate.';
  if (document.activeElement !== speedSlider) speedSlider.value = String(next.speed);
  element('speed-value').textContent = `${next.speed}×`;
  element('network-status').textContent = next.network?.message ?? 'Launch the fleet to connect.';
  renderRadio(next.radio); updateControls();
}

async function post(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`); return result;
}
async function command(path: string, body?: unknown) {
  busy = true; updateControls();
  try { return await post(path, body); } catch (error) { alertMessage(error instanceof Error ? error.message : String(error)); return undefined; }
  finally { busy = false; updateControls(); }
}
startButton.addEventListener('click', async () => {
  element('alert').hidden = true; element('mission-feedback').textContent = `Starting the parent and ${state?.drones.length ?? DRONE_IDS.length} Luna drone agents…`;
  const result = await command('start'); element('mission-feedback').textContent = result === undefined ? 'Launch failed. See the notice above.' : 'Fleet launched. Send your first instruction when the session is ready.';
});
stopButton.addEventListener('click', async () => { await command('stop'); element('mission-feedback').textContent = 'Fleet stopped. Launch again or reset the world.'; });
resetButton.addEventListener('click', async () => { if (await command('reset') !== undefined) element('mission-feedback').textContent = 'World reset. Launch the fleet to start a fresh mission.'; });
element('mission-form').addEventListener('submit', async event => { event.preventDefault(); const text = instruction.value.trim(); if (!text || sendButton.disabled) return; if (await command('mission', { text }) !== undefined) element('mission-feedback').textContent = 'Instruction queued for the relay. Watch the radio for the fleet’s response.'; });
instruction.addEventListener('input', updateControls);
instruction.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); element<HTMLFormElement>('mission-form').requestSubmit(); } });
speedSlider.addEventListener('input', () => { element('speed-value').textContent = `${speedSlider.value}×`; });
speedSlider.addEventListener('change', () => { void command('speed', { speed: Number(speedSlider.value) }); });
element('dismiss-alert').addEventListener('click', () => { element('alert').hidden = true; });
for (const scope of ['entire', 'downtown']) element(`map-${scope}`).addEventListener('click', () => {
  scene?.fitOverview(scope === 'downtown');
  for (const option of ['entire', 'downtown']) element(`map-${option}`).setAttribute('aria-pressed', String(option === scope));
});
element('follow-radio').addEventListener('change', () => { if (element<HTMLInputElement>('follow-radio').checked) radioLog.scrollTop = radioLog.scrollHeight; });

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.addEventListener('open', () => setConnection(true));
  socket.addEventListener('close', () => { setConnection(false); reconnectTimeout = setTimeout(connect, 1500); });
  socket.addEventListener('error', () => setConnection(false));
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === 'state') renderState(message.state as WorldState);
      if (message.type === 'capture') {
        if (!scene) throw new Error('Cannot return a camera observation because WebGL is unavailable.');
        const image = scene.capture(message.droneId as string, message.pose as Pose, message.drones);
        socket?.send(JSON.stringify({ type: 'capture-result', requestId: message.requestId, image }));
      }
    } catch (error) { alertMessage(error instanceof Error ? error.message : String(error)); }
  });
}
connect();
fetch('/api/state').then(response => { if (!response.ok) throw new Error('Simulator state unavailable.'); return response.json(); }).then(renderState).catch(() => {});
window.addEventListener('pagehide', () => { if (reconnectTimeout) clearTimeout(reconnectTimeout); scene?.dispose(); socket?.close(); });
