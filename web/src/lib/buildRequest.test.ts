import { describe, expect, it } from 'vitest';
import { defaultAuthConfig } from '@gym/shared';
import type { ResolvableRequest } from './buildRequest.js';
import { buildResolvedRequest } from './buildRequest.js';

function base(overrides: Partial<ResolvableRequest> = {}): ResolvableRequest {
  return {
    method: 'GET',
    url: '{{baseUrl}}/user',
    headers: [],
    auth: defaultAuthConfig(),
    bodyMode: 'none',
    rawBody: '',
    formBody: [],
    ...overrides,
  };
}

describe('buildResolvedRequest: variable resolution', () => {
  it('resolves {{var}} in the URL', () => {
    const result = buildResolvedRequest(base(), { baseUrl: 'http://127.0.0.1:4600/github' });
    expect(result.url).toBe('http://127.0.0.1:4600/github/user');
    expect(result.missing).toEqual([]);
  });

  it('reports an undefined variable instead of silently sending the literal token', () => {
    const result = buildResolvedRequest(base({ url: '{{baseUrl}}/user' }), {});
    expect(result.missing).toEqual(['baseUrl']);
    expect(result.url).toBe('{{baseUrl}}/user'); // left literal, caller must refuse to send this
  });

  it('resolves variables in headers and collects missing ones from there too', () => {
    const result = buildResolvedRequest(
      base({ headers: [{ id: '1', key: 'Authorization', value: 'Bearer {{token}}', enabled: true }] }),
      { baseUrl: 'http://x' },
    );
    expect(result.headers.Authorization).toBe('Bearer {{token}}');
    expect(result.missing).toEqual(['token']);
  });

  it('skips disabled headers and headers with a blank key', () => {
    const result = buildResolvedRequest(
      base({
        headers: [
          { id: '1', key: 'X-Off', value: 'nope', enabled: false },
          { id: '2', key: '', value: 'ignored', enabled: true },
          { id: '3', key: 'X-On', value: 'yes', enabled: true },
        ],
      }),
      { baseUrl: 'http://x' },
    );
    expect(result.headers).toEqual({ 'X-On': 'yes' });
  });
});

describe('buildResolvedRequest: auth injection', () => {
  it('bearer sets Authorization and overrides a manually-set one', () => {
    const auth = { ...defaultAuthConfig(), type: 'bearer' as const, bearer: { token: '{{token}}' } };
    const result = buildResolvedRequest(
      base({ headers: [{ id: '1', key: 'Authorization', value: 'stale-manual-value', enabled: true }], auth }),
      { baseUrl: 'http://x', token: 'abc123' },
    );
    expect(result.headers.Authorization).toBe('Bearer abc123');
  });

  it('basic base64-encodes username:password after resolving', () => {
    const auth = { ...defaultAuthConfig(), type: 'basic' as const, basic: { username: 'alice', password: 'secret' } };
    const result = buildResolvedRequest(base({ auth }), { baseUrl: 'http://x' });
    expect(result.headers.Authorization).toBe(`Basic ${btoa('alice:secret')}`);
  });

  it('apikey addTo header adds a header named by the key field', () => {
    const auth = { ...defaultAuthConfig(), type: 'apikey' as const, apikey: { key: 'X-Api-Key', value: '{{apiKey}}', addTo: 'header' as const } };
    const result = buildResolvedRequest(base({ auth }), { baseUrl: 'http://x', apiKey: 'k-123' });
    expect(result.headers['X-Api-Key']).toBe('k-123');
  });

  it('apikey addTo query appends to the URL instead of adding a header', () => {
    const auth = { ...defaultAuthConfig(), type: 'apikey' as const, apikey: { key: 'api_key', value: 'k-123', addTo: 'query' as const } };
    const result = buildResolvedRequest(base({ auth }), { baseUrl: 'http://x' });
    expect(result.url).toBe('http://x/user?api_key=k-123');
    expect(result.headers['api_key']).toBeUndefined();
  });

  it('oauth2 sets Authorization from the helper access token', () => {
    const auth = { ...defaultAuthConfig(), type: 'oauth2' as const, oauth2: { ...defaultAuthConfig().oauth2, accessToken: 'ya29.abc' } };
    const result = buildResolvedRequest(base({ auth }), { baseUrl: 'http://x' });
    expect(result.headers.Authorization).toBe('Bearer ya29.abc');
  });

  it('type none adds no auth header at all', () => {
    const result = buildResolvedRequest(base(), { baseUrl: 'http://x' });
    expect(result.headers.Authorization).toBeUndefined();
  });
});

describe('buildResolvedRequest: body modes', () => {
  it('none sends no body', () => {
    const result = buildResolvedRequest(base(), { baseUrl: 'http://x' });
    expect(result.body).toBeUndefined();
    expect(result.headers['Content-Type']).toBeUndefined();
  });

  it('raw-json resolves the body and defaults Content-Type to application/json', () => {
    const result = buildResolvedRequest(base({ bodyMode: 'raw-json', rawBody: '{"name":"{{repoName}}"}' }), {
      baseUrl: 'http://x',
      repoName: 'my-repo',
    });
    expect(result.body).toBe('{"name":"my-repo"}');
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('raw-json does not overwrite a Content-Type the learner already set by hand', () => {
    const result = buildResolvedRequest(
      base({ bodyMode: 'raw-json', rawBody: '{}', headers: [{ id: '1', key: 'Content-Type', value: 'application/vnd.custom+json', enabled: true }] }),
      { baseUrl: 'http://x' },
    );
    expect(result.headers['Content-Type']).toBe('application/vnd.custom+json');
  });

  it('form-urlencoded percent-encodes resolved key/value pairs and joins with &', () => {
    const result = buildResolvedRequest(
      base({
        bodyMode: 'form-urlencoded',
        formBody: [
          { id: '1', key: 'grant_type', value: 'authorization_code', enabled: true },
          { id: '2', key: 'code', value: '{{code}}', enabled: true },
          { id: '3', key: 'skip', value: 'x', enabled: false },
        ],
      }),
      { baseUrl: 'http://x', code: 'a b&c' },
    );
    expect(result.body).toBe('grant_type=authorization_code&code=a%20b%26c');
    expect(result.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('reports missing variables referenced only inside the body', () => {
    const result = buildResolvedRequest(base({ bodyMode: 'raw-json', rawBody: '{"token":"{{secret}}"}' }), { baseUrl: 'http://x' });
    expect(result.missing).toEqual(['secret']);
  });
});
