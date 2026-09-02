import net from 'node:net';

/**
 * Resolves once nothing is listening on `host:port`; rejects with a clear, port-naming
 * Error otherwise. This is the constraint 2a mirror-image hazard: `listen(PORT,
 * '0.0.0.0')` succeeds even when another process already holds `127.0.0.1:PORT`
 * specifically, and that squatter then wins every localhost request while this server
 * reports itself healthy (docs/SPEC.md section 2a). Real incident on this machine,
 * twice, on two different ports (one of them documented in docs/SPEC.md section 2).
 *
 * Implemented as an actual bind attempt against `host`, not a `connect()` probe: binding
 * is the exact resource contention the eventual `0.0.0.0` bind cares about, resolves
 * near-instantly (no network round trip, no timeout to tune), and has one failure mode
 * to handle (`EADDRINUSE`) instead of several. The throwaway listener is closed
 * immediately once it proves the port is free; the real server binds right after.
 */
export function assertPortAvailable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already being served on ${host} by another process. ` +
              `outpost refuses to bind 0.0.0.0:${port} blind: it would succeed while that ` +
              `other process keeps winning every ${host} request, and this server would report ` +
              `itself healthy while actually being unreachable on localhost. ` +
              `Set PORT to a free port and try again.`,
          ),
        );
        return;
      }
      reject(err);
    });

    probe.once('listening', () => {
      probe.close(() => resolve());
    });

    probe.listen(port, host);
  });
}
