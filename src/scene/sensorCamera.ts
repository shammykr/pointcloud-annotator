import * as THREE from 'three';
import { SENSOR_HEIGHT } from '../data/syntheticScene';

/**
 * Virtual front camera rigidly mounted next to the LiDAR. Its intrinsics and
 * extrinsics define the 2D image plane used by the projection overlay and by
 * polygon annotations (which are stored in this camera's pixel coordinates).
 */
export const SENSOR_CAMERA = {
  name: 'front_camera',
  width: 1280,
  height: 720,
  vfovDeg: 45,
  position: new THREE.Vector3(0.3, 0, SENSOR_HEIGHT - 0.2),
  forward: new THREE.Vector3(1, 0, 0),
  /** Distance at which the image plane is drawn inside the 3D scene. */
  planeDistance: 12,
};

export function createSensorCamera(): THREE.PerspectiveCamera {
  const c = SENSOR_CAMERA;
  const cam = new THREE.PerspectiveCamera(c.vfovDeg, c.width / c.height, 0.5, 200);
  cam.up.set(0, 0, 1);
  cam.position.copy(c.position);
  cam.lookAt(c.position.clone().add(c.forward));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Pinhole intrinsics (fx, fy, cx, cy) derived from the vertical FOV. */
export function sensorIntrinsics() {
  const c = SENSOR_CAMERA;
  const fy = c.height / 2 / Math.tan(((c.vfovDeg / 2) * Math.PI) / 180);
  return { fx: fy, fy, cx: c.width / 2, cy: c.height / 2, width: c.width, height: c.height };
}

const tmp = new THREE.Vector3();

/** Project a world point to image pixels. Returns null if behind the camera. */
export function projectToImage(cam: THREE.PerspectiveCamera, p: THREE.Vector3): [number, number, number] | null {
  tmp.copy(p).applyMatrix4(cam.matrixWorldInverse);
  const depth = -tmp.z;
  if (depth < cam.near) return null;
  tmp.applyMatrix4(cam.projectionMatrix);
  return [((tmp.x + 1) / 2) * SENSOR_CAMERA.width, ((1 - tmp.y) / 2) * SENSOR_CAMERA.height, depth];
}
