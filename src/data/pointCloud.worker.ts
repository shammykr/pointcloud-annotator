import { generatePointCloud } from './syntheticScene';

self.onmessage = (e: MessageEvent<{ points: number }>) => {
  const t0 = performance.now();
  const cloud = generatePointCloud(e.data.points);
  const ms = performance.now() - t0;
  // Copy to standalone buffers so they can be transferred zero-copy.
  const positions = cloud.positions.slice();
  const colors = cloud.colors.slice();
  (self as unknown as Worker).postMessage({ positions, colors, count: cloud.count, ms }, [positions.buffer, colors.buffer]);
};
