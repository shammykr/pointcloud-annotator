import { useEffect, useRef } from 'react';

export type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Global keyboard shortcuts. Keys are written like "mod+z", "mod+shift+z",
 * "delete", "b", "1" ("mod" = Cmd on macOS, Ctrl elsewhere). Ignored while
 * typing in form fields.
 */
export function useKeyboardShortcuts(map: ShortcutMap) {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      const key = e.key === 'Backspace' ? 'delete' : e.key.toLowerCase();
      const combo = [(e.metaKey || e.ctrlKey) && 'mod', e.shiftKey && 'shift', key].filter(Boolean).join('+');
      const fn = ref.current[combo];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
