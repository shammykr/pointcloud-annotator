import type { Annotation, LabelClass, Tool } from '../annotations/types';
import styles from './Sidebar.module.css';

interface Props {
  labels: LabelClass[];
  activeLabel: string;
  onLabel(id: string): void;
  tool: Tool;
  onTool(t: Tool): void;
  overlayOpen: boolean;
  onToggleOverlay(): void;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onDelete(id: string): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onExport(): void;
}

const TOOLS: { id: Tool; name: string; key: string }[] = [
  { id: 'select', name: 'Select / Edit', key: 'V' },
  { id: 'box', name: '3D Bounding Box', key: 'B' },
  { id: 'polygon', name: 'Polygon (camera view)', key: 'P' },
];

const SHORTCUTS: [string, string][] = [
  ['V / B / P', 'Select / box / polygon tool'],
  ['1–5', 'Pick label (relabels selection)'],
  ['L', 'Cycle label of selection'],
  ['Del / ⌫', 'Delete selected annotation'],
  ['⌘Z / ⌘⇧Z', 'Undo / redo (Ctrl+Y also)'],
  ['[ / ]', 'Rotate selected box ±5°'],
  ['C', 'Toggle camera overlay'],
  ['Esc', 'Deselect / cancel drawing'],
  ['Alt+drag', 'Orbit while in box tool'],
  ['Right-drag / wheel', 'Pan / zoom'],
];

export function Sidebar(p: Props) {
  const counts = new Map<string, number>();
  p.annotations.forEach((a) => counts.set(a.label, (counts.get(a.label) ?? 0) + 1));
  const color = (id: string) => p.labels.find((l) => l.id === id)?.color;

  return (
    <aside className={styles.sidebar}>
      <h1 className={styles.title}>Point Cloud Annotator</h1>

      <section>
        <h2>Tools</h2>
        {TOOLS.map((t) => (
          <button key={t.id} className={`${styles.row} ${p.tool === t.id ? styles.active : ''}`} onClick={() => p.onTool(t.id)}>
            <span>{t.name}</span>
            <kbd>{t.key}</kbd>
          </button>
        ))}
        <button className={`${styles.row} ${p.overlayOpen ? styles.active : ''}`} onClick={p.onToggleOverlay}>
          <span>Camera projection overlay</span>
          <kbd>C</kbd>
        </button>
      </section>

      <section>
        <h2>Labels</h2>
        {p.labels.map((l, i) => (
          <button
            key={l.id}
            className={`${styles.row} ${p.activeLabel === l.id ? styles.active : ''}`}
            onClick={() => p.onLabel(l.id)}
          >
            <span className={styles.label}>
              <i className={styles.swatch} style={{ background: l.color }} />
              {l.name}
              <em>{counts.get(l.id) ?? 0}</em>
            </span>
            <kbd>{i + 1}</kbd>
          </button>
        ))}
      </section>

      <section className={styles.grow}>
        <h2>Annotations ({p.annotations.length})</h2>
        <div className={styles.list}>
          {p.annotations.length === 0 && <p className={styles.empty}>Press B and drag on the ground to draw a box.</p>}
          {p.annotations.map((a) => (
            <div
              key={a.id}
              className={`${styles.item} ${p.selectedId === a.id ? styles.active : ''}`}
              onClick={() => p.onSelect(a.id)}
            >
              <i className={styles.swatch} style={{ background: color(a.label) }} />
              <span className={styles.itemText}>
                {a.label} · {a.type === 'box' ? `box ${a.dimensions.length.toFixed(1)}×${a.dimensions.width.toFixed(1)}×${a.dimensions.height.toFixed(1)} m` : `polygon ${a.vertices.length} pts`}
              </span>
              <button
                className={styles.del}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onDelete(a.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.buttons}>
        <button disabled={!p.canUndo} onClick={p.onUndo}>↶ Undo</button>
        <button disabled={!p.canRedo} onClick={p.onRedo}>↷ Redo</button>
        <button className={styles.primary} onClick={p.onExport}>Export JSON</button>
      </section>

      <details className={styles.shortcuts}>
        <summary>Keyboard shortcuts</summary>
        <dl>
          {SHORTCUTS.map(([k, d]) => (
            <div key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </details>
    </aside>
  );
}
