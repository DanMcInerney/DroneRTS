"""Native Zenoh peer sessions, explicitly connected over loopback TCP.

No router, multicast, gossip, parent forwarding, or in-process transport substitute.
Callbacks only enqueue immutable bytes; SQLite and application decisions run elsewhere.
"""

import json
import re

import zenoh


def loopback_endpoint(value):
    if not re.fullmatch(r"tcp/127\.0\.0\.1:[0-9]+", value):
        raise ValueError("Endpoints must use tcp/127.0.0.1:PORT")
    if not 1 <= int(value.rsplit(":", 1)[1]) <= 65535:
        raise ValueError("Endpoint port must be 1–65535")
    return value


class PeerTransport:
    def __init__(self, drone, fleet_session, listen, peers, events):
        self.drone, self.prefix = drone, f"fleet/{fleet_session}"
        self.events, self.session, self.subscribers = events, None, []
        self.generation = 0
        self.config = zenoh.Config.from_json5(json.dumps({
            "mode": "peer",
            "listen": {"endpoints": [loopback_endpoint(listen)], "timeout_ms": 0, "exit_on_failure": True},
            "connect": {"endpoints": [loopback_endpoint(peer) for peer in peers],
                        "timeout_ms": 0, "exit_on_failure": False,
                        "retry": {"period_init_ms": 100, "period_max_ms": 1000, "period_increase_factor": 2}},
            "scouting": {"multicast": {"enabled": False}, "gossip": {"enabled": False}, "delay": 0},
            "open": {"return_conditions": {"connect_scouted": False, "declares": False}},
        }))

    def data_topic(self, recipient):
        return f"{self.prefix}/radio/group" if recipient == "all" else f"{self.prefix}/radio/direct/{recipient}"

    def ack_topic(self, recipient):
        return f"{self.prefix}/ack/{recipient}"

    def open(self):
        if self.session:
            return
        self.generation += 1
        generation = self.generation

        def received(sample):
            self.events.put(("wire", generation, str(sample.key_expr), sample.payload.to_bytes()))

        session = zenoh.open(self.config)
        try:
            topics = [self.ack_topic("player")] if self.drone == "operator" else [
                self.data_topic("all"), self.data_topic(self.drone), self.ack_topic(self.drone)]
            self.subscribers = [session.declare_subscriber(topic, received, allowed_origin=zenoh.Locality.REMOTE)
                                for topic in topics]
            self.session = session
        except BaseException:
            session.close()
            raise

    def close(self):
        self.generation += 1
        session, self.session = self.session, None
        if session:
            session.close()
        self.subscribers = []

    def put(self, topic, payload):
        if self.session:
            self.session.put(topic, json.dumps(payload, separators=(",", ":"), allow_nan=False),
                             encoding=zenoh.Encoding.APPLICATION_JSON, allowed_destination=zenoh.Locality.REMOTE,
                             congestion_control=zenoh.CongestionControl.DROP)

    def status(self):
        if not self.session:
            return {"online": False, "peers": 0, "routers": 0, "links": []}
        return {"online": True, "peers": len(self.session.info.peers_zid()),
                "routers": len(self.session.info.routers_zid()),
                "links": [{"source": link.src, "destination": link.dst, "streamed": link.is_streamed}
                          for link in self.session.info.links()]}
