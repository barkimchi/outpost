import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { assertPortAvailable } from './startupProbe.js';

async function reserveEphemeralPort(host: string): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, host, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('resolves when nothing is listening on the probed host:port', async () => {
  const port = await reserveEphemeralPort('127.0.0.1');
  await assertPortAvailable('127.0.0.1', port);
});

test('rejects with a clear, port-naming message when something already holds the port', async () => {
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const { port } = squatter.address() as AddressInfo;
  try {
    await assert.rejects(
      () => assertPortAvailable('127.0.0.1', port),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(String(port)));
        assert.match(err.message.toLowerCase(), /already/);
        assert.match(err.message.toLowerCase(), /port/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('the probe releases its throwaway listener: the same port can be bound again immediately after', async () => {
  const port = await reserveEphemeralPort('127.0.0.1');
  await assertPortAvailable('127.0.0.1', port);

  const real = net.createServer();
  await new Promise<void>((resolve, reject) => {
    real.once('error', reject);
    real.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => real.close(() => resolve()));
});
