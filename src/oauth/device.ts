import { setTimeout as sleep } from 'node:timers/promises';
import {
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_POLLING_MARGIN_MS,
  OAUTH_ISSUER,
} from '../config.js';
import type { TokenResponse } from './types';

export interface Challenge {
  device_auth_id: string;
  user_code: string;
  interval: number;
  verification_url: string;
}

export async function start(): Promise<Challenge> {
  const response = await fetch(
    `${OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
    },
  );
  if (!response.ok) throw new Error('Failed to initiate device authorization');
  const data = (await response.json()) as {
    device_auth_id: string;
    user_code: string;
    interval?: string | number;
  };
  return {
    device_auth_id: data.device_auth_id,
    user_code: data.user_code,
    interval: Math.max(Number(data.interval) || 5, 1) * 1000,
    verification_url: `${OAUTH_ISSUER}/codex/device`,
  };
}

export async function poll(challenge: Challenge): Promise<TokenResponse> {
  while (true) {
    const response = await fetch(
      `${OAUTH_ISSUER}/api/accounts/deviceauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: challenge.device_auth_id,
          user_code: challenge.user_code,
        }),
      },
    );
    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };
      const tokenRes = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          redirect_uri: `${OAUTH_ISSUER}/deviceauth/callback`,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      });
      if (!tokenRes.ok)
        throw new Error(`Token exchange failed: ${tokenRes.status}`);
      return tokenRes.json() as Promise<TokenResponse>;
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device authorization failed: ${response.status}`);
    }
    await sleep(challenge.interval + OAUTH_DEVICE_POLLING_MARGIN_MS);
  }
}
