interface StateSocket { readyState: number; bufferedAmount: number; send(data: string): void }
interface Peer { pending: boolean; inFlight?: number }

/** Replaceable spectator snapshots share a connection with camera requests.
 * Socket.bufferedAmount alone does not bound the browser's queued messages:
 * allow only one unacknowledged snapshot, then send the latest state. */
export class StateChannel {
  private peers = new Map<StateSocket, Peer>();
  private sequence = 0;
  constructor(private readState: () => unknown) {}

  attach(socket: StateSocket) { this.peers.set(socket, { pending: true }); }
  detach(socket: StateSocket) { this.peers.delete(socket); }
  broadcast() {
    for (const [socket, peer] of this.peers) {
      peer.pending = true;
      this.flush(socket, peer);
    }
  }
  receive(socket: StateSocket, packet: any) {
    const peer = this.peers.get(socket);
    if (!peer || packet?.type !== 'state-ack' || peer.inFlight === undefined || packet.sequence !== peer.inFlight) return;
    peer.inFlight = undefined;
    this.flush(socket, peer);
  }
  private flush(socket: StateSocket, peer: Peer) {
    if (!peer.pending || peer.inFlight !== undefined || socket.readyState !== 1 || socket.bufferedAmount >= 2_000_000) return;
    peer.pending = false;
    peer.inFlight = ++this.sequence;
    socket.send(JSON.stringify({ type: 'state', sequence: peer.inFlight, state: this.readState() }));
  }
}
