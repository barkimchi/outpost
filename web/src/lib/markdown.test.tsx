import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './markdown.js';

describe('Markdown', () => {
  it('joins a single-newline soft break within a paragraph into a space, not a hard <br/>', () => {
    const { container } = render(<Markdown text={'This is a sentence\nhard-wrapped in the source.'} />);
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p?.querySelector('br')).toBeNull();
    expect(p?.textContent).toBe('This is a sentence hard-wrapped in the source.');
  });

  it('a blank line still starts a new block (a new paragraph, not one run-on block)', () => {
    const { container } = render(<Markdown text={'First paragraph.\n\nSecond paragraph.'} />);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe('First paragraph.');
    expect(paragraphs[1]?.textContent).toBe('Second paragraph.');
  });

  it('renders a 4-space-indented single line as a monospace code block, not proportional body text', () => {
    // Regression test: a real ticket shape (t1-wrong-method), a paragraph, then a blank
    // line, then a 4-space-indented log line, then another blank line and paragraph. The
    // block-splitting step used to run a bare `.trim()` on every block, which stripped
    // exactly the 4-space indent the code-block check below it depends on, so this line
    // silently fell through to the plain-paragraph branch instead.
    const text = [
      'The last log line reads:',
      '',
      '    HTTP 405 Method Not Allowed',
      '',
      'A valid personal access token is already configured.',
    ].join('\n');
    const { container } = render(<Markdown text={text} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('HTTP 405 Method Not Allowed');
    // The surrounding paragraphs must still render as ordinary paragraphs, not get
    // swept into the code block or lose their own content.
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe('The last log line reads:');
    expect(paragraphs[1]?.textContent).toBe('A valid personal access token is already configured.');
  });

  it('a multi-line indented block keeps every line, with the common 4-space indent stripped', () => {
    const text = ['    line one', '    line two'].join('\n');
    const { container } = render(<Markdown text={text} />);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('line one\nline two');
  });

  it('headings, bold, and inline code still parse correctly alongside the fixed trim', () => {
    const { container } = render(<Markdown text={'## Ticket\n\n**Bold** and `code`.'} />);
    expect(container.querySelector('h2')?.textContent).toBe('Ticket');
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
  });
});
