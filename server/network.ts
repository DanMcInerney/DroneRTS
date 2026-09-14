import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DRONE_IDS, type DroneId, type RadioMessage, type NetworkState } from '../shared/types.ts';
import { PythonRpc } from './python-rpc.ts';
const PEERS = [...DRONE_IDS, 'operator'] as const;
type PeerId = typeof PEERS[number];

async function unusedPort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolvePort, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

export class FleetNetwork {
  private workers = new Map<PeerId, PythonRpc>();
  private stopping = false;
  private stopPromise?: Promise<void>;
  state: NetworkState = { status: 'starting', transport: 'zenoh-tcp', vehicle: 'mavlink2-udp', message: 'Starting three independent network peers', peers: DRONE_IDS.map(id => ({ id, online: false, peers: 0, pending: 0, inbox: 0 })) };

  constructor(private options: { projectDir: string; sessionId: string; onReceive: (recipient: DroneId, message: RadioMessage) => void; onState: (state: NetworkState) => void; onEvent?: (event: any) => void; onFailure: (message: string) => void }) {}

  async start() {
    const directory = resolve(this.options.projectDir, 'artifacts', 'network', this.options.sessionId);
    await mkdir(directory, { recursive: true });
    const ports = await Promise.all(PEERS.map(() => unusedPort()));
    if (this.stopping) throw new Error('Network startup cancelled');
    for (let index = 0; index < PEERS.length; index++) {
      const id = PEERS[index];
      const worker = new PythonRpc(resolve(this.options.projectDir, 'network/peer.py'), [
        '--drone', id, '--session', this.options.sessionId, '--listen', `tcp/127.0.0.1:${ports[index]}`,
        '--peers', ports.filter((_, i) => i !== index).map(port => `tcp/127.0.0.1:${port}`).join(','),
        '--store', resolve(directory, `${id}.sqlite`),
      ], event => this.event(id, event));
      this.workers.set(id, worker);
    }
    try {
      await Promise.all([...this.workers.values()].map(worker => worker.start()));
      if (this.stopping) throw new Error('Network startup cancelled');
      this.state.status = 'online'; this.state.message = 'Zenoh peers · MAVLink 2 UDP · simulated link faults'; this.publish();
    } catch (error) { await this.stop(); throw error; }
  }

  private event(id: PeerId, event: any) {
    this.options.onEvent?.({ drone: id, ...event });
    if (this.stopping) return;
    if (event.event === 'fatal') {
      this.state.status = 'error'; this.state.message = String(event.message); this.publish();
      this.options.onFailure(this.state.message); return;
    }
    if (event.event === 'received' && id !== 'operator') this.options.onReceive(id, event.message);
    if (event.event === 'status' || event.event === 'ready') {
      if (id === 'operator') { this.state.pendingMissions = event.pending ?? 0; this.publish(); return; }
      const peer = this.state.peers.find(peer => peer.id === id)!;
      for (const key of ['online', 'peers', 'pending', 'inbox'] as const) if (event[key] !== undefined) Object.assign(peer, { [key]: event[key] });
      this.publish();
    }
  }
  private publish() { this.options.onState(structuredClone(this.state)); }
  send(message: RadioMessage) {
    const worker = this.workers.get(message.from === 'player' ? 'operator' : message.from as DroneId);
    if (!worker || this.stopping) throw new Error('Drone network is unavailable');
    return worker.request('send', { message, ttlMs: 120_000 });
  }
  consume(recipient: DroneId, ids: string[]) {
    if (!ids.length || this.stopping) return;
    void this.workers.get(recipient)?.request('consume', { ids }).catch(error => {
      if (!this.stopping) this.options.onFailure(String(error));
    });
  }
  async link(id: DroneId, online: boolean) {
    if (!this.workers.has(id) || this.stopping) throw new Error('Drone network is unavailable');
    await this.workers.get(id)!.request('link', { online });
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.workers.values()].map(worker => worker.stop()));
      this.workers.clear(); this.state.status = 'offline'; this.state.message = 'Network stopped';
      this.state.peers.forEach(peer => { peer.online = false; peer.peers = 0; }); this.publish();
    })();
    return this.stopPromise;
  }
}
