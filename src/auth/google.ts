/** Google OIDC Authorization Code + PKCE. No Google access tokens are persisted. */
import { base64url, fromBase64url, sha256 } from './security.ts';

type GoogleKey = JsonWebKey & { kid?: string; use?: string; alg?: string; kty?: string };
export type GoogleIdentity = { subject: string; email: string; displayName: string };
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let keyCache: { until: number; keys: GoogleKey[] } | null = null;

export function googleAuthorizationUrl(clientId: string, redirectUri: string, state: string, nonce: string, challenge: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    nonce,
    state,
    access_type: 'online'
  }).toString();
  return url.toString();
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier);
}

async function googleKeys(): Promise<GoogleKey[]> {
  if (keyCache && Date.now() < keyCache.until) return keyCache.keys;
  const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
  if (!response.ok) throw new Error('Google public keys unavailable');
  const text = await response.text();
  if (text.length > 100000) throw new Error('Unexpected Google JWKS size');
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || !('keys' in data) || !Array.isArray(data.keys)) throw new Error('Invalid Google JWKS');
  const keys = data.keys as GoogleKey[];
  if (keys.length < 1 || keys.length > 100) throw new Error('Invalid Google JWKS count');
  const seconds = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
  keyCache = { keys, until: Date.now() + Math.min(Math.max(60, seconds), 3600) * 1000 };
  return keys;
}

export async function verifyGoogleIdToken(
  jwt: string,
  clientId: string,
  nonce: string,
  suppliedKeys?: GoogleKey[],
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<GoogleIdentity> {
  if (!jwt || jwt.length > 32000 || jwt.split('.').length !== 3) throw new Error('Invalid token');
  const segments = jwt.split('.');
  const header = JSON.parse(new TextDecoder().decode(fromBase64url(segments[0]))) as { alg?: unknown; kid?: unknown; typ?: unknown };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid ||
      (header.typ !== undefined && header.typ !== 'JWT')) throw new Error('Invalid token header');
  const keys = suppliedKeys || await googleKeys();
  const key = keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === 'RS256'));
  if (!key) throw new Error('Unknown signing key');
  const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const message = new TextEncoder().encode(segments[0] + '.' + segments[1]);
  const signature = fromBase64url(segments[2]);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, message))) throw new Error('Invalid signature');
  const payload: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(segments[1])));
  if (!payload || typeof payload !== 'object') throw new Error('Invalid claims');
  const claims = payload as Record<string, unknown>;
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error('Invalid issuer');
  if (claims.aud !== clientId || (claims.azp !== undefined && claims.azp !== clientId)) throw new Error('Invalid audience');
  if (claims.nonce !== nonce) throw new Error('Invalid nonce');
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds - 30 ||
      typeof claims.iat !== 'number' || claims.iat > nowSeconds + 30 || claims.iat < nowSeconds - 7200) throw new Error('Expired or invalid token');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Unverified email');
  if (typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ||
      typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 250) throw new Error('Invalid identity');
  return {
    subject: claims.sub,
    email: claims.email.trim().toLowerCase(),
    displayName: typeof claims.name === 'string' && claims.name.length <= 120 ? claims.name : claims.email.split('@')[0]
  };
}

export async function exchangeCode(
  code: string,
  verifier: string,
  config: { clientId: string; clientSecret: string; redirectUri: string },
  fetcher: typeof fetch = fetch
): Promise<string> {
  if (!code || code.length > 4096) throw new Error('Invalid OAuth callback');
  const body = new URLSearchParams({
    code,
    code_verifier: verifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code'
  });
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Google token exchange failed');
  const content: unknown = await response.json();
  if (!content || typeof content !== 'object' || !('id_token' in content) || typeof content.id_token !== 'string') throw new Error('No ID token in Google response');
  return content.id_token;
}
