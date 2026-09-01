import { useEffect } from 'react';
import type { RefObject } from 'react';

/** Closes a popover/menu when the pointer goes down outside `ref`, or on Escape. */
export function useOutsideClick(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void): void {
  useEffect(() => {
    if (!active) return;
    function handlePointerDown(e: PointerEvent): void {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        onOutside();
      }
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onOutside();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [active, ref, onOutside]);
}
