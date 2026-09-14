"""MAVLink 2 common-dialect bridge and configured simulated endpoints on local UDP.

No flight firmware or physics lives here. Node applies only the returned,
validated wire commands. stdout is exclusively the PythonRpc JSON protocol.
"""

import argparse
import json
import math
import socket
import sys
import time

from pymavlink.dialects.v20 import common as mav
from fleet_config import parse_roster


BRIDGE_SYSTEM = 255
BRIDGE_COMPONENT = mav.MAV_COMP_ID_MISSIONPLANNER
VEHICLE_COMPONENT = mav.MAV_COMP_ID_AUTOPILOT1
POSITION_MASK = 0x0DF8  # Ignore velocity, acceleration, yaw and yaw rate.
HOLD_MASK = 0x0DC7  # Ignore position, acceleration, yaw and yaw rate.
PITCH_FLAGS = mav.GIMBAL_MANAGER_FLAGS_PITCH_LOCK
TIMEOUT = 0.75


def number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def boot_ms(sim_time):
    value = round(number(sim_time, "simTime") * 1000)
    if not 0 <= value <= 0xFFFFFFFF:
        raise ValueError("simTime is outside the uint32 millisecond interval")
    return value


def heading(value):
    result = value % 360
    return 0.0 if abs(result - 360) < 0.00001 else result


def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(",", ":")), flush=True)


