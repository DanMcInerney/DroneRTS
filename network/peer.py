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

DRONES = ("drone-1", "drone-2", "drone-3")
MAX_BYTES = 65536


def emit(value):
    print(json.dumps(value, separators=(",", ":"), allow_nan=False), flush=True)


def received_message(message, expires):
    """Add receiver metadata to a copy; never change the original payload/dedup key."""
    return {**message, "expiresAt": datetime.fromtimestamp(expires, timezone.utc)
            .isoformat(timespec="milliseconds").replace("+00:00", "Z")}


def validate_message(message, fleet_session, sender=None):
    if not isinstance(message, dict) or message.get("protocol") != "fleet-radio/1":
        raise ValueError("Expected fleet-radio/1 message")
    if message.get("sessionId") != fleet_session:
        raise ValueError("Message fleet session does not match")
    if message.get("from") not in (*DRONES, "player") or (sender and message["from"] != sender):
        raise ValueError("Message sender must be this drone")
    if message["from"] == "player" and (message.get("kind") != "mission" or message.get("to") != "all"):
        raise ValueError("Operator may only broadcast player missions")
    if message.get("to") not in (*DRONES, "all") or message["to"] == message["from"]:
        raise ValueError("Recipient must be all or another drone")
    for field, limit in (("id", 200), ("kind", 64), ("sentAt", 80), ("text", 4000)):
        if not isinstance(message.get(field), str) or not 1 <= len(message[field]) <= limit:
            raise ValueError(f"Invalid message {field}")
    for field, minimum in (("sequence", 1), ("mission", 0)):
        if type(message.get(field)) is not int or message[field] < minimum:
            raise ValueError(f"Invalid message {field}")
    if type(message.get("simTime")) not in (int, float) or not math.isfinite(message["simTime"]) or message["simTime"] < 0:
        raise ValueError("Invalid message simTime")
    if "data" in message and not isinstance(message["data"], dict):
        raise ValueError("Message data must be an object")
    if len(encode(message).encode("utf-8")) > MAX_BYTES:
        raise ValueError("Message exceeds 64 KiB")


class Peer:
    def __init__(self, args):
        uuid.UUID(args.session)
        peers = args.peers.split(",")
        valid_count = len(peers) == 3 if args.drone == "operator" else len(peers) in (2, 3)
        if not valid_count or len(set([args.listen, *peers])) != len(peers) + 1:
            raise ValueError("Distinct endpoints for the other drone peers and optional operator are required")
        self.drone, self.fleet_session = args.drone, args.session
        self.sender = "player" if args.drone == "operator" else args.drone
        self.events = queue.Queue()
        self.transport = PeerTransport(args.drone, args.session, args.listen, peers, self.events)
        self.store = PeerStore(args.store, args.drone, args.session)
        self.running = True
        self.counters = {"txFrames": 0, "rxFrames": 0, "duplicates": 0, "invalidFrames": 0, "retries": 0}
        self.last_status = None

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
            validate_message(message, self.fleet_session, self.sender)
            ttl = params.get("ttlMs", 120000)
            if type(ttl) not in (int, float) or not math.isfinite(ttl) or not 1 <= ttl <= 600000:
                raise ValueError("ttlMs must be between 1 and 600000")
            recipients = [drone for drone in DRONES if drone != self.drone] if message["to"] == "all" else [message["to"]]
            self.store.queue(message, recipients, time.time() + ttl / 1000)
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
            if topic == self.transport.ack_topic(self.sender):
                if packet.get("protocol") != "fleet-ack/1" or packet.get("to") != self.sender or packet.get("from") not in DRONES:
                    raise ValueError("Invalid ACK")
                if not isinstance(packet.get("id"), str):
                    raise ValueError("Invalid ACK ID")
                recipients = self.store.acknowledge(packet["id"], packet["from"], time.time())
                if recipients:
                    emit({"event": "delivery", "id": packet["id"], "status": "received", "recipients": recipients})
                return
            if packet.get("protocol") != "fleet-zenoh/1":
                raise ValueError("Invalid transport envelope")
            message = packet.get("message")
            validate_message(message, self.fleet_session)
            if message["from"] == self.drone or message["to"] not in (self.drone, "all") or topic != self.transport.data_topic(message["to"]):
                raise ValueError("Message not addressed to this peer")
            expires = packet.get("expiresAt")
            if type(expires) not in (float, int) or not math.isfinite(expires):
                raise ValueError("Invalid expiry")
            if expires <= time.time() * 1000:
                return
            received = received_message(message, expires / 1000)
            fresh = self.store.accept(message, expires / 1000)  # FULL synchronous SQLite commit precedes ACK.
            if fresh:
                emit({"event": "received", "message": received})
            else:
                self.counters["duplicates"] += 1
            self.transport.put(self.transport.ack_topic(message["from"]), {
                "protocol": "fleet-ack/1", "sessionId": self.fleet_session, "id": message["id"],
                "from": self.drone, "to": message["from"],
            })
            self.counters["txFrames"] += 1
        except (ValueError, TypeError, KeyError, UnicodeDecodeError, OverflowError, OSError):
            self.counters["invalidFrames"] += 1

    def tick(self):
        now = time.time()
        for row in self.store.expire(now):
            emit({"event": "delivery", "id": row["id"], "status": "expired",
                  "recipients": json.loads(row["recipients"]), "receivedBy": json.loads(row["receipts"])})
        if self.transport.session:
            for row in self.store.due(now):
                message = json.loads(row["message"])
                self.store.attempted(row["id"], now)
                self.transport.put(self.transport.data_topic(message["to"]), {
                    "protocol": "fleet-zenoh/1", "sessionId": self.fleet_session,
                    "message": message, "expiresAt": row["expires"] * 1000,
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
    parser.add_argument("--drone", required=True, choices=(*DRONES, "operator"))
    parser.add_argument("--session", required=True)
    parser.add_argument("--listen", required=True)
    parser.add_argument("--peers", required=True)
    parser.add_argument("--store", required=True)
    args = parser.parse_args()
    try:
        Peer(args).run()
    except Exception as error:
        print(f"Zenoh peer failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
