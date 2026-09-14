import type { WorldState } from './types';
import type { DroneViewport } from './scene';
import { dronePresentation } from './drone-presentation';
import { DroneRadio } from './drone-radio';
import { EQUIPMENT_MODULES, RTS_CONFIG } from '../shared/rts';
import { onboardPresentation } from './onboard-presentation';
import { batteryPresentation, chargingPresentation, equippedModuleCount, servicePresentation } from './equipment-presentation';

type Panels = { card: HTMLElement; mapItem: HTMLElement; networkItem: HTMLElement; radio: DroneRadio };

/** Reconciles all per-drone panels by identity and owns their telemetry display. */
export class FleetPanels {
  private panels = new Map<string, Panels>();
  private signature = '';
  constructor(private feeds: HTMLElement, private mapList: HTMLElement, private network: HTMLElement, private onLink: (id: string) => void) {}

  reconcile(ids: readonly string[]): DroneViewport[] | undefined {
    const signature = JSON.stringify(ids);
    if (signature === this.signature) return;
    this.signature = signature;
    this.feeds.querySelectorAll('.feed-team-heading').forEach(heading => heading.remove());
    for (const [id, items] of this.panels) if (!ids.includes(id)) {
      items.card.remove(); items.mapItem.remove(); items.networkItem.remove(); this.panels.delete(id);
    }
    const ordered = [...ids].sort((a, b) => (dronePresentation(a).team === 'red' ? 1 : 0) - (dronePresentation(b).team === 'red' ? 1 : 0));
    let lastTeam: string | undefined;
    for (const id of ordered) {
      const team = dronePresentation(id).team ?? 'blue';
      if (team !== lastTeam) {
        const heading = document.createElement('div'); heading.className = `feed-team-heading team-${team}`;
        heading.innerHTML = `<strong>${team === 'blue' ? 'YOUR BLUE SWARM' : 'ENEMY RED SWARM'}</strong><span>OPTICAL FEEDS · ${ordered.filter(value => (dronePresentation(value).team ?? 'blue') === team).length} INDEPENDENT PILOTS</span>`;
        this.feeds.append(heading); lastTeam = team;
      }
      let items = this.panels.get(id);
      if (!items) { items = this.create(id); this.panels.set(id, items); }
      this.feeds.append(items.card); this.mapList.append(items.mapItem); this.network.append(items.networkItem);
    }
    this.feeds.setAttribute('aria-label', `${ids.length} drone camera views`);
    return ids.map(droneId => ({ droneId, view: this.panels.get(droneId)!.card.querySelector<HTMLElement>('.viewport')! }));
  }

