import { useCallback, useReducer } from 'react';
import type { Annotation } from './types';

/**
 * Annotation state with an undo/redo stack. Every mutating action pushes the
 * previous snapshot onto `past`; annotation arrays are treated immutably so
 * snapshots are cheap (structural sharing of unchanged annotations).
 */
interface History {
  past: Annotation[][];
  present: Annotation[];
  future: Annotation[][];
}

type Action =
  | { type: 'add'; annotation: Annotation }
  | { type: 'update'; id: string; patch: Partial<Annotation> }
  | { type: 'remove'; id: string }
  | { type: 'undo' }
  | { type: 'redo' };

const MAX_HISTORY = 200;

function commit(h: History, next: Annotation[]): History {
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [] };
}

function reducer(h: History, a: Action): History {
  switch (a.type) {
    case 'add':
      return commit(h, [...h.present, a.annotation]);
    case 'update': {
      if (!h.present.some((x) => x.id === a.id)) return h;
      return commit(h, h.present.map((x) => (x.id === a.id ? ({ ...x, ...a.patch } as Annotation) : x)));
    }
    case 'remove':
      if (!h.present.some((x) => x.id === a.id)) return h;
      return commit(h, h.present.filter((x) => x.id !== a.id));
    case 'undo': {
      if (!h.past.length) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
    }
    case 'redo': {
      if (!h.future.length) return h;
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
    }
  }
}

let counter = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function useAnnotationStore() {
  const [h, dispatch] = useReducer(reducer, { past: [], present: [], future: [] });
  return {
    annotations: h.present,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    add: useCallback((annotation: Annotation) => dispatch({ type: 'add', annotation }), []),
    update: useCallback((id: string, patch: Partial<Annotation>) => dispatch({ type: 'update', id, patch }), []),
    remove: useCallback((id: string) => dispatch({ type: 'remove', id }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
  };
}
