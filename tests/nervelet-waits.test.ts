import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import { DroneNervelet } from '../server/nervelet.ts';
import type { LocalSensors } from '../server/local-sensors.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { DroneId, ToolResult } from '../shared/types.ts';

const body = (result: ToolResult): any => JSON.parse(result.content.find(item => item.type === 'text')!.text);

async function within<T>(pending: Promise<T>, message: string, milliseconds = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext) {
  const game = new FleetGame();
  game.setConnected(true);
  game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((drone, index) => Object.assign(drone, {
    x: -25 + index * 10, y: 30, z: 0, yaw: 0, pitch: -23,
  }));
  game.capture = async id => `data:image/jpeg;base64,${Buffer.from(id).toString('base64')}`;
  const pilots = MATCH_DRONE_IDS.map(id => new DroneNervelet(game, id));
  t.after(async () => {
    game.stop();
    await Promise.all(pilots.map(pilot => pilot.close()));
  });
  for (const pilot of pilots) await pilot.call('observe');
  game.queueMission('Blue wait fixture objective.');
  game.queueMission('Red wait fixture objective.', 'red');
  await game.forwardTeam('blue');
  await game.forwardTeam('red');
  const ready = await Promise.all(pilots.map(async pilot => {
    const initial = body(await pilot.call('observe'));
    return body(await pilot.call('observe', { seen: initial.nervelet.id }));
  }));
  return { game, pilots, ready };
}

async function command(pilot: DroneNervelet, prior: any, tool: string, args: object) {
  const result = body(await pilot.call(tool, {
    seen: prior.nervelet.id, command_id: prior.nervelet.nextCommandId,
    mission: prior.nervelet.goal.version, ...args,
  }));
  assert.equal(result.rejected, undefined, JSON.stringify(result));
  assert.ok(!['rejected', 'unknown', 'not_executed'].includes(result.nervelet.results.at(-1)?.status), JSON.stringify(result.nervelet.results));
  return result;
}

/** Wait for the real change-source registration, not an assumed scheduling delay. */
function registration(t: TestContext, pilot: DroneNervelet, beforeRegister?: () => void) {
  const changes = pilot.bridge.changes;
  const original = changes.wait.bind(changes);
  let entered!: () => void;
  const registered = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  changes.wait = (sequence, signal) => {
    if (first) {
      first = false;
      beforeRegister?.();
      entered();
    }
    return original(sequence, signal);
  };
  t.after(() => { changes.wait = original; });
  return within(registered, 'The actual DroneNervelet never registered its held wait');
}

/** Count both the model snapshot and the underlying finite-range acquisition. */
function acquisitions(t: TestContext, game: FleetGame, id: DroneId) {
  const sensors = (game as unknown as { localSensors: LocalSensors }).localSensors;
  const originalTelemetry = game.onboardTelemetry.bind(game);
  const originalAcquire = sensors.acquire.bind(sensors);
  const counts = { telemetry: 0, sensors: 0 };
  game.onboardTelemetry = drone => {
    if (drone === id) counts.telemetry++;
    return originalTelemetry(drone);
  };
  sensors.acquire = (...args) => {
    if (args[0].id === id) counts.sensors++;
    return originalAcquire(...args);
  };
  t.after(() => { game.onboardTelemetry = originalTelemetry; sensors.acquire = originalAcquire; });
  return counts;
}

test('a real waiting pilot does zero telemetry or sensor work for unrelated operations by all five peers', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0];
  const counts = acquisitions(t, game, pilot.id);
  const registered = registration(t, pilot);
  const pending = pilot.call('wait', { seen: ready[0].nervelet.id, timeout_ms: 30000 });
  await registered;
  await delay(0);
  const before = { ...counts };

  // Peers are outside the waiting pilot's finite sensor coverage. These commands
  // do not spend shared credits, deliver its mail, or alter its capabilities.
  for (let index = 1; index < pilots.length; index++) {
    const peer = pilots[index], drone = game.state.drones[index];
    let prior = ready[index];
    for (let movement = 0; movement < 3; movement++) {
      prior = await command(peer, prior, 'act', { kind: 'fly_to', x: drone.x, y: drone.y + 1 + movement, z: drone.z, replace: true });
    }
    prior = await command(peer, prior, 'act', { kind: 'look', heading: 25, pitch: -35 });
    prior = await command(peer, prior, 'workspace', { op: 'write', path: 'peer-only.txt', content: peer.id });
    await command(peer, prior, 'workspace', { op: 'read', path: 'peer-only.txt' });
    for (let mail = 0; mail < 3; mail++) game.inboxes[peer.id].push({ type: 'peer_notice', mission: 1, text: `private ${mail}` });
    await delay(0);
    assert.deepEqual(counts, before, `${peer.id}'s private actions must not evaluate ${pilot.id}'s wait`);
  }
  for (let change = 0; change < 15; change++) {
    game.emit('change');
    await delay(0);
  }
  assert.deepEqual(counts, before, 'spaced UI changes must not acquire telemetry or range sensors');
  for (let change = 0; change < 15; change++) game.emit('change');
  await delay(0);
  assert.deepEqual(counts, before, 'UI bursts must remain independent of pilot waits');

  game.inboxes[pilot.id].push({ type: 'own_notice', mission: 1 });
  const delivered = body(await within(pending, 'Own mail did not wake the waiting pilot'));
  assert.ok(delivered.events.some((event: any) => event.type === 'own_notice'));
  assert.ok(counts.telemetry > before.telemetry && counts.sensors > before.sensors);
  t.diagnostic('15 peer movement commands, five looks, ten workspace operations, 15 peer inbox events and 30 UI changes: 0 waiter telemetry reads, 0 waiter sensor acquisitions.');
});

