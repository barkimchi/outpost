import type {
  ActivatedPayload,
  ApiErrorBody,
  EnginePublicState,
  HealthResponse,
  HintResponse,
  ProxyRequestBody,
  ProxyResponseBody,
  ScenarioListEntry,
  SolutionResponse,
} from '../types.js';
import { TrainerApiError } from '../types.js';

/**
 * Thin wrapper over the `/_trainer/api/*` HTTP surface (docs/SPEC.md section 10). Every
 * call is a relative `fetch`, so it works unchanged behind Vite's dev proxy (port 5173)
 * and behind the production single-port server. Non-2xx responses throw `TrainerApiError`
 * so callers can branch on `.status` (a 409 "no hint unlocked yet" is routine, not a bug).
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const json = text === '' ? undefined : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const body = json as ApiErrorBody | undefined;
    throw new TrainerApiError(res.status, body, body?.message ?? `request to ${path} failed with ${res.status}`);
  }
  return json as T;
}

export const trainerApi = {
  health: (): Promise<HealthResponse> => request('/_trainer/api/health'),

  listScenarios: (): Promise<ScenarioListEntry[]> => request('/_trainer/api/scenarios'),

  activate: (scenarioId: string): Promise<ActivatedPayload> =>
    request(`/_trainer/api/scenarios/${encodeURIComponent(scenarioId)}/activate`, { method: 'POST' }),

  activateDrill: (tier?: number): Promise<ActivatedPayload> =>
    request('/_trainer/api/scenarios/drill', {
      method: 'POST',
      body: JSON.stringify(tier === undefined ? {} : { tier }),
    }),

  resetScenario: (): Promise<{ ok: true }> => request('/_trainer/api/scenarios/reset', { method: 'POST' }),

  getState: (): Promise<EnginePublicState> => request('/_trainer/api/state'),

  hint: (): Promise<HintResponse> => request('/_trainer/api/hint', { method: 'POST' }),

  revealSolution: (): Promise<SolutionResponse> => request('/_trainer/api/solution', { method: 'POST' }),

  explain: (rootCause: string, customerReply: string): Promise<SolutionResponse> =>
    request('/_trainer/api/explain', { method: 'POST', body: JSON.stringify({ rootCause, customerReply }) }),

  proxy: (body: ProxyRequestBody): Promise<ProxyResponseBody> =>
    request('/_trainer/api/proxy', { method: 'POST', body: JSON.stringify(body) }),
};
