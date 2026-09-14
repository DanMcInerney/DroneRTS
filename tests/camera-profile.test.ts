import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3, MathUtils } from 'three';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { visibleTreasures } from '../server/treasure-hunt.ts';
import type { Pose, Treasure } from '../shared/types.ts';

test('private visual evidence agrees with the rendered camera edges, including tilted views', () => {
  for (const [yaw, pitch] of [[0, 0], [75, -35], [-140, 55]]) {
    const pose: Pose = { x: 10, y: 8, z: -12, yaw, pitch };
    const camera = new PerspectiveCamera(DRONE_CAMERA.fov, DRONE_CAMERA.width / DRONE_CAMERA.height, DRONE_CAMERA.near, DRONE_CAMERA.far);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(MathUtils.degToRad(pitch), MathUtils.degToRad(yaw), 0);
    camera.updateMatrixWorld();
    const depth = 2, halfHeight = depth * Math.tan(MathUtils.degToRad(DRONE_CAMERA.fov / 2));
    for (const axis of ['x', 'y'] as const) for (const sign of [-1, 1]) {
      const chestAtImageEdge = (edge: number): Treasure => {
        const point = new Vector3(0, 0, -depth);
        point[axis] = sign * edge * halfHeight * (axis === 'x' ? camera.aspect : 1);
        point.applyMatrix4(camera.matrixWorld);
        assert.ok(Math.abs(point.clone().project(camera)[axis] - sign * edge) < 1e-10);
        return { id: 'edge-chest', x: point.x, y: point.y - 0.55, z: point.z, found: false };
      };
      // Recognition deliberately requires an inset from the image edge.
      assert.deepEqual(visibleTreasures(pose, [chestAtImageEdge(0.90)], []), ['edge-chest']);
      assert.deepEqual(visibleTreasures(pose, [chestAtImageEdge(0.94)], []), []);
    }
  }
});
