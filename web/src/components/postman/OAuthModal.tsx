import { useEffect, useRef, useState } from 'react';
import { useActiveVars, useStore } from '../../state/store.js';
import { resolveVars } from '../../lib/vars.js';
import { trainerApi } from '../../api/client.js';
import { Modal } from '../Modal.js';

/** The shape `GET /_trainer/oauth/callback` posts (`server/src/trainer/oauthCallback.ts`):
 *  `{ source: 'postman-gym-oauth-callback', code, error, state }`, code/error/state each
 *  either a string or `null`. Matched by `source` only, not by `event.origin`: the
 *  callback page posts with `window.location.origin` as its target origin (the TRAINER
 *  server's own origin, e.g. `http://localhost:4600`), which the browser only delivers to
 *  a window whose actual origin matches. In production (`npm start`, spec hard constraint
 *  1: "single process, single port") the built-in UI is served from that same origin, so
 *  this fires. Under `npm run dev` (Vite on 5173, proxying `/_trainer` and `/google`
 *  through to the trainer server's fixed port) the popup still lands on the trainer
 *  server's own origin because the redirect URI registered with the Google mock is derived
 *  from the live `PORT` the trainer server is actually running on
 *  (`server/src/platforms/google/oauth.ts`'s `builtInUICallbackUri()`, `http://localhost:
 *  <PORT>/_trainer/oauth/callback`, defaulting to 4600, spec section 11), not whatever port
 *  the popup was opened through; the browser then refuses to deliver a
 *  message whose target origin does not match the opener's, so automatic capture cannot
 *  fire across that split. This is a known dev-only limitation, not a bug in this
 *  listener: the manual paste fallback below covers it, and `npm start` (single port) is
 *  documented as the primary way to run this app. No real credentials ever flow through
 *  this app (spec hard constraint 3), so matching on `source` rather than requiring an
 *  exact `event.origin` match is a deliberate, low-risk simplification, not a shortcut
 *  around anything that actually needs defending. */
interface OAuthCallbackMessage {
  source: 'postman-gym-oauth-callback';
  code: string | null;
  error: string | null;
  state: string | null;
}

function isOAuthCallbackMessage(data: unknown): data is OAuthCallbackMessage {
  return typeof data === 'object' && data !== null && (data as { source?: unknown }).source === 'postman-gym-oauth-callback';
}

/**
 * The OAuth 2.0 helper's "Get New Access Token" flow (docs/SPEC.md section 13). Opens the
 * configured Auth URL in a real popup window (an ordinary browser navigation, exactly what
 * a real OAuth consent screen expects). `GET /_trainer/oauth/callback` (Task 6) lands the
 * popup on an HTML page that `postMessage`s `{code}`/`{error}` back to this window and
 * closes itself; this modal listens for that message and exchanges the code automatically
 * through `POST /_trainer/api/proxy`, so the exchange shows up in the Logs tab like any
 * other request this app makes. The manual "paste the code" path stays in place for when
 * the popup is blocked by the browser (no message will ever arrive) or the automatic
 * capture cannot reach this window (the dev-mode origin split documented above).
 */
