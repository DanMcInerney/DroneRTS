import './style.css';
import './explorer.css';
import './rts.css';
import './dashboard.css';
import './onboard.css';
import { FleetScene } from './scene';
import type { Pose, WorldState } from './types';
import { mountAdmin } from './admin';
import { MATCH_DRONE_IDS } from '../shared/fleet';
import { FleetPanels } from './fleet-panels';
import { layout } from './layout';
import { MatchPanel } from './match-panel';
import { DroneRadio } from './drone-radio';

const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = layout;
mountAdmin();

function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const startButton = element<HTMLButtonElement>('start');
const stopButton = element<HTMLButtonElement>('stop');
const resetButton = element<HTMLButtonElement>('reset');
const sendButton = element<HTMLButtonElement>('send');
const instruction = element<HTMLTextAreaElement>('instruction');
const speedSlider = element<HTMLInputElement>('speed');
const panels = new FleetPanels(element('fleet-feeds'), element('map-fleet-list'), element('network-peers'), async droneId => {
  const peer = state?.network?.peers.find(peer => peer.id === droneId);
  if (peer) await command('network/link', { droneId, online: !peer.online });
});
const initialViews = panels.reconcile(MATCH_DRONE_IDS)!;
const matchPanel = new MatchPanel();
const playerChat = new DroneRadio(element('player-chat'), 'operator', 'team');
let scene: FleetScene | undefined;
let state: WorldState | undefined;
let socket: WebSocket | undefined;
let connected = false;
let busy = false;
let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

function alertMessage(message: string) { element('alert-text').textContent = message; element('alert').hidden = false; }
try { scene = new FleetScene(element('world-views'), initialViews, element('overview-map')); scene.fitOverview(true); }
catch (error) { alertMessage(`The 3D view could not start. Enable WebGL and reload. ${error instanceof Error ? error.message : ''}`); element('fleet-feeds').classList.add('webgl-unavailable'); }

function clock(time: number) { const tenths = Math.max(0, Math.round(time * 10)); const minutes = Math.floor(tenths / 600).toString().padStart(2, '0'); return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`; }
function updateControls() {
  const active = Boolean(state?.running) || ['starting', 'running', 'bootstrapping', 'stopping'].includes(state?.runtime.status ?? '');
  startButton.disabled = !connected || busy || active || !scene || state?.match?.phase === 'finished';
  stopButton.disabled = !connected || !active;
  resetButton.disabled = !connected || busy || active;
  sendButton.disabled = !connected || busy || !state?.running || !instruction.value.trim();
  element<HTMLButtonElement>('replace-objective').disabled = sendButton.disabled;
  element<HTMLButtonElement>('play-again').disabled = !connected || busy;
  if (state) panels.update(state, connected && !busy);
}
function setConnection(value: boolean) { connected = value; element('connection-text').textContent = value ? 'Simulator connected' : 'Reconnecting to simulator'; element('connection-dot').classList.toggle('online', value); updateControls(); }

function renderState(next: WorldState) {
  state = next;
  const views = panels.reconcile(next.drones.map(drone => drone.id));
  if (views) scene?.setViews(views);
  scene?.update(next);
  matchPanel.update(next);
  playerChat.update(next.radio);
  element('clock').textContent = clock(next.simTime);
  element('mission-version').textContent = `MISSION ${next.mission ? String(next.mission).padStart(2, '0') : '—'}`;
  element('runtime-status').textContent = next.match?.phase === 'finished' ? 'MATCH COMPLETE' : next.runtime.status.replaceAll('_', ' ').toUpperCase();
  element('runtime-message').textContent = next.runtime.message || (next.running ? 'Fleet session is active.' : 'Ready when you are.');
  element('runtime-dot').className = `status-dot ${next.completed ? 'complete' : next.running ? 'online' : next.runtime.status === 'error' ? 'error' : ''}`;
  element('session-id').textContent = next.runtime.threadId ? `SESSION ${next.runtime.threadId.slice(0, 8)} · LUNA / XHIGH` : 'Two swarms. Six independent pilots.';
  if (document.activeElement !== speedSlider) speedSlider.value = String(next.speed);
  element('speed-value').textContent = `${next.speed}×`;
  element('network-status').textContent = next.network?.message ?? 'Launch the fleet to connect.';
  updateControls();
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
  element('alert').hidden = true; element('mission-feedback').textContent = `Starting both teams and ${state?.drones.length ?? MATCH_DRONE_IDS.length} independent Luna drone agents…`;
  const result = await command('start'); element('mission-feedback').textContent = result === undefined ? 'Launch failed. See the notice above.' : 'Both teams launched. Their objectives and commander briefings are queued automatically.';
});
stopButton.addEventListener('click', async () => { await command('stop'); element('mission-feedback').textContent = 'Match stopped. Reset to restore drones, resources and equipment.'; });
resetButton.addEventListener('click', async () => { if (await command('reset') !== undefined) element('mission-feedback').textContent = 'World reset. Launch the match for a fresh six-drone battle.'; });
element('play-again').addEventListener('click', async event => {
  event.stopPropagation();
  if (state?.running && await command('stop') === undefined) return;
  if (await command('reset') !== undefined) element('mission-feedback').textContent = 'New match ready. Launch when you are ready.';
});
element('match-result').addEventListener('click', event => event.stopPropagation());
element('match-result').addEventListener('keydown', event => event.stopPropagation());
element('mission-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = instruction.value.trim(); if (!text || sendButton.disabled) return;
  if (await command('chat', { text }) !== undefined) { instruction.value = ''; updateControls(); element('mission-feedback').textContent = 'Blue chat queued. Delivery stages and actual replies appear above.'; }
});
element('replace-objective').addEventListener('click', async () => {
  const text = instruction.value.trim(); if (!text || sendButton.disabled) return;
  if (await command('mission', { text }) !== undefined) element('mission-feedback').textContent = 'New blue objective queued. Each drone cancels old work only when it receives the replacement.';
});
instruction.addEventListener('input', updateControls);
instruction.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); element<HTMLFormElement>('mission-form').requestSubmit(); } });
speedSlider.addEventListener('input', () => { element('speed-value').textContent = `${speedSlider.value}×`; });
speedSlider.addEventListener('change', () => { void command('speed', { speed: Number(speedSlider.value) }); });
element('dismiss-alert').addEventListener('click', () => { element('alert').hidden = true; });
for (const scope of ['entire', 'downtown']) element(`map-${scope}`).addEventListener('click', () => {
  scene?.fitOverview(scope === 'downtown');
  for (const option of ['entire', 'downtown']) element(`map-${option}`).setAttribute('aria-pressed', String(option === scope));
});

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
        const image = scene.capture(message.droneId as string, message.pose as Pose, message.drones, message.match);
        socket?.send(JSON.stringify({ type: 'capture-result', requestId: message.requestId, image }));
      }
    } catch (error) { alertMessage(error instanceof Error ? error.message : String(error)); }
  });
}
connect();
fetch('/api/state').then(response => { if (!response.ok) throw new Error('Simulator state unavailable.'); return response.json(); }).then(renderState).catch(() => {});
window.addEventListener('pagehide', () => { if (reconnectTimeout) clearTimeout(reconnectTimeout); scene?.dispose(); socket?.close(); });
