import { useEffect, useState } from 'react';

interface HealthResponse {
  ok: boolean;
  version: string;
  port: number;
}

/**
 * Task 0 placeholder. Fetches the trainer health check so the scaffold proves the web
 * app can reach the server, either through the Vite dev proxy or the prod static bundle.
 * The real Postman-clone UI lands in Task 4 and 5.
 */
export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/_trainer/api/health')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`health check failed with status ${res.status}`);
        }
        return res.json() as Promise<HealthResponse>;
      })
      .then(setHealth)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'unknown error');
      });
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-sans">
      <div className="rounded-lg border border-slate-800 bg-slate-900 px-8 py-6 shadow-lg min-w-80">
        <h1 className="text-2xl font-semibold mb-4">Postman Gym</h1>
        {error && <p className="text-red-400">Health check failed. {error}</p>}
        {!error && !health && <p className="text-slate-400">Checking server health.</p>}
        {health && (
          <dl className="space-y-1 text-sm text-slate-300">
            <div>
              <dt className="inline text-slate-500">Status: </dt>
              <dd className="inline">{health.ok ? 'ok' : 'not ok'}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Version: </dt>
              <dd className="inline">{health.version}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Port: </dt>
              <dd className="inline">{health.port}</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
