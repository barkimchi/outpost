import { describe, expect, it } from 'vitest';
import { formatEpochMs, prettyJsonForDisplay, tryPrettyJson } from './format.js';

describe('prettyJsonForDisplay: annotates epoch-millisecond timestamp fields (Response panel Pretty tab)', () => {
  it('appends a readable date next to a getdocumentstatus-shaped indexedAt, without dropping the raw number', () => {
    const body = JSON.stringify({ id: 'doc-1', datasource: 'engineering-wiki', status: 'INDEXED', indexedAt: 1735689600000 });
    const { pretty, isJson } = prettyJsonForDisplay(body);
    expect(isJson).toBe(true);
    expect(pretty).toContain(`"indexedAt": "1735689600000 (${formatEpochMs(1735689600000)})"`);
    // Still valid JSON: re-parseable, not corrupted by the annotation.
    expect(() => JSON.parse(pretty)).not.toThrow();
  });

  it('leaves an unrelated number alone even if it happens to be large', () => {
    const body = JSON.stringify({ id: 'doc-1', size: 1735689600000 });
    const { pretty } = prettyJsonForDisplay(body);
    expect(pretty).toContain('"size": 1735689600000');
    expect(pretty).not.toContain('(');
  });

  it('leaves a small number under a timestamp-shaped key alone (outside the plausible epoch range)', () => {
    const body = JSON.stringify({ runs: 3, attempts: 7 });
    const { pretty } = prettyJsonForDisplay(body);
    expect(pretty).toContain('"runs": 3');
    expect(pretty).toContain('"attempts": 7');
  });

  it('recurses into nested objects and arrays', () => {
    const body = JSON.stringify({ results: [{ id: 'a', indexedAt: 1735689600000 }] });
    const { pretty } = prettyJsonForDisplay(body);
    expect(pretty).toContain(`(${formatEpochMs(1735689600000)})`);
  });

  it('falls back to the original text, unchanged, for non-JSON bodies', () => {
    const { pretty, isJson } = prettyJsonForDisplay('not json at all');
    expect(isJson).toBe(false);
    expect(pretty).toBe('not json at all');
  });

  it('does not affect tryPrettyJson, which the Logs tab and Raw tab depend on staying verbatim', () => {
    const body = JSON.stringify({ indexedAt: 1735689600000 });
    const { pretty } = tryPrettyJson(body);
    expect(pretty).toContain('"indexedAt": 1735689600000');
    expect(pretty).not.toContain('(');
  });
});
