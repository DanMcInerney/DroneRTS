import { randomUUID } from 'node:crypto';
import type { Drone, DroneId, Pose } from '../shared/types.ts';
import type { MatchState } from '../shared/rts.ts';

interface CameraSocket { readyState: number; send(data: string): void }
interface Pending { socket: CameraSocket; resolve(image: string): void; reject(error: Error): void; cleanup(): void }

/** One current renderer supplies captures; other matching browsers are standby.
 * An open WebSocket alone is never a sensor-readiness signal. */
export class CameraChannel {
  private peers = new Map<CameraSocket, { id: string; ready: boolean }>();
  private pending = new Map<string, Pending>();
  constructor(readonly rendererId: string, private changed: (ready: boolean) => void,
    private evidence: (record: Record<string, unknown>) => void = () => {}) {}

  get ready() { return [...this.peers].some(([socket, peer]) => peer.ready && socket.readyState === 1); }
  attach(socket: CameraSocket) { this.peers.set(socket, { id: randomUUID(), ready: false }); }
  detach(socket: CameraSocket) {
    this.peers.delete(socket);
    for (const [id, request] of this.pending) if (request.socket === socket) this.reject(id, 'Camera browser disconnected');
    this.changed(this.ready);
  }
  receive(socket: CameraSocket, packet: any) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    if (packet?.type === 'camera-ready') {
      peer.ready = packet.rendererId === this.rendererId;
      if (!peer.ready) socket.send(JSON.stringify({ type: 'camera-rejected', message: 'This camera page is out of date. Reload it to connect to the current match.' }));
      else socket.send(JSON.stringify({ type: 'camera-accepted' }));
      this.evidence({ type: 'camera-renderer', connectionId: peer.id, rendererId: packet.rendererId, accepted: peer.ready });
      this.changed(this.ready); return;
    }
    if (packet?.type !== 'capture-result') return;
    const request = this.pending.get(packet.requestId);
    if (!request || request.socket !== socket) return;
    if (!peer.ready || packet.rendererId !== this.rendererId) { this.reject(packet.requestId, 'Camera renderer identity changed'); return; }
    if (typeof packet.image !== 'string' || packet.image.length > 2_000_000 || !/^data:image\/(jpeg|png);base64,/.test(packet.image)) {
      this.reject(packet.requestId, 'Invalid camera result'); return;
    }
    this.pending.delete(packet.requestId); request.cleanup(); request.resolve(packet.image);
  }
  capture(droneId: DroneId, pose: Pose, simTime: number, drones: Drone[], match?: MatchState, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const provider = [...this.peers].find(([socket, peer]) => peer.ready && socket.readyState === 1);
    if (!provider) return Promise.reject(new Error('No matching camera renderer is ready. Reload the game browser.'));
    const [socket, peer] = provider, requestId = randomUUID();
    this.evidence({ type: 'camera-acquisition', requestId, connectionId: peer.id, rendererId: this.rendererId, droneId, simTime, rulesVersion: match?.rulesVersion });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(requestId, 'Camera capture timed out'), 8000);
      const abort = () => this.reject(requestId, 'Camera capture cancelled');
      this.pending.set(requestId, { socket, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { socket.send(JSON.stringify({ type: 'capture', requestId, rendererId: this.rendererId, droneId, pose, simTime, drones, match })); }
      catch { this.reject(requestId, 'Camera browser send failed'); }
    });
  }
  cancel(reason = 'Match stopped') { for (const id of this.pending.keys()) this.reject(id, reason); }
  private reject(id: string, message: string) {
    const request = this.pending.get(id); if (!request) return;
    this.pending.delete(id); request.cleanup();
    try { if (request.socket.readyState === 1) request.socket.send(JSON.stringify({ type: 'capture-cancel', requestId: id, rendererId: this.rendererId })); } catch { /* Already disconnected. */ }
    request.reject(new Error(message));
  }
}
