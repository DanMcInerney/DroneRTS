import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MavlinkAdapter } from '../server/mavlink.ts';
import { DRONE_IDS, type DroneId, type Pose } from '../shared/types.ts';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.FLEET_PYTHON || resolve(projectDir,
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const pose: Pose = { x: 3.123456789, y: 7, z: -9, yaw: -90, pitch: -23 };
const near = (actual: number, expected: number, tolerance = 0.00002) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('MAVLink 2 actions and telemetry cross isolated UDP endpoints for all three drones', async t => {
  const events: any[] = [];
  const adapter = new MavlinkAdapter({ projectDir, onEvent: event => events.push(event) });
  t.after(() => adapter.stop());
  await adapter.start();
  const ready = events.find(event => event.event === 'ready');
  assert.equal(ready.protocol, 'MAVLink2');
  assert.equal(ready.simulatedEndpoint, true);
  assert.deepEqual(ready.endpoints.map((endpoint: any) => endpoint.systemId), [1, 2, 3]);
  const sockets = ready.endpoints.flatMap((endpoint: any) => [endpoint.bridge, endpoint.vehicle]);
  assert.equal(new Set(sockets.map((endpoint: any) => endpoint[1])).size, 6);
  for (const [address, port] of sockets) {
    assert.equal(address, '127.0.0.1');
    assert.ok(port > 0 && port !== 4317 && port !== 4318);
  }
  await Promise.all(DRONE_IDS.map(async (droneId, index) => {
    const waypoint = { kind: 'fly_to', x: 11.123456789 + index, y: 9.876543219,
      z: -13.234567891, mission: 43, hiddenWorld: { pads: ['must never return'] } };
    const action = await adapter.command(droneId, waypoint, pose, 12.345);
    assert.deepEqual(action, { kind: 'fly_to', x: Math.fround(waypoint.x), y: Math.fround(waypoint.y),
      z: Math.fround(waypoint.z), mission: 43 });
    assert.notEqual(action.x, waypoint.x, 'float32 wire values must determine the actual command');
    assert.deepEqual(await adapter.command(droneId, { kind: 'hover', mission: 43 }, pose, 12.346),
      { kind: 'hover', mission: 43 });
    assert.deepEqual(await adapter.command(droneId,
      { kind: 'look', heading: 273.123456789, pitch: -38.123456789, mission: 43 }, pose, 12.347),
      { kind: 'look', heading: Math.fround(273.123456789), pitch: Math.fround(-38.123456789), mission: 43 });
    const sample = await adapter.sample(droneId, { ...pose, yaw: [-90, 90, 180][index] }, 12.3484);
    assert.deepEqual(Object.keys(sample).sort(), ['heading', 'position', 'simTime']);
    assert.deepEqual(sample.position, { x: Math.fround(pose.x), y: 7, z: -9 });
    assert.deepEqual(Object.keys(sample.heading), ['degrees']);
    near(sample.heading.degrees, [90, 270, 180][index]);
    assert.equal(sample.simTime, 12.348);
  }));
  for (const droneId of DRONE_IDS) {
    const wire = events.filter(event => event.event === 'wire' && event.droneId === droneId);
    assert.deepEqual(wire.map(event => event.kind), ['fly_to', 'hover', 'look']);
    assert.equal(wire.at(-1).sent, wire.at(-1).received);
    assert.ok(wire.at(-1).sent >= 8, 'commands and their standard responses must cross UDP');
  }
});

test('partial look commands preserve actuator independence; invalid requests never bypass wire checks', async t => {
  const adapter = new MavlinkAdapter({ projectDir });
  t.after(() => adapter.stop());
  await assert.rejects(adapter.sample('drone-1', pose, 0), /not running/);
  await adapter.start();
  assert.deepEqual(await adapter.command('drone-1', { kind: 'look', pitch: -45 }, pose, 1), { kind: 'look', pitch: -45 });
  assert.deepEqual(await adapter.command('drone-1', { kind: 'look', heading: -90 }, pose, 1), { kind: 'look', heading: 270 });
  assert.deepEqual(await adapter.command('drone-1', { kind: 'look' }, pose, 1), { kind: 'look', heading: 90 });
  near((await adapter.sample('drone-1', { ...pose, yaw: 720 }, 1)).heading.degrees, 0);
  await assert.rejects(adapter.command('drone-9' as DroneId, { kind: 'hover' }, pose, 1), /identity/);
  await assert.rejects(adapter.command('drone-1', { kind: 'teleport' }, pose, 1), /Unknown action/);
  await assert.rejects(adapter.command('drone-1', { kind: 'fly_to', x: Infinity, y: 7, z: 0 }, pose, 1), /finite/);
  await assert.rejects(adapter.command('drone-1', { kind: 'look', pitch: NaN }, pose, 1), /finite/);
  await assert.rejects(adapter.sample('drone-1', pose, -1), /millisecond interval/);
  assert.equal((await adapter.sample('drone-1', pose, 2)).simTime, 2);
});

test('reference dialect rejects corrupt, malformed and misdirected real UDP packets and recovers', async () => {
  const script = `
import json, math, socket, sys
sys.path.insert(0, 'network')
import mavlink as bridge
from pymavlink.dialects.v20 import common as m
b = bridge.FleetBridge()
p = b.pairs['drone-2']
c = p.bridge_codec
def waypoint(**changes):
    fields = dict(time_boot_ms=1234, target_system=2, target_component=1,
        coordinate_frame=1, type_mask=bridge.POSITION_MASK,
        x=9.25, y=-7.5, z=-6.75, vx=0, vy=0, vz=0,
        afx=0, afy=0, afz=0, yaw=0, yaw_rate=0)
    fields.update(changes)
    return c.set_position_target_local_ned_encode(**fields)
msg = waypoint()
valid = p.pack(msg, True)
seq = valid[4]
def reject(raw, sender=None):
    before = p.rejected
    (sender or p.bridge).sendto(raw, p.vehicle.getsockname())
    try:
        p.receive(p.vehicle, p.bridge.getsockname(), 255, bridge.BRIDGE_COMPONENT, seq, msg.get_msgId(), timeout=0.025)
        raise AssertionError('Invalid packet was accepted')
    except TimeoutError:
        pass
    assert p.rejected == before + 1
corrupt = bytearray(valid)
corrupt[15] ^= 1
reject(bytes(corrupt))
reject(valid[:-1])
reject(valid + valid)
reject(b'{"kind":"fly_to"}')
reject(msg.pack(c, force_mavlink1=True))
flags = bytearray(valid)
flags[2] = 1
reject(bytes(flags))
for source, component, sequence in [(1, bridge.BRIDGE_COMPONENT, seq), (255, 1, seq), (255, bridge.BRIDGE_COMPONENT, (seq+1)%256)]:
    other = m.MAVLink(None, srcSystem=source, srcComponent=component)
    other.seq = sequence
    reject(msg.pack(other))
spoof = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
spoof.bind(('127.0.0.1', 0))
reject(valid, spoof)
spoof.close()
p.bridge.sendto(valid, p.vehicle.getsockname())
recovered = p.receive(p.vehicle, p.bridge.getsockname(), 255, bridge.BRIDGE_COMPONENT, seq, msg.get_msgId())
assert recovered.x == 9.25
for changes in [dict(target_system=1), dict(target_component=2), dict(coordinate_frame=8),
                dict(type_mask=0), dict(x=math.nan), dict(type_mask=bridge.HOLD_MASK, vx=1)]:
    try:
        p.execute(waypoint(**changes))
        raise AssertionError('Invalid command was accepted')
    except ValueError:
        pass
assert p.execute(waypoint()) == dict(kind='fly_to', x=-7.5, y=6.75, z=-9.25)
assert not any('mission' in field for field in msg.fieldnames)
p.vehicle.close()
try:
    p.execute(waypoint())
    raise AssertionError('Closed transport silently accepted a command')
except OSError:
    pass
b.close()
print(json.dumps(dict(rejected=p.rejected, validRecovery=True)))
`;
  const { stdout } = await promisify(execFile)(python, ['-c', script], { cwd: projectDir, windowsHide: true, timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { rejected: 10, validRecovery: true });
});

test('Stop cancels startup, remains idempotent, and prevents a delayed start', async () => {
  const stoppedFirst = new MavlinkAdapter({ projectDir });
  await stoppedFirst.stop();
  await assert.rejects(stoppedFirst.start(), /stopped/);
  const adapter = new MavlinkAdapter({ projectDir });
  const starting = adapter.start();
  const rejected = assert.rejects(starting, /cancelled|stopped/);
  await Promise.all([adapter.stop(), adapter.stop(), rejected]);
  await assert.rejects(adapter.command('drone-1', { kind: 'hover' }, pose, 0), /not running/);
  await assert.rejects(adapter.start(), /stopped/);
});

test('MAVLink helper releases its process when IPC stdin closes', { timeout: 10000 }, async t => {
  const child = spawn(python, ['-u', resolve(projectDir, 'network/mavlink.py')], {
    cwd: projectDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let buffer = '';
  const ready = await new Promise<any>((resolveReady, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Exited before ready: ${code}`)));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index >= 0) resolveReady(JSON.parse(buffer.slice(0, index)));
    });
  });
  assert.equal(ready.event, 'ready');
  const exited = once(child, 'exit');
  child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
