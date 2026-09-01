import { describe, expect, it } from 'vitest';
import { flattenEnvVars, resolveVars, tokenizeVars, varNamesIn } from './vars.js';

describe('tokenizeVars', () => {
  it('splits plain text around {{var}} references', () => {
    const tokens = tokenizeVars('GET {{baseUrl}}/user');
    expect(tokens).toEqual([
      { kind: 'text', raw: 'GET ' },
      { kind: 'var', raw: '{{baseUrl}}', name: 'baseUrl' },
      { kind: 'text', raw: '/user' },
    ]);
  });

  it('returns a single text token when there are no variables', () => {
    expect(tokenizeVars('no vars here')).toEqual([{ kind: 'text', raw: 'no vars here' }]);
  });

  it('handles whitespace inside the delimiters', () => {
    expect(tokenizeVars('{{ token }}')).toEqual([{ kind: 'var', raw: '{{ token }}', name: 'token' }]);
  });

  it('handles back-to-back variables with nothing between them', () => {
    expect(tokenizeVars('{{a}}{{b}}')).toEqual([
      { kind: 'var', raw: '{{a}}', name: 'a' },
      { kind: 'var', raw: '{{b}}', name: 'b' },
    ]);
  });
});

describe('varNamesIn', () => {
  it('deduplicates repeated references, first-seen order', () => {
    expect(varNamesIn('{{token}} then {{baseUrl}} then {{token}} again')).toEqual(['token', 'baseUrl']);
  });

  it('returns an empty array for plain text', () => {
    expect(varNamesIn('nothing to see')).toEqual([]);
  });
});

describe('resolveVars', () => {
  it('substitutes every defined variable', () => {
    const result = resolveVars('{{baseUrl}}/user', { baseUrl: 'http://127.0.0.1:4600/github' });
    expect(result.value).toBe('http://127.0.0.1:4600/github/user');
    expect(result.missing).toEqual([]);
  });

  it('reports undefined variables and leaves the literal text in place rather than fabricating a value', () => {
    const result = resolveVars('Bearer {{token}}', {});
    expect(result.value).toBe('Bearer {{token}}');
    expect(result.missing).toEqual(['token']);
  });

  it('deduplicates a variable missing multiple times', () => {
    const result = resolveVars('{{x}} and {{x}} again', {});
    expect(result.missing).toEqual(['x']);
  });

  it('resolves defined variables while still reporting the undefined ones alongside them', () => {
    const result = resolveVars('{{baseUrl}}/user?token={{token}}', { baseUrl: 'http://x' });
    expect(result.value).toBe('http://x/user?token={{token}}');
    expect(result.missing).toEqual(['token']);
  });
});

describe('flattenEnvVars', () => {
  it('skips disabled rows and blank keys', () => {
    const flat = flattenEnvVars([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: false },
      { key: '', value: '3', enabled: true },
    ]);
    expect(flat).toEqual({ a: '1' });
  });

  it('last enabled duplicate key wins', () => {
    const flat = flattenEnvVars([
      { key: 'a', value: '1', enabled: true },
      { key: 'a', value: '2', enabled: true },
    ]);
    expect(flat).toEqual({ a: '2' });
  });
});
