"""Durable fleet-radio/1 worker. stdin/stdout are JSONL control IPC only.

Peer data and receipt acknowledgements travel exclusively through native Zenoh.
The UUID namespace isolates local fleet runs; it is not hardened authentication.
"""

import argparse
import json
import math
import queue
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

from peer_store import PeerStore, encode
from peer_transport import PeerTransport
from fleet_config import parse_roster

MAX_BYTES = 10240
MAX_TTL_MS = 600000
# The host-bound opening includes the full vehicle/rules briefing. It still
# shares the existing 8 KiB UTF-8 envelope cap with ordinary radio messages.
MAX_MISSION_TEXT = 6000


def emit(value):
    print(json.dumps(value, separators=(",", ":"), allow_nan=False, ensure_ascii=False), flush=True)


def received_message(message, expires):
    """Add receiver metadata to a copy; never change the original payload/dedup key."""
    # Wall labels are presentation only; immutable expiresAt is generated when
    # queued, while transport admission/retry uses the host monotonic deadline.
    return {**message, "remainingTtlMs": max(0, (expires - time.monotonic()) * 1000), "expiresAt": message.get("expiresAt") or datetime.fromtimestamp(
        time.time() + expires - time.monotonic(), timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z")}


def validate_message(message, fleet_session, drones, sender=None, player_chat=False):
    if not isinstance(message, dict) or message.get("protocol") != "fleet-radio/1":
        raise ValueError("Expected fleet-radio/1 message")
    if message.get("sessionId") != fleet_session:
        raise ValueError("Message fleet session does not match")
    if message.get("from") not in (*drones, "player") or (sender and message["from"] != sender):
        raise ValueError("Message sender must be this drone")
    if message["from"] == "player" and not player_chat and (message.get("kind") != "mission" or message.get("to") != "all"):
        raise ValueError("Operator may only broadcast player missions")
    if message.get("kind") == "mission" and message["from"] != "player":
        raise ValueError("Only the operator may replace an objective")
    if message.get("to") not in (*drones, "all", *(('player',) if player_chat else ())) or message["to"] == message["from"]:
        raise ValueError("Recipient must be all or another drone")
    for field, limit in (("id", 200), ("kind", 64), ("sentAt", 80), ("text", MAX_MISSION_TEXT if message.get("kind") == "mission" else 1200)):
        if not isinstance(message.get(field), str) or not 1 <= len(message[field]) <= limit:
            raise ValueError(f"Invalid message {field}")
    for field, minimum in (("sequence", 1), ("mission", 0)):
        if type(message.get(field)) is not int or message[field] < minimum:
            raise ValueError(f"Invalid message {field}")
    if type(message.get("simTime")) not in (int, float) or not math.isfinite(message["simTime"]) or message["simTime"] < 0:
        raise ValueError("Invalid message simTime")
    if "data" in message and not isinstance(message["data"], dict):
        raise ValueError("Message data must be an object")
    limit = MAX_BYTES if message.get("kind") == "transfer" else 8192
    if len(encode(message).encode("utf-8")) > limit:
        raise ValueError(f"Message exceeds {limit} UTF-8 bytes; use a bounded file transfer")


class Peer:
    def __init__(self, args):
        uuid.UUID(args.session)
        network_id = args.network or args.session
        uuid.UUID(network_id)
        self.drones = tuple(parse_roster(args.roster))
        if args.drone not in (*self.drones, "operator"):
            raise ValueError("Unknown network drone identity")
        peers = args.peers.split(",") if args.peers else []
        count = len(self.drones)
        valid_count = len(peers) == count if args.drone == "operator" else len(peers) in (count - 1, count)
        if not valid_count or len(set([args.listen, *peers])) != len(peers) + 1:
            raise ValueError("Distinct endpoints for the other drone peers and optional operator are required")
        self.drone, self.fleet_session = args.drone, args.session
        self.network_id, self.boot_id = network_id, str(uuid.uuid4())
        self.sender_sequence = 0
        self.player_chat = bool(args.player_chat)
        self.has_operator = len(peers) == count
        self.sender = "player" if args.drone == "operator" else args.drone
        self.events = queue.Queue(maxsize=128)
        self.transport = PeerTransport(args.drone, network_id, args.listen, peers, self.events, self.player_chat)
        self.store = PeerStore(args.store, args.drone, args.session)
        self.running = True
        self.counters = {"txFrames": 0, "rxFrames": 0, "duplicates": 0, "invalidFrames": 0, "retries": 0}
        self.last_status = None
        self.audit_window = 0
        self.audit_count = self.audit_suppressed = 0

    def audit_payload(self, direction, topic, payload):
        now = int(time.monotonic())
        if now != self.audit_window:
            self.audit_window, self.audit_count = now, 0
        if self.audit_count >= 12:
            self.audit_suppressed += 1
            return
        self.audit_count += 1
        emit({"event": "payload", "direction": direction, "topic": topic, "payload": payload,
              "bytes": len(encode(payload).encode("utf-8")), "capture": "Zenoh application payload, not TCP framing",
              "sampling": "at most 12 payloads/peer/s", "suppressedSinceLast": self.audit_suppressed})
        self.audit_suppressed = 0

    def put(self, topic, payload):
        self.transport.put(topic, payload)
        self.audit_payload("published", topic, payload)

    def status(self):
        return {"drone": self.drone, "sessionId": self.fleet_session, "transport": "zenoh-tcp-peer",
                **self.transport.status(), **self.store.status(), **self.counters}

    def publish_status(self):
        status = self.status()
        if status != self.last_status:
            emit({"event": "status", **status})
            self.last_status = status

    def request(self, method, params):
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        if method == "send":
            message = params.get("message")
            validate_message(message, self.fleet_session, self.drones, self.sender, self.player_chat)
            ttl = params.get("ttlMs", 120000)
            if type(ttl) not in (int, float) or not math.isfinite(ttl) or not 1 <= ttl <= 600000:
                raise ValueError("ttlMs must be between 1 and 600000")
            if message.get("kind") == "status":
                ttl = min(ttl, 5000)
            recipients = [drone for drone in self.drones if drone != self.drone] if message["to"] == "all" else [message["to"]]
            if message["to"] == "all" and self.sender != "player" and self.player_chat and self.has_operator:
                recipients.append("player")
            # The bridge binds sender/network/boot metadata; a guest cannot assert
            # another identity. Absolute monotonic deadlines survive helper restarts
            # on this same host; new matches have different stores/namespaces.
            deadline = time.monotonic() + ttl / 1000
            binding = self.store.sender_binding(message["id"])
            if binding is None:
                self.sender_sequence += 1
                binding = {"bootId": self.boot_id, "senderSequence": self.sender_sequence}
            message = {**message, "networkId": self.network_id, **binding,
                       "expiresAt": datetime.fromtimestamp(datetime.fromisoformat(message["sentAt"].replace("Z", "+00:00")).timestamp() + ttl / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                       "trafficClass": "control" if message["kind"] == "mission" else "status" if message["kind"] == "status" else "transfer" if message["kind"] == "transfer" else "durable"}
            validate_message(message, self.fleet_session, self.drones, self.sender, self.player_chat)
            self.store.queue(message, recipients, deadline)
            return {"queued": True, "id": message["id"]}
        if method == "link":
            if type(params.get("online")) is not bool:
                raise ValueError("online must be boolean")
            if params["online"]:
                self.transport.open()
            else:
                self.transport.close()
            return self.status()
        if method == "consume":
            ids = params.get("ids")
            if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
                raise ValueError("ids must be an array of message IDs")
            return {"consumed": self.store.consume(ids)}
        if method == "status":
            return self.status()
        if method == "stop":
            self.running = False
            return {"stopped": True}
        raise ValueError(f"Unknown method: {method}")

    def incoming(self, generation, topic, raw):
        if generation != self.transport.generation or not self.transport.session:
            return
        self.counters["rxFrames"] += 1
        try:
            if len(raw) > MAX_BYTES + 2048:
                raise ValueError("Oversize wire payload")
            packet = json.loads(raw)
            if not isinstance(packet, dict) or packet.get("sessionId") != self.fleet_session:
                raise ValueError("Wrong fleet session")
            self.audit_payload("received", topic, packet)
            if topic == self.transport.ack_topic(self.sender):
                if packet.get("protocol") not in ("fleet-ack/1", "fleet-backpressure/1") or packet.get("to") != self.sender or packet.get("from") not in (*self.drones, *(('player',) if self.player_chat else ())):
                    raise ValueError("Invalid ACK")
                if not isinstance(packet.get("id"), str):
                    raise ValueError("Invalid ACK ID")
                if packet["protocol"] == "fleet-backpressure/1":
                    emit({"event": "backpressure", "id": packet["id"], "recipient": packet["from"], "reason": "radio-mail storage full; retained in bounded sender outbox until expiry"})
                    return
                recipients = self.store.acknowledge(packet["id"], packet["from"], time.monotonic())
                emit({"event": "delivery", "id": packet["id"], "status": "stored", "recipient": packet["from"]})
                if recipients:
                    emit({"event": "delivery", "id": packet["id"], "status": "received", "recipients": recipients})
                return
            if packet.get("protocol") != "fleet-zenoh/1":
                raise ValueError("Invalid transport envelope")
            message = packet.get("message")
            validate_message(message, self.fleet_session, self.drones, player_chat=self.player_chat)
            if message.get("networkId") != self.network_id or not isinstance(message.get("bootId"), str) or type(message.get("senderSequence")) is not int or message["senderSequence"] < 1:
                raise ValueError("Invalid bound transport identity")
            if message["from"] == self.sender or message["to"] not in (self.sender, "all") or topic != self.transport.data_topic(message["to"]):
                raise ValueError("Message not addressed to this peer")
            expires = packet.get("expiresMonotonic")
            if type(expires) not in (float, int) or not math.isfinite(expires):
                raise ValueError("Invalid expiry")
            if expires <= time.monotonic() or expires > time.monotonic() + MAX_TTL_MS / 1000 + 1:
                return
            # Stable wall expiry is stored as receiver metadata outside the immutable
            # wire body by PeerStore; arrival labels never control deadline decisions.
            received = received_message(message, expires)
            try:
                fresh = self.store.accept(message, expires)  # FULL SQLite commit precedes ACK.
            except ValueError as error:
                if "storage" not in str(error).lower() and "quota" not in str(error).lower():
                    raise
                self.put(self.transport.ack_topic(message["from"]), {
                    "protocol": "fleet-backpressure/1", "sessionId": self.fleet_session,
                    "id": message["id"], "from": self.sender, "to": message["from"],
                })
                return
            if fresh:
                emit({"event": "received", "message": received})
            else:
                self.counters["duplicates"] += 1
            self.put(self.transport.ack_topic(message["from"]), {
                "protocol": "fleet-ack/1", "sessionId": self.fleet_session, "id": message["id"],
                "from": self.sender, "to": message["from"],
            })
            self.counters["txFrames"] += 1
        except (ValueError, TypeError, KeyError, UnicodeDecodeError, OverflowError, OSError):
            self.counters["invalidFrames"] += 1

    def tick(self):
        now = time.monotonic()
        for row in self.store.expire(now):
            emit({"event": "delivery", "id": row["id"], "status": "expired",
                  "recipients": json.loads(row["recipients"]), "receivedBy": json.loads(row["receipts"])})
        if self.transport.session:
            for row in self.store.due(now):
                message = json.loads(row["message"])
                self.store.attempted(row["id"], now)
                self.put(self.transport.data_topic(message["to"]), {
                    "protocol": "fleet-zenoh/1", "sessionId": self.fleet_session,
                    "message": message, "expiresMonotonic": row["expires"],
                })
                self.counters["txFrames"] += 1
                self.counters["retries"] += int(row["attempts"] > 0)
        self.publish_status()

    def read_stdin(self):
        for line in sys.stdin:
            self.events.put(("rpc", line))
        self.events.put(("eof",))

    def run(self):
        try:
            self.transport.open()
            emit({"event": "ready", **self.status()})
            for message, expires in self.store.unconsumed():
                emit({"event": "received", "message": received_message(message, expires)})
            threading.Thread(target=self.read_stdin, daemon=True).start()
            while self.running:
                try:
                    item = self.events.get(timeout=0.05)
                except queue.Empty:
                    item = None
                if item and item[0] == "eof":
                    break
                if item and item[0] == "wire":
                    self.incoming(*item[1:])
                elif item and item[0] == "rpc":
                    request = {}
                    try:
                        request = json.loads(item[1])
                        if not isinstance(request, dict) or "id" not in request:
                            raise ValueError("Expected RPC object with id")
                        result = self.request(request.get("method"), request.get("params", {}))
                        emit({"id": request["id"], "result": result})
                    except (ValueError, TypeError, KeyError) as error:
                        emit({"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)})
                if self.running:
                    self.tick()
        finally:
            self.transport.close()
            self.store.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drone", required=True)
    parser.add_argument("--roster", required=True)
    parser.add_argument("--network")
    parser.add_argument("--session", required=True)
    parser.add_argument("--listen", required=True)
    parser.add_argument("--peers", required=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--player-chat", action="store_true", help="Blue domain: operator receives ordinary group/direct conversation")
    args = parser.parse_args()
    try:
        Peer(args).run()
    except Exception as error:
        print(f"Zenoh peer failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
