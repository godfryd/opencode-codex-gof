import { OAUTH_CALLBACK_URI } from '../config.js';
import type { PkceCodes } from './pkce';
import { exchange } from './tokens';
import type { TokenResponse } from './types';

export async function fromUrl(
  callbackUrl: string,
  codes: PkceCodes,
  state: string,
): Promise<TokenResponse> {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error('Invalid callback URL');
  }
  const code = parsed.searchParams.get('code');
  const cbState = parsed.searchParams.get('state');
  if (!code) throw new Error('Callback URL is missing the ?code= parameter');
  if (cbState !== state) throw new Error('Callback URL state does not match');
  return exchange(code, OAUTH_CALLBACK_URI, codes);
}
