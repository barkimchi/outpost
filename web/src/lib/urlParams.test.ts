import { describe, expect, it } from 'vitest';
import { buildUrlWithParams, parseUrlParams } from './urlParams.js';

describe('parseUrlParams', () => {
  it('returns no params for a bare URL', () => {
    expect(parseUrlParams('http://x/y')).toEqual({ base: 'http://x/y', params: [] });
  });

  it('splits multiple query params', () => {
    const parsed = parseUrlParams('http://x/repos?per_page=30&page=2');
    expect(parsed.base).toBe('http://x/repos');
    expect(parsed.params).toEqual([
      { key: 'per_page', value: '30', enabled: true },
      { key: 'page', value: '2', enabled: true },
    ]);
  });

  it('leaves a {{var}} value unresolved and readable', () => {
    const parsed = parseUrlParams('http://x/y?token={{apiToken}}');
    expect(parsed.params[0]).toMatchObject({ key: 'token', value: '{{apiToken}}' });
  });

  it('treats a flag param with no = as an empty value', () => {
    const parsed = parseUrlParams('http://x/y?flag');
    expect(parsed.params[0]).toMatchObject({ key: 'flag', value: '' });
  });
});

describe('buildUrlWithParams', () => {
  it('reassembles base + enabled params', () => {
    const url = buildUrlWithParams('http://x/y', [
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true },
    ]);
    expect(url).toBe('http://x/y?a=1&b=2');
  });

  it('drops disabled rows but keeps a blank-key row so an in-progress add does not vanish', () => {
    const url = buildUrlWithParams('http://x/y', [
      { key: 'a', value: '1', enabled: false },
      { key: '', value: '', enabled: true },
    ]);
    expect(url).toBe('http://x/y?=');
    // and it must round-trip back into a single blank-key row, not disappear
    expect(parseUrlParams(url).params).toEqual([{ key: '', value: '', enabled: true }]);
  });

  it('preserves {{var}} syntax instead of percent-encoding the delimiters', () => {
    const url = buildUrlWithParams('http://x/y', [{ key: 'token', value: '{{apiToken}}', enabled: true }]);
    expect(url).toBe('http://x/y?token={{apiToken}}');
  });

  it('round-trips through parse then build unchanged', () => {
    const original = 'http://x/y?per_page=30&page=2';
    const parsed = parseUrlParams(original);
    expect(buildUrlWithParams(parsed.base, parsed.params)).toBe(original);
  });
});