  private create(id: string): Panels {
    const identity = dronePresentation(id), suffix = id.replace(/^drone-/, '');
    const card = document.createElement('article'); card.className = `feed-card team-${identity.team ?? 'blue'}`; card.dataset.drone = id; card.dataset.droneId = id;
    card.innerHTML = `<header class="feed-header"><div><span class="drone-dot"></span><h2></h2></div><span class="drone-connection">OFFLINE</span></header>
      <div class="viewport"><div class="camera-top"><span>FPV <i></i> <b class="camera-mode">WIDE</b></span><span class="heading">HDG 000°</span></div><div class="reticle" aria-hidden="true"><span></span><span></span></div><div class="camera-bottom"><span class="altitude">POS Y <b>—</b></span><span class="sensor-count">0 OBS</span></div><div class="camera-vignette" aria-hidden="true"></div></div>
      <div class="loadout-strip"><span data-item="gun" title="Gun · one module slot">↗ Gun</span><span data-item="cargo" title="Cargo module · one module slot · two crates total">◆ Cargo</span><span data-item="miner" title="Historical mining drill" hidden>◆ Drill</span><span data-item="optics" title="Optics · one module slot · wide/zoom camera">◎ Optics</span><span data-item="battery" title="Extra battery · one module slot · increased charge capacity">▰ Battery</span><span data-item="jammer" title="Historical jammer" hidden>⌁ Jammer</span><span data-item="armor" title="Armor · separate one-hit protection">⬡ Armor</span></div>
      <div class="equipment-state"><span class="module-count">0/2 MODULES</span><span class="ammo-status"></span><strong class="mining-status"></strong></div>
      <div class="endurance-state"><span class="battery-status">BATTERY —</span><progress class="battery-meter" max="100" value="0" aria-label="Battery charge" hidden></progress><span class="jamming-status" hidden></span><span class="interference-status" title="Peer radio is interrupted; the local camera and flight controls remain available." hidden>RADIO JAMMED</span></div>
      <div class="charging-status" hidden><span class="charging-label"></span><progress class="charging-progress" max="100" value="0" aria-label="Battery charging progress"></progress></div>
      <div class="service-status" hidden><span class="service-label"></span><progress class="service-progress" max="1" value="0" aria-label="Rearming progress"></progress></div>
      <div class="cargo-state" hidden><strong class="cargo-label"></strong><span class="logistics-label"></span><progress class="cargo-progress" max="1" value="0" aria-label="Cargo service progress" hidden></progress></div>
      <details class="onboard-state"><summary class="job-label">LOCAL CONTROLLER · IDLE</summary><span class="source-label"></span><span class="storage-label">Storage usage unavailable.</span></details>
      <footer class="feed-footer"><div class="activity"><span class="activity-dot"></span><span class="activity-text">Awaiting launch</span></div><div class="coordinates"><span>X <b class="coord-x">—</b></span><span>Y <b class="coord-y">—</b></span><span>Z <b class="coord-z">—</b></span></div></footer>`;
    const destroyed = document.createElement('div'); destroyed.className = 'destroyed-overlay'; destroyed.innerHTML = '<strong>SIGNAL LOST</strong><span>DRONE ELIMINATED</span>'; card.querySelector('.viewport')!.append(destroyed);
    card.querySelector('h2')!.textContent = identity.label.toUpperCase();
    card.querySelector<HTMLElement>('.viewport')!.id = `view-${suffix}`;
    card.querySelector<HTMLElement>('.drone-dot')!.style.background = identity.color;
    const mapItem = document.createElement('div'); mapItem.className = 'map-fleet-item'; mapItem.dataset.droneId = id;
    mapItem.innerHTML = '<span class="drone-dot"></span><div><strong></strong><span class="map-fleet-status">Awaiting launch</span></div>';
    mapItem.querySelector('strong')!.textContent = identity.label.toUpperCase();
    mapItem.querySelector<HTMLElement>('.drone-dot')!.style.background = identity.color;
    mapItem.querySelector('.map-fleet-status')!.id = `map-${id}`;
    const networkItem = document.createElement('div'); networkItem.className = 'network-peer'; networkItem.dataset.droneId = id;
    networkItem.innerHTML = '<div><strong></strong><span>Offline</span></div><button class="button button-stop" disabled>Isolate</button>';
    networkItem.querySelector('strong')!.textContent = identity.label.toUpperCase();
    networkItem.querySelector('span')!.id = `network-info-${suffix}`;
    const button = networkItem.querySelector('button')!; button.id = `network-link-${suffix}`; button.addEventListener('click', () => this.onLink(id));
    const radioRoot = document.createElement('section'); radioRoot.className = 'drone-radio'; card.append(radioRoot);
    const radio = new DroneRadio(radioRoot, id);
    return { card, mapItem, networkItem, radio };
  }