class Pair:
    """An address-pinned UDP link with independent bridge/vehicle encoders."""

    def __init__(self, drone, system_id, on_event=lambda event: None):
        self.drone, self.system_id = drone, system_id
        self.bridge = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.vehicle = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for sock in (self.bridge, self.vehicle):
            sock.bind(("127.0.0.1", 0))
        self.bridge_codec = mav.MAVLink(None, srcSystem=BRIDGE_SYSTEM, srcComponent=BRIDGE_COMPONENT)
        self.vehicle_codec = mav.MAVLink(None, srcSystem=system_id, srcComponent=VEHICLE_COMPONENT)
        self.sent = self.received = self.bytes_sent = self.rejected = 0
        self.on_event = on_event
        self.last_telemetry_audit = {}
        self.audit_window = 0
        self.audit_count = self.audit_suppressed = 0

    def close(self):
        self.bridge.close()
        self.vehicle.close()

    def status(self):
        return {"droneId": self.drone, "systemId": self.system_id,
                "componentId": VEHICLE_COMPONENT, "bridge": self.bridge.getsockname(),
                "vehicle": self.vehicle.getsockname(), "sent": self.sent,
                "received": self.received, "bytes": self.bytes_sent, "rejected": self.rejected}

    def pack(self, message, to_vehicle):
        codec = self.bridge_codec if to_vehicle else self.vehicle_codec
        packet = message.pack(codec, force_mavlink1=False)
        codec.seq = (codec.seq + 1) % 256
        return packet

    def receive(self, sock, peer, system, component, sequence, message_id, timeout=TIMEOUT):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("MAVLink UDP receive timed out; no simulation action was accepted")
            sock.settimeout(remaining)
            try:
                packet, source = sock.recvfrom(4096)
            except socket.timeout as error:
                raise TimeoutError("MAVLink UDP receive timed out; no simulation action was accepted") from error
            try:
                if source != peer:
                    raise ValueError("Unexpected UDP peer")
                # Profile: one unsigned MAVLink 2 frame per datagram. Reject
                # truncation, concatenation, v1 and unsupported flag bits before
                # the reference parser validates dialect CRC_EXTRA + checksum.
                if len(packet) < 12 or packet[0] != 0xFD or packet[2:4] != b"\0\0" or len(packet) != packet[1] + 12:
                    raise ValueError("Invalid MAVLink 2 datagram framing")
                message = mav.MAVLink(None).parse_char(packet)
                if message is None or message.get_type() == "BAD_DATA":
                    raise ValueError("Invalid MAVLink packet")
                if (message.get_srcSystem(), message.get_srcComponent()) != (system, component):
                    raise ValueError("Unexpected MAVLink source identity")
                if message.get_seq() != sequence or message.get_msgId() != message_id:
                    raise ValueError("Unexpected MAVLink sequence/message")
            except (ValueError, mav.MAVError):
                self.rejected += 1
                continue
            self.received += 1
            return message

    def transfer(self, message, to_vehicle):
        sender, receiver = (self.bridge, self.vehicle) if to_vehicle else (self.vehicle, self.bridge)
        system, component = (BRIDGE_SYSTEM, BRIDGE_COMPONENT) if to_vehicle else (self.system_id, VEHICLE_COMPONENT)
        packet = self.pack(message, to_vehicle)
        sender.sendto(packet, receiver.getsockname())
        self.sent += 1
        self.bytes_sent += len(packet)
        decoded = self.receive(receiver, sender.getsockname(), system, component, packet[4], message.get_msgId())
        now = time.monotonic()
        if int(now) != self.audit_window:
            self.audit_window, self.audit_count = int(now), 0
        telemetry = message.get_msgId() in (30, 32)
        due = not telemetry or now - self.last_telemetry_audit.get(message.get_msgId(), -10) >= 1
        if due and self.audit_count < 20:
            self.audit_count += 1
            if telemetry:
                self.last_telemetry_audit[message.get_msgId()] = now
            fields = {key: (value if not isinstance(value, float) or math.isfinite(value) else "unset / NaN")
                      for key, value in decoded.to_dict().items()}
            self.on_event({"event": "packet", "protocol": "MAVLink2", "droneId": self.drone,
                           "direction": "controller → vehicle" if to_vehicle else "vehicle → controller",
                           "source": sender.getsockname(), "destination": receiver.getsockname(),
                           "message": decoded.get_type(), "messageId": decoded.get_msgId(),
                           "sequence": decoded.get_seq(), "bytes": len(packet), "hex": packet.hex(),
                           "decoded": fields, "validation": "received and CRC validated",
                           "sampling": "telemetry at most 1/message/s; all packets at most 20/drone/s",
                           "suppressedSinceLast": self.audit_suppressed})
            self.audit_suppressed = 0
        else:
            self.audit_suppressed += 1
        return decoded

    def setpoint_action(self, message):
        if message.coordinate_frame != mav.MAV_FRAME_LOCAL_NED:
            raise ValueError("Unsupported MAVLink coordinate frame")
        if message.type_mask == POSITION_MASK:
            return {"kind": "fly_to", "x": number(message.y, "east"),
                    "y": -number(message.z, "down"), "z": -number(message.x, "north")}
        if message.type_mask == HOLD_MASK and all(number(v, "hold velocity") == 0 for v in (message.vx, message.vy, message.vz)):
            return {"kind": "hover"}
        raise ValueError("Unsupported MAVLink setpoint mask or nonzero hold velocity")

    def accept_command(self, message):
        if (message.target_system, message.target_component) != (self.system_id, VEHICLE_COMPONENT):
            raise ValueError("MAVLink command addressed to another system/component")
        if message.get_type() == "SET_POSITION_TARGET_LOCAL_NED":
            return self.setpoint_action(message)
        if message.get_type() != "COMMAND_LONG":
            raise ValueError("Unsupported MAVLink command message")
        if message.command == mav.MAV_CMD_CONDITION_YAW:
            value = number(message.param1, "heading")
            if not 0 <= value <= 360 or any(v != 0 for v in (message.param2, message.param3, message.param4, message.param5, message.param6, message.param7)):
                raise ValueError("Only an absolute, shortest-path yaw command is supported")
            return {"kind": "look", "heading": heading(value)}
        if message.command == mav.MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW:
            value = number(message.param1, "camera pitch")
            if not all(math.isnan(v) for v in (message.param2, message.param3, message.param4)) or (message.param5, message.param6, message.param7) != (PITCH_FLAGS, 0, 0):
                raise ValueError("Only horizon-locked camera pitch is supported")
            return {"kind": "look", "pitch": value}
        raise ValueError("Unsupported MAVLink COMMAND_LONG command")

    def execute(self, message):
        incoming = self.transfer(message, True)
        # The endpoint determines the action from the actual received bytes.
        action = self.accept_command(incoming)
        if incoming.get_type() == "SET_POSITION_TARGET_LOCAL_NED":
            echoed = self.vehicle_codec.position_target_local_ned_encode(
                incoming.time_boot_ms, incoming.coordinate_frame, incoming.type_mask,
                incoming.x, incoming.y, incoming.z, incoming.vx, incoming.vy, incoming.vz,
                incoming.afx, incoming.afy, incoming.afz, incoming.yaw, incoming.yaw_rate)
            response = self.transfer(echoed, False)
            if response.time_boot_ms != incoming.time_boot_ms:
                raise ValueError("MAVLink setpoint timestamp mismatch")
            return self.setpoint_action(response)
        ack = self.vehicle_codec.command_ack_encode(incoming.command, mav.MAV_RESULT_ACCEPTED,
                                                    100, 0, BRIDGE_SYSTEM, BRIDGE_COMPONENT)
        response = self.transfer(ack, False)
        if (response.command, response.result, response.target_system, response.target_component) != (
                incoming.command, mav.MAV_RESULT_ACCEPTED, BRIDGE_SYSTEM, BRIDGE_COMPONENT):
            raise ValueError("MAVLink command acknowledgement mismatch")
        # COMMAND_ACK does not echo angles. Retain only the endpoint's decoded
        # command, and release it to Node only after the matching wire ACK.
        return action