test('idle simulation maintains physical sensing without adding ordinary-wait snapshot acquisitions', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0], counts = acquisitions(t, game, pilot.id);
  for (let tick = 0; tick < 5; tick++) game.tick(0.01);
  const physicalSensors = counts.sensors;
  const registered = registration(t, pilot);
  const pending = pilot.call('wait', { seen: ready[0].nervelet.id, timeout_ms: 30000 });
  await registered;
  await delay(0);
  const before = { ...counts };
  for (let tick = 0; tick < 5; tick++) { game.tick(0.01); await delay(0); }
  assert.equal(counts.telemetry, before.telemetry);
  assert.equal(counts.sensors - before.sensors, physicalSensors, 'a held event wait adds no sensor work to the unchanged physics loop');
  game.inboxes[pilot.id].push({ type: 'end_idle_wait', mission: 1 });
  await within(pending, 'Own mail did not end the idle wait');
});

test('own job completion and numeric altitude changes wake from real game updates', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0], drone = game.state.drones[0];
  const prior = await command(pilot, ready[0], 'route', {
    op: 'start', waypoints: [{ x: drone.x, y: drone.y + 1, z: drone.z }],
  });
  const registered = registration(t, pilot);
  const pending = pilot.call('wait', {
    seen: prior.nervelet.id, until: [{ kind: 'jobTerminal', id: prior.job.id }], timeout_ms: 30000,
  });
  await registered;
  for (let tick = 0; tick < 100 && game.onboardTelemetry(pilot.id).job?.state !== 'completed'; tick++) {
    game.tick(0.05);
    await delay(1);
  }
  let next = body(await within(pending, 'Own terminal job did not wake its waiter'));
  assert.equal(next.nervelet.wait.reason, 'jobTerminal');
  assert.equal(next.job.state, 'completed');

  for (const condition of [
    { kind: 'threshold', field: 'altitude', op: 'gt', value: drone.y + 0.25 },
    { kind: 'change', field: 'altitude', deadband: 0.25 },
  ]) {
    const registeredNumeric = registration(t, pilot);
    const numeric = pilot.call('wait', { seen: next.nervelet.id, until: [condition], timeout_ms: 30000 });
    await registeredNumeric;
    drone.y += 1;
    game.tick(0.01);
    next = body(await within(numeric, `${condition.kind} did not wake on its numeric update`));
    assert.equal(next.nervelet.wait.reason, condition.kind);
  }
});

test('plain and anyEvent waits retain delivered unacknowledged backlog slices until seen', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0], acknowledged = game.inboxes[pilot.id].delivered;
  for (let index = 0; index < 60; index++) {
    game.inboxes[pilot.id].push({ type: 'radio', mission: 1, message: { id: `backlog-${index}`, text: 'x'.repeat(4096) } });
  }
  const lost = body(await pilot.call('observe', { seen: ready[0].nervelet.id }));
  assert.equal(lost.hasMore, true);
  for (const args of [{}, { until: [{ kind: 'anyEvent' }] }]) {
    const replay = body(await within(pilot.call('wait', { ...args, timeout_ms: 30000 }), 'Unread delivered events did not wake immediately'));
    assert.ok(replay.events, JSON.stringify(replay));
    assert.deepEqual(replay.events.map((event: any) => event.nerveletEventId), lost.events.map((event: any) => event.nerveletEventId));
    assert.ok(replay.events.every((event: any) => event.redelivered));
    assert.equal(game.inboxes[pilot.id].delivered, acknowledged);
  }
  const received: string[] = [];
  let slice = lost;
  while (slice.events.length) {
    received.push(...slice.events.map((event: any) => event.message.id));
    slice = body(await within(pilot.call('wait', { seen: slice.nervelet.id, timeout_ms: 40 }), 'Backlog acknowledgement did not make delivery progress'));
  }
  assert.deepEqual(received, Array.from({ length: 60 }, (_, index) => `backlog-${index}`));
  assert.equal(slice.nervelet.wait.reason, 'review');
});