  update(state: WorldState, connectionReady: boolean) {
    const peers = new Map(state.network?.peers.map(peer => [peer.id, peer]) ?? []);
    for (const drone of state.drones) {
      const items = this.panels.get(drone.id); if (!items) continue;
      items.radio.update(state.radio);
      const put = (selector: string, value: string) => { items.card.querySelector<HTMLElement>(selector)!.textContent = value; };
      const interfered = drone.alive !== false && Boolean(drone.radioJammed);
      put('.drone-connection', drone.alive === false ? 'ELIMINATED' : interfered ? 'RADIO JAMMED' : drone.online ? 'CONNECTED' : 'OFFLINE'); items.card.classList.toggle('drone-online', drone.online);
      items.card.classList.toggle('radio-jammed', interfered);
      items.card.classList.toggle('drone-eliminated', drone.alive === false);
      items.mapItem.classList.toggle('eliminated', drone.alive === false);
      for (const item of [...EQUIPMENT_MODULES, 'armor'] as const) items.card.querySelector(`[data-item="${item}"]`)!.classList.toggle('equipped', Boolean(drone.equipment?.[item]));
      put('[data-item="miner"]', drone.equipment?.miner && drone.equipment.minerUpgrade ? '◆ Drill II' : '◆ Drill');
      const modules = equippedModuleCount(drone);
      put('.module-count', `${modules}/${RTS_CONFIG.moduleSlots} MODULES`);
      const armed = Boolean(drone.equipment?.gun), empty = armed && drone.ammo === 0;
      put('.ammo-status', armed ? drone.ammo === undefined ? 'AMMO —' : `${drone.ammo}/${RTS_CONFIG.magazineSize} ROUNDS` : '');
      items.card.querySelector('.ammo-status')!.classList.toggle('empty', empty);
      put('.camera-mode', drone.cameraMode === 'zoom' && drone.equipment?.optics ? 'ZOOM' : 'WIDE');
      const battery = batteryPresentation(drone), batteryMeter = items.card.querySelector<HTMLProgressElement>('.battery-meter')!;
      put('.battery-status', battery ? `BATTERY ${battery.percent}%` : 'BATTERY —');
      items.card.querySelector<HTMLElement>('.battery-status')!.title = battery ? `${battery.charge.toFixed(1)} / ${battery.capacity} charge${battery.low ? ' · Low battery' : ''}` : 'Battery state unavailable';
      batteryMeter.hidden = !battery; if (battery) batteryMeter.value = battery.percent;
      const charging = chargingPresentation(drone, battery);
      items.card.querySelector<HTMLElement>('.charging-status')!.hidden = !charging;
      if (charging) {
        put('.charging-label', charging.label);
        const progress = items.card.querySelector<HTMLProgressElement>('.charging-progress')!;
        progress.hidden = !battery; if (battery) progress.value = battery.percent;
      }
      items.card.querySelector('.endurance-state')!.classList.toggle('low-battery', Boolean(battery?.low));
      const jammer = items.card.querySelector<HTMLElement>('.jamming-status')!;
      jammer.hidden = !drone.equipment?.jammer; jammer.classList.toggle('active', Boolean(drone.jamming));
      jammer.textContent = drone.jamming === undefined ? 'JAMMER —' : drone.jamming ? 'JAMMER ON' : 'JAMMER OFF';
      items.card.querySelector<HTMLElement>('.interference-status')!.hidden = !interfered;
      const service = servicePresentation(drone.alive !== false ? drone.servicing : undefined);
      items.card.querySelector<HTMLElement>('.service-status')!.hidden = !service;
      if (service) {
        put('.service-label', `${service.label.toUpperCase()} · ${service.remaining.toFixed(1)}s`);
        const progress = items.card.querySelector<HTMLProgressElement>('.service-progress')!;
        progress.value = service.progress; progress.setAttribute('aria-label', `${service.label} progress`);
      }
      put('.mining-status', drone.mining && drone.alive !== false ? 'MINING' : '');
      const onboard = onboardPresentation(drone);
      items.card.querySelector<HTMLElement>('.cargo-state')!.hidden = !onboard.cargo;
      put('.cargo-label', onboard.cargo ?? ''); put('.logistics-label', onboard.logistics ?? '');
      const cargoProgress = items.card.querySelector<HTMLProgressElement>('.cargo-progress')!;
      cargoProgress.hidden = onboard.progress === undefined; cargoProgress.value = onboard.progress ?? 0;
      put('.job-label', onboard.job ?? 'LOCAL CONTROLLER · IDLE'); put('.source-label', onboard.source ?? '');
      put('.storage-label', onboard.storage ?? 'Storage usage unavailable.');
      put('.heading', `HDG ${Math.round(((360 - drone.yaw) % 360 + 360) % 360).toString().padStart(3, '0')}°`);
      put('.altitude b', drone.y.toFixed(3)); put('.sensor-count', `${drone.observations} OBS`);
      put('.activity-text', drone.status || (drone.online ? 'Listening' : 'Awaiting launch'));
      put('.coord-x', drone.x.toFixed(3)); put('.coord-y', drone.y.toFixed(3)); put('.coord-z', drone.z.toFixed(3));
      items.mapItem.querySelector('.map-fleet-status')!.textContent = `${drone.status} · Y ${drone.y.toFixed(3)}${onboard.cargo ? ` · ${onboard.cargo}` : ''}`;
      const peer = peers.get(drone.id), button = items.networkItem.querySelector('button')!;
      button.disabled = !connectionReady || state.network?.status !== 'online' || !state.running || !peer || interfered;
      button.textContent = interfered ? 'Jammed' : peer?.online ? 'Isolate' : 'Reconnect';
      items.networkItem.querySelector('span')!.textContent = peer ? `${interfered ? 'Radio jammed' : peer.online ? 'Connected' : 'Isolated'} · ${peer.peers} links · ${peer.pending} pending sends · ${peer.inbox} unread` : 'Offline';
    }
  }
}
