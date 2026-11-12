/**
 * Synthetic LiDAR scene generator.
 *
 * Simulates a 64-beam spinning LiDAR mounted on a vehicle in an urban street:
 * rays are cast analytically against a ground plane and a set of oriented boxes
 * (cars, pedestrians, cyclists, buildings, poles, trees). The result has the
 * ring structure, occlusion shadows and range falloff of real sensor data.
 */

export interface SceneObject {
  kind: 'car' | 'truck' | 'pedestrian' | 'cyclist' | 'building' | 'pole' | 'tree';
  /** Box center (meters, LiDAR frame, Z up). */
  cx: number;
  cy: number;
  cz: number;
  /** Extents along local x (length), y (width), z (height). */
  l: number;
  w: number;
  h: number;
  yaw: number;
}

export interface PointCloud {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
}

export const SENSOR_HEIGHT = 1.8;
const BEAMS = 64;
const ELEV_MIN = (-24.8 * Math.PI) / 180;
const ELEV_MAX = (2.0 * Math.PI) / 180;
const MAX_RANGE = 90;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSceneObjects(seed = 7): SceneObject[] {
  const rnd = mulberry32(seed);
  const objs: SceneObject[] = [];
  const box = (kind: SceneObject['kind'], cx: number, cy: number, l: number, w: number, h: number, yaw = 0, z0 = 0) =>
    objs.push({ kind, cx, cy, cz: z0 + h / 2, l, w, h, yaw });

  // Buildings lining both sides of the street, with gaps between them.
  for (const side of [-1, 1]) {
    let x = -85;
    while (x < 85) {
      const len = 12 + rnd() * 18;
      const depth = 10 + rnd() * 10;
      const height = 8 + rnd() * 16;
      box('building', x + len / 2, side * (14 + depth / 2), len, depth, height);
      x += len + 3 + rnd() * 6;
    }
  }
  // Parked cars along both curbs.
  for (const side of [-1, 1]) {
    for (let x = -60; x < 60; x += 6.5 + rnd() * 6) {
      if (Math.abs(x) < 5 || rnd() < 0.25) continue;
      box('car', x, side * 5.6, 4.4 + rnd() * 0.5, 1.85, 1.45 + rnd() * 0.2, (rnd() - 0.5) * 0.08);
    }
  }
  // Moving traffic in the two lanes.
  for (const [x, y] of [[12, -2], [-18, 2], [30, 2], [-40, -2], [52, -2]]) {
    if (rnd() < 0.3) box('truck', x, y, 8, 2.5, 3.2, (rnd() - 0.5) * 0.05);
    else box('car', x, y, 4.6, 1.9, 1.5, (rnd() - 0.5) * 0.05);
  }
  // Pedestrians on the sidewalks.
  for (let i = 0; i < 18; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    box('pedestrian', -45 + rnd() * 90, side * (8.5 + rnd() * 3), 0.5, 0.6, 1.6 + rnd() * 0.3, rnd() * Math.PI);
  }
  // Cyclists near the curb.
  for (const x of [-25, 8, 22, 40]) {
    box('cyclist', x, (rnd() < 0.5 ? -1 : 1) * 4.0, 1.8, 0.6, 1.7, (rnd() - 0.5) * 0.2);
  }
  // Street poles and trees on the sidewalk.
  for (const side of [-1, 1]) {
    for (let x = -75; x < 75; x += 15) {
      box('pole', x, side * 7.6, 0.25, 0.25, 6.5);
      const tx = x + 7;
      box('tree', tx, side * 10.5, 0.4, 0.4, 3);
      box('tree', tx, side * 10.5, 3.5, 3.5, 3, rnd(), 3);
    }
  }
  return objs;
}

/** Ray vs oriented (yaw-only) box. Returns hit distance or Infinity. */
function intersectObb(o: SceneObject, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const c = Math.cos(-o.yaw);
  const s = Math.sin(-o.yaw);
  const px = ox - o.cx;
  const py = oy - o.cy;
  const lox = px * c - py * s;
  const loy = px * s + py * c;
  const loz = oz - o.cz;
  const ldx = dx * c - dy * s;
  const ldy = dx * s + dy * c;
  let tmin = 0;
  let tmax = MAX_RANGE;
  const slab = (orig: number, dir: number, half: number) => {
    if (Math.abs(dir) < 1e-9) return orig >= -half && orig <= half;
    let t1 = (-half - orig) / dir;
    let t2 = (half - orig) / dir;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(lox, ldx, o.l / 2) || !slab(loy, ldy, o.w / 2) || !slab(loz, dz, o.h / 2)) return Infinity;
  return tmin > 0 ? tmin : Infinity;
}

/** Turbo-like colormap, t in [0,1]. */
function colormap(t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t));
  const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
  const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
  const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
  return [r, g, b];
}

export function generatePointCloud(targetPoints = 500_000, seed = 7): PointCloud {
  const objects = buildSceneObjects(seed);
  const rnd = mulberry32(seed * 31 + 1);
  const positions = new Float32Array(targetPoints * 3);
  const colors = new Float32Array(targetPoints * 3);
  const oz = SENSOR_HEIGHT;
  let count = 0;
  let attempts = 0;

  while (count < targetPoints && attempts < targetPoints * 10) {
    attempts++;
    const beam = (rnd() * BEAMS) | 0;
    const elev = ELEV_MIN + ((ELEV_MAX - ELEV_MIN) * beam) / (BEAMS - 1);
    const az = rnd() * Math.PI * 2;
    const ce = Math.cos(elev);
    const dx = ce * Math.cos(az);
    const dy = ce * Math.sin(az);
    const dz = Math.sin(elev);

    let t = dz < 0 ? -oz / dz : Infinity;
    let hit: SceneObject | null = null;
    for (let i = 0; i < objects.length; i++) {
      const ti = intersectObb(objects[i], 0, 0, oz, dx, dy, dz);
      if (ti < t) {
        t = ti;
        hit = objects[i];
      }
    }
    if (t > MAX_RANGE) continue;

    t += (rnd() - 0.5) * 0.04; // range noise ±2cm
    const x = dx * t;
    const y = dy * t;
    const z = oz + dz * t;
    const i3 = count * 3;
    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = hit ? z : 0;

    let r: number, g: number, b: number;
    if (!hit) {
      // Ground: grey with distance falloff; painted lane markings are bright.
      const centerDash = Math.abs(y) < 0.12 && ((x + 200) % 6) < 3;
      const edgeLine = Math.abs(Math.abs(y) - 7) < 0.12;
      const sidewalk = Math.abs(y) > 7;
      let v = (sidewalk ? 0.34 : 0.24) * (1 - Math.min(t, 80) / 160);
      if (centerDash || edgeLine) v = 0.9;
      r = g = b = v;
    } else {
      [r, g, b] = colormap(z / 8);
    }
    colors[i3] = r;
    colors[i3 + 1] = g;
    colors[i3 + 2] = b;
    count++;
  }

  return { positions: positions.subarray(0, count * 3), colors: colors.subarray(0, count * 3), count };
}
