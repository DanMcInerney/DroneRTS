import type { WorldState } from './types';
import { dronePresentation } from './drone-presentation';

const element = (id: string) => document.getElementById(id)!;
const timestamp = (time: number) => `${Math.floor(time / 60).toString().padStart(2, '0')}:${Math.floor(time % 60).toString().padStart(2, '0')}`;

/** Spectator match information is DOM-only, so never enters optical observations. */
export class MatchPanel {
  private eventSignature = '';
  private rosterSignature = '';

  update(state: WorldState) {
    const match = state.match;
    element('match-phase').textContent = match?.phase === 'active' ? state.running ? 'IN PLAY' : 'STOPPED' : match?.phase === 'finished' ? 'FINAL' : 'READY';
    for (const team of ['blue', 'red'] as const) {
      const drones = state.drones.filter(drone => (drone.team ?? dronePresentation(drone.id).team ?? 'blue') === team);
      const alive = drones.filter(drone => drone.alive !== false).length;
      element(`${team}-alive`).replaceChildren(document.createTextNode(String(alive)));
      const total = document.createElement('span'); total.textContent = ` / ${drones.length}`; element(`${team}-alive`).append(total);
      element(`${team}-credits`).textContent = Math.floor((match?.teams[team].credits ?? 0) + 1e-9).toLocaleString();
    }
    const rosterSignature = JSON.stringify(state.drones.map(drone => [drone.id, drone.alive, drone.equipment]));
    if (rosterSignature !== this.rosterSignature) {
      this.rosterSignature = rosterSignature;
      for (const team of ['blue', 'red'] as const) {
        const roster = document.createDocumentFragment();
        for (const drone of state.drones.filter(drone => (drone.team ?? dronePresentation(drone.id).team ?? 'blue') === team)) {
          const card = document.createElement('div'); card.className = `roster-unit ${drone.alive === false ? 'eliminated' : ''}`;
          const name = document.createElement('strong'); name.textContent = dronePresentation(drone.id).label;
          const loadout = document.createElement('span');
          loadout.textContent = drone.alive === false ? 'ELIMINATED' : [drone.equipment?.gun && 'Gun', drone.equipment?.armor && 'Armor', drone.equipment?.miner && 'Miner'].filter(Boolean).join(' · ') || 'Unequipped';
          card.append(name, loadout); roster.append(card);
        }
        element(`${team}-roster`).replaceChildren(roster);
      }
    }
    const resources = document.createDocumentFragment();
    for (const [index, resource] of (match?.resources ?? []).entries()) {
      const row = document.createElement('div'); row.className = `resource-row ${resource.remaining <= 0 ? 'depleted' : ''}`;
      const name = document.createElement('span'); name.textContent = `◆  Deposit ${String(index + 1).padStart(2, '0')}`;
      const remaining = document.createElement('strong'); remaining.textContent = `${Math.ceil(resource.remaining)} / ${resource.capacity}`;
      const progress = document.createElement('progress'); progress.max = resource.capacity; progress.value = resource.remaining; progress.setAttribute('aria-label', `${resource.id} salvage remaining`);
      row.append(name, remaining, progress); resources.append(row);
    }
    element('resource-list').replaceChildren(resources);
    const finished = match?.phase === 'finished';
    element('match-result').hidden = !finished;
    if (finished) {
      element('match-result').dataset.winner = match.winner ?? 'draw';
      element('result-title').textContent = match.winner === 'blue' ? 'Blue swarm wins.' : match.winner === 'red' ? 'Red swarm wins.' : 'Mutual destruction.';
      element('result-description').textContent = match.winner === 'draw' ? 'No drones remain. Cincinnati is quiet again.' : `${match.winner === 'blue' ? 'Your team is' : 'The enemy team is'} the last swarm flying.`;
    }
    const signature = `${state.simTime < 1}:${match?.events.length}:${match?.events.at(-1)?.id}`;
    if (signature === this.eventSignature) return;
    this.eventSignature = signature;
    const events = match?.events ?? [];
    element('combat-count').textContent = String(events.length);
    if (!events.length) { element('combat-log').innerHTML = '<p class="combat-empty">First contact is still ahead. Mining, equipment purchases and combat events appear here.</p>'; return; }
    const rows = document.createDocumentFragment();
    for (const event of events.slice(-70).reverse()) {
      const row = document.createElement('article'); row.className = `combat-event ${event.team ? `team-${event.team}` : ''}`;
      const time = document.createElement('time'); time.textContent = timestamp(event.simTime);
      const kind = document.createElement('span'); kind.className = 'combat-kind'; kind.textContent = event.type.replaceAll('_', ' ');
      const body = document.createElement('p'); body.textContent = event.message;
      row.append(time, kind, body); rows.append(row);
    }
    element('combat-log').replaceChildren(rows);
  }
}
