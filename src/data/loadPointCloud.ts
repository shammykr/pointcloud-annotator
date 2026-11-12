import type { PointCloud } from './syntheticScene';

export interface LoadedCloud extends PointCloud {
  generationMs: number;
}

/** Generates the synthetic demo cloud off the main thread. */
export function loadDemoPointCloud(points = 500_000): Promise<LoadedCloud> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pointCloud.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { positions, colors, count, ms } = e.data;
      resolve({ positions, colors, count, generationMs: ms });
      worker.terminate();
    };
    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };
    worker.postMessage({ points });
  });
}
