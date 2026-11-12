import { useCallback, useEffect, useMemo, useState } from 'react';
import { Viewport } from './components/Viewport';
import { Sidebar } from './components/Sidebar';
import { CameraOverlay } from './components/CameraOverlay';
import { LABEL_CLASSES, labelById } from './annotations/labels';
import { newId, useAnnotationStore } from './annotations/store';
import { buildExport, downloadJson } from './annotations/export';
import type { BoxAnnotation, Tool } from './annotations/types';
import { SENSOR_CAMERA } from './scene/sensorCamera';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { Viewer, ViewerCallbacks } from './scene/Viewer';
import styles from './App.module.css';

const ROTATE_STEP = (5 * Math.PI) / 180;

export default function App() {
  const store = useAnnotationStore();
  const { annotations } = store;
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [cloud, setCloud] = useState<{ positions: Float32Array; count: number } | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [activeLabel, setActiveLabel] = useState(LABEL_CLASSES[0].id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  // Drop the selection if its annotation disappears (delete, undo).
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  // Push state into the imperative THREE.js viewer.
  useEffect(() => viewer?.setTool(tool), [viewer, tool]);
  useEffect(() => viewer?.setLabels(LABEL_CLASSES, activeLabel), [viewer, activeLabel]);
  useEffect(() => {
    viewer?.syncBoxes(annotations.filter((a): a is BoxAnnotation => a.type === 'box'), selectedId);
  }, [viewer, annotations, selectedId, tool]);

  const callbacks: ViewerCallbacks = useMemo(
    () => ({
      onCreateBox: (b) => {
        const id = newId('box');
        store.add({ id, type: 'box', label: activeLabel, ...b });
        setSelectedId(id);
      },
      onUpdateBox: (id, patch) => store.update(id, patch),
      onSelect: setSelectedId,
    }),
    [store.add, store.update, activeLabel], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const createPolygon = useCallback(
    (vertices: [number, number][]) => {
      const id = newId('poly');
      store.add({ id, type: 'polygon', label: activeLabel, view: SENSOR_CAMERA.name, vertices });
      setSelectedId(id);
    },
    [store.add, activeLabel], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const chooseTool = (t: Tool) => {
    setTool(t);
    if (t === 'polygon') setOverlayOpen(true); // polygons are drawn on the projected camera view
  };

  const chooseLabel = (id: string) => {
    setActiveLabel(id);
    if (selected && selected.label !== id) store.update(selected.id, { label: id });
  };

  const rotateSelected = (delta: number) => {
    if (selected?.type === 'box') store.update(selected.id, { yaw: selected.yaw + delta });
  };

  const exportJson = () => {
    downloadJson(buildExport(annotations, LABEL_CLASSES, cloud?.count ?? 0), `annotations-${Date.now()}.json`);
  };

  useKeyboardShortcuts({
    v: () => chooseTool('select'),
    b: () => chooseTool('box'),
    p: () => chooseTool('polygon'),
    c: () => setOverlayOpen((o) => !o),
    ...Object.fromEntries(LABEL_CLASSES.map((l, i) => [String(i + 1), () => chooseLabel(l.id)])),
    l: () => {
      const i = LABEL_CLASSES.findIndex((l) => l.id === (selected?.label ?? activeLabel));
      chooseLabel(LABEL_CLASSES[(i + 1) % LABEL_CLASSES.length].id);
    },
    delete: () => selected && store.remove(selected.id),
    'mod+z': store.undo,
    'mod+shift+z': store.redo,
    'mod+y': store.redo,
    '[': () => rotateSelected(ROTATE_STEP),
    ']': () => rotateSelected(-ROTATE_STEP),
    escape: () => {
      setSelectedId(null);
      viewer?.setTool(tool); // cancels an in-progress box drag
    },
  });

  return (
    <div className={styles.app}>
      <Sidebar
        labels={LABEL_CLASSES}
        activeLabel={activeLabel}
        onLabel={chooseLabel}
        tool={tool}
        onTool={chooseTool}
        overlayOpen={overlayOpen}
        onToggleOverlay={() => setOverlayOpen((o) => !o)}
        annotations={annotations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDelete={store.remove}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        onUndo={store.undo}
        onRedo={store.redo}
        onExport={exportJson}
      />
      <main className={styles.main}>
        <Viewport callbacks={callbacks} onReady={setViewer} onLoaded={setCloud} />
        {overlayOpen && viewer && cloud && (
          <CameraOverlay
            viewer={viewer}
            cloud={cloud}
            annotations={annotations}
            labels={LABEL_CLASSES}
            activeLabel={activeLabel}
            selectedId={selectedId}
            tool={tool}
            onCreatePolygon={createPolygon}
            onSelect={setSelectedId}
            onClose={() => setOverlayOpen(false)}
          />
        )}
        {selected && (
          <div className={styles.selection}>
            <i style={{ background: labelById(selected.label).color }} />
            {labelById(selected.label).name}
            {selected.type === 'box' &&
              ` · center (${selected.position.x.toFixed(2)}, ${selected.position.y.toFixed(2)}, ${selected.position.z.toFixed(2)}) · yaw ${((selected.yaw * 180) / Math.PI).toFixed(0)}°`}
          </div>
        )}
      </main>
    </div>
  );
}
