import type { Annotation, LabelClass } from './types';
import { SENSOR_CAMERA, sensorIntrinsics } from '../scene/sensorCamera';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Serialize all annotations into a self-describing JSON document. */
export function buildExport(annotations: Annotation[], labels: LabelClass[], pointCount: number) {
  return {
    format: 'pointcloud-annotator/v1',
    exportedAt: new Date().toISOString(),
    scene: { name: 'synthetic-urban-lidar', pointCount, frame: 'lidar', units: 'meters', up: 'z' },
    labels: labels.map(({ id, name, color }) => ({ id, name, color })),
    cameras: [
      {
        name: SENSOR_CAMERA.name,
        intrinsics: Object.fromEntries(Object.entries(sensorIntrinsics()).map(([k, v]) => [k, r3(v)])),
        extrinsics: {
          position: SENSOR_CAMERA.position.toArray().map(r3),
          forward: SENSOR_CAMERA.forward.toArray(),
        },
      },
    ],
    boxes: annotations.flatMap((a) =>
      a.type !== 'box'
        ? []
        : [{
            id: a.id,
            label: a.label,
            position: { x: r3(a.position.x), y: r3(a.position.y), z: r3(a.position.z) },
            dimensions: { length: r3(a.dimensions.length), width: r3(a.dimensions.width), height: r3(a.dimensions.height) },
            yaw: r3(a.yaw),
          }],
    ),
    polygons: annotations.flatMap((a) =>
      a.type !== 'polygon'
        ? []
        : [{ id: a.id, label: a.label, view: a.view, vertices: a.vertices.map(([u, v]) => [r3(u), r3(v)]) }],
    ),
  };
}

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
