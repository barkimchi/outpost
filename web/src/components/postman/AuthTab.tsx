import { useState } from 'react';
import type { AuthType } from '@gym/shared';
import { useActiveVars, useStore } from '../../state/store.js';
import { VarHighlightInput } from '../VarHighlightInput.js';
import { OAuthModal } from './OAuthModal.js';

/**
 * The Auth tab (docs/SPEC.md section 13): No Auth, Bearer, Basic, API Key, and an OAuth 2.0
 * helper. Every field that can carry a secret is a `VarHighlightInput` so `{{token}}`
 * highlights the same way it does in the URL bar: the whole point of practicing with
 * `{{variables}}` instead of pasted secrets (this task's dispatch) is that it looks and
 * behaves identically everywhere a credential can go.
 */

const AUTH_TYPES: Array<{ id: AuthType; label: string }> = [
  { id: 'none', label: 'No Auth' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
  { id: 'oauth2', label: 'OAuth 2.0' },
];

const fieldRowClass = 'grid grid-cols-[100px_1fr] items-center gap-3';
const labelClass = 'text-[11px] font-medium text-gym-text-faint';

function TextField({ value, onChange, placeholder, vars }: { value: string; onChange: (v: string) => void; placeholder?: string; vars: Record<string, string> }): React.JSX.Element {
  return <VarHighlightInput value={value} onChange={onChange} vars={vars} placeholder={placeholder} className="h-8" />;
}

export function AuthTab(): React.JSX.Element {
  const auth = useStore((s) => s.request.auth);
  const setAuthType = useStore((s) => s.setAuthType);
  const updateBearerAuth = useStore((s) => s.updateBearerAuth);
  const updateBasicAuth = useStore((s) => s.updateBasicAuth);
  const updateApiKeyAuth = useStore((s) => s.updateApiKeyAuth);
  const updateOAuth2Auth = useStore((s) => s.updateOAuth2Auth);
  const vars = useActiveVars();
  const [oauthModalOpen, setOAuthModalOpen] = useState(false);

  return (
    <div className="space-y-4 p-3">
      <div className={fieldRowClass}>
        <span className={labelClass}>Type</span>
        <select
          value={auth.type}
          onChange={(e) => setAuthType(e.target.value as AuthType)}
          className="w-48 rounded-md border border-gym-border bg-gym-panel2 px-2 py-1.5 text-xs text-gym-text focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
        >
          {AUTH_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {auth.type === 'none' && (
        <p className="rounded-md border border-gym-border bg-gym-panel2/60 px-3 py-4 text-center text-xs text-gym-text-faint">
          This request does not use any authorization.
        </p>
      )}

      {auth.type === 'bearer' && (
        <div className={fieldRowClass}>
          <span className={labelClass}>Token</span>
          <TextField value={auth.bearer.token} onChange={(token) => updateBearerAuth({ token })} placeholder="{{token}}" vars={vars} />
        </div>
      )}

      {auth.type === 'basic' && (
        <>
          <div className={fieldRowClass}>
            <span className={labelClass}>Username</span>
            <TextField value={auth.basic.username} onChange={(username) => updateBasicAuth({ username })} placeholder="username" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Password</span>
            <TextField value={auth.basic.password} onChange={(password) => updateBasicAuth({ password })} placeholder="{{password}}" vars={vars} />
          </div>
        </>
      )}

      {auth.type === 'apikey' && (
        <>
          <div className={fieldRowClass}>
            <span className={labelClass}>Key</span>
            <TextField value={auth.apikey.key} onChange={(key) => updateApiKeyAuth({ key })} placeholder="X-Api-Key" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Value</span>
            <TextField value={auth.apikey.value} onChange={(value) => updateApiKeyAuth({ value })} placeholder="{{apiKey}}" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Add to</span>
            <select
              value={auth.apikey.addTo}
              onChange={(e) => updateApiKeyAuth({ addTo: e.target.value as 'header' | 'query' })}
              className="w-48 rounded-md border border-gym-border bg-gym-panel2 px-2 py-1.5 text-xs text-gym-text focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
            >
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </div>
        </>
      )}

      {auth.type === 'oauth2' && (
        <div className="space-y-3">
          <div className={fieldRowClass}>
            <span className={labelClass}>Access Token</span>
            <TextField value={auth.oauth2.accessToken} onChange={(accessToken) => updateOAuth2Auth({ accessToken })} placeholder="(none yet)" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Auth URL</span>
            <TextField value={auth.oauth2.authUrl} onChange={(authUrl) => updateOAuth2Auth({ authUrl })} placeholder="{{baseUrl}}/o/oauth2/v2/auth" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Token URL</span>
            <TextField value={auth.oauth2.tokenUrl} onChange={(tokenUrl) => updateOAuth2Auth({ tokenUrl })} placeholder="{{baseUrl}}/oauth2/token" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Client ID</span>
            <TextField value={auth.oauth2.clientId} onChange={(clientId) => updateOAuth2Auth({ clientId })} placeholder="{{clientId}}" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Client Secret</span>
            <TextField value={auth.oauth2.clientSecret} onChange={(clientSecret) => updateOAuth2Auth({ clientSecret })} placeholder="{{clientSecret}}" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Scope</span>
            <TextField value={auth.oauth2.scope} onChange={(scope) => updateOAuth2Auth({ scope })} placeholder="openid email profile" vars={vars} />
          </div>
          <div className={fieldRowClass}>
            <span className={labelClass}>Callback URL</span>
            <TextField value={auth.oauth2.redirectUri} onChange={(redirectUri) => updateOAuth2Auth({ redirectUri })} placeholder="http://localhost:PORT/_trainer/oauth/callback" vars={vars} />
          </div>
          <button
            type="button"
            onClick={() => setOAuthModalOpen(true)}
            className="rounded-md bg-gym-accent px-3.5 py-1.5 text-xs font-semibold text-gym-bg transition-opacity hover:opacity-90"
          >
            Get New Access Token
          </button>
          {oauthModalOpen && <OAuthModal onClose={() => setOAuthModalOpen(false)} />}
        </div>
      )}
    </div>
  );
}
