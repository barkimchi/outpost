import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Gap between the anchor and the panel, in px. */
const GAP = 6;
/** Keep the panel this far from the viewport edge. */
const VIEWPORT_MARGIN = 12;
/** Below this much free space, prefer flipping the panel above the anchor. */
const MIN_HEIGHT = 160;

interface Position {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

interface MenuPopoverProps {
  /** The element the menu hangs off. Its rect drives positioning, and pointer events
   *  inside it are treated as "inside" so the trigger's own click can toggle. */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  /** Extra classes for the panel. Do NOT pass `max-h-*` or `overflow-y-*`; the panel sizes
   *  itself from the real free space in the viewport. */
  className?: string;
  children: React.ReactNode;
}

/**
 * A menu panel that renders through a portal into `document.body` and positions itself
 * with `position: fixed` off its anchor's bounding rect.
 *
 * Why a portal rather than the obvious `absolute` child: `ExerciseBar` is a 48px-tall
 * `<header>` carrying `overflow-x-auto` so the bar can scroll sideways on a narrow window.
 * CSS does not allow scrolling one axis while leaving the other `visible`: when
 * `overflow-x` is `auto`, the computed `overflow-y` is forced to `auto` as well. That
 * turns the header into a 48px scroll box that clips every descendant, so an
 * absolutely-positioned menu opened inside it renders into a 48px-tall window instead of
 * over the page. Portalling to `body` puts the panel outside that clipping box entirely,
 * and `fixed` keeps it immune to any future scroll container an ancestor might grow.
 */
export function MenuPopover({
  anchorRef,
  open,
  onClose,
  align = 'left',
  className = '',
  children,
}: MenuPopoverProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Position | null>(null);

  // Held in a ref so callers can pass an inline arrow without re-subscribing the document
  // listeners on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const reposition = useCallback((): void => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();

    const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - GAP - VIEWPORT_MARGIN;
    const flipUp = spaceBelow < MIN_HEIGHT && spaceAbove > spaceBelow;

    const next: Position = { maxHeight: Math.max(MIN_HEIGHT, flipUp ? spaceAbove : spaceBelow) };
    if (flipUp) next.bottom = window.innerHeight - rect.top + GAP;
    else next.top = rect.bottom + GAP;

    // Anchor to whichever edge the menu aligns on, so the panel never needs measuring.
    if (align === 'right') next.right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
    else next.left = Math.max(VIEWPORT_MARGIN, rect.left);

    setPos(next);
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function handle(): void {
      reposition();
    }
    window.addEventListener('resize', handle);
    // Capture phase: the anchor can sit inside a scrolling container (the bar itself
    // scrolls horizontally), and those scroll events do not bubble to window.
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent): void {
      if (!(e.target instanceof Node)) return;
      // The panel is no longer a DOM descendant of the anchor, so both have to be checked
      // explicitly; testing the anchor alone would close the menu on every click inside it.
      if (anchorRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCloseRef.current();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      style={{
        position: 'fixed',
        top: pos?.top,
        bottom: pos?.bottom,
        left: pos?.left,
        right: pos?.right,
        maxHeight: pos?.maxHeight,
      }}
      className={`z-50 overflow-y-auto rounded-lg border border-gym-border bg-gym-panel2 shadow-popover ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
