import { useState } from 'react';
import { useActiveVars, useStore } from '../../state/store.js';
import { resolveVars } from '../../lib/vars.js';
import { trainerApi } from '../../api/client.js';
import { Modal } from '../Modal.js';

/**
 * The OAuth 2.0 helper's "Get New Access Token" flow (docs/SPEC.md section 13). Opens the
 * configured Auth URL in a real popup window (an ordinary browser navigation, exactly what
 * a real OAuth consent screen expects), then exchanges the resulting authorization code for
 * a token through `POST /_trainer/api/proxy`, so the exchange shows up in the Logs tab like
 * any other request this app makes (docs/PLAN.md Task 6 brief).
 *
 * `GET /_trainer/oauth/callback` (spec section 10, an HTML page that `postMessage`s the
 * code back to this window) is Task 6's own deliverable, not yet built. Until it lands,
 * the popup's post-consent redirect 404s, but the browser has still genuinely navigated
 * there, so the `code` query parameter is sitting in the popup's own address bar; this
 * modal's manual "paste the code" step reads it from there. Once the callback route
 * exists, only this modal's automatic-capture half needs adding, not a rewrite: the
 * exchange call below already does the real work through the same proxy path that step
 * would just automate the handoff into.
 */
export function OAuthModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const oauth2 = useStore((s) => s.request.auth.oauth2);
  const updateOAuth2Auth = useStore((s) => s.updateOAuth2Auth);
  const vars = useActiveVars();
  const [code, setCode] = useState('');
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

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

  function openAuthorizePopup(): void {
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

  async function handleExchange(): Promise<void> {
    if (code.trim() === '') {
      setError('Paste the authorization code first.');
      return;
    }
    setExchanging(true);
    setError(null);
    setResult(null);
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code.trim(),
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
            Opens the consent screen in a popup window. Approve access there.
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
          <p className="mb-1.5 font-semibold text-gym-text">2. Paste the code</p>
          <p className="mb-2 leading-relaxed text-gym-text-dim">
            After approving, the popup lands on this app&apos;s callback URL with{' '}
            <code className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-gym-accent-soft">?code=...</code> in its
            own address bar. Copy that value here (this app does not read the popup&apos;s URL for you).
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
            onClick={() => void handleExchange()}
            className="rounded-md bg-gym-accent px-3.5 py-1.5 font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {exchanging ? 'Exchanging.' : 'Exchange for token'}
          </button>
          <p className="mt-1.5 text-[10px] text-gym-text-faint">Goes through the proxy, so it appears in the Logs tab.</p>
        </div>

        {error && <p className="rounded-md border border-gym-red-dim bg-gym-red-dim/20 px-3 py-2 text-gym-red">{error}</p>}
        {result && <p className="rounded-md border border-gym-green-dim bg-gym-green-dim/20 px-3 py-2 text-gym-green">{result}</p>}
      </div>
    </Modal>
  );
}
