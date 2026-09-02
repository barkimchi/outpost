import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MenuPopover } from './MenuPopover.js';

/** Reproduces the real layout that broke: `ExerciseBar` is a 48px-tall `<header>` carrying
 *  `overflow-x-auto`. CSS forbids scrolling one axis while leaving the other visible, so
 *  the computed `overflow-y` becomes `auto` too and the header clips every descendant to
 *  its own 48px box. A menu rendered as a plain absolutely-positioned child therefore
 *  opens inside a 48px scroll window instead of over the page. */
function Harness({ startOpen = true }: { startOpen?: boolean }): React.JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(startOpen);
  return (
    <header data-testid="clipping-header" style={{ height: 48, overflowX: 'auto' }}>
      <div ref={anchorRef}>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          Open
        </button>
        <MenuPopover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)}>
          <div data-testid="menu-content">Tier 1, Warm-ups</div>
        </MenuPopover>
      </div>
    </header>
  );
}

describe('MenuPopover', () => {
  it('renders its panel outside the clipping ancestor', () => {
    render(<Harness />);
    const header = screen.getByTestId('clipping-header');
    const content = screen.getByTestId('menu-content');

    expect(header.contains(content)).toBe(false);
    expect(document.body.contains(content)).toBe(true);
  });

  it('renders nothing while closed', () => {
    render(<Harness startOpen={false} />);
    expect(screen.queryByTestId('menu-content')).toBeNull();
  });

  it('positions the panel with fixed positioning so no ancestor can clip it', () => {
    render(<Harness />);
    const panel = screen.getByTestId('menu-content').parentElement;
    expect(panel).not.toBeNull();
    expect(panel?.style.position).toBe('fixed');
  });
});
