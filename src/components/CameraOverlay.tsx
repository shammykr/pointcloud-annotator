import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Annotation, BoxAnnotation, LabelClass, PolygonAnnotation, Tool } from '../annotations/types';
import { SENSOR_CAMERA, projectToImage } from '../scene/sensorCamera';
import type { Viewer } from '../scene/Viewer';
import styles from './CameraOverlay.module.css';

interface Props {
  viewer: Viewer;
  cloud: { positions: Float32Array; count: number };
  annotations: Annotation[];
  labels: LabelClass[];
  activeLabel: string;
  selectedId: string | null;
  tool: Tool;
  onCreatePolygon(vertices: [number, number][]): void;
  onSelect(id: string | null): void;
  onClose(): void;
}

const { width: W, height: H } = SENSOR_CAMERA;
const CLOSE_RADIUS_PX = 14;
const MAX_DEPTH = 70;

/**
 * Camera projection overlay: renders the LiDAR cloud projected into the
 * virtual front camera (a simulated 2D image plane), draws projected 3D boxes
 * and 2D polygon labels on top, and hosts the polygon labeling tool. The same
 * canvas is used as a texture on the image plane inside the 3D scene.
 */
export function CameraOverlay(props: Props) {
  const { viewer, cloud, annotations, labels, activeLabel, selectedId, tool, onCreatePolygon, onSelect, onClose } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [lookThrough, setLookThrough] = useState(false);

  // Project the point cloud once into a depth-colored base image (with z-buffer).
  const base = useMemo(() => projectCloud(viewer.sensorCamera, cloud.positions, cloud.count), [viewer, cloud]);

  const colorOf = useCallback((id: string) => labels.find((l) => l.id === id)?.color ?? '#fff', [labels]);

  // Attach the canvas as the textured image plane in the 3D scene while open.
  useEffect(() => {
    viewer.setProjectionOverlay(canvasRef.current);
    return () => {
      viewer.setProjectionOverlay(null);
      viewer.lookThroughSensor(false);
    };
  }, [viewer]);

  useEffect(() => viewer.lookThroughSensor(lookThrough), [viewer, lookThrough]);

  // Redraw composite image whenever anything visible changes.
  useEffect(() => {
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.putImageData(base, 0, 0);
    for (const a of annotations) {
      if (a.type === 'box') drawProjectedBox(ctx, viewer.sensorCamera, a, colorOf(a.label), a.id === selectedId);
    }
    for (const a of annotations) {
      if (a.type === 'polygon') drawPolygon(ctx, a.vertices, colorOf(a.label), a.id === selectedId, true);
    }
    if (draft.length) {
      const pts = cursor ? [...draft, cursor] : draft;
      drawPolygon(ctx, pts, colorOf(activeLabel), true, false);
      const [fx, fy] = draft[0];
      ctx.beginPath();
      ctx.arc(fx, fy, CLOSE_RADIUS_PX / 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    viewer.refreshProjectionOverlay();
  }, [base, annotations, selectedId, draft, cursor, activeLabel, colorOf, viewer]);

  // Leaving the polygon tool discards an unfinished polygon.
  useEffect(() => {
    if (tool !== 'polygon') setDraft([]);
  }, [tool]);

  const finish = useCallback(() => {
    if (draft.length >= 3) onCreatePolygon(draft);
    setDraft([]);
  }, [draft, onCreatePolygon]);

  // Drafting keys take priority over global shortcuts (capture phase + stopImmediatePropagation).
  useEffect(() => {
    if (!draft.length) return;
    const onKey = (e: KeyboardEvent) => {
      let handled = true;
      if (e.key === 'Enter') finish();
      else if (e.key === 'Escape') setDraft([]);
      else if (e.key === 'Backspace' || e.key === 'Delete' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z'))
        setDraft((d) => d.slice(0, -1));
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [draft, finish]);

  const toImage = (e: React.MouseEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const handleClick = (e: React.MouseEvent) => {
    const p = toImage(e);
    if (tool === 'polygon') {
      if (e.detail > 1) return; // double-click handled separately
      if (draft.length >= 3 && Math.hypot(p[0] - draft[0][0], p[1] - draft[0][1]) < CLOSE_RADIUS_PX) finish();
      else setDraft((d) => [...d, p]);
      return;
    }
    const hit = [...annotations].reverse().find((a) => a.type === 'polygon' && pointInPolygon(p, a.vertices));
    onSelect(hit?.id ?? null);
  };

  return (
    <div className={`${styles.panel} ${tool === 'polygon' ? styles.large : ''}`}>
      <div className={styles.header}>
        <span>
          <strong>{SENSOR_CAMERA.name}</strong> · {W}×{H} · projected LiDAR
        </span>
        <span className={styles.actions}>
          <label>
            <input type="checkbox" checked={lookThrough} onChange={(e) => setLookThrough(e.target.checked)} /> Look through camera
          </label>
          <button onClick={onClose} title="Close overlay (C)">✕</button>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className={styles.canvas}
        style={{ cursor: tool === 'polygon' ? 'crosshair' : 'default' }}
        onClick={handleClick}
        onDoubleClick={() => tool === 'polygon' && finish()}
        onMouseMove={(e) => draft.length && setCursor(toImage(e))}
        onMouseLeave={() => setCursor(null)}
      />
      <div className={styles.hint}>
        {tool === 'polygon'
          ? draft.length
            ? `${draft.length} vertices · click first vertex / double-click / Enter to close · Backspace removes last · Esc cancels`
            : 'Polygon tool: click to place vertices on the image'
          : 'Press P to label polygons on this view'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- drawing ---

function projectCloud(cam: THREE.PerspectiveCamera, positions: Float32Array, count: number): ImageData {
  const img = new ImageData(W, H);
  const depth = new Float32Array(W * H).fill(Infinity);
  const data = img.data;
  // Dark background standing in for the camera image.
  for (let i = 0; i < W * H; i++) {
    const y = Math.floor(i / W);
    const v = y < H * 0.5 ? 18 : 26;
    data[i * 4] = v;
    data[i * 4 + 1] = v + 2;
    data[i * 4 + 2] = v + 6;
    data[i * 4 + 3] = 255;
  }
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  const view = cam.matrixWorldInverse.elements;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const d = -(view[2] * x + view[6] * y + view[10] * z + view[14]); // camera-space depth
    if (d < cam.near || d > MAX_DEPTH) continue;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const u = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) / 2) * W;
    const v = ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) / 2) * H;
    const [r, g, b] = depthColor(d / MAX_DEPTH);
    // 2×2 splat with depth test
    for (let oy = 0; oy < 2; oy++) {
      for (let ox = 0; ox < 2; ox++) {
        const px = (u | 0) + ox, py = (v | 0) + oy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const k = py * W + px;
        if (d >= depth[k]) continue;
        depth[k] = d;
        data[k * 4] = r;
        data[k * 4 + 1] = g;
        data[k * 4 + 2] = b;
      }
    }
  }
  return img;
}

/** Near = warm, far = cool. */
function depthColor(t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t)) ** 0.6;
  return [255 * (1 - t), 255 * (0.35 + 0.65 * Math.sin(Math.PI * t)) * 0.9, 255 * t];
}

const corner = new THREE.Vector3();
function drawProjectedBox(ctx: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, b: BoxAnnotation, color: string, selected: boolean) {
  const { length: l, width: w, height: h } = b.dimensions;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const pts: [number, number][] = [];
  for (const [sx, sy, sz] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) {
    const lx = (sx * l) / 2, ly = (sy * w) / 2;
    corner.set(b.position.x + lx * c - ly * s, b.position.y + lx * s + ly * c, b.position.z + (sz * h) / 2);
    const p = projectToImage(cam, corner);
    if (!p) return; // box (partly) behind the camera
    pts.push([p[0], p[1]]);
  }
  ctx.strokeStyle = selected ? '#ffffff' : color;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.beginPath();
  for (const [a, z] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
    ctx.moveTo(...pts[a]);
    ctx.lineTo(...pts[z]);
  }
  ctx.stroke();
}

function drawPolygon(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, selected: boolean, closed: boolean) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  if (closed) {
    ctx.closePath();
    ctx.fillStyle = color + (selected ? '66' : '40');
    ctx.fill();
  }
  ctx.strokeStyle = selected ? '#ffffff' : color;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.stroke();
  ctx.fillStyle = selected ? '#ffffff' : color;
  for (const [x, y] of pts) ctx.fillRect(x - 3, y - 3, 6, 6);
}

function pointInPolygon([x, y]: [number, number], poly: PolygonAnnotation['vertices']) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
