import { useEffect, useRef, useState } from 'react';
import { Viewer, type ViewerCallbacks } from '../scene/Viewer';
import { loadDemoPointCloud } from '../data/loadPointCloud';
import styles from './Viewport.module.css';

interface Props {
  callbacks: ViewerCallbacks;
  onReady(viewer: Viewer): void;
  onLoaded(cloud: { positions: Float32Array; count: number }): void;
}

const DEMO_POINTS = 500_000;

/** Hosts the THREE.js canvas, loads the demo cloud and shows a live FPS meter. */
export function Viewport({ callbacks, onReady, onLoaded }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [status, setStatus] = useState('Generating 500K-point LiDAR scene…');

  useEffect(() => {
    const v = new Viewer(hostRef.current!, callbacks);
    // Write straight to the DOM so the meter never triggers React renders.
    v.onFps = (fps) => {
      if (fpsRef.current) fpsRef.current.textContent = fps.toFixed(0);
    };
    let cancelled = false;
    loadDemoPointCloud(DEMO_POINTS).then((cloud) => {
      if (cancelled) return;
      v.setPointCloud(cloud.positions, cloud.colors);
      onLoaded({ positions: cloud.positions, count: cloud.count });
      setStatus(`${cloud.count.toLocaleString()} points · generated in ${cloud.generationMs.toFixed(0)} ms`);
      (window as unknown as { __pointsLoaded?: boolean }).__pointsLoaded = true;
    });
    setViewer(v);
    onReady(v);
    return () => {
      cancelled = true;
      v.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => viewer?.setCallbacks(callbacks), [viewer, callbacks]);

  return (
    <div className={styles.viewport}>
      <div ref={hostRef} className={styles.host} />
      <div className={styles.hud}>
        <span><span ref={fpsRef}>–</span> fps</span>
        <span>{status}</span>
      </div>
    </div>
  );
}