test('typed events keep their delivered floor, empty until has no event predicate, and star is literal', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0];
  game.inboxes[pilot.id].push({ type: 'retained_notice', mission: 1 });
  const lost = body(await pilot.call('observe', { seen: ready[0].nervelet.id }));
  for (const until of [[], [{ kind: 'event', type: 'retained_notice' }], [{ kind: 'event', type: '*' }]]) {
    const at = performance.now();
    const next = body(await pilot.call('wait', { until, timeout_ms: 50 }));
    assert.equal(next.nervelet.wait.reason, 'review');
    assert.ok(performance.now() - at >= 35, 'the review deadline must not become an implicit event predicate');
    assert.equal(next.events[0].nerveletEventId, lost.events[0].nerveletEventId);
  }
  const mixed = body(await within(pilot.call('wait', {
    until: [{ kind: 'event', type: 'different_notice' }, { kind: 'anyEvent' }], timeout_ms: 30000,
  }), 'anyEvent did not use its unread floor independently of the typed-event floor'));
  assert.ok(mixed.events, JSON.stringify(mixed));
  assert.equal(mixed.events[0].nerveletEventId, lost.events[0].nerveletEventId);
  assert.notEqual(mixed.nervelet.wait.reason, 'review');

  const registered = registration(t, pilot);
  const literal = pilot.call('wait', { seen: mixed.nervelet.id, until: [{ kind: 'event', type: '*' }], timeout_ms: 60 });
  await registered;
  game.inboxes[pilot.id].push({ type: 'not_a_star', mission: 1 });
  const reviewed = body(await within(literal, 'Literal star wait did not honor its deadline'));
  assert.equal(reviewed.nervelet.wait.reason, 'review', 'a newly retained ordinary event cannot turn star into a wildcard');
  assert.ok(reviewed.events.some((event: any) => event.type === 'not_a_star'));
});

test('an own event between snapshot and change-listener registration cannot be lost', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0];
  const registered = registration(t, pilot, () => {
    game.inboxes[pilot.id].push({ type: 'registration_race', mission: 1 });
  });
  const pending = pilot.call('wait', { seen: ready[0].nervelet.id, timeout_ms: 30000 });
  await registered;
  const next = body(await within(pending, 'An event in the check/subscribe gap was lost'));
  assert.ok(next.events.some((event: any) => event.type === 'registration_race'));
});

test('review deadlines are bounded and cancellation preserves unread events', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0], at = performance.now();
  const reviewed = body(await within(pilot.call('wait', { seen: ready[0].nervelet.id, timeout_ms: 60 }), 'Review deadline did not release the wait'));
  assert.equal(reviewed.nervelet.wait.reason, 'review');
  assert.ok(performance.now() - at >= 45);
  const controller = new AbortController();
  const registered = registration(t, pilot);
  const pending = pilot.call('wait', { seen: reviewed.nervelet.id, timeout_ms: 30000 }, controller.signal);
  await registered;
  game.inboxes[pilot.id].push({ type: 'cancelled_delivery', mission: 1 });
  controller.abort(new Error('caller cancelled held wait'));
  const cancelled = body(await within(pending, 'Caller cancellation did not release held wait'));
  assert.equal(cancelled.cancelled, true);
  assert.ok(game.inboxes[pilot.id].peek().events.some(event => event.type === 'cancelled_delivery'));
  const next = body(await pilot.call('observe'));
  assert.ok(next.events.some((event: any) => event.type === 'cancelled_delivery'));
});

test('explicit lifecycle and connection transitions promptly end held waits', async t => {
  const transitions = {
    Stop: (game: FleetGame) => game.stop(),
    reset: (game: FleetGame) => { game.stop(); game.reset(); game.start(); },
    'session replacement': (game: FleetGame) => game.start(),
    destruction: (game: FleetGame) => { game.state.drones[0].y = -1; game.tick(0.01); },
    disconnect: (game: FleetGame) => game.setConnected(false),
  };
  for (const [name, transition] of Object.entries(transitions)) await t.test(name, async child => {
    const { game, pilots, ready } = await fixture(child);
    const pilot = pilots[0], registered = registration(child, pilot);
    const pending = pilot.call('wait', { seen: ready[0].nervelet.id, timeout_ms: 30000 });
    await registered;
    transition(game);
    const result = body(await within(pending, `${name} did not release held wait`));
    if (name === 'disconnect') {
      assert.equal(result.cancelled, true);
      assert.match(result.reason, /connection/i);
      game.setConnected(true);
      assert.equal(body(await pilot.call('observe')).stopped, false, 'same session can observe after connection recovery');
    } else {
      assert.equal(result.stopped, true, `${name} must invalidate the held session`);
      assert.equal(body(await pilot.call('observe')).stopped, true, 'old bridge cannot reactivate');
    }
  });
});

test('a newly received goal wakes a held wait and preserves the exact new objective', async t => {
  const { game, pilots, ready } = await fixture(t);
  const pilot = pilots[0], registered = registration(t, pilot);
  const pending = pilot.call('wait', { seen: ready[0].nervelet.id, timeout_ms: 30000 });
  await registered;
  game.queueMission('Replacement objective received during wait.');
  await game.forwardTeam('blue');
  await within(pending, 'Received goal did not release the held wait');
  const observed = body(await pilot.call('observe'));
  assert.equal(observed.nervelet.goal.text, 'Replacement objective received during wait.');
  assert.equal(observed.nervelet.goal.version, 2);
});
