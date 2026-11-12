export type Tool = 'select' | 'box' | 'polygon';

export interface LabelClass {
  id: string;
  name: string;
  color: string;
  /** Default box height (m) used when a box is drawn with this class. */
  defaultHeight: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoxAnnotation {
  id: string;
  type: 'box';
  label: string;
  /** Box center in the LiDAR frame (meters, Z up). */
  position: Vec3;
  dimensions: { length: number; width: number; height: number };
  /** Rotation around Z in radians. */
  yaw: number;
}

export interface PolygonAnnotation {
  id: string;
  type: 'polygon';
  label: string;
  /** Camera the polygon was drawn on. */
  view: string;
  /** Vertices in image pixel coordinates [u, v]. */
  vertices: [number, number][];
}

export type Annotation = BoxAnnotation | PolygonAnnotation;
