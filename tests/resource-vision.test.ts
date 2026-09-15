import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { cameraFovFor, DRONE_CAMERA } from '../shared/camera-profile.ts';
import type { ResourceNode } from '../shared/rts.ts';
import type { Pose } from '../shared/types.ts';
import { ResourceVision } from '../server/resource-vision.ts';

const pose: Pose = { x: 0, y: 4, z: 0, yaw: 0, pitch: 0 };
const resource = (id = 'seen', x = 0, z = -10): ResourceNode => ({
  id, x, y: pose.y - 0.65, z, remaining: 150, capacity: 150,
});

test('zoom requires equipped optics and an explicit zoom mode; old drones retain the wide camera', () => {
  assert.equal(cameraFovFor({}), DRONE_CAMERA.fov);
  assert.equal(cameraFovFor({ cameraMode: 'zoom' }), DRONE_CAMERA.fov);
  assert.equal(cameraFovFor({ equipment: { optics: true } }), DRONE_CAMERA.fov);
  assert.equal(cameraFovFor({ equipment: { optics: true }, cameraMode: 'wide' }), DRONE_CAMERA.fov);
  assert.equal(cameraFovFor({ equipment: { optics: false }, cameraMode: 'zoom' }), DRONE_CAMERA.fov);
  assert.ok(cameraFovFor({ equipment: { optics: true }, cameraMode: 'zoom' }) < DRONE_CAMERA.fov);
});

test('private resource evidence follows actual wide and zoom image edges, including tilted cameras', () => {
  for (const fov of [DRONE_CAMERA.fov, cameraFovFor({ equipment: { optics: true }, cameraMode: 'zoom' })]) {
    for (const [yaw, pitch] of [[0, 0], [75, -35], [-140, 55]]) {
      const tilted: Pose = { ...pose, yaw, pitch };
      const camera = new PerspectiveCamera(fov, DRONE_CAMERA.width / DRONE_CAMERA.height, DRONE_CAMERA.near, DRONE_CAMERA.far);
      camera.position.set(tilted.x, tilted.y, tilted.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(MathUtils.degToRad(pitch), MathUtils.degToRad(yaw), 0);
      camera.updateMatrixWorld();
      const depth = 4, halfHeight = depth * Math.tan(MathUtils.degToRad(fov / 2));
      for (const axis of ['x', 'y'] as const) for (const sign of [-1, 1]) {
        const atImageEdge = (edge: number): ResourceNode => {
          const point = new Vector3(0, 0, -depth);
          point[axis] = sign * edge * halfHeight * (axis === 'x' ? camera.aspect : 1);
          point.applyMatrix4(camera.matrixWorld);
          assert.ok(Math.abs(point.clone().project(camera)[axis] - sign * edge) < 1e-10);
          return { ...resource(), x: point.x, y: point.y - 0.65, z: point.z };
        };
        const vision = new ResourceVision();
        vision.record('drone-1', tilted, 1, 0, true, [atImageEdge(0.90)], [], fov);
        assert.equal(vision.select('drone-1', 1, 0), 'seen');
        // Recognition preserves the existing inset from the delivered image's edge.
        vision.record('drone-1', tilted, 1, 0, true, [atImageEdge(0.94)], [], fov);
        assert.equal(vision.select('drone-1', 1, 0), undefined);
      }
    }
  }
});

test('zoom excludes an off-axis resource present in wide view; omitted FOV remains backward compatible', () => {
  const vision = new ResourceVision(), node = resource('edge', 8);
  vision.record('drone-1', pose, 1, 0, true, [node], []);
  vision.record('drone-2', pose, 1, 0, true, [node], [], DRONE_CAMERA.fov);
  assert.equal(vision.select('drone-1', 1, 0), 'edge');
  assert.equal(vision.select('drone-2', 1, 0), 'edge');
  vision.record('drone-1', pose, 1, 1, true, [node], [], cameraFovFor({ equipment: { optics: true }, cameraMode: 'zoom' }));
  assert.equal(vision.select('drone-1', 1, 1), undefined);
});

test('zoom preserves resource occlusion, finite supply and the existing evidence distance limit', () => {
  const vision = new ResourceVision(), fov = cameraFovFor({ equipment: { optics: true }, cameraMode: 'zoom' });
  const wall = { x: 0, z: -5, width: 2, depth: 1, height: 10, rotation: 35 };
  vision.record('drone-1', pose, 1, 0, true, [resource()], [wall], fov);
  assert.equal(vision.select('drone-1', 1, 0), undefined);
  vision.record('drone-1', pose, 1, 0, true, [resource()], [], fov);
  assert.equal(vision.select('drone-1', 1, 0), 'seen');
  vision.record('drone-1', pose, 1, 0, true, [resource('far', 0, -20.1), { ...resource('empty'), remaining: 0 }, resource('behind', 0, 10)], [], fov);
  assert.equal(vision.select('drone-1', 1, 0), undefined);
});

test('unavailable images replace old sightings and evidence remains private to its drone and mission', () => {
  const vision = new ResourceVision();
  vision.record('drone-1', pose, 1, 10, true, [resource()], []);
  assert.equal(vision.select('drone-1', 1, 10), 'seen');
  assert.equal(vision.select('drone-2', 1, 10), undefined);
  assert.equal(vision.select('drone-1', 2, 10), undefined);
  assert.equal(vision.select('drone-1', 1, 25), 'seen');
  assert.equal(vision.select('drone-1', 1, 25.01), undefined);
  vision.record('drone-1', pose, 1, 11, false, [resource()], []);
  assert.equal(vision.select('drone-1', 1, 11), undefined);
  vision.record('drone-1', pose, 2, 12, true, [resource('new-mission')], []);
  assert.equal(vision.select('drone-1', 1, 12), undefined);
  assert.equal(vision.select('drone-1', 2, 12), 'new-mission');
  vision.record('drone-2', pose, 1, 12, true, [resource('peer')], []);
  vision.forget('drone-1');
  assert.equal(vision.select('drone-1', 2, 12), undefined);
  assert.equal(vision.select('drone-2', 1, 12), 'peer');
  vision.clear();
  assert.equal(vision.select('drone-2', 1, 12), undefined);
});