export function OAuthModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const oauth2 = useStore((s) => s.request.auth.oauth2);
  const updateOAuth2Auth = useStore((s) => s.updateOAuth2Auth);
  const vars = useActiveVars();
  const [code, setCode] = useState('');
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [autoCaptured, setAutoCaptured] = useState(false);

  function resolve(input: string): string {
    return resolveVars(input, vars).value;
  }

  const authUrl = resolve(oauth2.authUrl);
  const tokenUrl = resolve(oauth2.tokenUrl);
  const clientId = resolve(oauth2.clientId);
  const clientSecret = resolve(oauth2.clientSecret);
  const scope = resolve(oauth2.scope);
  const redirectUri = resolve(oauth2.redirectUri);

  const missingConfig = [authUrl, tokenUrl, clientId, redirectUri].some((v) => v === '' || v.includes('{{'));

  async function performExchange(codeValue: string): Promise<void> {
    if (codeValue.trim() === '') {
      setError('Paste the authorization code first.');
      return;
    }
    setExchanging(true);
    setError(null);
    setResult(null);
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: codeValue.trim(),
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString();
      const response = await trainerApi.proxy({
        method: 'POST',
        url: tokenUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (response.status >= 200 && response.status < 300) {
        const parsed = JSON.parse(response.body) as { access_token?: string };
        if (parsed.access_token) {
          updateOAuth2Auth({ accessToken: parsed.access_token });
          setResult('Access token obtained and applied to this request.');
        } else {
          setError(`Token endpoint returned ${response.status} with no access_token: ${response.body}`);
        }
      } else {
        setError(`Token endpoint returned ${response.status}: ${response.body}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token exchange failed.');
    } finally {
      setExchanging(false);
    }
  }

  // A ref, not a plain closure captured once, because `performExchange` closes over
  // `tokenUrl`/`clientId`/`clientSecret`/`redirectUri`, which can change while the popup
  // is open (the learner edits the Auth tab). The message listener itself is only ever
  // installed once (mount/unmount), so it must always call the LATEST version.
  const performExchangeRef = useRef(performExchange);
  performExchangeRef.current = performExchange;

  useEffect(() => {
    function handleMessage(event: MessageEvent): void {
      if (!isOAuthCallbackMessage(event.data)) return;
      const data = event.data;
      if (data.error) {
        setError(`Authorization failed: ${data.error}`);
        return;
      }
      if (data.code) {
        setAutoCaptured(true);
        setCode(data.code);
        void performExchangeRef.current(data.code);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function openAuthorizePopup(): void {
    setAutoCaptured(false);
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: crypto.randomUUID(),
    });
    const separator = authUrl.includes('?') ? '&' : '?';
    window.open(`${authUrl}${separator}${qs.toString()}`, 'postman-gym-oauth', 'width=480,height=640');
  }

  function handleExchange(): void {
    void performExchange(code);
  }

  return (
    <Modal title="Get New Access Token" onClose={onClose}>
      <div className="space-y-4 text-xs">
        {missingConfig && (
          <p className="rounded-md border border-gym-amber-dim bg-gym-amber-dim/20 px-3 py-2 text-gym-amber">
            Fill in Auth URL, Token URL, Client ID, and Callback URL on the Auth tab first.
          </p>
        )}

        <div>
          <p className="mb-1.5 font-semibold text-gym-text">1. Authorize</p>
          <p className="mb-2 leading-relaxed text-gym-text-dim">
            Opens the consent screen in a popup window. Approve access there. The code is captured automatically
            when the popup completes and exchanged right away, no copy-paste needed.
          </p>
          <button
            type="button"
            disabled={missingConfig}
            onClick={openAuthorizePopup}
            className="rounded-md border border-gym-border bg-gym-panel2 px-3 py-1.5 font-semibold text-gym-text-dim hover:border-gym-accent-dim hover:text-gym-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            Open authorization page
          </button>
        </div>

        <div>
          <p className="mb-1.5 font-semibold text-gym-text">2. Or paste the code by hand</p>
          <p className="mb-2 leading-relaxed text-gym-text-dim">
            If the popup was blocked, or the automatic capture did not reach this window (a known limitation under{' '}
            <code className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-gym-accent-soft">npm run dev</code>,
            fine under <code className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-gym-accent-soft">npm start</code>
            ), the popup still lands on this app&apos;s callback URL with{' '}
            <code className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-gym-accent-soft">?code=...</code> in its
            own address bar. Copy that value here.
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="4/..."
            spellCheck={false}
            className="w-full rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 font-mono text-xs text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
          />
        </div>

        <div>
          <p className="mb-1.5 font-semibold text-gym-text">3. Exchange</p>
          <button
            type="button"
            disabled={exchanging || missingConfig}
            onClick={handleExchange}
            className="rounded-md bg-gym-accent px-3.5 py-1.5 font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {exchanging ? 'Exchanging.' : 'Exchange for token'}
          </button>
          <p className="mt-1.5 text-[10px] text-gym-text-faint">
            {autoCaptured ? 'Code captured automatically from the popup. ' : ''}Goes through the proxy, so it appears in the Logs
            tab.
          </p>
        </div>

        {error && <p className="rounded-md border border-gym-red-dim bg-gym-red-dim/20 px-3 py-2 text-gym-red">{error}</p>}
        {result && <p className="rounded-md border border-gym-green-dim bg-gym-green-dim/20 px-3 py-2 text-gym-green">{result}</p>}
      </div>
    </Modal>
  );
}
