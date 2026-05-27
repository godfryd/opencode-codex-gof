import type { Plugin } from '@opencode-ai/plugin';
import * as accounts from './accounts/index.js';
import * as auth from './auth/index.js';
import * as codex from './codex/fetch.js';
import { OAUTH_DUMMY_KEY, PROVIDER_ID } from './config.js';
import * as oauth from './oauth/index.js';

const plugin: Plugin = async (_) => {
  await accounts.load();
  await auth.sync();

  let lastAuthFingerprint = auth.fingerprint(accounts.snapshot());
  accounts.subscribe((store) => {
    const nextAuthFingerprint = auth.fingerprint(store);
    if (nextAuthFingerprint === lastAuthFingerprint) return;
    lastAuthFingerprint = nextAuthFingerprint;
    void auth.sync();
  });

  const codexFetch = codex.create();

  return {
    auth: {
      provider: PROVIDER_ID,
      async loader() {
        return { apiKey: OAUTH_DUMMY_KEY, fetch: codexFetch };
      },
      methods: oauth.methods(),
    },
    async event({ event }) {
      const type = (event as { type?: string }).type;
      if (type === 'session.created' || type === 'session.idle') {
        await auth.sync();
      }
    },
  };
};

export default {
  id: 'opencode-codex',
  server: plugin,
};
