import { describe, expect, it } from 'vitest';
import { toCurl, toNodeAxios, toPythonRequests } from './codeExport.js';

const GET_REQ = {
  method: 'GET',
  url: 'http://127.0.0.1:4600/github/user',
  headers: { Authorization: 'token abc123' },
};

const POST_REQ = {
  method: 'POST',
  url: 'http://127.0.0.1:4600/github/user/repos',
  headers: { Authorization: 'token abc123', 'Content-Type': 'application/json' },
  body: '{"name":"it\'s a repo","private":true}',
};

describe('toCurl', () => {
  it('builds a runnable GET command with headers, no -d for an empty body', () => {
    const out = toCurl(GET_REQ);
    expect(out).toContain('curl -sS -X GET');
    expect(out).toContain("-H 'Authorization: token abc123'");
    expect(out).toContain("'http://127.0.0.1:4600/github/user'");
    expect(out).not.toContain('-d ');
  });

  it('single-quote-escapes an embedded single quote in the body so the shell parses it as one argument', () => {
    const out = toCurl(POST_REQ);
    // shQuote('it\'s a repo' embedded in JSON) must close/escape/reopen around every '.
    expect(out).toContain("'\\''");
    expect(out).toContain('-d ');
  });

  it('never leaves an unresolved {{var}} in the output', () => {
    const out = toCurl({ method: 'GET', url: 'http://x/y', headers: { Authorization: 'Bearer resolved-token-value' } });
    expect(out).not.toContain('{{');
  });
});

describe('toPythonRequests', () => {
  it('emits a runnable requests.get call with a headers dict', () => {
    const out = toPythonRequests(GET_REQ);
    expect(out).toContain('import requests');
    expect(out).toContain('url = "http://127.0.0.1:4600/github/user"');
    expect(out).toContain('"Authorization": "token abc123"');
    expect(out).toContain('response = requests.get(url, headers=headers)');
  });

  it('includes a data= argument for a POST body and escapes embedded quotes via JSON encoding', () => {
    const out = toPythonRequests(POST_REQ);
    expect(out).toContain('response = requests.post(url, headers=headers, data=data)');
    expect(out).toContain('data = "{\\"name\\":\\"it\'s a repo\\",\\"private\\":true}"');
  });

  it('omits headers=/data= entirely when there are none', () => {
    const out = toPythonRequests({ method: 'GET', url: 'http://x/y', headers: {} });
    expect(out).not.toContain('headers');
    expect(out).toContain('response = requests.get(url)');
  });
});

describe('toNodeAxios', () => {
  it('emits a runnable axios config object', () => {
    const out = toNodeAxios(GET_REQ);
    expect(out).toContain("const axios = require('axios');");
    expect(out).toContain('method: "get"');
    expect(out).toContain('url: "http://127.0.0.1:4600/github/user"');
    expect(out).toContain('"Authorization": "token abc123"');
  });

  it('includes a data field for a POST body', () => {
    const out = toNodeAxios(POST_REQ);
    expect(out).toContain('data: "{\\"name\\":\\"it\'s a repo\\",\\"private\\":true}",');
  });
});