class FleetBridge:
    def __init__(self, roster, on_event=lambda event: None):
        self.pairs = {drone: Pair(drone, system, on_event) for drone, system in parse_roster(roster).items()}
        self.on_event = on_event

    def close(self):
        for pair in self.pairs.values():
            pair.close()

    def status(self):
        return {"protocol": "MAVLink2", "dialect": "common", "simulatedEndpoint": True,
                "endpoints": [pair.status() for pair in self.pairs.values()]}

    def pair(self, drone):
        if drone not in self.pairs:
            raise ValueError("Unknown MAVLink drone identity")
        return self.pairs[drone]

    def command(self, params):
        pair = self.pair(params["droneId"])
        args = params["args"]
        timestamp = boot_ms(params["simTime"])
        kind = args.get("kind")
        codec = pair.bridge_codec
        if kind in ("fly_to", "hover"):
            x, y, z = (-number(args.get("z"), "z"), number(args.get("x"), "x"),
                       -number(args.get("y"), "y")) if kind == "fly_to" else (0, 0, 0)
            messages = [codec.set_position_target_local_ned_encode(timestamp, pair.system_id,
                VEHICLE_COMPONENT, mav.MAV_FRAME_LOCAL_NED, POSITION_MASK if kind == "fly_to" else HOLD_MASK,
                x, y, z, 0, 0, 0, 0, 0, 0, 0, 0)]
        elif kind == "look":
            messages = []
            if "heading" in args or "pitch" not in args:
                value = heading(number(args.get("heading", params.get("currentHeading")), "heading"))
                messages.append(codec.command_long_encode(pair.system_id, VEHICLE_COMPONENT,
                    mav.MAV_CMD_CONDITION_YAW, 0, value, 0, 0, 0, 0, 0, 0))
            if "pitch" in args:
                value = number(args["pitch"], "pitch")
                messages.append(codec.command_long_encode(pair.system_id, VEHICLE_COMPONENT,
                    mav.MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW, 0, value, math.nan, math.nan, math.nan, PITCH_FLAGS, 0, 0))
        else:
            raise ValueError("Unknown action kind")
        action = {}
        for message in messages:
            action.update(pair.execute(message))
        self.on_event({"event": "wire", "protocol": "MAVLink2", "droneId": pair.drone,
                       "kind": action["kind"], "messages": [message.get_type() for message in messages],
                       "decodedAction": action, "systemId": pair.system_id, "sent": pair.sent, "received": pair.received})
        return action

    def sample(self, params):
        pair = self.pair(params["droneId"])
        pose = params["pose"]
        timestamp = boot_ms(params["simTime"])
        north, east, down = -number(pose["z"], "z"), number(pose["x"], "x"), -number(pose["y"], "y")
        hdg = heading(-number(pose["yaw"], "yaw"))
        yaw = math.radians((hdg + 180) % 360 - 180)
        position = pair.transfer(pair.vehicle_codec.local_position_ned_encode(timestamp, north, east, down, 0, 0, 0), False)
        attitude = pair.transfer(pair.vehicle_codec.attitude_encode(timestamp, 0, 0, yaw, 0, 0, 0), False)
        if position.time_boot_ms != attitude.time_boot_ms or position.time_boot_ms != timestamp:
            raise ValueError("MAVLink telemetry timestamps do not match")
        return {"position": {"x": number(position.y, "east"), "y": -number(position.z, "down"),
                             "z": -number(position.x, "north")},
                "heading": {"degrees": heading(math.degrees(number(attitude.yaw, "yaw")))},
                "simTime": position.time_boot_ms / 1000}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--roster", required=True)
    args = parser.parse_args()
    bridge = FleetBridge(args.roster, emit)
    emit({"event": "ready", **bridge.status()})
    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                method, params = request.get("method"), request.get("params", {})
                if method == "stop":
                    emit({"id": request.get("id"), "result": {"stopped": True}})
                    break
                if method == "status":
                    result = bridge.status()
                elif method in ("command", "sample"):
                    result = getattr(bridge, method)(params)
                else:
                    raise ValueError("Unknown MAVLink RPC method")
                emit({"id": request.get("id"), "result": result})
            except Exception as error:
                emit({"id": request.get("id") if isinstance(request, dict) else None,
                      "error": str(error)})
    finally:
        bridge.close()


if __name__ == "__main__":
    main()
