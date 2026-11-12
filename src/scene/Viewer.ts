import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BoxAnnotation, LabelClass, Tool, Vec3 } from '../annotations/types';
import { SENSOR_CAMERA, createSensorCamera } from './sensorCamera';

export interface ViewerCallbacks {
  onCreateBox(box: Omit<BoxAnnotation, 'id' | 'type' | 'label'>): void;
  onUpdateBox(id: string, patch: Partial<Pick<BoxAnnotation, 'position' | 'dimensions'>>): void;
  onSelect(id: string | null): void;
}

/** One rendered 3D box: translucent faces, edges and six resize handles. */
interface BoxObject {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial[]>;
  edges: THREE.LineSegments;
  handles: THREE.Mesh[];
  data: BoxAnnotation;
}

type DragState =
  | { kind: 'draw'; start: THREE.Vector3; preview: THREE.Mesh }
  | { kind: 'move'; id: string; plane: THREE.Plane; offset: THREE.Vector3; moved: boolean }
  | { kind: 'resize'; id: string; axis: 0 | 1 | 2; sign: 1 | -1; center: THREE.Vector3; dir: THREE.Vector3; size: number };

const FACE_OPACITY = 0.12;
const FACE_HOVER_OPACITY = 0.45;
const SELECTED_FACE_OPACITY = 0.2;
// BoxGeometry face groups are ordered +x, -x, +y, -y, +z, -z.
const HANDLE_DEFS: { axis: 0 | 1 | 2; sign: 1 | -1 }[] = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
];
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const MIN_SIZE = 0.1;
const DEFAULT_FOV = 60;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sensorCamera = createSensorCamera();

  private container: HTMLElement;
  private callbacks: ViewerCallbacks;
  private points: THREE.Points | null = null;
  private boxes = new Map<string, BoxObject>();
  private boxRoot = new THREE.Group();
  private overlayRoot = new THREE.Group();
  private overlayTexture: THREE.CanvasTexture | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private tool: Tool = 'select';
  private labels: LabelClass[] = [];
  private activeLabel = '';
  private selectedId: string | null = null;
  private drag: DragState | null = null;
  private hover: { id: string; face: number } | { id: string; handle: number } | null = null;
  private downAt = new THREE.Vector2();
  private resizeObserver: ResizeObserver;
  private savedView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  // Frame-rate meter (updated by the render loop, read by the HUD).
  private frames = 0;
  private fpsWindowStart = performance.now();
  fps = 0;
  onFps: ((fps: number) => void) | null = null;

  constructor(container: HTMLElement, callbacks: ViewerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0b0e13);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1000);
    this.camera.up.set(0, 0, 1); // LiDAR convention: Z up
    this.camera.position.set(-28, -26, 24);

    // Our pointer handlers run in the capture phase so they can claim a drag
    // (disabling OrbitControls) before OrbitControls sees the same event.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    el.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this.controls = new OrbitControls(this.camera, el);
    this.controls.target.set(6, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.maxDistance = 300;
    this.controls.update();

    this.scene.add(this.boxRoot, this.overlayRoot);
    this.overlayRoot.visible = false;
    this.addSceneHelpers();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setCallbacks(cb: ViewerCallbacks) {
    this.callbacks = cb;
  }

  // ---------------------------------------------------------------- data ---

  setPointCloud(positions: Float32Array, colors: Float32Array) {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.computeBoundingSphere();
    // Fixed pixel-size points: cheap to rasterize and readable at any zoom.
    const mat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true });
    this.points = new THREE.Points(geom, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.cancelDraw();
    this.renderer.domElement.style.cursor = tool === 'box' ? 'crosshair' : 'default';
  }

  setLabels(labels: LabelClass[], active: string) {
    this.labels = labels;
    this.activeLabel = active;
  }

  /** Reconcile rendered boxes with annotation state. */
  syncBoxes(boxes: BoxAnnotation[], selectedId: string | null) {
    this.selectedId = selectedId;
    const seen = new Set<string>();
    for (const b of boxes) {
      seen.add(b.id);
      let obj = this.boxes.get(b.id);
      if (!obj) {
        obj = this.createBoxObject(b);
        this.boxes.set(b.id, obj);
        this.boxRoot.add(obj.group);
      }
      obj.data = b;
      this.applyBoxTransform(obj, b.position, b.dimensions, b.yaw);
      this.applyBoxStyle(obj);
    }
    for (const [id, obj] of this.boxes) {
      if (!seen.has(id)) {
        this.boxRoot.remove(obj.group);
        obj.mesh.geometry.dispose();
        obj.mesh.material.forEach((m) => m.dispose());
        this.boxes.delete(id);
      }
    }
  }

  // ------------------------------------------------- camera projection ---

  /**
   * Show the sensor camera frustum and a textured image plane (the projected
   * view rendered by the overlay panel) aligned with the point cloud.
   */
  setProjectionOverlay(canvas: HTMLCanvasElement | null) {
    this.overlayRoot.clear();
    this.overlayTexture?.dispose();
    this.overlayTexture = null;
    if (!canvas) {
      this.overlayRoot.visible = false;
      return;
    }
    const c = SENSOR_CAMERA;
    const d = c.planeDistance;
    const h = 2 * d * Math.tan(((c.vfovDeg / 2) * Math.PI) / 180);
    const w = (h * c.width) / c.height;
    this.overlayTexture = new THREE.CanvasTexture(canvas);
    this.overlayTexture.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: this.overlayTexture, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    );
    // Place the plane in the sensor camera's local frame at -d along its view axis.
    plane.position.set(0, 0, -d);
    const frame = new THREE.Group();
    frame.add(plane);
    const corners = [
      [-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2],
    ].map(([x, y]) => new THREE.Vector3(x, y, -d));
    const frustum: THREE.Vector3[] = [];
    corners.forEach((p, i) => frustum.push(new THREE.Vector3(), p, p, corners[(i + 1) % 4]));
    frame.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(frustum),
      new THREE.LineBasicMaterial({ color: 0x9fd3ff, transparent: true, opacity: 0.8 }),
    ));
    frame.position.copy(this.sensorCamera.position);
    frame.quaternion.copy(this.sensorCamera.quaternion);
    this.overlayRoot.add(frame);
    this.overlayRoot.visible = true;
  }

  refreshProjectionOverlay() {
    if (this.overlayTexture) this.overlayTexture.needsUpdate = true;
  }

  /** Move the orbit camera onto the sensor camera so the image plane lines up with the points behind it. */
  lookThroughSensor(on: boolean) {
    if (on) {
      if (!this.savedView) this.savedView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
      this.camera.position.copy(SENSOR_CAMERA.position);
      this.controls.target.copy(SENSOR_CAMERA.position).addScaledVector(SENSOR_CAMERA.forward, SENSOR_CAMERA.planeDistance);
      this.camera.fov = SENSOR_CAMERA.vfovDeg;
    } else if (this.savedView) {
      this.camera.position.copy(this.savedView.pos);
      this.controls.target.copy(this.savedView.target);
      this.camera.fov = DEFAULT_FOV;
      this.savedView = null;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // -------------------------------------------------------------- render ---

  private tick = () => {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    const now = performance.now();
    if (now - this.fpsWindowStart >= 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
      this.onFps?.(this.fps);
    }
  };

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private addSceneHelpers() {
    const grid = new THREE.GridHelper(200, 40, 0x2a3442, 0x1a212b);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ; rotate onto the XY ground
    grid.position.z = -0.02;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(2);
    axes.position.z = 0.01;
    this.scene.add(axes);
  }

  // --------------------------------------------------------------- boxes ---

  private labelColor(label: string) {
    return new THREE.Color(this.labels.find((l) => l.id === label)?.color ?? '#ffffff');
  }

  private createBoxObject(b: BoxAnnotation): BoxObject {
    const color = this.labelColor(b.label);
    const materials = Array.from({ length: 6 }, () =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: FACE_OPACITY, depthWrite: false, side: THREE.DoubleSide }),
    );
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
    mesh.userData.boxId = b.id;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color }),
    );
    const handleGeom = new THREE.SphereGeometry(0.16, 12, 8);
    const handles = HANDLE_DEFS.map((_, i) => {
      const hm = new THREE.Mesh(handleGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      hm.renderOrder = 10;
      hm.userData = { boxId: b.id, handle: i };
      return hm;
    });
    // Heading indicator: a short line from the center out through the +x face.
    const heading = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.5, 0, 0)]),
      new THREE.LineBasicMaterial({ color }),
    );
    const group = new THREE.Group();
    group.add(mesh, edges, heading, ...handles);
    return { group, mesh, edges, handles, data: b };
  }

  private applyBoxTransform(obj: BoxObject, p: Vec3, d: BoxAnnotation['dimensions'], yaw: number) {
    obj.group.position.set(p.x, p.y, p.z);
    obj.group.rotation.set(0, 0, yaw);
    obj.mesh.scale.set(d.length, d.width, d.height);
    obj.edges.scale.copy(obj.mesh.scale);
    obj.group.children[2].scale.copy(obj.mesh.scale); // heading line
    const half = [d.length / 2, d.width / 2, d.height / 2];
    HANDLE_DEFS.forEach(({ axis, sign }, i) => {
      obj.handles[i].position.set(0, 0, 0).setComponent(axis, sign * half[axis]);
    });
  }

  private applyBoxStyle(obj: BoxObject) {
    const selected = obj.data.id === this.selectedId;
    const color = this.labelColor(obj.data.label);
    obj.mesh.material.forEach((m, i) => {
      m.color.copy(color);
      const hovered = this.hover?.id === obj.data.id && 'face' in this.hover && this.hover.face === i;
      m.opacity = hovered ? FACE_HOVER_OPACITY : selected ? SELECTED_FACE_OPACITY : FACE_OPACITY;
    });
    (obj.edges.material as THREE.LineBasicMaterial).color.copy(selected ? new THREE.Color(0xffffff) : color);
    ((obj.group.children[2] as THREE.Line).material as THREE.LineBasicMaterial).color.copy(color);
    obj.handles.forEach((h, i) => {
      h.visible = selected && this.tool === 'select';
      const hovered = this.hover?.id === obj.data.id && 'handle' in this.hover && this.hover.handle === i;
      (h.material as THREE.MeshBasicMaterial).color.set(hovered ? 0xffe14d : 0xffffff);
      h.scale.setScalar(hovered ? 1.4 : 1);
    });
  }

  // ----------------------------------------------------------- pointer ---

  private setPointer(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pick(): { obj: BoxObject; handle?: number; face?: number; point: THREE.Vector3 } | null {
    const selected = this.selectedId ? this.boxes.get(this.selectedId) : undefined;
    if (selected && this.tool === 'select') {
      const hit = this.raycaster.intersectObjects(selected.handles, false)[0];
      if (hit) return { obj: selected, handle: hit.object.userData.handle, point: hit.point };
    }
    const meshes = [...this.boxes.values()].map((b) => b.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    return { obj: this.boxes.get(hit.object.userData.boxId)!, face: hit.face?.materialIndex, point: hit.point };
  }

  private groundHit(plane = this.groundPlane): THREE.Vector3 | null {
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.downAt.set(e.clientX, e.clientY);
    if (e.button !== 0 || e.altKey) return; // Alt+drag / right / middle always navigate
    this.setPointer(e);

    if (this.tool === 'box') {
      const start = this.groundHit();
      if (!start) return;
      const color = this.labelColor(this.activeLabel);
      const preview = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false }),
      );
      preview.add(new THREE.LineSegments(new THREE.EdgesGeometry(preview.geometry), new THREE.LineBasicMaterial({ color })));
      preview.visible = false;
      this.scene.add(preview);
      this.drag = { kind: 'draw', start, preview };
      this.claimPointer(e);
      return;
    }

    if (this.tool === 'select') {
      const hit = this.pick();
      if (!hit) return; // let OrbitControls handle it; click-to-deselect happens on pointerup
      const id = hit.obj.data.id;
      if (id !== this.selectedId) this.callbacks.onSelect(id);
      if (hit.handle !== undefined) {
        const { axis, sign } = HANDLE_DEFS[hit.handle];
        const dir = AXES[axis].clone().applyQuaternion(hit.obj.group.quaternion);
        const dims = hit.obj.data.dimensions;
        this.drag = {
          kind: 'resize', id, axis, sign, dir,
          center: hit.obj.group.position.clone(),
          size: [dims.length, dims.width, dims.height][axis],
        };
      } else {
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.point.z);
        this.drag = { kind: 'move', id, plane, offset: hit.obj.group.position.clone().sub(hit.point), moved: false };
      }
      this.claimPointer(e);
    }
  };

  private claimPointer(e: PointerEvent) {
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  private handlePointerMove = (e: PointerEvent) => {
    this.setPointer(e);
    const drag = this.drag;
    if (!drag) {
      this.updateHover();
      return;
    }
    if (drag.kind === 'draw') {
      const p = this.groundHit();
      if (!p) return;
      const h = this.labels.find((l) => l.id === this.activeLabel)?.defaultHeight ?? 1.5;
      const sx = Math.max(Math.abs(p.x - drag.start.x), 0.05);
      const sy = Math.max(Math.abs(p.y - drag.start.y), 0.05);
      drag.preview.visible = true;
      drag.preview.scale.set(sx, sy, h);
      drag.preview.position.set((p.x + drag.start.x) / 2, (p.y + drag.start.y) / 2, h / 2);
      return;
    }
    const obj = this.boxes.get(drag.id);
    if (!obj) return;
    if (drag.kind === 'move') {
      const p = this.groundHit(drag.plane);
      if (!p) return;
      obj.group.position.set(p.x + drag.offset.x, p.y + drag.offset.y, obj.group.position.z);
      drag.moved = true;
      return;
    }
    // Resize: find where the pointer ray passes closest to the handle's axis line,
    // then move that face while keeping the opposite face fixed.
    const s = closestParamOnLine(drag.center, drag.dir, this.raycaster.ray);
    if (s === null) return;
    const opposite = (-drag.sign * drag.size) / 2;
    const size = Math.max(MIN_SIZE, drag.sign * (s - opposite));
    const offset = opposite + (drag.sign * size) / 2;
    const d = obj.data.dimensions;
    const dims = { ...d };
    if (drag.axis === 0) dims.length = size;
    else if (drag.axis === 1) dims.width = size;
    else dims.height = size;
    const c = drag.center.clone().addScaledVector(drag.dir, offset);
    this.applyBoxTransform(obj, c, dims, obj.data.yaw);
    obj.group.userData.pending = { position: { x: c.x, y: c.y, z: c.z }, dimensions: dims };
  };

  private handlePointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    this.drag = null;
    this.controls.enabled = true;
    const clicked = this.downAt.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) < 4;

    if (!drag) {
      // A plain click on empty space (not an orbit drag) clears the selection.
      if (clicked && e.button === 0 && e.target === this.renderer.domElement && this.tool === 'select') {
        this.setPointer(e);
        if (!this.pick()) this.callbacks.onSelect(null);
      }
      return;
    }
    if (drag.kind === 'draw') {
      this.scene.remove(drag.preview);
      drag.preview.geometry.dispose();
      const { scale: s, position: p } = drag.preview;
      if (!drag.preview.visible || s.x < 0.2 || s.y < 0.2) return;
      this.callbacks.onCreateBox({
        position: { x: p.x, y: p.y, z: p.z },
        dimensions: { length: s.x, width: s.y, height: s.z },
        yaw: 0,
      });
      return;
    }
    const obj = this.boxes.get(drag.id);
    if (!obj) return;
    if (drag.kind === 'move' && drag.moved) {
      const p = obj.group.position;
      this.callbacks.onUpdateBox(drag.id, { position: { x: p.x, y: p.y, z: p.z } });
    } else if (drag.kind === 'resize' && obj.group.userData.pending) {
      this.callbacks.onUpdateBox(drag.id, obj.group.userData.pending);
      obj.group.userData.pending = null;
    }
  };

  private cancelDraw() {
    if (this.drag?.kind === 'draw') {
      this.scene.remove(this.drag.preview);
      this.drag = null;
      this.controls.enabled = true;
    }
  }

  private updateHover() {
    const hit = this.tool === 'polygon' ? null : this.pick();
    const prev = this.hover;
    this.hover = !hit
      ? null
      : hit.handle !== undefined
        ? { id: hit.obj.data.id, handle: hit.handle }
        : { id: hit.obj.data.id, face: hit.face ?? -1 };
    if (JSON.stringify(prev) === JSON.stringify(this.hover)) return;
    for (const id of new Set([prev?.id, this.hover?.id])) {
      const obj = id ? this.boxes.get(id) : undefined;
      if (obj) this.applyBoxStyle(obj);
    }
    if (this.tool === 'select') {
      this.renderer.domElement.style.cursor = this.hover ? ('handle' in this.hover ? 'grab' : 'move') : 'default';
    }
  }
}

/** Parameter s of the point on line (o + s·dir) closest to the given ray, or null if parallel. */
function closestParamOnLine(o: THREE.Vector3, dir: THREE.Vector3, ray: THREE.Ray): number | null {
  const b = dir.dot(ray.direction);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const w0 = o.clone().sub(ray.origin);
  const d = dir.dot(w0);
  const e = ray.direction.dot(w0);
  return (b * e - d) / denom;
}
