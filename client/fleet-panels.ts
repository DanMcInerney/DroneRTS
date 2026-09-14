import type { WorldState } from './types';
import type { DroneViewport } from './scene';
import { dronePresentation } from './drone-presentation';

type Panels = { card: HTMLElement; mapItem: HTMLElement; networkItem: HTMLElement };

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
      <div class="viewport"><div class="camera-top"><span>FPV <i></i> OPTICAL</span><span class="heading">HDG 000°</span></div><div class="reticle" aria-hidden="true"><span></span><span></span></div><div class="camera-bottom"><span class="altitude">POS Y <b>—</b></span><span class="sensor-count">0 OBS</span></div><div class="camera-vignette" aria-hidden="true"></div></div>
      <div class="loadout-strip"><span data-item="gun">↗ Gun</span><span data-item="armor">⬡ Armor</span><span data-item="miner">◆ Miner</span><strong class="mining-status"></strong></div>
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
    return { card, mapItem, networkItem };
  }

  update(state: WorldState, connectionReady: boolean) {
    const peers = new Map(state.network?.peers.map(peer => [peer.id, peer]) ?? []);
    for (const drone of state.drones) {
      const items = this.panels.get(drone.id); if (!items) continue;
      const put = (selector: string, value: string) => { items.card.querySelector<HTMLElement>(selector)!.textContent = value; };
      put('.drone-connection', drone.alive === false ? 'ELIMINATED' : drone.online ? 'CONNECTED' : 'OFFLINE'); items.card.classList.toggle('drone-online', drone.online);
      items.card.classList.toggle('drone-eliminated', drone.alive === false);
      items.mapItem.classList.toggle('eliminated', drone.alive === false);
      for (const item of ['gun', 'armor', 'miner'] as const) items.card.querySelector(`[data-item="${item}"]`)!.classList.toggle('equipped', Boolean(drone.equipment?.[item]));
      put('.mining-status', drone.mining && drone.alive !== false ? 'MINING' : '');
      put('.heading', `HDG ${Math.round(((360 - drone.yaw) % 360 + 360) % 360).toString().padStart(3, '0')}°`);
      put('.altitude b', drone.y.toFixed(1)); put('.sensor-count', `${drone.observations} OBS`);
      put('.activity-text', drone.status || (drone.online ? 'Listening' : 'Awaiting launch'));
      put('.coord-x', drone.x.toFixed(1)); put('.coord-y', drone.y.toFixed(1)); put('.coord-z', drone.z.toFixed(1));
      items.mapItem.querySelector('.map-fleet-status')!.textContent = `${drone.status} · Y ${drone.y.toFixed(1)}`;
      const peer = peers.get(drone.id), button = items.networkItem.querySelector('button')!;
      button.disabled = !connectionReady || state.network?.status !== 'online' || !state.running || !peer;
      button.textContent = peer?.online ? 'Isolate' : 'Reconnect';
      items.networkItem.querySelector('span')!.textContent = peer ? `${peer.online ? 'Connected' : 'Isolated'} · ${peer.peers} links · ${peer.pending} pending sends · ${peer.inbox} unread` : 'Offline';
    }
  }
}
