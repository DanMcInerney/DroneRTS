import { resolve } from 'node:path';
import { DRONE_IDS, type DroneId, type Pose } from '../shared/types.ts';
import { PythonRpc } from './python-rpc.ts';

type WireEvent = Record<string, unknown>;
export type MavlinkSample = {
  position: { x: number; y: number; z: number };
  heading: { degrees: number };
  simTime: number;
};

/** Local simulated MAVLink endpoints; all accepted values cross actual UDP. */
export class MavlinkAdapter {
  private rpc: PythonRpc;
  private started = false;
  private stopped = false;
  private startPromise?: Promise<void>;

  constructor({ projectDir, onEvent }: { projectDir: string; onEvent?: (event: WireEvent) => void }) {
    const python = process.env.FLEET_PYTHON || resolve(projectDir,
      process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    this.rpc = new PythonRpc(resolve(projectDir, 'network/mavlink.py'), [], event => {
      if (event.event === 'fatal') this.started = false;
      onEvent?.(event);
    }, python);
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('MAVLink adapter has stopped; create a new adapter to restart'));
    this.startPromise ??= (async () => {
      await this.rpc.start();
      if (this.stopped) throw new Error('MAVLink adapter startup cancelled');
      this.started = true;
    })();
    return this.startPromise;
  }

  private requireDrone(droneId: DroneId) {
    if (!this.started) throw new Error('MAVLink adapter is not running');
    if (!DRONE_IDS.includes(droneId)) throw new Error('Unknown MAVLink drone identity');
  }

  async command(droneId: DroneId, args: Record<string, unknown>, currentPose: Pose, simTime: number): Promise<Record<string, unknown>> {
    this.requireDrone(droneId);
    // Mission is local pending-request metadata, never a MAVLink field. Do not
    // forward unrelated tool arguments or any world state into this endpoint.
    const mission = args.mission;
    const wireArgs = Object.fromEntries(['kind', 'x', 'y', 'z', 'heading', 'pitch']
      .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const decoded = await this.rpc.request('command', {
      droneId, args: wireArgs, currentHeading: ((-currentPose.yaw % 360) + 360) % 360, simTime,
    });
    return { ...decoded, ...(mission === undefined ? {} : { mission }) };
  }

  async sample(droneId: DroneId, pose: Pose, simTime: number): Promise<MavlinkSample> {
    this.requireDrone(droneId);
    // Camera pitch is an actuator state, not a sensor. It never enters telemetry.
    const decoded = await this.rpc.request('sample', {
      droneId, pose: { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw }, simTime,
    });
    return {
      position: { x: decoded.position.x, y: decoded.position.y, z: decoded.position.z },
      heading: { degrees: decoded.heading.degrees }, simTime: decoded.simTime,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    await this.rpc.stop();
  }
}
